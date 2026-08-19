import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dedupeCredentials } from "../src/lib/credentials.ts";
import { invitationInstructions } from "../src/lib/invitations.ts";
import { isCurrentSkillRevision } from "../src/lib/skill-review.ts";
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

test("pending invitations distinguish loading and query failures from an empty result", async () => {
  const app = await source("src/App.tsx");

  assert.doesNotMatch(
    app,
    /const invitations = useQuery<WorkspaceInvitation\[\]>\(api\.team\.invitations\.list, protectedArgs\) \?\? \[\]/,
  );
  assert.match(app, /invitationLoad\.status === "loading"/);
  assert.match(app, /invitationLoad\.status === "error"/);
  assert.match(app, /Could not load (?:the )?invitation/i);
});

test("invite instructions name the exact Google account and acceptance steps", () => {
  const message = invitationInstructions("Teammate@Example.com", "https://skills.whagons.com");

  assert.match(message, /teammate@example\.com/);
  assert.match(message, /https:\/\/skills\.whagons\.com/);
  assert.match(message, /Sign in with Google/);
  assert.match(message, /Accept the workspace invitation/);
});

test("workspace API keys can explicitly opt out of expiration", async () => {
  const app = await source("src/App.tsx");
  const backend = await source("gonvex/skills.go");
  const schema = await source("gonvex/schema.go");

  assert.match(app, /<option value="never">Never expires<\/option>/);
  assert.match(app, /Never expires/);
  assert.match(backend, /NeverExpires\s+bool\s+`json:"never_expires"`/);
  assert.match(backend, /expires_at is null or expires_at > now\(\)/);
  assert.match(schema, /t\.Time\("expires_at", gonvex\.Nullable\)/);
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

test("skill review never presents cached content from an older revision", async () => {
  const metadata = { id: "skill-1", updated_at: "2026-08-13T18:00:00Z" };
  const staleDetail = { id: "skill-1", updated_at: "2026-08-12T18:00:00Z" };
  const currentDetail = { id: "skill-1", updated_at: "2026-08-13T18:00:00Z" };

  assert.equal(isCurrentSkillRevision(metadata, staleDetail), false);
  assert.equal(isCurrentSkillRevision(metadata, currentDetail), true);

  const app = await source("src/App.tsx");
  assert.match(app, /gonvex\.query<Skill>\(api\.skills\.get/);
  assert.match(app, /const approved = await approveSkill/);
  assert.match(app, /setSelectedSkillLoad\([^;]*approved/s);
});

test("sync projections never include secret-bearing columns", async () => {
  const syncs = await source("gonvex/syncs.go");
  assert.doesNotMatch(syncs, /key_hash/);
  assert.doesNotMatch(syncs, /secret_value/);
  assert.match(syncs, /EqualArg\("owner_id", "ownerId"\)/);
  assert.match(syncs, /identity\.WorkspaceID/);
});
