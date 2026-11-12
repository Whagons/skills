# Skills Vault on Cloudflare Workers: design

Status: implemented in `worker/` and tested on dev resources (`skills-cf-dev-*`);
not applied to production. The cutover (§8) is a separate, manual decision.

## 1. Why

`skills.whagons.com` is the team's credential vault and skill registry. Its
frontend is a static container on Coolify. Its backend is the Gonvex project
`skills` (`01f1974b-dcda-6fc3-b16d-9acf5f3b4192`), which runs inside the shared
production Gonvex runtime (`wss://gonvex.whagons.com/ws`) and stores its data
in that runtime's Postgres (`gonvex_01f1974b_dcda_6fc3_b16d_9acf5f3b4192`,
about 9 MB).

When the production server failed, the vault failed with it. That is the worst
possible coupling: the vault holds the Coolify, Cloudflare, DigitalOcean and
backup credentials that are needed to *recover* production. The goal is to
run the vault on infrastructure that shares nothing with Whagons production:
Cloudflare Workers, a SQLite Durable Object, R2, and Workers static assets.

## 2. What exists today (inventory)

Everything below was read from this repository: `gonvex/schema.go`,
`gonvex/skills.go`, `gonvex/access.go`, `gonvex/syncs.go`, `src/`, and the
`whagons-dev` CLI in `cli/cmd/whagons-dev`.

### 2.1 What the vault stores

| Data | Table | Notes |
| --- | --- | --- |
| Google identities | `skill_users` | `owner_id` = `google:<sub>`, email, name, `can_own` (allowlisted). |
| Browser sessions | `skill_sessions` | SHA-256 of the session token only, workspace, `pending_only`, 30-day expiry, revocation. |
| Skills | `skills` | One Markdown document (`SKILL.md`) per skill, up to 2 MiB; `content_hash`; `approved_at/by` (pending vs published). |
| API keys | `skill_api_keys` | SHA-256 of the key only, 14-char display prefix, creator, scopes CSV, expiry, revocation. |
| Credentials | `skill_credentials` | Name, summary, `secret_value` (AES-256-GCM `encv2:` ciphertext, legacy `encv1:` or plaintext migrate on read). Up to 256 KiB. |
| Members | `skill_workspace_members` | Workspace owner, invited email, role. |
| Invitations | `skill_workspace_invitations` | Pending / accepted / rejected, role. |
| Roles | `skill_access_roles` | JSON policy: scopes, all/selected skill IDs, all/selected credential IDs. |

There are no file uploads, skill bundles or other blobs. A "skill" is a single
Markdown text column. The telemetry database belongs to the Gonvex runtime
(function timings and errors), is not application data, and is not migrated.

Limits enforced by the backend: 500 skills, 100 credentials, 50 active API
keys, 50 members + pending invitations, 50 roles per workspace; names ≤ 120
chars, summaries ≤ 1000 chars, no control characters.

### 2.2 Function inventory (the API contract)

Every call is a Gonvex function addressed by path, with JSON arguments. Browser
calls carry `sessionToken`; agent calls carry `apiKey`. Results are JSON;
errors are a single human-readable string (the CLI and UI show it verbatim).

Browser session functions:

