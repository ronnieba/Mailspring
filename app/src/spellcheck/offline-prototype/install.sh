#!/usr/bin/env bash
# Private local install. Does NOT touch app/package-lock.json.
# dictionary-he aff/dic are AGPL-3.0 — never commit node_modules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [[ -f "$ROOT/../../../package-lock.json" ]]; then
  echo "Refusing to run from a path that would confuse npm with app/package-lock.json" >&2
fi
echo "Installing nspell@2.1.5 dictionary-en@4.0.0 dictionary-he@2.0.0 into:"
echo "  $ROOT"
echo "AGPL-3.0 Hebrew aff/dic stay here for private evaluation only."
npm install --package-lock-only=false --no-package-lock
test -f "$ROOT/node_modules/dictionary-he/index.aff"
test -f "$ROOT/node_modules/dictionary-he/index.dic"
test -f "$ROOT/node_modules/dictionary-en/index.aff"
test -f "$ROOT/node_modules/nspell/package.json"
echo "OK. Do not git-add node_modules. Do not publish this folder."
