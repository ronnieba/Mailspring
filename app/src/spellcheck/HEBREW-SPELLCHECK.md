# Hebrew spellchecking — native listed vs bundled dictionary

The DEMO overlay’s two authored typos (`misspelledd`, `איותת`) exist only to exercise suggestion / personal-dictionary UI. They are **not** a Hebrew dictionary and must not be described as fulfilling general Hebrew spelling.

This Mac session may list **`he`** in `availableSpellCheckerLanguages`. That means native `NSSpellChecker` Hebrew is **listed**. It does **not** mean underlines/suggestions are proven, and it does **not** mean a bundled Hspell dictionary was shipped.

**Native Hebrew runtime verification is pending** on the target Mac (non-fixture words + real context menu). Do not label native Hebrew universally BLOCKED from a missing bundled dictionary, and do not claim it fully works until parent records ordinary-word behavior.

## What this SHA does deliver

- Per-paragraph RTL/LTR on the real Slate `ComposerEditor` (not app-wide `dir`). Homogeneous Hebrew paragraphs get `lang="he"`, homogeneous English `lang="en"`, mixed paragraphs omit `lang` so the OS can auto-detect.
- Native Chromium/OS spellcheck **on** (`nativeSpellCheck={true}` plus `session.setSpellCheckerEnabled(true)`). Languages listed this session, including `he` when present, are passed to `setSpellCheckerLanguages` (no-op on macOS; still required on Win/Linux).
- User-invoked overlay suggestions and add/remove for **UI-test fixture typos only**.
- Personal dictionary JSON under the isolated config dir. DEMO never writes `~/Library/Spelling`.
- Status region `מצב בודק איות`: `data-hebrew-native="listed|absent"`, `data-hebrew-runtime="pending"`, `data-hebrew-bundled="not-shipped"`.

## Platform (Electron / macOS)

Official: https://www.electronjs.org/docs/latest/tutorial/spellchecker

| Platform | Engine | `setSpellCheckerLanguages` | Hebrew |
|----------|--------|----------------------------|--------|
| macOS | `NSSpellChecker` (not Hunspell) | **No-op** (Electron [#35514](https://github.com/electron/electron/pull/35514)). OS auto-detects language. | If `he` is listed this session, enable native detection. Parent must still verify underlines and context-menu suggestions on **non-fixture** words. Do not treat a missing `he` as proof that macOS Hebrew is universally unavailable. |
| Windows / Linux | Hunspell | Required; unknown codes can throw | Chromium ships `he_IL` Hunspell files (see below). Unused on macOS. |

Hunspell unused on macOS (Electron uses `NSSpellChecker` only).

`session.addWordToSpellCheckerDictionary` on macOS writes `~/Library/Spelling`. DEMO `learnWord` uses `Mailspring-demo/spell-personal-dictionary.json` instead.

Default Hunspell dictionary downloads use a **Google CDN**. This change does not enable that path.

## Offline Hebrew dictionaries investigated (bundled path)

| Source | Vocab | Size (order) | License | Why not bundled here |
|--------|-------|--------------|---------|----------------------|
| **Hspell 1.4** (current; LibreOffice `he_IL`, Mozilla) | Full morphological Hebrew | `.aff` tens of KB + generated word lists large | **AGPL-3+** on programs **and** dictionary files | Shipping it would AGPL the combined work. Mailspring is GPL-3.0. **Not shipped.** This is the bundled-dictionary gap, not a native-unavailable claim. |
| **Hspell 1.0 → Chromium `he_IL.dic`** | Older general Hebrew (2000–2006) | ~3.2 MB | GPL (Hspell 1.0) | Electron **does not run Hunspell on macOS**. Not shipped. |
| Authored fixture list in `word-lists.ts` | Two UI-test typos + tiny demo sentences | few KB | GPL-3.0-or-later | **UI-test only.** |

## Parent native acceptance (do not skip)

Use the isolated demo composer. Do **not** infer results from the two overlay fixtures.

### Overlay vs native

| Mechanism | Words | How to accept |
|-----------|-------|----------------|
| UI-test overlay | only `misspelledd`, `איותת` | Caret in the word → region `הצעות איות` → `החלף ב-misspelled` / `החלף ב-איות`. AX Press, Space, and Enter must replace. |
| Native OS/Chromium | everything else | Red native underline + **real right-click / Control-click** context menu (`misspelledWord` / `dictionarySuggestions`). `AXShowMenu` is **not** sufficient (it may show Cut/Copy/Paste only). |

### Non-fixture examples (type these; overlay must stay silent)

After **טען טיוטת DEMO מחדש** so fixtures are intact, append a new paragraph or edit paragraph 5:

| Script | Correct (should not be overlay-flagged) | Intentional typo (native may underline) |
|--------|------------------------------------------|-----------------------------------------|
| English | `watermelon` | `recieve` or `mispelled` (one s — **not** `misspelledd`) |
| Hebrew | `אבטיח` | `אבטיחחח` or `חשבנוית` |

1. Overlay (`data-spell-error`) must **not** wrap `אבטיח`, `watermelon`, `recieve`, `אבטיחחח`.
2. Place the caret in the intentional typo, wait ~1s (`spellcheck` re-enables after typing).
3. **Real right-click** (two-finger or Control-click) on that word.
4. Record whether the menu contains native suggestions and whether choosing one replaces only that word via `webContents.replaceMisspelling`.
5. Learn Spelling in DEMO must write `Mailspring-demo/spell-personal-dictionary.json` only — never `~/Library/Spelling`.

If `he` is listed and native Hebrew suggestions appear for `אבטיחחח`, report **native Hebrew listed and observed**. If `he` is listed but the menu has no spelling items, report **native Hebrew listed, runtime verification pending** (do not relabel unavailable). General / bundled Hebrew remains **not complete**.
