/**
 * Offline experiment: local drafts (new / reply / forward).
 *
 * Drafts live only in the offline profile (one JSON file in its config dir).
 * There is NO send path: this module has no way to deliver mail, nothing
 * here talks to the network, Mailspring's composer / send packages stay
 * disabled in offline mode, and the editor's "send" button is permanently
 * disabled with the note OFFLINE_DRAFTS_NO_SEND_NOTE.
 */
import fs from 'fs';
import path from 'path';

export type OfflineDraftKind = 'new' | 'reply' | 'forward';

export interface OfflineDraft {
  id: string;
  kind: OfflineDraftKind;
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** Local archive message this reply / forward was started from. */
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Source message fields needed to start a reply or forward. */
export interface OfflineDraftSource {
  id: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  text: string;
}

export const OFFLINE_DRAFTS_FILE = 'offline-drafts.json';
export const OFFLINE_DRAFTS_NO_SEND_NOTE = 'גרסת ניסוי – אין שליחה';
export const OFFLINE_DRAFTS_TITLE = 'טיוטות מקומיות';
/** Longest quoted / forwarded body kept in a new draft. */
export const OFFLINE_DRAFT_QUOTE_MAX_CHARS = 20000;
/** Longest draft text sent to Gemini for proofreading. */
export const OFFLINE_PROOFREAD_MAX_CHARS = 20000;

const KINDS: OfflineDraftKind[] = ['new', 'reply', 'forward'];

export function draftsFilePath(configDir: string): string {
  return path.join(configDir, OFFLINE_DRAFTS_FILE);
}

/** True when `p` is inside `configDir` (drafts never leave the profile). */
export function isInsideProfile(configDir: string, p: string): boolean {
  const rel = path.relative(path.resolve(configDir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function str(v: unknown, max = 200000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function sanitizeDraft(raw: unknown): OfflineDraft | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^d[\w-]{4,64}$/.test(r.id)) {
    return null;
  }
  const kind = KINDS.includes(r.kind as OfflineDraftKind) ? (r.kind as OfflineDraftKind) : 'new';
  const createdAt = num(r.createdAt, 0);
  const d: OfflineDraft = {
    id: r.id,
    kind,
    to: str(r.to, 4000),
    cc: str(r.cc, 4000),
    subject: str(r.subject, 2000),
    body: str(r.body),
    createdAt,
    updatedAt: num(r.updatedAt, createdAt),
  };
  if (typeof r.sourceMessageId === 'string' && r.sourceMessageId) {
    d.sourceMessageId = r.sourceMessageId.slice(0, 500);
  }
  return d;
}

/** Newest first. A missing or unreadable file means "no drafts". */
export function readDrafts(configDir: string): OfflineDraft[] {
  let text: string;
  try {
    text = fs.readFileSync(draftsFilePath(configDir), 'utf8');
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(text.replace(/^\uFEFF/, ''));
    const list = Array.isArray(json?.drafts) ? json.drafts : [];
    return sortDrafts(list.map(sanitizeDraft).filter(Boolean) as OfflineDraft[]);
  } catch {
    return [];
  }
}

/** Atomic write (temp file + rename) inside the offline profile only. */
export function writeDrafts(configDir: string, drafts: OfflineDraft[]): void {
  const file = draftsFilePath(configDir);
  if (!isInsideProfile(configDir, file)) {
    throw new Error('Drafts file must be inside the offline profile');
  }
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const data = JSON.stringify({ version: 1, drafts: sortDrafts(drafts) }, null, 1);
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

export function sortDrafts(list: OfflineDraft[]): OfflineDraft[] {
  return list.slice().sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

let seq = 0;
export function newDraftId(now: number): string {
  seq = (seq + 1) % 100000;
  return `d${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makeNewDraft(now: number): OfflineDraft {
  return {
    id: newDraftId(now),
    kind: 'new',
    to: '',
    cc: '',
    subject: '',
    body: '',
    createdAt: now,
    updatedAt: now,
  };
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const s = (subject || '').trim();
  const re = prefix === 'Re' ? /^(re|תשובה)\s*:/i : /^(fwd?|הועבר)\s*:/i;
  return re.test(s) ? s : `${prefix}: ${s}`.trim();
}

/** Email address part of a From header ("Name <a@b>" → a@b). */
export function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header || '');
  return (m ? m[1] : header || '').trim();
}

function capped(text: string): string {
  const t = (text || '').replace(/\r\n/g, '\n');
  return t.length > OFFLINE_DRAFT_QUOTE_MAX_CHARS
    ? `${t.slice(0, OFFLINE_DRAFT_QUOTE_MAX_CHARS)}\n…`
    : t;
}

export interface DraftLabels {
  wrote: (date: string, from: string) => string;
  forwardedHeader: string;
  from: string;
  date: string;
  subject: string;
  to: string;
}

export const HEBREW_DRAFT_LABELS: DraftLabels = {
  wrote: (date, from) => `ב-${date}, ${from} כתב/ה:`,
  forwardedHeader: '---------- הודעה שהועברה ----------',
  from: 'מאת',
  date: 'תאריך',
  subject: 'נושא',
  to: 'אל',
};

export const ENGLISH_DRAFT_LABELS: DraftLabels = {
  wrote: (date, from) => `On ${date}, ${from} wrote:`,
  forwardedHeader: '---------- Forwarded message ----------',
  from: 'From',
  date: 'Date',
  subject: 'Subject',
  to: 'To',
};

export function makeReplyDraft(
  src: OfflineDraftSource,
  now: number,
  labels: DraftLabels = HEBREW_DRAFT_LABELS
): OfflineDraft {
  const quoted = capped(src.text)
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
  return {
    id: newDraftId(now),
    kind: 'reply',
    to: addressOf(src.from),
    cc: '',
    subject: prefixed(src.subject, 'Re'),
    body: `\n\n${labels.wrote(src.date, src.from)}\n${quoted}`,
    sourceMessageId: src.id,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeForwardDraft(
  src: OfflineDraftSource,
  now: number,
  labels: DraftLabels = HEBREW_DRAFT_LABELS
): OfflineDraft {
  const head = [
    labels.forwardedHeader,
    `${labels.from}: ${src.from}`,
    `${labels.date}: ${src.date}`,
    `${labels.subject}: ${src.subject}`,
    src.to ? `${labels.to}: ${src.to}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: newDraftId(now),
    kind: 'forward',
    to: '',
    cc: '',
    subject: prefixed(src.subject, 'Fwd'),
    body: `\n\n${head}\n\n${capped(src.text)}`,
    sourceMessageId: src.id,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertDraft(list: OfflineDraft[], d: OfflineDraft): OfflineDraft[] {
  return sortDrafts([d, ...list.filter((x) => x.id !== d.id)]);
}

export function removeDraft(list: OfflineDraft[], id: string): OfflineDraft[] {
  return list.filter((x) => x.id !== id);
}

const HEBREW_OR_ARABIC = /[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

/** Direction of one paragraph from its first strong character (like dir=auto). */
export function paragraphDirection(p: string): 'rtl' | 'ltr' | 'neutral' {
  for (const ch of p) {
    if (HEBREW_OR_ARABIC.test(ch)) {
      return 'rtl';
    }
    if (STRONG_LTR.test(ch)) {
      return 'ltr';
    }
  }
  return 'neutral';
}

export function paragraphDirections(body: string): ('rtl' | 'ltr' | 'neutral')[] {
  return (body || '').split(/\r?\n/).map(paragraphDirection);
}

export function draftSnippet(d: OfflineDraft, max = 90): string {
  const firstReal = (d.body || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('>'));
  const s = firstReal || '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function isDraftEmpty(d: OfflineDraft): boolean {
  return !d.to.trim() && !d.cc.trim() && !d.subject.trim() && !d.body.trim();
}
