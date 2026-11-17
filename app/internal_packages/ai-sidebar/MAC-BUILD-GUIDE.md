# AI Sidebar Mac Development Build Guide

The signed `/Applications/Mailspring.app` cannot load this prototype. Use a source Electron run only.

## Isolated identities

| Mode | Command | App name | Config dir | Keychain item | Crashpad |
|------|---------|----------|------------|---------------|----------|
| Production | `/Applications/Mailspring.app` | `Mailspring` | `~/Library/Application Support/Mailspring/` | `Mailspring Safe Storage` | `Mailspring/Crashpad` |
| Dev | `npm start` | `Mailspring-dev` | `.../Mailspring-dev/` | `Mailspring-dev Safe Storage` | `Mailspring-dev/Crashpad` |
| **Demo (required for sidebar without account)** | `npm run start:demo` | `Mailspring-demo` | `.../Mailspring-demo/` | mock keychain (no prompt) | `Mailspring-demo/Crashpad` |
| **Opt-in one selected message** | `sh scripts/start-real-selected-summary.sh` | `Mailspring-dev` | `.../Mailspring-dev/` | `Mailspring-dev Safe Storage` + existing DEMO Gemini Keychain item | `Mailspring-dev/Crashpad` |
| **Disconnected local archive (current approved path)** | `sh scripts/start-offline-archive.sh /abs/archive` | `Mailspring-offline` | `.../Mailspring-offline/` | mock keychain + existing DEMO Gemini Keychain item (optional, one-message only) | `Mailspring-offline/Crashpad` |

`--demo` skips onboarding, mailsync, KeyManager/safeStorage, protocol registration, and single-instance lock. It does **not** read the production profile or Yahoo credentials.

`--dev --offline-archive` is **not** `--demo` and **not** live `--real-selected-summary`. It skips mailsync, does not open `edgehill.db`, and never logs into Yahoo. `--demo` still wins if both flags are present. Live `--real-selected-summary` is retained in code but is **not** the approved experiment path.

`--dev --real-selected-summary` is **not** `--demo`. It keeps mailsync and uses the isolated Mailspring-dev profile (same as `npm start`). It cannot see Yahoo mail that only exists in official `/Applications/Mailspring.app`. Do not copy production userData, Keychain, or account configs. Do not install over the official app. The official app does not load this extension. The official Mailspring cache is **not a complete backup** (bodyProgress, live sync). Do not scrape it.

Electron `--use-mock-keychain` covers **Mailspring-demo Safe Storage** only. The DEMO Gemini API key is a **separate** login-Keychain item: service `Mailspring-demo Gemini Developer API`, account `gemini-demo-api-key`, via `app/native/gemini-demo-keychain` (Security.framework). It is not KeyManager/safeStorage.

If a Keychain dialog names **Mailspring Safe Storage**, deny it — that is the production item. Demo must not request it. A dialog for **Mailspring-demo Gemini Developer API** is the intended DEMO secret prompt (Allow / Deny). Deny is fail-closed (no plaintext fallback).

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
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-real-selected-summary.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-archive.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-snapshot.ts
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
| `test-real-adapter.ts` | **23** |
| `test-isolation.ts` | **15** |
| `test-integration.ts` | 18 |
| `test-mail-database.ts` | **23** |
| `test-demo-sidebar.ts` | **23** |
| `test-demo-query.ts` | **20** |
| `test-ai-boundary.ts` | **19** |
| `test-gemini-demo.ts` | **41** (mocked transport + KEY_FILE + Keychain helper + dummy non-overwrite contract) |
| `test-real-selected-summary.ts` | **17** (fake ids only; no live mail/keys) |
| `test-offline-archive.ts` | **19** (fixtures + IMAP plan; no Yahoo / no paid call) |
| `test-offline-snapshot.ts` | **22** (fake IMAP only; retry/hash/verify/keychain; no Yahoo / no credentials / no paid call) |
| `test-demo-cli.ts` | **16** |
| **prior portable subtotal** | **298** |
| `test-composer-direction.ts` | 14 |
| `test-composer-spell.ts` | 21 |
| `test-demo-composer.ts` | 13 |
| **composer subtotal (no sidecar)** | **48** |
| `test-nspell-engine.ts` | **13** (requires sidecar install) |
| **portable total after sidecar** | **359** |

