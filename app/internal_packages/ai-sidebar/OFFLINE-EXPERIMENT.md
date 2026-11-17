# Offline experiment (Windows / macOS dev build)

Browse a local, read-only copy of a mailbox (the snapshot `work` tree, or any
`.eml` / Maildir / mbox folder) with the AI sidebar. Nothing is connected to the
mail provider.

## Launch (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-offline-archive.ps1 -ArchivePath D:\Yahoo-Offline\<run>\work
```

(macOS/Linux: `sh scripts/start-offline-archive.sh /absolute/path/to/work`.)

## What this mode does

- Isolated profile `Mailspring-offline` (`%APPDATA%\Mailspring-offline`). The
  official Mailspring profile, database and credentials are never used.
- No account, no onboarding, no mailsync process, no IMAP/SMTP.
- Mail files are opened read-only. The `baseline` copy is refused. The header
  index cache is written only into the isolated profile
  (`offline-mail-index.json`), never into the archive.
- Main window: folder tree (original server folder names from the snapshot
  manifest), virtualized message list (newest first, local filter, Ctrl/Shift
  multi-select), read-only reader. HTML mail renders in a sandboxed iframe
  (no scripts) with a CSP that blocks every remote load; remote images are hidden.
- Compose, reply, forward, send, move, delete and flag are off: the related
  packages are not activated, DraftStore is inert and queued tasks are dropped.
- Every remote request from app windows is cancelled (main-process
  `webRequest` guard), except the Gemini Developer API host, which the app
  contacts only after an explicit Summarize when a key is configured.
  Crash dumps are kept local (no upload).
- AI sidebar: Selected / Folder / All scopes over the local copy with the mock
  provider (no network). Citations open the message in the main window.
  Gemini is used only via the explicit "Summarize (Gemini)" button for exactly
  one selected message.
- Local full-text search (search box above the list, Ctrl+F, ribbon "Search
  mail"): subject, sender, recipients, body text (HTML without tags) and
  attachment file names; current folder, folder + subfolders, or all folders;
  Hebrew-aware (niqqud, final letters, ו/ה/ב/ל/מ/ש prefixes) and case-insensitive;
  `from:` `to:` `subject:` `file:` `has:attachment` `after:` `before:` `date:`
  `folder:` (Hebrew aliases too), "phrases", `OR`, `-word`. The SQLite FTS5
  index lives only in the offline profile (`offline-search.sqlite`); it is
  built once in the background (progress shown) and afterwards only new,
  changed or removed mail is read. No network.
- "✍️ Write with AI" for local drafts (AI panel chip, ribbon AI tab, draft
  toolbar). On by default for an empty/near-empty draft. New mail: Gemini
  writes subject + body from the user's instruction; reply/forward: only the
  reply/note above the quote, with the original message (or up to 10
  conversation messages when ticked) sent as plain text, truncated (12,000 /
  24,000 characters), never attachments or draft recipients. Only on an
  explicit "Write" click; preview first; Apply / Add at end / Copy; the
  subject changes only when empty or ticked; one-step undo restores body and
  subject. Usage is logged as `offline-draft-compose`.
- Draft conversation memory (write with AI and draft help): follow-ups such as
  "shorter", "refer to the mail", "in Hebrew" are sent with the earlier
  instructions and Gemini answers about the same draft (marked applied or
  not), last 6 turns / 16,000 characters, plus the current draft text. Kept in
  memory only; "🆕 New conversation", "Clear chat" or opening another draft
  resets it. A "🔗 continuing" bar shows when context will be sent.

## Gemini on Windows

Not wired yet. The Gemini key store is the macOS Keychain helper (or a key file
via `MAILSPRING_DEMO_GEMINI_KEY_FILE`). A Windows Credential Manager reader (same
pattern as `scripts/windows-cred-read.ps1` / `store-yahoo-imap-password.ps1`)
is required before Summarize can be enabled; the user enters the key locally.

## Gemini on Windows (optional, paid project yahoo-agent)

1. Store the key once, typing it yourself (hidden prompt; never printed or logged):
   `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Roni\Developer\Mailspring-AI-Dev\src\scripts\store-gemini-api-key.ps1"`
   Answer `y` to confirm the key is from the paid project. Remove it with `-Remove`.
2. Credential Manager item: `Mailspring-offline Gemini API|gemini-api-key` (separate from the Yahoo IMAP item, which the app never reads).
3. The app reads it lazily (AI panel status / "Check again" / Summarize), keeps it in main-process memory only.
4. Gemini runs only on an explicit click of "Summarize with Gemini" for exactly one selected message. "Send" stays local (Mock).