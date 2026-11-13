/**
 * Offline experiment: local full-text search over the read-only work copy.
 *
 * - The index is a SQLite FTS5 file inside the isolated offline profile
 *   (never inside the archive, never in baseline). Mail files are only read.
 * - Hebrew aware: niqqud/cantillation removed, final letters folded
 *   (ך→כ ם→מ ן→נ ף→פ ץ→צ), geresh/gershayim dropped, words also indexed
 *   without the one-letter prefixes ו ה ב כ ל מ ש; prefix matching.
 * - English / Latin: case and accents ignored.
 * - No network. Nothing here sends mail content anywhere.
 */
import * as fs from 'fs';
import * as path from 'path';

export const OFFLINE_SEARCH_DB = 'offline-search.sqlite';
/** Bump to rebuild every document (tokenizing / extraction changed). */
export const OFFLINE_SEARCH_VERSION = 2;
/** Bytes read from the start of each message for its text (bodies precede attachments). */
export const SEARCH_HEAD_BYTES = 1024 * 1024;
/** Body characters indexed per message. */
export const SEARCH_BODY_MAX_CHARS = 60000;
export const SEARCH_RESULT_LIMIT = 500;

const FINALS: { [k: string]: string } = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const HEB_PREFIX = 'והבכלמש';
const MARKS_RE = /\p{M}/gu;
const FINALS_RE = /[ךםןףץ]/g;
// Geresh / gershayim (and ASCII quotes used for them) between Hebrew letters: צה"ל → צהל
const GERESH_RE = /([\u05d0-\u05ea])["'\u05f3\u05f4\u2019\u201d]+(?=[\u05d0-\u05ea])/g;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/** The one normalization used for the index, queries and highlighting. */
export function normalizeSearchText(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(MARKS_RE, '')
    .toLowerCase()
    .replace(FINALS_RE, (c) => FINALS[c])
    .replace(GERESH_RE, '$1');
}

export function searchTokens(s: string): string[] {
  return normalizeSearchText(s).match(TOKEN_RE) || [];
}

function isHebrewWord(w: string): boolean {
  return /^[\u05d0-\u05ea]+$/.test(w);
}

/**
 * Hebrew words without their prefix letters (והבית → הבית, בית), so a search
 * for "בית" also finds "ובבית". Unique words only.
 */
export function hebrewPrefixVariants(normalized: string): string {
  const out = new Set<string>();
  for (const w of normalized.match(TOKEN_RE) || []) {
    if (!isHebrewWord(w)) {
      continue;
    }
    let cur = w;
    for (let i = 0; i < 3 && cur.length >= 4 && HEB_PREFIX.includes(cur[0]); i++) {
      cur = cur.slice(1);
      out.add(cur);
    }
  }
  return Array.from(out).join(' ');
}

// ---------------------------------------------------------------- query

export type SearchField = 'any' | 'subject' | 'from' | 'to' | 'body' | 'attach';

export type ParsedSearchQuery = {
  /** `or`: joined to the previous term with OR (a OR b) instead of AND. */
  terms: Array<{
    field: SearchField;
    words: string[];
    phrase: boolean;
    negate: boolean;
    or?: boolean;
  }>;
  hasAttachment: boolean | null;
  after: number | null;
  before: number | null;
  folders: string[];
  /** Normalized words to highlight. */
  highlight: string[];
};

const FIELD_ALIASES: { [k: string]: SearchField | 'has' | 'after' | 'before' | 'date' | 'folder' } =
  {
    from: 'from',
    מאת: 'from',
    מ: 'from',
    to: 'to',
    cc: 'to',
    אל: 'to',
    אלי: 'to',
    subject: 'subject',
    נושא: 'subject',
    body: 'body',
    גוף: 'body',
    תוכן: 'body',
    file: 'attach',
    filename: 'attach',
    attachment: 'attach',
    קובץ: 'attach',
    צרופה: 'attach',
    has: 'has',
    יש: 'has',
    after: 'after',
    since: 'after',
    אחרי: 'after',
    מתאריך: 'after',
    before: 'before',
    until: 'before',
    לפני: 'before',
    עדתאריך: 'before',
    date: 'date',
    תאריך: 'date',
    folder: 'folder',
    in: 'folder',
    תיקייה: 'folder',
    תיקיה: 'folder',
  };

/** YYYY, YYYY-MM, YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY -> [start, end) in local time. */
export function parseSearchDate(v: string): [number, number] | null {
  const s = v.trim();
  let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(s);
  let y: number;
  let mo: number | null = null;
  let d: number | null = null;
  if (m) {
    y = +m[1];
    mo = m[2] ? +m[2] : null;
    d = m[3] ? +m[3] : null;
  } else {
    m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
    if (!m) {
      return null;
    }
    d = +m[1];
    mo = +m[2];
    y = +m[3];
  }
  if ((mo !== null && (mo < 1 || mo > 12)) || (d !== null && (d < 1 || d > 31))) {
    return null;
  }
  if (mo === null) {
    return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()];
  }
  if (d === null) {
    return [new Date(y, mo - 1, 1).getTime(), new Date(y, mo, 1).getTime()];
  }
  return [new Date(y, mo - 1, d).getTime(), new Date(y, mo - 1, d + 1).getTime()];
}

