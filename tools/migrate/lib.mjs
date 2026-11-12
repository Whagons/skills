// Shared, dependency-free definition of the vault data bundle. Used by the
// migration CLI (Node) and by the Worker's /admin/import, /admin/export and
// /admin/stats (workerd), so both sides canonicalize and digest rows the same
// way. Never log row values from here: rows include ciphertext and hashes.

export const BUNDLE_FORMAT = "whagons-skills-vault/v1";
export const GONVEX_EXPORT_FORMAT = "whagons-skills-gonvex-export/v1";

// Column kinds: text, time (non-null timestamp), timeNull, bool.
/** @type {Record<string, { key: string, columns: Record<string, "text"|"time"|"timeNull"|"bool"> }>} */
export const TABLES = {
  skill_users: {
    key: "owner_id",
    columns: { owner_id: "text", email: "text", name: "text", can_own: "bool", created_at: "time", updated_at: "time" },
  },
  skill_sessions: {
    key: "id",
    columns: {
      id: "text", owner_id: "text", workspace_id: "text", token_hash: "text", pending_only: "bool",
      created_at: "time", expires_at: "time", revoked_at: "timeNull",
    },
  },
  skills: {
    key: "id",
    columns: {
      id: "text", owner_id: "text", name: "text", summary: "text", content: "text", content_hash: "text",
      approved_at: "timeNull", approved_by: "text", created_at: "time", updated_at: "time",
    },
  },
  skill_api_keys: {
    key: "id",
    columns: {
      id: "text", owner_id: "text", created_by: "text", name: "text", key_hash: "text", prefix: "text",
      scopes: "text", created_at: "time", expires_at: "timeNull", revoked_at: "timeNull",
    },
  },
  skill_credentials: {
    key: "id",
    columns: { id: "text", owner_id: "text", name: "text", summary: "text", secret_value: "text", created_at: "time", updated_at: "time" },
  },
  skill_workspace_members: {
    key: "id",
    columns: { id: "text", workspace_owner_id: "text", email: "text", invited_by: "text", role_id: "text", created_at: "time" },
  },
  skill_workspace_invitations: {
    key: "id",
    columns: {
      id: "text", workspace_owner_id: "text", email: "text", invited_by: "text", role_id: "text",
      created_at: "time", accepted_at: "timeNull", rejected_at: "timeNull",
    },
  },
  skill_access_roles: {
    key: "id",
    columns: { id: "text", workspace_owner_id: "text", name: "text", policy: "text" },
  },
};

export const TABLE_NAMES = Object.keys(TABLES);

