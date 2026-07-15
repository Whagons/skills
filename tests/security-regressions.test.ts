import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("CLI authorization never puts an API key in a callback URL", async () => {
  const app = await source("src/App.tsx");
  const cli = await source("cli/cmd/whagons-dev/main.go");
  assert.doesNotMatch(app, /callback\.searchParams\.set\(key, value\)/);
  assert.doesNotMatch(cli, /r\.URL\.Query\(\)\.Get\("api_key"\)/);
});

test("copied setup text never embeds the live API key", async () => {
  const app = await source("src/App.tsx");
  assert.doesNotMatch(app, /printf '%s' '\$\{apiKey\}'/);
  assert.doesNotMatch(app, /export WHAGONS_DEV_API_KEY=\$\{apiKey\}/);
  assert.doesNotMatch(app, /agentExample\(apiKey\)/);
});

test("credential encryption fails closed when no key is configured", async () => {
  const backend = await source("gonvex/skills.go");
  assert.doesNotMatch(backend, /if aead == nil \{\s*return value, nil\s*\}/);
});

test("member removal revokes keys created by that member", async () => {
  const backend = await source("gonvex/skills.go");
  assert.match(backend, /update skill_api_keys set revoked_at = now\(\)[\s\S]{0,400}created_by/);
});

test("workspace invitations require explicit acceptance", async () => {
  const backend = await source("gonvex/skills.go");
  assert.match(backend, /team\.invitations\.accept/);
  assert.match(backend, /pending_only/);
});

test("production nginx sends baseline browser security headers", async () => {
  const nginx = await source("nginx.conf");
  assert.match(nginx, /Content-Security-Policy/i);
  assert.match(nginx, /frame-ancestors 'none'/i);
  assert.match(nginx, /Strict-Transport-Security[^\n]*max-age=31536000/i);
  assert.match(nginx, /Referrer-Policy[^\n]*no-referrer/i);
  assert.match(nginx, /X-Content-Type-Options[^\n]*nosniff/i);
});

test("patched Gonvex dev wrapper cannot leak project keys to URLs or child env", async () => {
  const patch = await source("patches/@gonvex__cli@0.1.10.patch");
  assert.match(patch, /env: publicChildEnvironment\(\)/);
  assert.match(patch, /sensitiveName/);
  assert.match(patch, /authenticated browser log streaming is disabled/);
  assert.doesNotMatch(patch, /^\+.*searchParams\.set\("key"/m);
});
