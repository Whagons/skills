// Every vault function, ported from gonvex/skills.go, gonvex/access.go and
// gonvex/syncs.go with the same paths, arguments, result shapes and error
// strings. See docs/cloudflare/DESIGN.md §2.2 and §4.4.

import {
  Ctx, DEFAULT_GOOGLE_CLIENT_ID, LIMITS, PENDING_ERROR, SCOPES, type AccessRole, type Identity, type Row,
  callerRole, fullAccess, identityAllowed, identityRole, isOwner, normalizeScopes, parseRole, readRole,
  requireAccess, roleAllows, verifyAPIKey, verifySession, verifySessionIdentity,
} from "./context";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  DAY_MS, VaultError, addMs, byteLength, deny, hasControl, hasSpace, hashToken, nowISO, randomID, randomToken,
  sha256Hex, splitCSV, unauthorized,
} from "./util";

type Args = Record<string, unknown>;
type Handler = (c: Ctx, args: Args, prepared?: unknown) => Promise<unknown>;
export type FunctionKind = "query" | "mutation" | "action" | "sync";
export type FunctionDef = {
  kind: FunctionKind;
  handler: Handler;
  // Queries re-run for live subscriptions after writes. Point reads of secret
  // values are one-shot so a subscription never re-reads (and re-audits) them.
  live?: boolean;
  // Network work done before the call is serialized (Google token checks).
  prepare?: (c: Ctx, args: Args) => Promise<unknown>;
};

const s = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const deleted = (value: boolean) => ({ deleted: value });

// ---------------------------------------------------------------------------
// Row shapes

type SkillMeta = { id: string; name: string; summary: string; created_at: string; updated_at: string; approved: boolean };
type CredentialMeta = { id: string; name: string; summary: string; created_at: string; updated_at: string };

function skillMeta(row: Row): SkillMeta {
  return {
    id: s(row.id), name: s(row.name), summary: s(row.summary), created_at: s(row.created_at), updated_at: s(row.updated_at),
    approved: row.approved_at !== null && row.approved_at !== undefined,
  };
}

function credentialMeta(row: Row): CredentialMeta {
  return { id: s(row.id), name: s(row.name), summary: s(row.summary), created_at: s(row.created_at), updated_at: s(row.updated_at) };
}

function apiKeyRecord(row: Row, canRevoke = false) {
  const record: Record<string, unknown> = {
    can_revoke: canRevoke, id: s(row.id), name: s(row.name), prefix: s(row.prefix), created_at: s(row.created_at),
  };
  if (row.revoked_at) record.revoked_at = s(row.revoked_at);
  record.expires_at = row.expires_at ? s(row.expires_at) : null;
  record.scopes = splitCSV(s(row.scopes));
  if (row.created_by) record.created_by = s(row.created_by);
  return record;
}

// ---------------------------------------------------------------------------
// Skills

function skillIdentityKey(id: string, name: string): string {
  let value = id.trim();
  const index = value.indexOf("_");
  if (index === 12 && value.length > 13) value = value.slice(index + 1);
  value = value.replace(/^local-/, "").replace(/^cloud-/, "");
  return value ? value.toLowerCase() : name.trim().toLowerCase();
}

function sortByNameThenNewest<T extends { name: string; updated_at: string }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    if (left === right) return b.updated_at.localeCompare(a.updated_at);
    return left < right ? -1 : 1;
  });
}

function listSkills(c: Ctx, workspace: string, approvedOnly: boolean): SkillMeta[] {
  const rows = c.all(
    `select id, name, summary, created_at, updated_at, approved_at from skills
     where owner_id = ? and (? = 0 or approved_at is not null) order by name_key, updated_at desc`,
    workspace, approvedOnly ? 1 : 0,
  );
  const byKey = new Map<string, SkillMeta>();
  for (const row of rows) {
    const skill = skillMeta(row);
    const key = skillIdentityKey(skill.id, skill.name);
    const current = byKey.get(key);
    if (!current || skill.updated_at > current.updated_at) byKey.set(key, skill);
  }
  return sortByNameThenNewest([...byKey.values()]);
}

async function scopedID(workspace: string, rawID: string): Promise<string> {
  const id = rawID.trim();
  if (!id) return id;
  const prefix = (await hashToken(workspace)).slice(0, 12) + "_";
  return id.startsWith(prefix) ? id : prefix + id;
}

async function existingID(c: Ctx, table: "skills" | "skill_credentials", workspace: string, rawID: string, name: string): Promise<string> {
  const id = rawID.trim();
  const scoped = await scopedID(workspace, id);
  const key = name.trim().toLowerCase();
  const row = c.one<{ id: string }>(
    `select id from ${table} where owner_id = ? and (id = ? or id = ? or name_key = ?)
     order by case when id = ? then 0 when name_key = ? then 1 when id = ? then 2 else 3 end, updated_at desc limit 1`,
    workspace, scoped, id, key, scoped, key, id,
  );
  return row?.id?.trim() ? row.id : scoped;
}

async function getSkill(c: Ctx, workspace: string, rawID: unknown, rawName: unknown, approvedOnly: boolean) {
  const id = s(rawID).trim();
  const name = s(rawName).trim();
  const row = c.one(
    `select * from skills where owner_id = ? and ((? <> '' and id = ?) or (? <> '' and name_key = ?))
     and (? = 0 or approved_at is not null) order by updated_at desc limit 1`,
    workspace, id, id, name, name.toLowerCase(), approvedOnly ? 1 : 0,
  );
  if (!row) throw new VaultError("skill not found", 404);
  return { ...skillMeta(row), content: await c.skillContent(row) };
}

