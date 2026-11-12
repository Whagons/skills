// The vault Durable Object: one instance ("vault") owns all data in SQLite,
// serializes every call, and implements the operator (admin) operations. All
// traffic arrives as RPC from the Worker (src/index.ts); there are no sockets.

import { DurableObject } from "cloudflare:workers";
// Plain JS module shared with the migration CLI (types in lib.d.mts).
import { BUNDLE_FORMAT, TABLES, bundleStats, canonicalTable, transformExport } from "../../tools/migrate/lib.mjs";
import { Ctx, LIMITS, type Env, type Meta } from "./context";
import { decryptSecret, encryptSecret, storedFormat } from "./crypto";
import { FUNCTIONS } from "./functions";
import { DATA_TABLES, migrate } from "./schema";
import { DAY_MS, VaultError, addMs, nowISO, sha256Hex } from "./util";

export type CallResult = { ok: true; result: unknown } | { ok: false; error: string; status: number };

const AUDIT_RETENTION_DAYS = 400;

export class Vault extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly contentCache = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql);
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  // Every call runs to completion before the next starts, so the read-then-
  // write rules (limits, unique names, role checks) never interleave.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private context(meta: Meta): Ctx {
    return new Ctx(this.ctx.storage, this.env, meta, this.contentCache);
  }

  // ---------------------------------------------------------------------
  // RPC entry points used by the Worker.

  async call(path: string, args: unknown, meta: Meta): Promise<CallResult> {
    const def = Object.hasOwn(FUNCTIONS, path) ? FUNCTIONS[path] : undefined;
    if (!def) return { ok: false, error: `unknown function: ${path}`, status: 404 };
    return this.invoke(path, args, meta);
  }

  private async invoke(path: string, rawArgs: unknown, meta: Meta): Promise<CallResult> {
    const def = FUNCTIONS[path];
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    try {
      let prepared: unknown;
      if (def.prepare) {
        const c = this.context(meta);
        prepared = await def.prepare(c, args);
      }
      const result = await this.serialize(async () => {
        return def.handler(this.context(meta), args, prepared);
      });
      return { ok: true, result: result ?? null };
    } catch (error) {
      return failure(error);
    }
  }

  async admin(op: string, body: unknown, params: Record<string, string>, meta: Meta): Promise<CallResult> {
    try {
      const result = await this.serialize(async () => {
        const c = this.context(meta);
        c.actor = { id: "admin", workspace: "", via: "admin" };
        switch (op) {
          case "stats": return this.stats(c);
          case "export": return this.exportBundle(c, params.audit === "1");
          case "import": return this.importBundle(c, body, params.replace === "1");
          case "verify-decrypt": return this.verifyDecrypt(c);
          case "reencrypt": return this.reencrypt(c);
          default: throw new VaultError(`unknown admin operation: ${op}`, 404);
        }
      });
      return { ok: true, result };
    } catch (error) {
      return failure(error);
    }
  }

  async backup(): Promise<{ key: string; bytes: number }> {
    if (!this.env.BLOBS) throw new Error("BLOBS bucket is not bound");
    const bundle = await this.serialize(() => this.exportBundle(this.context({ ip: "", userAgent: "cron", ray: "" }), true));
    const text = JSON.stringify(bundle);
    const key = `backups/${new Date().toISOString().slice(0, 10)}.json`;
    await this.env.BLOBS.put(key, text, { httpMetadata: { contentType: "application/json" } });
    return { key, bytes: text.length };
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const now = nowISO();
      this.ctx.storage.sql.exec("delete from skill_sessions where expires_at < ?", addMs(now, -7 * DAY_MS));
      this.ctx.storage.sql.exec("delete from audit_events where at < ?", addMs(now, -AUDIT_RETENTION_DAYS * DAY_MS));
    });
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }

  // ---------------------------------------------------------------------
  // Operator operations. None returns plaintext secrets.

  private async exportTables(c: Ctx): Promise<Record<string, Array<Record<string, unknown>>>> {
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of DATA_TABLES) {
      const rows = c.all(`select * from ${table}`);
      if (table === "skills") {
        for (const row of rows) {
          row.content = await c.skillContent(row);
          delete row.content_r2_key;
        }
      }
      for (const row of rows) delete row.name_key;
      tables[table] = canonicalTable(table, rows);
    }
    return tables;
  }

  private async exportBundle(c: Ctx, includeAudit: boolean) {
    const tables = await this.exportTables(c);
    const bundle: Record<string, unknown> = { format: BUNDLE_FORMAT, exported_at: nowISO(), source: "cloudflare", tables };
    if (includeAudit) bundle.audit = c.all("select * from audit_events order by id");
    c.audit({ action: "admin.export", detail: includeAudit ? "with audit" : "" });
    return bundle;
  }

  private async stats(c: Ctx) {
    const tables = await this.exportTables(c);
    const formats: Record<string, number> = {};
    for (const row of c.all<{ secret_value: string }>("select secret_value from skill_credentials")) {
      const format = storedFormat(row.secret_value);
      formats[format] = (formats[format] ?? 0) + 1;
    }
    const meta = Object.fromEntries(c.all<{ key: string; value: string }>("select key, value from vault_meta").map((row) => [row.key, row.value]));
    return {
      tables: await bundleStats(tables),
      credentialFormats: formats,
      auditEvents: Number(c.one<{ n: number }>("select count(*) as n from audit_events")?.n ?? 0),
      meta,
    };
  }

  private async importBundle(c: Ctx, body: unknown, replace: boolean) {
    const input = body as { format?: string; source?: string; tables?: unknown; audit?: unknown[] };
    if (!input || input.format !== BUNDLE_FORMAT) throw new VaultError(`bundle format must be ${BUNDLE_FORMAT}`);
    const { bundle, report } = transformExport(input, { allowPlaintext: true, source: input.source ?? "import" });
    if (report.problems.length) throw new VaultError(`bundle has problems: ${report.problems.join("; ")}`);
    const existing = DATA_TABLES.reduce((sum, table) => sum + Number(c.one<{ n: number }>(`select count(*) as n from ${table}`)?.n ?? 0), 0);
    if (existing > 0 && !replace) throw new VaultError("the vault is not empty; pass replace=1 to overwrite it", 409);

    // Large skill bodies go to R2 before the transaction.
    const skills = bundle.tables.skills as Array<Record<string, unknown>>;
    const overflow = new Map<string, string>();
    for (const row of skills) {
      const content = String(row.content);
      if (new TextEncoder().encode(content).byteLength > LIMITS.inlineContentBytes) {
        if (!this.env.BLOBS) throw new VaultError("skill content storage is not configured", 500);
        const key = `skills/${row.id}/${row.content_hash || (await sha256Hex(content))}`;
        await this.env.BLOBS.put(key, content, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
        overflow.set(String(row.id), key);
      }
    }
    c.tx(() => {
      if (replace) for (const table of DATA_TABLES) c.run(`delete from ${table}`);
      for (const table of DATA_TABLES) {
        const spec = TABLES[table] as { columns: Record<string, string> };
        const columns = Object.keys(spec.columns);
        const extra = table === "skills" ? ["name_key", "content_r2_key"] : table === "skill_credentials" ? ["name_key"] : [];
        const all = [...columns, ...extra];
        const statement = `insert into ${table} (${all.join(", ")}) values (${all.map(() => "?").join(", ")})`;
        for (const row of bundle.tables[table] as Array<Record<string, unknown>>) {
          const values = columns.map((column) => {
            const value = row[column];
            if (spec.columns[column] === "bool") return value ? 1 : 0;
            if (table === "skills" && column === "content" && overflow.has(String(row.id))) return "";
            return value ?? null;
          });
          if (table === "skills") values.push(String(row.name).trim().toLowerCase(), overflow.get(String(row.id)) ?? null);
          if (table === "skill_credentials") values.push(String(row.name).trim().toLowerCase());
          c.run(statement, ...values);
        }
      }
      if (Array.isArray(input.audit) && replace) {
        c.run("delete from audit_events");
        for (const event of input.audit as Array<Record<string, unknown>>) {
          c.run(
            `insert into audit_events (at, workspace_id, actor_id, actor_email, via, api_key_id, action, target_type, target_id, target_name, outcome, detail, ip, user_agent, cf_ray)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ...["at", "workspace_id", "actor_id", "actor_email", "via", "api_key_id", "action", "target_type", "target_id", "target_name", "outcome", "detail", "ip", "user_agent", "cf_ray"]
              .map((key) => String(event[key] ?? "")),
          );
        }
      }
      c.run("insert into vault_meta (key, value) values ('imported_at', ?) on conflict (key) do update set value = excluded.value", nowISO());
      c.run("insert into vault_meta (key, value) values ('imported_from', ?) on conflict (key) do update set value = excluded.value", String(bundle.source ?? ""));
    });
    this.contentCache.clear();
    c.audit({ action: "admin.import", detail: JSON.stringify(report.counts).slice(0, 300) });
    // Legacy plaintext/encv1 rows (and rows under a previous key) are
    // re-encrypted immediately so they never sit unprotected in storage,
    // PITR snapshots or backups waiting for a first read.
    const reencrypted = (this.env.SKILLS_SECRET_KEY ?? "").trim() ? await this.reencrypt(c) : null;
    return { report, reencrypted, stats: await bundleStats(await this.exportTables(c)) };
  }

  private async verifyDecrypt(c: Ctx) {
    const result = { total: 0, ok: 0, failed: 0, needsMigration: 0, formats: {} as Record<string, number> };
    for (const row of c.all<{ id: string; owner_id: string; secret_value: string }>("select id, owner_id, secret_value from skill_credentials")) {
      result.total++;
      const format = storedFormat(row.secret_value);
      result.formats[format] = (result.formats[format] ?? 0) + 1;
      try {
        const decrypted = await decryptSecret(c.keys(), row.owner_id, row.id, row.secret_value);
        result.ok++;
        if (decrypted.migrate) result.needsMigration++;
      } catch {
        result.failed++;
      }
    }
    c.audit({ action: "admin.verifyDecrypt", detail: `ok ${result.ok} failed ${result.failed}` });
    return result;
  }

  private async reencrypt(c: Ctx) {
    const result = { total: 0, rewritten: 0, failed: 0 };
    for (const row of c.all<{ id: string; owner_id: string; secret_value: string }>("select id, owner_id, secret_value from skill_credentials")) {
      result.total++;
      try {
        const decrypted = await decryptSecret(c.keys(), row.owner_id, row.id, row.secret_value);
        if (!decrypted.migrate) continue;
        const stored = await encryptSecret(c.keys(), row.owner_id, row.id, decrypted.value);
        c.run("update skill_credentials set secret_value = ? where id = ?", stored, row.id);
        result.rewritten++;
      } catch {
        result.failed++;
      }
    }
    c.audit({ action: "admin.reencrypt", detail: `rewritten ${result.rewritten} failed ${result.failed}` });
    return result;
  }
}

function failure(error: unknown): CallResult & { ok: false } {
  if (error instanceof VaultError) return { ok: false, error: error.message, status: error.status };
  console.error("vault internal error", error instanceof Error ? error.name : typeof error);
  return { ok: false, error: "internal error", status: 500 };
}
