# Offline Hunspell WASM prototype — notices (no dictionary files here)

This directory is a **private local evaluation**. Do not publish installers, do not
commit `node_modules`, and do not host a modified covered service until a
distribution review.

| Package | Pinned | License (exact) | What it is |
|---------|--------|-----------------|------------|
| `hunspell-asm` | 4.0.2 | **MIT** wrapper | WASM bindings. Embedded Hunspell is **MPL-1.1 / GPL-2+ / LGPL-2.1+** (`hunspell-version` `fc6a952-200131`). |
| `dictionary-en` | 4.0.0 | **(MIT AND BSD)** (SCOWL/Ispell attribution) | English `index.aff` / `index.dic` |
| `dictionary-he` | 2.0.0 | **AGPL-3.0** on aff/dic (package.json `"license": "AGPL-3.0"`; Hspell 1.4 header says GNU Affero GPL **version 3**, no independent “or later” grant verified). Packaging/JS wrapper MIT in wooorm/dictionaries. | Hebrew Hunspell files from Hspell 1.4 |
| `nspell` | **not installed** | MIT | Rejected. See below. |

Upstream:

- https://github.com/kwonoj/hunspell-asm (MIT; Hunspell tri-license)
- https://github.com/wooorm/dictionaries/tree/main/dictionaries/en
- https://github.com/wooorm/dictionaries/tree/main/dictionaries/he
- http://hspell.ivrix.org.il/ (Hspell 1.4)

## GPL-3 (Mailspring) and AGPL-3 (dictionary-he aff/dic)

- GPL-3 **§2** allows making, running, and propagating **non-conveyed** covered works.
  A private desktop prototype that is not distributed is not a conveyance.
- GPL-3 **§13** permits **combining** GPL-3 and AGPL-3. GPL terms continue for the
  GPL-covered part. AGPL-3 **network source-offer** requirements apply to the
  **combination as such**. This does **not** automatically relicense all of
  Mailspring as AGPL.
- Hunspell’s MPL/GPL/LGPL tri-license can be used under GPL-3. That does not
  change the AGPL-3.0 dictionary obligation.
- Whether a given package is an aggregate vs a combined/derived work needs a
  packaging review **before** publishing covered assets, builds, or offering a
  covered network service.

**Before publishing** `index.aff` / `index.dic`, a combined build, or a service
that modifies and offers the covered dictionaries: complete source/notices and
AGPL-3 §13 review, or obtain differently licensed Hebrew data.

## nspell rejected (native 7c346435)

`nspell@2.1.5` is **not** the runtime. Native `test-nspell-engine.ts` printed four
passes (pins, no vendored aff/dic, tokenizer, affix inspection) then stalled on
the first `nspell(aff, dic)` construct: 194s, 99% CPU, 1,377,552 KiB RSS,
SIGTERM 143. `correct()` / `suggest()` were never reached.

nspell `lib/util/add.js` stores every generated form as a JavaScript object key
at load. `lib/util/apply.js` recursively applies PFX/SFX continuations.
`dictionary-he` 2.0.0 `index.aff` has `PFX a N 962` (clitic combinations). That
eager expansion is unsuitable for this dictionary; Hunspell applies affixes at
check time in C++/WASM instead.

nspell also lacks MAP and BREAK (present in the Hebrew aff). Switching engines
does **not** change the AGPL-3.0 dictionary license.
