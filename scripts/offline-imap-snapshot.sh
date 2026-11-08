#!/bin/sh
# Read-only Yahoo IMAP snapshot. EXAMINE + BODY.PEEK only.
# Password is never on argv/env. Default (no args) does not connect.
#
# Official Mailspring folder export (GetManyRFC2822Task) is NOT this backup.
# Do not copy ~/Library/Application Support/Mailspring/.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -n "${YAHOO_IMAP_PASSWORD+x}" ] || [ -n "${IMAP_PASSWORD+x}" ] || [ -n "${MAILSPRING_IMAP_PASSWORD+x}" ]; then
  echo "offline-imap-snapshot: REFUSES password from environment. Unset it; use a hidden prompt." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "offline-imap-snapshot: REFUSES to connect with no arguments." >&2
  echo "  --preflight-only --username EMAIL" >&2
  echo "  --execute --dest /abs/archive --username EMAIL [--work-copy /abs/work]" >&2
  echo "  Fake tests: --insecure-test-server --host 127.0.0.1 --port N --secret-from-stdin" >&2
  echo "Yahoo TLS imap.mail.yahoo.com:993, EXAMINE / BODY.PEEK[], never STORE/SELECT." >&2
  echo "exit 2" >&2
  exit 2
fi

for arg in "$@"; do
  case "$arg" in
    --password|--password=*|--imap-password|--imap-password=*|-p)
      echo "offline-imap-snapshot: REFUSES --password on argv." >&2
      exit 1
      ;;
  esac
done

cd "$ROOT"
exec npx --yes ts-node --project "$ROOT/app/tsconfig.json" "$ROOT/app/src/offline-snapshot/cli.ts" "$@"
