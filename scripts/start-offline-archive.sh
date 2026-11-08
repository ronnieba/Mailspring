#!/bin/sh
# Disconnected local-archive reader. NOT --demo. NOT live Yahoo.
# NOT the official app. skipMailsync + Mailspring-offline + mock keychain.
#
# Requires an absolute --offline-archive-path to an immutable .eml / Maildir /
# mbox tree. Never copies ~/Library/Application Support/Mailspring/, never
# points --user-data-dir at the official profile, never sets MAILSPRING_DEMO=1.
#
# Gemini (if a key is already saved) is explicit one-selected-message only.
# Names KEY/PAID are unset. This cloud agent does not read the key.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
KEY_FILE=${MAILSPRING_DEMO_GEMINI_KEY_FILE:-}
NS=${MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE:-}
ARCHIVE_PATH=${MAILSPRING_OFFLINE_ARCHIVE_PATH:-}

usage() {
  echo "start-offline-archive: pass an absolute archive directory." >&2
  echo "  sh scripts/start-offline-archive.sh /absolute/path/to/eml-or-maildir" >&2
  echo "Acquisition from Yahoo is a remaining native gate (EXAMINE / BODY.PEEK)." >&2
  echo "This launcher does not connect to Yahoo and does not copy the official profile." >&2
}

for arg in "$@"; do
  case "$arg" in
    --offline-archive-path=*)
      ARCHIVE_PATH=${arg#--offline-archive-path=}
      ;;
    --help|-h)
      usage
      exit 2
      ;;
    --)
      break
      ;;
    -*)
      ;;
    *)
      if [ -z "$ARCHIVE_PATH" ]; then
        ARCHIVE_PATH=$arg
      fi
      ;;
  esac
done

if [ -z "$ARCHIVE_PATH" ]; then
  usage
  exit 2
fi

case "$ARCHIVE_PATH" in
  /*) ;;
  *)
    echo "start-offline-archive: archive path must be absolute." >&2
    exit 1
    ;;
esac

case "$ARCHIVE_PATH" in
  */Application\ Support/Mailspring|*/Application\ Support/Mailspring/*|*/Mailspring/edgehill.db|*/Mailspring/config.json)
    echo "start-offline-archive: refuses official Mailspring profile/cache (not a complete backup)." >&2
    exit 1
    ;;
esac

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "start-offline-archive: archive path is not a directory." >&2
  exit 1
fi

if [ -n "$NS" ] && [ "$NS" != dummy ]; then
  echo "start-offline-archive: MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE must be unset or dummy." >&2
  exit 1
fi

if [ -n "${MAILSPRING_DEMO_GEMINI_API_KEY+x}" ] || [ -n "${MAILSPRING_DEMO_GEMINI_PAID+x}" ]; then
  echo "start-offline-archive: unsetting MAILSPRING_DEMO_GEMINI_API_KEY / MAILSPRING_DEMO_GEMINI_PAID from launcher environ (values not printed)" >&2
  if [ -n "$KEY_FILE" ]; then
    if [ "$NS" = dummy ]; then
      exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
        MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
        MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
        MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
        "$0" "$@"
    fi
    exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
      -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
      MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
      MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
      "$0" "$@"
  fi
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
    -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
    MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
    "$0" "$@"
fi

if [ -n "$KEY_FILE" ]; then
  case "$KEY_FILE" in
    /*) ;;
    *)
      echo "start-offline-archive: MAILSPRING_DEMO_GEMINI_KEY_FILE must be an absolute path." >&2
      exit 1
      ;;
  esac
  if [ ! -f "$KEY_FILE" ]; then
    echo "start-offline-archive: KEY_FILE is not a readable file." >&2
    exit 1
  fi
fi

UNAME=$(uname -s)
if [ "$UNAME" = Darwin ]; then
  ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  HELPER="$ROOT/app/native/gemini-demo-keychain/gemini-demo-keychain"
  if [ -z "$KEY_FILE" ] && [ ! -x "$HELPER" ]; then
    echo "start-offline-archive: Keychain helper missing. Optional: sh scripts/gemini-demo-keychain.sh save" >&2
  fi
else
  ELECTRON="$ROOT/node_modules/electron/dist/electron"
fi

if [ ! -x "$ELECTRON" ]; then
  echo "start-offline-archive: missing Electron binary (install node_modules/electron)." >&2
  exit 1
fi

echo "start-offline-archive: Mailspring-offline only. Official /Applications/Mailspring.app is unused." >&2
echo "start-offline-archive: skipMailsync. Yahoo IMAP is not opened. Do not copy production profile/Keychain." >&2
echo "start-offline-archive: Gemini is explicit Summarize of one local message, not bulk upload." >&2

# Never --demo. Never --user-data-dir pointing at production Mailspring/.
# Never --real-selected-summary (live Yahoo).
if [ -n "$KEY_FILE" ]; then
  if [ "$NS" = dummy ]; then
    exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
      MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
      MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
      MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
      "$ELECTRON" "$ROOT/app" --enable-logging --dev --offline-archive \
      --offline-archive-path="$ARCHIVE_PATH"
  fi
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
    MAILSPRING_DEMO_GEMINI_KEY_FILE="$KEY_FILE" \
    MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
    "$ELECTRON" "$ROOT/app" --enable-logging --dev --offline-archive \
    --offline-archive-path="$ARCHIVE_PATH"
fi

if [ "$NS" = dummy ]; then
  echo "start-offline-archive: dummy Keychain namespace (isolated test item)" >&2
  exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
    -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
    MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy \
    MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
    "$ELECTRON" "$ROOT/app" --enable-logging --dev --offline-archive \
    --offline-archive-path="$ARCHIVE_PATH"
fi

exec env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID \
  -u MAILSPRING_DEMO_GEMINI_KEY_FILE \
  -u MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE \
  MAILSPRING_OFFLINE_ARCHIVE_PATH="$ARCHIVE_PATH" \
  "$ELECTRON" "$ROOT/app" --enable-logging --dev --offline-archive \
  --offline-archive-path="$ARCHIVE_PATH"
