#!/bin/sh
# DEMO Gemini Keychain setup. macOS only.
#
# Usual path after one save: sh scripts/start-demo-gemini.sh
# Explicit KEY_FILE remains a fallback (not the usual launch).
#
# Dummy commands use an isolated Keychain service/account and never
# call helper save/remove on the real item. dummy-save hardcodes the
# public marker inside the helper (stdin is not stored). dummy-remove
# deletes only a dummy-namespace item whose value is that marker.
#
# save is create-only (conflict if the real item exists). replace is
# the deliberate overwrite. Never pass the password as a process
# argument to the security CLI. Does not touch Mailspring Safe Storage.
# Does not print the key. Does not scrape process memory or KEY env.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$ROOT/app/native/gemini-demo-keychain/main.swift"
HELPER="$ROOT/app/native/gemini-demo-keychain/gemini-demo-keychain"

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

prompt_blob() {
  [ -t 0 ] || die "$1 requires a Terminal hidden prompt; do not pipe the key onto this script"
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
  printf 'paid=%s\n%s\n' "$PAID" "$KEY"
  KEY=
  PAID=
}

cmd=${1:-}
case "$cmd" in
  save)
    ensure_helper
    refuse_env_secret
    prompt_blob save | "$HELPER" save
    ;;
  replace)
    ensure_helper
    refuse_env_secret
    prompt_blob replace | "$HELPER" replace
    ;;
  dummy-save)
    ensure_helper
    refuse_env_secret
    "$HELPER" dummy-save
    ;;
  dummy-remove)
    ensure_helper
    "$HELPER" dummy-remove
    ;;
  dummy-status)
    ensure_helper
    "$HELPER" dummy-status
    ;;
  remove)
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
    die "usage: gemini-demo-keychain.sh save|replace|remove|status|dummy-save|dummy-remove|dummy-status"
    ;;
esac
