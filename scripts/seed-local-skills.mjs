import { readdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { GonvexClient } from "@gonvex/client";

const skillRoots = (process.env.SKILLS_LOCAL_ROOTS || [
  `${process.env.HOME}/.codex/skills`,
  `${process.env.HOME}/.agents/skills`,
].join(","))
  .split(",")
  .map((root) => root.trim())
  .filter(Boolean);

async function discoverSkillFiles() {
  const files = [];
  for (const root of skillRoots) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      files.push(`${root}/${entry.name}/SKILL.md`);
    }
  }
  return files;
}

function parseFrontmatter(content, fallbackName) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!fieldMatch) continue;
      fields[fieldMatch[1]] = fieldMatch[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return {
    name: fields.name || fallbackName,
    summary: fields.description || "",
  };
}

function devJWT() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "skills-seeder", email: "skills@whagons.local" })}.seed`;
}

const wsURL = new URL(process.env.VITE_GONVEX_WS_URL || "wss://gonvex.whagons.com/ws");
wsURL.searchParams.set("project", process.env.GONVEX_PROJECT_ID || "skills");

const client = new GonvexClient(wsURL.toString(), {
  token: devJWT(),
  tenant: process.env.GONVEX_PROJECT_ID || "skills",
});

const saveRef = { kind: "mutation", path: "skills.save" };
const listRef = { kind: "query", path: "skills.list" };
const deleteRef = { kind: "mutation", path: "skills.delete" };
const loginRef = { kind: "mutation", path: "auth.login" };

let password = process.env.SKILLS_VAULT_PASSWORD || "";
if (!password) {
  password = (await readFile(".skills-vault-password", "utf8")).trim();
}
const session = await client.mutation(loginRef, { password });
const sessionToken = session.sessionToken;

const localSkillFiles = await discoverSkillFiles();
const seededIDs = new Set();
for (const file of localSkillFiles) {
  let content = "";
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  const fallbackName = basename(dirname(file));
  const metadata = parseFrontmatter(content, fallbackName);
  const id = `local-${metadata.name}`;
  seededIDs.add(id);
  await client.mutation(saveRef, {
    sessionToken,
    id,
    name: metadata.name,
    summary: metadata.summary,
    content,
  });
  console.log(`seeded ${metadata.name}`);
}

const existing = await client.query(listRef, { sessionToken });
for (const skill of existing) {
  if (typeof skill.id === "string" && skill.id.startsWith("local-") && !seededIDs.has(skill.id)) {
    await client.mutation(deleteRef, { sessionToken, id: skill.id });
    console.log(`removed stale ${skill.name}`);
  }
}

client.close();
