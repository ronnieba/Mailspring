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
# Do NOT run repo-root npm install if it would rewrite the existing
# app/package-lock.json local diff — leave that file BYTE IDENTICAL.
# Private Hunspell WASM dictionaries (AGPL-3.0 he aff/dic, not committed).
# install.sh aborts if app/package-lock.json would change. Re-run after this SHA
# to replace leftover nspell with hunspell-asm@4.0.2:
bash app/src/spellcheck/offline-prototype/install.sh
npm run typecheck
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-core.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-adapter.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-real-adapter.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-isolation.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-integration.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-mail-database.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-sidebar.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-query.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-ai-boundary.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-gemini-demo.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-cli.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-composer-direction.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-composer-spell.ts
# First gate: 20 passed, 0 failed, and the process must EXIT on its own
# (cf9ca4f printed 20/0 then hung on Hunspell child IPC until 35s SIGTERM).
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-composer.ts
# After sidecar install (does NOT touch app/package-lock.json):
# bash app/src/spellcheck/offline-prototype/install.sh
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-nspell-engine.ts

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
#   "$REPO/app/internal_packages/ai-sidebar/test-ai-boundary.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-gemini-demo.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-demo-cli.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-composer-direction.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-composer-spell.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-demo-composer.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-nspell-engine.ts"

# Accountless synthetic demo (NOT npm start — that is onboarding)
npm run start:demo

# AX UI retest (same as native 2026-11-07 method)
electron ./app --enable-logging --dev --demo --force-renderer-accessibility