| Path | Kind | Arguments → result | Rule |
| --- | --- | --- | --- |
| `auth.login` | mutation | `idToken` → `{sessionToken, expires_at, email, name, is_owner, pending_only}` | Google ID token verified (audience, verified email). Allowlisted accounts own a workspace; members land in the inviter's workspace; invited-only accounts get a pending-only session. Prunes sessions expired > 7 days. |
| `auth.logout` | mutation | → `{deleted}` | Revokes the session. |
| `auth.me` | query | → `{email, name, is_owner, workspace_id, workspace_email, pending_only}` | |
| `auth.workspaces` | query | → `[{id, email, is_owner, active}]` | Own workspace (if `can_own`) plus memberships. |
| `auth.switchWorkspace` | mutation | `workspace_id` → workspace | Only to an active workspace. |
| `team.list` | query | → `[{id, email, created_at, status}]` | Pending invitations only for the owner. |
| `team.invite` | mutation | `email, role_id` → member | Owner only; role required; limit 50; owner can't invite self; re-invite updates the pending row. |
| `team.remove` | mutation | `id` → `{deleted}` | Owner only. Removing a member revokes that person's sessions in the workspace **and every API key they created**. Cancelling an invitation revokes pending-only sessions for that email. |
| `team.invitations.list` | query | → `[{id, workspace_id, workspace_email, email, created_at}]` | Invitations addressed to the caller's email. |
| `team.invitations.accept` | mutation | `id` → member | Exact email match; refuses if already a member of another shared workspace; switches the session. |
| `team.invitations.reject` | mutation | `id` → `{deleted}` | Revokes a pending-only session. |
| `skills.list` / `skills.get` | query | → metadata / `{…, content}` | Role-filtered; includes pending skills. |
| `skills.save` | mutation | `id, name, summary, content` → skill | Owner publishes immediately; others may only propose a skill with no published row. |
| `skills.approve` | mutation | `id` → skill | Owner only; bumps `updated_at`. |
| `skills.delete` | mutation | `id` → `{deleted}` | Owner only. |
| `apiKeys.list` | query | → keys (no hashes) | Own keys always; others need `keys:read`; `can_revoke` per row. |
| `apiKeys.create` | mutation | `name, scopes, expires_in_days, never_expires` → `{record, apiKey}` | Scopes must be within the caller's role; ≤ 365 days or explicit never; 50 active keys. The plaintext key is returned once. |
| `apiKeys.revoke` | mutation | `id` → `{deleted}` | Own key, or `keys:revoke`. |
| `credentials.list` | query | → metadata (never values) | Role-filtered. |
| `credentials.get` | mutation | `id` or `name` → `{…, value}` | `credentials:read` on that item. A mutation because it may re-encrypt. |
| `credentials.save` | mutation | `id, name, summary, value` → metadata | `credentials:write`; new items need all-credentials access; name is unique per workspace (case-insensitive, trimmed). |
| `credentials.delete` | mutation | `id` → `{deleted}` | |
| `access.snapshot` | action | → `{state, vault}` | Members' UI polls this every 5 s. |
| `access.state` / `access.vault` | query | → role state / filtered vault | |
| `access.saveRole` / `deleteRole` / `assignRole` | mutation | | Owner only; built-in `full` role is immutable; roles in use can't be deleted. |
| `skills.sync`, `apiKeys.sync`, `credentials.sync`, `team.membersSync`, `team.invitationsSync` | sync | `ownerId` → rows | Owner only; projections exclude `key_hash` and `secret_value`. |

Agent (API key) functions, used by `whagons-dev` and scripts:

| Path | Kind | Scope | Notes |
| --- | --- | --- | --- |
| `agent.skills.list` | query (live) | `skills:read` | Published only, metadata only. Today the CLI daemon keeps this subscribed for pushed updates; on Workers the daemon polls it (§4.2). |
| `agent.skills.get` | query | `skills:read` | By `id` or `name`; published only. |
| `agent.skills.upload` | mutation | `skills:write` | `publish: true` from an **owner-created** key goes live; others create pending proposals. |
| `agent.skills.delete` | mutation | `skills:write` | Owner-created key only. |
| `agent.apiKeys.list` | query | `keys:read` | |
| `agent.apiKeys.verify` | query | any | Used by `auth set-key` and the browser flow. |
| `agent.apiKeys.revoke` | mutation | `keys:revoke` | |
| `agent.apiKeys.revokeSelf` | mutation | any | Used by `auth logout`. |
| `agent.credentials.list` / `get` / `save` / `delete` | query / query / mutation / mutation | `credentials:read` / `:read` / `:write` / `:write` | `get` by `id` or `name` returns the decrypted value. |

There is deliberately no `agent.apiKeys.create`: a leaked key cannot mint
keys that outlive its own revocation. That rule is kept.

An API key's effective permissions are the intersection of its own scopes and
the **current** role of the person who created it, evaluated on every call, so
role downgrades and removals apply to existing keys immediately.

### 2.3 How clients talk to it

`whagons-dev` (Go, `cli/cmd/whagons-dev/main.go`) opens
`wss://gonvex.whagons.com/ws?project=<id>` and uses a small subset of the
Gonvex protocol:

```
→ {"type":"auth","id":…,"token":<unsigned dev JWT>,"tenant":<project>}   ← auth.result | auth.error
→ {"type":"query.subscribe","id":…,"path":…,"args":{…}}                  ← query.result (repeated on change) | query.error
→ {"type":"query.unsubscribe","id":…}
→ {"type":"mutation.call","id":…,"path":…,"args":{…}}                    ← mutation.result | mutation.error
```

The `auth` token is an unsigned `alg: none` JWT. It carries no authority; all
authorization is in the `apiKey` / `sessionToken` arguments. The CLI stores
`wsURL`, `project` and `apiKey` in `~/.whagons-dev/config.json`, overridable
with `WHAGONS_DEV_WS_URL` / `WHAGONS_DEV_PROJECT`. It already contains a
precedent for rewriting a retired default endpoint (`migrateLegacyRuntime`).

