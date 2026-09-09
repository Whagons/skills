#!/usr/bin/env bash
set -euo pipefail
# Compile against the same Gonvex checkout used for the runtime.
: "${GONVEX_SOURCE_ROOT:?Set GONVEX_SOURCE_ROOT to a Gonvex checkout}"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export TEST_BACKEND_DIR="$test_dir"
python3 - <<'PY'
import json, os, pathlib
root = pathlib.Path(os.environ['GONVEX_SOURCE_ROOT']).resolve()
path = pathlib.Path(os.environ['TEST_BACKEND_DIR'])
(path / 'go.mod').write_text('module skills-backend-tests\n\ngo 1.26\n\nrequire github.com/gonvex/gonvex v0.0.0\nreplace github.com/gonvex/gonvex => ' + json.dumps(str(root)) + '\n')
PY
for file in "$repo_dir"/gonvex/*.go "$repo_dir"/tests/backend/*_test.go; do ln -s "$file" "$test_dir/$(basename "$file")"; done
cd "$test_dir"
go test -mod=mod -count=1 -v ./...