Without sidecar install: prior **346** (298+48) + alt-cwd composer **48** still apply. After `install.sh`: **359** portable (346+13). Composer+engine alt-cwd remains **61** (48+13) unless `test-ai-boundary.ts` / `test-gemini-demo.ts` / `test-real-selected-summary.ts` / `test-offline-archive.ts` / `test-offline-snapshot.ts` are included. Do not run these in cloud CI. Preserve 34a90265 layout/AI/isolation. Do not rewrite `app/package-lock.json`.

**This SHA targeted Mac commands (do not claim f89b4e4b 221+61 / 81 UI):**

```bash
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-ai-boundary.ts
# expected 19 passed, natural exit
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-gemini-demo.ts
# expected 41 passed (mocked transport + KEY_FILE + Keychain helper + dummy non-overwrite contract; no live Gemini)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-real-selected-summary.ts
# expected 17 passed (fake test-real-msg-1 only; no live Yahoo / no paid call)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-archive.ts
# expected 19 passed (local fixtures + IMAP plan; no Yahoo / no paid call)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-snapshot.ts
# expected 22 passed (fake IMAP retry/hash/verify/keychain; no Yahoo / no credentials / no paid call)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-query.ts
# expected 20 passed (exhaustive 2/5/6 + first-selected vs all-selected)
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-sidebar.ts
# expected 23 passed (store fail-closed + 299pt scrollport)
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
No Keychain dialog for `Mailspring Safe Storage`. A dialog for `Mailspring-demo Gemini Developer API` is the dedicated DEMO Gemini item (not Safe Storage).
After dictionary add: `Mailspring-demo/spell-personal-dictionary.json` exists; `~/Library/Spelling` and `.../Mailspring/` (production) are not written.

Quit with Cmd+Q.

## Prerequisites

Apple Silicon, Node 24 at `/opt/homebrew/bin` is fine. Leave `/Applications/Mailspring.app` closed.

`npm start` (dev, no `--demo`) still shows onboarding if there is no account. That is intentional.

## Official paid Gemini Developer API (DEMO synthetic only)

This is the **Gemini Developer API** billed through AI Studio / Cloud Billing. It is **not a consumer Gemini** app subscription (Google AI Pro / Gemini in a browser). An API key or the model id **cannot prove billing** is linked. Do not treat a key as a free-tier-only project prerequisite — live execution requires an explicitly configured **paid** project/key plus `paid=1` in the Keychain blob (or KEY_FILE). Launch-env `MAILSPRING_DEMO_GEMINI_PAID` is ignored and is not billing proof.

Pinned model: `gemini-3.5-flash-lite` (no auto-substitution). Official Interactions REST:

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Headers: `x-goog-api-key`, `Content-Type: application/json`, `Api-Revision: 2026-05-20`. REST body is an Interaction resource: `status` plus `steps[]` (`type=model_output`, `content[].type=text` JSON). `output_text` is an SDK convenience, not a REST field. Also accept `output: [json string]` as observed on a standalone HTTP 200. Distinguish `failed` / `incomplete` / empty from schema failure. Do not mock-fallback or substitute the model.

Native 856fbc6d (existing main 72367, one Send on synthetic `שרשור פגישת צוות (2 הודעות)`): UI `Gemini response missing output_text`. HTTP status/body/tokens were **not captured** — do not infer a native HTTP 200 from that string. No further paid requests until this parser is on the running app.

Sources: https://ai.google.dev/gemini-api/docs/get-started · https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/billing · https://ai.google.dev/gemini-api/terms#data-use-paid

Listed paid price for this model as of 2026-11-08: **$0.30 input / $2.50 output per 1M tokens** (output includes thinking). Parent is researching rates, prepaid amount, and spend controls. App token estimates are **not** a cost ceiling.

### Data use (do not over-claim)

Paid-tier docs currently say prompts/responses are **not used to improve Google products**, and Google acts as a data processor. Google still logs prompts/responses **for a limited period** to detect policy violations and for legal disclosures (no day count published). That is **not zero** retention. Whether an abuse review can involve a human reading logs is **not stated**. Do not promise zero retention or no human access.

### Billing gates (parent, not this SHA)

- Prepaid minimum **$5**; unused credits expire after 12 months.
- Keep **auto-reload** **OFF** unless the parent later enables it.
- Spend caps are **not** a true real-time hard stop: billing can lag about **10 minute**s and overshoot a cap or a $0 prepay balance. Batch/agent jobs can overshoot further.
- Linking billing and issuing live generations is **not authorized** until the parent settles price/budget/key.

### Local env (Keychain usual launch — not launch-env KEY/PAID)

Native 33d7f263: JS `delete process.env` contained Chromium children (2 renderers, GPU, utility, Crashpad — 15 absences) but **Electron main** and the **Node** `./node_modules/.bin/electron` **launcher** still exposed `MAILSPRING_DEMO_GEMINI_API_KEY`, the public marker, and `MAILSPRING_DEMO_GEMINI_PAID` in macOS `ps eww` exec-time environ. JS deletion is not OS launch-env secrecy.

Usual delivery: save once into the dedicated DEMO Keychain item, then launch with **no** credential names. `scripts/gemini-demo-keychain.sh save` compiles `app/native/gemini-demo-keychain` with `swiftc -framework Security` if needed, then reads the key from a **hidden Terminal prompt** (`stty -echo`) and pipes `paid=0|1` plus the key to helper **stdin**. `save` is **SecItemAdd only** — if the real item already exists it exits conflict (4) and does **not** delete or overwrite. Deliberate overwrite is `replace` (`SecItemUpdate`; failure leaves the old item). Dummy tests use a **separate** service `Mailspring-demo Gemini Developer API (dummy)` / account `gemini-demo-api-key-dummy`. Never put the secret on process argv (including Keychain CLI password flags). Default item ACL; `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; not iCloud-syncable; no trusted-app ACL bypass. Denied / locked / cancelled access is fail-closed (no plaintext fallback). OS may prompt Allow.

