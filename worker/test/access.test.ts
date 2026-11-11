// Ports tests/backend/access_test.go to the Worker.
import { describe, expect, it } from "vitest";
import { call, fails, login, membershipID, ok, team } from "./helpers";

async function fixture() {
  const t = await team();
  const allowed = await ok("skills.save", { sessionToken: t.owner, name: "allowed-skill", content: "allowed content" });
  const forbidden = await ok("skills.save", { sessionToken: t.owner, name: "forbidden-skill", content: "private content" });
  const secretAllowed = await ok("credentials.save", { sessionToken: t.owner, name: "allowed-secret", value: "fixture-secret-1" });
  const secretForbidden = await ok("credentials.save", { sessionToken: t.owner, name: "forbidden-secret", value: "fixture-secret-2" });
  const role = await ok("access.saveRole", {
    sessionToken: t.owner,
    role: { name: "Limited", scopes: ["skills:read", "skills:write", "credentials:read"], skill_ids: [allowed.id], credential_ids: [secretAllowed.id] },
  });
  // Existing keys inherit changes to their creator's membership.
  const key = await ok("apiKeys.create", { sessionToken: t.member, name: "Before restriction", scopes: ["skills:read", "skills:write", "credentials:read"] });
  const membership = await membershipID(t.owner, "member@fixtures.invalid");
  await ok("access.assignRole", { sessionToken: t.owner, id: membership, role_id: role.id });
  return { ...t, allowed, forbidden, secretAllowed, secretForbidden, role, key, membership };
}

