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

— or export `WHAGONS_DEV_API_KEY=skv_...` for ephemeral use. Agents cannot mint keys themselves; a human creates them in a Google-verified session and hands them over.

## Team workspaces

All data (skills, credentials, API keys) belongs to a **workspace**, owned by the Google account that created it. From the **Team** tab in the UI, the workspace owner can invite other Google emails. Invited members:

- sign in with their own Google account (no env-var whitelist changes needed),
- see and manage all skills, credentials, and API keys in the owner's workspace,
- lose access immediately when removed (their active sessions are revoked).

Login is allowed for accounts that are either invited members or covered by the runtime allowlist:

```bash
SKILLS_ALLOWED_EMAILS=you@example.com,teammate@example.com
SKILLS_ALLOWED_DOMAINS=whagons.com
SKILLS_LEGACY_OWNER_EMAIL=you@example.com
```

If neither `SKILLS_ALLOWED_EMAILS` nor `SKILLS_ALLOWED_DOMAINS` is set, only `malek.gabriel33@gmail.com` can own a workspace. `SKILLS_LEGACY_OWNER_EMAIL` claims pre-owner-migration rows for that Google user only. If an account is both invited *and* allowlisted, the invite wins — they join the inviter's workspace.

## Local development

- `.env.local` contains the Gonvex runtime settings and project key. It is ignored by git.

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

Agents do not use Google directly. They use an API key (created in the UI or via the CLI browser flow) and call the agent functions:

- `agent.skills.list` / `get` / `upload` / `delete` (lists are metadata-only; `get` returns content)
- `agent.apiKeys.list` / `revoke`
- `agent.credentials.list` / `get` / `save` / `delete`

There is deliberately no `agent.apiKeys.create`: a leaked API key cannot mint replacement keys that survive its own revocation. New keys only come from a Google-verified session (UI or CLI browser flow).

A session or API key can only read and mutate rows in its own workspace. Credential values are only returned through `agent.credentials.get` / `credentials.get` — never in lists. Do not print credential values in logs or chat.

### Encryption at rest

Set a 32-byte `SKILLS_SECRET_KEY` (hex, base64, or any passphrase — passphrases are SHA-256-stretched) on the Gonvex runtime to encrypt credential values with AES-256-GCM before they hit the database. Existing plaintext rows stay readable and are re-encrypted the next time they are saved. Without the key, values are stored as plaintext (previous behavior).

### CLI authorization flow

`whagons-dev` starts a loopback HTTP server on `127.0.0.1`, opens the vault with `?cli_callback=...&cli_state=...`, and waits. After Google login the UI validates that the callback is a loopback address (non-local callbacks are refused and shown as blocked), mints a workspace API key, and POSTs it to the CLI — the key never appears in a URL or browser history. Old CLI builds that only support the GET redirect still work as a fallback.

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

`credentials exec` fetches the credential, converts it into environment variables for the child process (`COOLIFY_WHAGONS_JSON`, flattened fields, or `<NAME>_VALUE` for plain strings), and does not print the secret value.

`skills install-codex` / `update-codex` write cloud skills to `~/.codex/skills/whagons/<skill-name>/SKILL.md` by default; override with `--dir`.

Environment overrides: `WHAGONS_DEV_API_KEY`, `WHAGONS_DEV_WS_URL`, `WHAGONS_DEV_PROJECT`, `WHAGONS_DEV_APP_URL`, `WHAGONS_DEV_CONFIG` (the legacy `WHAGONS_SKILLS_*` names still work). Config from the old `whagons-skills` CLI at `~/.whagons-skills/config.json` is read automatically if the new path does not exist.

## Agent bootstrap

The UI has a **Copy agent setup** button in the API keys tab. It copies a self-contained handoff: the `go install` command, the two-command plug-and-play setup, safe credential usage rules, and (optionally) a fresh API key for headless use. Paste it into Codex or another agent.
