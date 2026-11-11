import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";
import vectors from "./fixtures/go-vectors.json";
import { OWNER_EMAIL, fails, login, membershipID, ok, team } from "./helpers";

function vaultStub() {
  return env.VAULT.get(env.VAULT.idFromName("vault"));
}

async function storedValue(id: string): Promise<string> {
  return runInDurableObject(vaultStub(), async (_instance, state) => {
    return String(state.storage.sql.exec("select secret_value from skill_credentials where id = ?", id).one().secret_value);
  });
}

describe("credential encryption", () => {
  it("decrypts ciphertext produced by the Go backend", async () => {
    for (const item of vectors.encv2) {
      const out = await decryptSecret({ current: vectors.key }, item.owner, item.id, item.stored);
      expect(out.value).toBe(item.value);
      expect(out.migrate).toBe(false);
    }
    const rotated = await decryptSecret({ current: vectors.key, previous: vectors.previousKey }, vectors.rotated.owner, vectors.rotated.id, vectors.rotated.stored);
    expect(rotated.migrate).toBe(true);
    const legacy = await decryptSecret({ current: vectors.key }, "x", "y", vectors.encv1.stored);
    expect(legacy).toMatchObject({ value: "legacy fixture", migrate: true, format: "encv1" });
  });

  it("binds ciphertext to its workspace and credential id", async () => {
    const stored = await encryptSecret({ current: vectors.key }, "google:1", "cred-1", "v");
    expect(stored).toMatch(/^encv2:[0-9a-f]{12}:[A-Za-z0-9+/]+$/);
    await expect(decryptSecret({ current: vectors.key }, "google:2", "cred-1", stored)).rejects.toThrow("credential decryption failed");
    await expect(decryptSecret({ current: vectors.key }, "google:1", "cred-2", stored)).rejects.toThrow("credential decryption failed");
  });

  it("fails closed without a key", async () => {
    await expect(encryptSecret({ current: "" }, "o", "i", "v")).rejects.toThrow("SKILLS_SECRET_KEY must be configured");
    await expect(encryptSecret({ current: "abcd" }, "o", "i", "v")).rejects.toThrow("exactly 32 bytes");
  });

  it("stores only ciphertext, never returns values in lists, and audits every read", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    const saved = await ok("credentials.save", { sessionToken, name: "coolify-fixture", summary: "token", value: '{"token":"fixture-value"}' });
    expect(saved).not.toHaveProperty("value");
    expect(await storedValue(saved.id)).toMatch(/^encv2:/);
    expect(await storedValue(saved.id)).not.toContain("fixture-value");
    const listed = JSON.stringify(await ok("credentials.list", { sessionToken }));
    expect(listed).not.toContain("fixture-value");
    expect(JSON.stringify(await ok("credentials.sync", { sessionToken, ownerId: "google:100" }))).not.toContain("fixture-value");
    const key = await ok("apiKeys.create", { sessionToken, scopes: ["credentials:read"] });
    expect((await ok("agent.credentials.get", { apiKey: key.apiKey, name: "COOLIFY-FIXTURE" })).value).toBe('{"token":"fixture-value"}');
    await fails("agent.credentials.get", { apiKey: key.apiKey, name: "missing" }, "credential not found");
    const audit = await ok("audit.list", { sessionToken });
    const reads = audit.filter((event: any) => event.action === "credential.read");
    expect(reads.map((event: any) => event.outcome)).toEqual(["error", "ok"]);
    expect(reads[1]).toMatchObject({ via: "api_key", api_key_id: key.record.id, target_name: "coolify-fixture", actor_email: OWNER_EMAIL });
    expect(JSON.stringify(audit)).not.toContain("fixture-value");
  });

  it("migrates legacy and old-key rows on read", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    const saved = await ok("credentials.save", { sessionToken, name: "legacy", value: "placeholder" });
    await runInDurableObject(vaultStub(), async (_instance, state) => {
      state.storage.sql.exec("update skill_credentials set secret_value = ? where id = ?", "plain fixture", saved.id);
    });
    expect((await ok("credentials.get", { sessionToken, id: saved.id })).value).toBe("plain fixture");
    expect(await storedValue(saved.id)).toMatch(/^encv2:/);
  });

  it("enforces names, sizes and uniqueness", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    await fails("credentials.save", { sessionToken, name: "", value: "x" }, "credential name is required");
    await fails("credentials.save", { sessionToken, name: "x", value: "" }, "credential value is required");
    await fails("credentials.save", { sessionToken, name: "x", value: "v".repeat((256 << 10) + 1) }, "credential value exceeds the 262144-byte limit");
    const first = await ok("credentials.save", { sessionToken, name: "Shared", value: "1" });
    const again = await ok("credentials.save", { sessionToken, name: " shared ", value: "2" });
    expect(again.id).toBe(first.id);
    expect(await ok("credentials.list", { sessionToken })).toHaveLength(1);
    expect(await ok("credentials.delete", { sessionToken, id: first.id })).toEqual({ deleted: true });
  });

  it("lists credential reads for the owner, filterable by person, key and secret", async () => {
    const t = await team();
    const a = await ok("credentials.save", { sessionToken: t.owner, name: "secret-a", value: "va" });
    const b = await ok("credentials.save", { sessionToken: t.owner, name: "secret-b", value: "vb" });
    const limited = await ok("access.saveRole", { sessionToken: t.owner, role: { name: "Only A", scopes: ["credentials:read"], credential_ids: [a.id] } });
    await ok("access.assignRole", { sessionToken: t.owner, id: await membershipID(t.owner, "member@fixtures.invalid"), role_id: limited.id });
    const memberKey = await ok("apiKeys.create", { sessionToken: t.member, name: "member laptop", scopes: ["credentials:read"] });
    await ok("agent.credentials.get", { apiKey: memberKey.apiKey, name: "secret-a" });
    await fails("agent.credentials.get", { apiKey: memberKey.apiKey, name: "secret-b" }, /does not allow/);
    await ok("credentials.get", { sessionToken: t.owner, id: b.id });

    const all = await ok("audit.credentialReads", { sessionToken: t.owner });
    expect(all.map((e: any) => [e.actor_email, e.credential_name, e.result, e.api_key_name])).toEqual([
      [OWNER_EMAIL, "secret-b", "allowed", ""],
      ["member@fixtures.invalid", "secret-b", "denied", "member laptop"],
      ["member@fixtures.invalid", "secret-a", "allowed", "member laptop"],
    ]);
    expect(await ok("audit.credentialReads", { sessionToken: t.owner, actor_email: OWNER_EMAIL })).toHaveLength(1);
    expect(await ok("audit.credentialReads", { sessionToken: t.owner, api_key_id: memberKey.record.id })).toHaveLength(2);
    const onlyB = await ok("audit.credentialReads", { sessionToken: t.owner, credential_id: b.id });
    expect(onlyB.map((e: any) => e.result)).toEqual(["allowed", "denied"]);
    expect(JSON.stringify(all)).not.toMatch(/"va"|"vb"/);
    await fails("audit.credentialReads", { sessionToken: t.member }, "only the workspace owner can read the audit log");
  });
});
