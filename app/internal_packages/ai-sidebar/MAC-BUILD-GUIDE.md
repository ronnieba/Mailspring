# AI Sidebar Mac Development Build Guide

The signed `/Applications/Mailspring.app` cannot load this prototype. Use a source Electron run only.

## Isolated identities

| Mode | Command | App name | Config dir | Keychain item | Crashpad |
|------|---------|----------|------------|---------------|----------|
| Production | `/Applications/Mailspring.app` | `Mailspring` | `~/Library/Application Support/Mailspring/` | `Mailspring Safe Storage` | `Mailspring/Crashpad` |
| Dev | `npm start` | `Mailspring-dev` | `.../Mailspring-dev/` | `Mailspring-dev Safe Storage` | `Mailspring-dev/Crashpad` |
| **Demo (required for sidebar without account)** | `npm run start:demo` | `Mailspring-demo` | `.../Mailspring-demo/` | mock keychain (no prompt) | `Mailspring-demo/Crashpad` |

`--demo` skips onboarding, mailsync, KeyManager/safeStorage, protocol registration, and single-instance lock. It does **not** read the production profile or Yahoo credentials.

If a Keychain dialog names **Mailspring Safe Storage**, deny it — that is the production item. Demo must not request it.

## Launch (accountless sidebar)

```bash
cd /path/to/Mailspring   # e.g. /Users/d623300/Developer/Mailspring-AI-Dev/src
git checkout cursor/ai-sidebar-prototype-842c
npm install
npm run typecheck
npx ts-node app/internal_packages/ai-sidebar/test-core.ts
npx ts-node app/internal_packages/ai-sidebar/test-adapter.ts
npx ts-node app/internal_packages/ai-sidebar/test-real-adapter.ts
npx ts-node app/internal_packages/ai-sidebar/test-isolation.ts
npx ts-node app/internal_packages/ai-sidebar/test-integration.ts

# Accountless synthetic demo (NOT npm start — that is onboarding)
npm run start:demo
```

Expected window title: `Mailspring Demo (synthetic — no account)`.
Expected sidebar banner: `🧪 מצב DEMO` / `MOCK AI · synthetic fixtures`.

### Own-window PNG (no macOS Screen Recording)

```bash
electron ./app --enable-logging --dev --demo \
  --demo-capture="$PWD/ai-sidebar-demo.png"
```

Electron `capturePage` writes only this window. Check stdout for `Wrote own-window capture`.

## Verify isolation after launch

```bash
# Demo profile (new). Do not open production Mailspring/.
ls -la ~/Library/Application\ Support/Mailspring-demo/

# Production timestamps must be unchanged — do not read config.json or Keychain.
stat ~/Library/Application\ Support/Mailspring
```

Helper `--user-data-dir` must contain `Mailspring-demo`.
`chrome_crashpad_handler` database path must contain `Mailspring-demo/Crashpad`, not `Mailspring/Crashpad`.
No Keychain dialog for `Mailspring Safe Storage`.

Quit with Cmd+Q.

## Prerequisites

Apple Silicon, Node 24 at `/opt/homebrew/bin` is fine. Leave `/Applications/Mailspring.app` closed.

`npm start` (dev, no `--demo`) still shows onboarding if there is no account. That is intentional.
