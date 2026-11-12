// Numbered schema migrations for the vault's SQLite storage. Table and column
// names match the Gonvex Postgres tables so migration is a direct copy; the
// additions (name_key, content_r2_key, audit_events, vault_meta) are new.

export const MIGRATIONS: string[][] = [
  [
    `create table if not exists vault_meta (key text primary key, value text not null)`,
    `create table skill_users (
      owner_id text primary key, email text not null, name text not null default '',
      can_own integer not null default 0, created_at text not null, updated_at text not null)`,
    `create index skill_users_by_email on skill_users(email)`,
    `create table skill_sessions (
      id text primary key, owner_id text not null, workspace_id text not null default '',
      token_hash text not null unique, pending_only integer not null default 0,
      created_at text not null, expires_at text not null, revoked_at text)`,
    `create index skill_sessions_by_owner on skill_sessions(owner_id)`,
    `create table skills (
      id text primary key, owner_id text not null, name text not null, name_key text not null,
      summary text not null default '', content text not null default '', content_r2_key text,
      content_hash text not null default '', approved_at text, approved_by text not null default '',
      created_at text not null, updated_at text not null)`,
    `create index skills_by_owner_name on skills(owner_id, name_key)`,
    `create index skills_by_owner_updated_at on skills(owner_id, updated_at)`,
    `create table skill_api_keys (
      id text primary key, owner_id text not null, created_by text not null default '', name text not null,
      key_hash text not null unique, prefix text not null, scopes text not null,
      created_at text not null, expires_at text, revoked_at text)`,
    `create index skill_api_keys_by_owner_created_at on skill_api_keys(owner_id, created_at)`,
    `create table skill_credentials (
      id text primary key, owner_id text not null, name text not null, name_key text not null,
      summary text not null default '', secret_value text not null, created_at text not null, updated_at text not null)`,
    `create unique index skill_credentials_unique_owner_name on skill_credentials(owner_id, name_key)`,
    `create table skill_workspace_members (
      id text primary key, workspace_owner_id text not null, email text not null,
      invited_by text not null default '', role_id text not null default '', created_at text not null)`,
    `create unique index skill_workspace_members_unique on skill_workspace_members(workspace_owner_id, email)`,
    `create index skill_workspace_members_by_email on skill_workspace_members(email)`,
    `create table skill_workspace_invitations (
      id text primary key, workspace_owner_id text not null, email text not null,
      invited_by text not null default '', role_id text not null default '', created_at text not null,
      accepted_at text, rejected_at text)`,
    `create unique index skill_workspace_invitations_pending_unique on skill_workspace_invitations(workspace_owner_id, email)
      where accepted_at is null and rejected_at is null`,
    `create index skill_workspace_invitations_by_email on skill_workspace_invitations(email)`,
    `create table skill_access_roles (id text primary key, workspace_owner_id text not null, name text not null, policy text not null)`,
    `create index skill_access_roles_by_workspace on skill_access_roles(workspace_owner_id)`,
    `create table audit_events (
      id integer primary key autoincrement, at text not null, workspace_id text not null default '',
      actor_id text not null default '', actor_email text not null default '', via text not null default '',
      api_key_id text not null default '', action text not null, target_type text not null default '',
      target_id text not null default '', target_name text not null default '', outcome text not null default 'ok',
      detail text not null default '', ip text not null default '', user_agent text not null default '', cf_ray text not null default '')`,
    `create index audit_events_by_workspace_at on audit_events(workspace_id, at)`,
    `create index audit_events_by_at on audit_events(at)`,
  ],
];

export function migrate(sql: SqlStorage): number {
  sql.exec(`create table if not exists vault_meta (key text primary key, value text not null)`);
  const current = Number(sql.exec(`select value from vault_meta where key = 'schema_version'`).toArray()[0]?.value ?? 0);
  for (let version = current; version < MIGRATIONS.length; version++) {
    for (const statement of MIGRATIONS[version]) {
      if (statement.startsWith("create table if not exists vault_meta")) continue;
      sql.exec(statement);
    }
    sql.exec(`insert into vault_meta (key, value) values ('schema_version', ?) on conflict (key) do update set value = excluded.value`, String(version + 1));
  }
  return MIGRATIONS.length;
}

// Tables carried in import/export bundles, plus the derived columns the vault
// adds on import.
export const DATA_TABLES = [
  "skill_users", "skill_sessions", "skills", "skill_api_keys", "skill_credentials",
  "skill_workspace_members", "skill_workspace_invitations", "skill_access_roles",
] as const;
