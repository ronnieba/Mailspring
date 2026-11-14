/**
 * Offline experiment (t227): Yahoo-style message actions as a LOCAL overlay.
 *
 * Nothing here touches the mail copy (work/baseline) or Yahoo. Every change
 * (star, unread, delete/archive/spam/move, blocked senders, saved contacts)
 * is a small record in the offline profile (offline-local-changes.json),
 * applied on top of the read-only index when the app shows the mail. Every
 * change can be undone ("Restore", "Unblock", "Reset all local changes").
 */
import fs from 'fs';
import path from 'path';
import { parseAddressList, isLikelyEmail } from './offline-address-book';

export const OFFLINE_LOCAL_CHANGES_FILE = 'offline-local-changes.json';
export const OFFLINE_LOCAL_CHANGES_VERSION = 1;

export type LocalPlace = 'trash' | 'archive' | 'spam';
export const LOCAL_PLACES: LocalPlace[] = ['trash', 'archive', 'spam'];

/** Virtual folder paths (cannot clash with a stored folder path). */
export const LOCAL_FOLDER_PREFIX = '\u2060local:';
export function localFolderPath(place: LocalPlace): string {
  return `${LOCAL_FOLDER_PREFIX}${place}`;
}
export function localPlaceOf(folderPath: string | null | undefined): LocalPlace | null {
  if (!folderPath || !folderPath.startsWith(LOCAL_FOLDER_PREFIX)) {
    return null;
  }
  const p = folderPath.slice(LOCAL_FOLDER_PREFIX.length) as LocalPlace;
  return LOCAL_PLACES.includes(p) ? p : null;
}
export const LOCAL_PLACE_LABELS: { [p in LocalPlace]: [string, string] } = {
  trash: ['אשפה (מקומי)', 'Trash (local)'],
  archive: ['ארכיון (מקומי)', 'Archive (local)'],
  spam: ['ספאם (מקומי)', 'Spam (local)'],
};

export type OverlayMessage = {
  star?: boolean;
  unread?: boolean;
  /** In a local virtual folder (deleted / archived / spam). */
  place?: LocalPlace;
  /** Moved to another (stored) folder. */
  folder?: string;
  at?: number;
};

export type BlockedSender = { email: string; name: string; at: number };
export type SavedContact = { email: string; name: string; at: number };

export type OverlayData = {
  version: number;
  messages: { [id: string]: OverlayMessage };
  blocked: BlockedSender[];
  contacts: SavedContact[];
};

