/**
 * Offline experiment: group archive messages into conversations.
 * Uses Message-ID / In-Reply-To / References from the local index; replies
 * without those headers join by normalized subject + the same participants.
 * Pure functions, nothing leaves the computer.
 */
import fs from 'fs';
import path from 'path';

export interface ThreadSourceEntry {
  id: string;
  ts: number;
  subject: string;
  from: string;
  to?: string;
  cc?: string;
  msgId?: string;
  inReplyTo?: string;
  refs?: string;
}

export interface OfflineThread {
  /** Stable key: "thread-" + id of the oldest message. */
  key: string;
  /** Message ids, oldest first. */
  ids: string[];
  latestTs: number;
}

const REPLY_PREFIX =
  /^\s*((re|fw|fwd|aw|wg|sv|vs|tr|rv|antw|השב|תשובה|הועבר|מועבר|העבר)\s*(\[\d+\])?\s*[:：]\s*|\[[^\]]{1,40}\]\s*)/i;

/** Subject without Re:/Fwd:/תשובה: prefixes and list tags, lowercased. */
export function normalizeSubject(subject: string): string {
  let s = (subject || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(REPLY_PREFIX, '');
    if (next === s) {
      break;
    }
    s = next.trim();
  }
  return s.toLowerCase();
}

export function isReplyOrForwardSubject(subject: string): boolean {
  return /^\s*(re|fw|fwd|aw|sv|השב|תשובה|הועבר|העבר)\s*(\[\d+\])?\s*[:：]/i.test(subject || '');
}

function ids(value?: string): string[] {
  return ((value || '').match(/<[^<>\s]+>/g) || []).map((x) => x.toLowerCase());
}

function addresses(value?: string): string[] {
  return ((value || '').match(/[^\s<>,;"()]+@[^\s<>,;"()]+/g) || []).map((x) => x.toLowerCase());
}

/** Everyone on the message (From + To + Cc), order-free. */
export function participantsKey(e: Pick<ThreadSourceEntry, 'from' | 'to' | 'cc'>): string {
  return Array.from(new Set([...addresses(e.from), ...addresses(e.to), ...addresses(e.cc)]))
    .sort()
    .join(',');
}

export function buildThreads(entries: ThreadSourceEntry[]): {
  threads: Map<string, OfflineThread>;
  threadOf: Map<string, string>;
} {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  };
  const byMsgId = new Map<string, number>();
  entries.forEach((e, i) => {
    const mid = ids(e.msgId)[0];
    if (!mid) {
      return;
    }
    const prev = byMsgId.get(mid);
    if (prev === undefined) {
      byMsgId.set(mid, i);
    } else {
      union(prev, i); // the same message in two folders
    }
  });
  const linked = new Array(entries.length).fill(false);
  // Replies to a message that is not in the copy still meet at that id.
  const missingParent = new Map<string, number>();
  entries.forEach((e, i) => {
    for (const r of [...ids(e.refs), ...ids(e.inReplyTo)]) {
      const j = byMsgId.has(r) ? byMsgId.get(r) : missingParent.get(r);
      if (j === undefined) {
        missingParent.set(r, i);
        continue;
      }
      if (j !== i) {
        union(i, j);
        linked[i] = true;
        linked[j] = true;
      }
    }
  });
  // Fallback: a "Re:/Fwd:" message with no usable headers joins the
  // conversation with the same subject and the same people.
  const firstByKey = new Map<string, number>();
  const order = entries
    .map((_, i) => i)
    .sort((a, b) => (entries[a].ts || 0) - (entries[b].ts || 0));
  for (const i of order) {
    const e = entries[i];
    const subj = normalizeSubject(e.subject);
    const people = participantsKey(e);
    if (!subj || subj === '(no subject)' || !people) {
      continue;
    }
    const key = `${subj}\u0000${people}`;
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, i);
    } else if (!linked[i] && isReplyOrForwardSubject(e.subject)) {
      union(first, i);
    }
  }
  const groups = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r) || [];
    g.push(i);
    groups.set(r, g);
  });
  const threads = new Map<string, OfflineThread>();
  const threadOf = new Map<string, string>();
  for (const g of groups.values()) {
    g.sort(
      (a, b) =>
        (entries[a].ts || 0) - (entries[b].ts || 0) || (entries[a].id < entries[b].id ? -1 : 1)
    );
    const key = `thread-${entries[g[0]].id}`;
    const t: OfflineThread = {
      key,
      ids: g.map((i) => entries[i].id),
      latestTs: Math.max(...g.map((i) => entries[i].ts || 0)),
    };
    threads.set(key, t);
    for (const i of g) {
      threadOf.set(entries[i].id, key);
    }
  }
  return { threads, threadOf };
}

/**
 * The same message stored in several folders (same Message-ID) is shown once:
 * the copy in the preferred folder when there is one, otherwise the first.
 */
export function dedupeCopies(
  list: string[],
  info: (id: string) => { msgId?: string; folder: string } | undefined,
  preferFolder: string | null
): string[] {
  const chosen = new Map<string, string>();
  for (const id of list) {
    const mid = ids(info(id)?.msgId)[0];
    if (!mid) {
      continue;
    }
    const cur = chosen.get(mid);
    if (
      cur === undefined ||
      (info(cur)?.folder !== preferFolder && info(id)?.folder === preferFolder)
    ) {
      chosen.set(mid, id);
    }
  }
  return list.filter((id) => {
    const mid = ids(info(id)?.msgId)[0];
    return !mid || chosen.get(mid) === id;
  });
}

/**
 * One key per message: its Message-ID (lowercased) or, without one, its own
 * file id. Copies of the same message share a key.
 */
export function messageKey(e: { id: string; msgId?: string }): string {
  const mid = ids(e.msgId)[0];
  return mid ? `mid:${mid}` : `id:${e.id}`;
}

/**
 * Messages of ONE folder with duplicate copies (same Message-ID twice in the
 * same folder) kept once: the first in list order (newest when sorted).
 * This is what the folder badge, the list header and the list all count.
 */
export function uniqueInFolder<T extends { id: string; msgId?: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of list) {
    const k = messageKey(e);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ---- "Conversations" view preference (offline profile) ----

export const OFFLINE_VIEW_PREFS_FILE = 'offline-view-prefs.json';

export function readThreadedPref(configDir: string | null): boolean {
  if (!configDir) {
    return true;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, OFFLINE_VIEW_PREFS_FILE), 'utf8'));
    return typeof raw?.threaded === 'boolean' ? raw.threaded : true;
  } catch (e) {
    return true;
  }
}

export function writeThreadedPref(configDir: string | null, threaded: boolean): void {
  if (!configDir) {
    return;
  }
  const file = path.join(configDir, OFFLINE_VIEW_PREFS_FILE);
  try {
    // Keep the other list settings (sort per folder, density) in the same file.
    let prev: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      prev = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      prev = {};
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, version: 1, threaded }));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[Offline mail] could not save the view preference');
  }
}
