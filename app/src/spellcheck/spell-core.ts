import { englishWordSet, FIXTURE_TYPOS, hebrewWordSet } from './word-lists';

export type WordScript = 'en' | 'he';

export interface Token {
  word: string;
  start: number;
  end: number;
  script: WordScript;
}

const EN_RE = /[A-Za-z']+/g;
const HE_RE = /[\u0590-\u05FF]+/g;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const collect = (re: RegExp, script: WordScript) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length, script });
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