`paid=1` in the stored blob is an operator ack, not proof of Cloud Billing, and is distinct from `keyPresent=true` and from `billingProven` (always false here). Launch does **not** auto-generate and does **not** copy `MAILSPRING_DEMO_GEMINI_API_KEY` from the environment into Keychain (setup refuses if that name is set).

```bash
# Close the demo app first. Hidden prompt on this Mac — do not paste a real key
# into git, screenshots, argv, chat, or this cloud agent.
unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID MAILSPRING_DEMO_GEMINI_KEY_FILE
sh scripts/gemini-demo-keychain.sh save
# prompt: key (hidden), then paid ack 0 or 1
sh scripts/gemini-demo-keychain.sh status   # present=true|false only
sh scripts/start-demo-gemini.sh
# later launches: sh scripts/start-demo-gemini.sh
# replace / remove:
# sh scripts/gemini-demo-keychain.sh replace
# sh scripts/gemini-demo-keychain.sh remove
```

Explicit KEY_FILE fallback remains: a **0600** file whose **first line** is `paid=0` or `paid=1` and whose remainder is the key, launched with **only** `MAILSPRING_DEMO_GEMINI_KEY_FILE`. Main unlinks the file after read. Unlink is not a disk-wipe or OS-memory-erasure guarantee. If KEY_FILE is set, Keychain is not consulted.

```bash
# Explicit KEY_FILE fallback — not the usual launch.
unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID
umask 077
cat > /tmp/ms-gemini-cred <<'EOF'
paid=1
…paid project key…
EOF
chmod 600 /tmp/ms-gemini-cred
export MAILSPRING_DEMO_GEMINI_KEY_FILE=/tmp/ms-gemini-cred
sh scripts/start-demo-gemini.sh
```

`scripts/start-demo-gemini.sh` execs `Electron.app/Contents/MacOS/Electron` (not the Node shim) with `env -u MAILSPRING_DEMO_GEMINI_API_KEY -u MAILSPRING_DEMO_GEMINI_PAID`. Usual launch also unsets `MAILSPRING_DEMO_GEMINI_KEY_FILE`.

