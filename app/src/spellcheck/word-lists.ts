/**
 * UI-test fixture vocabulary only.
 *
 * This is NOT general Hebrew (or English) spellchecking. The DEMO overlay
 * uses FIXTURE_TYPOS to underline two known misspellings so suggestion and
 * personal-dictionary controls can be tested. Do not describe this file as
 * fulfilling Hebrew spelling.
 *
 * License: GPL-3.0-or-later with the Mailspring tree.
 * Not Hspell, not Hunspell, not Chromium he_IL.dic.
 *
 * See ./HEBREW-SPELLCHECK.md for the general-Hebrew blocker.
 */
export const SPELL_WORDLIST_LICENSE =
  'GPL-3.0-or-later (UI-test fixture typos only; not a Hebrew dictionary; not Hspell/Hunspell)';

export const SPELL_WORDLIST_PROVENANCE =
  'Mailspring-authored UI-test vocabulary. Not general-language spellchecking.';

/** Known DEMO typos → one user-invoked replacement. Overlay must not flag other words. */
export const FIXTURE_TYPOS: { [word: string]: string } = {
  misspelledd: 'misspelled',
  איותת: 'איות',
};

export const ENGLISH_FIXTURE_WORDS: string[] = [
  'hello',
  'team',
  'please',
  'review',
  'invoice',
  'this',
  'is',
  'a',
  'misspelled',
  'word',
  'meeting',
  'november',
  'the',
  'for',
  'and',
  'from',
  'last',
  'month',
  'synthetic',
  'demo',
  'message',
  'archive',
  'inbox',
  'selected',
  'paragraph',
  'direction',
  'english',
  'hebrew',
];

export const HEBREW_FIXTURE_WORDS: string[] = [
  'שלום',
  'צוות',
  'מצורפת',
  'החשבונית',
  'לחודש',
  'נובמבר',
  'לכולם',
  'זו',
  'שגיאת',
  'איות',
  'הודעה',
  'ארכיון',
  'תיבת',
  'דואר',
  'נכנס',
  'סינתטית',
  'ברוכים',
  'הבאים',
  'פגישת',
  'יום',
  'ראשון',
  'פסקה',
  'מימין',
  'לשמאל',
  'חשבונית',
];

export function englishWordSet(): Set<string> {
  return new Set(ENGLISH_FIXTURE_WORDS.map((w) => w.toLowerCase()));
}

export function hebrewWordSet(): Set<string> {
  return new Set(HEBREW_FIXTURE_WORDS);
}