// Postgres json renders timestamptz as "2026-08-19T07:00:46.276123+00:00";
// JavaScript keeps milliseconds. Normalize everything to ISO-8601 UTC ms.
export function normalizeTime(value) {
  if (value === null || value === undefined || value === "") return null;
  let text = String(value).trim().replace(" ", "T");
  text = text.replace(/(\.\d{3})\d+/, "$1");
  if (/[+-]\d{2}$/.test(text)) text += ":00";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp ${JSON.stringify(String(value).slice(0, 40))}`);
  return new Date(ms).toISOString();
}

export function canonicalRow(table, row) {
  const spec = TABLES[table];
  const out = {};
  for (const [column, kind] of Object.entries(spec.columns)) {
    const value = row[column];
    if (kind === "bool") out[column] = value === true || value === 1 || value === "1" || value === "t" || value === "true";
    else if (kind === "time") {
      const time = normalizeTime(value);
      if (time === null) throw new Error(`${table}.${column} is required`);
      out[column] = time;
    } else if (kind === "timeNull") out[column] = normalizeTime(value);
    else out[column] = value === null || value === undefined ? "" : String(value);
  }
  return out;
}

export function canonicalTable(table, rows) {
  const key = TABLES[table].key;
  return rows.map((row) => canonicalRow(table, row)).sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

export async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Per-table counts and digests of canonical rows. Digests reveal nothing
// about values but change if any value differs. Credential digests cover
// metadata only: import re-encrypts legacy rows (and rotation rewrites all
// of them), so ciphertext is checked by decrypting (/admin/verify-decrypt).
export async function bundleStats(tables) {
  const stats = {};
  for (const table of TABLE_NAMES) {
    let rows = canonicalTable(table, tables[table] ?? []);
    if (table === "skill_credentials") rows = rows.map(({ secret_value: _secret, ...meta }) => meta);
    stats[table] = { count: rows.length, digest: await sha256Hex(JSON.stringify(rows)) };
  }
  return stats;
}

export function credentialFormat(stored) {
  const value = String(stored ?? "");
  if (value.startsWith("encv2:")) return `encv2:${value.split(":")[1] ?? ""}`;
  if (value.startsWith("encv1:")) return "encv1";
  return "plaintext";
}

const MAX_SKILL_BYTES = 2 << 20;
const MAX_CREDENTIAL_BYTES = 256 << 10;

/**
 * Turn a Gonvex Postgres export (or a vault export) into an import bundle and
 * a report. The report holds counts and problems only, never values.
 */
export function transformExport(input, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const source = input?.tables ? input.tables : input;
  if (!source || typeof source !== "object") throw new Error("export has no tables");
  const problems = [];
  const warnings = [];
  const tables = {};
  for (const table of TABLE_NAMES) {
    const rows = source[table];
    if (rows === undefined || rows === null) {
      warnings.push(`${table}: missing from export, treated as empty`);
      tables[table] = [];
      continue;
    }
    if (!Array.isArray(rows)) throw new Error(`${table} is not an array`);
    const known = new Set(Object.keys(TABLES[table].columns));
    const unknown = new Set();
    for (const row of rows) for (const column of Object.keys(row)) if (!known.has(column)) unknown.add(column);
    if (unknown.size) warnings.push(`${table}: ignoring columns ${[...unknown].sort().join(", ")}`);
    tables[table] = canonicalTable(table, rows);
  }

  // A user row without an identity can never sign in (sessions and keys are
  // keyed by "google:<sub>"); drop it rather than fail the migration.
  const orphanUsers = tables.skill_users.filter((row) => !row.owner_id).length;
  if (orphanUsers) {
    tables.skill_users = tables.skill_users.filter((row) => row.owner_id);
    warnings.push(`skill_users: dropped ${orphanUsers} row(s) with an empty owner_id (no identity; cannot sign in)`);
  }

  // Expired sessions are useless after migration; keep live ones so browser
  // sessions survive the cutover.
  const sessionsBefore = tables.skill_sessions.length;
  tables.skill_sessions = tables.skill_sessions.filter((row) => row.expires_at > now);
  const droppedSessions = sessionsBefore - tables.skill_sessions.length;

  const ownerColumns = { skills: "owner_id", skill_api_keys: "owner_id", skill_credentials: "owner_id", skill_sessions: "owner_id" };
  for (const [table, column] of Object.entries(ownerColumns)) {
    const empty = tables[table].filter((row) => !row[column]).length;
    if (empty) problems.push(`${table}: ${empty} row(s) have an empty ${column}; claim legacy rows in Gonvex before migrating`);
  }
  for (const table of TABLE_NAMES) {
    const key = TABLES[table].key;
    const seen = new Set();
    for (const row of tables[table]) {
      if (!row[key]) problems.push(`${table}: row with empty ${key}`);
      if (seen.has(row[key])) problems.push(`${table}: duplicate ${key}`);
      seen.add(row[key]);
    }
  }
  const uniqueBy = (table, fields, label, filter = () => true) => {
    const seen = new Set();
    let duplicates = 0;
    for (const row of tables[table].filter(filter)) {
      const id = fields.map((field) => field(row)).join("\u0000");
      if (seen.has(id)) duplicates++;
      seen.add(id);
    }
    if (duplicates) problems.push(`${table}: ${duplicates} duplicate ${label}`);
  };
  uniqueBy("skill_credentials", [(r) => r.owner_id, (r) => r.name.trim().toLowerCase()], "credential name(s) in one workspace");
  uniqueBy("skill_api_keys", [(r) => r.key_hash], "key hash(es)");
  uniqueBy("skill_sessions", [(r) => r.token_hash], "token hash(es)");
  uniqueBy("skill_workspace_members", [(r) => r.workspace_owner_id, (r) => r.email], "member email(s) in one workspace");
  uniqueBy("skill_workspace_invitations", [(r) => r.workspace_owner_id, (r) => r.email], "pending invitation(s) for one email",
    (r) => r.accepted_at === null && r.rejected_at === null);

  const encoder = new TextEncoder();
  for (const row of tables.skills) {
    if (encoder.encode(row.content).byteLength > MAX_SKILL_BYTES) problems.push(`skills: a skill exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  const formats = {};
  for (const row of tables.skill_credentials) {
    const format = credentialFormat(row.secret_value);
    formats[format] = (formats[format] ?? 0) + 1;
    if (format === "plaintext" && !options.allowPlaintext) {
      problems.push("skill_credentials: a credential is stored in plaintext; read it once in Gonvex to re-encrypt it, or pass --allow-plaintext");
    }
    if (row.secret_value.length > MAX_CREDENTIAL_BYTES * 2) problems.push("skill_credentials: a stored value is unexpectedly large");
  }
  const skillIDs = new Set(tables.skills.map((row) => row.id));
  const credentialIDs = new Set(tables.skill_credentials.map((row) => row.id));
  const roleIDs = new Set(tables.skill_access_roles.map((row) => row.id));
  for (const row of tables.skill_access_roles) {
    let policy;
    try {
      policy = JSON.parse(row.policy);
    } catch {
      problems.push("skill_access_roles: a role policy is not valid JSON");
      continue;
    }
    const missing = [...(policy.skill_ids ?? [])].filter((id) => !skillIDs.has(id)).length
      + [...(policy.credential_ids ?? [])].filter((id) => !credentialIDs.has(id)).length;
    if (missing) warnings.push(`skill_access_roles: a role references ${missing} item(s) that no longer exist (kept; they grant nothing)`);
  }
  for (const table of ["skill_workspace_members", "skill_workspace_invitations"]) {
    const dangling = tables[table].filter((row) => row.role_id && row.role_id !== "full" && !roleIDs.has(row.role_id)).length;
    if (dangling) problems.push(`${table}: ${dangling} row(s) reference a missing role`);
  }

  const counts = Object.fromEntries(TABLE_NAMES.map((table) => [table, tables[table].length]));
  return {
    bundle: { format: BUNDLE_FORMAT, exported_at: now, source: options.source ?? "gonvex", tables },
    report: { counts, droppedExpiredSessions: droppedSessions, credentialFormats: formats, problems, warnings },
  };
}