`paid=0` is **configured key, paid-disabled**: stdout `[Gemini DEMO] status keyPresent=true paidAcknowledged=false configured=false billingProven=false (credential value not logged)` and the UI stays **Mock AI**. That is expected. A Gemini error must not fall back to mock fixtures. Local Cancel/timeout abort the process fetch; they do **not** guarantee the provider stopped a billed generation.

Do **not** launch with `MAILSPRING_DEMO_GEMINI_API_KEY=… MAILSPRING_DEMO_GEMINI_PAID=1 electron ./app` or `node ./node_modules/.bin/electron`. That is the 33d7f263 failing recipe. Main ignores those names if present; `ps eww` on main/launcher still shows the original exec environ.

Do not paste a real key into git, screenshots, argv, renderer UI, or logs. IPC and stdout status report booleans only.

### UNRUN native process-boundary (NONSECRET marker — never a real key)

Native e1ec474c: renderer PID 70413 inherited the named key. Native 33d7f263: children ABSENT (15 pass); Electron main PID 71003 and Node launcher PID 71001 still true/true/true for key-name, public marker, paid-name. AX collection 30s timeout — `data-gemini-status` UNVERIFIED. Repeat this **boolean** check on the new SHA before any secret-bearing launch. Do **not** print environ. Do **not** use a real key. Close the running demo app before updating this Mac.

**1. Dummy Keychain save / launch / relaunch / delete** (isolated dummy namespace). Public marker only. `dummy-save` / `dummy-remove` never call helper `save`/`remove` and never query the real item. Record real `status` first; it must be unchanged after dummy-save and after dummy-remove. Do **not** run dummy-* on a0427637 (that revision could clobber the real item).

```bash
# UNRUN native Keychain dummy. Isolated dummy item. Public marker only. No real key. No argv secret.
unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID MAILSPRING_DEMO_GEMINI_KEY_FILE
unset MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE
# Boolean only — do not load/print any value.
REAL_BEFORE=$(sh scripts/gemini-demo-keychain.sh status)
echo "real-before $REAL_BEFORE"   # present=true|false only
sh scripts/gemini-demo-keychain.sh dummy-save
sh scripts/gemini-demo-keychain.sh dummy-status   # present=true
sh scripts/gemini-demo-keychain.sh status         # MUST equal $REAL_BEFORE
MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy sh scripts/start-demo-gemini.sh --force-renderer-accessibility
# expect: capture source=keychain keyPresent=true paidAcknowledged=false configured=false
# quit, relaunch still with NAMESPACE=dummy — still keyPresent=true from dummy item
MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE=dummy sh scripts/start-demo-gemini.sh --force-renderer-accessibility
sh scripts/gemini-demo-keychain.sh dummy-remove
sh scripts/gemini-demo-keychain.sh dummy-status   # present=false
sh scripts/gemini-demo-keychain.sh status         # MUST still equal $REAL_BEFORE
unset MAILSPRING_DEMO_GEMINI_KEYCHAIN_NAMESPACE
sh scripts/start-demo-gemini.sh --force-renderer-accessibility
# expect: keyPresent follows the real item (false if REAL_BEFORE was present=false)
```

Denied / cancelled Keychain prompt must stay fail-closed (`source=keychain-denied`, Mock AI).

**2. Optional KEY_FILE dummy** (explicit fallback, not usual launch):

```bash
unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID
umask 077
MARKER_FILE=$(mktemp /tmp/ms-gemini-XXXXXX)
# Path must not contain the marker string.
printf 'paid=0\nMAILSPRING_DEMO_GEMINI_NONSECRET_MARKER\n' > "$MARKER_FILE"
chmod 600 "$MARKER_FILE"
export MAILSPRING_DEMO_GEMINI_KEY_FILE="$MARKER_FILE"
sh scripts/start-demo-gemini.sh --force-renderer-accessibility
```

From another terminal, inspect **own** checkout processes only (`--user-data-dir=.../Mailspring-demo`). Record booleans for whether **key-name** `MAILSPRING_DEMO_GEMINI_API_KEY`, **public marker** `MAILSPRING_DEMO_GEMINI_NONSECRET_MARKER`, and **paid-name** `MAILSPRING_DEMO_GEMINI_PAID` are present in OS environ (`ps eww` / equivalent). Do not dump environ.

