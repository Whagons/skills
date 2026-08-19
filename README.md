# Whagons Skills Vault

Gonvex + React app at https://skills.whagons.com for storing Whagons-specific agent skills and project credentials behind server-verified Google login, with a plug-and-play CLI (`whagons-dev`) for agents.

## Quick start for agents (plug and play)

```bash
go install github.com/whagons/skills/cli/cmd/whagons-dev@latest
whagons-dev setup
```

That's it. On first use the CLI opens https://skills.whagons.com in the browser; sign in with Google and click **Authorize CLI**. The CLI receives a scoped one-year key and stores it itself in the private `~/.whagons-dev/config.json` file; a model does not need to copy or save it. `setup` then:

- stores signed canonical skills in `~/.whagons-dev/skills`,
- links them into the compatible agents detected on the machine,
- installs a lightweight login service that receives live vault changes with a periodic fallback, and
- enables a daily CLI self-update check.

Install every supported integration instead of only detected agents with:

```bash
whagons-dev setup --targets all
```

Every later command just works:

```bash
whagons-dev skills update                                        # refresh managed skills now
whagons-dev --update                                             # update the CLI now
whagons-dev credentials list                                     # see what secrets exist
whagons-dev credentials exec coolify-whagons -- node deploy.mjs  # inject a secret, never print it
```

Headless environments can skip the browser: create a key in the UI's API keys tab, then either hand it to the agent to persist —

```bash
printf '%s' "$KEY" | whagons-dev auth set-key --stdin   # validates against the vault, saves to config
```

The stdin flow keeps the key out of shell history. Avoid exporting long-lived keys into a broad parent environment. Agents cannot mint keys themselves; a human creates a scoped, expiring key in a Google-verified session and hands it over separately from setup text.

## Team workspaces

All data (skills, credentials, API keys) belongs to a **workspace**, owned by the Google account that created it. From the **Team** tab in the UI, the workspace owner can invite other Google emails. Invited members:

- do not receive an automatic email, so the owner copies and sends the sign-in instructions shown beside a pending invite,
- must use the exact Google email address entered by the owner,
- sign in with their own Google account and explicitly accept the invitation,
- see and manage all skills, credentials, and API keys in the owner's workspace,
- lose access immediately when removed (their active sessions and keys are revoked).

Login is allowed for accounts that are either invited members or covered by the runtime allowlist:

```bash
SKILLS_ALLOWED_EMAILS=you@example.com,teammate@example.com
SKILLS_ALLOWED_DOMAINS=whagons.com
SKILLS_LEGACY_OWNER_EMAIL=you@example.com
```

If neither `SKILLS_ALLOWED_EMAILS` nor `SKILLS_ALLOWED_DOMAINS` is set, only `malek.gabriel33@gmail.com` can own a workspace. `SKILLS_LEGACY_OWNER_EMAIL` claims pre-owner-migration rows for that Google user only. An allowlisted owner always lands in their own workspace; an invitation never silently redirects that account.

## Local development

- `.env.local` contains the Gonvex runtime settings and project key. It is ignored by git and must remain mode `0600`.

```bash
npm install
npm run build
npm run gonvex:once   # sync gonvex/*.go and schema metadata to the runtime
npm run dev
```

Run on a specific local port:

```bash
npm run vite -- --host 127.0.0.1 --port 5175 --strictPort
```

`SKILLS_GOOGLE_CLIENT_ID` is optional on the runtime because the Whagons web client id is the built-in default. Configure the frontend with the same Google OAuth client id:

```bash
VITE_GOOGLE_CLIENT_ID=...
```

Seed local custom skills from `~/.codex/skills` and `~/.agents/skills`:

```bash
WHAGONS_SKILLS_API_KEY=skv_... node scripts/seed-local-skills.mjs
```

Import selected local credentials into the vault without printing secret values:

```bash
WHAGONS_SKILLS_API_KEY=skv_... node scripts/import-local-credentials.mjs
```

By default this imports `coolify-whagons`, `coolify-gabrielmalek`, `digitalocean`, `cloudflare`, and `cloudflare-r2-whagons-backups` from `~/.secrets/keys.json`. Override with:

```bash
SKILLS_CREDENTIAL_IMPORT_FILE=/path/to/keys.json \
SKILLS_CREDENTIAL_IMPORT_NAMES=coolify-whagons,cloudflare \
WHAGONS_SKILLS_API_KEY=skv_... \
node scripts/import-local-credentials.mjs
```

### Durable sync storage (production)

The vault UI renders skills, API keys, credentials, and team rows from Gonvex sync collections (`gonvex/syncs.go`). Those collections need the runtime's durable change log (`_gonvex_sync_clock`, `_gonvex_sync_changes`, per-table triggers) inside the project database. The runtime only installs that storage while applying *tenant* schemas; every vault table is a tenant table and this single-mode project has no tenant targets, so the runtime never installs it and every sync subscribe fails with `relation "_gonvex_sync_clock" does not exist` (a black screen after login).

`scripts/install-sync-storage.sql` is the idempotent install, generated from the runtime's own `schema/sync.go`. Re-generate and re-apply it whenever a sync definition changes its table, key, or projected columns; verify with `select to_regclass('public._gonvex_sync_clock')`.

## Auth model

The UI uses Google Identity Services. The browser sends a Google ID token to the Gonvex backend, which verifies it against `https://oauth2.googleapis.com/tokeninfo` (audience, verified email) before creating a session. Sessions store both who logged in and which workspace they access; invited members resolve to the inviter's workspace.

Google-only: there is no password login.

Agents do not use Google directly. They use a scoped API key created in the UI or via the CLI browser flow. UI-created keys can expire after 7, 30, 90, or 365 days, or explicitly be created without an expiration; CLI browser-flow keys expire after 365 days. Agents call these functions:

- `agent.skills.list` / `get` / `upload` / `delete` (lists are metadata-only; `get` returns content)
- `agent.apiKeys.list` / `revoke`
- `agent.credentials.list` / `get` / `save` / `delete`

There is deliberately no `agent.apiKeys.create`: a leaked API key cannot mint replacement keys that survive its own revocation. New keys only come from a Google-verified session (UI or CLI browser flow).

Keys record their creator, scopes, and expiration. Removing a member revokes every key they created. Agent uploads are quarantined from agent reads and CLI installation until the workspace owner reviews and approves them in the UI.

A session or API key can only read and mutate rows in its own workspace. Credential values are only returned through `agent.credentials.get` / `credentials.get` — never in lists. Do not print credential values in logs or chat.

### Encryption at rest

Set `SKILLS_SECRET_KEY` to exactly 32 random bytes encoded as 64 hex characters or base64. Credential operations fail closed when it is missing or malformed. AES-256-GCM ciphertext is bound to its workspace and credential ID. Existing plaintext and `encv1` rows are migrated to `encv2` when read.

For rotation, set the new key in `SKILLS_SECRET_KEY` and temporarily list old keys in comma-separated `SKILLS_SECRET_KEY_PREVIOUS`. Reads made with a previous key are immediately re-encrypted with the current key. Remove previous keys after all rows have migrated.

This workspace keeps the current operator-side rotation copy in the ignored `.skills-vault-password` file with mode `0600`; it is also excluded from Docker build contexts. Never print or commit that file.

### CLI authorization flow

`whagons-dev` starts a loopback HTTP server on `127.0.0.1`, opens the vault with `?cli_callback=...&cli_state=...`, and waits. After Google login the UI validates the exact callback shape, mints a 365-day CLI key, and sends a state-bound JSON `POST`. The listener permits only the exact vault origin and the key never appears in a URL or browser history. The CLI verifies the key before atomically saving it to a mode-`0600` config file. If delivery or verification fails, the new key is revoked or discarded.

## CLI reference

Install from a checkout:

```bash
cd cli
go install ./cmd/whagons-dev
```

Or directly:

```bash
go install github.com/whagons/skills/cli/cmd/whagons-dev@latest
```

Commands:

