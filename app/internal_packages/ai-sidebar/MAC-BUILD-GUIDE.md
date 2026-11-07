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
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-composer-direction.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-composer-spell.ts
npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-composer.ts

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
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-composer-direction.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-composer-spell.ts"
# npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
#   "$REPO/app/internal_packages/ai-sidebar/test-demo-composer.ts"

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
5. Spell status region `מצב בודק איות` (`data-hebrew-general="blocked"`) must report **this session’s** `availableSpellCheckerLanguages`. Do **not** treat a missing `he` as proof that macOS Hebrew is universally unavailable — parent verifies `NSSpellChecker` on that Mac. Status must include **General Hebrew: BLOCKED** and **UI-test overlay: fixture typos only**. Native English spellcheck stays on (`nativeSpellCheck={true}`).

### Fixture paragraphs (synthetic in-memory draft)

| # | Explicit dir | Text |
|---|--------------|------|
| 1 | RTL | `שלום צוות, מצורפת החשבונית לחודש נובמבר.` |
| 2 | LTR | `Hello team, please review the invoice for November.` |
| 3 | RTL | `זו שגיאת איותת בפסקה העברית.` |
| 4 | LTR | `This is a misspelledd word in English.` |
| 5 | LTR | `Invoice 12345 — חשבונית 12345.` |

**UI-test overlay only** (never auto-corrected; **not** general Hebrew): English `misspelledd` → `misspelled`; Hebrew `איותת` → `איות`. Ordinary Hebrew such as `אבטיח` must **not** be flagged by the overlay. Native Chromium/OS English underlines remain on. Whether native Hebrew underlines appear is a **parent Mac observation**, not a cloud claim.

### Native verification cases

1. **Per-paragraph independence:** caret in paragraph 1, click `פסקה משמאל לימין (LTR)`. Paragraph 1 must flip LTR; paragraph 2 must stay LTR English; paragraph 3 must stay RTL Hebrew. Caret/selection must not jump to another paragraph. Numbers in paragraph 5 (`12345`) stay intact if you only change dir.
2. **Serialize/reopen:** click `סריאליזציה ופתיחה מחדש`. The HTML preview (`aria-label="HTML after serialize"`) must include `dir="rtl"` and `dir="ltr"` on the corresponding `<div>`s. After reopen, paragraph directions and mixed Hebrew/English text must match. This uses real `convertToHTML` / `convertFromHTML`, not a lookalike editor.
3. **Suggestion accept (UI-test typos only):** click into `misspelledd` (or `איותת`). Region `הצעות איות` appears (copy includes `not a Hebrew dictionary`). Click `החלף ב-misspelled` (or `החלף ב-איות`). Only that word changes. Type `אבטיח`: overlay must **not** underline it.
4. **Dictionary add:** with the fixture typo selected, `הוסף למילון האישי`. Overlay underline disappears; word appears under `מילון אישי`. File must be `~/Library/Application Support/Mailspring-demo/spell-personal-dictionary.json` — **never** `~/Library/Spelling` and never `.../Mailspring/` (production).
5. **Dictionary remove:** click `הסר מהמילון האישי: misspelledd` (list button) or the overlay remove control. Overlay flags the fixture typo again. Production OS dictionary must be untouched (`stat ~/Library/Spelling` timestamps unchanged if you check names only; do not edit it).
6. **Native English:** `misspelledd` may also be underlined by Chromium/OS spellcheck. Context-menu Learn Spelling in DEMO still writes the isolated JSON, not the OS dictionary.
7. **Native Hebrew:** record whether `he` appears in the status line and whether non-fixture Hebrew is underlined. That observation belongs in the parent report. Cloud agents must not pre-claim unavailable.

There is no Send button on this surface. Production composer send/draft saving is unchanged. Overlay spell plugins are **not** in the default conversion plugin list.

### Spell backend provenance

**General Hebrew spellchecking is a remaining blocker.** Details: `app/src/spellcheck/HEBREW-SPELLCHECK.md`.

| Backend | When | License / notes |
|---------|------|-----------------|
| Chromium/macOS `NSSpellChecker` | Production + DEMO `nativeSpellCheck={true}` | Official Electron docs: Hunspell is **not** used on macOS; `setSpellCheckerLanguages` is a **no-op**. Language auto-detect. Parent records `availableSpellCheckerLanguages` on the target Mac. |
| Chromium Hunspell `he_IL` | Win/Linux only | Chromium `he_IL.dic` is Hspell **1.0 / GPL** (~3.2 MB). Not loaded on macOS. Not vendored here (would need a JS Hunspell engine). |
| Hspell 1.4 / LibreOffice `he_IL` | Not shipped | **AGPL-3+** on dictionary files and generated word lists. Bundling would AGPL the combined work. Mailspring is GPL-3.0. |
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
| `test-demo-cli.ts` | 12 |
| **prior portable subtotal** | **160** |
| `test-composer-direction.ts` | 13 |
| `test-composer-spell.ts` | 17 |
| `test-demo-composer.ts` | 12 |
| **new portable subtotal** | **42** |
| **portable total** | **202** |

Plus prior native: CLI 12 / query 18 alternate-cwd, 29 native UI assertions. Typecheck + lint locally. Do not run these in cloud CI.

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
