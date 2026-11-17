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
 * Do not claim macOS Hebrew is unavailable from source alone. If this session
 * lists `he` / `he-IL`, that is listing only — not underlines and not guesses.
 * 34a90265 on one Mac: recieve/seperate/mispell and אבטיחחח/חשבנוית/שלומ
 * underlined; dictionarySuggestions empty (No Guesses Found); teh not flagged.
 * That matches electron#24455 (macOS Automatic by Language) plus #35514
 * (setSpellCheckerLanguages is a no-op). Not a missing context-menu handler.
 * Listing ≠ detection ≠ suggestions. Bundled Hspell is not shipped (AGPL-3).
 * See ./HEBREW-SPELLCHECK.md.
 */

export interface SpellCheckerSession {
  setSpellCheckerEnabled?: (enable: boolean) => void;
  setSpellCheckerLanguages?: (languages: string[]) => void;
  setSpellCheckerMaxReplacements?: (max: number) => void;
  availableSpellCheckerLanguages?: string[];
}

export interface NativeContextSpellParams {
  misspelledWord?: string;
  dictionarySuggestions?: string[] | null;
}

export interface NativeContextSpellItems {
  misspelledWord: string | null;
  suggestions: string[];
  emptyGuesses: boolean;
}

/**
 * Map Electron context-menu spell fields. Empty suggestions with a misspelled
 * word is a valid NSSpellChecker/Electron result (often macOS “Automatic by
 * Language”) — show “No Guesses Found”, do not invent replacements.
 * https://github.com/electron/electron/issues/24455
 */
export function nativeContextSpellItems(
  params: NativeContextSpellParams | null | undefined
): NativeContextSpellItems {
  const misspelledWord =
    params && typeof params.misspelledWord === 'string' && params.misspelledWord.trim()
      ? params.misspelledWord
      : null;
  const raw = (params && params.dictionarySuggestions) || [];
  const suggestions = misspelledWord
    ? raw.filter((s) => typeof s === 'string' && s.length > 0 && s !== misspelledWord)
    : [];
  return {
    misspelledWord,
    suggestions,
    emptyGuesses: !!misspelledWord && suggestions.length === 0,
  };
}

/** Menu path only. Underlines are Chromium/OS; this does not infer detection. */
export function nativeGuessSupport(
  items: NativeContextSpellItems
): 'none' | 'empty-guesses' | 'has-suggestions' {
  if (!items.misspelledWord) return 'none';
  return items.emptyGuesses ? 'empty-guesses' : 'has-suggestions';
}

export type NativeSpellPhase = 'unproven';

export interface SpellBackendStatus {
  sessionLanguages: string[];
  english: { listedInSession: boolean; code: string | null };
  hebrew: { listedInSession: boolean; code: string | null };
  hebrewBundledDictionary: 'not-shipped';
  /** Source cannot see Chromium underlines. Session listing is not detection. */
  hebrewNativeDetection: NativeSpellPhase;
  /** Empty dictionarySuggestions is a valid platform result; guesses stay unproven. */
  hebrewNativeSuggestions: NativeSpellPhase;
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
    hebrewBundledDictionary: 'not-shipped',
    hebrewNativeDetection: 'unproven',
    hebrewNativeSuggestions: 'unproven',
    hebrewUiTestOverlay: 'fixture-typos-only',
    note: [
      'macOS: setSpellCheckerLanguages is a no-op; NSSpellChecker auto-detects.',
      'Hebrew listed in this session: ' + (hebrew || 'no'),
      hebrew
        ? 'Native Hebrew is listed. Listing is not detection. Suggestions unproven until a real right-click guess is chosen (not AXShowMenu). Empty dictionarySuggestions with a misspelledWord is a valid platform result.'
        : 'Hebrew not listed in this session. That is not a universal macOS result — parent must verify NSSpellChecker on this Mac.',
      'Bundled Hspell 1.4 is not shipped (AGPL-3). That is separate from whether NSSpellChecker lists Hebrew on this Mac.',
      'UI-test overlay: fixture typos misspelledd / איותת only — not a Hebrew dictionary.',
    ].join(' '),
  };
}

export function formatHebrewNativeSummary(status: SpellBackendStatus): string {
  if (status.hebrew.listedInSession) {
    return `Native Hebrew listed this session (${status.hebrew.code}) — listing is not detection; suggestions unproven`;
  }
  return 'Native Hebrew not listed this session — not a universal unavailable claim';
}

export function formatBackendStatusText(status: SpellBackendStatus): string {
  const en = status.english.listedInSession
    ? `English native (this session): ${status.english.code}`
    : 'English native (this session): not listed in availableSpellCheckerLanguages';
  const he = status.hebrew.listedInSession
    ? `Hebrew native listed (this session): ${status.hebrew.code} — listing is not detection; suggestions unproven`
    : 'Hebrew native listed (this session): no — not a universal macOS result; parent verifies NSSpellChecker';
  return [
    en,
    he,
    'Native detection (underlines) is not claimed from the language list',
    'Native suggestions unproven until a context-menu guess is chosen',
    'Bundled Hspell/Hunspell Hebrew dictionary: not shipped (AGPL-3)',
    'UI-test overlay: fixture typos only, not a dictionary',
    'No silent auto-correct',
    'Demo dictionary: Mailspring-demo JSON only, never ~/Library/Spelling',
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

/**
 * Turn native Chromium/OS spellcheck on for this session. Never downloads
 * dictionaries, never calls addWordToSpellCheckerDictionary.
 */
export function enableNativeSpellSession(
  session: SpellCheckerSession | null | undefined,
  preferred?: string | null
): string[] {
  if (!session) return [];
  try {
    if (typeof session.setSpellCheckerEnabled === 'function') {
      session.setSpellCheckerEnabled(true);
    }
  } catch {
    // Some sessions expose the method but reject in tests / early startup.
  }
  try {
    if (typeof session.setSpellCheckerMaxReplacements === 'function') {
      session.setSpellCheckerMaxReplacements(5);
    }
  } catch {
    // Optional Electron API; detection still works if this is missing.
  }
  const available = session.availableSpellCheckerLanguages || [];
  const list = languagesToEnable(available, preferred);
  if (list.length && typeof session.setSpellCheckerLanguages === 'function') {
    try {
      session.setSpellCheckerLanguages(list);
    } catch {
      // Unknown codes throw on Win/Linux; macOS treats this as a no-op.
    }
  }
  return list;
}