```bash
whagons-dev setup [--targets all|codex,t3,claude,cursor,opencode] [--no-startup]
whagons-dev --update
whagons-dev update
whagons-dev self-update
whagons-dev version

whagons-dev startup install
whagons-dev startup status
whagons-dev startup remove
whagons-dev daemon [--interval 1m] [--once]

whagons-dev auth login [--app-url https://skills.whagons.com/]
printf '%s' "$KEY" | whagons-dev auth set-key --stdin
whagons-dev auth status
whagons-dev auth logout

whagons-dev skills list
whagons-dev skills get whagons-monitor --output ./SKILL.md
whagons-dev skills copy whagons-monitor
whagons-dev skills upload ./my-skill/SKILL.md
whagons-dev skills sync ./skills
whagons-dev skills install [--targets all|codex,t3,claude,cursor,opencode]
whagons-dev skills update
whagons-dev skills status
whagons-dev skills install-codex [--dir DIR]
whagons-dev skills update-codex [--dir DIR]
whagons-dev skills delete <name-or-id>

whagons-dev api-keys list
whagons-dev api-keys revoke <id>

whagons-dev credentials list
printf '%s' "$SECRET_JSON" | whagons-dev credentials set coolify-whagons --summary "Coolify token" --value-stdin
whagons-dev credentials exec coolify-whagons -- node ./scripts/deploy.mjs
whagons-dev credentials delete <id>
```

`credentials exec` writes the credential to a temporary mode-`0600` file, exposes its path as `WHAGONS_CREDENTIAL_FILE` and `<NAME>_FILE`, and deletes it after the child exits. The child receives a minimal non-secret environment. Use `--inherit-env NAME[,NAME...]` for additional non-secret variables, `--via stdin` for stdin delivery, or the explicit compatibility mode `--via env` for flattened credential variables.

### Managed skills and integrations

The canonical store is `~/.whagons-dev/skills/<skill-name>/`. Each skill has a secret-key-authenticated `.whagons-managed.json` ownership marker. A sync will only overwrite or delete a directory when that signature is valid and the local `SKILL.md` still matches its recorded hash. Locally modified and unsigned directories are preserved and reported.

The CLI creates one link per managed skill, never replaces an existing user-owned skill, and removes links and canonical directories when the corresponding vault skill is deleted. On Windows it falls back to directory junctions when ordinary symlinks are unavailable.

Supported targets:

- `codex`, `t3`, and `agents` use the portable `~/.agents/skills` directory. Current Codex, T3 Code, Cursor, and OpenCode understand this Agent Skills location.
- `claude` uses `~/.claude/skills`.
- `cursor` explicitly uses `~/.cursor/skills` when that native path is preferred.
- `opencode` explicitly uses `~/.config/opencode/skills` when that native path is preferred.

`--targets all` selects the portable Agent Skills directory plus Claude. This covers every supported tool without making Cursor or OpenCode discover duplicate copies.

`skills install-codex` and `skills update-codex` remain compatibility aliases for the portable Codex/T3 target. A supplied legacy `--dir` is treated as a custom linked target.

### Background synchronization and CLI updates

`setup` registers a per-user service through systemd on Linux, a LaunchAgent on macOS, or Task Scheduler on Windows. The daemon subscribes to vault skill metadata so approved edits and deletions are applied promptly; the configured interval (one minute by default) is also a reconnect/fallback window. It does not expose credentials or run as root.

The daemon checks once per day for a new CLI and runs the same safe updater exposed as `whagons-dev --update`. The current updater uses the official Go module, so Go must remain installed and available on `PATH`. Disable background registration with `setup --no-startup`, disable automatic CLI updates with `setup --no-auto-update`, or remove the service with `startup remove`.

Environment overrides: `WHAGONS_DEV_API_KEY`, `WHAGONS_DEV_WS_URL`, `WHAGONS_DEV_PROJECT`, `WHAGONS_DEV_APP_URL`, `WHAGONS_DEV_CONFIG`, `WHAGONS_DEV_SKILLS_DIR` (the legacy `WHAGONS_SKILLS_*` names still work). Config from the old `whagons-skills` CLI at `~/.whagons-skills/config.json` is read automatically if the new path does not exist.

## Agent bootstrap

The UI has a **Copy agent setup** button in the API keys tab. It copies a self-contained handoff with installation and safe credential rules, but never embeds a live API key. Transfer a manually created key separately through a secure channel.
