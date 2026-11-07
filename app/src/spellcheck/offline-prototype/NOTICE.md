# Offline nspell prototype — notices (no dictionary files here)

This directory is a **private local evaluation**. Do not publish installers, do not
commit `node_modules`, and do not host a modified covered service until a
distribution review.

| Package | Pinned | License (exact) | What it is |
|---------|--------|-----------------|------------|
| `nspell` | 2.1.5 | **MIT** | JS Hunspell-like engine. Not full Hunspell. |
| `dictionary-en` | 4.0.0 | **(MIT AND BSD)** (SCOWL/Ispell attribution) | English `index.aff` / `index.dic` |
| `dictionary-he` | 2.0.0 | **AGPL-3.0** on aff/dic (package.json `"license": "AGPL-3.0"`; Hspell 1.4 header says GNU Affero GPL **version 3**, no independent “or later” grant verified). Packaging/JS wrapper MIT in wooorm/dictionaries. | Hebrew Hunspell files from Hspell 1.4 |

Upstream:

- https://github.com/wooorm/nspell (MIT)
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
- Whether a given package is an aggregate vs a combined/derived work needs a
  packaging review **before** publishing covered assets, builds, or offering a
  covered network service.
- Ordinary spellchecked mail text is not relicensed. A desktop checker is not a
  network service merely because the mail client can use the internet.

**Before publishing** `index.aff` / `index.dic`, a combined build, or a service
that modifies and offers the covered dictionaries: complete source/notices and
AGPL-3 §13 review, or obtain differently licensed Hebrew data.

## nspell limits (not Hunspell parity)

Supported: FLAG, PFX/SFX cross-products, REP, ICONV/OCONV, WORDCHARS, personal add.
**Not** supported: COMPLEXPREFIXES, CIRCUMFIX, AF aliases, FULLSTRIP, MAP, BREAK,
most compounding, IGNORE, MAXNGRAMSUGS.

`dictionary-he` 2.0.0 aff (Hspell 1.4): PFX clitics (no SFX, no COMPLEXPREFIXES);
**MAP** (final-letter lookalikes) and **BREAK** (quote/geresh edges) are present
and **ignored by nspell**. If those show up as blocked native cases, prefer
full Hunspell/WASM — switching engines does **not** change the AGPL-3 dictionary
license.
