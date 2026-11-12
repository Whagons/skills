# Skills Vault HTTP API

The vault Worker serves one JSON API. The `whagons-dev` CLI, the web UI and
scripts all use it. The design is in [DESIGN.md](DESIGN.md).

## Calling a function

```
POST https://skills.whagons.com/api/<function>
Authorization: Bearer <API key or session token>
Content-Type: application/json

{ ...arguments... }
```

* **Function name:** one of the names below, for example
  `agent.credentials.get`.
* **Body:** a JSON object holding the function's arguments; `{}` when there
  are none. Up to 3 MiB.
* **Credentials:** only in the `Authorization` header.
  * `agent.*` functions take an **API key** (`skv_…`), created in the UI or
    by `whagons-dev auth login`.
  * Every other function takes a browser **session token** (`skv_sess_…`)
    from `auth.login`.
  * A body containing `apiKey` or `sessionToken` is rejected with 400.
* **Method:** only `POST`. Credentials never go in URLs.

Success:

```
200 {"result": <value>}
```

Failure:

```
<status> {"error": "<human-readable message>"}
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid input or a rule violation (limits, names, sizes, a body containing credentials). |
| 401 | Missing, invalid, expired or revoked key or session, or a removed member. |
| 403 | Authenticated, but the role, key scope or owner-only rule does not allow this. |
| 404 | Unknown function, skill, credential or invitation. |
| 409 | Conflict (admin import into a non-empty vault). |
| 413 | Body larger than 3 MiB. |
| 429 | Rate limited; see `Retry-After`. 600 calls per minute per IP; 10 `auth.login` per minute per IP. |
| 500 | Internal error. The message is generic, and nothing secret is ever echoed. |

Error messages match the previous Gonvex backend word for word, for example
`invalid api key` or `your role does not allow access to this item`.

### Examples

```bash
API=https://skills.whagons.com
curl -sS -X POST $API/api/agent.skills.list \
  -H "Authorization: Bearer $WHAGONS_DEV_API_KEY" -H 'content-type: application/json' -d '{}'

curl -sS -X POST $API/api/agent.skills.get \
  -H "Authorization: Bearer $WHAGONS_DEV_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"whagons-monitor"}'
```

Prefer `whagons-dev credentials exec <name> -- <command>` over calling
`agent.credentials.get` yourself, so values never reach a terminal or log.

## Agent functions (API key)

The effective permission for any API key call is the key's scopes, intersected
with the creator's current role, intersected with per-item grants. All three
are checked on every call.

| Function | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `agent.skills.list` | `skills:read` | — | `[{id, name, summary, created_at, updated_at, approved}]` (published only, no content) |
| `agent.skills.get` | `skills:read` | `id` or `name` | `{id, name, summary, content, created_at, updated_at, approved}` (published only) |
| `agent.skills.upload` | `skills:write` | `name`, `content`, optional `id`, `summary`, `publish` | skill. `publish: true` from an owner-created key goes live; anything else is a pending proposal. Members cannot change a published skill. |
| `agent.skills.delete` | `skills:write` | `id` | `{deleted}`. Owner-created keys only. |
| `agent.credentials.list` | `credentials:read` | — | `[{id, name, summary, created_at, updated_at}]` (never values) |
| `agent.credentials.get` | `credentials:read` | `id` or `name` | `{id, name, summary, value, created_at, updated_at}`. Every call is audited, including denials. |
| `agent.credentials.save` | `credentials:write` | `name`, `value`, optional `id`, `summary` | metadata. Creating a new credential requires access to all credentials. Names are unique per workspace, case-insensitive. |
| `agent.credentials.delete` | `credentials:write` | `id` | `{deleted}` |
| `agent.apiKeys.list` | `keys:read` | — | `[{id, name, prefix, created_at, expires_at, revoked_at?, scopes, created_by?}]` |
| `agent.apiKeys.verify` | any | — | `{deleted: true}` if the key is valid |
| `agent.apiKeys.revoke` | `keys:revoke` | `id` | `{deleted}` |
| `agent.apiKeys.revokeSelf` | any | — | `{deleted}` (revokes the calling key) |

There is deliberately no `agent.apiKeys.create`: a leaked key cannot mint
keys that outlive its own revocation.

## Browser functions (session token)

| Function | Arguments | Notes |
| --- | --- | --- |
| `auth.login` | `idToken` (Google ID token) | No `Authorization` header. Returns `{sessionToken, expires_at, email, name, is_owner, pending_only}`. |
| `auth.logout` | — | Revokes the session. |
| `auth.me`, `auth.workspaces` | — | Identity and the workspaces the account can use. |
| `auth.switchWorkspace` | `workspace_id` | |
| `team.list`, `team.invite` (`email`, `role_id`), `team.remove` (`id`) | | Invite and remove are owner only. Removal revokes the member's sessions and every key they created. |
| `team.invitations.list`, `.accept` (`id`), `.reject` (`id`) | | For the signed-in account's own invitations. |
| `skills.list`, `skills.get` (`id`/`name`), `skills.save`, `skills.approve` (`id`), `skills.delete` (`id`) | | Approve and delete are owner only. |
| `apiKeys.list`, `apiKeys.create` (`name`, `scopes`, `expires_in_days`, `never_expires`), `apiKeys.revoke` (`id`) | | The plaintext key is returned once by `create`. |
| `credentials.list`, `credentials.get` (`id`/`name`), `credentials.save`, `credentials.delete` (`id`) | | `get` is audited. |
| `access.snapshot`, `access.state`, `access.vault` | — | Role state; the role-filtered vault for members. |
| `access.saveRole` (`role`), `access.deleteRole` (`id`), `access.assignRole` (`id`, `role_id`) | | Owner only. |
| `skills.sync`, `apiKeys.sync`, `credentials.sync`, `team.membersSync`, `team.invitationsSync` | `ownerId` | Owner-only collections; the UI polls them. No secret columns. |
| `audit.list` | optional `limit` (≤ 500), `before` (ISO time) | Owner only. Every audit event, newest first. |
| `audit.credentialReads` | optional `actor_email`, `api_key_id`, `credential_id`, `limit`, `before` | Owner only. Credential reads with `result` = `allowed` / `denied` / `failed`. Backs the Access log page. |

## Operator endpoints

`GET|POST /admin/{stats,export,import,verify-decrypt,reencrypt}` with
`Authorization: Bearer <ADMIN_TOKEN>`. They return 404 unless the
`ADMIN_TOKEN` secret (at least 32 characters) is set. They exist for migration
and rotation; see DESIGN.md §4.3 and `tools/migrate/`. They never return
plaintext secrets.

## Other routes

* `GET /health` → `ok`
* Everything else → the web UI (single-page app), with security headers.
