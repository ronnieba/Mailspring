/**
 * Electron/macOS spellchecker availability.
 *
 * Official: https://www.electronjs.org/docs/latest/tutorial/spellchecker
 * - macOS uses NSSpellChecker (OS language packs), not Hunspell.
 * - session.setSpellCheckerLanguages is a no-op on macOS (Electron #35514).
 * - Windows 10+ uses the Windows spell checker when available, else Hunspell.
 * - Linux uses Hunspell.
 * - session.setSpellCheckerLanguages can throw on Win/Linux for unknown codes.
 * - session.addWordToSpellCheckerDictionary on macOS writes ~/Library/Spelling.
 *   Demo must never call it.
 *
 * Do not claim macOS Hebrew is unavailable from source alone. Report whatever
 * this session's availableSpellCheckerLanguages contains; parent verifies
 * NSSpellChecker on the target Mac. See ./HEBREW-SPELLCHECK.md.
 */

export interface SpellBackendStatus {
  sessionLanguages: string[];
  english: { listedInSession: boolean; code: string | null };
  hebrew: { listedInSession: boolean; code: string | null };
  hebrewGeneral: 'blocked';
  hebrewUiTestOverlay: 'fixture-typos-only';
  note: string;
}

export function pickSupportedLanguage(available: string[], wanted: string[]): string | null {
  const set = new Set(available.map((s) => s.toLowerCase()));
  for (const code of wanted) {
    if (set.has(code.toLowerCase()))
      return available.find((s) => s.toLowerCase() === code.toLowerCase()) || code;
    const prefix = code.split('-')[0];
    const hit = available.find(
      (s) => s.toLowerCase() === prefix || s.toLowerCase().startsWith(`${prefix}-`)
    );
    if (hit) return hit;
  }
  return null;
}

export function describeSpellBackends(available: string[]): SpellBackendStatus {
  const english = pickSupportedLanguage(available, ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en']);
  const hebrew = pickSupportedLanguage(available, ['he', 'he-IL', 'iw']);
  return {
    sessionLanguages: [...available],
    english: { listedInSession: !!english, code: english },
    hebrew: { listedInSession: !!hebrew, code: hebrew },
    hebrewGeneral: 'blocked',
    hebrewUiTestOverlay: 'fixture-typos-only',
    note: [
      'macOS: setSpellCheckerLanguages is a no-op; NSSpellChecker auto-detects.',
      'Hebrew listed in this session: ' + (hebrew || 'no'),
      'That list is not a claim about every Mac. Parent must verify.',
      'General Hebrew spellchecking: BLOCKED (Hspell 1.4 AGPL-3; Hunspell unused on macOS).',
      'UI-test overlay: fixture typos misspelledd / איותת only — not a Hebrew dictionary.',
    ].join(' '),
  };
}

export function formatBackendStatusText(status: SpellBackendStatus): string {
  const en = status.english.listedInSession
    ? `English native (this session): ${status.english.code}`
    : 'English native (this session): not listed in availableSpellCheckerLanguages';
  const he = status.hebrew.listedInSession
    ? `Hebrew listed in this session: ${status.hebrew.code}`
    : 'Hebrew listed in this session: no (not a universal macOS claim — parent must verify NSSpellChecker)';
  return [
    en,
    he,
    'General Hebrew: BLOCKED — see HEBREW-SPELLCHECK.md',
    'UI-test overlay: fixture typos only, not a dictionary',
    'No silent auto-correct',
    status.note,
  ].join(' · ');
}

export function languagesToEnable(
  available: string[],
  preferred: string | null | undefined
): string[] {
  const out: string[] = [];
  const add = (code: string | null) => {
    if (code && !out.includes(code)) out.push(code);
  };
  if (preferred) {
    add(pickSupportedLanguage(available, [preferred]));
  }
  add(pickSupportedLanguage(available, ['en-US', 'en-GB', 'en']));
  add(pickSupportedLanguage(available, ['he', 'he-IL', 'iw']));
  return out;
}
