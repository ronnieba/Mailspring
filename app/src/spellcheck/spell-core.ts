import { englishWordSet, FIXTURE_TYPOS, hebrewWordSet } from './word-lists';

export type WordScript = 'en' | 'he';

export interface Token {
  word: string;
  start: number;
  end: number;
  script: WordScript;
}

const EN_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
// Letters stay in a letter class. Niqqud/cantillation are \p{Mn} after a letter so
// combining marks are not listed next to bases in one class (that looks like one
// grapheme but matches two code points — no-misleading-character-class).
const HE_RE =
  /[\u05D0-\u05EA]\p{Mn}*(?:[\u05D0-\u05EA]\p{Mn}*|[\u05F3\u05F4'’"][\u05D0-\u05EA]\p{Mn}*)*/gu;

const NIQQUD_RE = /[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7]/g;
const URL_RE = /https?:\/\/[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;

export function stripNiqqud(word: string): string {
  return word.replace(NIQQUD_RE, '');
}

export function urlOrEmailRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function overlapsUrl(start: number, end: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((r) => start < r.end && end > r.start);
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const skip = urlOrEmailRanges(text);
  const collect = (re: RegExp, script: WordScript) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsUrl(start, end, skip)) continue;
      const word = m[0];
      if (script === 'he' && !stripNiqqud(word).replace(/[\u05F3\u05F4'’"]/g, '')) continue;
      tokens.push({ word, start, end, script });
    }
  };
  collect(EN_RE, 'en');
  collect(HE_RE, 'he');
  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

export interface SpellCheckContext {
  personal: Set<string>;
  english: Set<string>;
  hebrew: Set<string>;
}

export function defaultSpellCheckContext(personal: Iterable<string> = []): SpellCheckContext {
  return {
    personal: new Set(Array.from(personal).map((w) => w.toLowerCase())),
    english: englishWordSet(),
    hebrew: hebrewWordSet(),
  };
}

export function isKnownWord(word: string, script: WordScript, ctx: SpellCheckContext): boolean {
  if (ctx.personal.has(word.toLowerCase()) || ctx.personal.has(word)) {
    return true;
  }
  if (script === 'en') {
    return ctx.english.has(word.toLowerCase());
  }
  return ctx.hebrew.has(word);
}

/**
 * Closed-world scan against the tiny authored lists. Not the DEMO overlay.
 * DEMO_EN_MISS flags `in`; DEMO_HE_MISS flags `בפסקה`/`העברית`. Overlay
 * uses findFixtureTypos so those surrounding tokens stay unflagged.
 */
export function findMisspellings(text: string, ctx: SpellCheckContext): Token[] {
  return tokenize(text).filter((t) => !isKnownWord(t.word, t.script, ctx));
}

export interface FixtureTypo extends Token {
  suggestion: string;
}

/** UI-test overlay: only the known DEMO typos. Never mutates text. */
export function findFixtureTypos(text: string, personal: Iterable<string> = []): FixtureTypo[] {
  const skip = new Set(Array.from(personal).map((w) => w.toLowerCase()));
  const out: FixtureTypo[] = [];
  for (const t of tokenize(text)) {
    const suggestion = FIXTURE_TYPOS[t.word];
    if (!suggestion) continue;
    if (skip.has(t.word.toLowerCase()) || skip.has(t.word)) continue;
    out.push({ ...t, suggestion });
  }
  return out;
}

export function suggestionsFor(word: string, script: WordScript, ctx: SpellCheckContext): string[] {
  const dict =
    script === 'en'
      ? [...ctx.english, ...ctx.personal]
      : [...ctx.hebrew, ...Array.from(ctx.personal)];
  const ranked = dict
    .map((candidate) => ({
      candidate,
      d: levenshtein(word.toLowerCase(), candidate.toLowerCase()),
    }))
    .filter((x) => x.d > 0 && x.d <= 2)
    .sort((a, b) => a.d - b.d || a.candidate.localeCompare(b.candidate));
  const out: string[] = [];
  for (const { candidate } of ranked) {
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= 5) break;
  }
  return out;
}

export function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string
): string {
  return text.slice(0, start) + replacement + text.slice(end);
}
