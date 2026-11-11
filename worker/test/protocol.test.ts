// The Gonvex-compatible WebSocket protocol used by whagons-dev and the UI.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, OWNER_EMAIL, login, membershipID, ok, socket, team } from "./helpers";

const PROJECT = "01f1974b-dcda-6fc3-b16d-9acf5f3b4192";

describe("websocket protocol", () => {
  it("speaks the CLI's subset: auth, query.subscribe, mutation.call", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    const key = await ok("apiKeys.create", { sessionToken, scopes: ["skills:read", "skills:write"] });
    const s = await socket(`?project=${PROJECT}`);
    expect(await s.request({ type: "auth", token: "x.y.cli", tenant: PROJECT })).toEqual({ type: "auth.result", id: expect.any(String) });
    expect((await s.request({ type: "auth", token: "x", tenant: "other" })).type).toBe("auth.error");
    const empty = await s.request({ type: "query.subscribe", path: "agent.skills.list", args: { apiKey: key.apiKey } });
    expect(empty).toMatchObject({ type: "query.result", result: [] });
    const uploaded = await s.request({ type: "mutation.call", path: "agent.skills.upload", args: { apiKey: key.apiKey, name: "ws-skill", content: "c", publish: true } });
    expect(uploaded).toMatchObject({ type: "mutation.result", result: { name: "ws-skill", approved: true } });
    const bad = await s.request({ type: "query.subscribe", path: "agent.skills.list", args: { apiKey: "skv_nope" } });
    expect(bad).toMatchObject({ type: "query.error", error: "invalid api key" });
    expect((await s.request({ type: "mutation.call", path: "agent.skills.list", args: {} })).type).toBe("mutation.error");
    expect((await s.request({ type: "query.subscribe", path: "agent.skills.upload", args: {} })).type).toBe("query.error");
    expect((await s.request({ type: "action.call", path: "access.snapshot", args: { sessionToken } }))).toMatchObject({ type: "action.result" });
    s.close();
  });

  it("pushes a fresh result to live subscribers after a write (CLI daemon)", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    const key = await ok("apiKeys.create", { sessionToken, scopes: ["skills:read", "skills:write"] });
    const daemon = await socket();
    await daemon.request({ type: "auth", tenant: PROJECT });
    const first = await daemon.request({ type: "query.subscribe", id: "watch", path: "agent.skills.list", args: { apiKey: key.apiKey } });
    expect(first.result).toEqual([]);
    await ok("agent.skills.upload", { apiKey: key.apiKey, name: "pushed", content: "x", publish: true });
    const pushed = await daemon.next("watch");
    expect(pushed).toMatchObject({ type: "query.result", id: "watch", path: "agent.skills.list" });
    expect(pushed.result.map((s: any) => s.name)).toEqual(["pushed"]);
    // Unchanged results are not re-sent; unsubscribed queries stop.
    await ok("credentials.save", { sessionToken, name: "unrelated", value: "x" });
    await expect(daemon.next("watch", 300)).rejects.toThrow("timed out");
    daemon.send({ type: "query.unsubscribe", id: "watch" });
    await ok("agent.skills.upload", { apiKey: key.apiKey, name: "pushed-2", content: "x", publish: true });
    await expect(daemon.next("watch", 300)).rejects.toThrow("timed out");
    daemon.close();
  });

  it("re-authorizes live subscriptions: revocation turns into query.error", async () => {
    const t = await team();
    const key = await ok("apiKeys.create", { sessionToken: t.member, scopes: ["skills:read"] });
    const s = await socket();
    await s.request({ type: "query.subscribe", id: "w", path: "agent.skills.list", args: { apiKey: key.apiKey } });
    await ok("team.remove", { sessionToken: t.owner, id: await membershipID(t.owner, "member@fixtures.invalid") });
    expect(await s.next("w")).toMatchObject({ type: "query.error", error: "invalid api key" });
    s.close();
  });

  it("serves owner sync collections as live queries without secrets", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    const s = await socket();
    const args = { sessionToken, ownerId: "google:100" };
    const creds = await s.request({ type: "query.subscribe", id: "c", path: "credentials.sync", args });
    const keys = await s.request({ type: "query.subscribe", id: "k", path: "apiKeys.sync", args });
    expect(creds.result).toEqual([]);
    expect(keys.result).toEqual([]);
    await ok("credentials.save", { sessionToken, name: "pushed-cred", value: "fixture-secret" });
    const pushed = await s.next("c");
    expect(pushed.result).toEqual([expect.objectContaining({ name: "pushed-cred", owner_id: "google:100" })]);
    expect(JSON.stringify(pushed)).not.toContain("fixture-secret");
    await ok("apiKeys.create", { sessionToken });
    const keyRow = (await s.next("k")).result[0];
    expect(Object.keys(keyRow).sort()).toEqual(["created_at", "created_by", "expires_at", "id", "name", "owner_id", "prefix", "revoked_at", "scopes"]);
    s.close();
  });

  it("does not re-run point reads of secrets", async () => {
    const { sessionToken } = await login(OWNER_EMAIL, "100");
    await ok("credentials.save", { sessionToken, name: "once", value: "v1" });
    const key = await ok("apiKeys.create", { sessionToken, scopes: ["credentials:read", "credentials:write"] });
    const s = await socket();
    const read = await s.request({ type: "query.subscribe", id: "r", path: "agent.credentials.get", args: { apiKey: key.apiKey, name: "once" } });
    expect(read.result.value).toBe("v1");
    await ok("agent.credentials.save", { apiKey: key.apiKey, name: "once", value: "v2" });
    await expect(s.next("r", 300)).rejects.toThrow("timed out");
    s.close();
  });

  it("rejects other projects and non-websocket requests", async () => {
    expect((await SELF.fetch(`${ORIGIN}/ws?project=someone-else`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/ws`)).status).toBe(426);
  });
});
