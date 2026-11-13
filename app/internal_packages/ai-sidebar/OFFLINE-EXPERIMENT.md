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

## Gemini on Windows

Not wired yet. The Gemini key store is the macOS Keychain helper (or a key file
via `MAILSPRING_DEMO_GEMINI_KEY_FILE`). A Windows Credential Manager reader (same
pattern as `scripts/windows-cred-read.ps1` / `store-yahoo-imap-password.ps1`)
is required before Summarize can be enabled; the user enters the key locally.
