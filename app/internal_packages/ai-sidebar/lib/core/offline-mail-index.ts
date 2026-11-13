/**
 * Header-only index of a local offline mail copy (.eml tree / Maildir / mbox).
 *
 * - Every mail file is opened read-only ('r'); the archive tree is never written.
 * - The index cache is written only to an explicit cache path inside the
 *   isolated Mailspring-offline profile, never into the archive.
 * - No network. No IMAP. No Mailspring database.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isForbiddenArchiveRoot, splitMboxrd } from './offline-archive-format';
import { messageKey } from './offline-threads';
import {
  containsHebrew,
  parseOfflineMail,
  parseOfflineMailHeaders,
  ParsedOfflineMail,
  scanOfflineMailAttachments,
  topContentType,
} from './offline-mail-mime';

export const OFFLINE_INDEX_VERSION = 3;
const HEAD_BYTES = 64 * 1024;
/** Bump to re-check attachments of every cached entry once (structure, not headers). */
export const ATTACH_SCAN_VERSION = 2;
/** Messages larger than this are not read whole; they are counted as having attachments. */
const FULL_SCAN_MAX_BYTES = 80 * 1024 * 1024;
/** Large files are read one at a time (memory). */
const BIG_READ_BYTES = 8 * 1024 * 1024;
let bigReadChain: Promise<unknown> = Promise.resolve();

/** Only multipart messages other than plain body alternatives can carry attachments past the head. */
export function needsFullAttachmentScan(topType: string, size: number): boolean {
  return (
    size > HEAD_BYTES && topType.startsWith('multipart/') && topType !== 'multipart/alternative'
  );
}

/**
 * Real attachments of one mail file (read-only). Small files and single-part
 * messages are judged from the first chunk; multipart ones are read whole.
 */
export async function scanAttachmentsOfFile(
  abs: string,
  size: number,
  head: Buffer
): Promise<{ count: number; bytes: number; names: string[] }> {
  const top = topContentType(head);
  if (!needsFullAttachmentScan(top, size)) {
    const s = scanOfflineMailAttachments(head);
    return { count: s.count, bytes: s.bytes, names: attachNamesForIndex(s.names) };
  }
  if (size > FULL_SCAN_MAX_BYTES) {
    return { count: 1, bytes: size, names: [] };
  }
  const read = () => fs.promises.readFile(abs, { flag: 'r' });
  let buf: Buffer;
  if (size > BIG_READ_BYTES) {
    const p = bigReadChain.then(read, read);
    bigReadChain = p.catch(() => undefined);
    buf = await p;
  } else {
    buf = await read();
  }
  const s = scanOfflineMailAttachments(buf);
  return { count: s.count, bytes: s.bytes, names: attachNamesForIndex(s.names) };
}

