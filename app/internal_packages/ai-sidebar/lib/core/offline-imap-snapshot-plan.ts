/**
 * Read-only IMAP snapshot *plan*. This module never opens a socket.
 *
 * Acquisition (later, native, user login) is EXAMINE + UID FETCH BODY.PEEK /
 * RFC822.SIZE. STORE, EXPUNGE, MOVE, APPEND, COPY, and SELECT are forbidden
 * so flags, deletes, and mailbox mutation cannot happen.
 *
 * Yahoo IMAP is typically imap.mail.yahoo.com:993. App passwords are often
 * required. This SHA does not connect and does not take credentials.
 */

export const YAHOO_IMAP_HOST = 'imap.mail.yahoo.com';
export const YAHOO_IMAP_PORT = 993;

/** Documented typical Yahoo folder names. Inventory all; do not silently skip. */
export const YAHOO_FOLDER_CANDIDATES = [
  'Inbox',
  'Sent',
  'Draft',
  'Bulk Mail',
  'Spam',
  'Trash',
  'Archive',
  'Starred',
] as const;

export const FORBIDDEN_IMAP_VERBS = [
  'STORE',
  'UID STORE',
  'EXPUNGE',
  'UID EXPUNGE',
  'MOVE',
  'UID MOVE',
  'APPEND',
  'COPY',
  'UID COPY',
  'CREATE',
  'DELETE',
  'RENAME',
  'SELECT',
] as const;

export const ALLOWED_IMAP_VERBS = [
  'CAPABILITY',
  'LOGIN',
  'AUTHENTICATE',
  'LIST',
  'LSUB',
  'EXAMINE',
  'UID FETCH',
  'FETCH',
  'NOOP',
  'LOGOUT',
] as const;

export type ImapFolderInventory = {
  path: string;
  selectable: boolean;
  exists: number | null;
  uidvalidity: number | null;
  status: 'listed' | 'unselectable' | 'examine-failed' | 'empty' | 'fetched';
  note: string;
};

export type DiskEstimate = {
  rfc822Bytes: number;
  recommendedFreeBytes: number;
  messageCount: number;
  unknownSizes: number;
};

const IMAP_LEADERS = new Set(
  [...FORBIDDEN_IMAP_VERBS, ...ALLOWED_IMAP_VERBS].map((v) => v.split(' ')[0])
);

export function normalizeImapCommand(raw: string): string {
  let n = String(raw || '')
    .trim()
    .toUpperCase();
  n = n.replace(/^\d+\s+/, '');
  const tagged = n.match(/^(\S+)\s+(.*)$/);
  if (tagged && !IMAP_LEADERS.has(tagged[1])) {
    n = tagged[2];
  }
  return n;
}

export function imapCommandKind(raw: string): 'allowed' | 'forbidden' | 'unknown' {
  const n = normalizeImapCommand(raw);
  if (!n) {
    return 'unknown';
  }
  for (const verb of FORBIDDEN_IMAP_VERBS) {
    if (n === verb || n.startsWith(`${verb} `)) {
      return 'forbidden';
    }
  }
  if (/\bBODY\.PEEK\b/.test(n) || /\bRFC822\.SIZE\b/.test(n) || /\bBODY\.PEEK\[\]/.test(n)) {
    return 'allowed';
  }
  for (const verb of ALLOWED_IMAP_VERBS) {
    if (n === verb || n.startsWith(`${verb} `)) {
      return 'allowed';
    }
  }
  return 'unknown';
}

