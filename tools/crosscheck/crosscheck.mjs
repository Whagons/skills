// Cross-checks the Worker's credential crypto (worker/src/crypto.ts) against
// the Go implementation extracted from gonvex/skills.go, in both directions,
// with a throwaway key and synthetic values. Never use real secrets here.
//
//   node tools/crosscheck/crosscheck.mjs [--write-vectors worker/test/fixtures/go-vectors.json]

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const work = mkdtempSync(join(tmpdir(), "vault-crosscheck-"));
try {
  execFileSync("go", ["build", "-o", join(work, "extract"), join(here, "extract.go")], { stdio: "inherit" });
  execFileSync(join(work, "extract"), [join(root, "gonvex", "skills.go"), work], { stdio: "inherit" });
  rmSync(join(work, "extract"));
  copyFileSync(join(here, "harness.go.txt"), join(work, "harness.go"));
  execFileSync("go", ["mod", "init", "crosscheck"], { cwd: work, stdio: "ignore" });
  execFileSync("go", ["build", "-buildvcs=false", "-o", "harness", "."], { cwd: work, stdio: "inherit" });
  const go = (request) => JSON.parse(execFileSync(join(work, "harness"), { input: JSON.stringify(request) }).toString());

  const { build } = await import(pathToFileURL(join(root, "worker", "node_modules", "esbuild", "lib", "main.js")).href);
  const bundled = join(work, "crypto.mjs");
  await build({ entryPoints: [join(root, "worker", "src", "crypto.ts")], bundle: true, format: "esm", platform: "neutral", outfile: bundled, logLevel: "error" });
  const ts = await import(pathToFileURL(bundled).href);

  const key = randomBytes(32).toString("hex");
  const previousKey = randomBytes(32).toString("base64");
  const cases = [
    { owner: "google:100000000000000000001", id: "a1b2c3d4e5f6_skill_fixture-one", value: JSON.stringify({ apiToken: "fixture-token-" + randomBytes(6).toString("hex") }) },
    { owner: "google:100000000000000000001", id: "a1b2c3d4e5f6_local-fixture", value: "opaque fixture value ✓ ünïcödé" },
    { owner: "google:100000000000000000002", id: "x", value: "y".repeat(5000) },
  ];

  // Go encrypts -> Worker decrypts.
  const goStored = go({ mode: "encrypt", key, cases });
  for (const [i, item] of goStored.entries()) {
    assert.equal(item.error ?? "", "", "go encrypt failed");
    const out = await ts.decryptSecret({ current: key }, item.owner, item.id, item.stored);
    assert.equal(out.value, cases[i].value);
    assert.equal(out.migrate, false);
    await assert.rejects(ts.decryptSecret({ current: key }, item.owner, item.id + "-moved", item.stored), "AAD must bind the credential id");
  }
  // Worker encrypts -> Go decrypts.
  const tsStored = [];
  for (const item of cases) tsStored.push({ ...item, stored: await ts.encryptSecret({ current: key }, item.owner, item.id, item.value), value: "" });
  for (const [i, item] of go({ mode: "decrypt", key, cases: tsStored }).entries()) {
    assert.equal(item.error ?? "", "", "go decrypt of worker ciphertext failed");
    assert.equal(item.value, cases[i].value);
    assert.equal(item.migrate, false);
  }
  // Rotation: Go-encrypted under the old key decrypts with it as "previous" and asks to migrate.
  const oldStored = go({ mode: "encrypt", key: previousKey, cases: cases.slice(0, 1) })[0];
  const rotated = await ts.decryptSecret({ current: key, previous: previousKey }, oldStored.owner, oldStored.id, oldStored.stored);
  assert.equal(rotated.value, cases[0].value);
  assert.equal(rotated.migrate, true);
  // Legacy encv1 and plaintext.
  const legacy = go({ mode: "encv1", key, cases: [{ value: "legacy fixture" }] })[0];
  const legacyOut = await ts.decryptSecret({ current: key }, "any", "any", legacy.stored);
  assert.deepEqual([legacyOut.value, legacyOut.migrate, legacyOut.format], ["legacy fixture", true, "encv1"]);
  const goKeyID = goStored[0].stored.split(":")[1];
  assert.match(goKeyID, /^[0-9a-f]{12}$/);

  const write = process.argv.indexOf("--write-vectors");
  if (write > 0) {
    const vectors = { note: "Synthetic vectors from the Go implementation; throwaway key, fake values.", key, previousKey, encv2: goStored, rotated: oldStored, encv1: legacy };
    writeFileSync(join(process.cwd(), process.argv[write + 1]), JSON.stringify(vectors, null, 2) + "\n");
  }
  console.log(`crosscheck ok: ${cases.length} vectors each way, rotation and encv1 all agree`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