| Process | 33d7f263 | Expected this SHA |
| --- | --- | --- |
| start-demo-gemini.sh launcher (not npm, not `node .bin/electron`) | Node launcher true/true/true | all three **ABSENT** |
| Electron main (`.../MacOS/Electron ./app`) | true/true/true | all three **ABSENT** |
| `--type=renderer` (e1ec474c failing case) | ABSENT | ABSENT |
| `--type=gpu-process` | ABSENT | ABSENT |
| `--type=utility` | ABSENT | ABSENT |
| `chrome_crashpad_handler` | ABSENT | ABSENT |

Usual Keychain launch: `MAILSPRING_DEMO_GEMINI_KEY_FILE` **ABSENT** on launcher/main too. KEY_FILE fallback: that name **may** be present on launcher/main (path only). It must not appear on renderer/gpu/utility/crashpad. Marker must not appear as a **value** anywhere.

Stdout (AX-free; 33d7f263 AX 30s timeout left status UNVERIFIED):

```
[Gemini DEMO] capture source=keychain keyPresent=true paidAcknowledged=false (credential value not logged)
[Gemini DEMO] status keyPresent=true paidAcknowledged=false configured=false billingProven=false (credential value not logged)
```

KEY_FILE fallback prints `source=key-file` instead. Those lines must not contain the marker. Sidebar **Mock AI** is expected for paid-disabled. Do **not** claim actual live UI until a parent native test with `paid=1` (still synthetic DEMO, still not authorized here).

Portable Node equivalent (already in `test-gemini-demo.ts`): mocked helper capture; denied fail-closed; dummy-save/remove cannot clobber a real-namespace sentinel; save conflict retains; KEY_FILE capture; launch-env KEY ignored; child spawned after capture prints `ABSENT` for key-name, paid-name, and marker-in-values.

**3. Once dummy Keychain tests pass — real-key setup (parent Mac only, never this agent):**

```bash
unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID MAILSPRING_DEMO_GEMINI_KEY_FILE
sh scripts/gemini-demo-keychain.sh save    # hidden prompt; paid ack 0 or 1
sh scripts/start-demo-gemini.sh
```

Never place the key on process argv. This SHA does **not** authorize a paid call.

dbagent / Hunspell / mailsync / localAI spawn sanitization remains **UNRUN** natively (JS `sanitizeSpawnEnv` still applied). Not packaging, not real mail.

Remaining gates before live execution: this native main+launcher+child boolean check passing, paid project + key, Cloud Billing linked (not inferable from the key), prepaid amount, auto-reload off, budget/cap accepted with overshoot risk, official data-use terms accepted, then a separate approval to admit real mail. No live Gemini / billing calls on this SHA.

## Opt-in one selected Yahoo message (Mailspring-dev only)

User approval covers **one selected message** the user picks, sent only after **Summarize**. It is not broad mailbox access and not a profile migration.

**Safe launch (parent Mac; leave the currently running DEMO window alone until closure coordination):**

```bash
# From the source checkout. Never --user-data-dir at production Mailspring/.
# Never copy official profile/Keychain/account configs.
unset MAILSPRING_DEMO_GEMINI_API_KEY MAILSPRING_DEMO_GEMINI_PAID MAILSPRING_DEMO_GEMINI_KEY_FILE
sh scripts/start-real-selected-summary.sh
```

Consequential remaining user step if `~/Library/Application Support/Mailspring-dev/` has no account: onboarding asks for a **separate** Yahoo login into Mailspring-dev. That is a new OAuth + local cache, not a copy of the official app. If Mailspring-dev already has a Yahoo from a prior `npm start`, use that. Do not log in from this cloud agent.

**Staged native validation (parent only; no cloud mail/keys):**

