#!/bin/sh
# DEMO Gemini Keychain setup. macOS only.
#
# Usual path after one save: sh scripts/start-demo-gemini.sh
# Explicit KEY_FILE remains a fallback (not the usual launch).
#
# The helper uses Security.framework SecItem* and reads the secret from stdin.
# Never pass the password as a process argument to the security CLI.
# Does not touch "Mailspring Safe Storage" / "Mailspring-demo Safe Storage".
# Does not print the key. Does not scrape process memory or KEY env.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$ROOT/app/native/gemini-demo-keychain/main.swift"
HELPER="$ROOT/app/native/gemini-demo-keychain/gemini-demo-keychain"
MARKER=MAILSPRING_DEMO_GEMINI_NONSECRET_MARKER

die() {
  echo "gemini-demo-keychain: $*" >&2
  exit 1
}

ensure_darwin() {
  [ "$(uname -s)" = Darwin ] || die "macOS only"
}

ensure_helper() {
  ensure_darwin
  if [ -x "$HELPER" ]; then
    return 0
  fi
  command -v swiftc >/dev/null 2>&1 || die "swiftc not found; install Xcode CLT"
  echo "gemini-demo-keychain: compiling helper (Security.framework)" >&2
  swiftc -O -framework Security -o "$HELPER" "$SRC"
  chmod 755 "$HELPER"
}

refuse_env_secret() {
  if [ -n "${MAILSPRING_DEMO_GEMINI_API_KEY+x}" ]; then
    die "MAILSPRING_DEMO_GEMINI_API_KEY is set; unset it. This script never copies that env into Keychain."
  fi
}

cmd=${1:-}
case "$cmd" in
  save|replace)
    ensure_helper
    refuse_env_secret
    [ -t 0 ] || die "save requires a Terminal hidden prompt; do not pipe the key onto this script"
    restore_echo() { stty echo 2>/dev/null || true; }
    trap restore_echo EXIT INT HUP
    printf 'Gemini DEMO API key (input hidden, not echoed): ' >&2
    stty -echo
    IFS= read -r KEY || true
    restore_echo
    trap - EXIT INT HUP
    printf '\n' >&2
    [ -n "$KEY" ] || die "empty key"
    printf 'Paid project ack? type 1 or 0 (not billing proof): ' >&2
    IFS= read -r PAID || true
    [ "$PAID" = 0 ] || [ "$PAID" = 1 ] || die "paid ack must be 0 or 1"
    # Builtin printf → helper stdin. Key is not on helper argv.
    printf 'paid=%s\n%s\n' "$PAID" "$KEY" | "$HELPER" save
    KEY=
    PAID=
    ;;
  dummy-save)
    ensure_helper
    refuse_env_secret
    # Public marker only. Never a live key.
    printf 'paid=0\n%s\n' "$MARKER" | "$HELPER" save
    ;;
  remove|dummy-remove)
    ensure_helper
    "$HELPER" remove
    ;;
  status)
    ensure_helper
    "$HELPER" status
    ;;
  helper)
    ensure_helper
    echo "$HELPER"
    ;;
  *)
    die "usage: gemini-demo-keychain.sh save|replace|remove|status|dummy-save|dummy-remove"
    ;;
esac
