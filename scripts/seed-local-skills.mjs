import { readdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { callVault } from "./vault-api.mjs";

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




const apiKey = process.env.WHAGONS_DEV_API_KEY || process.env.WHAGONS_SKILLS_API_KEY || process.env.SKILLS_VAULT_API_KEY || "";
if (!apiKey) {
  console.error("Set WHAGONS_SKILLS_API_KEY to an API key created in the vault UI.");
  process.exit(1);
}

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
  await callVault("agent.skills.upload", { id, name: metadata.name, summary: metadata.summary, content }, apiKey);
  console.log(`seeded ${metadata.name}`);
}

const existing = await callVault("agent.skills.list", {}, apiKey);
for (const skill of existing) {
  if (typeof skill.id === "string" && skill.id.startsWith("local-") && !seededIDs.has(skill.id)) {
    await callVault("agent.skills.delete", { id: skill.id }, apiKey);
    console.log(`removed stale ${skill.name}`);
  }
}

