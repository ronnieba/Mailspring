#!/bin/sh
# Read-only Yahoo IMAP snapshot PLAN. This script REFUSES to connect.
# It does not take a password, does not open a socket, and does not write mail.
#
# Later native gate (parent Mac, user-authorized): TLS imap.mail.yahoo.com:993,
# app password often required, LIST + EXAMINE (never SELECT) + UID FETCH
# RFC822.SIZE (disk estimate) then BODY.PEEK[] into an immutable .eml/maildir
# tree with sha256 + counts. STORE / EXPUNGE / MOVE / APPEND / COPY / SELECT
# are forbidden so flags and mailbox mutation cannot happen.
#
# Official Mailspring folder export (GetManyRFC2822Task) is NOT this backup:
# it needs live mailsync, is folder-at-a-time, and skips drafts/starred/unread
# roles. Do not copy ~/Library/Application Support/Mailspring/.
set -eu

echo "offline-imap-snapshot: REFUSES to execute. This SHA does not log in to Yahoo." >&2
echo "offline-imap-snapshot: no socket, no credentials, no FETCH." >&2
echo >&2
echo "Planned later native steps (user login + disk check first):" >&2
echo "  TLS connect imap.mail.yahoo.com:993 (not performed)" >&2
echo "  CAPABILITY" >&2
echo "  AUTHENTICATE / LOGIN (user, later; never this cloud agent)" >&2
echo "  LIST \"\" \"*\"" >&2
echo "  For every listed mailbox including Bulk/Spam/Trash: EXAMINE (not SELECT)" >&2
echo "  UID FETCH 1:* (RFC822.SIZE) for disk estimate before BODY.PEEK" >&2
echo "  Parent confirms free disk >= rfc822*1.15 + 64MiB" >&2
echo "  UID FETCH … BODY.PEEK[] write immutable .eml + sha256; resume by UIDVALIDITY+UID" >&2
echo "  Manifest: counts, hashes, unselectable, empty, examine-failed, missing candidates" >&2
echo "  LOGOUT" >&2
echo "  Copy archive to a disposable working tree; original stays read-only" >&2
echo >&2
echo "Forbidden: STORE EXPUNGE MOVE APPEND COPY SELECT FETCH BODY[] FETCH RFC822" >&2
echo "Allowed peek: EXAMINE UID FETCH BODY.PEEK[] RFC822.SIZE" >&2
echo >&2
echo "Uncertainties: Yahoo folder names, app-password vs OAuth IMAP, unselectable" >&2
echo "mailboxes, items already deleted on server, IMAP size vs on-disk MIME." >&2
echo "Unavailable/deleted items must be inventoried, never silently skipped." >&2
exit 2
