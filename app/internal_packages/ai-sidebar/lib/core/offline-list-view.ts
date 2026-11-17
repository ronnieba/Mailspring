/**
 * Offline experiment: message list sorting, "attachments only" filter and
 * row density. Pure helpers + the saved preferences (offline profile only).
 */
import fs from 'fs';
import path from 'path';
import { OFFLINE_VIEW_PREFS_FILE, normalizeSubject } from './offline-threads';

export type OfflineSortKey = 'date' | 'subject' | 'from' | 'attachments';
export type OfflineSortDir = 'asc' | 'desc';
export type OfflineSort = { key: OfflineSortKey; dir: OfflineSortDir };
export type OfflineListDensity = 'compact' | 'expanded';

export const OFFLINE_SORT_KEYS: OfflineSortKey[] = ['date', 'subject', 'from', 'attachments'];
/** [Hebrew, English] labels. */
export const SORT_LABELS: Record<OfflineSortKey, [string, string]> = {
  date: ['תאריך קבלה', 'Date received'],
  subject: ['נושא', 'Subject'],
  from: ['שם השולח', 'Sender name'],
  attachments: ['צרופות (וגודל)', 'Attachments (and size)'],
};
export const DEFAULT_SORT: OfflineSort = { key: 'date', dir: 'desc' };
export const DEFAULT_DENSITY: OfflineListDensity = 'expanded';
/** Row heights in px: one line, or three lines (sender+date / subject / preview). */
export const ROW_HEIGHTS: Record<OfflineListDensity, number> = { compact: 32, expanded: 74 };

/** Natural default direction when switching to a key. */
export function defaultDirFor(key: OfflineSortKey): OfflineSortDir {
  return key === 'date' || key === 'attachments' ? 'desc' : 'asc';
}

export function isSortKey(v: unknown): v is OfflineSortKey {
  return typeof v === 'string' && (OFFLINE_SORT_KEYS as string[]).includes(v);
}

function sanitizeSort(v: any): OfflineSort | null {
  if (!v || typeof v !== 'object' || !isSortKey(v.key)) {
    return null;
  }
  return { key: v.key, dir: v.dir === 'asc' ? 'asc' : 'desc' };
}

export interface OfflineListPrefs {
  density: OfflineListDensity;
  sortByFolder: { [folder: string]: OfflineSort };
}

const MAX_SAVED_FOLDERS = 2000;

export function readListPrefs(configDir: string | null): OfflineListPrefs {
  const out: OfflineListPrefs = { density: DEFAULT_DENSITY, sortByFolder: {} };
  if (!configDir) {
    return out;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, OFFLINE_VIEW_PREFS_FILE), 'utf8'));
    if (raw?.density === 'compact' || raw?.density === 'expanded') {
      out.density = raw.density;
    }
    const sb = raw?.sortByFolder;
    if (sb && typeof sb === 'object' && !Array.isArray(sb)) {
      for (const k of Object.keys(sb).slice(0, MAX_SAVED_FOLDERS)) {
        const s = sanitizeSort(sb[k]);
        if (s) {
          out.sortByFolder[k] = s;
        }
      }
    }
  } catch (e) {
    // defaults
  }
  return out;
}

/** Merge into offline-view-prefs.json (keeps "threaded" and anything else). */
export function writeListPrefs(configDir: string | null, prefs: OfflineListPrefs): void {
  if (!configDir) {
    return;
  }
  const file = path.join(configDir, OFFLINE_VIEW_PREFS_FILE);
  try {
    let prev: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      prev = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      prev = {};
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        ...prev,
        version: 1,
        density: prefs.density,
        sortByFolder: prefs.sortByFolder,
      })
    );
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[Offline mail] could not save the list settings');
  }
}

/** Hebrew-aware, case/accent-insensitive, numbers in natural order. */
const collator = new Intl.Collator(['he', 'en'], { sensitivity: 'base', numeric: true });

export function senderName(from: string): string {
  const s = String(from || '');
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(s);
  return (m ? m[1] : s).trim();
}

/** What a list row is sorted by (a message, or a conversation). */
export interface SortableRow {
  /** Newest message time (conversations: latest message). */
  ts: number;
  subject: string;
  /** Sender name (conversations: first sender). */
  from: string;
  hasAttachments: boolean;
  /** Bytes (message size, includes attachments). */
  size: number;
}

function cmpText(a: string, b: string): number {
  const ea = !a.trim();
  const eb = !b.trim();
  if (ea !== eb) {
    return ea ? 1 : -1; // empty subjects / names always last
  }
  return collator.compare(a, b);
}

export function compareRows(a: SortableRow, b: SortableRow, sort: OfflineSort): number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  let c = 0;
  if (sort.key === 'subject') {
    c = cmpText(normalizeSubject(a.subject), normalizeSubject(b.subject));
    if (c !== 0 && (!a.subject.trim() || !b.subject.trim())) {
      return c; // empties last in both directions
    }
  } else if (sort.key === 'from') {
    c = cmpText(senderName(a.from), senderName(b.from));
    if (c !== 0 && (!senderName(a.from) || !senderName(b.from))) {
      return c;
    }
  } else if (sort.key === 'attachments') {
    c = (a.hasAttachments ? 1 : 0) - (b.hasAttachments ? 1 : 0) || (a.size || 0) - (b.size || 0);
  } else {
    c = (a.ts || 0) - (b.ts || 0);
  }
  if (c === 0) {
    // Ties: newest first, whatever the direction.
    return (b.ts || 0) - (a.ts || 0);
  }
  return c * sign;
}

/** Stable sort of rows by a projection. */
export function sortRows<T>(rows: T[], project: (r: T) => SortableRow, sort: OfflineSort): T[] {
  const proj = rows.map((r, i) => ({ r, i, p: project(r) }));
  proj.sort((x, y) => compareRows(x.p, y.p, sort) || x.i - y.i);
  return proj.map((x) => x.r);
}

/** One preview line from the message text: no quoted reply, collapsed spaces. */
export function previewLine(text: string, max = 160): string {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const keep: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (/^>/.test(t)) {
      continue;
    }
    if (
      /^(On .+ wrote:|ב-.+ כתב\/ה:|-{3,}\s*(Original Message|Forwarded message|הודעה שהועברה)\s*-{3,})$/i.test(
        t
      )
    ) {
      break;
    }
    if (t) {
      keep.push(t);
    }
    if (keep.join(' ').length > max) {
      break;
    }
  }
  const s = keep.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
