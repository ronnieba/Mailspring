#!/usr/bin/env bash
# Private local Hunspell WASM install. Does NOT touch app/package-lock.json.
# dictionary-he aff/dic are AGPL-3.0 — never commit node_modules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ "$(basename "$ROOT")" != "offline-prototype" ]]; then
  echo "ERROR: refusing to run npm outside sidecar ($ROOT). Aborting." >&2
  exit 1
fi

APP_LOCK="$(cd "$ROOT/../../.." && pwd)/package-lock.json"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

HASH_BEFORE=""
if [[ -f "$APP_LOCK" ]]; then
  HASH_BEFORE="$(hash_file "$APP_LOCK")"
  echo "Sidecar-only install. app/package-lock.json hash before: $HASH_BEFORE"
  echo "Will not write $APP_LOCK (npm --prefix sidecar --no-package-lock)."
fi

if [[ -d "$ROOT/node_modules/nspell" ]]; then
  echo "Removing leftover nspell (rejected: eager PFX expansion stalled 7c346435)."
  rm -rf "$ROOT/node_modules/nspell"
fi

echo "Installing hunspell-asm@4.0.2 dictionary-en@4.0.0 dictionary-he@2.0.0 into:"
echo "  $ROOT"
echo "AGPL-3.0 Hebrew aff/dic stay here for private evaluation only."
npm install --prefix "$ROOT" --no-package-lock --ignore-scripts

if [[ -n "$HASH_BEFORE" ]]; then
  HASH_AFTER="$(hash_file "$APP_LOCK")"
  if [[ "$HASH_BEFORE" != "$HASH_AFTER" ]]; then
    echo "ERROR: app/package-lock.json changed ($HASH_BEFORE -> $HASH_AFTER). Aborting." >&2
    exit 1
  fi
  echo "app/package-lock.json unchanged: $HASH_AFTER"
fi

test -f "$ROOT/node_modules/dictionary-he/index.aff"
test -f "$ROOT/node_modules/dictionary-he/index.dic"
test -f "$ROOT/node_modules/dictionary-en/index.aff"
test -f "$ROOT/node_modules/hunspell-asm/package.json"
if [[ -d "$ROOT/node_modules/nspell" ]]; then
  echo "ERROR: nspell must not be installed (rejected engine)." >&2
  exit 1
fi
echo "OK. Do not git-add node_modules. Do not publish this folder."
