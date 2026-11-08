#!/bin/sh
# DEMO Gemini launcher. Usual path: no KEY_FILE — Electron main loads the
# dedicated demo Keychain item via app/native/gemini-demo-keychain (SecItem*,
# secret on helper stdin at save time, never on argv).
#
# Exec the real Electron binary with credential names unset so neither this
# launcher nor Electron main is started with MAILSPRING_DEMO_GEMINI_API_KEY
# or MAILSPRING_DEMO_GEMINI_PAID in OS environ.
#
# Native 33d7f263: `node ./node_modules/.bin/electron` plus JS delete of
# process.env left those names on the Node launcher and Electron main
# exec-time environ (macOS `ps eww`). This script does not use the Node
# shim. It does not print file contents, argv secrets, or env values.
#
# One-time local save (hidden Terminal prompt; not this cloud agent):
#   unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID MAILSPRING_DEMO_GEMINI_KEY_FILE
#   sh scripts/gemini-demo-keychain.sh save
#   sh scripts/start-demo-gemini.sh
#
# Explicit KEY_FILE fallback (0600 file, first line paid=0|1, remainder the key):
#   export MAILSPRING_DEMO_GEMINI_KEY_FILE=/absolute/path/to/0600-file
#   sh scripts/start-demo-gemini.sh
#
# Replace / remove the Keychain item:
#   sh scripts/gemini-demo-keychain.sh replace
#   sh scripts/gemini-demo-keychain.sh remove
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
KEY_FILE=${MAILSPRING_DEMO_GEMINI_KEY_FILE:-}

# If this process inherited the secret names, replace the process image so
# the running launcher environ is not the original exec snapshot.
if [ -n "${MAILSPRING_DEMO_GEMINI_API_KEY+x}" ] || [ -n "${MAILSPRING_DEMO_GEMINI_PAID+x}" ]; then
  echo "start-demo-gemini: unsetting MAILSPRING_DEMO_GEMINI_API_KEY / MAILSPRING_DEMO_GEMINI_PAID from launcher environ (values not printed)" >&2
  if [ -n "$KEY_FILE" ]; then
    exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
      MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
      "$0" "$@"
  fi
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
    "$0" "$@"
fi

if [ -n "$KEY_FILE" ]; then
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
fi

UNAME=$(uname -s)
if [ "$UNAME" = Darwin ]; then
  ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  HELPER="$ROOT/app/native/gemini-demo-keychain/gemini-demo-keychain"
  if [ -z "$KEY_FILE" ] && [ ! -x "$HELPER" ]; then
    echo "start-demo-gemini: Keychain helper missing. One-time: sh scripts/gemini-demo-keychain.sh save" >&2
  fi
else
  ELECTRON="$ROOT/node_modules/electron/dist/electron"
fi

if [ ! -x "$ELECTRON" ]; then
  echo "start-demo-gemini: missing Electron binary (install node_modules/electron)." >&2
  exit 1
fi

# KEY_FILE is a path, not the secret. Usual launch unsets it so main uses Keychain.
if [ -n "$KEY_FILE" ]; then
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
    "$ELECTRON" "$ROOT/app" --enable-logging --dev --demo "$@"
fi

exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
  -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
  "$ELECTRON" "$ROOT/app" --enable-logging --dev --demo "$@"
