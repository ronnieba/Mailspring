# Hebrew spellchecking — native listed vs bundled dictionary

The DEMO overlay’s two authored typos (`misspelledd`, `איותת`) exist only to exercise suggestion / personal-dictionary UI. They are **not** a Hebrew dictionary and must not be described as fulfilling general Hebrew spelling.

This Mac session may list **`he`** in `availableSpellCheckerLanguages`. That means native `NSSpellChecker` Hebrew is **listed**. Listing is not underlines and not guesses, and it is not a bundled Hspell dictionary.

**Listing ≠ detection ≠ suggestions.** Source reports listing from `availableSpellCheckerLanguages` only; it cannot see Chromium underlines. 733ff115 on one Mac recorded red underlines on non-fixture `recieve` / `אבטיחחח` (correct `watermelon` / `אבטיח` not underlined) with empty `dictionarySuggestions` (**No Guesses Found**). That is **detection observed, suggestions not proven**. Do not label native Hebrew universally BLOCKED, and do not claim full spell completion from a language list or underlines.

## What this SHA does deliver

- Per-paragraph RTL/LTR on the real Slate `ComposerEditor` (not app-wide `dir`). Homogeneous Hebrew paragraphs get `lang="he"`, homogeneous English `lang="en"`, mixed paragraphs omit `lang` so the OS can auto-detect.
- Native Chromium/OS spellcheck **on** (`nativeSpellCheck={true}` plus `session.setSpellCheckerEnabled(true)`). Languages listed this session, including `he` when present, are passed to `setSpellCheckerLanguages` (no-op on macOS; still required on Win/Linux).
- User-invoked overlay suggestions and add/remove for **UI-test fixture typos only**.
- Personal dictionary JSON under the isolated config dir. DEMO never writes `~/Library/Spelling`.
- Status region `מצב בודק איות`: `data-hebrew-native="listed|absent"`, `data-hebrew-detection="unproven"`, `data-hebrew-suggestions="unproven"`, `data-hebrew-bundled="not-shipped"`. Detection/suggestions stay `unproven` in source because the session list cannot observe underlines or guesses.

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

Reload the demo draft, replace the body with four paragraphs (or append). Overlay must stay silent on all of these.

| Role | English | Hebrew |
|------|---------|--------|
| Correct (no underline expected) | `watermelon` · `invoice` | `אבטיח` · `שלום` |
| Typo that English checkers often guess | `teh` → the · `recieve` → receive · `seperate` → separate · `mispell` → misspell | — |
| Typo that may underline with **no** guesses | `recieve` (if macOS Spelling is Automatic) · `qqqqxxxx` | `אבטיחחח` · `חשבנוית` · `שלומ` |

1. Overlay (`data-spell-error`) must **not** wrap these words.
2. Wait ~1s after typing (`spellcheck` re-enables).
3. **Real right-click / Control-click** (not AXShowMenu).
4. Menu wiring: misspelled word → either suggestion items (`replaceMisspelling`) **or** disabled `לא נמצאו ניחושים` / `No Guesses Found`, then Learn Spelling / Cut / Copy. Empty guesses with a red underline is a **platform result** ([electron#24455](https://github.com/electron/electron/issues/24455), macOS Spelling = Automatic by Language), not a missing menu. Do not treat that as full spell completion, and do not invent replacements.
5. If a suggestion **is** listed, choose it; only that word must change. Never silent auto-correct.
6. Learn Spelling in DEMO writes `Mailspring-demo/spell-personal-dictionary.json` only — never `~/Library/Spelling`. Do not click it unless that is the case under test.

733ff115 on one Mac: `recieve` and `אבטיחחח` were red-underlined; `watermelon` / `אבטיח` were not; both typo menus showed **No Guesses Found**. That is **detection observed, suggestions not proven**.

Optional OS check (not a product patch): System Settings → Keyboard → Text Input → Spelling. If it is Automatic by Language, try U.S. English, relaunch demo, and retry `teh` / `recieve`. Report either **suggestions observed** or **native listed, guesses empty**.

If `he` is listed and Hebrew suggestions appear, report listed+guesses. If listed, underlined, empty guesses: **native Hebrew listed, suggestions not proven**. General/bundled Hebrew remains not complete.
