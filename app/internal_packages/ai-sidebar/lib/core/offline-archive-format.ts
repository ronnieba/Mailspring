/**
 * Immutable .eml / mboxrd / Maildir archive import. Original files are never
 * written. Working copies are independent trees. Remote images and scripts are
 * stripped for display. No Yahoo access.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { displayFromRfc822 } from './offline-mime-display';

export { stripRemoteHtml } from './offline-mime-display';

export const OFFLINE_ARCHIVE_ACCOUNT_ID = 'offline-archive-account';
export const OFFLINE_MSG_ID = /^offline-[a-f0-9]{16}$/;

export type OfflineArchiveMessage = {
  id: string;
  threadId: string;
  accountId: typeof OFFLINE_ARCHIVE_ACCOUNT_ID;
  folderId: string;
  folderPath: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyText: string;
  sha256: string;
  byteLength: number;
  attachmentCount: number;
  sourceRelPath: string;
};

export type OfflineArchiveManifest = {
  version: 1;
  kind: 'offline-archive';
  originalRoot: string;
  messageCount: number;
  folderCounts: Record<string, number>;
  sha256All: string;
  unreadable: Array<{ path: string; reason: string }>;
  emptyFolders: string[];
};

export type FsLike = {
  readdirSync(p: string, opts?: { withFileTypes?: boolean }): any;
  readFileSync(p: string): Buffer;
  statSync(p: string): { isDirectory(): boolean; isFile(): boolean; size: number };
  copyFileSync?(src: string, dest: string): void;
  mkdirSync?(p: string, opts?: { recursive?: boolean }): void;
  writeFileSync?(p: string, data: string | Buffer): void;
};

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function offlineMessageIdFromHash(sha256: string): string {
  return `offline-${sha256.slice(0, 16)}`;
}

export function isOfflineArchiveMailRef(m: { id?: unknown; accountId?: unknown }): boolean {
  return (
    typeof m.id === 'string' &&
    OFFLINE_MSG_ID.test(m.id) &&
    m.accountId === OFFLINE_ARCHIVE_ACCOUNT_ID
  );
}

/**
 * Refuse official Mailspring profile/cache paths. That cache is not a complete
 * backup (bodyProgress, live mailsync) and must not be scraped for credentials.
 */
export function isForbiddenArchiveRoot(p: string): { forbidden: boolean; reason: string } {
  if (!p || typeof p !== 'string') {
    return { forbidden: true, reason: 'archive path is required' };
  }
  if (!path.isAbsolute(p)) {
    return { forbidden: true, reason: 'archive path must be absolute' };
  }
  const n = p.replace(/\\/g, '/');
  if (/edgehill\.db$/i.test(n) || /\/config\.json$/i.test(n)) {
    return {
      forbidden: true,
      reason: 'refuses Mailspring database/profile files; that cache is not a complete backup',
    };
  }
  if (/\/Mailspring(\/|$)/.test(n) && !/\/Mailspring-(dev|demo|spec|offline)(\/|$)/.test(n)) {
    return {
      forbidden: true,
      reason: 'refuses official Mailspring profile/cache; do not copy or scrape it',
    };
  }
  return { forbidden: false, reason: '' };
}

export function parseRfc822Headers(raw: string): {
  from: string;
  subject: string;
  date: string;
  messageId: string;
  contentType: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  const headers = (headerEnd === -1 ? normalized : normalized.slice(0, headerEnd)).replace(
    /\n[ \t]+/g,
    ' '
  );
  const get = (name: string) => {
    const match = headers.match(new RegExp(`^${name}:(.*)$`, 'im'));
    return match ? match[1].trim() : '';
  };
  return {
    from: get('from') || '(Unknown)',
    subject: get('subject') || '(No Subject)',
    date: get('date') || '',
    messageId: get('message-id') || '',
    contentType: get('content-type') || '',
  };
}

export function rfc822Body(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  return headerEnd === -1 ? '' : normalized.slice(headerEnd + 2);
}

export function countAttachments(raw: string): number {
  const matches = raw.match(/Content-Disposition:\s*attachment/gi);
  return matches ? matches.length : 0;
}

export function splitMboxrd(raw: string): string[] {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.trim()) {
    return [];
  }
  const parts = text.split(/\nFrom /);
  const messages: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (!part.trim()) {
      continue;
    }
    if (part.startsWith('From ')) {
      const nl = part.indexOf('\n');
      part = nl === -1 ? '' : part.slice(nl + 1);
    } else if (i > 0) {
      // split consumed the "From " token; first line is the rest of the separator.
      const nl = part.indexOf('\n');
      part = nl === -1 ? '' : part.slice(nl + 1);
    }
    const unquoted = part.replace(/^>(>*From )/gm, '$1');
    if (unquoted.trim()) {
      messages.push(unquoted);
    }
  }
  return messages;
}

