// node --test tools/migrate/ — migration tool on synthetic fixtures only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateGonvexExport } from "./fixtures.mjs";
import { bundleStats, gonvexExportSQL, normalizeTime, parseExportText, toPostgresSQL, transformExport } from "./lib.mjs";
import { main } from "./migrate.mjs";

test("export SQL is a single read-only transaction over the eight tables", () => {
  const sql = gonvexExportSQL();
  assert.match(sql, /^begin transaction read only;/);
  assert.match(sql, /commit;\n$/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|truncate)\b/i);
  for (const table of ["skill_users", "skill_sessions", "skills", "skill_api_keys", "skill_credentials", "skill_workspace_members", "skill_workspace_invitations", "skill_access_roles"]) {
    assert.match(sql, new RegExp(`from ${table} t\\)`));
  }
});

test("Postgres timestamps normalize to ISO milliseconds", () => {
  assert.equal(normalizeTime("2026-08-19T07:00:46.276123+00:00"), "2026-08-19T07:00:46.276Z");
  assert.equal(normalizeTime("2026-08-19 07:00:46+02"), "2026-08-19T05:00:46.000Z");
  assert.equal(normalizeTime(null), null);
  assert.throws(() => normalizeTime("nope"));
});

test("transform reports formats and refuses plaintext unless allowed, without leaking values", async () => {
  const fixture = await generateGonvexExport();
  const strict = transformExport(fixture.exportDoc);
  assert.equal(strict.report.problems.length, 1);
  assert.match(strict.report.problems[0], /plaintext/);
  const { bundle, report } = transformExport(fixture.exportDoc, { allowPlaintext: true });
  assert.deepEqual(report.problems, []);
  assert.equal(report.droppedExpiredSessions, 1);
  assert.equal(report.counts.skill_credentials, 7);
  const reportText = JSON.stringify(report);
  for (const value of Object.values(fixture.secrets)) assert.ok(!reportText.includes(value));
  for (const value of Object.values(fixture.apiKeys)) assert.ok(!reportText.includes(value));
  assert.equal(bundle.format, "whagons-skills-vault/v1");
});

test("transform catches integrity problems", async () => {
  const fixture = await generateGonvexExport();
  const doc = structuredClone(fixture.exportDoc);
  doc.tables.skills[0].owner_id = "";
  doc.tables.skill_workspace_members[0].role_id = "missing-role";
  const { report } = transformExport(doc, { allowPlaintext: true });
  assert.ok(report.problems.some((p) => p.includes("empty owner_id")));
  assert.ok(report.problems.some((p) => p.includes("missing role")));
});

test("psql output with command tags parses; rollback SQL upserts every row", async () => {
  const fixture = await generateGonvexExport();
  const parsed = parseExportText(`BEGIN\n${JSON.stringify(fixture.exportDoc)}\nCOMMIT\n`);
  const { bundle } = transformExport(parsed, { allowPlaintext: true });
  const sql = toPostgresSQL(bundle);
  assert.equal(sql.match(/^insert into /gm).length, Object.values(bundle.tables).reduce((n, rows) => n + rows.length, 0));
  assert.match(sql, /'2026|'20\d\d-/);
  assert.match(sql, /::timestamptz/);
  // Quotes inside values are escaped.
  bundle.tables.skills[0].summary = "it's";
  assert.match(toPostgresSQL(bundle), /'it''s'/);
});

test("CLI writes 0600 bundles and stable digests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
  try {
    assert.equal(await main(["fixtures", join(dir, "export.json"), join(dir, "material.json")]), 0);
    assert.equal(await main(["transform", join(dir, "export.json"), join(dir, "bundle.json")]), 2); // plaintext row
    assert.equal(await main(["transform", join(dir, "export.json"), join(dir, "bundle.json"), "--allow-plaintext"]), 0);
    assert.equal(statSync(join(dir, "bundle.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "material.json")).mode & 0o777, 0o600);
    const bundle = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8"));
    const again = transformExport(bundle, { allowPlaintext: true }).bundle;
    assert.deepEqual(await bundleStats(again.tables), await bundleStats(bundle.tables));
    writeFileSync(join(dir, "bad.json"), "not json");
    await assert.rejects(main(["transform", join(dir, "bad.json"), join(dir, "x.json")]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
