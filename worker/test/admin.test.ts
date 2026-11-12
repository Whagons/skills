// Operator endpoints and the migration path, end to end, on synthetic data.
import { SELF, createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateGonvexExport } from "../../tools/migrate/fixtures.mjs";
import { bundleStats, toPostgresSQL, transformExport } from "../../tools/migrate/lib.mjs";
import worker from "../src/index";
import vectors from "./fixtures/go-vectors.json";
import { ORIGIN, admin, call, fails, ok } from "./helpers";

async function fixtureBundle() {
  const fixture = await generateGonvexExport({ key: vectors.key });
  const { bundle, report } = transformExport(fixture.exportDoc, { allowPlaintext: true, source: "gonvex" });
  return { fixture, bundle, report };
}

describe("admin endpoints", () => {
  it("are invisible without ADMIN_TOKEN and reject wrong tokens", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/admin/stats`, { headers: { Authorization: "Bearer anything" } }), { ...env, ADMIN_TOKEN: undefined } as never);
    expect(response.status).toBe(404);
    expect((await admin("stats", { token: "wrong-token-wrong-token-wrong-token" })).status).toBe(401);
    expect((await admin("import", { method: "GET" })).status).toBe(405);
    expect((await admin("nope")).status).toBe(404);
  });

  it("migrates a Gonvex export: counts, digests, decryption, existing keys and sessions", async () => {
    const { fixture, bundle, report } = await fixtureBundle();
    expect(report.problems).toEqual([]);
    expect(report.droppedExpiredSessions).toBe(1);
    expect(report.credentialFormats).toMatchObject({ encv1: 1, plaintext: 1 });

    const imported = await admin("import", { body: bundle });
    expect(imported.status).toBe(200);
    expect(imported.body.result.reencrypted).toEqual({ total: 7, rewritten: 2, failed: 0 });
    const stats = await admin("stats");
    // Credential digests cover metadata, so re-encrypting legacy rows at import keeps them equal.
    expect(stats.body.result.tables).toEqual(await bundleStats(bundle.tables));
    const formats = Object.entries(stats.body.result.credentialFormats);
    expect(formats).toHaveLength(1);
    expect(formats[0][0]).toMatch(/^encv2:[0-9a-f]{12}$/);
    expect(formats[0][1]).toBe(7);
    expect(JSON.stringify(stats.body)).not.toMatch(/apiToken|skv_/);

    const decrypt = await admin("verify-decrypt");
    expect(decrypt.body.result).toMatchObject({ total: 7, ok: 7, failed: 0, needsMigration: 0 });
    expect(JSON.stringify(decrypt.body)).not.toContain("apiToken");

    // Existing CLI keys and browser sessions keep working after migration.
    const ownerKey = fixture.apiKeys.skill_fixturekey_owner;
    const listed = await ok("agent.credentials.list", { apiKey: ownerKey });
    expect(listed).toHaveLength(7);
    for (const credential of listed) {
      const got = await ok("agent.credentials.get", { apiKey: ownerKey, id: credential.id });
      expect(got.value).toBe(fixture.secrets[credential.id]);
    }
    expect((await ok("agent.skills.list", { apiKey: ownerKey })).length).toBe(11); // one fixture skill is pending
    await fails("agent.skills.list", { apiKey: fixture.apiKeys.skill_fixturekey_revoked }, "invalid api key");
    const me = await ok("auth.me", { sessionToken: fixture.sessions.skill_fixturesession_live });
    expect(me).toMatchObject({ email: "owner@fixtures.invalid", is_owner: true });
    await fails("auth.me", { sessionToken: fixture.sessions.skill_fixturesession_expired }, "invalid session");
    // The member's role (one credential) carries over.
    const memberKey = fixture.apiKeys.skill_fixturekey_member;
    expect((await ok("agent.credentials.list", { apiKey: memberKey })).map((c: any) => c.name)).toEqual(["fixture-credential-0"]);

    // Legacy rows were re-encrypted at import; reencrypt has nothing left to do.
    expect((await admin("reencrypt", { method: "POST" })).body.result).toMatchObject({ total: 7, rewritten: 0, failed: 0 });
  });

  it("refuses to import over data unless replace=1, and round-trips export -> import", async () => {
    const { bundle } = await fixtureBundle();
    expect((await admin("import", { body: bundle })).status).toBe(200);
    expect((await admin("import", { body: bundle })).status).toBe(409);
    const exported = (await admin("export")).body.result;
    expect(exported.format).toBe("whagons-skills-vault/v1");
    expect(await bundleStats(exported.tables)).toEqual(await bundleStats(bundle.tables));
    expect((await admin("import", { body: exported, query: "?replace=1" })).status).toBe(200);
    expect((await admin("stats")).body.result.tables).toEqual(await bundleStats(exported.tables));
    const sql = toPostgresSQL(exported);
    expect(sql).toMatch(/^begin;/);
    expect(sql.match(/insert into skill_credentials/g)).toHaveLength(7);
    expect(sql).toContain("on conflict (id) do update set");
  });

  it("rejects bundles with integrity problems", async () => {
    const { bundle } = await fixtureBundle();
    const broken = structuredClone(bundle);
    broken.tables.skill_credentials.push({ ...broken.tables.skill_credentials[0], id: "dup", name: "FIXTURE-CREDENTIAL-0" });
    const response = await admin("import", { body: broken });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("duplicate credential name");
    expect((await admin("import", { body: { format: "other" } })).status).toBe(400);
  });

  it("writes nightly backups to R2 without plaintext secrets", async () => {
    const { bundle } = await fixtureBundle();
    await admin("import", { body: bundle });
    const ctx = createExecutionContext();
    await worker.scheduled!({ cron: "17 3 * * *", scheduledTime: Date.now(), type: "scheduled", noRetry() {} } as ScheduledController, env as never, ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const listed = await env.BLOBS.list({ prefix: "backups/" });
    expect(listed.objects).toHaveLength(1);
    const text = await (await env.BLOBS.get(listed.objects[0].key))!.text();
    expect(text).not.toContain("apiToken\\\":\\\"");
    expect(JSON.parse(text).tables.skill_credentials).toHaveLength(7);
  });
});

describe("HTTP surface", () => {
  it("serves health, security headers and the SPA", async () => {
    expect(await (await SELF.fetch(`${ORIGIN}/health`)).text()).toBe("ok\n");
    const page = await SELF.fetch(`${ORIGIN}/some/client/route?tab=credentials`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:* https://cloudflareinsights.com");
    expect(csp).not.toMatch(/wss?:/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("gonvex.whagons.com");
    expect(page.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("accepts only POST JSON on /api, with credentials only in the Authorization header", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/agent.skills.list`)).status).toBe(405);
    expect((await call("agent.skills.list", {}, { Authorization: "Bearer skv_invalid" })).error).toBe("invalid api key");
    expect((await call("agent.skills.list", {})).error).toBe("api key is required");
    for (const body of [{ apiKey: "skv_x" }, { sessionToken: "skv_sess_x" }]) {
      const response = await SELF.fetch(`${ORIGIN}/api/agent.skills.list`, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/Authorization header/);
    }
    const bad = await SELF.fetch(`${ORIGIN}/api/agent.skills.list`, { method: "POST", body: "{nope" });
    expect(bad.status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/agent.skills.list`, { method: "POST", body: "[]" })).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/%E0%A4%A`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/constructor`, { method: "POST", body: "{}" })).status).toBe(404);
    const big = await SELF.fetch(`${ORIGIN}/api/agent.skills.list`, { method: "POST", body: "x".repeat((3 << 20) + 10) });
    expect(big.status).toBe(413);
    expect((await SELF.fetch(`${ORIGIN}/ws`, { headers: { Upgrade: "websocket" } })).headers.get("Content-Type")).not.toContain("json");
  });

  it("rate-limits sign-ins per client IP", async () => {
    const attempt = (ip: string) => SELF.fetch(`${ORIGIN}/api/auth.login`, {
      method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify({ idToken: "fake|300|stranger@fixtures.invalid" }),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt("203.0.113.7")).status);
    expect(statuses.slice(0, 10).every((status) => status === 403)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect((await attempt("203.0.113.8")).status).toBe(403);
  });
});
