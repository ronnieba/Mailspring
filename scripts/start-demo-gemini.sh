#!/bin/sh
# DEMO Gemini launcher. Exec the real Electron binary with credential names
# unset so neither this launcher nor Electron main is started with
# MAILSPRING_DEMO_GEMINI_API_KEY / MAILSPRING_DEMO_GEMINI_PAID in OS environ.
#
# Native 33d7f263: `node ./node_modules/.bin/electron` plus JS delete of
# process.env left those names on the Node launcher and Electron main
# exec-time environ (macOS `ps eww`). This script does not use the Node
# shim. It does not print file contents, argv secrets, or env values.
#
# Parent: CopyFromBox (or equivalent) into a 0600 file outside the repo and
# profile whose path does not contain the key or public marker, then:
#   unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID
#   export MAILSPRING_DEMO_GEMINI_KEY_FILE=/absolute/path/to/0600-file
#   sh scripts/start-demo-gemini.sh --force-renderer-accessibility
#
# File format (first line paid ack, remainder the key):
#   paid=0
#   <key>
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
KEY_FILE=${MAILSPRING_DEMO_GEMINI_KEY_FILE:-}

if [ -z "$KEY_FILE" ]; then
  echo "start-demo-gemini: set MAILSPRING_DEMO_GEMINI_KEY_FILE to an absolute 0600 credential file (first line paid=0|1). Do not export MAILSPRING_DEMO_GEMINI_API_KEY or MAILSPRING_DEMO_GEMINI_PAID." >&2
  exit 1
fi

case "$KEY_FILE" in
  /*) ;;
  *)
    echo "start-demo-gemini: MAILSPRING_DEMO_GEMINI_KEY_FILE must be an absolute path." >&2
    exit 1
    ;;
esac

if [ ! -f "$KEY_FILE" ]; then
  echo "start-demo-gemini: KEY_FILE is not a readable file." >&2
  exit 1
fi

# If this process inherited the secret names, replace the process image so
# the running launcher environ is not the original exec snapshot.
if [ -n "${MAILSPRING_DEMO_GEMINI_API_KEY+x}" ] || [ -n "${MAILSPRING_DEMO_GEMINI_PAID+x}" ]; then
  echo "start-demo-gemini: unsetting MAILSPRING_DEMO_GEMINI_API_KEY / MAILSPRING_DEMO_GEMINI_PAID from launcher environ (values not printed)" >&2
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
    "$0" "$@"
fi

UNAME=$(uname -s)
if [ "$UNAME" = Darwin ]; then
  ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else
  ELECTRON="$ROOT/node_modules/electron/dist/electron"
fi

if [ ! -x "$ELECTRON" ]; then
  echo "start-demo-gemini: missing Electron binary (install node_modules/electron)." >&2
  exit 1
fi

# KEY_FILE is a path, not the secret. KEY/PAID names stay unset.
exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
  MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
  "$ELECTRON" "$ROOT/app" --enable-logging --dev --demo "$@"
