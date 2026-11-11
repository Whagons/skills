#!/usr/bin/env node
// Skills Vault migration tool: Gonvex Postgres -> Cloudflare Worker, and back
// for rollback. See docs/cloudflare/DESIGN.md §7 and §9.
//
// It never prints secret values, tokens or hashes. Output files that contain
// ciphertext and hashes are written with mode 0600.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { generateGonvexExport } from "./fixtures.mjs";
import { bundleStats, gonvexExportSQL, parseExportText, toPostgresSQL, transformExport } from "./lib.mjs";

const USAGE = `usage:
  migrate.mjs export-sql                                   print the read-only export SQL for psql
  migrate.mjs transform <export.json> <bundle.json> [--allow-plaintext]
  migrate.mjs import <bundle.json> --url <worker-url> [--replace]
  migrate.mjs verify <bundle.json> --url <worker-url>
  migrate.mjs export --url <worker-url> <out.json>          pull the vault (ciphertext/hashes only)
  migrate.mjs to-postgres <bundle.json>                     print rollback upsert SQL for Gonvex
  migrate.mjs fixtures <export.json> <key-file>             write a synthetic Gonvex export + throwaway key

Admin calls read the bearer token from VAULT_ADMIN_TOKEN.`;

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
function bool(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}
function readJSON(path) {
  return parseExportText(readFileSync(path, "utf8"));
}
function adminToken() {
  const token = process.env.VAULT_ADMIN_TOKEN ?? "";
  if (token.length < 32) throw new Error("set VAULT_ADMIN_TOKEN (the Worker's ADMIN_TOKEN secret)");
  return token;
}
async function admin(url, op, { method = "GET", body, query = "" } = {}) {
  const response = await fetch(new URL(`/admin/${op}${query}`, url), {
    method,
    headers: { Authorization: `Bearer ${adminToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${op}: HTTP ${response.status} (non-JSON response)`);
  }
  if (!response.ok || parsed.error) throw new Error(`${op}: HTTP ${response.status}: ${parsed.error ?? "failed"}`);
  return parsed.result;
}
function printReport(report) {
  console.log("rows:", JSON.stringify(report.counts));
  console.log("credential formats:", JSON.stringify(report.credentialFormats));
  if (report.droppedExpiredSessions) console.log(`dropped ${report.droppedExpiredSessions} expired session(s)`);
  for (const warning of report.warnings) console.log("warning:", warning);
  for (const problem of report.problems) console.log("PROBLEM:", problem);
}

export async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  switch (command) {
    case "export-sql":
      process.stdout.write(gonvexExportSQL());
      return 0;
    case "transform": {
      const allowPlaintext = bool(args, "--allow-plaintext");
      const [input, output] = args;
      if (!input || !output) throw new Error(USAGE);
      const { bundle, report } = transformExport(readJSON(input), { allowPlaintext, source: "gonvex" });
      printReport(report);
      if (report.problems.length) {
        console.log("not writing a bundle until the problems are fixed");
        return 2;
      }
      writePrivate(output, JSON.stringify(bundle));
      const stats = await bundleStats(bundle.tables);
      console.log("bundle digests:", JSON.stringify(Object.fromEntries(Object.entries(stats).map(([t, s]) => [t, s.digest.slice(0, 12)]))));
      console.log(`wrote ${output} (mode 0600)`);
      return 0;
    }
    case "import": {
      const url = flag(args, "--url");
      const replace = bool(args, "--replace");
      const [input] = args;
      if (!url || !input) throw new Error(USAGE);
      const result = await admin(url, "import", { method: "POST", body: readJSON(input), query: replace ? "?replace=1" : "" });
      printReport(result.report);
      console.log("imported");
      return 0;
    }
    case "verify": {
      const url = flag(args, "--url");
      const [input] = args;
      if (!url || !input) throw new Error(USAGE);
      const bundle = readJSON(input);
      const expected = await bundleStats(bundle.tables);
      const actual = await admin(url, "stats");
      let failures = 0;
      for (const [table, stat] of Object.entries(expected)) {
        const remote = actual.tables[table];
        const same = remote && remote.count === stat.count && remote.digest === stat.digest;
        console.log(`${same ? "ok  " : "DIFF"} ${table}: ${stat.count} row(s)${same ? "" : ` (vault has ${remote?.count ?? "?"})`}`);
        if (!same) failures++;
      }
      const decrypt = await admin(url, "verify-decrypt");
      console.log(`credentials: ${decrypt.ok}/${decrypt.total} decrypt with the configured key; ${decrypt.needsMigration} need re-encryption; ${decrypt.failed} failed`);
      if (decrypt.failed) failures++;
      console.log(failures ? "VERIFY FAILED" : "verify ok");
      return failures ? 1 : 0;
    }
    case "export": {
      const url = flag(args, "--url");
      const [output] = args;
      if (!url || !output) throw new Error(USAGE);
      const bundle = await admin(url, "export");
      writePrivate(output, JSON.stringify(bundle));
      console.log(`wrote ${output} (mode 0600)`);
      return 0;
    }
    case "to-postgres": {
      const [input] = args;
      if (!input) throw new Error(USAGE);
      process.stdout.write(toPostgresSQL(readJSON(input)));
      return 0;
    }
    case "fixtures": {
      const [output, keyFile] = args;
      if (!output || !keyFile) throw new Error(USAGE);
      const fixture = await generateGonvexExport();
      writePrivate(output, JSON.stringify(fixture.exportDoc));
      writePrivate(keyFile, JSON.stringify({ key: fixture.key, apiKeys: fixture.apiKeys, sessions: fixture.sessions, secrets: fixture.secrets }));
      console.log(`wrote synthetic export ${output} and throwaway key material ${keyFile}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
