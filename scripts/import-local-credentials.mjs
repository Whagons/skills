import { readFile } from "node:fs/promises";
import { callVault } from "./vault-api.mjs";

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


{
  let imported = 0;
  let skipped = 0;
  for (const name of credentialNames) {
    const value = localCredentials[name];
    if (value == null) {
      skipped += 1;
      console.log(`skipped ${name}`);
      continue;
    }
    await callVault("agent.credentials.save", {
      id: `credential-${name}`,
      name,
      summary: summarizeCredential(name, value),
      value: JSON.stringify(value),
    }, apiKey);
    imported += 1;
    console.log(`imported ${name}`);
  }
  console.log(`done: ${imported} imported, ${skipped} skipped`);
}
