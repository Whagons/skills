#!/usr/bin/env bash
# Deploys the DEV Worker (skills-cf-dev-vault + R2 skills-cf-dev-blobs) with a
# throwaway encryption key. It never touches the production Worker.
#
#   node tools/migrate/migrate.mjs fixtures "$DIR/export.json" "$DIR/material.json"
#   openssl rand -hex 32 > "$DIR/admin-token"
#   whagons-dev credentials exec full-cloudflare-access -- worker/scripts/deploy-dev.sh "$DIR"
#
# $DIR must live outside the repository. Its material.json key becomes the dev
# SKILLS_SECRET_KEY, so only fixture data can ever be decrypted there.
set -euo pipefail
cred="${WHAGONS_CREDENTIAL_FILE:?run through: whagons-dev credentials exec full-cloudflare-access -- $0 DIR}"
dir="${1:?material directory}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(cd "$dir" && pwd)" in "$root"*) echo "material directory must be outside the repository" >&2; exit 2;; esac
CLOUDFLARE_ACCOUNT_ID="$(jq -r .accountId "$cred")"
CLOUDFLARE_API_TOKEN="$(jq -r .apiToken "$cred")"
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
cd "$root/worker"
wr() { npx --no-install wrangler "$@"; }

wr r2 bucket create skills-cf-dev-blobs 2>&1 | grep -v -i 'already exists' || true
wr r2 bucket lifecycle add skills-cf-dev-blobs backups-expire backups/ --expire-days 35 --force >/dev/null 2>&1 || true
npm run --silent build:assets >/dev/null
wr deploy --env dev
jq -r .key "$dir/material.json" | tr -d '\n' | wr secret put SKILLS_SECRET_KEY --env dev >/dev/null
tr -d '\n' < "$dir/admin-token" | wr secret put ADMIN_TOKEN --env dev >/dev/null
echo "dev Worker deployed with secrets SKILLS_SECRET_KEY (fixture key) and ADMIN_TOKEN"
