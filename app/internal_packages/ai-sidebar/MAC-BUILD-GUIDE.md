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
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-core.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-adapter.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-real-adapter.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-isolation.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-integration.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-mail-database.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-sidebar.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-query.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-cli.ts

# From any other cwd — pass ABSOLUTE paths and --prefix so npx uses the repo
# ts-node. Do not use a local tsconfig.json (that was a tester command error,
# not a test portability defect).
# REPO=/Users/d623300/Developer/Mailspring-AI-Dev/src
# cd /tmp
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-mail-database.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-demo-query.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-demo-cli.ts"

# Accountless synthetic demo (NOT npm start — that is onboarding)
npm run start:demo

# AX UI retest (same as native 2026-11-07 method)
electron ./app --enable-logging --dev --demo --force-renderer-accessibility

# Cancel inspect (demo+dev only; ignored without --demo; max 30000ms)
electron ./app --enable-logging --dev --demo --force-renderer-accessibility --demo-delay-ms=8000
# or: npm run start:demo -- --force-renderer-accessibility --demo-delay-ms=8000
```

`--demo-delay-ms` is not a debug port or network endpoint. It only delays the mock provider so **ביטול** can be clicked. Leave it off for normal fixture checks. Optimist 0.4 has no `.number()` — the flag is a `.string()` like `--demo-capture`. Isolation (`setName` / `userData` / mock keychain) is applied from raw argv **before** Optimist parse so a CLI throw cannot leave helpers on `.../Mailspring`.

After launch, GPU/network `--user-data-dir` must contain `Mailspring-demo`, never `.../Application Support/Mailspring` without `-demo`.

## Accessible control names (AX)

| Control | AX name / visible |
|---------|-------------------|
| All | `כל הדואר` / `📬 הכל` |
| Inbox (demo folder) | `תיקייה` / `📁 תיקייה` |
| Selected | `הודעות נבחרות` / `📧 נבחרות` |
| Ranked | radio `דירוג (מהיר)` |
| Full Scan | radio `סריקה מלאה` |
| Send | `שלח` |
| Clear | `נקה` |
| Cancel | `ביטול` |
| Invoice citation | includes `demo-msg-3` and `חשבונית` |
| Meeting citation | includes `demo-msg-1` |
| DEMO preview | region `DEMO source preview` |
| Close preview | `סגור תצוגת מקור DEMO` |

## Fixture queries

| Query | All | Inbox (`תיקייה`) | Selected (`נבחרות`) |
|-------|-----|------------------|---------------------|
| `חפש חשבוניות` | invoice `demo-msg-3` | invoice `demo-msg-3` | no match |
| `חפש הודעת ארכיון` | archive `demo-msg-6` | no match | no match |
| `סכם` | mock summary of in-scope fixtures | inbox only | meeting thread (2) |

Full Scan (`סריקה מלאה`) must echo **סריקה מלאה (exhaustive)** and the in-scope scan count (All=6, Inbox=5, Selected=2). It must **not** say ranked/top-k or `לא כל ההודעות נסרקו`. Ranked must still show that warning.

Citation click must open the yellow **DEMO מקור סינתטי** preview for `demo-msg-3` / `demo-msg-1` (same log line `Would navigate to message:`). Never a production mailbox.

## Screenshots parent should collect

1. Full Scan selected (ranked=0/full=1) + invoice answer showing exhaustive coverage, not top-k.
2. Same query after Clear **before** selecting Full Scan (mode must still stick).
3. Citation click → visible DEMO preview with source id (`demo-msg-3` or `demo-msg-1`).
4. `--demo-delay-ms=8000` → **ביטול** visible; after Cancel, no late mock answer.
5. `חפש הודעת ארכיון` in All (hit) vs Inbox and Selected (empty).

`--demo` does **not** open, migrate, rebuild, or relaunch over `edgehill.db`. A leftover empty stub in `Mailspring-demo/` from an older checkout is ignored; do not delete it. Production `application:reset-database` (Okay → rebuild → relaunch) is unchanged.

Expected window title: `Mailspring Demo (synthetic — no account)`.
Expected sidebar banner: `🧪 מצב DEMO` / `MOCK AI · synthetic fixtures`.

### Own-window PNG (no macOS Screen Recording)

```bash
electron ./app --enable-logging --dev --demo \
  --demo-capture="$PWD/ai-sidebar-demo.png"
```

Capture waits until `.ai-sidebar[data-demo-ready]` is mounted with the DEMO banner and three scope buttons, then runs a fixture mock query (`חפש חשבוניות`) and snapshots citations. It does **not** screenshot at `did-finish-load` / a fixed 2s delay.

Check stdout for `sidebar ready`, `mock query complete`, and `Wrote own-window capture`. `Wrote diagnostic capture` means the sidebar never became ready — that PNG is a failure, not success.

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
