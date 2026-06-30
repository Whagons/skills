# Whagons Skills Vault

Small Gonvex + React app for storing Whagons-specific skills and project credentials behind server-side password auth.

## Local Files

- `.env.local` contains the Gonvex runtime settings and project key.
- `.skills-vault-password` contains the generated local UI password.
- Both files are ignored by git.

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
SKILLS_PASSWORD_SALT=...
SKILLS_PASSWORD_HASH=...
```

The source tree intentionally does not contain the real password hash.

Seed local custom skills from `~/.codex/skills` and `~/.agents/skills`:

```bash
node scripts/seed-local-skills.mjs
```

Import selected local credentials into the vault without printing secret values:

```bash
node scripts/import-local-credentials.mjs
```

By default this imports `coolify-whagons`, `coolify-gabrielmalek`, `digitalocean`, `cloudflare`, and `cloudflare-r2-whagons-backups` from `~/.secrets/keys.json`. Override with:

```bash
SKILLS_CREDENTIAL_IMPORT_FILE=/path/to/keys.json \
SKILLS_CREDENTIAL_IMPORT_NAMES=coolify-whagons,cloudflare \
node scripts/import-local-credentials.mjs
```

## Auth Model

The UI password is verified by the Gonvex backend. A successful login stores a short-lived session token in browser session storage, and all UI mutations/queries require that session token.

Agents do not use the UI password. Create an API key in the UI, then call the agent functions:

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

Project credentials are stored in the `skill_credentials` table and are only returned through the agent credentials API with a valid API key. Do not print credential values in logs or chat.

## CLI

Install the Go CLI from a checkout:

```bash
cd cli
go install ./cmd/whagons-skills
```

After this repo is published, it can be installed with:

```bash
go install github.com/whagons/skills/cli/cmd/whagons-skills@latest
```

Authorize through the browser:

```bash
whagons-skills auth login --app-url http://127.0.0.1:5175/
```

The login command opens the vault in a browser. After unlocking, click **Authorize CLI**. The CLI stores the returned API key in `~/.whagons-skills/config.json` with file mode `0600`.

Common commands:

```bash
whagons-skills skills list
whagons-skills skills get whagons-monitor --output ./SKILL.md
whagons-skills skills upload ./my-skill/SKILL.md
whagons-skills skills sync ./skills

whagons-skills credentials list
printf '%s' "$SECRET_JSON" | whagons-skills credentials set coolify-whagons --summary "Coolify token" --value-stdin
whagons-skills credentials exec coolify-whagons -- node ./scripts/deploy.mjs
```

`credentials exec` fetches the credential, converts it into environment variables for the child process, and does not print the secret value.