# Cancel inspect (demo+dev only; ignored without --demo; max 30000ms)
electron ./app --enable-logging --dev --demo --force-renderer-accessibility --demo-delay-ms=8000
# or: npm run start:demo -- --force-renderer-accessibility --demo-delay-ms=8000
```

`--demo-delay-ms` is not a debug port or network endpoint. It only delays the mock provider so **ביטול** can be clicked. Leave it off for normal fixture checks. **ביטול** / AbortSignal / worker SIGTERM are **local cancellation**. They do not complete remote generation and must not be billed. Live providers are disabled. Optimist 0.4 has no `.number()` — the flag is a `.string()` like `--demo-capture`. Isolation (`setName` / `userData` / mock keychain) is applied from raw argv **before** Optimist parse so a CLI throw cannot leave helpers on `.../Mailspring`.

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
| DEMO composer tab | `עורך DEMO` |
| AI tab | `עוזר AI` |
| DEMO composer region | `DEMO composer (synthetic)` |
| Paragraph direction group | `כיוון פסקה` |
| Paragraph RTL | `פסקה מימין לשמאל (RTL)` |
| Paragraph LTR | `פסקה משמאל לימין (LTR)` |
| Paragraph Auto | `כיוון פסקה אוטומטי` |
| Serialize & reopen | `סריאליזציה ופתיחה מחדש` |
| Reload demo draft | `טען טיוטת DEMO מחדש` |
| Spell backend status | `מצב בודק איות` |
| Spell suggestions | `הצעות איות` |
| Replace overlay typo | `החלף ב-misspelled` / `החלף ב-איות` (AX Press, Space, Enter) |
| Add to personal dictionary | `הוסף למילון האישי` |
| Remove from personal dictionary | `הסר מהמילון האישי` / `הסר מהמילון האישי: <word>` |
| Personal dictionary region | `מילון אישי` |

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
6. Composer tab: per-paragraph RTL/LTR independence + serialize/reopen HTML `dir`.
7. Visible misspellings `misspelledd` / `איותת`; suggestion click replaces; add/remove personal dictionary only under `Mailspring-demo/`.

## DEMO composer (accountless, same real editor)

Launch is the same isolated demo. Do **not** `npm start` (onboarding). Do **not** send mail.

```bash
npm run start:demo -- --force-renderer-accessibility
# or:
electron ./app --enable-logging --dev --demo --force-renderer-accessibility
```

1. Wait until `.ai-sidebar[data-demo-ready]` is up (AI tab is default so Full Scan capture still works).
2. Click **עורך DEMO** (`aria-label="עורך DEMO"`).
3. Toolbar direction buttons appear after ~400ms (existing ComposerEditorToolbar defer). Wait ~1s.
4. Confirm banner: `עורך DEMO · אותו ComposerEditor · אין שליחה · אין שמירת טיוטה`.
5. Spell status region `מצב בודק איות` (`data-hebrew-native="listed|absent"`, `data-hebrew-detection="unproven"`, `data-hebrew-suggestions="unproven"`, `data-hebrew-bundled="not-shipped"`). If this Mac lists `he`, summary is **Native Hebrew listed this session (he) — listing is not detection; suggestions unproven**. Listing ≠ underlines ≠ guesses. Do **not** relabel native Hebrew universally BLOCKED. Bundled Hspell is not shipped (AGPL-3). Overlay remains two UI-test typos. Native spellcheck stays on (`nativeSpellCheck={true}`).

### Fixture paragraphs (synthetic in-memory draft)

| # | Explicit dir | Text |
|---|--------------|------|
| 1 | RTL | `שלום צוות, מצורפת החשבונית לחודש נובמבר.` |
| 2 | LTR | `Hello team, please review the invoice for November.` |
| 3 | RTL | `זו שגיאת איותת בפסקה העברית.` |
| 4 | LTR | `This is a misspelledd word in English.` |
| 5 | LTR | `Invoice 12345 — חשבונית 12345.` |

**UI-test overlay only** (never auto-corrected; **not** general Hebrew): English `misspelledd` → `misspelled`; Hebrew `איותת` → `איות`. Ordinary Hebrew such as `אבטיח` must **not** be flagged by the overlay.

### Overlay AX / keyboard (must work without a physical mouse)

| Control | AX name | Activation |
|---------|---------|------------|
| Replace English | `החלף ב-misspelled` (`data-spell-action="replace"`) | AX Press, Space, Enter, or mouse. Caret may leave the typo; stored range is used. |
| Replace Hebrew | `החלף ב-איות` | same |
| Add to dictionary | `הוסף למילון האישי` | AX Press / click |
| Remove from list | `הסר מהמילון האישי: misspelledd` | AX Press / click — overlay on that word must return **immediately**, no reload |
| Status | `מצב בודק איות` | expand `<details>` for the full session note |

Keyboard: click the typo, then Tab/Shift+Tab to the replace button, then Space or Enter. Overlay popover stays up while the editor is unfocused.

### Native verification cases

1. **Per-paragraph independence:** caret in paragraph 1, click `פסקה משמאל לימין (LTR)`. Paragraph 1 must flip LTR; neighbors unchanged. Numbers in paragraph 5 (`12345`) stay intact.
2. **Serialize/reopen:** `סריאליזציה ופתיחה מחדש`. HTML includes `dir="rtl"` / `dir="ltr"`; homogeneous Hebrew paragraphs may also have `lang="he"`. Mixed paragraph 5 omits `lang`.
3. **Overlay accept:** caret in `misspelledd` / `איותת` → `הצעות איות` → authored `החלף ב-misspelled` / `החלף ב-איות`. These two stay fixture-backend with authored replacements even after Hunspell is loaded, dictionary add/remove, and `טען טיוטת DEMO מחדש`. Do **not** show `אין הצעות` for those two. AX Press and keyboard must succeed, not only mouse. Type `אבטיח`: overlay must **not** underline it.
4. **Dictionary add:** `הוסף למילון האישי`. File: `~/Library/Application Support/Mailspring-demo/spell-personal-dictionary.json` only.
5. **Dictionary remove:** `הסר מהמילון האישי: misspelledd`. Overlay for **that word** must reappear immediately (Hebrew mark stays). No reload/edit workaround.
6. **Layout at the real sidebar width (~300pt, not declared minWidth):** after add/remove, with the overlay popover open, paragraphs 4/5 must remain fully readable. `מילון אישי` / `אין מילים שמורות` / the footer must **not** paint over editor text. Scroll the editor workspace if needed; dictionary/status/actions stay in flow (opaque, not covering). Measured column width may stay ~299pt because the MessageListSidebar also hosts contact cards (`maxWidth: 300`).
7. **Expanded spelling status must not collapse the editor or dictionary:** click `מצב בודק איות` so the disclosure is **open**. At ~299pt, workspace and `מילון אישי` must keep a usable height (not ~1pt). Wheel inside the workspace still reveals all 5 paragraphs; wheel inside the yellow status slot scrolls the diagnostic text. Do **not** collapse the disclosure as a workaround. Collapsed status must still work as in (6).
8. **Native OS suggestions:** 34a90265 recorded underlines on `recieve`/`seperate`/`mispell` and `אבטיחחח`/`חשבנוית`/`שלומ` with **No Guesses Found**; `teh` was not flagged. OS/Electron limitation, not a missing menu. Do not rebuild layout. Do not change the user’s Spelling language.
9. **Offline Hunspell WASM (after sidecar reinstall):** first confirm composer-spell **exits** after 20/0. Then engine 13. Status `data-offline-spell="ready"` (or `timeout`/`error` if the child is killed — do not treat that as “no guesses”). Type `recieve` / `אבטיחחח` (overlay silent). Caret → `הצעות איות` → `החלף ב-receive` / a Hebrew guess. **103d29bf:** with status **expanded** at ~299pt, suggestion buttons were h=2 at the workspace bottom; AXScrollToVisible and workspace wheel did not reveal them. The popover must sit in `.demo-composer-spell-host` (overlay above the dictionary, not inside the editor scrollport). Buttons `min-height: 32px`, pointer + keyboard/AX. Do **not** collapse the diagnostic disclosure as a workaround. Workspace still scrolls all paragraphs; status still independently scrolls. Only that word changes; paragraph `dir` and neighbors stay. `watermelon` / `אבטיח` must not be flagged. Add/remove personal JSON under `Mailspring-demo` only. Fixtures remain two typos.

There is no Send button on this surface. Production composer send/draft saving is unchanged. Overlay spell plugins are **not** in the default conversion plugin list.

### Spell backend provenance

**Hspell aff/dic are not in git (AGPL-3.0). Native listing is not detection.** Private Hunspell WASM sidecar: `bash app/src/spellcheck/offline-prototype/install.sh` — does not touch `app/package-lock.json`. nspell is not installed. Details: `app/src/spellcheck/HEBREW-SPELLCHECK.md` and `offline-prototype/NOTICE.md`.

| Backend | When | License / notes |
|---------|------|-----------------|
| Chromium/macOS `NSSpellChecker` | Production + DEMO `nativeSpellCheck={true}` | Official Electron docs: Hunspell is **not** used on macOS; `setSpellCheckerLanguages` is a **no-op**. Language auto-detect. Parent records `availableSpellCheckerLanguages` on the target Mac. |
| Chromium Hunspell `he_IL` | Win/Linux only | Chromium `he_IL.dic` is Hspell **1.0 / GPL** (~3.2 MB). Not loaded on macOS. Not vendored here (would need a JS Hunspell engine). |
| Hspell 1.4 / `dictionary-he` 2.0.0 | Sidecar local only, **not in git** | **AGPL-3.0** aff/dic (no “or later” grant verified). Packaging MIT. Install via `offline-prototype/install.sh`. Do not publish. |
| hunspell-asm 4.0.2 + dictionary-en 4.0.0 | Sidecar local only | Wrapper MIT; Hunspell MPL-1.1/GPL-2+/LGPL-2.1+. dictionary-en (MIT AND BSD). Child process, separate en/he instances. |
| nspell 2.1.5 | **Rejected** | Native 7c346435: first `nspell(aff,dic)` stalled 194s / 99% CPU / 1.31GiB. Eager PFX expansion. Not installed. |
| UI-test overlay (`FIXTURE_TYPOS`) | DEMO extraPlugins only | Two typos: `misspelledd`, `איותת`. GPL-3.0-or-later authored. **Not** a Hebrew dictionary. |
| Personal dictionary JSON | DEMO / `learnWord` while `MAILSPRING_DEMO=1` | `spell-personal-dictionary.json` under the isolated config dir. Demo never calls `session.addWordToSpellCheckerDictionary`. |
| LanguageTool / paid grammar / Google Hunspell CDN / cloud AI | **Not used** | Existing grammar-check package is unchanged and is not this backend. |

## Expected portable test counts (UNRUN in cloud)

Parent runs these on Mac from repo root (and once from another cwd with `--prefix` + absolute paths):

| File | Expected |
|------|----------|
| `test-core.ts` | 21 |
| `test-adapter.ts` | 21 |
| `test-real-adapter.ts` | 18 |
| `test-isolation.ts` | 10 |
| `test-integration.ts` | 18 |
| `test-mail-database.ts` | 21 |
| `test-demo-sidebar.ts` | 21 |
| `test-demo-query.ts` | 18 |
| `test-ai-boundary.ts` | **17** |
| `test-gemini-demo.ts` | **22** (mocked transport + nonsecret child-env containment) |
| `test-demo-cli.ts` | 12 |
| **prior portable subtotal** | **199** |
| `test-composer-direction.ts` | 14 |
| `test-composer-spell.ts` | 21 |
| `test-demo-composer.ts` | 13 |
| **composer subtotal (no sidecar)** | **48** |
| `test-nspell-engine.ts` | **13** (requires sidecar install) |
| **portable total after sidecar** | **260** |

Without sidecar install: prior **247** + alt-cwd **48** still apply. After `install.sh`: **260** portable (247+13). Composer+engine alt-cwd remains **61** (48+13) unless `test-ai-boundary.ts` / `test-gemini-demo.ts` are included (**+17 / +22**). Do not run these in cloud CI. Preserve 34a90265 layout/AI/isolation. Do not rewrite `app/package-lock.json`.

**This SHA targeted Mac commands (do not claim f89b4e4b 221+61 / 81 UI):**

```bash
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-ai-boundary.ts
# expected 17 passed, natural exit
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-gemini-demo.ts
# expected 22 passed (mocked transport + NONSECRET child-env containment; no live Gemini)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-query.ts
# expected 18 passed (explicit exhaustive 2/5/6)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-sidebar.ts
# expected 21 passed (store fail-closed + hostCoverageFooter)
```

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
After dictionary add: `Mailspring-demo/spell-personal-dictionary.json` exists; `~/Library/Spelling` and `.../Mailspring/` (production) are not written.

Quit with Cmd+Q.

## Prerequisites

Apple Silicon, Node 24 at `/opt/homebrew/bin` is fine. Leave `/Applications/Mailspring.app` closed.

`npm start` (dev, no `--demo`) still shows onboarding if there is no account. That is intentional.

## Official paid Gemini Developer API (DEMO synthetic only)

This is the **Gemini Developer API** billed through AI Studio / Cloud Billing. It is **not a consumer Gemini** app subscription (Google AI Pro / Gemini in a browser). An API key or the model id **cannot prove billing** is linked. Do not treat a key as a free-tier-only project prerequisite — live execution requires an explicitly configured **paid** project/key plus `MAILSPRING_DEMO_GEMINI_PAID=1`.

Pinned model: `gemini-3.5-flash-lite` (no auto-substitution). Official Interactions REST:

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Headers: `x-goog-api-key`, `Content-Type: application/json`, `Api-Revision: 2026-05-20`. Read `output_text`. Sources: https://ai.google.dev/gemini-api/docs/get-started · https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/billing · https://ai.google.dev/gemini-api/terms#data-use-paid

Listed paid price for this model as of 2026-11-08: **$0.30 input / $2.50 output per 1M tokens** (output includes thinking). Parent is researching rates, prepaid amount, and spend controls. App token estimates are **not** a cost ceiling.

### Data use (do not over-claim)

Paid-tier docs currently say prompts/responses are **not used to improve Google products**, and Google acts as a data processor. Google still logs prompts/responses **for a limited period** to detect policy violations and for legal disclosures (no day count published). That is **not zero** retention. Whether an abuse review can involve a human reading logs is **not stated**. Do not promise zero retention or no human access.

### Billing gates (parent, not this SHA)

- Prepaid minimum **$5**; unused credits expire after 12 months.
- Keep **auto-reload** **OFF** unless the parent later enables it.
- Spend caps are **not** a true real-time hard stop: billing can lag about **10 minute**s and overshoot a cap or a $0 prepay balance. Batch/agent jobs can overshoot further.
- Linking billing and issuing live generations is **not authorized** until the parent settles price/budget/key.

### Local env (captured in main, stripped before Electron children)

Live path stays **unconfigured** without both variables at **launch**. `app/src/browser/main.js` captures them into main-process memory and **unsets** the names from `process.env` before `require('electron')`. Chromium `--type=renderer` / `--type=gpu-process` / `--type=utility` and `chrome_crashpad_handler` therefore must not inherit the named variable. Native e1ec474c renderer PID 70413 inherited it when this strip was missing.

Do not paste a real key into git, screenshots, argv, renderer UI, or logs. IPC status reports booleans only.

```bash
# Do not paste a real key into git, screenshots, or argv.
# MAILSPRING_DEMO_GEMINI_PAID=1 is an operator ack, not proof of Cloud Billing.
MAILSPRING_DEMO=1 \
MAILSPRING_DEMO_GEMINI_API_KEY='…paid project key…' \
MAILSPRING_DEMO_GEMINI_PAID=1 \
electron ./app --enable-logging --dev --demo
```

Without those env vars the sidebar stays mock. A Gemini error must not fall back to mock fixtures. Local Cancel/timeout abort the process fetch; they do **not** guarantee the provider stopped a billed generation.

### UNRUN native process-boundary (NONSECRET marker — never a real key)

Native e1ec474c: `nonsecret_key_named_environment_inherited=true` on own `--type=renderer` PID 70413. Repeat this **boolean** check on the new SHA before any secret-bearing launch. Do **not** print environ. Do **not** use a real key. `MAILSPRING_DEMO_GEMINI_PAID=0`.

```bash
# UNRUN native process-boundary. Public marker only.
MAILSPRING_DEMO_GEMINI_API_KEY='MAILSPRING_DEMO_GEMINI_NONSECRET_MARKER' \
MAILSPRING_DEMO_GEMINI_PAID=0 \
./node_modules/.bin/electron ./app --enable-logging --dev --demo --force-renderer-accessibility
```

From another terminal, inspect **own** checkout Electron children only (`--user-data-dir=.../Mailspring-demo`). Record booleans for whether the **name** `MAILSPRING_DEMO_GEMINI_API_KEY` is present in:

- Electron main (`.../MacOS/Electron ./app`)
- `--type=renderer` (the e1ec474c failing case)
- `--type=gpu-process`
- `--type=utility`
- `chrome_crashpad_handler`

Expected after this SHA: **all false**. Stdout may include `[Gemini DEMO] provider credential captured in main process memory; stripped from process environment (value not logged)` — that log must not contain the marker value. Portable Node equivalent (already in `test-gemini-demo.ts`): child spawned with stripped `process.env` prints `ABSENT`.

Remaining gates before live execution: this native renderer/helper boolean check passing, paid project + key, Cloud Billing linked (not inferable from the key), prepaid amount, auto-reload off, budget/cap accepted with overshoot risk, official data-use terms accepted, then a separate approval to admit real mail. No live Gemini / billing calls on this SHA.