/** Split the box text into words / "quoted phrases" / field:values. */
function lexQuery(
  q: string
): Array<{ key: string | null; value: string; quoted: boolean; negate: boolean }> {
  const out: Array<{ key: string | null; value: string; quoted: boolean; negate: boolean }> = [];
  const re = /(-?)(?:([^\s:"״]+):)?(?:["״“”]([^"״“”]*)["״“”]?|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const negate = m[1] === '-';
    const key = m[2] ? m[2].toLowerCase() : null;
    const quoted = m[3] !== undefined;
    const value = quoted ? m[3] : m[4] || '';
    if (!value && !key) {
      continue;
    }
    if (key && !FIELD_ALIASES[key]) {
      // Not an operator (e.g. a time "10:30" or a URL): plain text.
      out.push({ key: null, value: `${m[2]}:${value}`, quoted, negate });
      continue;
    }
    out.push({ key, value, quoted, negate });
  }
  return out;
}

export function parseSearchQuery(q: string): ParsedSearchQuery {
  const res: ParsedSearchQuery = {
    terms: [],
    hasAttachment: null,
    after: null,
    before: null,
    folders: [],
    highlight: [],
  };
  let pendingOr = false;
  for (const tok of lexQuery(q || '')) {
    if (
      !tok.key &&
      !tok.quoted &&
      !tok.negate &&
      (tok.value === 'OR' || tok.value === 'או' || tok.value === '|')
    ) {
      pendingOr = res.terms.length > 0;
      continue;
    }
    const kind = tok.key ? FIELD_ALIASES[tok.key] : 'any';
    if (kind === 'has') {
      const v = normalizeSearchText(tok.value);
      if (/^(attachments?|att|attach|files?|צרופות|צרופה|קבצים|קובץ|📎)$/.test(v)) {
        res.hasAttachment = !tok.negate;
      }
      continue;
    }
    if (kind === 'after' || kind === 'before' || kind === 'date') {
      const r = parseSearchDate(tok.value);
      if (r) {
        if (kind === 'after') {
          res.after = r[0];
        } else if (kind === 'before') {
          res.before = r[0];
        } else {
          res.after = r[0];
          res.before = r[1];
        }
      }
      continue;
    }
    if (kind === 'folder') {
      if (tok.value.trim()) {
        res.folders.push(tok.value.trim());
      }
      continue;
    }
    const words = searchTokens(tok.value);
    if (!words.length) {
      continue;
    }
    const or = pendingOr && !tok.negate && !res.terms[res.terms.length - 1].negate;
    pendingOr = false;
    res.terms.push({
      field: kind as SearchField,
      words,
      phrase: tok.quoted,
      negate: tok.negate,
      ...(or ? { or } : {}),
    });
    if (!tok.negate) {
      res.highlight.push(...words);
      const bare = !tok.quoted && words.length === 1 ? withoutArticle(words[0]) : null;
      if (bare) {
        res.highlight.push(bare);
      }
    }
  }
  res.highlight = Array.from(new Set(res.highlight)).sort((a, b) => b.length - a.length);
  return res;
}

/** "הבית" / "והבית" also search "בית" (ה / ו in front); short words are left alone. */
export function withoutArticle(w: string): string | null {
  if (!isHebrewWord(w)) {
    return null;
  }
  let cur = w;
  while (cur.length >= 4 && (cur[0] === 'ה' || cur[0] === 'ו')) {
    cur = cur.slice(1);
  }
  return cur !== w ? cur : null;
}

const FIELD_COLUMNS: { [k in SearchField]: string } = {
  any: '{subject sender recips body attach alt}',
  subject: '{subject}',
  from: '{sender}',
  to: '{recips}',
  body: '{body alt}',
  attach: '{attach}',
};

function quoteFts(w: string): string {
  return `"${w.replace(/"/g, '""')}"`;
}

/** FTS5 MATCH expression for the text part of a query, or null (filters only). */
export function buildFtsMatch(p: ParsedSearchQuery): string | null {
  const pos: string[][] = [];
  const neg: string[] = [];
  for (const t of p.terms) {
    // Word prefix match ("משפ" finds "משפחה"); quoted phrases match whole words.
    const last = t.words[t.words.length - 1];
    const star = !t.phrase && last.length >= 2 ? '*' : '';
    const bare = !t.phrase && t.words.length === 1 ? withoutArticle(t.words[0]) : null;
    const inner = bare
      ? `(${quoteFts(t.words[0])}${star} OR ${quoteFts(bare)}${star})`
      : `${quoteFts(t.words.join(' '))}${star}`;
    const expr = `${FIELD_COLUMNS[t.field]} : ${inner}`;
    if (t.negate) {
      neg.push(expr);
    } else if (t.or && pos.length) {
      pos[pos.length - 1].push(expr);
    } else {
      pos.push([expr]);
    }
  }
  if (!pos.length) {
    return null;
  }
  let m = pos.map((g) => `(${g.map((x) => `(${x})`).join(' OR ')})`).join(' AND ');
  for (const n of neg) {
    m = `(${m}) NOT (${n})`;
  }
  return m;
}

// ---------------------------------------------------------------- highlight

export type SnippetPart = { t: string; hit?: boolean };

/** Normalized text plus, for each of its UTF-16 units, the index in the original. */
export function normalizeWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  const src = String(s || '');
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    let n = ch.normalize('NFKD').replace(MARKS_RE, '').toLowerCase();
    n = n.replace(FINALS_RE, (c) => FINALS[c]);
    if (/["'\u05f3\u05f4\u2019\u201d]/.test(ch)) {
      const prev = text[text.length - 1] || '';
      const next = src[i + ch.length] || '';
      if (
        /[\u05d0-\u05ea]/.test(prev) &&
        /[\u05d0-\u05ea\u05da\u05dd\u05df\u05e3\u05e5]/.test(next)
      ) {
        n = '';
      }
    }
    for (let k = 0; k < n.length; k++) {
      text += n[k];
      map.push(i);
    }
    i += ch.length;
  }
  return { text, map };
}

/** Original-text ranges [start, end) where a search word starts a word (Hebrew prefixes allowed). */
export function findHits(original: string, words: string[], max = 200): Array<[number, number]> {
  if (!words.length || !original) {
    return [];
  }
  const { text, map } = normalizeWithMap(original);
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:[${HEB_PREFIX}]{0,3})(${esc.join('|')})`, 'gdu');
  const hits: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && hits.length < max) {
    const ind = (m as any).indices?.[1] as [number, number] | undefined;
    if (!ind) {
      break;
    }
    const a = map[ind[0]];
    const lastUnit = map[ind[1] - 1];
    // End after the whole original character (with its niqqud).
    let b = lastUnit + 1;
    while (b < original.length && /\p{M}/u.test(original[b])) {
      b++;
    }
    if (b > a) {
      hits.push([a, b]);
    }
    if (m[0].length === 0) {
      re.lastIndex++;
    }
  }
  return hits;
}

/** Split a short text into plain / highlighted parts. */
export function highlightParts(original: string, words: string[]): SnippetPart[] {
  const hits = findHits(original, words);
  if (!hits.length) {
    return [{ t: original }];
  }
  const parts: SnippetPart[] = [];
  let pos = 0;
  for (const [a, b] of hits) {
    if (a < pos) {
      continue;
    }
    if (a > pos) {
      parts.push({ t: original.slice(pos, a) });
    }
    parts.push({ t: original.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < original.length) {
    parts.push({ t: original.slice(pos) });
  }
  return parts;
}

/** A short piece of the body around the first hit, with the hits marked. */
export function buildSnippet(body: string, words: string[], width = 200): SnippetPart[] {
  const flat = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) {
    return [];
  }
  const hits = findHits(flat, words, 1);
  let start = 0;
  if (hits.length) {
    start = Math.max(0, hits[0][0] - Math.floor(width / 3));
    // Start at a word boundary.
    const sp = flat.lastIndexOf(' ', start);
    start = sp > 0 && hits[0][0] - sp < width / 2 ? sp + 1 : start;
  }
  const end = Math.min(flat.length, start + width);
  const piece = flat.slice(start, end);
  const parts = highlightParts(piece, words);
  if (start > 0) {
    parts.unshift({ t: '…' });
  }
  if (end < flat.length) {
    parts.push({ t: '…' });
  }
  return parts;
}

// ---------------------------------------------------------------- database

export type SearchDoc = {
  id: string;
  rel: string;
  folder: string;
  ts: number;
  size: number;
  mtimeMs: number;
  hasAttachments: boolean;
  subject: string;
  from: string;
  recipients: string;
  body: string;
  attachNames: string[];
};

export type SearchHit = { id: string; rel: string; folder: string; ts: number; score: number };

export type SearchOptions = {
  /** Only these folders (exact paths); null = all folders. */
  folders: string[] | null;
  sort: 'relevance' | 'date';
  limit?: number;
};

/** Refuse a search index path inside the mail copy (or a baseline copy). */
export function assertSearchDbPath(dbPath: string, root: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(dbPath));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error('refuses to write the search index inside the archive');
  }
  if (
    path
      .resolve(dbPath)
      .split(/[\\/]/)
      .some((p) => p.toLowerCase() === 'baseline')
  ) {
    throw new Error('refuses to write the search index into a baseline copy');
  }
}

function openDatabase(file: string): any {
  // Built into Node / Electron (SQLite with FTS5); no native module to rebuild.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file);
}

export class OfflineSearchIndex {
  readonly file: string;
  private db: any;

  constructor(file: string, root: string) {
    assertSearchDbPath(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = openDatabase(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS docs (
        rowid INTEGER PRIMARY KEY,
        rel TEXT UNIQUE NOT NULL,
        id TEXT NOT NULL,
        folder TEXT NOT NULL,
        ts INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        hasatt INTEGER NOT NULL,
        ver INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS docs_folder ON docs(folder);
      CREATE INDEX IF NOT EXISTS docs_ts ON docs(ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        subject, sender, recips, body, attach, alt,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3 4'
      );
    `);
    const root0 = this.meta('root');
    if (root0 && root0 !== path.resolve(root)) {
      // A different mail copy: start over.
      this.db.exec('DELETE FROM docs; DELETE FROM fts;');
    }
    this.setMeta('root', path.resolve(root));
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  meta(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
    return r ? String(r.v) : null;
  }

  setMeta(k: string, v: string) {
    this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v);
  }

  count(): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM docs').get().n);
  }

  /** What has to be (re)indexed to match the current mail index. */
  plan(entries: Array<{ rel: string; size: number; mtimeMs: number }>): {
    add: string[];
    remove: number[];
    unchanged: number;
  } {
    const have = new Map<string, { rowid: number; size: number; mtime: number; ver: number }>();
    for (const r of this.db.prepare('SELECT rowid, rel, size, mtime, ver FROM docs').all()) {
      have.set(String(r.rel), {
        rowid: Number(r.rowid),
        size: Number(r.size),
        mtime: Number(r.mtime),
        ver: Number(r.ver),
      });
    }
    const add: string[] = [];
    const remove: number[] = [];
    let unchanged = 0;
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.rel)) {
        continue;
      }
      seen.add(e.rel);
      const h = have.get(e.rel);
      if (h && h.size === e.size && h.mtime === e.mtimeMs && h.ver === OFFLINE_SEARCH_VERSION) {
        unchanged++;
        continue;
      }
      if (h) {
        remove.push(h.rowid);
      }
      add.push(e.rel);
    }
    for (const [rel, h] of have) {
      if (!seen.has(rel)) {
        remove.push(h.rowid);
      }
    }
    return { add, remove, unchanged };
  }

  remove(rowids: number[]) {
    const delF = this.db.prepare('DELETE FROM fts WHERE rowid = ?');
    const delD = this.db.prepare('DELETE FROM docs WHERE rowid = ?');
    this.db.exec('BEGIN');
    try {
      for (const r of rowids) {
        delF.run(r);
        delD.run(r);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  addMany(docs: SearchDoc[]) {
    const insD = this.db.prepare(
      'INSERT OR REPLACE INTO docs (rel, id, folder, ts, size, mtime, hasatt, ver) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insF = this.db.prepare(
      'INSERT INTO fts (rowid, subject, sender, recips, body, attach, alt) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const old = this.db.prepare('SELECT rowid FROM docs WHERE rel = ?');
    const delF = this.db.prepare('DELETE FROM fts WHERE rowid = ?');
    this.db.exec('BEGIN');
    try {
      for (const d of docs) {
        const prev = old.get(d.rel);
        if (prev) {
          delF.run(prev.rowid);
        }
        const r = insD.run(
          d.rel,
          d.id,
          d.folder,
          Math.round(d.ts || 0),
          d.size,
          d.mtimeMs,
          d.hasAttachments ? 1 : 0,
          OFFLINE_SEARCH_VERSION
        );
        const body = normalizeSearchText(d.body.slice(0, SEARCH_BODY_MAX_CHARS));
        const subject = normalizeSearchText(d.subject);
        insF.run(
          Number(r.lastInsertRowid),
          // Subject words also without ו/ה/ל... so "משפחה" ranks "למשפחה" in a subject high.
          `${subject} ${hebrewPrefixVariants(subject)}`.trim(),
          normalizeSearchText(d.from),
          normalizeSearchText(d.recipients),
          body,
          normalizeSearchText(d.attachNames.join(' \n ')),
          hebrewPrefixVariants(body)
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Run a parsed query. Returns the hits (bounded) and how many match in total. */
  search(p: ParsedSearchQuery, opts: SearchOptions): { hits: SearchHit[]; total: number } {
    const match = buildFtsMatch(p);
    const where: string[] = [];
    const args: any[] = [];
    if (opts.folders) {
      if (!opts.folders.length) {
        return { hits: [], total: 0 };
      }
      where.push(`d.folder IN (${opts.folders.map(() => '?').join(',')})`);
      args.push(...opts.folders);
    }
    if (p.hasAttachment !== null) {
      where.push('d.hasatt = ?');
      args.push(p.hasAttachment ? 1 : 0);
    }
    if (p.after !== null) {
      where.push('d.ts >= ?');
      args.push(p.after);
    }
    if (p.before !== null) {
      where.push('d.ts < ?');
      args.push(p.before);
    }
    if (!match && !where.length) {
      return { hits: [], total: 0 };
    }
    const limit = Math.max(1, opts.limit || SEARCH_RESULT_LIMIT);
    const cond = where.length ? ` AND ${where.join(' AND ')}` : '';
    let rows: any[];
    let total: number;
    if (match) {
      const order = opts.sort === 'date' ? 'd.ts DESC' : 'score ASC, d.ts DESC';
      rows = this.db
        .prepare(
          `SELECT d.id, d.rel, d.folder, d.ts, bm25(fts, 8.0, 4.0, 2.0, 1.0, 3.0, 1.0) AS score
           FROM fts JOIN docs d ON d.rowid = fts.rowid
           WHERE fts MATCH ?${cond} ORDER BY ${order} LIMIT ${limit}`
        )
        .all(match, ...args);
      total = Number(
        this.db
          .prepare(
            `SELECT count(*) AS n FROM fts JOIN docs d ON d.rowid = fts.rowid WHERE fts MATCH ?${cond}`
          )
          .get(match, ...args).n
      );
    } else {
      const w = where.join(' AND ');
      rows = this.db
        .prepare(
          `SELECT d.id, d.rel, d.folder, d.ts, 0 AS score FROM docs d WHERE ${w} ORDER BY d.ts DESC LIMIT ${limit}`
        )
        .all(...args);
      total = Number(this.db.prepare(`SELECT count(*) AS n FROM docs d WHERE ${w}`).get(...args).n);
    }
    return {
      hits: rows.map((r) => ({
        id: String(r.id),
        rel: String(r.rel),
        folder: String(r.folder),
        ts: Number(r.ts),
        score: Number(r.score),
      })),
      total,
    };
  }
}
