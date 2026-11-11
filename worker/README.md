# Skills Vault Worker

The serverless backend and host for the vault UI: one Worker, one SQLite Durable
Object, and one R2 bucket. Design, security model, migration and cutover are in
[`docs/cloudflare/DESIGN.md`](../docs/cloudflare/DESIGN.md).

```
src/index.ts      routing, security headers, JSON API, admin gate, cron backup
src/vault.ts      Durable Object: serialized calls, WebSocket protocol, live queries, admin ops
src/functions.ts  every vault function (ported from gonvex/*.go, same paths and errors)
src/context.ts    sessions, API keys, roles, per-item grants
src/crypto.ts     encv2/encv1 credential encryption (byte-compatible with Go)
src/schema.ts     SQLite migrations
```

## Develop and test

```bash
pnpm install --frozen-lockfile && (cd .. && pnpm install --frozen-lockfile)
pnpm run build:assets                                   # UI built with --mode cloudflare
npx wrangler types --env-interface CloudflareBindings
pnpm run typecheck && pnpm test                         # tests run inside workerd
node --test ../tools/migrate/migrate.test.mjs
node ../tools/crosscheck/crosscheck.mjs                 # needs Go
../tools/e2e/cli-against-worker.sh --local              # real whagons-dev against wrangler dev
```

Point an existing CLI at any Worker with `WHAGONS_DEV_WS_URL=wss://<host>/ws`.
The CLI itself needs no change.

## Dev deployment (`skills-cf-dev-*`, synthetic data only)

```bash
DIR=$(mktemp -d)   # outside the repo
node tools/migrate/migrate.mjs fixtures "$DIR/export.json" "$DIR/material.json"
openssl rand -hex 32 > "$DIR/admin-token"
whagons-dev credentials exec full-cloudflare-access -- worker/scripts/deploy-dev.sh "$DIR"
VAULT_ADMIN_TOKEN=$(cat "$DIR/admin-token") tools/e2e/cli-against-worker.sh \
  --url https://skills-cf-dev-vault.whagons-international.workers.dev --material "$DIR/material.json"
```

The dev Worker's `SKILLS_SECRET_KEY` is the fixture key, so it can never
decrypt real data. Delete `ADMIN_TOKEN` when you are done
(`wrangler secret delete ADMIN_TOKEN --env dev`).

The top-level `wrangler.jsonc` environment is production (`skills-vault`).
Nothing in this repo deploys it.