async function saveSkill(c: Ctx, workspace: string, rawID: string, rawName: string, rawSummary: string, rawContent: string, approved: boolean, approvedBy: string) {
  const name = rawName.trim();
  const content = rawContent.trim();
  const summary = rawSummary;
  if (!name) throw new VaultError("skill name is required");
  if (!content) throw new VaultError("skill content is required");
  if (byteLength(name) > LIMITS.maxNameLength || byteLength(summary) > LIMITS.maxSummaryLength) {
    throw new VaultError("skill name or summary exceeds the allowed length");
  }
  if (hasControl(name) || hasControl(summary)) throw new VaultError("skill name or summary contains control characters");
  const contentBytes = byteLength(content);
  if (contentBytes > LIMITS.maxSkillContentBytes) throw new VaultError(`skill content exceeds the ${LIMITS.maxSkillContentBytes}-byte limit`);
  let id = rawID.trim() || randomID();
  if (id.length > 240) throw new VaultError("skill id is too long");
  id = await existingID(c, "skills", workspace, id, name);
  const exists = !!c.one("select 1 as ok from skills where owner_id = ? and id = ?", workspace, id);
  if (!exists) {
    const count = Number(c.one<{ n: number }>("select count(*) as n from skills where owner_id = ?", workspace)?.n ?? 0);
    if (count >= LIMITS.maxWorkspaceSkills) throw new VaultError(`workspace skill limit reached (${LIMITS.maxWorkspaceSkills})`);
  }
  const hash = await sha256Hex(content);
  let inline = content;
  let r2Key: string | null = null;
  if (contentBytes > LIMITS.inlineContentBytes) {
    if (!c.env.BLOBS) throw new VaultError("skill content storage is not configured", 500);
    r2Key = `skills/${id}/${hash}`;
    await c.env.BLOBS.put(r2Key, content, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    inline = "";
  }
  const summaryTrimmed = summary.trim();
  const now = nowISO();
  const approvedAt = approved ? now : null;
  const row = c.one<{ created_at: string }>(
    `insert into skills (id, owner_id, name, name_key, summary, content, content_r2_key, content_hash, approved_at, approved_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set name = excluded.name, name_key = excluded.name_key, summary = excluded.summary,
       content = excluded.content, content_r2_key = excluded.content_r2_key, content_hash = excluded.content_hash,
       approved_at = excluded.approved_at, approved_by = excluded.approved_by, updated_at = excluded.updated_at
     where skills.owner_id = excluded.owner_id
     returning created_at`,
    id, workspace, name, name.toLowerCase(), summaryTrimmed, inline, r2Key, hash, approvedAt, approvedBy, now, now,
  );
  if (!row) throw new VaultError("skill id is unavailable");
  return { id, name, summary: summaryTrimmed, created_at: s(row.created_at), updated_at: now, approved, content };
}

const OWNER_ONLY_SKILL_CHANGE = "only the workspace owner can change or delete a published skill; propose a new skill instead";

async function writeWorkspaceSkill(c: Ctx, workspace: string, actor: string, owner: boolean, publish: boolean, args: Args) {
  const id = s(args.id);
  const name = s(args.name);
  if (!owner) {
    const existing = await existingID(c, "skills", workspace, id, name);
    if (c.one("select 1 as ok from skills where owner_id = ? and id = ? and approved_at is not null", workspace, existing)) {
      throw deny(OWNER_ONLY_SKILL_CHANGE);
    }
    return saveSkill(c, workspace, id, name, s(args.summary), s(args.content), false, "");
  }
  return saveSkill(c, workspace, id, name, s(args.summary), s(args.content), publish, publish ? actor : "");
}

function deleteSkill(c: Ctx, workspace: string, rawID: unknown) {
  const id = s(rawID).trim();
  if (!id) throw new VaultError("skill id is required");
  return deleted(c.run("delete from skills where owner_id = ? and id = ?", workspace, id) > 0);
}

function filterRole<T extends { id: string }>(rows: T[], role: AccessRole, scope: string): T[] {
  return rows.filter((row) => roleAllows(role, scope, row.id));
}

// ---------------------------------------------------------------------------
// Credentials

function listCredentialMeta(c: Ctx, workspace: string): CredentialMeta[] {
  const rows = c.all("select id, name, summary, created_at, updated_at from skill_credentials where owner_id = ? order by name_key, updated_at desc", workspace);
  const byName = new Map<string, CredentialMeta>();
  for (const row of rows) {
    const meta = credentialMeta(row);
    const key = meta.name.trim().toLowerCase();
    const current = byName.get(key);
    if (!current || meta.updated_at > current.updated_at) byName.set(key, meta);
  }
  return sortByNameThenNewest([...byName.values()]);
}

async function getCredential(c: Ctx, workspace: string, rawID: unknown, rawName: unknown) {
  const id = s(rawID).trim();
  const name = s(rawName).trim();
  const row = c.one(
    `select id, name, summary, secret_value, created_at, updated_at from skill_credentials
     where owner_id = ? and ((? <> '' and id = ?) or (? <> '' and name_key = ?)) order by updated_at desc limit 1`,
    workspace, id, id, name, name.toLowerCase(),
  );
  if (!row) throw new VaultError("credential not found", 404);
  const meta = credentialMeta(row);
  const decrypted = await decryptSecret(c.keys(), workspace, meta.id, s(row.secret_value));
  if (decrypted.migrate) {
    const stored = await encryptSecret(c.keys(), workspace, meta.id, decrypted.value);
    c.run("update skill_credentials set secret_value = ? where owner_id = ? and id = ?", stored, workspace, meta.id);
  }
  return { ...meta, value: decrypted.value };
}

async function saveCredential(c: Ctx, workspace: string, args: Args) {
  const name = s(args.name).trim();
  const value = s(args.value);
  const summary = s(args.summary);
  if (!name) throw new VaultError("credential name is required");
  if (!value) throw new VaultError("credential value is required");
  if (byteLength(name) > LIMITS.maxNameLength || byteLength(summary) > LIMITS.maxSummaryLength) {
    throw new VaultError("credential name or summary exceeds the allowed length");
  }
  if (hasControl(name) || hasControl(summary)) throw new VaultError("credential name or summary contains control characters");
  if (byteLength(value) > LIMITS.maxCredentialValueBytes) {
    throw new VaultError(`credential value exceeds the ${LIMITS.maxCredentialValueBytes}-byte limit`);
  }
  let id = s(args.id).trim() || randomID();
  if (id.length > 240) throw new VaultError("credential id is too long");
  id = await existingID(c, "skill_credentials", workspace, id, name);
  const exists = !!c.one("select 1 as ok from skill_credentials where owner_id = ? and id = ?", workspace, id);
  if (!exists) {
    const count = Number(c.one<{ n: number }>("select count(*) as n from skill_credentials where owner_id = ?", workspace)?.n ?? 0);
    if (count >= LIMITS.maxWorkspaceCredentials) throw new VaultError(`workspace credential limit reached (${LIMITS.maxWorkspaceCredentials})`);
  }
  const stored = await encryptSecret(c.keys(), workspace, id, value);
  const now = nowISO();
  let row: { created_at: string } | null;
  try {
    row = c.one<{ created_at: string }>(
      `insert into skill_credentials (id, owner_id, name, name_key, summary, secret_value, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, name_key = excluded.name_key, summary = excluded.summary,
         secret_value = excluded.secret_value, updated_at = excluded.updated_at
       where skill_credentials.owner_id = excluded.owner_id
       returning created_at`,
      id, workspace, name, name.toLowerCase(), summary.trim(), stored, now, now,
    );
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) throw new VaultError("a credential with this name already exists");
    throw error;
  }
  if (!row) throw new VaultError("credential id is unavailable");
  c.audit({ action: "credential.save", targetType: "credential", targetID: id, targetName: name });
  return { id, name, summary: summary.trim(), created_at: s(row.created_at), updated_at: now };
}

