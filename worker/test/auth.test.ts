import { describe, expect, it } from "vitest";
import { OWNER_EMAIL, call, fails, login, membershipID, ok, team } from "./helpers";

describe("Google login and sessions", () => {
  it("lets an allowlisted account own a workspace", async () => {
    const result = await login(OWNER_EMAIL, "100");
    expect(result).toMatchObject({ email: OWNER_EMAIL, is_owner: true, pending_only: false });
    expect(result.sessionToken).toMatch(/^skv_sess_[A-Za-z0-9_-]{43}$/);
    const me = await ok("auth.me", { sessionToken: result.sessionToken });
    expect(me).toEqual({ email: OWNER_EMAIL, name: "owner", is_owner: true, workspace_id: "google:100", workspace_email: "", pending_only: false });
    const workspaces = await ok("auth.workspaces", { sessionToken: result.sessionToken });
    expect(workspaces).toEqual([{ id: "google:100", email: OWNER_EMAIL, is_owner: true, active: true }]);
  });

  it("rejects accounts that are neither allowlisted nor invited, and bad tokens", async () => {
    await fails("auth.login", { idToken: "fake|300|stranger@fixtures.invalid" }, "google account is not allowed for this vault");
    await fails("auth.login", { idToken: "fake|100|owner@fixtures.invalid|someone-else.apps.googleusercontent.com" }, "google token audience mismatch");
    await fails("auth.login", { idToken: "fake|100|owner@fixtures.invalid||false" }, "google email is not verified");
    await fails("auth.login", { idToken: "garbage" }, "google token verification failed");
    await fails("auth.login", { idToken: "" }, "google id token is required");
    await fails("auth.login", { idToken: "x".repeat(17 << 10) }, "google id token is too large");
  });

  it("revokes a session on logout", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    expect(await ok("auth.logout", { sessionToken })).toEqual({ deleted: true });
    await fails("auth.me", { sessionToken }, "invalid session");
    await fails("auth.me", { sessionToken: "" }, "session token is required");
  });

  it("gives invitees a pending-only session until they accept", async () => {
    const owner = await login(OWNER_EMAIL, "100");
    await fails("team.invite", { sessionToken: owner.sessionToken, email: "guest@fixtures.invalid" }, "choose a role for this invitation");
    await fails("team.invite", { sessionToken: owner.sessionToken, email: OWNER_EMAIL, role_id: "full" }, "the workspace owner cannot invite their own account");
    await fails("team.invite", { sessionToken: owner.sessionToken, email: "bad email@x", role_id: "full" }, "a valid google email is required");
    const invite = await ok("team.invite", { sessionToken: owner.sessionToken, email: "guest@fixtures.invalid", role_id: "full" });
    expect(invite).toMatchObject({ email: "guest@fixtures.invalid", status: "pending" });

    const guest = await login("guest@fixtures.invalid", "300");
    expect(guest).toMatchObject({ is_owner: false, pending_only: true });
    await fails("credentials.list", { sessionToken: guest.sessionToken }, "accept or reject the pending workspace invitation first");
    await fails("apiKeys.create", { sessionToken: guest.sessionToken }, "accept or reject the pending workspace invitation first");
    const invitations = await ok("team.invitations.list", { sessionToken: guest.sessionToken });
    expect(invitations).toEqual([expect.objectContaining({ id: invite.id, workspace_id: "google:100", workspace_email: OWNER_EMAIL })]);

    const member = await ok("team.invitations.accept", { sessionToken: guest.sessionToken, id: invite.id });
    expect(member.status).toBe("active");
    const me = await ok("auth.me", { sessionToken: guest.sessionToken });
    expect(me).toMatchObject({ is_owner: false, pending_only: false, workspace_id: "google:100", workspace_email: OWNER_EMAIL });
    expect((await ok("team.list", { sessionToken: owner.sessionToken })).map((p: any) => p.status)).toEqual(["active"]);
  });

  it("revokes a pending session when the invitee rejects or the owner cancels", async () => {
    const owner = await login(OWNER_EMAIL, "100");
    const first = await ok("team.invite", { sessionToken: owner.sessionToken, email: "a@fixtures.invalid", role_id: "full" });
    const a = await login("a@fixtures.invalid", "301");
    expect(await ok("team.invitations.reject", { sessionToken: a.sessionToken, id: first.id })).toEqual({ deleted: true });
    await fails("auth.me", { sessionToken: a.sessionToken }, "invalid session");

    await ok("team.invite", { sessionToken: owner.sessionToken, email: "b@fixtures.invalid", role_id: "full" });
    const b = await login("b@fixtures.invalid", "302");
    const pending = (await ok("team.list", { sessionToken: owner.sessionToken })).find((p: any) => p.email === "b@fixtures.invalid");
    expect(await ok("team.remove", { sessionToken: owner.sessionToken, id: pending.id })).toEqual({ deleted: true });
    await fails("auth.me", { sessionToken: b.sessionToken }, "invalid session");
  });

  it("removing a member revokes their sessions and every key they created", async () => {
    const { owner, member } = await team();
    const key = await ok("apiKeys.create", { sessionToken: member, name: "member laptop", scopes: ["skills:read"] });
    expect((await call("agent.skills.list", { apiKey: key.apiKey })).error).toBeUndefined();
    const id = await membershipID(owner, "member@fixtures.invalid");
    expect(await ok("team.remove", { sessionToken: owner, id })).toEqual({ deleted: true });
    await fails("auth.me", { sessionToken: member }, /invalid session|no longer active/);
    await fails("agent.skills.list", { apiKey: key.apiKey }, "invalid api key");
    const keys = await ok("apiKeys.list", { sessionToken: owner });
    expect(keys.find((k: any) => k.id === key.record.id).revoked_at).toBeTypeOf("string");
  });

  it("switches only to workspaces the account belongs to", async () => {
    const { owner } = await team();
    await fails("auth.switchWorkspace", { sessionToken: owner, workspace_id: "google:999" }, "workspace access is not active");
    await fails("auth.switchWorkspace", { sessionToken: owner, workspace_id: "" }, "valid workspace id is required");
    expect(await ok("auth.switchWorkspace", { sessionToken: owner, workspace_id: "google:100" })).toEqual({ id: "google:100", email: OWNER_EMAIL, is_owner: true, active: true });
  });

  it("returns HTTP status codes that match the failure", async () => {
    expect((await call("auth.me", { sessionToken: "skv_sess_nope" })).status).toBe(401);
    const { member } = await team();
    expect((await call("access.saveRole", { sessionToken: member, role: { name: "x" } })).status).toBe(403);
    expect((await call("no.such.function", {})).status).toBe(404);
  });
});