/** Attachment file names kept in the index (local search); bounded. */
export function attachNamesForIndex(names: string[]): string[] {
  return names
    .filter((n) => n && !/^\(unnamed /.test(n))
    .slice(0, 20)
    .map((n) => n.slice(0, 160));
}

export type OfflineIndexEntry = {
  id: string;
  /** Path relative to the archive root using '/' separators. mbox parts end with #n. */
  rel: string;
  /** Stored folder path ('/'-separated). */
  folder: string;
  size: number;
  mtimeMs: number;
  subject: string;
  from: string;
  /** Raw Date header. */
  date: string;
  /** Parsed timestamp (ms) or 0. */
  ts: number;
  hasAttachments: boolean;
  hebrew: boolean;
  /** Decoded To / Cc / Reply-To (for the local address book). Missing in older caches. */
  to?: string;
  cc?: string;
  replyTo?: string;
  /** Message-ID, In-Reply-To and References (for conversations). Missing in older caches. */
  msgId?: string;
  inReplyTo?: string;
  refs?: string;
  /** Real attachments (MIME structure; inline cid images, signatures, body parts excluded). */
  attachCount?: number;
  attachBytes?: number;
  /** Real attachment file names (for local search); only when there are some. */
  attachNames?: string[];
  /** ATTACH_SCAN_VERSION the attachment fields were computed with. */
  attachScan?: number;
};

export type OfflineMailIndex = {
  version: number;
  root: string;
  builtAt: string;
  entries: OfflineIndexEntry[];
  /** stored folder path -> original server folder path (from snapshot manifest). */
  folderNames: { [stored: string]: string };
  /** Folder message counts as recorded by the snapshot manifest, when present. */
  manifestFolderCounts: { [stored: string]: number } | null;
  manifestMessageCount: number | null;
  unreadable: Array<{ rel: string; reason: string }>;
  stats: { reused: number; parsed: number; rescanned?: number; ms: number };
};

export type IndexProgress = {
  phase: 'scan' | 'headers' | 'manifest' | 'done';
  done: number;
  total: number;
};

export function offlineEntryId(rel: string): string {
  return `offline-${crypto.createHash('sha256').update(rel, 'utf8').digest('hex').slice(0, 16)}`;
}

/** The snapshot keeps an untouchable reference copy in `baseline`; refuse to open it. */
export function isBaselineRoot(root: string): boolean {
  const base = path.basename(String(root || '').replace(/[\\/]+$/, '')).toLowerCase();
  return base === 'baseline';
}

export function assertBrowsableRoot(root: string): void {
  const forbidden = isForbiddenArchiveRoot(root);
  if (forbidden.forbidden) {
    throw new Error(forbidden.reason);
  }
  if (isBaselineRoot(root)) {
    throw new Error('refuses the baseline copy; open the separate work copy instead');
  }
}

export function folderFromRel(rel: string): string {
  const norm = rel.replace(/\\/g, '/');
  const dir = path.posix.dirname(norm);
  if (dir === '.' || dir === '') {
    return 'INBOX';
  }
  const parts = dir.split('/').filter((p) => p && p !== 'cur' && p !== 'new' && p !== 'tmp');
  return parts.join('/') || 'INBOX';
}

function isMailFile(rel: string): 'eml' | 'maildir' | 'mbox' | null {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.eml')) {
    return 'eml';
  }
  if (lower.endsWith('.mbox') || lower.endsWith('.mbx')) {
    return 'mbox';
  }
  if (/(^|\/)(cur|new)\/[^/]+$/.test(rel)) {
    return 'maildir';
  }
  return null;
}

function absPath(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const dir = rel ? absPath(root, rel) : root;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      await walk(root, childRel, out);
    } else if (ent.isFile() && isMailFile(childRel)) {
      // Snapshot metadata (.json/.txt/.log) is never treated as mail.
      out.push(childRel);
    }
  }
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function parseTs(date: string): number {
  if (!date) {
    return 0;
  }
  const t = Date.parse(date.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isFinite(t) ? t : 0;
}

/** Locate `"field": [ ... ]` in a huge JSON buffer and parse only that array. */
export function extractJsonField(buf: Buffer, field: string): unknown {
  const key = Buffer.from(`"${field}"`, 'utf8');
  const at = buf.indexOf(key);
  if (at === -1) {
    return undefined;
  }
  let i = at + key.length;
  while (i < buf.length && buf[i] !== 0x3a /* : */) i++;
  i++;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)
  )
    i++;
  const open = buf[i];
  const close = open === 0x5b ? 0x5d : open === 0x7b ? 0x7d : -1;
  if (close === -1) {
    // Scalar: read until , or }
    let j = i;
    while (j < buf.length && buf[j] !== 0x2c && buf[j] !== 0x7d) j++;
    try {
      return JSON.parse(buf.subarray(i, j).toString('utf8'));
    } catch {
      return undefined;
    }
  }
  let depth = 0;
  let inStr = false;
  for (let j = i; j < buf.length; j++) {
    const c = buf[j];
    if (inStr) {
      if (c === 0x5c) {
        j++;
      } else if (c === 0x22) {
        inStr = false;
      }
      continue;
    }
    if (c === 0x22) {
      inStr = true;
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(buf.subarray(i, j + 1).toString('utf8'));
      }
    }
  }
  return undefined;
}