function deleteCredential(c: Ctx, workspace: string, rawID: unknown) {
  const id = s(rawID).trim();
  if (!id) throw new VaultError("credential id is required");
  const name = c.one<{ name: string }>("select name from skill_credentials where owner_id = ? and id = ?", workspace, id)?.name ?? "";
  const result = deleted(c.run("delete from skill_credentials where owner_id = ? and id = ?", workspace, id) > 0);
  if (result.deleted) c.audit({ action: "credential.delete", targetType: "credential", targetID: id, targetName: name });
  return result;
}

// Credential reads are audited whether they succeed or fail.
async function auditedRead<T extends { id: string; name: string }>(c: Ctx, args: Args, read: () => Promise<T>): Promise<T> {
  try {
    const credential = await read();
    c.audit({ action: "credential.read", targetType: "credential", targetID: credential.id, targetName: credential.name });
    return credential;
  } catch (error) {
    const status = error instanceof VaultError ? error.status : 500;
    c.audit({
      action: "credential.read", outcome: status === 401 || status === 403 ? "denied" : "error", targetType: "credential",
      targetID: s(args.id).slice(0, 240), targetName: s(args.name).slice(0, 120), detail: error instanceof Error ? error.message : "",
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// API keys

function listAPIKeys(c: Ctx, workspace: string): Row[] {
  return c.all(
    "select id, name, prefix, created_at, revoked_at, expires_at, scopes, created_by from skill_api_keys where owner_id = ? order by created_at desc",
    workspace,
  );
}

async function visibleAPIKeys(c: Ctx, token: unknown) {
  const identity = await verifySessionIdentity(c, token);
  const role = identityRole(c, identity);
  return listAPIKeys(c, identity.workspaceID)
    .filter((key) => key.created_by === identity.ownerID || roleAllows(role, SCOPES.keysRead, ""))
    .map((key) => apiKeyRecord(key, key.created_by === identity.ownerID || roleAllows(role, SCOPES.keysRevoke, "")));
}

async function createAPIKey(c: Ctx, workspace: string, createdBy: string, args: Args) {
  const name = s(args.name).trim() || "Agent key";
  if (byteLength(name) > LIMITS.maxNameLength) throw new VaultError(`api key name must be at most ${LIMITS.maxNameLength} characters`);
  if (hasControl(name)) throw new VaultError("api key name contains control characters");
  const now = nowISO();
  const active = Number(c.one<{ n: number }>(
    "select count(*) as n from skill_api_keys where owner_id = ? and revoked_at is null and (expires_at is null or expires_at > ?)",
    workspace, now,
  )?.n ?? 0);
  if (active >= LIMITS.maxWorkspaceKeys) throw new VaultError(`active api key limit reached (${LIMITS.maxWorkspaceKeys})`);
  let scopes = normalizeScopes(args.scopes);
  if (!scopes.length) scopes = [SCOPES.skillsRead];
  let expiresAt: string | null = null;
  if (args.never_expires !== true) {
    const days = Math.trunc(Number(args.expires_in_days ?? 0) || 0);
    if (days < 0 || days > LIMITS.maxKeyDays) throw new VaultError(`api keys may expire at most ${LIMITS.maxKeyDays} days from creation`);
    expiresAt = addMs(now, days > 0 ? days * DAY_MS : LIMITS.defaultKeyTTLms);
  }
  const id = randomID();
  const apiKey = randomToken("skv_");
  const prefix = apiKey.slice(0, 14);
  c.run(
    "insert into skill_api_keys (id, owner_id, created_by, name, key_hash, prefix, scopes, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, workspace, createdBy, name, await hashToken(apiKey), prefix, scopes.join(","), now, expiresAt,
  );
  c.audit({ action: "api_key.create", targetType: "api_key", targetID: id, targetName: name, detail: scopes.join(",") });
  const record = apiKeyRecord({ id, name, prefix, created_at: now, expires_at: expiresAt, scopes: scopes.join(","), created_by: createdBy, revoked_at: null });
  return { record, apiKey };
}

function revokeAPIKey(c: Ctx, workspace: string, rawID: unknown) {
  const id = s(rawID).trim();
  if (!id) throw new VaultError("api key id is required");
  if (id.length > 240) throw new VaultError("api key id is too long");
  const result = deleted(c.run("update skill_api_keys set revoked_at = ? where owner_id = ? and id = ? and revoked_at is null", nowISO(), workspace, id) > 0);
  if (result.deleted) c.audit({ action: "api_key.revoke", targetType: "api_key", targetID: id });
  return result;
}

// ---------------------------------------------------------------------------
// Auth

type GoogleInfo = { sub: string; email: string; email_verified: string; name?: string; aud: string; hd?: string };

async function verifyGoogleIDToken(c: Ctx, args: Args): Promise<GoogleInfo> {
  const idToken = s(args.idToken);
  if (idToken.length > 16 << 10) throw new VaultError("google id token is too large");
  if (!idToken.trim()) throw new VaultError("google id token is required");
  const clientID = (c.env.SKILLS_GOOGLE_CLIENT_ID ?? "").trim() || DEFAULT_GOOGLE_CLIENT_ID;
  let response: Response;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken.trim())}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new VaultError(`verify google token: ${error instanceof Error ? error.message : "request failed"}`, 502);
  }
  if (!response.ok) throw unauthorized("google token verification failed");
  const text = await response.text();
  if (text.length > 64 << 10) throw unauthorized("google token verification failed");
  const info = JSON.parse(text) as Partial<GoogleInfo>;
  if (info.aud !== clientID) throw unauthorized("google token audience mismatch");
  if (!s(info.sub).trim() || !s(info.email).trim()) throw unauthorized("google token missing identity");
  if (s(info.email_verified).toLowerCase() !== "true") throw unauthorized("google email is not verified");
  return info as GoogleInfo;
}

async function login(c: Ctx, _args: Args, prepared: unknown) {
  const info = prepared as GoogleInfo;
  const email = info.email.trim().toLowerCase();
  const name = s(info.name).trim() || email;
  const ownerID = `google:${info.sub.trim()}`;
  const allowed = identityAllowed(c.env, email, s(info.hd));
  let workspaceID = "";
  let pendingOnly = false;
  if (allowed) {
    workspaceID = ownerID;
  } else {
    const member = c.one<{ workspace_owner_id: string }>(
      "select workspace_owner_id from skill_workspace_members where email = ? order by created_at desc limit 1", email,
    );
    if (member?.workspace_owner_id?.trim() && member.workspace_owner_id !== ownerID) {
      workspaceID = member.workspace_owner_id;
    } else {
      const invitation = c.one<{ workspace_owner_id: string }>(
        `select workspace_owner_id from skill_workspace_invitations
         where lower(email) = ? and accepted_at is null and rejected_at is null order by created_at desc limit 1`, email,
      );
      if (invitation?.workspace_owner_id?.trim()) {
        workspaceID = invitation.workspace_owner_id;
        pendingOnly = true;
      }
    }
  }
  if (!workspaceID) {
    c.actor = null;
    c.audit({ action: "auth.login", outcome: "denied", targetType: "user", targetName: email, detail: "google account is not allowed" });
    throw deny("google account is not allowed for this vault");
  }
  const now = nowISO();
  const token = randomToken("skv_sess_");
  const expires = addMs(now, LIMITS.sessionTTLms);
  const tokenHash = await hashToken(token);
  c.tx(() => {
    c.run(
      `insert into skill_users (owner_id, email, name, can_own, created_at, updated_at) values (?, ?, ?, ?, ?, ?)
       on conflict (owner_id) do update set email = excluded.email, name = excluded.name, can_own = excluded.can_own, updated_at = excluded.updated_at`,
      ownerID, email, name, allowed ? 1 : 0, now, now,
    );
    c.run("delete from skill_sessions where expires_at < ?", addMs(now, -7 * DAY_MS));
    c.run(
      "insert into skill_sessions (id, owner_id, workspace_id, token_hash, pending_only, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
      randomID(), ownerID, workspaceID, tokenHash, pendingOnly ? 1 : 0, now, expires,
    );
  });
  c.actor = { id: ownerID, workspace: workspaceID, via: "session" };
  c.audit({ action: "auth.login", targetType: "user", targetID: ownerID, targetName: email, detail: pendingOnly ? "pending invitation" : "" });
  return { sessionToken: token, expires_at: expires, email, name, is_owner: ownerID === workspaceID && !pendingOnly, pending_only: pendingOnly };
}

function lookupUser(c: Ctx, ownerID: string): { email: string; name: string } | null {
  return c.one<{ email: string; name: string }>("select email, name from skill_users where owner_id = ?", ownerID);
}

function workspacesFor(c: Ctx, identity: Identity, email: string) {
  const rows = c.all<{ workspace_id: string; workspace_email: string; is_owner: number }>(
    `select workspace_id, workspace_email, max(is_owner) as is_owner from (
       select u.owner_id as workspace_id, u.email as workspace_email, 1 as is_owner from skill_users u where u.owner_id = ? and u.can_own = 1
       union all
       select m.workspace_owner_id, coalesce(o.email, ''), 0 from skill_workspace_members m
       left join skill_users o on o.owner_id = m.workspace_owner_id where lower(m.email) = lower(?)
     ) group by workspace_id, workspace_email order by is_owner desc, lower(workspace_email)`,
    identity.ownerID, email,
  );
  return rows.map((row) => ({ id: row.workspace_id, email: row.workspace_email, is_owner: !!row.is_owner, active: row.workspace_id === identity.workspaceID }));
}

function requireOwner(identity: Identity, message: string) {
  if (!isOwner(identity)) throw deny(message);
}

// ---------------------------------------------------------------------------
// Access roles

function accessState(c: Ctx, identity: Identity) {
  const role = identityRole(c, identity);
  const state = { role, roles: [] as AccessRole[], assignments: {} as Record<string, string> };
  if (!isOwner(identity)) return state;
  state.roles.push(fullAccess());
  for (const row of c.all<{ policy: string }>("select policy from skill_access_roles where workspace_owner_id = ? order by name", identity.workspaceID)) {
    state.roles.push(parseRole(row.policy));
  }
  const assignments = c.all<{ id: string; role_id: string }>(
    `select id, role_id from skill_workspace_members where workspace_owner_id = ?
     union all select id, role_id from skill_workspace_invitations where workspace_owner_id = ? and accepted_at is null and rejected_at is null`,
    identity.workspaceID, identity.workspaceID,
  );
  for (const row of assignments) state.assignments[row.id] = row.role_id || "full";
  return state;
}

async function accessVault(c: Ctx, args: Args) {
  const { workspace, role } = await callerRole(c, args.sessionToken, false);
  const skills: Row[] = [];
  for (const row of c.all("select * from skills where owner_id = ?", workspace)) {
    if (!roleAllows(role, SCOPES.skillsRead, s(row.id))) continue;
    skills.push(skillSyncRow({ ...row, content: await c.skillContent(row) }));
  }
  const credentials = c.all("select id, owner_id, name, summary, created_at, updated_at from skill_credentials where owner_id = ?", workspace)
    .filter((row) => roleAllows(role, SCOPES.credentialsRead, s(row.id)));
  return { skills, credentials, keys: await visibleAPIKeys(c, args.sessionToken) };
}

function skillSyncRow(row: Row): Row {
  return {
    id: row.id, owner_id: row.owner_id, name: row.name, summary: row.summary, content: row.content,
    created_at: row.created_at, updated_at: row.updated_at, approved_at: row.approved_at ?? null, approved_by: row.approved_by,
  };
}

// ---------------------------------------------------------------------------
// Owner sync collections (now live queries with the same row shapes).

async function verifyWorkspaceSync(c: Ctx, args: Args): Promise<Identity> {
  const identity = await verifySessionIdentity(c, args.sessionToken);
  if (identity.pendingOnly) throw deny(PENDING_ERROR);
  if (!isOwner(identity)) throw deny("members must use permission-filtered queries");
  if (s(args.ownerId).trim() !== identity.workspaceID) throw deny("ownerId does not match the active workspace");
  return identity;
}

// ---------------------------------------------------------------------------
// Registry

export const FUNCTIONS: Record<string, FunctionDef> = {
  "auth.login": { kind: "mutation", prepare: (c, args) => verifyGoogleIDToken(c, args).catch((error) => {
    c.audit({ action: "auth.login", outcome: "denied", detail: error instanceof Error ? error.message : "" });
    throw error;
  }), handler: login },

  "auth.logout": { kind: "mutation", handler: async (c, args) => {
    const token = s(args.sessionToken);
    const result = deleted(c.run("update skill_sessions set revoked_at = ? where token_hash = ? and revoked_at is null", nowISO(), await hashToken(token)) > 0);
    if (result.deleted) {
      const owner = c.one<{ owner_id: string; workspace_id: string }>("select owner_id, workspace_id from skill_sessions where token_hash = ?", await hashToken(token));
      if (owner) c.actor = { id: owner.owner_id, workspace: owner.workspace_id || owner.owner_id, via: "session" };
      c.audit({ action: "auth.logout" });
    }
    return result;
  } },

  "auth.me": { kind: "query", live: true, handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const owner = isOwner(identity);
    const user = lookupUser(c, identity.ownerID);
    return {
      email: user?.email ?? "", name: user?.name ?? "", is_owner: owner, workspace_id: identity.workspaceID,
      workspace_email: owner ? "" : lookupUser(c, identity.workspaceID)?.email ?? "", pending_only: identity.pendingOnly,
    };
  } },

  "auth.workspaces": { kind: "query", live: true, handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const user = lookupUser(c, identity.ownerID);
    if (!user) throw new VaultError("user not found", 404);
    return workspacesFor(c, identity, user.email);
  } },

  "auth.switchWorkspace": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const target = s(args.workspace_id).trim();
    if (!target || target.length > 240) throw new VaultError("valid workspace id is required");
    const user = lookupUser(c, identity.ownerID);
    if (!user) throw new VaultError("user not found", 404);
    const workspace = workspacesFor(c, identity, user.email).find((item) => item.id === target);
    if (!workspace) throw deny("workspace access is not active");
    c.run("update skill_sessions set workspace_id = ?, pending_only = 0 where token_hash = ? and owner_id = ? and revoked_at is null",
      target, await hashToken(s(args.sessionToken).trim()), identity.ownerID);
    c.audit({ action: "auth.switchWorkspace", targetType: "workspace", targetID: target });
    return { ...workspace, active: true };
  } },

  "team.list": { kind: "query", live: true, handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    if (identity.pendingOnly) throw deny(PENDING_ERROR);
    return c.all(
      `select id, email, created_at, status from (
         select id, email, created_at, 'active' as status from skill_workspace_members where workspace_owner_id = ?
         union all
         select id, email, created_at, 'pending' as status from skill_workspace_invitations
         where workspace_owner_id = ? and accepted_at is null and rejected_at is null and ? = 1
       ) order by created_at desc`,
      identity.workspaceID, identity.workspaceID, isOwner(identity) ? 1 : 0,
    );
  } },

  "team.invite": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can invite members");
    const roleID = s(args.role_id);
    if (!roleID) throw new VaultError("choose a role for this invitation");
    readRole(c, identity.workspaceID, roleID);
    const email = s(args.email).trim().toLowerCase();
    if (email.length > 320 || !email.includes("@") || hasSpace(email) || hasControl(email) || email.includes(",")) {
      throw new VaultError("a valid google email is required");
    }
    const owner = lookupUser(c, identity.ownerID);
    if (!owner) throw new VaultError("user not found", 404);
    if (owner.email.toLowerCase() === email) throw new VaultError("the workspace owner cannot invite their own account");
    const count = Number(c.one<{ n: number }>(
      `select (select count(*) from skill_workspace_members where workspace_owner_id = ?)
            + (select count(*) from skill_workspace_invitations where workspace_owner_id = ? and accepted_at is null and rejected_at is null) as n`,
      identity.workspaceID, identity.workspaceID,
    )?.n ?? 0);
    if (count >= LIMITS.maxWorkspaceMembers) throw new VaultError(`workspace member limit reached (${LIMITS.maxWorkspaceMembers})`);
    const now = nowISO();
    const row = c.one<{ id: string }>(
      `insert into skill_workspace_invitations (id, workspace_owner_id, email, invited_by, created_at, role_id) values (?, ?, ?, ?, ?, ?)
       on conflict (workspace_owner_id, email) where accepted_at is null and rejected_at is null
       do update set invited_by = excluded.invited_by, created_at = excluded.created_at, role_id = excluded.role_id
       returning id`,
      randomID(), identity.workspaceID, email, identity.ownerID, now, roleID,
    );
    c.audit({ action: "team.invite", targetType: "invitation", targetID: row?.id ?? "", targetName: email, detail: `role ${roleID}` });
    return { id: row?.id ?? "", email, created_at: now, status: "pending" };
  } },

  "team.remove": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can remove members");
    const id = s(args.id).trim();
    if (!id) throw new VaultError("member id is required");
    const person = c.one<{ email: string; status: string }>(
      `select email, status from (
         select email, 'active' as status from skill_workspace_members where workspace_owner_id = ? and id = ?
         union all
         select email, 'pending' as status from skill_workspace_invitations where workspace_owner_id = ? and id = ? and accepted_at is null and rejected_at is null
       ) limit 1`,
      identity.workspaceID, id, identity.workspaceID, id,
    );
    if (!person) return deleted(false);
    const now = nowISO();
    const email = person.email.toLowerCase();
    c.tx(() => {
      if (person.status === "pending") {
        c.run("delete from skill_workspace_invitations where workspace_owner_id = ? and id = ? and accepted_at is null and rejected_at is null", identity.workspaceID, id);
        c.run(
          `update skill_sessions set revoked_at = ? where revoked_at is null and pending_only = 1 and workspace_id = ?
           and owner_id in (select owner_id from skill_users where lower(email) = ?)`,
          now, identity.workspaceID, email,
        );
        return;
      }
      c.run("delete from skill_workspace_members where workspace_owner_id = ? and id = ?", identity.workspaceID, id);
      // Removal takes effect immediately: sessions in this workspace and every
      // API key the member created are revoked in the same transaction.
      c.run(
        `update skill_sessions set revoked_at = ? where revoked_at is null and workspace_id = ?
         and owner_id in (select owner_id from skill_users where lower(email) = ?) and owner_id <> ?`,
        now, identity.workspaceID, email, identity.workspaceID,
      );
      c.run(
        `update skill_api_keys set revoked_at = ? where owner_id = ? and revoked_at is null
         and created_by in (select owner_id from skill_users where lower(email) = ?)`,
        now, identity.workspaceID, email,
      );
    });
    c.audit({ action: person.status === "pending" ? "team.cancelInvite" : "team.remove", targetType: "member", targetID: id, targetName: email });
    return deleted(true);
  } },

  "team.invitations.list": { kind: "query", live: true, handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const user = lookupUser(c, identity.ownerID);
    if (!user) throw new VaultError("user not found", 404);
    return c.all(
      `select i.id, i.workspace_owner_id as workspace_id, coalesce(u.email, '') as workspace_email, i.email, i.created_at
       from skill_workspace_invitations i left join skill_users u on u.owner_id = i.workspace_owner_id
       where lower(i.email) = lower(?) and i.accepted_at is null and i.rejected_at is null order by i.created_at desc`,
      user.email,
    );
  } },

  "team.invitations.accept": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const user = lookupUser(c, identity.ownerID);
    if (!user) throw new VaultError("user not found", 404);
    const invitation = c.one<{ id: string; workspace_owner_id: string; email: string }>(
      `select id, workspace_owner_id, email from skill_workspace_invitations
       where id = ? and lower(email) = lower(?) and accepted_at is null and rejected_at is null limit 1`,
      s(args.id).trim(), user.email,
    );
    if (!invitation) throw new VaultError("pending invitation not found", 404);
    if (c.one("select 1 as ok from skill_workspace_members where lower(email) = lower(?) and workspace_owner_id <> ? limit 1", user.email, invitation.workspace_owner_id)) {
      throw new VaultError("this account already belongs to another shared workspace; leave it before accepting a different invitation");
    }
    const memberID = randomID();
    const now = nowISO();
    const tokenHash = await hashToken(s(args.sessionToken).trim());
    c.tx(() => {
      c.run(
        `insert into skill_workspace_members (id, workspace_owner_id, email, invited_by, created_at, role_id)
         select ?, workspace_owner_id, email, invited_by, ?, role_id from skill_workspace_invitations where id = ?
         on conflict (workspace_owner_id, email) do nothing`,
        memberID, now, invitation.id,
      );
      c.run("update skill_workspace_invitations set accepted_at = ? where id = ?", now, invitation.id);
      c.run("update skill_sessions set workspace_id = ?, pending_only = 0 where token_hash = ? and owner_id = ? and revoked_at is null",
        invitation.workspace_owner_id, tokenHash, identity.ownerID);
    });
    c.actor = { id: identity.ownerID, workspace: invitation.workspace_owner_id, via: "session" };
    c.audit({ action: "team.acceptInvitation", targetType: "invitation", targetID: invitation.id, targetName: invitation.email });
    return { id: memberID, email: invitation.email, created_at: now, status: "active" };
  } },

  "team.invitations.reject": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const user = lookupUser(c, identity.ownerID);
    if (!user) throw new VaultError("user not found", 404);
    const now = nowISO();
    const count = c.run(
      "update skill_workspace_invitations set rejected_at = ? where id = ? and lower(email) = lower(?) and accepted_at is null and rejected_at is null",
      now, s(args.id).trim(), user.email,
    );
    if (identity.pendingOnly) {
      c.run("update skill_sessions set revoked_at = ? where token_hash = ?", now, await hashToken(s(args.sessionToken).trim()));
    }
    if (count) c.audit({ action: "team.rejectInvitation", targetType: "invitation", targetID: s(args.id).trim() });
    return deleted(count > 0);
  } },

  "skills.list": { kind: "query", live: true, handler: async (c, args) => {
    const workspace = await verifySession(c, args.sessionToken);
    const { role } = await callerRole(c, args.sessionToken, false);
    return filterRole(listSkills(c, workspace, false), role, SCOPES.skillsRead);
  } },

  "skills.get": { kind: "query", handler: async (c, args) => {
    await requireAccess(c, args.sessionToken, false, SCOPES.skillsRead, args.id, args.name);
    return getSkill(c, await verifySession(c, args.sessionToken), args.id, args.name, false);
  } },

  "skills.save": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.sessionToken, false, SCOPES.skillsWrite, args.id, args.name);
    const identity = await verifySessionIdentity(c, args.sessionToken);
    if (identity.pendingOnly) throw deny(PENDING_ERROR);
    const skill = await writeWorkspaceSkill(c, identity.workspaceID, identity.ownerID, isOwner(identity), true, args);
    c.audit({ action: skill.approved ? "skill.publish" : "skill.propose", targetType: "skill", targetID: skill.id, targetName: skill.name });
    return skill;
  } },

  "skills.approve": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can approve agent-uploaded skills");
    const id = s(args.id).trim();
    if (!id) throw new VaultError("skill id is required");
    if (id.length > 240) throw new VaultError("skill id is too long");
    const now = nowISO();
    const count = c.run("update skills set approved_at = ?, approved_by = ?, updated_at = ? where owner_id = ? and id = ?",
      now, identity.ownerID, now, identity.workspaceID, id);
    if (!count) throw new VaultError("skill not found", 404);
    const skill = await getSkill(c, identity.workspaceID, id, "", false);
    c.audit({ action: "skill.approve", targetType: "skill", targetID: id, targetName: skill.name });
    return skill;
  } },

  "skills.delete": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.sessionToken, false, SCOPES.skillsWrite, args.id, "");
    const identity = await verifySessionIdentity(c, args.sessionToken);
    if (!isOwner(identity)) throw deny(OWNER_ONLY_SKILL_CHANGE);
    const result = deleteSkill(c, identity.workspaceID, args.id);
    if (result.deleted) c.audit({ action: "skill.delete", targetType: "skill", targetID: s(args.id).trim() });
    return result;
  } },

  "apiKeys.list": { kind: "query", live: true, handler: (c, args) => visibleAPIKeys(c, args.sessionToken) },

  "apiKeys.create": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    if (identity.pendingOnly) throw deny(PENDING_ERROR);
    const role = identityRole(c, identity);
    let scopes = normalizeScopes(args.scopes);
    if (!scopes.length) scopes = [SCOPES.skillsRead];
    if (scopes.some((scope) => !role.scopes.includes(scope))) throw deny("requested key permissions exceed your role");
    return createAPIKey(c, identity.workspaceID, identity.ownerID, args);
  } },

  "apiKeys.revoke": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const role = identityRole(c, identity);
    const key = c.one<{ created_by: string }>("select created_by from skill_api_keys where owner_id = ? and id = ?", identity.workspaceID, s(args.id));
    if (!key) throw new VaultError("api key not found", 404);
    if (key.created_by !== identity.ownerID && !roleAllows(role, SCOPES.keysRevoke, "")) throw deny("your role does not allow revoking workspace keys");
    return revokeAPIKey(c, identity.workspaceID, args.id);
  } },

  "credentials.list": { kind: "query", live: true, handler: async (c, args) => {
    const workspace = await verifySession(c, args.sessionToken);
    const { role } = await callerRole(c, args.sessionToken, false);
    return filterRole(listCredentialMeta(c, workspace), role, SCOPES.credentialsRead);
  } },

  "credentials.get": { kind: "mutation", handler: (c, args) => auditedRead(c, args, async () => {
    await requireAccess(c, args.sessionToken, false, SCOPES.credentialsRead, args.id, args.name);
    return getCredential(c, await verifySession(c, args.sessionToken), args.id, args.name);
  }) },

  "credentials.save": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.sessionToken, false, SCOPES.credentialsWrite, args.id, args.name);
    return saveCredential(c, await verifySession(c, args.sessionToken), args);
  } },

  "credentials.delete": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.sessionToken, false, SCOPES.credentialsWrite, args.id, "");
    return deleteCredential(c, await verifySession(c, args.sessionToken), args.id);
  } },

  "access.snapshot": { kind: "action", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    const state = accessState(c, identity);
    const vault = state.roles.length === 0 ? await accessVault(c, args) : null;
    return { state, vault };
  } },

  "access.state": { kind: "query", live: true, handler: async (c, args) => accessState(c, await verifySessionIdentity(c, args.sessionToken)) },

  "access.vault": { kind: "query", live: true, handler: (c, args) => accessVault(c, args) },

  "access.saveRole": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can manage roles");
    const input = (args.role ?? {}) as Partial<AccessRole>;
    const role: AccessRole = {
      id: s(input.id), name: s(input.name).trim(), description: s(input.description), scopes: [],
      all_skills: !!input.all_skills, skill_ids: Array.isArray(input.skill_ids) ? input.skill_ids.map(String) : [],
      all_credentials: !!input.all_credentials, credential_ids: Array.isArray(input.credential_ids) ? input.credential_ids.map(String) : [],
    };
    if (!role.name || role.name.length > 80 || role.description.length > 500 || role.id === "full" || role.id.length > 240) {
      throw new VaultError("enter a role name of up to 80 characters");
    }
    role.scopes = normalizeScopes(input.scopes);
    for (const kind of ["skills", "credentials"]) {
      if (role.scopes.includes(`${kind}:write`) && !role.scopes.includes(`${kind}:read`)) throw new VaultError("editing requires read access");
    }
    if (role.skill_ids.length > LIMITS.maxWorkspaceSkills || role.credential_ids.length > LIMITS.maxWorkspaceCredentials) {
      throw new VaultError("too many selected resources");
    }
    for (const [table, ids] of [["skills", role.skill_ids], ["skill_credentials", role.credential_ids]] as const) {
      for (const id of ids) {
        if (!c.one(`select 1 as ok from ${table} where owner_id = ? and id = ?`, identity.workspaceID, id)) {
          throw new VaultError("a selected item no longer exists in this workspace");
        }
      }
    }
    if (!role.id) {
      role.id = randomID();
      const count = Number(c.one<{ n: number }>("select count(*) as n from skill_access_roles where workspace_owner_id = ?", identity.workspaceID)?.n ?? 0);
      if (count >= LIMITS.maxRoles) throw new VaultError("workspace role limit reached");
    } else {
      readRole(c, identity.workspaceID, role.id);
    }
    c.run(
      `insert into skill_access_roles (id, workspace_owner_id, name, policy) values (?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, policy = excluded.policy where skill_access_roles.workspace_owner_id = excluded.workspace_owner_id`,
      role.id, identity.workspaceID, role.name, JSON.stringify(role),
    );
    c.audit({ action: "role.save", targetType: "role", targetID: role.id, targetName: role.name, detail: role.scopes.join(",") });
    return role;
  } },

  "access.deleteRole": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can delete roles");
    const id = s(args.id);
    if (!id || id === "full") throw new VaultError("the built-in role cannot be deleted");
    const used = c.one(
      `select 1 as ok from skill_workspace_members where workspace_owner_id = ? and role_id = ?
       union all select 1 from skill_workspace_invitations where workspace_owner_id = ? and role_id = ? and accepted_at is null and rejected_at is null limit 1`,
      identity.workspaceID, id, identity.workspaceID, id,
    );
    if (used) throw new VaultError("assign members and pending invitations another role first");
    const result = deleted(c.run("delete from skill_access_roles where workspace_owner_id = ? and id = ?", identity.workspaceID, id) > 0);
    if (result.deleted) c.audit({ action: "role.delete", targetType: "role", targetID: id });
    return result;
  } },

  "access.assignRole": { kind: "mutation", handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can assign roles");
    const roleID = s(args.role_id);
    if (!roleID) throw new VaultError("choose a role");
    readRole(c, identity.workspaceID, roleID);
    let count = 0;
    c.tx(() => {
      for (const table of ["skill_workspace_members", "skill_workspace_invitations"]) {
        count += c.run(`update ${table} set role_id = ? where workspace_owner_id = ? and id = ?`, roleID, identity.workspaceID, s(args.id));
      }
    });
    if (!count) throw new VaultError("member or invitation no longer exists", 404);
    c.audit({ action: "role.assign", targetType: "member", targetID: s(args.id), detail: `role ${roleID}` });
    return deleted(true);
  } },

  "skills.sync": { kind: "sync", live: true, handler: async (c, args) => {
    const identity = await verifyWorkspaceSync(c, args);
    const rows: Row[] = [];
    for (const row of c.all("select * from skills where owner_id = ? order by updated_at desc", identity.workspaceID)) {
      rows.push(skillSyncRow({ ...row, content: await c.skillContent(row) }));
    }
    return rows;
  } },

  "apiKeys.sync": { kind: "sync", live: true, handler: async (c, args) => {
    const identity = await verifyWorkspaceSync(c, args);
    return c.all(
      "select id, owner_id, created_by, name, prefix, scopes, created_at, expires_at, revoked_at from skill_api_keys where owner_id = ? order by created_at desc",
      identity.workspaceID,
    );
  } },

  "credentials.sync": { kind: "sync", live: true, handler: async (c, args) => {
    const identity = await verifyWorkspaceSync(c, args);
    return c.all("select id, owner_id, name, summary, created_at, updated_at from skill_credentials where owner_id = ? order by updated_at desc", identity.workspaceID);
  } },

  "team.membersSync": { kind: "sync", live: true, handler: async (c, args) => {
    const identity = await verifyWorkspaceSync(c, args);
    return c.all("select id, workspace_owner_id, email, invited_by, created_at from skill_workspace_members where workspace_owner_id = ? order by created_at desc", identity.workspaceID);
  } },

  "team.invitationsSync": { kind: "sync", live: true, handler: async (c, args) => {
    const identity = await verifyWorkspaceSync(c, args);
    return c.all(
      "select id, workspace_owner_id, email, invited_by, created_at, accepted_at, rejected_at from skill_workspace_invitations where workspace_owner_id = ? order by created_at desc",
      identity.workspaceID,
    );
  } },

  "audit.list": { kind: "query", live: true, handler: async (c, args) => {
    const identity = await verifySessionIdentity(c, args.sessionToken);
    requireOwner(identity, "only the workspace owner can read the audit log");
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 100), 1), 500);
    const before = s(args.before) || "9999";
    return c.all(
      `select id, at, actor_id, actor_email, via, api_key_id, action, target_type, target_id, target_name, outcome, detail, ip, user_agent
       from audit_events where workspace_id = ? and at < ? order by at desc, id desc limit ?`,
      identity.workspaceID, before, limit,
    );
  } },

  // Agent (API key) functions.

  "agent.skills.list": { kind: "query", live: true, handler: async (c, args) => {
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.skillsRead);
    const { role } = await callerRole(c, args.apiKey, true);
    return filterRole(listSkills(c, key.workspace, true), role, SCOPES.skillsRead);
  } },

  "agent.skills.get": { kind: "query", handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.skillsRead, args.id, args.name);
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.skillsRead);
    return getSkill(c, key.workspace, args.id, args.name, true);
  } },

  "agent.skills.upload": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.skillsWrite, args.id, args.name);
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.skillsWrite);
    const owner = !!key.createdBy && key.createdBy === key.workspace;
    const skill = await writeWorkspaceSkill(c, key.workspace, key.workspace, owner, args.publish === true, args);
    c.audit({ action: skill.approved ? "skill.publish" : "skill.propose", targetType: "skill", targetID: skill.id, targetName: skill.name });
    return skill;
  } },

  "agent.skills.delete": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.skillsWrite, args.id, "");
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.skillsWrite);
    if (!(key.createdBy && key.createdBy === key.workspace)) throw deny(OWNER_ONLY_SKILL_CHANGE);
    const result = deleteSkill(c, key.workspace, args.id);
    if (result.deleted) c.audit({ action: "skill.delete", targetType: "skill", targetID: s(args.id).trim() });
    return result;
  } },

  "agent.apiKeys.list": { kind: "query", live: true, handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.keysRead, "", "");
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.keysRead);
    return listAPIKeys(c, key.workspace).map((row) => apiKeyRecord(row));
  } },

  "agent.apiKeys.verify": { kind: "query", handler: async (c, args) => {
    await verifyAPIKey(c, args.apiKey, "");
    return deleted(true);
  } },

  "agent.apiKeys.revoke": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.keysRevoke, "", "");
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.keysRevoke);
    return revokeAPIKey(c, key.workspace, args.id);
  } },

  "agent.apiKeys.revokeSelf": { kind: "mutation", handler: async (c, args) => {
    const apiKey = s(args.apiKey).trim();
    if (!apiKey) throw unauthorized("api key is required");
    if (apiKey.length > 256) throw unauthorized("invalid api key");
    const now = nowISO();
    const hash = await hashToken(apiKey);
    const row = c.one<{ id: string; owner_id: string; created_by: string }>(
      "select id, owner_id, created_by from skill_api_keys where key_hash = ? and revoked_at is null and (expires_at is null or expires_at > ?)", hash, now,
    );
    const count = c.run("update skill_api_keys set revoked_at = ? where key_hash = ? and revoked_at is null and (expires_at is null or expires_at > ?)", now, hash, now);
    if (row && count) {
      c.actor = { id: row.created_by || row.owner_id, workspace: row.owner_id, via: "api_key", keyID: row.id };
      c.audit({ action: "api_key.revokeSelf", targetType: "api_key", targetID: row.id });
    }
    return deleted(count > 0);
  } },

  "agent.credentials.list": { kind: "query", live: true, handler: async (c, args) => {
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.credentialsRead);
    const { role } = await callerRole(c, args.apiKey, true);
    return filterRole(listCredentialMeta(c, key.workspace), role, SCOPES.credentialsRead);
  } },

  "agent.credentials.get": { kind: "query", handler: (c, args) => auditedRead(c, args, async () => {
    await requireAccess(c, args.apiKey, true, SCOPES.credentialsRead, args.id, args.name);
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.credentialsRead);
    return getCredential(c, key.workspace, args.id, args.name);
  }) },

  "agent.credentials.save": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.credentialsWrite, args.id, args.name);
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.credentialsWrite);
    return saveCredential(c, key.workspace, args);
  } },

  "agent.credentials.delete": { kind: "mutation", handler: async (c, args) => {
    await requireAccess(c, args.apiKey, true, SCOPES.credentialsWrite, args.id, "");
    const key = await verifyAPIKey(c, args.apiKey, SCOPES.credentialsWrite);
    return deleteCredential(c, key.workspace, args.id);
  } },
};

