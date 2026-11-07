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
3. **Overlay accept:** caret in `misspelledd` / `איותת` → `הצעות איות` → replace. AX Press and keyboard must succeed, not only mouse. Type `אבטיח`: overlay must **not** underline it.
4. **Dictionary add:** `הוסף למילון האישי`. File: `~/Library/Application Support/Mailspring-demo/spell-personal-dictionary.json` only.
5. **Dictionary remove:** `הסר מהמילון האישי: misspelledd`. Overlay for **that word** must reappear immediately (Hebrew mark stays). No reload/edit workaround.
6. **Layout at the real sidebar width (~300pt, not declared minWidth):** after add/remove, with the overlay popover open, paragraphs 4/5 must remain fully readable. `מילון אישי` / `אין מילים שמורות` / the footer must **not** paint over editor text. Scroll the editor workspace if needed; dictionary/status/actions stay in flow (opaque, not covering). Measured column width may stay ~299pt because the MessageListSidebar also hosts contact cards (`maxWidth: 300`).
7. **Native non-fixture suggestions:** reload, type `watermelon` / `teh` / `recieve` / `אבטיח` / `אבטיחחח`. Overlay silent. Wait ~1s. **Real right-click** on `teh` (often guessed as `the`) and on `recieve` / `אבטיחחח`. If the menu lists a guess, choose it — only that word changes (`replaceMisspelling`). If it shows `לא נמצאו ניחושים` with a red underline, that is empty `dictionarySuggestions` (Electron/macOS Automatic-by-language), **not** a missing menu. Detection ≠ suggestions ≠ overlay fixtures. Do not click Learn Spelling unless testing the isolated JSON.

If `he` is listed and Hebrew **guesses** appear, report listed+guesses. If listed, underlined, empty guesses: **native Hebrew listed, suggestions not proven**. Bundled Hspell remains not shipped.

There is no Send button on this surface. Production composer send/draft saving is unchanged. Overlay spell plugins are **not** in the default conversion plugin list.

### Spell backend provenance

**Bundled Hspell is not shipped (AGPL-3). Native listing is not detection; suggestions remain unproven.** Details: `app/src/spellcheck/HEBREW-SPELLCHECK.md`.

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
| `test-composer-direction.ts` | 14 |
| `test-composer-spell.ts` | 20 |
| `test-demo-composer.ts` | 13 |
| **new portable subtotal** | **47** |
| **portable total** | **207** |

Typecheck + lint locally. Do not run these in cloud CI. Cancellation was **not** rerun on 733ff115 — do not reuse old delayed-cancel UI.

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
