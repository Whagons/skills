#!/usr/bin/env bash
# Drives the real, unmodified whagons-dev CLI against the Worker on synthetic
# data: migrate fixtures in, then credentials, skills, managed sync, the live
# daemon push, and logout revocation. Everything runs under a throwaway $HOME.
#
#   tools/e2e/cli-against-worker.sh --local
#       starts `wrangler dev` with a throwaway key and admin token
#   tools/e2e/cli-against-worker.sh --url https://skills-cf-dev-vault.<sub>.workers.dev --material FILE
#       uses a deployed dev Worker; FILE is from `migrate.mjs fixtures` and the
#       Worker's SKILLS_SECRET_KEY must be that file's key; VAULT_ADMIN_TOKEN must be set.
#
# Never point this at production: it replaces the vault's contents.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/vault-e2e.XXXXXX")"
pids=()
cleanup() { for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; rm -rf "$work"; }
trap cleanup EXIT
migrate() { node "$root/tools/migrate/migrate.mjs" "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "E2E FAILED: $*" >&2; exit 1; }

mode="${1:-}"
case "$mode" in
  --local)
    migrate fixtures "$work/export.json" "$work/material.json" >/dev/null
    export VAULT_ADMIN_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
    printf 'SKILLS_SECRET_KEY=%s\nADMIN_TOKEN=%s\nSKILLS_ALLOWED_EMAILS=owner@fixtures.invalid\n' \
      "$(jq -r .key "$work/material.json")" "$VAULT_ADMIN_TOKEN" > "$work/dev.vars"
    port="${E2E_PORT:-8791}"
    (cd "$root/worker" && exec npx wrangler dev --port "$port" --ip 127.0.0.1 --env-file "$work/dev.vars" --persist-to "$work/state" >"$work/wrangler.log" 2>&1) &
    pids+=($!)
    url="http://127.0.0.1:$port"
    for _ in $(seq 1 60); do curl -fsS "$url/health" >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS "$url/health" >/dev/null || { tail -20 "$work/wrangler.log"; fail "wrangler dev did not start"; }
    ;;
  --url)
    url="${2:?url}"; [ "${3:-}" = "--material" ] || fail "--material FILE is required with --url"
    cp "${4:?material file}" "$work/material.json"
    : "${VAULT_ADMIN_TOKEN:?set VAULT_ADMIN_TOKEN}"
    case "$url" in *skills-cf-dev-*|http://127.0.0.1:*|http://localhost:*) ;; *) fail "refusing non-dev URL $url";; esac
    node --input-type=module -e "
      import { generateGonvexExport } from '$root/tools/migrate/fixtures.mjs';
      import { readFileSync, writeFileSync } from 'node:fs';
      const m = JSON.parse(readFileSync('$work/material.json','utf8'));
      const f = await generateGonvexExport({ key: m.key });
      writeFileSync('$work/export.json', JSON.stringify(f.exportDoc), { mode: 0o600 });
      writeFileSync('$work/material.json', JSON.stringify({ key: m.key, apiKeys: f.apiKeys, sessions: f.sessions, secrets: f.secrets }), { mode: 0o600 });"
    ;;
  *) echo "usage: $0 --local | --url URL --material FILE" >&2; exit 2 ;;
esac
ws="${url/http/ws}/ws"

step "migrate synthetic Gonvex export into $url"
migrate transform "$work/export.json" "$work/bundle.json" --allow-plaintext
migrate import "$work/bundle.json" --url "$url" --replace
verify_out="$(migrate verify "$work/bundle.json" --url "$url")" || { echo "$verify_out"; fail "verify"; }
echo "$verify_out"
echo "$verify_out" | grep -q "credentials: 7/7 decrypt with the configured key; 0 need re-encryption; 0 failed" || fail "decrypt verification"

step "build the unmodified whagons-dev CLI"
(cd "$root/cli" && go build -buildvcs=false -o "$work/whagons-dev" ./cmd/whagons-dev)
export HOME="$work/home"; mkdir -p "$HOME"
export WHAGONS_DEV_WS_URL="$ws"
unset WHAGONS_DEV_API_KEY WHAGONS_SKILLS_API_KEY WHAGONS_DEV_CONFIG
cli() { "$work/whagons-dev" "$@"; }
owner_key="$(jq -r .apiKeys.skill_fixturekey_owner "$work/material.json")"

step "auth set-key (verifies the migrated key over the WebSocket)"
printf '%s' "$owner_key" | cli auth set-key --stdin
cli auth status

step "credentials list / exec (value compared by hash, never printed)"
[ "$(cli credentials list | wc -l)" -eq 7 ] || fail "expected 7 credentials"
cred_id="$(cli credentials list | awk -F'\t' '$1=="fixture-credential-0"{print $2}')"
expected="$(jq -r --arg id "$cred_id" '.secrets[$id]' "$work/material.json" | tr -d '\n' | sha256sum | cut -d' ' -f1)"
got="$(cli credentials exec fixture-credential-0 -- sh -c 'tr -d "\n" < "$WHAGONS_CREDENTIAL_FILE" | sha256sum | cut -d" " -f1')"
[ "$got" = "$expected" ] || fail "credentials exec delivered a different value"
printf '%s' '{"fixture":"e2e"}' | cli credentials set e2e-credential --summary "e2e" --value-stdin
cli credentials list | grep -q '^e2e-credential' || fail "credentials set"

step "skills list / get / update (managed skills under the throwaway HOME)"
[ "$(cli skills list | wc -l)" -eq 11 ] || fail "expected 11 published skills"
cli skills get fixture-skill-3 --output "$work/skill.md"
head -1 "$work/skill.md" | grep -q '^---$' || fail "skills get"
cli skills update
[ "$(find "$HOME/.whagons-dev/skills" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 11 ] || fail "managed skills not installed"

step "daemon receives a live push when a skill is published"
cli daemon --interval 60s --no-self-update >"$work/daemon.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 30); do grep -q "skills are current" "$work/daemon.log" && break; sleep 0.5; done
sleep 1
curl -fsS -X POST "$url/api/agent.skills.upload" -H "Authorization: Bearer $owner_key" -H 'content-type: application/json' \
  -d '{"name":"e2e-live-skill","summary":"live push","content":"---\nname: e2e-live-skill\ndescription: pushed\n---\n\n# Live\n","publish":true}' >/dev/null
for _ in $(seq 1 40); do [ -d "$HOME/.whagons-dev/skills/e2e-live-skill" ] && break; sleep 0.25; done
[ -d "$HOME/.whagons-dev/skills/e2e-live-skill" ] || { cat "$work/daemon.log"; fail "daemon did not apply the pushed skill"; }
grep -q "vault edit detected" "$work/daemon.log" || fail "daemon did not log the live push"
echo "daemon applied the pushed skill"

step "auth logout revokes the key server-side"
cli auth logout
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$url/api/agent.apiKeys.verify" -H "Authorization: Bearer $owner_key" -H 'content-type: application/json' -d '{}')"
[ "$code" = "401" ] || fail "key still valid after logout (HTTP $code)"

echo; echo "E2E OK against $url"
