#!/bin/sh
# Opt-in one-selected-message summary. NOT --demo. NOT the official app.
#
# Isolation is the same as `npm start`: Mailspring-dev (userData, Crashpad,
# Mailspring-dev Safe Storage). This script never passes --user-data-dir,
# never copies ~/Library/Application Support/Mailspring/, never overwrites
# /Applications/Mailspring.app, and never sets MAILSPRING_DEMO=1.
#
# Yahoo in the official app stays there. If Mailspring-dev has no account,
# onboarding asks for a separate login — that is a remaining user step, not
# done by this script.
#
# Credentials: same dedicated DEMO Keychain item / KEY_FILE as the synthetic
# launcher. Names KEY/PAID are unset. This cloud agent does not read the key.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
KEY_FILE=${MAILSPRING_DEMO_GEMINI_KEY_FILE:-}
NS=${MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE:-}

if [ -n "$NS" ] && [ "$NS" != dummy ]; then
  echo "start-real-selected-summary: MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE must be unset or dummy." >&2
  exit 1
fi

if [ -n "${MAILSPRING_DEMO_GEMINI_API_KEY+x}" ] || [ -n "${MAILSPRING_DEMO_GEMINI_PAID+x}" ]; then
  echo "start-real-selected-summary: unsetting MAILSPRING_DEMO_GEMINI_API_KEY / MAILSPRING_DEMO_GEMINI_PAID from launcher environ (values not printed)" >&2
  if [ -n "$KEY_FILE" ]; then
    if [ "$NS" = dummy ]; then
      exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
        MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
        MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
        "$0" "$@"
    fi
    exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
      -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
      MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
      "$0" "$@"
  fi
  if [ "$NS" = dummy ]; then
    exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
      -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
      MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
      "$0" "$@"
  fi
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
    -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
    "$0" "$@"
fi

if [ -n "$KEY_FILE" ]; then
  case "$KEY_FILE" in
    /*) ;;
    *)
      echo "start-real-selected-summary: MAILSPRING_DEMO_GEMINI_KEY_FILE must be an absolute path." >&2
      exit 1
      ;;
  esac
  if [ ! -f "$KEY_FILE" ]; then
    echo "start-real-selected-summary: KEY_FILE is not a readable file." >&2
    exit 1
  fi
fi

UNAME=$(uname -s)
if [ "$UNAME" = Darwin ]; then
  ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  HELPER="$ROOT/app/native/gemini-demo-keychain/gemini-demo-keychain"
  if [ -z "$KEY_FILE" ] && [ ! -x "$HELPER" ]; then
    echo "start-real-selected-summary: Keychain helper missing. One-time: sh scripts/gemini-demo-keychain.sh save" >&2
  fi
else
  ELECTRON="$ROOT/node_modules/electron/dist/electron"
fi

if [ ! -x "$ELECTRON" ]; then
  echo "start-real-selected-summary: missing Electron binary (install node_modules/electron)." >&2
  exit 1
fi

echo "start-real-selected-summary: Mailspring-dev only. Official /Applications/Mailspring.app is unused." >&2
echo "start-real-selected-summary: Do not copy production profile/Keychain. Yahoo login in this profile is a separate remaining user step if Mailspring-dev has no account." >&2

# Never --demo. Never --user-data-dir pointing at production Mailspring/.
if [ -n "$KEY_FILE" ]; then
  if [ "$NS" = dummy ]; then
    exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
      MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
      MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
      "$ELECTRON" "$ROOT/app" --enable-logging --dev --real-selected-summary "$@"
  fi
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
    MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
    "$ELECTRON" "$ROOT/app" --enable-logging --dev --real-selected-summary "$@"
fi

if [ "$NS" = dummy ]; then
  echo "start-real-selected-summary: dummy Keychain namespace (isolated test item)" >&2
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
    MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
    "$ELECTRON" "$ROOT/app" --enable-logging --dev --real-selected-summary "$@"
fi

exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
  -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
  -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
  "$ELECTRON" "$ROOT/app" --enable-logging --dev --real-selected-summary "$@"
