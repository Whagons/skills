# Whagons Skills Vault

Small Gonvex + React app for storing Whagons-specific skills and project credentials behind server-verified Google login.

## Local Files

- `.env.local` contains the Gonvex runtime settings and project key.
- It is ignored by git.

## Commands

```bash
npm install
npm run build
npm run gonvex:once
npm run dev
```

Run on the requested local port:

```bash
npm run vite -- --host 127.0.0.1 --port 5175 --strictPort
```

`npm run gonvex:once` syncs `gonvex/*.go` and schema metadata to the configured Gonvex runtime.

Before syncing/deploying the backend, configure these runtime environment variables:

```bash
SKILLS_ALLOWED_EMAILS=you@example.com,teammate@example.com
SKILLS_ALLOWED_DOMAINS=whagons.com
SKILLS_LEGACY_OWNER_EMAIL=you@example.com
```

`SKILLS_GOOGLE_CLIENT_ID` is optional because the Whagons web client id is the built-in default. If neither `SKILLS_ALLOWED_EMAILS` nor `SKILLS_ALLOWED_DOMAINS` is set, the vault only allows `malek.gabriel33@gmail.com`. `SKILLS_LEGACY_OWNER_EMAIL` claims pre-owner-migration rows for that Google user only.

Configure the frontend with the same Google OAuth client id:

```bash
VITE_GOOGLE_CLIENT_ID=...
```

Seed local custom skills from `~/.codex/skills` and `~/.agents/skills`:

```bash
WHAGONS_SKILLS_API_KEY=skv_... \
node scripts/seed-local-skills.mjs
```

Import selected local credentials into the vault without printing secret values:

```bash
WHAGONS_SKILLS_API_KEY=skv_... \
node scripts/import-local-credentials.mjs
```

By default this imports `coolify-whagons`, `coolify-gabrielmalek`, `digitalocean`, `cloudflare`, and `cloudflare-r2-whagons-backups` from `~/.secrets/keys.json`. Override with:

```bash
SKILLS_CREDENTIAL_IMPORT_FILE=/path/to/keys.json \
SKILLS_CREDENTIAL_IMPORT_NAMES=coolify-whagons,cloudflare \
WHAGONS_SKILLS_API_KEY=skv_... \
node scripts/import-local-credentials.mjs
```

## Auth Model

The UI uses Google Identity Services. The browser sends a Google ID token to the Gonvex backend, and the backend verifies it against `https://oauth2.googleapis.com/tokeninfo` before creating a session. A successful login stores a short-lived session token in browser session storage.

All skills, API keys, sessions, and credentials are scoped by `owner_id`, derived from the verified Google `sub`. A session or API key can only read and mutate rows for its owner.

Agents do not use Google directly. Create or authorize an API key in the UI, then call the agent functions:

- `agent.skills.list`
- `agent.skills.get`
- `agent.skills.upload`
- `agent.skills.delete`
- `agent.apiKeys.list`
- `agent.apiKeys.create`
- `agent.apiKeys.revoke`
- `agent.credentials.list`
- `agent.credentials.get`
- `agent.credentials.save`
- `agent.credentials.delete`

Project credentials are stored in the `skill_credentials` table and are only returned through the agent credentials API with a valid API key owned by the same Google user. Do not print credential values in logs or chat.

## CLI

Install the Go CLI from a checkout:

```bash
cd cli
go install ./cmd/whagons-skills
```

Install directly:

```bash
go install github.com/whagons/skills/cli/cmd/whagons-skills@latest
```

Authorize through the browser:

```bash
whagons-skills auth login --app-url https://skills.whagons.com/
```

The login command opens the vault in a browser. After Google login, click **Authorize CLI**. The CLI stores the returned API key in `~/.whagons-skills/config.json` with file mode `0600`.

Common commands:

```bash
whagons-skills skills list
whagons-skills skills get whagons-monitor --output ./SKILL.md
whagons-skills skills upload ./my-skill/SKILL.md
whagons-skills skills sync ./skills
whagons-skills skills install-codex
whagons-skills skills update-codex

whagons-skills credentials list
printf '%s' "$SECRET_JSON" | whagons-skills credentials set coolify-whagons --summary "Coolify token" --value-stdin
whagons-skills credentials exec coolify-whagons -- node ./scripts/deploy.mjs
```

`credentials exec` fetches the credential, converts it into environment variables for the child process, and does not print the secret value.

`skills install-codex` and `skills update-codex` write cloud skills to `~/.codex/skills/whagons/<skill-name>/SKILL.md` by default. Override with:

```bash
whagons-skills skills install-codex --dir /path/to/codex/skills
```

## Agent Bootstrap

The UI has a **Copy agent setup** button in the API keys tab. It copies:

- the `go install` command for the CLI
- the browser auth command
- the Codex skill install/update command
- safe credential usage instructions

Paste that into Codex or another agent. The agent should authenticate through the browser flow, install/update local Codex skills with the CLI, and use `credentials exec` instead of printing secrets.
