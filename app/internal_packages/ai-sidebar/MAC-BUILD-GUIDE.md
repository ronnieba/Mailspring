# AI Sidebar Mac Development Build Guide

This document describes how to build and run the AI sidebar prototype on macOS. The prototype is a development-mode feature that requires running Mailspring from source.

## Important: This is NOT a Plugin for the Installed App

**The signed Mailspring.app from getmailspring.com cannot load this plugin.**

Packaged releases silently ignore `--dev` and `--test` flags (see `developer-tools.js`). The only way to run this prototype is via a development build from source.

## Profile Isolation

Running `npm start` uses complete profile isolation from the production app:

| Data | Production App | Dev Build (`npm start`) |
|------|----------------|------------------------|
| Config directory | `~/Library/Application Support/Mailspring/` | `~/Library/Application Support/Mailspring-dev/` |
| Database | `Mailspring/edgehill.db` | `Mailspring-dev/edgehill.db` |
| Config file | `Mailspring/config.json` | `Mailspring-dev/config.json` |
| Encrypted credentials | In `config.json`, encrypted with app's safeStorage key | Separate in `Mailspring-dev/config.json` |

**What IS isolated:**
- ✅ All config, database, and cached data
- ✅ Account credentials (stored in separate config with different encryption)
- ✅ User preferences and themes

**What is NOT fully isolated:**
- ⚠️ URL scheme `mailspring://` - both register it; avoid running simultaneously
- ⚠️ System tray may show both if running together

**Recommendation:** Do not run the production app and dev build at the same time.

## Prerequisites

### Required
- macOS (Apple Silicon or Intel)
- Node.js 18+ (recommended: use `nvm`)
- Git

### Install Node.js via nvm (recommended)
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
# Restart terminal, then:
nvm install 18
nvm use 18
```

## Build Steps

### 1. Clone the fork
```bash
git clone https://github.com/ronnieba/Mailspring.git
cd Mailspring
git checkout cursor/ai-sidebar-prototype-842c
```

### 2. Install dependencies
```bash
npm install
```

This may take 5-10 minutes. It downloads Electron and compiles native modules.

### 3. Run the development build
```bash
npm start
```

This launches Mailspring in development mode with:
- Config stored in `~/Library/Application Support/Mailspring-dev/`
- TypeScript compiled on the fly
- All internal packages loaded from source

## Verifying the Sidebar Loads

1. The app will open to the account setup screen (dev profile is empty)
2. **You do NOT need to add a real account to test the sidebar**
3. Open Developer Tools: Menu → Developer → Toggle Developer Tools
4. In the console, check for errors related to `ai-sidebar`
5. The sidebar should appear in the message list panel

## Testing Without a Real Account

The prototype works with synthetic fixtures. To demo without real mail:

1. Start the dev build
2. The sidebar will show "לא נבחרו הודעות" (no messages selected) - this is expected
3. The mock AI provider will respond to queries with fixture-based responses
4. The "⚠️ MODE: MOCK" banner confirms no real AI is connected

## Running Tests

### Node-based tests (no Electron required)
```bash
# Core mock provider tests
npx ts-node app/internal_packages/ai-sidebar/test-core.ts

# Adapter logic tests
npx ts-node app/internal_packages/ai-sidebar/test-adapter.ts
```

### Electron-based Jasmine tests (may require Xvfb on Linux)
```bash
npm test -- --spec-file-pattern='ai-sidebar'
```

Note: Jasmine tests may hang in some environments without a display. The Node-based tests provide equivalent coverage.

## Files Changed

| File | Purpose |
|------|---------|
| `lib/core/types.ts` | Platform-agnostic type definitions |
| `lib/core/mock-provider.ts` | Deterministic mock AI (no network) |
| `lib/mailspring-adapter.ts` | Mailspring-specific data access |
| `lib/ai-sidebar-store.ts` | Flux store for state management |
| `lib/ai-sidebar.tsx` | React UI component (Hebrew RTL) |
| `lib/main.ts` | Package entry point |
| `styles/ai-sidebar.less` | RTL-aware styles |
| `test-core.ts` | Node-based core tests (21 tests) |
| `test-adapter.ts` | Node-based adapter tests (21 tests) |
| `specs/*.ts` | Jasmine specs for Electron |

## Troubleshooting

### "Module not found" errors
Run `npm install` again - native modules may need recompilation.

### App crashes on startup
Delete the dev config folder and restart:
```bash
rm -rf ~/Library/Application\ Support/Mailspring-dev
npm start
```

### Tests hang
The Jasmine test harness requires a display. Use the Node-based tests instead:
```bash
npx ts-node app/internal_packages/ai-sidebar/test-core.ts
npx ts-node app/internal_packages/ai-sidebar/test-adapter.ts
```

### URL scheme conflicts
If clicking `mailspring://` links opens the wrong app, ensure only one version is running.

## What This Prototype Does NOT Do

- ❌ Connect to any AI service (Gemini, Claude, or otherwise)
- ❌ Access real email content for AI processing
- ❌ Send, delete, move, label, or mark messages as read
- ❌ Store credentials or make network requests
- ❌ Modify the installed Mailspring.app
- ❌ Change system default mail client settings

## Security Constraints

- Mock mode is prominently labeled in the UI
- All "AI" responses are deterministic fixtures
- HTML content is escaped to prevent XSS
- No prompt injection can trigger mutations or network requests
- Read-only access to mail data (when accounts exist)
