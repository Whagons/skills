import type { KeyConfig } from "./crypto";
import { VaultError, deny, hashToken, nowISO, splitCSV, unauthorized } from "./util";

export interface Env {
  VAULT: DurableObjectNamespace<import("./vault").Vault>;
  ASSETS?: Fetcher;
  BLOBS?: R2Bucket;
  SKILLS_SECRET_KEY?: string;
  SKILLS_SECRET_KEY_PREVIOUS?: string;
  SKILLS_GOOGLE_CLIENT_ID?: string;
  SKILLS_ALLOWED_EMAILS?: string;
  SKILLS_ALLOWED_DOMAINS?: string;
  SKILLS_PROJECT_ID?: string;
  ADMIN_TOKEN?: string;
  VAULT_LOCATION_HINT?: string;
  API_LIMIT?: RateLimit;
  LOGIN_LIMIT?: RateLimit;
}

export const DEFAULT_PROJECT_ID = "01f1974b-dcda-6fc3-b16d-9acf5f3b4192";
export const DEFAULT_GOOGLE_CLIENT_ID = "578623964983-iall0oeq2r2mke7trpqqv3pjingqljh0.apps.googleusercontent.com";
export const DEFAULT_ALLOWED_EMAIL = "malek.gabriel33@gmail.com";

export const SCOPES = {
  skillsRead: "skills:read",
  skillsWrite: "skills:write",
  credentialsRead: "credentials:read",
  credentialsWrite: "credentials:write",
  keysRead: "keys:read",
  keysRevoke: "keys:revoke",
} as const;
export const ALL_SCOPES: string[] = Object.values(SCOPES);

export const LIMITS = {
  sessionTTLms: 30 * 24 * 60 * 60 * 1000,
  defaultKeyTTLms: 30 * 24 * 60 * 60 * 1000,
  maxKeyDays: 365,
  maxSkillContentBytes: 2 << 20,
  maxCredentialValueBytes: 256 << 10,
  maxNameLength: 120,
  maxSummaryLength: 1000,
  maxWorkspaceSkills: 500,
  maxWorkspaceKeys: 50,
  maxWorkspaceCredentials: 100,
  maxWorkspaceMembers: 50,
  maxRoles: 50,
  inlineContentBytes: 1 << 20,
};

export type Meta = { ip: string; userAgent: string; ray: string };
export type Actor = { id: string; workspace: string; via: "session" | "api_key" | "admin"; keyID?: string };
export type Row = Record<string, SqlStorageValue>;

export type AuditEvent = {
  action: string;
  outcome?: "ok" | "denied" | "error";
  targetType?: string;
  targetID?: string;
  targetName?: string;
  detail?: string;
};

// Per-call context: SQL access, configuration and the authenticated actor.
export class Ctx {
  actor: Actor | null = null;
  private contentCache: Map<string, string>;

  constructor(
    readonly storage: DurableObjectStorage,
    readonly env: Env,
    readonly meta: Meta,
    contentCache: Map<string, string>,
  ) {
    this.contentCache = contentCache;
  }

  get sql(): SqlStorage {
    return this.storage.sql;
  }

