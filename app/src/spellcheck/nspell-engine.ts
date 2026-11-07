/**
 * Private offline nspell prototype. Separate English/Hebrew instances.
 * Does not vendor dictionary files. Loads aff/dic from a local sidecar
 * install only. Never silently mutates text. Never writes ~/Library/Spelling.
 *
 * dictionary-he aff/dic: AGPL-3.0 (not an independently verified “or later”).
 * Do not publish those files or combined builds before distribution review.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Token, stripNiqqud, tokenize } from './spell-core';
import { FIXTURE_TYPOS } from './word-lists';

export const OFFLINE_SPELL_NOTICE =
  'nspell MIT · dictionary-en MIT AND BSD · dictionary-he aff/dic AGPL-3.0 · private local prototype · no auto-correct';

const SIDECAR = path.join(__dirname, 'offline-prototype');

export interface AffixCapabilityReport {
  file: string;
  hasComplexPrefixes: boolean;
  hasCircumfix: boolean;
  hasAfAliases: boolean;
  hasFullstrip: boolean;
  hasMap: boolean;
  hasBreak: boolean;
  hasIgnore: boolean;
  pfxClasses: number;
  sfxClasses: number;
  nspellUnsupportedPresent: string[];
}

export interface OfflineSpellStatus {
  available: boolean;
  english: boolean;
  hebrew: boolean;
  reason: string;
  nspellVersion: string | null;
  dictionaryEn: string | null;
  dictionaryHe: string | null;
  loadMs: number;
  licenses: {
    nspell: 'MIT';
    dictionaryEn: '(MIT AND BSD)';
    dictionaryHeAffDic: 'AGPL-3.0';
  };
}

type NSpellInstance = {
  correct: (word: string) => boolean;
  suggest: (word: string) => string[];
};

let cached: {
  status: OfflineSpellStatus;
  en: NSpellInstance | null;
  he: NSpellInstance | null;
  affEn: AffixCapabilityReport | null;
  affHe: AffixCapabilityReport | null;
} | null = null;

function candidateRoots(): string[] {
  const extra = process.env.MAILSPRING_OFFLINE_SPELL_DIR;
  return [
    extra || '',
    path.join(SIDECAR, 'node_modules'),
    path.join(process.cwd(), 'app/src/spellcheck/offline-prototype/node_modules'),
    path.join(process.cwd(), 'src/spellcheck/offline-prototype/node_modules'),
  ].filter(Boolean);
}

export function resolveDictionaryFiles(pkg: 'dictionary-en' | 'dictionary-he'): {
  aff: string;
  dic: string;
  root: string;
} | null {
  for (const root of candidateRoots()) {
    const aff = path.join(root, pkg, 'index.aff');
    const dic = path.join(root, pkg, 'index.dic');
    if (fs.existsSync(aff) && fs.existsSync(dic)) {
      return { aff, dic, root };
    }
  }
  return null;
}

export function inspectAffixFile(affPath: string): AffixCapabilityReport {
  const text = fs.readFileSync(affPath, 'utf8');
  const has = (re: RegExp) => re.test(text);
  const pfxClasses = (text.match(/^PFX \S+ [YN] \d+/gm) || []).length;
  const sfxClasses = (text.match(/^SFX \S+ [YN] \d+/gm) || []).length;
  const unsupported: string[] = [];
  if (has(/^COMPLEXPREFIXES/m)) unsupported.push('COMPLEXPREFIXES');
  if (has(/^CIRCUMFIX /m)) unsupported.push('CIRCUMFIX');
  if (has(/^AF /m)) unsupported.push('AF');
  if (has(/^FULLSTRIP/m)) unsupported.push('FULLSTRIP');
  if (has(/^MAP /m)) unsupported.push('MAP');
  if (has(/^BREAK /m)) unsupported.push('BREAK');
  if (has(/^IGNORE /m)) unsupported.push('IGNORE');
  return {
    file: affPath,
    hasComplexPrefixes: has(/^COMPLEXPREFIXES/m),
    hasCircumfix: has(/^CIRCUMFIX /m),
    hasAfAliases: has(/^AF /m),
    hasFullstrip: has(/^FULLSTRIP/m),
    hasMap: has(/^MAP /m),
    hasBreak: has(/^BREAK /m),
    hasIgnore: has(/^IGNORE /m),
    pfxClasses,
    sfxClasses,
    nspellUnsupportedPresent: unsupported,
  };
}

function requireNspell(): any {
  const fromSidecar = path.join(SIDECAR, 'node_modules', 'nspell');
  const tries = [fromSidecar, 'nspell'];
  for (const spec of tries) {
    try {
      return require(spec);
    } catch {
      // try next
    }
  }
  for (const root of candidateRoots()) {
    try {
      return require(path.join(root, 'nspell'));
    } catch {
      // try next
    }
  }
  throw new Error('nspell not found. Run app/src/spellcheck/offline-prototype/install.sh');
}

function readUtf8(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function loadOfflineSpellEngine(force = false): OfflineSpellStatus {
  if (cached && !force) return cached.status;
  const t0 = Date.now();
  const enFiles = resolveDictionaryFiles('dictionary-en');
  const heFiles = resolveDictionaryFiles('dictionary-he');
  const licenses = {
    nspell: 'MIT' as const,
    dictionaryEn: '(MIT AND BSD)' as const,
    dictionaryHeAffDic: 'AGPL-3.0' as const,
  };
  if (!enFiles && !heFiles) {
    cached = {
      status: {
        available: false,
        english: false,
        hebrew: false,
        reason:
          'Local dictionaries not installed. Run app/src/spellcheck/offline-prototype/install.sh (does not touch app/package-lock.json). dictionary-he aff/dic are AGPL-3.0 — do not commit node_modules.',
        nspellVersion: null,
        dictionaryEn: null,
        dictionaryHe: null,
        loadMs: Date.now() - t0,
        licenses,
      },
      en: null,
      he: null,
      affEn: null,
      affHe: null,
    };
    return cached.status;
  }
  let nspell: any;
  try {
    nspell = requireNspell();
  } catch (err: any) {
    cached = {
      status: {
        available: false,
        english: false,
        hebrew: false,
        reason: String(err && err.message ? err.message : err),
        nspellVersion: null,
        dictionaryEn: enFiles ? enFiles.root : null,
        dictionaryHe: heFiles ? heFiles.root : null,
        loadMs: Date.now() - t0,
        licenses,
      },
      en: null,
      he: null,
      affEn: enFiles ? inspectAffixFile(enFiles.aff) : null,
      affHe: heFiles ? inspectAffixFile(heFiles.aff) : null,
    };
    return cached.status;
  }
  let en: NSpellInstance | null = null;
  let he: NSpellInstance | null = null;
  try {
    if (enFiles) en = nspell(readUtf8(enFiles.aff), readUtf8(enFiles.dic));
  } catch (err: any) {
    cached = {
      status: {
        available: false,
        english: false,
        hebrew: false,
        reason: 'nspell failed on dictionary-en: ' + (err && err.message),
        nspellVersion: null,
        dictionaryEn: enFiles ? enFiles.root : null,
        dictionaryHe: heFiles ? heFiles.root : null,
        loadMs: Date.now() - t0,
        licenses,
      },
      en: null,
      he: null,
      affEn: enFiles ? inspectAffixFile(enFiles.aff) : null,
      affHe: heFiles ? inspectAffixFile(heFiles.aff) : null,
    };
    return cached.status;
  }
  try {
    if (heFiles) he = nspell(readUtf8(heFiles.aff), readUtf8(heFiles.dic));
  } catch (err: any) {
    cached = {
      status: {
        available: false,
        english: !!en,
        hebrew: false,
        reason: 'nspell failed on dictionary-he: ' + (err && err.message),
        nspellVersion: null,
        dictionaryEn: enFiles ? enFiles.root : null,
        dictionaryHe: heFiles ? heFiles.root : null,
        loadMs: Date.now() - t0,
        licenses,
      },
      en,
      he: null,
      affEn: enFiles ? inspectAffixFile(enFiles.aff) : null,
      affHe: heFiles ? inspectAffixFile(heFiles.aff) : null,
    };
    return cached.status;
  }
  let nspellVersion: string | null = null;
  try {
    nspellVersion = require(
      path.join(path.dirname(require.resolve('nspell')), '..', 'package.json')
    ).version;
  } catch {
    nspellVersion = '2.1.5';
  }
  cached = {
    status: {
      available: !!(en || he),
      english: !!en,
      hebrew: !!he,
      reason: OFFLINE_SPELL_NOTICE,
      nspellVersion,
      dictionaryEn: enFiles ? enFiles.root : null,
      dictionaryHe: heFiles ? heFiles.root : null,
      loadMs: Date.now() - t0,
      licenses,
    },
    en,
    he,
    affEn: enFiles ? inspectAffixFile(enFiles.aff) : null,
    affHe: heFiles ? inspectAffixFile(heFiles.aff) : null,
  };
  return cached.status;
}

export function offlineAffixReports(): {
  en: AffixCapabilityReport | null;
  he: AffixCapabilityReport | null;
} {
  loadOfflineSpellEngine();
  return { en: cached && cached.affEn, he: cached && cached.affHe };
}

function lookupWord(word: string, script: Token['script']): string {
  if (script === 'he') return stripNiqqud(word);
  return word;
}

export function offlineCorrect(word: string, script: Token['script']): boolean | null {
  loadOfflineSpellEngine();
  if (!cached) return null;
  const inst = script === 'he' ? cached.he : cached.en;
  if (!inst) return null;
  try {
    return inst.correct(lookupWord(word, script));
  } catch {
    return null;
  }
}

export function offlineSuggest(word: string, script: Token['script'], limit = 5): string[] {
  loadOfflineSpellEngine();
  if (!cached) return [];
  const inst = script === 'he' ? cached.he : cached.en;
  if (!inst) return [];
  const key = lookupWord(word, script);
  let raw: string[] = [];
  try {
    raw = inst.suggest(key) || [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !s || s === word || s === key) continue;
    if (script === 'he' && !/[\u05D0-\u05EA]/.test(s)) continue;
    if (script === 'en' && !/[A-Za-z]/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export interface OfflineTypo extends Token {
  suggestions: string[];
  backend: 'nspell';
}

export function findOfflineTypos(
  text: string,
  personal: Iterable<string> = [],
  opts: { includeSuggestions?: boolean } = {}
): OfflineTypo[] {
  const status = loadOfflineSpellEngine();
  if (!status.available) return [];
  const skip = new Set(Array.from(personal).map((w) => w.toLowerCase()));
  const out: OfflineTypo[] = [];
  for (const t of tokenize(text)) {
    if (FIXTURE_TYPOS[t.word]) continue;
    if (skip.has(t.word.toLowerCase()) || skip.has(t.word)) continue;
    const known = offlineCorrect(t.word, t.script);
    if (known === null || known) continue;
    out.push({
      ...t,
      backend: 'nspell',
      suggestions: opts.includeSuggestions ? offlineSuggest(t.word, t.script) : [],
    });
  }
  return out;
}