async function readManifestInfo(root: string): Promise<{
  folderNames: { [k: string]: string };
  counts: { [k: string]: number } | null;
  total: number | null;
}> {
  const file = path.join(root, 'snapshot-manifest.json');
  const folderNames: { [k: string]: string } = {};
  try {
    const buf = await fs.promises.readFile(file, { flag: 'r' });
    const mapping = extractJsonField(buf, 'folderPathMapping') as Array<{
      original: string;
      stored: string;
    }>;
    if (Array.isArray(mapping)) {
      for (const m of mapping) {
        if (m && typeof m.stored === 'string' && typeof m.original === 'string') {
          folderNames[m.stored.replace(/\\/g, '/')] = m.original;
        }
      }
    }
    const counts = extractJsonField(buf, 'folderCounts') as { [k: string]: number } | undefined;
    const total = extractJsonField(buf, 'messageCount') as number | undefined;
    return {
      folderNames,
      counts: counts && typeof counts === 'object' ? counts : null,
      total: typeof total === 'number' ? total : null,
    };
  } catch {
    return { folderNames, counts: null, total: null };
  }
}

function loadCache(cachePath: string | undefined, root: string): OfflineMailIndex | null {
  if (!cachePath) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as OfflineMailIndex;
    if (parsed && parsed.version === OFFLINE_INDEX_VERSION && parsed.root === root) {
      return parsed;
    }
  } catch {
    // no cache
  }
  return null;
}

