# Whagons Skills Vault

Gonvex + React app at https://skills.whagons.com for storing Whagons-specific agent skills and project credentials behind server-verified Google login, with a plug-and-play CLI (`whagons-dev`) for agents.

## Quick start for agents (plug and play)

```bash
go install github.com/whagons/skills/cli/cmd/whagons-dev@latest
whagons-dev skills install-codex
```

That's it. On first use the CLI opens https://skills.whagons.com in the browser; sign in with Google, click **Authorize CLI**, and the CLI saves its own API key to `~/.whagons-dev/config.json` (mode `0600`). Every later command just works:

```bash
whagons-dev skills update-codex                                  # refresh local skills
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

## Auth model

The UI uses Google Identity Services. The browser sends a Google ID token to the Gonvex backend, which verifies it against `https://oauth2.googleapis.com/tokeninfo` (audience, verified email) before creating a session. Sessions store both who logged in and which workspace they access; invited members resolve to the inviter's workspace.

Google-only: there is no password login.

Agents do not use Google directly. They use a scoped API key created in the UI or via the CLI browser flow. UI-created keys can expire after 7, 30, or 90 days, or explicitly be created without an expiration; CLI browser-flow keys expire after 30 days. Agents call these functions:

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

`whagons-dev` starts a loopback HTTP server on `127.0.0.1`, opens the vault with `?cli_callback=...&cli_state=...`, and waits. After Google login the UI validates the exact callback shape, mints a 30-day CLI key, and sends a state-bound JSON `POST`. The listener permits only the exact vault origin and the key never appears in a URL or browser history. If delivery or key verification fails, the new key is revoked or discarded.

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
whagons-dev auth login [--app-url https://skills.whagons.com/]
printf '%s' "$KEY" | whagons-dev auth set-key --stdin
whagons-dev auth status
whagons-dev auth logout

whagons-dev skills list
whagons-dev skills get whagons-monitor --output ./SKILL.md
whagons-dev skills copy whagons-monitor
whagons-dev skills upload ./my-skill/SKILL.md
whagons-dev skills sync ./skills
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

`skills install-codex` / `update-codex` write cloud skills to `~/.codex/skills/whagons/<skill-name>/SKILL.md` by default; override with `--dir`.

Environment overrides: `WHAGONS_DEV_API_KEY`, `WHAGONS_DEV_WS_URL`, `WHAGONS_DEV_PROJECT`, `WHAGONS_DEV_APP_URL`, `WHAGONS_DEV_CONFIG` (the legacy `WHAGONS_SKILLS_*` names still work). Config from the old `whagons-skills` CLI at `~/.whagons-skills/config.json` is read automatically if the new path does not exist.

## Agent bootstrap

The UI has a **Copy agent setup** button in the API keys tab. It copies a self-contained handoff with installation and safe credential rules, but never embeds a live API key. Transfer a manually created key separately through a secure channel.
