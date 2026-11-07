# Hebrew spellchecking — remaining blocker

**General Hebrew spellchecking is not delivered in this change.** The DEMO overlay’s few authored words exist only to exercise suggestion / personal-dictionary UI. They are not a Hebrew dictionary and must not be described as fulfilling the owner’s Hebrew spelling requirement.

## What this SHA does deliver

- Per-paragraph RTL/LTR on the real Slate `ComposerEditor` (not app-wide `dir`).
- Native Chromium/OS **English** spellcheck (production composer unchanged; DEMO composer leaves `nativeSpellCheck` on).
- User-invoked suggestions and add/remove for **UI-test fixture typos only** (`misspelledd`, `איותת`).
- Personal dictionary JSON under the isolated config dir. DEMO never writes `~/Library/Spelling`.
- Runtime status from `session.availableSpellCheckerLanguages` for **this session**, plus the blocker note below.

## Platform (Electron / macOS)

Official: https://www.electronjs.org/docs/latest/tutorial/spellchecker

| Platform | Engine | `setSpellCheckerLanguages` | Hebrew |
|----------|--------|----------------------------|--------|
| macOS | `NSSpellChecker` (not Hunspell) | **No-op** (Electron [#35514](https://github.com/electron/electron/pull/35514)). OS auto-detects language. | **Parent must verify on the target Mac.** Do not treat a missing `he` in `availableSpellCheckerLanguages` as proof that macOS Hebrew is universally unavailable. Apple’s published Sonoma built-in spelling list (community doc) names 24 languages and does **not** list Hebrew; that is secondary evidence only. Users can add `.dic`/`.aff` under `~/Library/Spelling` (OS-global — DEMO must not). |
| Windows / Linux | Hunspell | Required; unknown codes can throw | Chromium ships `he_IL` Hunspell files (see below). Unused on macOS. |

Hunspell unused on macOS (Electron uses `NSSpellChecker` only).

`session.addWordToSpellCheckerDictionary` on macOS writes `~/Library/Spelling`. DEMO `learnWord` uses `Mailspring-demo/spell-personal-dictionary.json` instead.

Default Hunspell dictionary downloads use a **Google CDN**. This change does not enable that path.

## Offline Hebrew dictionaries investigated

| Source | Vocab | Size (order) | License | Why not bundled here |
|--------|-------|--------------|---------|----------------------|
| **Hspell 1.4** (current; LibreOffice `he_IL`, Mozilla) | Full morphological Hebrew — the real dictionary | `.aff` tens of KB + generated word lists large | **AGPL-3+** on programs **and** dictionary files / generated word lists ([ivrix/hspell](https://github.com/ivrix/hspell), Debian `hspell`, LibreOffice `dictionaries/he_IL`) | Shipping it would require treating the combined work as AGPL-3. Mailspring is GPL-3.0. Not a silent license change for this PR. |
| **Hspell 1.0 → Chromium `he_IL.dic`** | Older general Hebrew (2000–2006) | ~3.2 MB `.dic` + `.aff`; ~2.2 MB `.bdic` | README_he_IL.txt: **GPL** (Hspell 1.0) | License is GPL-compatible, but Electron **does not run Hunspell on macOS**. Using it would need a separate engine (`nspell` / WASM Hunspell): new dependency, ~3 MB payload, 2006 morphology, still no native Mac path. Out of scope; not “small.” |
| Authored fixture list in `word-lists.ts` | ~25 Hebrew + ~25 English demo words | few KB | GPL-3.0-or-later with this tree | **UI-test only.** Not general vocabulary. |

There is no other maintained, general-vocabulary, non-AGPL Hebrew spell dictionary that is both small and affix-aware. A plain frequency list (Wikipedia, etc.) is not a spellchecker for inflected Hebrew.

## What parent should verify on Mac (do not skip)

1. Log `session.availableSpellCheckerLanguages` from the DEMO composer status region (`מצב בודק איות`).
2. With native spellcheck on, type ordinary Hebrew **outside** the fixture typos (e.g. a word not in `word-lists.ts`) and see whether Chromium/`NSSpellChecker` underlines it and offers suggestions.
3. Confirm `he` / `he-IL` presence or absence **for that machine** — report the observed list; do not copy a cloud-agent guess.

If native Hebrew works on that Mac, production composer already uses the same `spellCheck` attribute and context-menu suggestions (Learn Spelling still writes the OS dictionary in non-demo). If it does not, general Hebrew remains blocked until a licensed Hunspell engine + dictionary decision (AGPL 1.4 vs vendoring Chromium GPL 1.0 + JS Hunspell) is made explicitly.