export function writeIndexCache(cachePath: string, index: OfflineMailIndex, root: string): void {
  const resolvedCache = path.resolve(cachePath);
  const resolvedRoot = path.resolve(root);
  const relToRoot = path.relative(resolvedRoot, resolvedCache);
  if (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
    throw new Error('refuses to write the index cache inside the archive');
  }
  fs.mkdirSync(path.dirname(resolvedCache), { recursive: true });
  const tmp = `${resolvedCache}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index));
  try {
    fs.renameSync(tmp, resolvedCache);
  } catch {
    try {
      fs.unlinkSync(resolvedCache);
    } catch {
      // ignore
    }
    fs.renameSync(tmp, resolvedCache);
  }
}

export async function buildOfflineMailIndex(
  root: string,
  opts: {
    cachePath?: string;
    onProgress?: (p: IndexProgress) => void;
    concurrency?: number;
  } = {}
): Promise<OfflineMailIndex> {
  assertBrowsableRoot(root);
  const started = Date.now();
  const st = await fs.promises.stat(root);
  if (!st.isDirectory()) {
    throw new Error('archive path is not a directory');
  }
  const progress = opts.onProgress || (() => {});
  progress({ phase: 'scan', done: 0, total: 0 });
  const files: string[] = [];
  await walk(root, '', files);
  files.sort();

  const cached = loadCache(opts.cachePath, root);
  const prior = new Map<string, OfflineIndexEntry>();
  if (cached) {
    for (const e of cached.entries) {
      prior.set(e.rel, e);
    }
  }

  const entries: OfflineIndexEntry[] = [];
  const unreadable: Array<{ rel: string; reason: string }> = [];
  let reused = 0;
  let parsed = 0;
  let rescanned = 0;
  const concurrency = Math.max(1, opts.concurrency || 24);
  let done = 0;
  progress({ phase: 'headers', done, total: files.length });

  const work = async (rel: string): Promise<OfflineIndexEntry[]> => {
    const abs = absPath(root, rel);
    const fst = await fs.promises.stat(abs);
    const kind = isMailFile(rel);
    if (kind === 'mbox') {
      const raw = (await fs.promises.readFile(abs, { flag: 'r' })).toString('latin1');
      const folder = path.posix.basename(rel, path.posix.extname(rel));
      return splitMboxrd(raw).map((part, i) => {
        const h = parseOfflineMailHeaders(part.slice(0, HEAD_BYTES));
        const att = scanOfflineMailAttachments(part);
        const partRel = `${rel}#${i + 1}`;
        return {
          id: offlineEntryId(partRel),
          rel: partRel,
          folder,
          size: part.length,
          mtimeMs: fst.mtimeMs,
          subject: h.subject,
          from: h.from,
          date: h.date,
          ts: parseTs(h.date),
          hasAttachments: att.count > 0,
          hebrew: containsHebrew(h.subject) || containsHebrew(h.from),
          to: h.to,
          cc: h.cc,
          replyTo: h.replyTo,
          msgId: h.msgId,
          inReplyTo: h.inReplyTo,
          refs: h.refs,
          attachCount: att.count,
          attachBytes: att.bytes,
          ...(att.count ? { attachNames: attachNamesForIndex(att.names) } : {}),
          attachScan: ATTACH_SCAN_VERSION,
        };
      });
    }
    const old = prior.get(rel);
    // Entries cached before recipients / thread headers were indexed are read once more.
    if (
      old &&
      old.size === fst.size &&
      old.mtimeMs === fst.mtimeMs &&
      old.to !== undefined &&
      old.msgId !== undefined
    ) {
      if (old.attachScan === ATTACH_SCAN_VERSION) {
        reused++;
        return [old];
      }
      // Older entry: headers are fine, only the attachment flag is re-checked (once).
      const att = await scanAttachmentsOfFile(abs, fst.size, await readHead(abs, HEAD_BYTES));
      rescanned++;
      const { attachNames: _oldNames, ...rest } = old;
      return [
        {
          ...rest,
          hasAttachments: att.count > 0,
          attachCount: att.count,
          attachBytes: att.bytes,
          ...(att.count && att.names.length ? { attachNames: att.names } : {}),
          attachScan: ATTACH_SCAN_VERSION,
        },
      ];
    }
    const head = await readHead(abs, HEAD_BYTES);
    const h = parseOfflineMailHeaders(head);
    const att = await scanAttachmentsOfFile(abs, fst.size, head);
    parsed++;
    return [
      {
        id: offlineEntryId(rel),
        rel,
        folder: folderFromRel(rel),
        size: fst.size,
        mtimeMs: fst.mtimeMs,
        subject: h.subject,
        from: h.from,
        date: h.date,
        ts: parseTs(h.date),
        hasAttachments: att.count > 0,
        hebrew: containsHebrew(h.subject) || containsHebrew(h.from),
        to: h.to,
        cc: h.cc,
        replyTo: h.replyTo,
        msgId: h.msgId,
        inReplyTo: h.inReplyTo,
        refs: h.refs,
        attachCount: att.count,
        attachBytes: att.bytes,
        ...(att.count && att.names.length ? { attachNames: att.names } : {}),
        attachScan: ATTACH_SCAN_VERSION,
      },
    ];
  };

  for (let i = 0; i < files.length; i += concurrency) {
    const slice = files.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map((rel) =>
        work(rel).catch((err) => {
          unreadable.push({ rel, reason: (err as Error).message || 'unreadable' });
          return [] as OfflineIndexEntry[];
        })
      )
    );
    for (const r of results) {
      entries.push(...r);
    }
    done += slice.length;
    progress({ phase: 'headers', done, total: files.length });
    // Yield to the UI thread between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  progress({ phase: 'manifest', done, total: files.length });
  const manifest = await readManifestInfo(root);
  const index: OfflineMailIndex = {
    version: OFFLINE_INDEX_VERSION,
    root,
    builtAt: new Date().toISOString(),
    entries,
    folderNames: manifest.folderNames,
    manifestFolderCounts: manifest.counts,
    manifestMessageCount: manifest.total,
    unreadable,
    stats: { reused, parsed, rescanned, ms: Date.now() - started },
  };
  if (opts.cachePath) {
    try {
      writeIndexCache(opts.cachePath, index, root);
    } catch (err) {
      unreadable.push({ rel: '(index cache)', reason: (err as Error).message });
    }
  }
  progress({ phase: 'done', done, total: files.length });
  return index;
}

/** Read one message's raw bytes read-only. */
export async function readOfflineMessageRaw(root: string, rel: string): Promise<Buffer> {
  assertBrowsableRoot(root);
  const hash = rel.lastIndexOf('#');
  if (hash !== -1 && /\.(mbox|mbx)#\d+$/i.test(rel)) {
    const file = rel.slice(0, hash);
    const n = parseInt(rel.slice(hash + 1), 10);
    const raw = (await fs.promises.readFile(absPath(root, file), { flag: 'r' })).toString('latin1');
    const part = splitMboxrd(raw)[n - 1];
    if (part === undefined) {
      throw new Error('mbox part not found');
    }
    return Buffer.from(part, 'latin1');
  }
  return fs.promises.readFile(absPath(root, rel), { flag: 'r' });
}