  all<T = Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as T[];
  }

  one<T = Row>(query: string, ...bindings: unknown[]): T | null {
    return this.all<T>(query, ...bindings)[0] ?? null;
  }

  run(query: string, ...bindings: unknown[]): number {
    return this.sql.exec(query, ...(bindings as SqlStorageValue[])).rowsWritten;
  }

  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  keys(): KeyConfig {
    return { current: this.env.SKILLS_SECRET_KEY, previous: this.env.SKILLS_SECRET_KEY_PREVIOUS };
  }

  async skillContent(row: { content?: unknown; content_r2_key?: unknown }): Promise<string> {
    const key = row.content_r2_key ? String(row.content_r2_key) : "";
    if (!key) return String(row.content ?? "");
    const cached = this.contentCache.get(key);
    if (cached !== undefined) return cached;
    if (!this.env.BLOBS) throw new VaultError("skill content storage is not configured", 500);
    const object = await this.env.BLOBS.get(key);
    if (!object) throw new VaultError("skill content is missing", 500);
    const text = await object.text();
    if (this.contentCache.size > 64) this.contentCache.clear();
    this.contentCache.set(key, text);
    return text;
  }

  audit(event: AuditEvent): void {
    const actor = this.actor;
    const email = actor && actor.via !== "admin" ? this.one<{ email: string }>("select email from skill_users where owner_id = ?", actor.id)?.email ?? "" : "";
    this.run(
      `insert into audit_events (at, workspace_id, actor_id, actor_email, via, api_key_id, action, target_type, target_id, target_name, outcome, detail, ip, user_agent, cf_ray)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nowISO(), actor?.workspace ?? "", actor?.id ?? "", email, actor?.via ?? "", actor?.keyID ?? "",
      event.action, event.targetType ?? "", event.targetID ?? "", event.targetName ?? "", event.outcome ?? "ok",
      (event.detail ?? "").slice(0, 300), this.meta.ip.slice(0, 64), this.meta.userAgent.slice(0, 200), this.meta.ray.slice(0, 64),
    );
  }
}

// ---------------------------------------------------------------------------
// Identity, sessions and API keys (gonvex/skills.go verify* functions).

export type Identity = { ownerID: string; workspaceID: string; pendingOnly: boolean };
export const isOwner = (identity: Identity) => identity.ownerID === identity.workspaceID && !identity.pendingOnly;
export const PENDING_ERROR = "accept or reject the pending workspace invitation first";

function isActiveMember(c: Ctx, ownerID: string, workspaceID: string): boolean {
  return !!c.one(
    `select 1 as ok from skill_workspace_members m join skill_users u on u.owner_id = ?
     where m.workspace_owner_id = ? and lower(m.email) = lower(u.email) limit 1`,
    ownerID, workspaceID,
  );
}

export async function verifySessionIdentity(c: Ctx, rawToken: unknown): Promise<Identity> {
  const token = String(rawToken ?? "").trim();
  if (!token) throw unauthorized("session token is required");
  if (token.length > 256) throw unauthorized("invalid session");
  const row = c.one<{ owner_id: string; workspace_id: string; pending_only: number }>(
    `select owner_id, workspace_id, pending_only from skill_sessions
     where token_hash = ? and revoked_at is null and expires_at > ? limit 1`,
    await hashToken(token), nowISO(),
  );
  if (!row) throw unauthorized("invalid session");
  const ownerID = String(row.owner_id ?? "");
  if (!ownerID.trim()) throw unauthorized("invalid session owner");
  const workspaceID = String(row.workspace_id ?? "").trim() || ownerID;
  const pendingOnly = !!row.pending_only;
  if (workspaceID !== ownerID && !pendingOnly && !isActiveMember(c, ownerID, workspaceID)) {
    throw unauthorized("workspace membership is no longer active");
  }
  c.actor = { id: ownerID, workspace: workspaceID, via: "session" };
  return { ownerID, workspaceID, pendingOnly };
}

export async function verifySession(c: Ctx, token: unknown): Promise<string> {
  const identity = await verifySessionIdentity(c, token);
  if (identity.pendingOnly) throw deny(PENDING_ERROR);
  return identity.workspaceID;
}

export type KeyIdentity = { workspace: string; createdBy: string; scopes: string; keyID: string };

export async function verifyAPIKey(c: Ctx, rawKey: unknown, requiredScope: string): Promise<KeyIdentity> {
  const apiKey = String(rawKey ?? "").trim();
  if (!apiKey) throw unauthorized("api key is required");
  if (apiKey.length > 256) throw unauthorized("invalid api key");
  const now = nowISO();
  const row = c.one<{ id: string; owner_id: string; created_by: string; scopes: string }>(
    `select id, owner_id, created_by, scopes from skill_api_keys
     where key_hash = ? and revoked_at is null and (expires_at is null or expires_at > ?) limit 1`,
    await hashToken(apiKey), now,
  );
  if (!row) throw unauthorized("invalid api key");
  const workspace = String(row.owner_id ?? "");
  if (!workspace.trim()) throw unauthorized("invalid api key owner");
  const createdBy = String(row.created_by ?? "");
  c.actor = { id: createdBy || workspace, workspace, via: "api_key", keyID: String(row.id) };
  if (requiredScope && !splitCSV(row.scopes).includes(requiredScope)) {
    throw deny(`api key is missing required scope ${requiredScope}`);
  }
  if (createdBy && createdBy !== workspace && !isActiveMember(c, createdBy, workspace)) {
    throw unauthorized("api key creator is no longer a workspace member");
  }
  return { workspace, createdBy, scopes: String(row.scopes ?? ""), keyID: String(row.id) };
}

// ---------------------------------------------------------------------------
// Roles (gonvex/access.go).

export type AccessRole = {
  id: string;
  name: string;
  description: string;
  scopes: string[];
  all_skills: boolean;
  skill_ids: string[];
  all_credentials: boolean;
  credential_ids: string[];
};

export function fullAccess(): AccessRole {
  return {
    id: "full",
    name: "Full access",
    description: "All skills, credentials and API keys. Only the owner manages people and roles.",
    scopes: [SCOPES.skillsRead, SCOPES.skillsWrite, SCOPES.credentialsRead, SCOPES.credentialsWrite, SCOPES.keysRead, SCOPES.keysRevoke],
    all_skills: true,
    skill_ids: [],
    all_credentials: true,
    credential_ids: [],
  };
}

export function roleAllows(role: AccessRole, scope: string, id: string): boolean {
  if (!(role.scopes ?? []).includes(scope)) return false;
  if (scope.startsWith("skills:")) return role.all_skills || (id !== "" && (role.skill_ids ?? []).includes(id));
  if (scope.startsWith("credentials:")) return role.all_credentials || (id !== "" && (role.credential_ids ?? []).includes(id));
  return true;
}

export function parseRole(raw: string): AccessRole {
  const value = JSON.parse(raw) as Partial<AccessRole>;
  return {
    id: String(value.id ?? ""),
    name: String(value.name ?? ""),
    description: String(value.description ?? ""),
    scopes: Array.isArray(value.scopes) ? value.scopes.map(String) : [],
    all_skills: !!value.all_skills,
    skill_ids: Array.isArray(value.skill_ids) ? value.skill_ids.map(String) : [],
    all_credentials: !!value.all_credentials,
    credential_ids: Array.isArray(value.credential_ids) ? value.credential_ids.map(String) : [],
  };
}

export function readRole(c: Ctx, workspace: string, id: string): AccessRole {
  if (!id || id === "full") return fullAccess();
  const row = c.one<{ policy: string }>("select policy from skill_access_roles where workspace_owner_id = ? and id = ?", workspace, id);
  if (!row) throw new VaultError("role is unavailable");
  return parseRole(row.policy);
}

export function identityRole(c: Ctx, identity: Identity): AccessRole {
  if (identity.pendingOnly) throw deny(PENDING_ERROR);
  if (isOwner(identity)) return fullAccess();
  const row = c.one<{ role_id: string }>(
    `select m.role_id from skill_workspace_members m join skill_users u on lower(u.email) = lower(m.email)
     where m.workspace_owner_id = ? and u.owner_id = ?`,
    identity.workspaceID, identity.ownerID,
  );
  if (!row) throw unauthorized("workspace membership is no longer active");
  return readRole(c, identity.workspaceID, String(row.role_id ?? ""));
}

export type Caller = { workspace: string; role: AccessRole; identity: Identity; key?: KeyIdentity };

export async function callerRole(c: Ctx, token: unknown, agent: boolean): Promise<Caller> {
  if (!agent) {
    const identity = await verifySessionIdentity(c, token);
    return { workspace: identity.workspaceID, role: identityRole(c, identity), identity };
  }
  const key = await verifyAPIKey(c, token, "");
  const creator = key.createdBy || key.workspace;
  const identity = { ownerID: creator, workspaceID: key.workspace, pendingOnly: false };
  const role = identityRole(c, identity);
  const keyScopes = splitCSV(key.scopes);
  role.scopes = role.scopes.filter((scope) => keyScopes.includes(scope));
  return { workspace: key.workspace, role, identity, key };
}

// Resolve every supplied selector so an allowed ID cannot mask a forbidden
// name. Creating new items requires all-resource access.
export async function requireAccess(c: Ctx, token: unknown, agent: boolean, scope: string, rawID: unknown, rawName: unknown): Promise<Caller> {
  const caller = await callerRole(c, token, agent);
  const { workspace, role } = caller;
  if (!role.scopes.includes(scope)) throw deny("your role does not allow this action");
  const table = scope.startsWith("skills:") ? "skills" : scope.startsWith("credentials:") ? "skill_credentials" : "";
  if (!table) return caller;
  const id = String(rawID ?? "").trim();
  const name = String(rawName ?? "").trim();
  if (id && !roleAllows(role, scope, id)) throw deny("your role does not allow access to this item");
  if (name) {
    const rows = c.all<{ id: string }>(`select id from ${table} where owner_id = ? and name_key = ?`, workspace, name.toLowerCase());
    for (const row of rows) {
      if (!roleAllows(role, scope, row.id)) throw deny("your role does not allow access to this item");
    }
    if (rows.length || roleAllows(role, scope, id)) return caller;
    throw deny("your role does not allow creating items");
  }
  if (!roleAllows(role, scope, id)) throw deny("your role does not allow access to this item");
  return caller;
}

export function normalizeScopes(requested: unknown): string[] {
  const list = Array.isArray(requested) ? requested : [];
  const unique = new Set<string>();
  for (const raw of list) {
    const scope = String(raw ?? "").trim().toLowerCase();
    if (!scope) continue;
    if (!ALL_SCOPES.includes(scope)) throw new VaultError(`unsupported api key scope ${JSON.stringify(scope)}`);
    unique.add(scope);
  }
  return [...unique].sort();
}

export function identityAllowed(env: Env, email: string, hostedDomain: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  const domain = at >= 0 && at + 1 < normalized.length ? normalized.slice(at + 1) : "";
  let emails = splitCSV(env.SKILLS_ALLOWED_EMAILS);
  const domains = splitCSV(env.SKILLS_ALLOWED_DOMAINS);
  if (!emails.length && !domains.length) emails = [DEFAULT_ALLOWED_EMAIL];
  if (emails.some((allowed) => normalized === allowed.toLowerCase())) return true;
  return domains.some((raw) => {
    const allowed = raw.replace(/^@/, "").toLowerCase();
    return domain === allowed || hostedDomain.trim().toLowerCase() === allowed;
  });
}
