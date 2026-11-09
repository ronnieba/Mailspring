/**
 * Whole-archive hashing of finalized .eml files. Deterministic path order.
 * Sidecars and .partial files are not part of the aggregate.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PROGRESS_LOG, STATUS_FILE } from './progress';

export const MANIFEST_FILE = 'snapshot-manifest.json';
export const STATE_FILE = 'snapshot-state.json';
export const HASH_LIST_FILE = 'snapshot-hashes.txt';
export { PROGRESS_LOG, STATUS_FILE } from './progress';

export type HashedEml = {
  rel: string;
  sha256: string;
  bytes: number;
};

export type SizeMismatch = {
  rel: string;
  expected: number;
  actual: number;
};

export type ArchiveHashResult = {
  files: HashedEml[];
  sha256All: string;
  listing: string;
};

export const CONSOLE_LOG = 'snapshot-console.log';

const SKIP_NAMES = new Set([
  MANIFEST_FILE,
  STATE_FILE,
  HASH_LIST_FILE,
  PROGRESS_LOG,
  STATUS_FILE,
  CONSOLE_LOG,
  'offline-work-copy.json',
  `${STATE_FILE}.partial`,
  `${MANIFEST_FILE}.partial`,
  `${STATUS_FILE}.partial`,
]);

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

function listFilesRecursive(root: string, rel = ''): string[] {
  const abs = rel ? path.join(root, rel) : root;
  if (!fs.existsSync(abs)) {
    return [];
  }
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const out: string[] = [];
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..') {
      continue;
    }
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) {
      out.push(...listFilesRecursive(root, childRel));
    } else if (ent.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

export function listFinalizedEmlRels(root: string): string[] {
  return listFilesRecursive(root)
    .filter((rel) => {
      const base = path.basename(rel);
      if (SKIP_NAMES.has(base) || base.endsWith('.partial')) {
        return false;
      }
      return base.endsWith('.eml');
    })
    .map(toPosixRel)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function hashListingText(files: HashedEml[]): string {
  const sorted = files.slice().sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  if (sorted.length === 0) {
    return '';
  }
  return sorted.map((f) => `${f.sha256}  ${f.bytes}  ${f.rel}`).join('\n') + '\n';
}

export function aggregateSha256(files: HashedEml[]): string {
  return sha256Hex(hashListingText(files));
}

export function hashEmlTree(root: string): ArchiveHashResult {
  const rels = listFinalizedEmlRels(root);
  const files: HashedEml[] = rels.map((rel) => {
    const buf = fs.readFileSync(path.join(root, rel.split('/').join(path.sep)));
    return { rel, sha256: sha256Hex(buf), bytes: buf.length };
  });
  const listing = hashListingText(files);
  return { files, sha256All: sha256Hex(listing), listing };
}

export function sizeMismatchesAgainstRfc822(
  files: HashedEml[],
  rfc822ByRel: Map<string, number>
): SizeMismatch[] {
  const out: SizeMismatch[] = [];
  for (const f of files) {
    const expected = rfc822ByRel.get(f.rel);
    if (typeof expected === 'number' && Number.isFinite(expected) && expected !== f.bytes) {
      out.push({ rel: f.rel, expected, actual: f.bytes });
    }
  }
  return out;
}

export type StateLike = {
  complete?: boolean;
  folders?: Record<string, { uidvalidity?: number; doneUids?: number[] }>;
};

export function stateFileCount(state: StateLike | null): number {
  if (!state || !state.folders) {
    return 0;
  }
  let n = 0;
  for (const rec of Object.values(state.folders)) {
    n += Array.isArray(rec.doneUids) ? rec.doneUids.length : 0;
  }
  return n;
}

export type VerifyIssue = {
  kind: 'missing' | 'extra' | 'hash' | 'size' | 'count' | 'work-copy';
  rel?: string;
};

export type VerifyResult = {
  ok: boolean;
  complete: boolean;
  reason: string;
  fileCount: number;
  sha256All: string;
  expectedSha256All: string | null;
  issues: VerifyIssue[];
  sizeMismatches: SizeMismatch[];
};

function loadJson(p: string): unknown | null {
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function verifySnapshotArchive(dest: string, workCopy?: string | null): VerifyResult {
  const hashed = hashEmlTree(dest);
  const manifest = loadJson(path.join(dest, MANIFEST_FILE)) as {
    complete?: boolean;
    sha256All?: string;
    messageCount?: number;
    files?: HashedEml[];
  } | null;
  const state = loadJson(path.join(dest, STATE_FILE)) as StateLike | null;
  const issues: VerifyIssue[] = [];
  const sizeMismatches: SizeMismatch[] = [];
  const expectedSha =
    manifest && typeof manifest.sha256All === 'string' ? manifest.sha256All : null;

  if (expectedSha && expectedSha !== hashed.sha256All) {
    issues.push({ kind: 'hash' });
  }
  if (manifest && Array.isArray(manifest.files)) {
    const byRel = new Map(manifest.files.map((f) => [f.rel, f]));
    for (const f of hashed.files) {
      const exp = byRel.get(f.rel);
      if (!exp) {
        issues.push({ kind: 'extra', rel: f.rel });
        continue;
      }
      if (exp.sha256 !== f.sha256) {
        issues.push({ kind: 'hash', rel: f.rel });
      }
      if (typeof exp.bytes === 'number' && exp.bytes !== f.bytes) {
        sizeMismatches.push({ rel: f.rel, expected: exp.bytes, actual: f.bytes });
        issues.push({ kind: 'size', rel: f.rel });
      }
      byRel.delete(f.rel);
    }
    for (const rel of byRel.keys()) {
      issues.push({ kind: 'missing', rel });
    }
  }
  const stateCount = stateFileCount(state);
  if (state && stateCount !== hashed.files.length) {
    issues.push({ kind: 'count' });
  }
  if (
    manifest &&
    typeof manifest.messageCount === 'number' &&
    manifest.messageCount !== hashed.files.length
  ) {
    issues.push({ kind: 'count' });
  }

  if (workCopy) {
    const work = hashEmlTree(workCopy);
    if (work.sha256All !== hashed.sha256All) {
      issues.push({ kind: 'work-copy' });
    }
    if (work.files.length !== hashed.files.length) {
      issues.push({ kind: 'work-copy' });
    }
  }

  const complete = !!(manifest && manifest.complete && state && state.complete);
  const ok = issues.length === 0 && sizeMismatches.length === 0;
  let reason = '';
  if (!ok) {
    reason = `verify failed issues=${issues.length} sizeMismatches=${sizeMismatches.length}`;
  } else if (!complete) {
    reason = 'verify-ok-incomplete';
  }
  return {
    ok,
    complete,
    reason,
    fileCount: hashed.files.length,
    sha256All: hashed.sha256All,
    expectedSha256All: expectedSha,
    issues,
    sizeMismatches,
  };
}

export function writeHashList(dest: string, listing: string) {
  const tmp = path.join(dest, `${HASH_LIST_FILE}.partial`);
  fs.writeFileSync(tmp, listing);
  fs.renameSync(tmp, path.join(dest, HASH_LIST_FILE));
}