The React UI uses `@gonvex/client` / `@gonvex/react`: one-shot queries,
mutations, one action, and durable sync collections (owner only).

The browser CLI-authorization flow (loopback callback, state-bound POST, key
never in a URL) is entirely frontend + `apiKeys.create`, and carries over
unchanged.

**Decision (Gabriel): no backwards compatibility.** Nobody depends on old CLI
versions, so the Worker does not speak this WebSocket protocol. The CLI in
this repository is updated to the HTTP API (§4.2) and reaches developers
through its existing self-update.

## 3. Target architecture

```
                     skills.whagons.com (Worker custom domain)
                                    │
                      ┌─────────────▼──────────────┐
                      │ Worker  skills-vault       │  security headers, routing,
                      │  /            static UI    │  per-IP rate limits
                      │  /api/<fn>    JSON API ──┐ │
                      │  /admin/*     operator ──┤ │  (bearer ADMIN_TOKEN, off by default)
                      │  /health                 │ │
                      └──────────────────────────┼─┘
                                                 ▼  RPC
                      ┌────────────────────────────────────────────┐
                      │ Durable Object  Vault  (idFromName "vault", │
                      │                 locationHint "enam")        │
                      │  SQLite: users, sessions, skills, keys,    │
                      │          credentials, team, roles, audit   │
                      │  serialized calls · alarm: pruning         │
                      └───────────────┬────────────────────────────┘
                                      │ overflow skill content (> 1 MiB), nightly backups
                                      ▼
                                 R2  skills-vault-blobs
```

### 3.1 Why one SQLite Durable Object (and not D1)

* **Transactions and invariants.** Every rule in §2.2 (limits, unique names,
  "removal revokes keys", role checks) is a read-then-write. A single DO runs
  them serially against local SQLite, with no cross-request races and no
  network round trips per statement. D1 would need the same rules re-expressed
  as single SQL statements or batches.
* **Scale fits easily.** About 9 MB of data and a team-sized request rate. One
  DO's SQLite holds 10 GB.
* **Point-in-time recovery.** SQLite-backed DOs keep 30 days of PITR
  bookmarks, in addition to the nightly R2 export (§7).

**Location (decision): `enam`, eastern North America.** The Worker asks for
the DO with `locationHint: "enam"` (variable `VAULT_LOCATION_HINT`). A hint
only applies when the object is first created, so it must be set before the
first production request. It is in `wrangler.jsonc` for both environments.
Agents far from eastern North America pay one extra round trip per call,
which is acceptable for a vault read a few times per command.

### 3.2 R2

The vault has no blob features today, so R2 has two narrow uses:

1. **Overflow skill content.** DO SQLite caps a row at 2 MB, and the skill
   limit is 2 MiB. Content larger than 1 MiB is stored in R2 at
   `skills/<id>/<content_hash>` and the row keeps `content_r2_key`. Today every
   skill is far below this, so the path exists only to honour the contract.
2. **Backups.** A nightly cron writes a full JSON export (credentials stay
   `encv2` ciphertext, tokens stay hashes) to `backups/YYYY-MM-DD.json`, with
   a 35-day lifecycle rule.

### 3.3 Frontend on Workers static assets

The same React build is served from Workers static assets with SPA fallback.
The Worker runs first for every request so it can add the security headers
that `nginx.conf` sets today: CSP, HSTS, `Referrer-Policy`, `nosniff`,
`X-Frame-Options`, `Permissions-Policy` and COOP. CSP `connect-src` is
`'self'` (plus the CLI loopback callback and Cloudflare analytics), because the
UI talks only to its own origin.

The frontend's data layer is selected at build time by a Vite alias,
`@backend`. The default build, used by Docker/Coolify, resolves it to
`src/backend/gonvex.tsx`, so merging this work does not change the production
UI. `vite build --mode cloudflare` resolves it to `src/backend/cloudflare.tsx`,
a small client for the JSON API. Owner collections (`skills.sync` and the
others) are polled every 5 seconds while the tab is visible (every 30 seconds
while hidden), and immediately after the browser's own writes. Members
already poll `access.snapshot` every 5 seconds. Nothing about the vault is
persisted in the browser. `App.tsx` keeps the same `useSync` / `useMutation` /
`query` calls.

## 4. API on Workers

### 4.1 One HTTP API

The full reference is [`API.md`](API.md). In short:

* `POST /api/<function>`, with the arguments as a JSON object. The function
  names are the §2.2 paths, such as `agent.credentials.get` or
  `team.invite`. The response is `200 {"result": …}`, or an error status
  (400/401/403/404/409/413/429/500) with `{"error": "…"}`. The error strings
  are the Go backend's.
