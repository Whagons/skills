// Ports tests/backend/publish_test.go: only the owner changes published skills.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fails, membershipID, ok, team } from "./helpers";

async function fixture() {
  const t = await team();
  const writer = await ok("access.saveRole", { sessionToken: t.owner, role: { name: "Writer", scopes: ["skills:read", "skills:write"], all_skills: true } });
  await ok("access.assignRole", { sessionToken: t.owner, id: await membershipID(t.owner, "member@fixtures.invalid"), role_id: writer.id });
  const ownerKey = (await ok("apiKeys.create", { sessionToken: t.owner, name: "owner agent", scopes: ["skills:read", "skills:write"] })).apiKey as string;
  const memberKey = (await ok("apiKeys.create", { sessionToken: t.member, name: "member agent", scopes: ["skills:read", "skills:write"] })).apiKey as string;
  const live = async (key: string) => {
    const names: Record<string, string> = {};
    for (const row of await ok("agent.skills.list", { apiKey: key })) {
      const skill = await ok("agent.skills.get", { apiKey: key, id: row.id });
      names[skill.name] = skill.content;
    }
    return names;
  };
  const upload = (key: string, name: string, content: string, publish: boolean) => ok("agent.skills.upload", { apiKey: key, name, content, publish });
  return { ...t, ownerKey, memberKey, live, upload };
}

const OWNER_ONLY = "only the workspace owner can change or delete a published skill; propose a new skill instead";

describe("workspace skill publishing", () => {
  it("owner keys publish live and update the same row", async () => {
    const f = await fixture();
    const published = await f.upload(f.ownerKey, "pub-deploy", "v1", true);
    expect(published.approved).toBe(true);
    expect((await f.live(f.memberKey))["pub-deploy"]).toBe("v1");
    const updated = await f.upload(f.ownerKey, "pub-deploy", "v2", true);
    expect(updated).toMatchObject({ approved: true, id: published.id });
  });

  it("members cannot change or remove a published skill", async () => {
    const f = await fixture();
    const published = await f.upload(f.ownerKey, "pub-deploy", "v2", true);
    for (const publish of [false, true]) {
      await fails("agent.skills.upload", { apiKey: f.memberKey, name: "pub-deploy", content: "member edit", publish }, OWNER_ONLY);
    }
    await fails("skills.save", { sessionToken: f.member, name: "PUB-DEPLOY", content: "ui edit" }, OWNER_ONLY);
    await fails("agent.skills.delete", { apiKey: f.memberKey, id: published.id }, OWNER_ONLY);
    await fails("skills.delete", { sessionToken: f.member, id: published.id }, OWNER_ONLY);
    expect((await f.live(f.ownerKey))["pub-deploy"]).toBe("v2");
  });

  it("member proposals stay pending until the owner publishes", async () => {
    const f = await fixture();
    const proposal = await f.upload(f.memberKey, "pub-proposal", "idea", true);
    expect(proposal.approved).toBe(false);
    await f.upload(f.memberKey, "pub-proposal", "idea v2", false);
    expect(await f.live(f.ownerKey)).not.toHaveProperty("pub-proposal");
    expect((await ok("skills.list", { sessionToken: f.owner })).find((s: any) => s.name === "pub-proposal").approved).toBe(false);
    const approved = await ok("skills.approve", { sessionToken: f.owner, id: proposal.id });
    expect(approved).toMatchObject({ approved: true, content: "idea v2" });
    await fails("skills.approve", { sessionToken: f.member, id: proposal.id }, "only the workspace owner can approve agent-uploaded skills");
    const final = await f.upload(f.ownerKey, "pub-proposal", "idea, edited by owner", true);
    expect(final).toMatchObject({ approved: true, id: proposal.id });
  });

  it("an owner upload without publish stays pending like older CLIs", async () => {
    const f = await fixture();
    expect((await ok("agent.skills.upload", { apiKey: f.ownerKey, name: "pub-legacy", content: "draft" })).approved).toBe(false);
  });

  it("the owner deletes", async () => {
    const f = await fixture();
    const published = await f.upload(f.ownerKey, "pub-deploy", "v1", true);
    expect(await ok("agent.skills.delete", { apiKey: f.ownerKey, id: published.id })).toEqual({ deleted: true });
    expect(await f.live(f.ownerKey)).not.toHaveProperty("pub-deploy");
  });

  it("scopes new IDs to the workspace, trims content and validates input", async () => {
    const f = await fixture();
    const skill = await ok("agent.skills.upload", { apiKey: f.ownerKey, id: "local-demo", name: "demo", summary: " s ", content: "\n# Demo\n", publish: true });
    expect(skill.id).toMatch(/^[0-9a-f]{12}_local-demo$/);
    expect(skill).toMatchObject({ content: "# Demo", summary: "s", name: "demo" });
    // Re-uploading by the same unscoped ID or by name reuses the row.
    expect((await ok("agent.skills.upload", { apiKey: f.ownerKey, id: "local-demo", name: "demo", content: "x", publish: true })).id).toBe(skill.id);
    await fails("skills.save", { sessionToken: f.owner, name: "", content: "x" }, "skill name is required");
    await fails("skills.save", { sessionToken: f.owner, name: "x", content: "  " }, "skill content is required");
    await fails("skills.save", { sessionToken: f.owner, name: "a\u0007", content: "x" }, "skill name or summary contains control characters");
    await fails("skills.save", { sessionToken: f.owner, name: "n".repeat(121), content: "x" }, "skill name or summary exceeds the allowed length");
    await fails("skills.save", { sessionToken: f.owner, name: "big", content: "x".repeat((2 << 20) + 1) }, "skill content exceeds the 2097152-byte limit");
  });

  it("stores skills larger than 1 MiB in R2 and serves them transparently", async () => {
    const f = await fixture();
    const content = "# Big\n" + "abcdefghij".repeat(150_000);
    const skill = await ok("skills.save", { sessionToken: f.owner, name: "big-skill", content });
    const listed = await env.BLOBS.list({ prefix: `skills/${skill.id}/` });
    expect(listed.objects).toHaveLength(1);
    expect((await ok("agent.skills.get", { apiKey: f.ownerKey, name: "big-skill" })).content).toBe(content);
    const synced = await ok("skills.sync", { sessionToken: f.owner, ownerId: f.workspace });
    expect(synced.find((row: any) => row.id === skill.id).content).toBe(content);
  });
});
