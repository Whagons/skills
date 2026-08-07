import { readFile } from "node:fs/promises";
import { GonvexClient } from "@gonvex/client";

const defaultCredentialFile = `${process.env.HOME}/.secrets/keys.json`;
const credentialFile = process.env.SKILLS_CREDENTIAL_IMPORT_FILE || defaultCredentialFile;
const credentialNames = (process.env.SKILLS_CREDENTIAL_IMPORT_NAMES || [
  "coolify-whagons",
  "coolify-gabrielmalek",
  "digitalocean",
  "cloudflare",
  "cloudflare-r2-whagons-backups",
].join(","))
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

function devJWT() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "skills-credential-import", email: "skills@whagons.local" })}.import`;
}

function summarizeCredential(name, value) {
  if (name.startsWith("coolify-")) return `Coolify credential for ${name.replace("coolify-", "")}`;
  if (name === "digitalocean") return "DigitalOcean API credential";
  if (name === "cloudflare") return "Cloudflare API credential";
  if (name.includes("r2")) return "Cloudflare R2 backup credential";
  if (value && typeof value === "object") return `Imported credential with ${Object.keys(value).length} fields`;
  return "Imported credential";
}

let raw = "";
try {
  raw = await readFile(credentialFile, "utf8");
} catch {
  console.error(`Credential import file not found: ${credentialFile}`);
  process.exit(1);
}

const localCredentials = JSON.parse(raw);
const apiKey = process.env.WHAGONS_DEV_API_KEY || process.env.WHAGONS_SKILLS_API_KEY || process.env.SKILLS_VAULT_API_KEY || "";
if (!apiKey) {
  console.error("Set WHAGONS_SKILLS_API_KEY to an API key created in the vault UI.");
  process.exit(1);
}

const wsURL = new URL(process.env.VITE_GONVEX_WS_URL || "wss://gonvex-unified-dev.whagons.com/ws");
wsURL.searchParams.set("project", process.env.VITE_GONVEX_PROJECT_ID || "skills");

const client = new GonvexClient(wsURL.toString(), {
  token: devJWT(),
  tenant: process.env.VITE_GONVEX_PROJECT_ID || "skills",
});

try {
  let imported = 0;
  let skipped = 0;
  for (const name of credentialNames) {
    const value = localCredentials[name];
    if (value == null) {
      skipped += 1;
      console.log(`skipped ${name}`);
      continue;
    }
    await client.mutation(
      { kind: "mutation", path: "agent.credentials.save" },
      {
        apiKey,
        id: `credential-${name}`,
        name,
        summary: summarizeCredential(name, value),
        value: JSON.stringify(value),
      },
    );
    imported += 1;
    console.log(`imported ${name}`);
  }
  console.log(`done: ${imported} imported, ${skipped} skipped`);
} finally {
  client.close();
}
