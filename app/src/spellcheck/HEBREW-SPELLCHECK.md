# Native spellcheck vs bundled dictionaries

The DEMO overlay’s two authored typos (`misspelledd`, `איותת`) exist only to exercise suggestion / personal-dictionary UI. They are **not** a Hebrew or English dictionary and must not be described as general spellcheck.

**Listing ≠ detection ≠ suggestions.** Source reports listing from `availableSpellCheckerLanguages` only.

## 34a90265 native evidence (this Mac)

Isolated demo composer, Electron 44.9.1, real right-click (not AXShowMenu). Overlay silent on all eleven probes. Session listed `en-US` and `he`.

| Word | lang | Native underline | Context menu |
|------|------|------------------|--------------|
| `watermelon` | en | no | no spelling section |
| `invoice` | en | no | no spelling section |
| `teh` | en | **no** | no spelling section — do not claim complete English detection |
| `recieve` | en | yes | **לא נמצאו ניחושים** / No Guesses Found |
| `seperate` | en | yes | No Guesses Found |
| `mispell` | en | yes | No Guesses Found |
| `אבטיח` | he | no | no spelling section |
| `שלום` | he | no | no spelling section |
| `אבטיחחח` | he | yes | No Guesses Found |
| `חשבנוית` | he | yes | No Guesses Found |
| `שלומ` | he | yes | No Guesses Found |

That is **detection observed, suggestions not proven** for both languages. `replaceMisspelling` was not exercised because Electron delivered no guesses. Fixture overlay replacements are not this path.

Exported probe HTML had `lang="en"` on the English words and `lang="he"` on the Hebrew words. English probe paragraphs also had `dir="rtl"` (Select-All overwrite of the RTL fixture). That is recorded, not treated as the proven cause of empty guesses: the same empty-`dictionarySuggestions` result is documented for English-only Electron apps.

## Why `dictionarySuggestions` is empty (OS / Electron, not a missing menu)

The custom context menu **did** run: `misspelledWord` was set (Learn Spelling / No Guesses Found appeared) and `dictionarySuggestions` was `[]`. Wiring:

- `webPreferences.spellcheck: true`
- `nativeSpellCheck={true}` + `session.setSpellCheckerEnabled(true)`
- `event.preventDefault()` then `nativeContextSpellItems(params)` → `replaceMisspelling` only for real guesses
- Empty guesses → disabled localized No Guesses Found (never invented)

