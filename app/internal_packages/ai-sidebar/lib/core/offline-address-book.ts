/**
 * Offline experiment: a local address book built from the archive's
 * From / To / Cc / Reply-To headers (already in the offline index).
 * Pure functions plus a small JSON file inside the offline profile.
 * Nothing here talks to the network or to Gemini.
 */
import fs from 'fs';
import path from 'path';
import { offlineFolderRole } from './offline-folder-roles';

export const OFFLINE_ADDRESS_BOOK_FILE = 'offline-address-book.json';
export const OFFLINE_ADDRESS_BOOK_VERSION = 1;
const MAX_CONTACTS = 20000;
const SENT_WEIGHT = 3;
const FROM_WEIGHT = 1;
const CO_RECIPIENT_WEIGHT = 0.3;
const SELF_FACTOR = 0.05;
const YEAR_MS = 365 * 24 * 3600 * 1000;

export interface OfflineAddress {
  name: string;
  email: string;
}

export interface OfflineContact {
  email: string;
  name: string;
  /** Number of messages it appeared in. */
  count: number;
  /** Messages the user sent to it (To/Cc in a Sent folder). */
  sentTo: number;
  /** Newest message time (ms). */
  last: number;
  score: number;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function isLikelyEmail(s: string): boolean {
  return EMAIL_RE.test((s || '').trim());
}

function cleanName(raw: string): string {
  let n = (raw || '').trim();
  if (n.startsWith('"') && n.endsWith('"') && n.length >= 2) {
    n = n.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  n = n.replace(/\s+/g, ' ').trim();
  if (n.startsWith("'") && n.endsWith("'") && n.length >= 2) {
    n = n.slice(1, -1).trim();
  }
  return n.slice(0, 200);
}

/** Split a header address list on commas/semicolons outside quotes, <> and (). */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && quote && i + 1 < value.length) {
      cur += c + value[i + 1];
      i++;
      continue;
    }
    if (c === '"') {
      quote = !quote;
    } else if (!quote && c === '<') {
      angle++;
    } else if (!quote && c === '>' && angle > 0) {
      angle--;
    } else if (!quote && c === '(') {
      paren++;
    } else if (!quote && c === ')' && paren > 0) {
      paren--;
    } else if (!quote && angle === 0 && paren === 0 && (c === ',' || c === ';')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Parse "Name <a@b.c>, d@e.f; \"Last, First\" <g@h.i>" into addresses. */
export function parseAddressList(value: string): OfflineAddress[] {
  const out: OfflineAddress[] = [];
  if (!value || typeof value !== 'string') {
    return out;
  }
  for (let part of splitList(value.slice(0, 20000))) {
    // Group syntax: "undisclosed-recipients:;" or "Team: a@b.c, d@e.f;"
    const group = /^[^"<@]*:\s*/.exec(part);
    if (group && !part.includes('<')) {
      part = part.slice(group[0].length);
    }
    if (!part) {
      continue;
    }
    const m = /^(.*?)<([^<>]*)>\s*(\(.*\))?$/.exec(part);
    let email = '';
    let name = '';
    if (m) {
      email = m[2].trim();
      name = cleanName(m[1]);
      if (!name && m[3]) {
        name = cleanName(m[3].slice(1, -1));
      }
    } else {
      const c = /^([^\s()]+)\s*\((.*)\)$/.exec(part);
      if (c) {
        email = c[1];
        name = cleanName(c[2]);
      } else {
        email = part.replace(/^"|"$/g, '').trim();
      }
    }
    email = email.replace(/^mailto:/i, '').trim();
    if (!isLikelyEmail(email)) {
      continue;
    }
    if (name && name.toLowerCase() === email.toLowerCase()) {
      name = '';
    }
    out.push({ name, email });
  }
  return out;
}

export interface RecipientChip {
  raw: string;
  /** Parsed address, or null when the text is not a valid address. */
  addr: OfflineAddress | null;
}

/** Recipients field value → chips (invalid parts are kept, not dropped). */
export function splitRecipients(value: string): RecipientChip[] {
  return splitList((value || '').slice(0, 20000)).map((raw) => {
    const parsed = parseAddressList(raw);
    return { raw, addr: parsed.length === 1 ? parsed[0] : null };
  });
}

export function joinRecipients(chips: RecipientChip[]): string {
  return chips.map((c) => (c.addr ? formatAddress(c.addr) : c.raw)).join(', ');
}

/** "Name <email>" (quoted when needed) or the bare email. */
export function formatAddress(a: OfflineAddress): string {
  const name = (a.name || '').replace(/[\r\n]+/g, ' ').trim();
  if (!name) {
    return a.email;
  }
  const needsQuotes = /[",;:<>()@[\]\\]/.test(name);
  return needsQuotes
    ? `"${name.replace(/(["\\])/g, '\\$1')}" <${a.email}>`
    : `${name} <${a.email}>`;
}

export function formatAddressList(list: OfflineAddress[]): string {
  return list.map(formatAddress).join(', ');
}

export interface AddressBookSourceEntry {
  folder: string;
  ts: number;
  from: string;
  to?: string;
  cc?: string;
  replyTo?: string;
}

interface Acc {
  email: string;
  names: Map<string, { n: number; last: number }>;
  count: number;
  sentTo: number;
  weight: number;
  last: number;
  fromInSent: number;
}

function isSentFolder(folder: string, folderNames?: { [stored: string]: string }): boolean {
  const top = (folder || '').split('/')[0];
  const original = (folderNames && folderNames[top]) || top;
  return offlineFolderRole(original, 0) === 'sent' || offlineFolderRole(top, 0) === 'sent';
}

/**
 * Build the ranked address book. Sent-to recipients weigh most, senders next,
 * co-recipients of received mail least. The user's own address (sender of
 * Sent mail) sinks to the bottom. Newer contacts get a recency boost.
 */
export function buildAddressBook(
  entries: AddressBookSourceEntry[],
  opts: { folderNames?: { [stored: string]: string }; now?: number } = {}
): OfflineContact[] {
  const now = opts.now || Date.now();
  const map = new Map<string, Acc>();
  const touch = (
    a: OfflineAddress,
    weight: number,
    ts: number,
    sent: boolean,
    seen: Set<string>
  ) => {
    const key = a.email.toLowerCase();
    let acc = map.get(key);
    if (!acc) {
      acc = {
        email: a.email,
        names: new Map(),
        count: 0,
        sentTo: 0,
        weight: 0,
        last: 0,
        fromInSent: 0,
      };
      map.set(key, acc);
    }
    if (!seen.has(key)) {
      seen.add(key);
      acc.count++;
    }
    if (sent) {
      acc.sentTo++;
    }
    acc.weight += weight;
    acc.last = Math.max(acc.last, ts || 0);
    if (a.name && !isLikelyEmail(a.name)) {
      const n = acc.names.get(a.name) || { n: 0, last: 0 };
      n.n++;
      n.last = Math.max(n.last, ts || 0);
      acc.names.set(a.name, n);
    }
    return acc;
  };
  for (const e of entries) {
    const sent = isSentFolder(e.folder, opts.folderNames);
    const seen = new Set<string>();
    const ts = e.ts || 0;
    for (const a of parseAddressList(e.from)) {
      const acc = touch(a, sent ? 0 : FROM_WEIGHT, ts, false, seen);
      if (sent) {
        acc.fromInSent++;
      }
    }
    if (!sent) {
      for (const a of parseAddressList(e.replyTo || '')) {
        touch(a, FROM_WEIGHT, ts, false, seen);
      }
    }
    for (const field of [e.to, e.cc]) {
      for (const a of parseAddressList(field || '')) {
        touch(a, sent ? SENT_WEIGHT : CO_RECIPIENT_WEIGHT, ts, sent, seen);
      }
    }
  }
  const out: OfflineContact[] = [];
  for (const acc of map.values()) {
    let best = '';
    let bestN = -1;
    let bestLast = -1;
    for (const [n, v] of acc.names) {
      if (v.n > bestN || (v.n === bestN && v.last > bestLast)) {
        best = n;
        bestN = v.n;
        bestLast = v.last;
      }
    }
    const age = acc.last ? Math.max(0, now - acc.last) : 10 * YEAR_MS;
    const recency = Math.exp(-age / YEAR_MS);
    let score = (acc.weight + 0.1) * (1 + 2 * recency);
    if (acc.fromInSent > 0 && acc.sentTo === 0) {
      score *= SELF_FACTOR;
    }
    out.push({
      email: acc.email,
      name: best,
      count: acc.count,
      sentTo: acc.sentTo,
      last: acc.last,
      score: Math.round(score * 1000) / 1000,
    });
  }
  out.sort((a, b) => b.score - a.score || b.last - a.last || a.email.localeCompare(b.email));
  return out.slice(0, MAX_CONTACTS);
}

/** Lowercase, strip Hebrew niqqud and Latin accents for matching. */
export function normalizeForSearch(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '')
    .toLowerCase()
    .trim();
}

function words(s: string): string[] {
  return normalizeForSearch(s)
    .split(/[\s.@_\-+'"()]+/)
    .filter(Boolean);
}

/** 0 = no match; higher = better (prefix of name/email beats word prefix beats substring). */
export function matchRank(c: Pick<OfflineContact, 'name' | 'email'>, query: string): number {
  const q = normalizeForSearch(query);
  if (!q) {
    return 1;
  }
  const name = normalizeForSearch(c.name);
  const email = normalizeForSearch(c.email);
  if (name.startsWith(q) || email.startsWith(q)) {
    return 4;
  }
  const qWords = q.split(/\s+/).filter(Boolean);
  const all = words(c.name).concat(words(c.email));
  if (qWords.every((qw) => all.some((w) => w.startsWith(qw)))) {
    return 3;
  }
  if (name.includes(q) || email.includes(q)) {
    return 2;
  }
  return 0;
}

export function searchAddressBook(
  contacts: OfflineContact[],
  query: string,
  limit = 8,
  exclude: string[] = []
): OfflineContact[] {
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const hits: { c: OfflineContact; r: number; i: number }[] = [];
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (skip.has(c.email.toLowerCase())) {
      continue;
    }
    const r = matchRank(c, query);
    if (r > 0) {
      hits.push({ c, r, i });
    }
  }
  hits.sort((a, b) => b.r - a.r || a.i - b.i);
  return hits.slice(0, limit).map((h) => h.c);
}

export interface AddressBookFile {
  version: number;
  builtAt: string;
  sourceMessages: number;
  contacts: OfflineContact[];
}

export function assertInsideProfile(file: string, configDir: string) {
  const rel = path.relative(path.resolve(configDir), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Address book must stay inside the offline profile');
  }
}

function sanitizeContact(c: any): OfflineContact | null {
  if (!c || typeof c.email !== 'string' || !isLikelyEmail(c.email)) {
    return null;
  }
  const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return {
    email: c.email.slice(0, 320),
    name: typeof c.name === 'string' ? c.name.slice(0, 200) : '',
    count: num(c.count),
    sentTo: num(c.sentTo),
    last: num(c.last),
    score: num(c.score),
  };
}

export function readAddressBook(configDir: string): AddressBookFile | null {
  const file = path.join(configDir, OFFLINE_ADDRESS_BOOK_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || raw.version !== OFFLINE_ADDRESS_BOOK_VERSION || !Array.isArray(raw.contacts)) {
      return null;
    }
    return {
      version: raw.version,
      builtAt: String(raw.builtAt || ''),
      sourceMessages: Number(raw.sourceMessages) || 0,
      contacts: raw.contacts.map(sanitizeContact).filter(Boolean) as OfflineContact[],
    };
  } catch (e) {
    return null;
  }
}

export function writeAddressBook(configDir: string, data: AddressBookFile) {
  const file = path.join(configDir, OFFLINE_ADDRESS_BOOK_FILE);
  assertInsideProfile(file, configDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