// SQL that dumps the eight vault tables as one JSON document inside a
// read-only transaction. Run with: psql -qAt -v ON_ERROR_STOP=1 -f -
export function gonvexExportSQL() {
  const parts = TABLE_NAMES.map((table) => {
    const key = TABLES[table].key;
    return `'${table}', (select coalesce(json_agg(t order by t.${key}), '[]'::json) from ${table} t)`;
  });
  return [
    "begin transaction read only;",
    `select json_build_object('format', '${GONVEX_EXPORT_FORMAT}', 'exported_at', now(), 'tables', json_build_object(\n  ${parts.join(",\n  ")}\n));`,
    "commit;",
    "",
  ].join("\n");
}

function sqlLiteral(value, kind) {
  if (value === null || value === undefined) return "null";
  if (kind === "bool") return value ? "true" : "false";
  const text = String(value).replaceAll("'", "''");
  return kind === "time" || kind === "timeNull" ? `'${text}'::timestamptz` : `'${text}'`;
}

// Rollback helper: idempotent upserts that put a vault export back into the
// Gonvex tables. Ciphertext and hashes move unchanged. Rows deleted in the
// vault after cutover are listed for manual review rather than deleted.
export function toPostgresSQL(bundle) {
  const lines = ["begin;"];
  for (const table of TABLE_NAMES) {
    const spec = TABLES[table];
    const columns = Object.keys(spec.columns);
    const rows = canonicalTable(table, bundle.tables?.[table] ?? []);
    for (const row of rows) {
      const values = columns.map((column) => sqlLiteral(row[column], spec.columns[column]));
      const updates = columns.filter((column) => column !== spec.key).map((column) => `${column} = excluded.${column}`);
      lines.push(`insert into ${table} (${columns.join(", ")}) values (${values.join(", ")}) on conflict (${spec.key}) do update set ${updates.join(", ")};`);
    }
  }
  lines.push("commit;", "");
  return lines.join("\n");
}

// Parse psql output: tolerate command tags or blank lines around the JSON.
export function parseExportText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object found in export");
  return JSON.parse(text.slice(start, end + 1));
}
