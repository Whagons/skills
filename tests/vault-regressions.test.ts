import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dedupeCredentials } from "../src/lib/credentials.ts";
import { readVaultTab, vaultURLForTab, vaultURLWithoutCLIAuth } from "../src/lib/vault-state.ts";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the selected vault tab is restored from and written to the URL", async () => {
  const app = await source("src/App.tsx");
  assert.match(app, /readVaultTab\(window\.location\.href\)/);
  assert.match(app, /window\.addEventListener\("popstate"/);
  assert.match(app, /vaultURLForTab\(window\.location\.href, tab\)/);

  const credentialsURL = vaultURLForTab(
    "https://skills.whagons.com/?cli_state=state#selected-skill",
    "credentials",
  );
  assert.equal(credentialsURL, "/?cli_state=state&tab=credentials#selected-skill");
  assert.equal(readVaultTab(`https://skills.whagons.com${credentialsURL}`), "credentials");
  assert.equal(vaultURLForTab(`https://skills.whagons.com${credentialsURL}`, "skills"), "/?cli_state=state#selected-skill");
  assert.equal(readVaultTab("https://skills.whagons.com/?tab=unknown"), "skills");
  assert.equal(
    vaultURLWithoutCLIAuth("https://skills.whagons.com/?cli_callback=http%3A%2F%2F127.0.0.1%3A3000%2Fcallback&cli_state=x&tab=api-keys"),
    "/?tab=api-keys",
  );
});

test("credential saves replace a matching workspace name instead of allocating another row", async () => {
  const backend = await source("gonvex/skills.go");
  assert.match(backend, /id = existingCredentialID\(ctx, runner, ownerID, id, name\)/);
  assert.match(backend, /skill_credentials_unique_owner_name/);
});

test("credential rows support ID-based editing and protected reveal or copy", async () => {
  const app = await source("src/App.tsx");

  assert.match(app, /getCredential\(\{ sessionToken, id: credential\.id, name: "" \}\)/);
  assert.match(app, /setCredentialDraft\(\{\s*id: credential\.id,/);
  assert.match(app, /saveCredential\(\{ sessionToken, \.\.\.credentialDraft \}\)/);
  assert.match(app, /Copy value/);
  assert.match(app, /Hide value|Show value/);
});

test("credential rows keep identity, revealed values, and actions in readable full-width regions", async () => {
  const app = await source("src/App.tsx");
  const styles = await source("src/styles.css");

  assert.match(app, /className="keyRow credentialRow"/);
  assert.match(app, /className="credentialIdentity"/);
  assert.match(app, /className="credentialValuePanel"/);
  assert.match(app, /formatCredentialValue\(credentialSecrets\[credential\.id\]\)/);
  assert.match(styles, /\.credentialRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.credentialRow \.rowActions\s*\{[^}]*justify-content:\s*flex-start/s);
  assert.match(styles, /\.credentialIdentity strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(styles, /\.credentialValuePanel\s*\{[^}]*width:\s*100%/s);
});

test("credential encryption reads the Gonvex project environment from the request context", async () => {
  const backend = await source("gonvex/skills.go");
  assert.match(backend, /ctx\.EnvValue\("SKILLS_SECRET_KEY"\)/);
  assert.match(backend, /ctx\.EnvValue\("SKILLS_SECRET_KEY_PREVIOUS"\)/);
});

test("the credential vault collapses legacy duplicate metadata before rendering", async () => {
  const app = await source("src/App.tsx");
  assert.match(app, /dedupeCredentials\(credentialRecords\)/);

  const credentials = dedupeCredentials([
    { id: "legacy", name: "coolify-whagons", updated_at: "2026-07-10T00:00:00Z" },
    { id: "scoped", name: "COOLIFY-WHAGONS", updated_at: "2026-07-11T00:00:00Z" },
    { id: "cloudflare", name: "cloudflare", updated_at: "2026-07-09T00:00:00Z" },
  ]);
  assert.deepEqual(credentials.map(({ id }) => id), ["cloudflare", "scoped"]);
});