/**
 * The first `bytes` of one message (read-only), for the local search index.
 * Bodies come before attachments, so this holds the text of almost every mail.
 */
export async function readOfflineMessageHead(
  root: string,
  rel: string,
  bytes: number
): Promise<Buffer> {
  assertBrowsableRoot(root);
  if (/\.(mbox|mbx)#\d+$/i.test(rel)) {
    const all = await readOfflineMessageRaw(root, rel);
    return all.subarray(0, bytes);
  }
  return readHead(absPath(root, rel), bytes);
}

export function readOfflineMessageRawSync(root: string, rel: string): Buffer {
  assertBrowsableRoot(root);
  const hash = rel.lastIndexOf('#');
  if (hash !== -1 && /\.(mbox|mbx)#\d+$/i.test(rel)) {
    const file = rel.slice(0, hash);
    const n = parseInt(rel.slice(hash + 1), 10);
    const raw = fs.readFileSync(absPath(root, file), { flag: 'r' }).toString('latin1');
    const part = splitMboxrd(raw)[n - 1];
    if (part === undefined) {
      throw new Error('mbox part not found');
    }
    return Buffer.from(part, 'latin1');
  }
  return fs.readFileSync(absPath(root, rel), { flag: 'r' });
}

export async function loadOfflineMessage(root: string, rel: string): Promise<ParsedOfflineMail> {
  return parseOfflineMail(await readOfflineMessageRaw(root, rel));
}

export type OfflineFolderNode = {
  path: string;
  name: string;
  displayPath: string;
  count: number;
  totalCount: number;
  children: OfflineFolderNode[];
  depth: number;
};

const ROLE_ORDER = ['inbox', 'draft', 'drafts', 'sent', 'archive', 'bulk', 'spam', 'junk', 'trash'];

function roleRank(name: string): number {
  const i = ROLE_ORDER.indexOf(name.toLowerCase());
  return i === -1 ? ROLE_ORDER.length : i;
}

export function buildFolderTree(
  index: Pick<OfflineMailIndex, 'entries' | 'folderNames'>
): OfflineFolderNode[] {
  // Unique messages in each exact folder: a duplicate copy (same Message-ID
  // stored twice in one folder) counts once, like the message list.
  const counts: { [p: string]: number } = {};
  const seen = new Set<string>();
  for (const e of index.entries) {
    const k = `${e.folder}\u0000${messageKey(e)}`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    counts[e.folder] = (counts[e.folder] || 0) + 1;
  }
  const allPaths = new Set<string>(Object.keys(counts));
  for (const stored of Object.keys(index.folderNames || {})) {
    allPaths.add(stored);
  }
  const nodes = new Map<string, OfflineFolderNode>();
  const ensure = (p: string): OfflineFolderNode => {
    let n = nodes.get(p);
    if (n) {
      return n;
    }
    const parts = p.split('/');
    const original = (index.folderNames || {})[p];
    const displayPath = original || p;
    const displayParts = displayPath.split('/');
    n = {
      path: p,
      name: displayParts[displayParts.length - 1] || parts[parts.length - 1],
      displayPath,
      count: counts[p] || 0,
      totalCount: 0,
      children: [],
      depth: parts.length - 1,
    };
    nodes.set(p, n);
    if (parts.length > 1) {
      ensure(parts.slice(0, -1).join('/')).children.push(n);
    }
    return n;
  };
  for (const p of allPaths) {
    ensure(p);
  }
  const roots = Array.from(nodes.values()).filter((n) => n.depth === 0);
  const sortRec = (list: OfflineFolderNode[]): number => {
    list.sort((a, b) => {
      if (a.depth === 0 && b.depth === 0) {
        const r = roleRank(a.name) - roleRank(b.name);
        if (r !== 0) {
          return r;
        }
      }
      return a.name.localeCompare(b.name, 'he');
    });
    let sum = 0;
    for (const n of list) {
      n.totalCount = n.count + sortRec(n.children);
      sum += n.totalCount;
    }
    return sum;
  };
  sortRec(roots);
  return roots;
}