export function assertReadOnlyImapCommand(raw: string): { ok: boolean; reason: string } {
  const kind = imapCommandKind(raw);
  if (kind === 'forbidden') {
    return {
      ok: false,
      reason: 'IMAP command would mutate mailbox or flags (STORE/EXPUNGE/MOVE/APPEND/SELECT)',
    };
  }
  if (kind === 'unknown') {
    return { ok: false, reason: 'IMAP command is not on the read-only allowlist' };
  }
  const n = normalizeImapCommand(raw);
  if (n.startsWith('FETCH ') && /\bBODY\[/.test(n) && !/\bBODY\.PEEK\b/.test(n)) {
    return {
      ok: false,
      reason: 'FETCH BODY[] can set \\Seen; use BODY.PEEK',
    };
  }
  if (n.startsWith('UID FETCH ') && /\bBODY\[/.test(n) && !/\bBODY\.PEEK\b/.test(n)) {
    return {
      ok: false,
      reason: 'UID FETCH BODY[] can set \\Seen; use BODY.PEEK',
    };
  }
  if (n.startsWith('SELECT ')) {
    return { ok: false, reason: 'SELECT is read-write; use EXAMINE' };
  }
  // RFC3501: RFC822 is BODY[]; RFC822.TEXT is BODY[TEXT]; both can set \Seen.
  if (
    /\bRFC822\.TEXT\b/.test(n) ||
    (/\bRFC822\b/.test(n) && !/\bRFC822\.(SIZE|PEEK|HEADER)\b/.test(n))
  ) {
    return {
      ok: false,
      reason: 'FETCH RFC822 / RFC822.TEXT can set \\Seen; use BODY.PEEK[]',
    };
  }
  return { ok: true, reason: '' };
}

export function estimateArchiveDisk(sizes: Array<number | null | undefined>): DiskEstimate {
  let rfc822Bytes = 0;
  let unknownSizes = 0;
  let messageCount = 0;
  for (const s of sizes) {
    messageCount += 1;
    if (typeof s === 'number' && Number.isFinite(s) && s >= 0) {
      rfc822Bytes += Math.floor(s);
    } else {
      unknownSizes += 1;
    }
  }
  // Maildir + manifest + hashes: ~15% overhead, plus 64MiB working margin.
  const recommendedFreeBytes = Math.ceil(rfc822Bytes * 1.15) + 64 * 1024 * 1024;
  return { rfc822Bytes, recommendedFreeBytes, messageCount, unknownSizes };
}

export function inventoryFolders(listed: ImapFolderInventory[]): {
  totalListed: number;
  selectable: number;
  unselectable: ImapFolderInventory[];
  empty: ImapFolderInventory[];
  examineFailed: ImapFolderInventory[];
  missingCandidates: string[];
} {
  const names = new Set(listed.map((f) => f.path.toLowerCase()));
  const missingCandidates = YAHOO_FOLDER_CANDIDATES.filter((c) => !names.has(c.toLowerCase()));
  return {
    totalListed: listed.length,
    selectable: listed.filter((f) => f.selectable).length,
    unselectable: listed.filter((f) => !f.selectable || f.status === 'unselectable'),
    empty: listed.filter((f) => f.status === 'empty' || f.exists === 0),
    examineFailed: listed.filter((f) => f.status === 'examine-failed'),
    missingCandidates,
  };
}

export function snapshotResumeKey(folderPath: string, uidvalidity: number, uid: number): string {
  return `${folderPath}\u0000${uidvalidity}:${uid}`;
}

/**
 * Planned steps for a later native snapshotter. Not executed here.
 * LOGIN is listed because IMAP requires it; credentials stay with the parent.
 */
export function plannedImapSnapshotSteps(): string[] {
  return [
    `TLS connect ${YAHOO_IMAP_HOST}:${YAHOO_IMAP_PORT} (not performed this SHA)`,
    'CAPABILITY',
    'AUTHENTICATE / LOGIN (user, later; never this cloud agent)',
    'LIST "" "*"',
    'For every listed mailbox including Bulk/Spam/Trash: EXAMINE (not SELECT)',
    'UID FETCH 1:* (RFC822.SIZE) for disk estimate before BODY.PEEK',
    'Parent confirms free disk >= recommendedFreeBytes',
    'UID FETCH … BODY.PEEK[] write immutable .eml + sha256; resume by UIDVALIDITY+UID',
    'Manifest: counts, hashes, unselectable, empty, examine-failed, missing candidates',
    'LOGOUT',
    'Copy archive to a disposable working tree; original stays read-only',
  ];
}