describe("roles and per-item grants", () => {
  it("snapshots reflect assignments and role edits", async () => {
    const f = await fixture();
    const owner = await ok("access.snapshot", { sessionToken: f.owner });
    expect(owner.state.assignments[f.membership]).toBe(f.role.id);
    expect(owner.vault).toBeNull();
    expect(owner.state.roles.map((r: any) => r.id)).toEqual(["full", f.role.id]);

    await ok("access.saveRole", { sessionToken: f.owner, role: { ...f.role, skill_ids: [f.forbidden.id], credential_ids: [] } });
    const member = await ok("access.snapshot", { sessionToken: f.member });
    expect(member.vault.skills.map((s: any) => s.id)).toEqual([f.forbidden.id]);
    expect(member.vault.credentials).toEqual([]);
    expect(member.state.roles).toEqual([]);
    await fails("access.snapshot", { sessionToken: "invalid-token" }, "invalid session");
  });

  it("filters lists and snapshots", async () => {
    const f = await fixture();
    expect((await ok("skills.list", { sessionToken: f.member })).map((s: any) => s.id)).toEqual([f.allowed.id]);
    expect((await ok("credentials.list", { sessionToken: f.member })).map((s: any) => s.id)).toEqual([f.secretAllowed.id]);
    const vault = await ok("access.vault", { sessionToken: f.member });
    expect(vault.skills).toHaveLength(1);
    expect(vault.credentials).toHaveLength(1);
    expect(JSON.stringify(vault)).not.toContain("fixture-secret");
    expect((await ok("agent.credentials.list", { apiKey: f.key.apiKey })).map((s: any) => s.name)).toEqual(["allowed-secret"]);
  });

  it("checks ID and name selectors for browser and CLI", async () => {
    const f = await fixture();
    for (const agent of [false, true]) {
      const auth = agent ? { apiKey: f.key.apiKey } : { sessionToken: f.member };
      const skillGet = agent ? "agent.skills.get" : "skills.get";
      const credGet = agent ? "agent.credentials.get" : "credentials.get";
      for (const selector of [{ id: f.allowed.id }, { name: "allowed-skill" }, { name: "ALLOWED-SKILL" }]) {
        expect((await ok(skillGet, { ...auth, ...selector })).content).toBe("allowed content");
      }
      for (const selector of [{ id: f.forbidden.id }, { name: "forbidden-skill" }, { id: f.allowed.id, name: "forbidden-skill" }, { name: "new-item" }]) {
        await fails(skillGet, { ...auth, ...selector }, /your role does not allow/);
      }
      for (const selector of [{ id: f.secretAllowed.id }, { name: "allowed-secret" }]) {
        expect((await ok(credGet, { ...auth, ...selector })).value).toBe("fixture-secret-1");
      }
      for (const selector of [{ id: f.secretForbidden.id }, { name: "forbidden-secret" }, { id: f.secretAllowed.id, name: "forbidden-secret" }]) {
        await fails(credGet, { ...auth, ...selector }, /your role does not allow/);
      }
    }
  });

  it("allows only personal key management to members", async () => {
    const f = await fixture();
    const keys = await ok("apiKeys.list", { sessionToken: f.member });
    expect(keys).toHaveLength(1);
    expect(keys[0].can_revoke).toBe(true);
    expect(keys[0]).not.toHaveProperty("key_hash");
    const personal = await ok("apiKeys.create", { sessionToken: f.member, scopes: ["skills:read"] });
    expect(await ok("apiKeys.revoke", { sessionToken: f.member, id: personal.record.id })).toEqual({ deleted: true });
    const ownerKey = await ok("apiKeys.create", { sessionToken: f.owner, scopes: ["skills:read"] });
    await fails("apiKeys.revoke", { sessionToken: f.member, id: ownerKey.record.id }, "your role does not allow revoking workspace keys");
    const empty = await ok("access.saveRole", { sessionToken: f.owner, role: { name: "Unused" } });
    expect(await ok("access.deleteRole", { sessionToken: f.owner, id: empty.id })).toEqual({ deleted: true });
  });

  it("blocks write and privilege escalation", async () => {
    const f = await fixture();
    await fails("skills.delete", { sessionToken: f.member, id: f.forbidden.id }, /does not allow/);
    await fails("agent.skills.upload", { apiKey: f.key.apiKey, name: "new-item", content: "new" }, "your role does not allow creating items");
    await fails("apiKeys.create", { sessionToken: f.member, scopes: ["credentials:write"] }, "requested key permissions exceed your role");
    await fails("access.saveRole", { sessionToken: f.member, role: f.role }, "only the workspace owner can manage roles");
    await fails("access.assignRole", { sessionToken: f.member, id: f.membership, role_id: "full" }, "only the workspace owner can assign roles");
    const other = await login("second-owner@fixtures.invalid", "999");
    await fails("access.assignRole", { sessionToken: other.sessionToken, id: f.membership, role_id: f.role.id }, /role is unavailable|no longer exists/);
    await fails("skills.sync", { sessionToken: f.member, ownerId: f.workspace }, "members must use permission-filtered queries");
    await fails("skills.sync", { sessionToken: other.sessionToken, ownerId: f.workspace }, "ownerId does not match the active workspace");
    await fails("access.deleteRole", { sessionToken: f.owner, id: f.role.id }, "assign members and pending invitations another role first");
    await fails("access.deleteRole", { sessionToken: f.owner, id: "full" }, "the built-in role cannot be deleted");
    // Another workspace never sees this one's items.
    await fails("credentials.get", { sessionToken: other.sessionToken, id: f.secretAllowed.id }, "credential not found");
    expect(await ok("skills.list", { sessionToken: other.sessionToken })).toEqual([]);
  });

  it("applies role downgrades to existing keys on their next call", async () => {
    const f = await fixture();
    const readOnly = await ok("access.saveRole", { sessionToken: f.owner, role: { name: "Skills only", scopes: ["skills:read"], all_skills: true } });
    await ok("access.assignRole", { sessionToken: f.owner, id: f.membership, role_id: readOnly.id });
    await fails("agent.credentials.get", { apiKey: f.key.apiKey, name: "allowed-secret" }, "your role does not allow this action");
    expect(await ok("agent.credentials.list", { apiKey: f.key.apiKey })).toEqual([]);
  });

  it("carries the invitation's role into membership", async () => {
    const f = await fixture();
    const invite = await ok("team.invite", { sessionToken: f.owner, email: "guest@fixtures.invalid", role_id: f.role.id });
    const state = await ok("access.state", { sessionToken: f.owner });
    expect(state.assignments[invite.id]).toBe(f.role.id);
    const guest = await login("guest@fixtures.invalid", "400");
    await ok("team.invitations.accept", { sessionToken: guest.sessionToken, id: invite.id });
    expect((await ok("skills.list", { sessionToken: guest.sessionToken })).map((s: any) => s.id)).toEqual([f.allowed.id]);
  });

  it("validates role input", async () => {
    const f = await fixture();
    await fails("access.saveRole", { sessionToken: f.owner, role: { name: "" } }, "enter a role name of up to 80 characters");
    await fails("access.saveRole", { sessionToken: f.owner, role: { name: "x", scopes: ["skills:write"] } }, "editing requires read access");
    await fails("access.saveRole", { sessionToken: f.owner, role: { name: "x", scopes: ["root"] } }, 'unsupported api key scope "root"');
    await fails("access.saveRole", { sessionToken: f.owner, role: { name: "x", scopes: ["skills:read"], skill_ids: ["nope"] } }, "a selected item no longer exists in this workspace");
  });

  it("enforces key scopes independently of the role", async () => {
    const f = await fixture();
    const narrow = await ok("apiKeys.create", { sessionToken: f.owner, scopes: ["skills:read"] });
    await fails("agent.credentials.list", { apiKey: narrow.apiKey }, "api key is missing required scope credentials:read");
    await fails("agent.apiKeys.list", { apiKey: narrow.apiKey }, "your role does not allow this action");
    expect((await call("agent.apiKeys.verify", { apiKey: narrow.apiKey })).result).toEqual({ deleted: true });
    expect(await ok("agent.apiKeys.revokeSelf", { apiKey: narrow.apiKey })).toEqual({ deleted: true });
    await fails("agent.apiKeys.verify", { apiKey: narrow.apiKey }, "invalid api key");
  });

  it("creates keys with expiry rules", async () => {
    const f = await fixture();
    const never = await ok("apiKeys.create", { sessionToken: f.owner, never_expires: true });
    expect(never.record.expires_at).toBeNull();
    expect(never.record.scopes).toEqual(["skills:read"]);
    expect(never.apiKey).toMatch(/^skv_/);
    expect(never.record.prefix).toBe(never.apiKey.slice(0, 14));
    const year = await ok("apiKeys.create", { sessionToken: f.owner, expires_in_days: 365 });
    expect(Date.parse(year.record.expires_at) - Date.now()).toBeGreaterThan(364 * 86400e3);
    await fails("apiKeys.create", { sessionToken: f.owner, expires_in_days: 366 }, "api keys may expire at most 365 days from creation");
  });
});