* **Credentials only in the `Authorization` header.** `Authorization: Bearer
  <token>` carries the API key for `agent.*` functions and the session token
  for everything else. A body that contains `apiKey` or `sessionToken` is
  rejected with 400, so secrets never sit in request bodies that a proxy or
  log might keep. GET is not accepted, so nothing sensitive ends up in URLs.
* Requests are capped at 3 MiB, enough for a 2 MiB skill.

The function-per-path RPC shape was chosen over REST resources because the
§2.2 inventory, its tests, and the UI's call sites are already function-shaped.
Mapping them onto REST verbs would add a translation layer and change nothing
for callers.

### 4.2 CLI (`whagons-dev`) changes

* **Transport:** the Gonvex WebSocket client and the `gorilla/websocket`
  dependency are removed. A small HTTP client posts to
  `<api>/api/<function>` and sends the API key as `Authorization: Bearer`.
* **Endpoint:** `WHAGONS_DEV_API_URL`, then `apiURL` in
  `~/.whagons-dev/config.json`, then the origin of the vault app URL
  (`WHAGONS_DEV_APP_URL` / `appURL`, default `https://skills.whagons.com`).
  HTTPS is required except for loopback. The old `wsURL` and `project` config
  fields are ignored and dropped on the next config write. The API key itself
  carries over.
* **Daemon:** the daemon used to hold a live subscription. It now polls the
  skill metadata list every 20 seconds and runs a full sync when the revision
  changes, plus the usual sync every interval (default 1 minute).
* **Release:** through the existing self-update. The daemon checks daily and
  runs `go install github.com/whagons/skills/cli/cmd/whagons-dev@latest`, and
  anyone can run `whagons-dev --update` immediately. Because `@latest`
  follows this repository, **merging this change ships the new CLI**. Merge it
  as part of the cutover (§8), not before, or developers' CLIs will point at
  `skills.whagons.com/api` while that is still the Gonvex frontend.

### 4.3 Operator endpoints

`/admin/import`, `/admin/export`, `/admin/stats`, `/admin/verify-decrypt` and
`/admin/reencrypt` require `Authorization: Bearer <ADMIN_TOKEN>`. They are
compared in constant time and are **disabled when the `ADMIN_TOKEN` secret is
unset**, which is the normal state. They exist for migration, verification,
key rotation and rollback. None of them ever returns a plaintext secret;
`verify-decrypt` returns counts only. `import` refuses a non-empty vault
unless `?replace=1` is given. Before it returns, `import` re-encrypts any
legacy `encv1`, plaintext or old-key rows, so they never sit unprotected in
storage, PITR snapshots or backups. The token must be at least 32 characters.

### 4.4 Deliberate contract changes

| Change | Why |
| --- | --- |
| Transport is HTTP (`POST /api/<function>`); the Gonvex WebSocket protocol is gone. | Gabriel's decision: no backwards compatibility. Simpler server, nothing to keep alive. |
| Credentials move from arguments to the `Authorization` header. | Keeps secrets out of bodies; the CLI and UI clients do this for callers. |
| No pushed updates. The UI polls every 5 s; the CLI daemon polls skill metadata every 20 s. | No sockets to hold open. Edits reach agents within about 20 s instead of about 1 s. |
| Timestamps are ISO-8601 UTC with millisecond precision (Postgres had microseconds). | JavaScript `Date`. Clients treat them as opaque strings or parse them with `Date.parse`. After migration, the daemon's revision string changes once, which causes one harmless re-sync. |
| Case-insensitive name matching uses JavaScript `toLowerCase()` on a stored `name_key`, instead of Postgres `lower()`. | Equivalent for every current name. SQLite's `lower()` is ASCII-only, so the key is computed in code. |
| `ensureTables` DDL migrations and `SKILLS_LEGACY_OWNER_EMAIL` legacy claiming are dropped. | The schema is created once. The migration tool fails if any row still has an empty owner. |
| New: audit log, `audit.list`, `audit.credentialReads`, and the owner's Access log page. | §5.5. |
| New: per-IP rate limits. | §5.7. |
| New: admin endpoints. | §4.3. |

Everything else (function names, arguments, result fields, limits, error
strings, role semantics and owner-only rules) is ported one to one. The
Worker test suite encodes the behaviour that the Go backend tests cover.

## 5. Security model

### 5.1 Principals