Electron has **no API** to fetch extra guesses when `params.dictionarySuggestions` is empty. `session.setSpellCheckerLanguages` is a **no-op on macOS** ([#35514](https://github.com/electron/electron/pull/35514)). Official docs: [SpellChecker](https://www.electronjs.org/docs/latest/tutorial/spellchecker) — macOS uses native APIs and automatically detects language; Hunspell is not used.

Matching upstream:

- [electron#24455](https://github.com/electron/electron/issues/24455): on macOS, `dictionarySuggestions` is an empty array while underlines still appear when System Settings → Spelling is **Automatic by Language** (the default). Reporters saw guesses only after setting an **explicit** language (e.g. U.S. English) and restarting. Chrome (the browser) could still suggest in both modes; Electron did not. Closed stale; not fixed in a later Electron API.
- [electron#29685](https://github.com/electron/electron/issues/29685): empty suggestions on **Windows** due to `WinRetrieveSuggestionsOnlyOnDemand`. That flag is not this Mac failure.

This app cannot set the user’s Spelling language, write `~/Library/Spelling`, or call `NSSpellChecker setLanguage:` without a new native bridge. Changing System Settings is **not** a product patch and is **not** done here.

**Conclusion:** empty guesses on 34a90265 for both English and Hebrew are an **actual OS/Electron limitation**, not an integration hole in the context-menu handler. Keep `hebrewNativeSuggestions: 'unproven'`. Do not invent replacements.

Optional parent experiment (not required, not a source fix): if this Mac’s Spelling is Automatic by Language, set it to U.S. English, relaunch **only** the isolated demo, retry `recieve`. Report guesses or still-empty. Revert the OS setting afterward. Do not treat that as shipping a product capability.

## What this SHA does deliver

- Per-paragraph RTL/LTR on the real Slate `ComposerEditor`. Homogeneous Hebrew paragraphs get `lang="he"`, homogeneous English `lang="en"`, mixed paragraphs omit `lang`.
- Native Chromium/OS spellcheck **on**. `setSpellCheckerLanguages` still called with listed codes (required on Win/Linux; no-op on macOS).
- User-invoked overlay suggestions and add/remove for **UI-test fixture typos only**.
- Personal dictionary JSON under the isolated config dir. DEMO never writes `~/Library/Spelling`.
- Status region `מצב בודק איות`: `data-hebrew-native="listed|absent"`, `data-hebrew-detection="unproven"`, `data-hebrew-suggestions="unproven"`, `data-hebrew-bundled="not-shipped"`.

Hunspell unused on macOS (Electron uses `NSSpellChecker` only). Default Hunspell downloads use a Google CDN; this change does not enable that path.

## Bundled-engine options (user decision required)

None of these are implemented. They need an explicit product decision. No network dictionary service, LanguageTool, paid API, or OS-global dictionary writes.

GPL-3 (Mailspring) **can** combine with AGPL-3 (GPL-3 §13). The **combined distribution** must then honor AGPL-3 §13 (network source offer). That is an extra obligation vs today’s GPL-3-only shipping — a license-policy decision, not “AGPL is illegal to combine.”

| Option | Languages | Engine | License | Tradeoff | Decision needed |
|--------|-----------|--------|---------|----------|-----------------|
| **A. Keep native-only** (current) | Whatever NSSpellChecker detects | Electron/macOS | n/a | Underlines observed; guesses empty under Automatic-by-Language; `teh` not flagged | None. Honest detection ≠ completion. |
| **B. In-process English Hunspell/nspell** | English | `nspell` (MIT) + `dictionary-en` / SCOWL (permissive, attribution) | MIT + SCOWL/BSD-style; GPL-3 compatible | Real English suggestions without OS Spelling. Hebrew unchanged. New dependency + `webFrame.setSpellCheckProvider`. nspell is not full Hunspell morphology. | Approve English-only local engine + vendor the word list with notices. |
| **C. WASM Hunspell (hunspell-asm)** | Any Hunspell `.aff/.dic` we ship | Hunspell in WASM | Wrapper MIT; Hunspell MPL-1.1 / GPL-2+ / LGPL-2.1+ (can be used under GPL-3) | Closer to Chromium Win/Linux. Still need a **Hebrew dictionary license**. ~engine size. | Approve WASM Hunspell **and** pick a Hebrew dictionary from D/E/F. |
| **D. Hspell 1.4 / `dictionary-he` / LibreOffice he_IL** | Modern morphological Hebrew | Hunspell WASM (nspell rejected) | **AGPL-3.0** on aff/dic (package.json and Hspell 1.4 header: version 3, no independent “or later” grant verified). Packaging MIT. | Best Hebrew vocab. GPL-3 §13 allows combination; combined **distribution** still needs AGPL-3 §13 review. | Private Hunspell WASM + dictionary-he sidecar. Do not commit aff/dic. |
| **E. Chromium `he_IL` from Hspell 1.0 (2000–2006)** | Older general Hebrew | Needs C | Chromium `README_he_IL.txt`: **GPL, version not specified**. If GPL-2-**only**, it cannot mix with GPL-3; if GPL-2-or-later, it can. | Incomplete vs modern Hebrew. Electron still will not load Hunspell on macOS without C. | License review of that dump **before** shipping. |
| **F. Authored fixture list** | `misspelledd` / `איותת` only | Overlay | GPL-3.0-or-later | UI-test only. **Not** general spellcheck. | Already shipped. Do not relabel. |

Rejected without a separate decision: LanguageTool / grammar cloud, Google Hunspell CDN downloads, writing `~/Library/Spelling`, changing the user’s Spelling language from the app.

## Private Hunspell WASM prototype (this SHA)

Sidecar `app/src/spellcheck/offline-prototype/` pins `hunspell-asm@4.0.2`, `dictionary-en@4.0.0`, `dictionary-he@2.0.0`. **Install locally only:**

```bash
bash app/src/spellcheck/offline-prototype/install.sh
```

That does **not** modify `app/package-lock.json`. `node_modules` is gitignored. Aff/dic are **not** in the public PR. `nspell` is **not** installed.

**nspell rejected (native 7c346435):** `test-nspell-engine.ts` printed four passes (pins, no vendored aff/dic, tokenizer, affix inspection) then stalled on the first `nspell(aff, dic)` construct — 194s, 99% CPU, 1,377,552 KiB RSS, SIGTERM 143. `correct()` / `suggest()` were never reached. nspell `lib/util/add.js` + `apply.js` expand every PFX/SFX continuation into a JavaScript object key at load; `dictionary-he` has `PFX a N 962`. Hunspell applies affixes at check time in a **child process** with hard timeouts (`LOAD_TIMEOUT_MS=8000`, `CORRECT_TIMEOUT_MS=2000`, `SUGGEST_TIMEOUT_MS=2000`). Timeout is reported (`data-offline-spell="timeout"`, popover `ההצעות חרגו מהזמן`), not hidden as “no guesses.”

Verified from `dictionary-he` 2.0.0 `index.aff` (Hspell 1.4): PFX clitics (no SFX, no COMPLEXPREFIXES). **MAP** and **BREAK** are present; Hunspell honors them (nspell did not). Dictionary license stays AGPL-3.0.

UI: general typos get accessible `החלף ב-…` buttons (same AX as fixtures). Suggestions are computed when the popover opens, in the worker, not on every keystroke. Personal JSON remains app-scoped. No silent replace. Fixtures `misspelledd` / `איותת` stay fixture-backend.

**Distribution:** do not publish sidecar `node_modules`, combined installers, or a modified covered network service until notices + AGPL-3 §13 review. GPL-3 §13 does not automatically relicense Mailspring. Hunspell tri-license is GPL-3 compatible; that does not change the AGPL dictionary obligation.

## Parent native acceptance

Use the isolated demo composer. Do **not** infer results from the two overlay fixtures.

| Mechanism | Words | How to accept |
|-----------|-------|----------------|
| UI-test overlay | only `misspelledd`, `איותת` | `החלף ב-misspelled` / `החלף ב-איות`. AX Press, Space, Enter. |
| Offline Hunspell WASM (after sidecar install) | `recieve`/`seperate`/`mispell`; `אבטיחחח`/`חשבנוית`/`שלומ`; clitics `הבית` | Overlay **or** popover `החלף ב-receive` etc. Only that word changes. Neighbors and paragraph `dir` stay. `watermelon`/`invoice`/`אבטיח`/`שלום` must **not** be flagged. Status `data-offline-spell="ready"`. Timeout must say timeout, not “no guesses.” |
| Native OS/Chromium | same non-fixture words | Red underline + **real right-click**. Empty guesses remain an OS/Electron limitation. Do not treat Hunspell buttons as native NSSpellChecker completion. |

If `הבית` is unknown while `בית` is known: **Hunspell PFX blocked** — report, do not skip Hebrew coverage. If Hebrew `suggest` exceeds 2s: worker SIGTERM and `timeout` UI — report, do not hang. Record misclassifications; fixtures are not completion.

Bundled Hspell files are **not shipped** in git.