1. Confirm `/Applications/Mailspring.app` is still the official build and still running its own profile. This source Electron must show app name / userData **Mailspring-dev**.
2. Confirm `--demo` is **not** on the argv. Synthetic DEMO remains the default via `start-demo-gemini.sh`.
3. Pick **exactly one** message (one-message thread, or expand exactly one message in a thread). Preview identity + disclosure must appear **before** Summarize. Load/select must not generate.
4. Click **Summarize** once. No automatic retry. Host must reject multi-select, folder/all-mail, and a changed selection.
5. Citations open an in-sidebar preview of **that same message**. Unread state must not change; the AI feature must not send/delete/move.
6. Do not paste message content, credentials, or Keychain values into chat/logs.

Known limits: quoted neighboring HTML is stripped (disclosed); attachments are not sent (count disclosed); body truncated at 8000 characters; `--demo` cannot see Yahoo (`skipMailsync`); official app does not load this extension.

**Current user direction supersedes this live login.** Do not continue `--real-selected-summary` onboarding. Use the disconnected archive path below.

## Disconnected Yahoo archive (Mailspring-offline)

Goal: a **complete local archive** on the Mac, a **read-only backup baseline**, and a **disposable working copy** for experiments. No synchronization back to Yahoo. No live account credentials or mailsync in the experiment reader. Gemini remains allowed only for **explicit Summarize of one selected local message**, separately disclosed, never automatic bulk upload.

### What is not the acquisition path

- Official `/Applications/Mailspring.app` profile (`~/Library/Application Support/Mailspring/`, `edgehill.db`, Keychain) is **not a complete backup**. bodyProgress can leave bodies missing. Do not copy, scrape, or point `--user-data-dir` at it.
- Built-in folder export (`GetManyRFC2822Task`) needs **live mailsync**, is folder-at-a-time, and skips `drafts` / `starred` / `unread` roles (`EXCLUDED_EXPORT_ROLES`). It is not a full mailbox snapshot and is not a new export UI.
- `--demo` is synthetic fixtures. `--real-selected-summary` is live Yahoo in Mailspring-dev. Neither is this mode.

### Supported acquisition (standalone snapshotter; native Yahoo is parent-only)

Read-only IMAP snapshot lives in `app/src/offline-snapshot/`. The Mailspring-offline experiment app **does not import it** and cannot see Yahoo credentials or open IMAP. This cloud agent does not connect to Yahoo and does not take credentials.

Allowlisted commands: `LIST` `EXAMINE` `UID FETCH … (RFC822.SIZE)` `UID FETCH … BODY.PEEK[]`. Forbidden: `STORE` `EXPUNGE` `MOVE` `APPEND` `COPY` `SELECT` `FETCH BODY[]` `FETCH RFC822` (those can set `\Seen` or mutate). Resume key is `folder + UIDVALIDITY + UID`. TLS for Yahoo is `imap.mail.yahoo.com:993` with `rejectUnauthorized: true`. Password default is a **hidden Terminal prompt**. Non-TTY execute is `--password-from-keychain` only (login generic password, service `Mailspring-offline Yahoo IMAP`, account = `--username`; never argv, env, or logs). `--secret-from-stdin` is fake-server tests only.

No-args still refuses to connect (exit 2):

```bash
sh scripts/offline-imap-snapshot.sh
```

Fake-server unit tests (this SHA; no Yahoo):

```bash
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-snapshot.ts
```

**Staged native run (parent Mac only; not initiated here):**

1. Yahoo IMAP login. **App password is often required.** Do not scrape `/Applications/Mailspring.app`, `Mailspring-dev`, Keychain, or `edgehill.db`. Do not invent an in-app export UI.
2. Hidden TTY password prompt on the Mac. Refuses `--password`, `YAHOO_IMAP_PASSWORD`, and piped stdin on the Yahoo host.
3. Preflight (LIST + EXAMINE + SIZE + disk; no BODY.PEEK dest write):

   ```bash
   sh scripts/offline-imap-snapshot.sh --preflight-only --username 'you@yahoo.com'
   ```