export function messageFromRfc822(
  raw: string,
  sourceRelPath: string,
  folderPath: string
): OfflineArchiveMessage {
  const buf = Buffer.from(raw, 'latin1');
  const sha256 = sha256Hex(buf);
  const display = displayFromRfc822(raw);
  const snippet = display.bodyText.replace(/\s+/g, ' ').trim().slice(0, 160);
  const folderId = folderPath.replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_') || 'INBOX';
  return {
    id: offlineMessageIdFromHash(sha256),
    threadId: `offline-thread-${sha256.slice(0, 12)}`,
    accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
    folderId,
    folderPath,
    subject: display.subject,
    from: display.from,
    date: display.date,
    snippet,
    bodyText: display.bodyText,
    sha256,
    byteLength: buf.length,
    attachmentCount: display.attachmentCount,
    sourceRelPath,
  };
}

function listFilesRecursive(root: string, io: FsLike, rel = ''): string[] {
  const abs = rel ? path.join(root, rel) : root;
  const entries = io.readdirSync(abs, { withFileTypes: true }) as Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  const out: string[] = [];
  for (const ent of entries) {
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.name === '.' || ent.name === '..') {
      continue;
    }
    if (ent.isDirectory()) {
      out.push(...listFilesRecursive(root, io, childRel));
    } else if (ent.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

function folderFromRel(rel: string): string {
  const dir = path.dirname(rel).replace(/\\/g, '/');
  if (dir === '.' || dir === '') {
    return 'INBOX';
  }
  const parts = dir.split('/').filter((p) => p && p !== 'cur' && p !== 'new' && p !== 'tmp');
  return parts.join('/') || 'INBOX';
}

export function readOfflineArchive(
  originalRoot: string,
  io: FsLike = fs
): { messages: OfflineArchiveMessage[]; manifest: OfflineArchiveManifest } {
  const files = listFilesRecursive(originalRoot, io);
  const messages: OfflineArchiveMessage[] = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  const folderSet = new Set<string>();
  const folderCounts: Record<string, number> = {};

  for (const rel of files.sort()) {
    const lower = rel.toLowerCase();
    const abs = path.join(originalRoot, rel);
    if (lower.endsWith('.eml') || /\/(cur|new)\/[^/]+$/.test(rel.replace(/\\/g, '/'))) {
      try {
        const raw = io.readFileSync(abs).toString('latin1');
        const folderPath = folderFromRel(rel);
        folderSet.add(folderPath);
        const msg = messageFromRfc822(raw, rel, folderPath);
        messages.push(msg);
        folderCounts[folderPath] = (folderCounts[folderPath] || 0) + 1;
      } catch (err) {
        unreadable.push({ path: rel, reason: (err as Error).message || 'unreadable' });
      }
      continue;
    }
    if (lower.endsWith('.mbox') || lower.endsWith('.mbx')) {
      try {
        const raw = io.readFileSync(abs).toString('latin1');
        const folderPath = path.basename(rel, path.extname(rel));
        folderSet.add(folderPath);
        const parts = splitMboxrd(raw);
        if (parts.length === 0) {
          folderSet.add(folderPath);
        }
        parts.forEach((part, i) => {
          const msg = messageFromRfc822(part, `${rel}#${i + 1}`, folderPath);
          messages.push(msg);
          folderCounts[folderPath] = (folderCounts[folderPath] || 0) + 1;
        });
      } catch (err) {
        unreadable.push({ path: rel, reason: (err as Error).message || 'unreadable' });
      }
    }
  }

  const emptyFolders = [...folderSet].filter((f) => !folderCounts[f]);
  const hashMaterial = messages
    .map((m) => `${m.sha256} ${m.sourceRelPath}`)
    .sort()
    .join('\n');
  const manifest: OfflineArchiveManifest = {
    version: 1,
    kind: 'offline-archive',
    originalRoot,
    messageCount: messages.length,
    folderCounts,
    sha256All: sha256Hex(hashMaterial),
    unreadable,
    emptyFolders,
  };
  return { messages, manifest };
}

export function materializeWorkingCopy(opts: {
  originalRoot: string;
  workRoot: string;
  io: FsLike;
}): { copied: number; originalHashes: Record<string, string> } {
  const files = listFilesRecursive(opts.originalRoot, opts.io);
  const originalHashes: Record<string, string> = {};
  let copied = 0;
  if (!opts.io.mkdirSync || !opts.io.copyFileSync || !opts.io.writeFileSync) {
    throw new Error('working copy requires mkdirSync/copyFileSync/writeFileSync');
  }
  opts.io.mkdirSync(opts.workRoot, { recursive: true });
  for (const rel of files) {
    const src = path.join(opts.originalRoot, rel);
    const dest = path.join(opts.workRoot, rel);
    const buf = opts.io.readFileSync(src);
    originalHashes[rel] = sha256Hex(buf);
    opts.io.mkdirSync(path.dirname(dest), { recursive: true });
    opts.io.copyFileSync(src, dest);
    copied += 1;
  }
  opts.io.writeFileSync(
    path.join(opts.workRoot, 'offline-work-copy.json'),
    JSON.stringify({ originalRoot: opts.originalRoot, copied, originalHashes }, null, 2)
  );
  return { copied, originalHashes };
}

export function originalHashesUnchanged(
  originalRoot: string,
  expected: Record<string, string>,
  io: FsLike
): boolean {
  for (const rel of Object.keys(expected)) {
    const buf = io.readFileSync(path.join(originalRoot, rel));
    if (sha256Hex(buf) !== expected[rel]) {
      return false;
    }
  }
  return true;
}