export function emptyOverlay(): OverlayData {
  return { version: OFFLINE_LOCAL_CHANGES_VERSION, messages: {}, blocked: [], contacts: [] };
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function cleanMessage(m: any): OverlayMessage | null {
  if (!m || typeof m !== 'object') {
    return null;
  }
  const out: OverlayMessage = {};
  if (m.star === true) out.star = true;
  if (m.unread === true) out.unread = true;
  if (LOCAL_PLACES.includes(m.place)) out.place = m.place;
  if (!out.place && typeof m.folder === 'string' && m.folder && m.folder.length < 1000) {
    out.folder = m.folder;
  }
  if (typeof m.at === 'number' && isFinite(m.at)) out.at = m.at;
  return out.star || out.unread || out.place || out.folder ? out : null;
}

function cleanPerson(p: any): { email: string; name: string; at: number } | null {
  if (!p || typeof p.email !== 'string' || !isLikelyEmail(p.email)) {
    return null;
  }
  return {
    email: p.email.trim().toLowerCase().slice(0, 320),
    name: typeof p.name === 'string' ? p.name.slice(0, 200) : '',
    at: typeof p.at === 'number' && isFinite(p.at) ? p.at : 0,
  };
}

export function sanitizeOverlay(raw: any): OverlayData {
  const out = emptyOverlay();
  if (!raw || raw.version !== OFFLINE_LOCAL_CHANGES_VERSION) {
    return out;
  }
  for (const [id, m] of Object.entries(raw.messages || {})) {
    const c = ID_RE.test(id) ? cleanMessage(m) : null;
    if (c) out.messages[id] = c;
  }
  const seen = new Set<string>();
  for (const b of Array.isArray(raw.blocked) ? raw.blocked : []) {
    const c = cleanPerson(b);
    if (c && !seen.has(c.email)) {
      seen.add(c.email);
      out.blocked.push(c);
    }
  }
  seen.clear();
  for (const b of Array.isArray(raw.contacts) ? raw.contacts : []) {
    const c = cleanPerson(b);
    if (c && !seen.has(c.email)) {
      seen.add(c.email);
      out.contacts.push(c);
    }
  }
  return out;
}

export function overlayFile(configDir: string): string {
  return path.join(configDir, OFFLINE_LOCAL_CHANGES_FILE);
}

export function readOverlay(configDir: string | null): OverlayData {
  if (!configDir) {
    return emptyOverlay();
  }
  try {
    return sanitizeOverlay(JSON.parse(fs.readFileSync(overlayFile(configDir), 'utf8')));
  } catch {
    return emptyOverlay();
  }
}

/** Atomic write, only inside the offline profile. */
export function writeOverlay(configDir: string | null, data: OverlayData) {
  if (!configDir) {
    return;
  }
  const file = overlayFile(configDir);
  const rel = path.relative(path.resolve(configDir), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Local changes must stay inside the offline profile');
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Lower-case sender address of a From header ('' when none). */
export function senderEmail(from: string): string {
  const a = parseAddressList(from || '')[0];
  return a && isLikelyEmail(a.email) ? a.email.trim().toLowerCase() : '';
}
export function senderDisplayName(from: string): string {
  const a = parseAddressList(from || '')[0];
  return (a && a.name) || '';
}

export type OverlayEntry = { id: string; folder: string; from: string };

/** Where a message shows (local virtual folder, moved-to folder or its own). */
export function effectiveFolder(e: OverlayEntry, m: OverlayMessage | undefined): string {
  if (m && m.place) {
    return localFolderPath(m.place);
  }
  if (m && m.folder) {
    return m.folder;
  }
  return e.folder;
}

export type OverlayView<T extends OverlayEntry> = {
  /** Entries with their effective folder (blocked ones too). */
  entries: T[];
  /** Ids hidden from lists/counts/search (blocked senders), unless shown. */
  hidden: Set<string>;
};

export function applyOverlay<T extends OverlayEntry>(
  entries: T[],
  data: OverlayData,
  opts: { showBlocked?: boolean } = {}
): OverlayView<T> {
  const blocked = new Set(data.blocked.map((b) => b.email));
  const hidden = new Set<string>();
  const out: T[] = [];
  for (const e of entries) {
    const m = data.messages[e.id];
    const folder = effectiveFolder(e, m);
    out.push(folder === e.folder ? e : { ...e, folder });
    if (blocked.size && !opts.showBlocked && blocked.has(senderEmail(e.from))) {
      hidden.add(e.id);
    }
  }
  return { entries: out, hidden };
}

/** Change one message record (removes it when nothing is left). */
export function patchMessage(
  data: OverlayData,
  id: string,
  patch: Partial<OverlayMessage>,
  now = Date.now()
) {
  const cur: any = { ...(data.messages[id] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === false || v === null || v === '') {
      delete cur[k];
    } else {
      cur[k] = v;
    }
  }
  if (patch.place) {
    delete cur.folder;
  }
  if (patch.folder) {
    delete cur.place;
  }
  cur.at = now;
  const c = cleanMessage(cur);
  if (c) {
    data.messages[id] = c;
  } else {
    delete data.messages[id];
  }
}

/** Number of local changes (for "reset" and the status line). */
export function overlayCounts(data: OverlayData) {
  let starred = 0;
  let unread = 0;
  let moved = 0;
  const places: { [p in LocalPlace]: number } = { trash: 0, archive: 0, spam: 0 };
  for (const m of Object.values(data.messages)) {
    if (m.star) starred++;
    if (m.unread) unread++;
    if (m.place) places[m.place]++;
    if (m.folder) moved++;
  }
  return {
    starred,
    unread,
    moved,
    ...places,
    blocked: data.blocked.length,
    contacts: data.contacts.length,
    total: Object.keys(data.messages).length + data.blocked.length + data.contacts.length,
  };
}