4. Disk check **before** BODY.PEEK must cover **baseline + independent work copy**, not a single tree: `rfc822Bytes * 1.15 * 2 + 64MiB`. Unknown RFC822.SIZE values are counted and block execute unless you pass `--allow-unknown-sizes` (still disclosed, not skipped).
5. Inventory is the **server LIST**, including Bulk Mail / Spam / Trash / Draft / Starred / Unicode names. Unselectable, empty, examine-failed, UIDVALIDITY mismatch, UID gaps, messages that arrived during the snapshot, and missing typical folders (e.g. Archive) are recorded in the manifest — **no silent exclusions**. Already-expunged mail cannot be recovered.
6. Execute to a **new empty** destination (never overwrites a preexisting complete archive). Atomic `{uid}.eml.partial` → `{uid}.eml`. Transient IMAP/network failures reconnect (fresh TLS, in-memory password, re-EXAMINE, UIDVALIDITY must match) with bounded backoff. Resume of an existing partial dest is the **same** `--execute --dest` (55bab0ba `snapshot-state.json` shape). Then copy to a disposable working tree.

   Hidden TTY prompt is the default. For a **non-TTY / background bot** (no Terminal), store the Yahoo app password once in the login Keychain (`security add-generic-password … -T '' -w`; first access may prompt Allow), then:

   ```bash
   # Non-interactive resume/execute (no Terminal). Password from Keychain only.
   mkdir -p /abs/offline-archive-baseline
   nohup sh scripts/offline-imap-snapshot.sh \
     --execute \
     --username 'you@yahoo.com' \
     --dest /abs/offline-archive-baseline \
     --work-copy /abs/offline-archive-work \
     --password-from-keychain \
     >/abs/offline-archive-baseline/snapshot-console.log 2>&1 &

   # Monitor (counts only; no secrets):
   tail -f /abs/offline-archive-baseline/snapshot-progress.log
   cat /abs/offline-archive-baseline/snapshot-status.json
   ```

   Same command resumes a partial dest. Keychain denied/locked/missing is fail-closed (no argv/env/stdin fallback). Optional `--keychain-service` overrides the default service `Mailspring-offline Yahoo IMAP` (account is `--username`).

   Interactive Terminal (hidden prompt, no Keychain):

   ```bash
   sh scripts/offline-imap-snapshot.sh \
     --execute \
     --username 'you@yahoo.com' \
     --dest /abs/offline-archive-baseline \
     --work-copy /abs/offline-archive-work
   ```

   Whole-archive `sha256` covers every finalized `.eml` on disk (including prior resume runs). Offline check (no network, no password):

   ```bash
   sh scripts/offline-imap-snapshot.sh \
     --verify \
     --dest /abs/offline-archive-baseline \
     --work-copy /abs/offline-archive-work
   ```

7. Point the experiment reader at the **work copy**, never at credentials:

   ```bash
   sh scripts/start-offline-archive.sh /abs/offline-archive-work
   ```

Immutability is **process never writes the baseline after finalize** plus **refuse overwrite** — not a claim that `chmod` made the tree immutable. MIME display decode is **partial** (`display-parse-partial`); nested `message/rfc822` is noted, not expanded. Gemini stays opt-in per selected local message; import does not generate.

Remaining native/auth gates this cloud SHA does **not** perform: Yahoo app-password, TTY prompt, real TLS to `imap.mail.yahoo.com`, actual mailbox bytes, Mac disk confirmation.

### Experiment reader (fixture-testable; no Yahoo)

```bash
# Fixture tree (fake @example.test addresses only). Does not touch Yahoo.
sh scripts/start-offline-archive.sh \
  "$PWD/app/internal_packages/ai-sidebar/fixtures/offline-archive"
```

Identity: **Mailspring-offline**, `skipMailsync`, mock keychain, no `edgehill.db`, `core.reading.autoloadImages=false`, no onboarding. Official app unused. Network is **not** globally blocked (Gemini fetch must still work on explicit Summarize). Yahoo IMAP is not opened at an architecture boundary (`skipMailsync` + catalog import, not a blanket offline firewall).

Gemini: one selected local message after Summarize. Not bulk corpus upload. Same dedicated DEMO Keychain item / KEY_FILE as other launchers; KEY/PAID names stay unset.

Imported HTML: scripts, `on*` handlers, and remote `https` images are stripped. Original archive files are never written. Local deletion in the working copy cannot reach Yahoo.

Remaining actual export/native gates: user login + disk confirmation + IMAP snapshot on the Mac. This SHA is a fake-server-testable snapshotter plus a fixture-testable reader. Native Yahoo is not initiated here.