* **Owner**: a Google account matching `SKILLS_ALLOWED_EMAILS` /
  `SKILLS_ALLOWED_DOMAINS` (default: Gabriel's address only). Owns exactly one
  workspace, has full access, and is the only one who can invite, remove,
  assign roles, approve or delete skills.
* **Member**: a Google account that accepted an invitation to the exact email
  address. Their access is defined by their role.
* **Pending identity**: a signed-in, invited, not-yet-accepted account. It can
  only list, accept or reject invitations.
* **API key**: acts for its creator in the creator's workspace. Effective
  permission = key scopes ∩ creator's current role ∩ per-item grants.
* **Operator**: whoever holds the `ADMIN_TOKEN` secret, only while it is set.

### 5.2 Who can read which secret

A credential value is returned only by `credentials.get` (session) and
`agent.credentials.get` (API key), and only when **all** of these hold:

1. The session or key is valid: not revoked, not expired, and the creator or
   member is still in the workspace.
2. The caller's role has `credentials:read`, and the API key has the
   `credentials:read` scope.
3. The role grants either all credentials or that credential's ID. When
   looking up by name, every row matching the name must be granted.
4. The credential belongs to the caller's active workspace.

Lists, owner collections, exports and backups never contain
values. Every value read is written to the audit log.

### 5.3 Encryption at rest

* Format is unchanged: `encv2:<key-id>:<base64(nonce‖AES-256-GCM ciphertext)>`,
  where key-id is the first 12 hex digits of SHA-256(key). AAD is
  `whagons-skills/credential/<workspace>/<credential-id>`, so ciphertext cannot
  be moved to another row or workspace. Legacy `encv1:` and plaintext rows are
  decrypted and re-encrypted on read, as today.
* Implemented with WebCrypto in the Worker and byte-compatible with the Go
  code. **Migration copies ciphertext verbatim; no plaintext secret leaves
  either system during migration.** A test checks Go-generated vectors
  against the Worker implementation.
* Cloudflare also encrypts DO storage and R2 at rest. That protects against
  disk theft, not against someone with access to the Cloudflare account; the
  application-level layer above is what protects against exports, backups and
  PITR snapshots.
* Session tokens and API keys are stored only as SHA-256 hashes; they are
  256-bit random values, so an unsalted hash is sufficient. Hashes are copied
  verbatim, so **existing CLI keys and browser sessions keep working after
  migration**.

### 5.4 Key management

* `SKILLS_SECRET_KEY` (32 bytes, hex or base64) is a Worker secret. It is
  write-only through the API and dashboard, and readable only by the running
  Worker. Credential operations fail closed if it is missing or malformed.
* The **same key** as today is set on the Worker at cutover. The operator copy
  stays where it is today (`.skills-vault-password`, mode 0600, never
  committed). Backups are useless without it, and it is never stored in R2 or
  the DO.
* Rotation is the same as today: set the new key, move the old one to
  `SKILLS_SECRET_KEY_PREVIOUS`, then run `/admin/reencrypt` (new) to rewrite
  every row immediately instead of waiting for reads. Remove the previous key
  after `/admin/verify-decrypt` reports zero rows on old keys.
* Cloudflare access is the root of trust. The Cloudflare account must have 2FA
  on every member, and the API token that deploys the Worker should be
  scoped to Workers, DO and R2 for this account only. Anyone who can deploy
  code to the Worker can read secrets, exactly as anyone who can change
  the Gonvex project can today.
* Dev resources (`skills-cf-dev-*`) use a separate, randomly generated key and
  only fixture data.

### 5.5 Audit log (new)

Table `audit_events` (append-only from the application's view):
`at, workspace_id, actor_id, actor_email, via (session | api_key | admin),
api_key_id, action, target_type, target_id, target_name, outcome
(ok | denied | error), detail, ip, user_agent, cf_ray`.

Logged: logins (allowed and denied), logouts, workspace switches, every
credential read (`credentials.get`, `agent.credentials.get`) **including
denials**, credential save/delete, skill save/upload/approve/delete, API key
create/revoke/revokeSelf, invite/remove/accept/reject, role
save/delete/assign, and every admin call. Not logged: list and metadata
queries, which would be noise. Values, tokens and key hashes are never
written. Retention is 400 days, pruned by the DO alarm. Workers Logs record
request metadata only; the code never logs arguments.

**Access log page (decision).** A single owner-only page, "Access log", lists
recent credential reads: when, who, through which API key or the browser,
which secret, and whether the read was allowed or denied. It can be filtered
by person, API key and secret, and nothing more. A denied read by name is
recorded against the credential's ID when the name exists in the caller's
workspace, so the secret filter finds it. The page is backed by
`audit.credentialReads`; `audit.list` returns the full event stream for the
owner.

### 5.6 Revocation

| Action | Effect |
| --- | --- |
| Revoke an API key (UI, `agent.apiKeys.revoke`, `revokeSelf`) | The next call with it fails (401). |
| Logout | Session revoked. |
| Remove a member | Their sessions in the workspace and **every key they created** are revoked in the same transaction. |
| Change or downgrade a role | Applies to the member's sessions and keys on their next call, because roles are evaluated per call and never cached in tokens. |
| Cancel an invitation | Pending-only sessions for that email are revoked. |
| Emergency: lock the whole vault | Remove `SKILLS_SECRET_KEY` (credential reads fail closed instantly) or route `skills.whagons.com` to a maintenance response. |

As today, a value that was already read cannot be recalled, so rotate the
credential at its source.

### 5.7 Other hardening

* **Request size:** each HTTP body is capped at 3 MiB, above the 2 MiB skill
  limit.
* **Rate limits (defaults chosen for this design):** implemented with the
  Workers Rate Limiting binding and keyed by client IP (`CF-Connecting-IP`).
  * `API_LIMIT` allows 600 API calls per 60 s per IP. A busy office behind one
    NAT stays well under this: each daemon makes about 3 calls a minute and
    an open owner tab about 75. Scripted guessing or abuse is still bounded.
  * `LOGIN_LIMIT` allows 10 `auth.login` attempts per 60 s per IP.
  * Over a limit, the API returns 429 with `Retry-After: 60`. The binding's
    counters are per Cloudflare location and approximate, which is enough to
    blunt abuse.
  * API keys and session tokens are 256-bit random values, so guessing them
    is not a realistic threat. The limits protect availability and Google
    sign-in.
* **No CSRF surface:** there are no cookies. Browser auth is a bearer token
  in `sessionStorage`, as today, and CSP forbids inline script.

## 6. Data model (DO SQLite)

The tables keep the Postgres names and columns so the migration is a direct
copy. Additions are marked **new**.

```sql
skill_users(owner_id TEXT PK, email, name, can_own INT, created_at, updated_at)
skill_sessions(id PK, owner_id, workspace_id, token_hash UNIQUE, pending_only INT,
               created_at, expires_at, revoked_at NULL)
skills(id PK, owner_id, name, name_key /*new*/, summary, content, content_r2_key NULL /*new*/,
       content_hash, approved_at NULL, approved_by, created_at, updated_at)
  INDEX (owner_id, name_key), (owner_id, updated_at)
skill_api_keys(id PK, owner_id, created_by, name, key_hash UNIQUE, prefix, scopes,
               created_at, expires_at NULL, revoked_at NULL)
skill_credentials(id PK, owner_id, name, name_key /*new*/, summary, secret_value, created_at, updated_at)
  UNIQUE (owner_id, name_key)
skill_workspace_members(id PK, workspace_owner_id, email, invited_by, role_id, created_at)
  UNIQUE (workspace_owner_id, email)
skill_workspace_invitations(id PK, workspace_owner_id, email, invited_by, role_id, created_at,
                            accepted_at NULL, rejected_at NULL)
  UNIQUE (workspace_owner_id, email) WHERE accepted_at IS NULL AND rejected_at IS NULL
skill_access_roles(id PK, workspace_owner_id, name, policy /*JSON*/)
audit_events /*new*/ (id INTEGER PK AUTOINCREMENT, at, workspace_id, actor_id, actor_email, via,
                      api_key_id, action, target_type, target_id, target_name, outcome,
                      detail, ip, user_agent, cf_ray)
  INDEX (workspace_id, at)
vault_meta /*new*/ (key PK, value)   -- schema_version, imported_from, imported_at
```

Timestamps are ISO-8601 strings, so they sort lexically. Booleans are 0 or 1.
Schema changes are numbered migrations run in the DO constructor inside
`blockConcurrencyWhile`.

## 7. Migration from Gonvex

Tool: `tools/migrate/` (Node, no dependencies).

1. **Export, read only.** `migrate export-sql` prints one SQL statement that
   runs in a `BEGIN READ ONLY` transaction and returns the eight tables as a
   single JSON document. The operator runs it against the project database
   (`docker exec <postgres> psql -U gonvex -d gonvex_01f1974b_… -At -f -`) and
   saves the output to a 0600 file outside any repo. It writes nothing to
   Postgres. The file contains ciphertext and hashes, never plaintext values,
   but should still be handled as sensitive and deleted afterwards.
2. **Transform and validate.** `migrate transform export.json bundle.json`
   normalizes timestamps, computes `name_key`, and checks every invariant: no
   empty owners, unique credential names, size limits, roles referencing
   existing items, and credential formats. It reports counts per table, the
   number of credentials per format and key-id, and any problem. It never
   prints values. Plaintext or `encv1` rows are reported; the Worker
   re-encrypts them on first read, or immediately via `/admin/reencrypt`.
3. **Import.** `migrate import bundle.json --url https://<worker> ` posts to
   `/admin/import` (bearer `ADMIN_TOKEN` read from the environment). The import
   is one DO transaction: all or nothing.
4. **Verify.** `migrate verify bundle.json --url …` compares per-table counts
   and SHA-256 digests of canonical rows between the bundle and
   `/admin/stats`. Credential digests cover metadata only, because import
   re-encrypts legacy rows. It then calls `/admin/verify-decrypt`, which must
   report every credential decryptable with the configured key. Finally,
   smoke-test with the new CLI: `WHAGONS_DEV_API_URL=https://<worker>
   whagons-dev credentials list` and `skills list`.

The tool is tested end to end against **generated fixtures**: fake users,
skills, roles, sessions, keys, and credentials encrypted with a throwaway key
in all three storage formats. Real production data is never used in tests,
dev resources, logs or the repository.

## 8. Cutover runbook (Gabriel runs it; nothing here is done yet)

**Decision: keep it simple, with a short manual freeze.** There is no automated
write-freeze machinery.

**Before the day**
* The production Worker `skills-vault` is deployed on its `workers.dev` URL
  with `SKILLS_SECRET_KEY` set to the current production key and the
  `SKILLS_ALLOWED_*` / `SKILLS_GOOGLE_CLIENT_ID` values copied from the Gonvex
  `skills` project. All of them are Worker secrets. Set a temporary
  `ADMIN_TOKEN` too.
* Do a rehearsal: export, transform, import and verify (§7) into it. Smoke-test
  with `WHAGONS_DEV_API_URL=https://skills-vault.<sub>.workers.dev`. Leave the
  data there or re-import on the day with `--replace`.
* Check that you can reach the Gonvex Postgres container for the read-only
  export, and that you hold a Cloudflare token allowed to attach a custom
  domain on whagons.com (`cloudflare_dns_access` or broader).
* PR #12 is reviewed but **not merged**. Merging it releases the new CLI.

**On the day** (about 15 minutes)
1. **Announce the freeze:** "don't add or change secrets or skills in the
   vault until I say so."
2. **Final export → transform → import (`--replace`) → verify** (§7). Verify must
   print `verify ok` with every credential decrypting.
3. **Switch DNS:** attach `skills.whagons.com` as the Worker's custom domain.
   This replaces the proxied record that points at Coolify. Then set
   `"workers_dev": false` in `wrangler.jsonc` and redeploy. Check that sign-in
   works in a browser: the hostname is unchanged, so the Google OAuth client
   needs no change.
4. **Switch the CLI endpoint:** merge PR #12. Its CLI defaults to
   `https://skills.whagons.com/api`. Daemons pick it up through their daily
   self-update; anyone can run `whagons-dev --update` immediately. Until a
   machine updates, its old CLI keeps talking to Gonvex and fails after step 5,
   which is visible and harmless. The API key in each config keeps working,
   because key hashes were migrated.
5. **Stop the old vault:** make the Gonvex `skills` project read-only or stop
   it. The simplest option is removing `SKILLS_SECRET_KEY` from the project,
   so credential reads and writes there fail closed. Leave its database
   untouched for 30 days as the rollback source.
6. **Lift the freeze** and unset `ADMIN_TOKEN` on the Worker.

Browser sessions and CLI keys survive, because token hashes are copied.
Expected disruption is the freeze window plus the time until each machine's
CLI updates.

## 9. Rollback

* **Before step 3:** nothing public has changed. The Worker can stay or be
  deleted.
* **After cutover, with no writes worth keeping:**
  * Detach the custom domain and restore the original proxied DNS record for
    `skills.whagons.com` (note it before cutover).
  * Restore `SKILLS_SECRET_KEY` on the Gonvex project, or restart it.
  * Revert the CLI change on `main`; daemons self-update back.
  * The old database was never modified, so it is exactly the pre-cutover
    state.
* **After cutover, with new writes:** `migrate export --url …` pulls
  `/admin/export` (ciphertext and hashes only), and `migrate to-postgres` turns
  it into idempotent `INSERT … ON CONFLICT DO UPDATE` SQL for the Gonvex
  tables. Gabriel reviews and applies it, then follows the step above.
  Because the encryption format is shared, ciphertext moves back unchanged.
* **Data loss inside Cloudflare:** restore from DO point-in-time recovery
  (30 days) or from the nightly R2 export via `/admin/import?replace=1`.

## 10. Cost

The Cloudflare account already has **Workers Paid** ($5/month base, already
paid) and **R2 Paid**. Assumptions:
* 10 developers, each running the daemon. It makes about 3 metadata checks a
  minute, with full syncs only on change or every 30 minutes.
* About two owner or member browser tabs open during working hours. They poll
  every 5 s while visible.

| Item | Estimate / month | Included | Marginal cost |
| --- | --- | --- | --- |
| Worker requests | ~2.5 M | 10 M | $0 |
| DO requests (each API call is one) | ~2.5 M | 1 M | ~$0.25 at $0.15/M |
| DO duration (128 MB; one object; worst case awake all month) | ≤ 330 k GB-s | 400 k GB-s | $0 |
| DO SQLite storage / rows | < 50 MB; < 50 M rows read | 5 GB; 25 B rows | $0 |
| R2 storage (35 daily backups × ~10 MB) | ~0.35 GB | 10 GB | $0 |
| Rate Limiting binding | — | included | $0 |

**Expected marginal cost: about $0.25/month, under $1/month even at 50
developers.** The worst case is the $5 base, if Workers Paid were ever dropped
for everything else.

## 11. Testing and CI

* **Worker:** `worker/test/*.test.ts` runs inside **workerd**
  (`@cloudflare/vitest-plugin`) against a real DO with SQLite. It covers:
  * the auth matrix (owner, member, pending, removed, downgraded, expired,
    revoked) and the API key escalation rules;
  * skill publish rules;
  * credential crypto, including Go-generated vectors and legacy formats;
  * the HTTP contract, including credentials refused in bodies and size and
    path errors;
  * login rate limiting;
  * the access-log query and its filters;
  * admin gating, migration, and backups.
* **CLI:** `cli/` tests run against an `httptest` fake of the HTTP API. They
  cover endpoint resolution, dropping old Gonvex config fields, and the
  daemon's change detection.
* **Migration tool:** tests on generated fixtures run transform, import into
  workerd, verify digests, export, and the `to-postgres` round trip.
* **Crypto cross-check:** `tools/crosscheck/` extracts the credential crypto
  from `gonvex/skills.go` by Go AST, not by hand, and checks it against the
  Worker in both directions, including rotation and `encv1`.
* **End to end:** `tools/e2e/cli-against-worker.sh` builds `whagons-dev` from
  this checkout and runs it against `wrangler dev` or the dev Worker under a
  throwaway `$HOME`. It covers migration, `auth set-key`,
  `credentials list/exec/set`, `skills list/get/update`, the daemon picking
  up a newly published skill, and `auth logout` revocation.
* **CI:** job `worker` runs the Worker, migration, crypto and end-to-end
  checks, plus typechecks and a dry-run bundle. It never deploys. The `cli`
  job runs the CLI tests on Linux, macOS and Windows.
* **Dev deployment:** Worker `skills-cf-dev-vault` and bucket
  `skills-cf-dev-blobs`, with a random dev key and fixture data only.

## 12. Findings from building it

* **Size limit holds.** A 2,080,059-byte `SKILL.md` went through Cloudflare to
  the dev Worker and was stored through the R2 overflow path. The 2 MiB skill
  contract holds on Workers.
* **Google login on dev.** The Google OAuth client does not list the
  `*.workers.dev` origins, so Google sign-in fails there with
  `origin_mismatch`. On dev, the UI was exercised with a migrated fixture
  session, which also proves that sessions survive migration.
  `skills.whagons.com` is already allowed, so production needs no Google
  change.
* **Existing CSP finding (unchanged here, for parity).** Google Identity
  Services tries to load `https://accounts.google.com/gsi/style`, which the
  current `style-src` blocks. It only logs a console error. Adding that URL to
  `style-src` in both `nginx.conf` and the Worker is a one-line follow-up.
* **Daemon request rate.** Over a socket, re-downloading every skill each
  minute was nearly free. Over HTTP it would have been one request per skill
  per minute per developer. The daemon now checks metadata every 20 s and
  re-downloads only on change, with a full resync at most every 30 minutes.

## 13. Decisions (Gabriel)

1. **No backwards compatibility.** The Worker exposes only the HTTP API (§4.1,
   [`API.md`](API.md)). `whagons-dev` in `cli/` uses it at a configurable
   endpoint and ships through self-update. There is no route on
   `gonvex.whagons.com`.
2. **DO location: `enam`.**
3. **Audit UI:** one owner-only Access log page for credential reads,
   filterable by person, key and secret (§5.5).
4. **Freeze:** a short manual freeze, as in the §8 runbook.
5. **Defaults chosen here.** The production Worker is `skills-vault`, with R2
   bucket `skills-vault-blobs`; dev uses `skills-cf-dev-vault` and
   `skills-cf-dev-blobs`. Rate limits are 600 API calls and 10 sign-ins per
   minute per IP (§5.7).
