import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  inventoryFolders,
  ImapFolderInventory,
} from '../../internal_packages/ai-sidebar/lib/core/offline-imap-snapshot-plan';
import { isForbiddenArchiveRoot } from '../../internal_packages/ai-sidebar/lib/core/offline-archive-format';
import { materializeWorkingCopy } from '../../internal_packages/ai-sidebar/lib/core/offline-archive-format';
import {
  CONSOLE_LOG,
  HASH_LIST_FILE,
  HashedEml,
  SizeMismatch,
  hashEmlTree,
  sizeMismatchesAgainstRfc822,
  stateFileCount,
  writeHashList,
} from './archive-hash';
import { checkDiskForSnapshot } from './disk';
import { ListMailbox, uidGaps } from './imap-protocol';
import { ReadOnlyImapSession, SnapshotLog } from './read-only-session';
import {
  RetryPolicy,
  classifySnapshotError,
  defaultRetryPolicy,
  retryReasonToken,
  retryWaitMs,
  bodyPeekTimeoutMs,
} from './retry';
import {
  PROGRESS_LOG,
  STATUS_FILE,
  appendProgressLog,
  writeSnapshotStatus,
  SnapshotStatus,
} from './progress';
import { SnapshotConnectTarget } from './yahoo-config';

export { verifySnapshotArchive } from './archive-hash';
export { bodyPeekTimeoutMs, classifySnapshotError } from './retry';

export type SnapshotFolderRecord = {
  path: string;
  raw: string;
  selectable: boolean;
  exists: number | null;
  uidvalidity: number | null;
  uidnext: number | null;
  fetched: number;
  unread: number;
  gaps: number[];
  arrivedDuringSnapshot: number[];
  status: ImapFolderInventory['status'];
  note: string;
  examineReadOnly: boolean;
};

export type SnapshotManifest = {
  version: 1;
  kind: 'imap-readonly-snapshot';
  host: string;
  tls: boolean;
  complete: boolean;
  messageCount: number;
  folderCounts: Record<string, number>;
  folders: SnapshotFolderRecord[];
  missingCandidates: string[];
  unselectable: string[];
  empty: string[];
  examineFailed: string[];
  sha256All: string;
  files: HashedEml[];
  sizeMismatches: SizeMismatch[];
  disk: {
    rfc822Bytes: number;
    recommendedFreeBytes: number;
    freeBytes: number | null;
    unknownSizes: number;
  };
};

export type SnapshotState = {
  complete: boolean;
  folders: Record<string, { uidvalidity: number; doneUids: number[] }>;
};

const STATE_FILE = 'snapshot-state.json';
const MANIFEST_FILE = 'snapshot-manifest.json';

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countLog(msg: string, extra: Record<string, number | string | boolean>): string {
  const bits = Object.keys(extra)
    .sort()
    .map((k) => `${k}=${extra[k]}`);
  return `snapshot: ${msg} ${bits.join(' ')}`.trim();
}

function isDestRootSidecar(name: string): boolean {
  return (
    name === PROGRESS_LOG ||
    name === STATUS_FILE ||
    name === `${STATUS_FILE}.partial` ||
    name === HASH_LIST_FILE ||
    name === CONSOLE_LOG ||
    name === 'offline-work-copy.json' ||
    name === `${STATE_FILE}.partial` ||
    name === `${MANIFEST_FILE}.partial`
  );
}

export function destOverwriteGuard(dest: string): {
  ok: boolean;
  reason: string;
  resumable: boolean;
} {
  const forbidden = isForbiddenArchiveRoot(dest);
  if (forbidden.forbidden) {
    return { ok: false, reason: forbidden.reason, resumable: false };
  }
  if (!fs.existsSync(dest)) {
    return { ok: true, reason: '', resumable: false };
  }
  // Progress/status/console sidecars are not archive content. A detached
  // nohup redirect may create dest/snapshot-console.log before execute.
  const names = fs
    .readdirSync(dest)
    .filter((n) => n !== '.' && n !== '..' && !isDestRootSidecar(n));
  if (names.length === 0) {
    return { ok: true, reason: '', resumable: false };
  }
  const manifestPath = path.join(dest, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      if (m.complete) {
        return {
          ok: false,
          reason: 'refuses to overwrite a complete preexisting archive',
          resumable: false,
        };
      }
    } catch {
      return {
        ok: false,
        reason: 'refuses to overwrite dest with an unreadable manifest',
        resumable: false,
      };
    }
  }
  const statePath = path.join(dest, STATE_FILE);
  if (fs.existsSync(statePath)) {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8')) as SnapshotState;
      if (!s.complete) {
        return { ok: true, reason: '', resumable: true };
      }
    } catch {
      return {
        ok: false,
        reason: 'refuses dest with corrupt snapshot-state.json',
        resumable: false,
      };
    }
  }
  return {
    ok: false,
    reason: 'refuses to overwrite a preexisting non-empty archive',
    resumable: false,
  };
}

function loadState(dest: string): SnapshotState {
  const p = path.join(dest, STATE_FILE);
  if (!fs.existsSync(p)) {
    return { complete: false, folders: {} };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as SnapshotState;
}

function saveState(dest: string, state: SnapshotState) {
  const tmp = path.join(dest, `${STATE_FILE}.partial`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path.join(dest, STATE_FILE));
}

function atomicWriteEml(dir: string, uid: number, raw: Buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${uid}.eml`);
  const tmp = path.join(dir, `${uid}.eml.partial`);
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, finalPath);
  return { path: finalPath, sha256: sha256Hex(raw) };
}

function folderDir(dest: string, unicodePath: string): string {
  return path.join(dest, unicodePath.replace(/[\\/]/g, path.sep));
}

export async function runReadOnlySnapshot(opts: {
  target: SnapshotConnectTarget;
  username: string;
  password: string;
  dest: string;
  workCopy?: string | null;
  preflightOnly?: boolean;
  execute?: boolean;
  allowUnknownSizes?: boolean;
  freeBytes?: number | null;
  log?: SnapshotLog;
  /** Test hook: inject fake-server messages after SIZE inventory, before BODY.PEEK. */
  onAfterPreflight?: () => void | Promise<void>;
  retry?: Partial<RetryPolicy>;
  peekTimeoutMs?: (rfc822Size: number | null | undefined) => number;
}): Promise<{
  ok: boolean;
  reason: string;
  manifest: SnapshotManifest | null;
  preflight: boolean;
}> {
  const userLog = opts.log || (() => undefined);
  let destClaimed = false;
  const log = (line: string) => {
    userLog(line);
    if (destClaimed && opts.execute && opts.dest) {
      appendProgressLog(opts.dest, line);
    }
  };
  const policy = defaultRetryPolicy(opts.retry);
  const peekTimeout = opts.peekTimeoutMs || bodyPeekTimeoutMs;
  let session: ReadOnlyImapSession | null = null;
  let examinedRaw: string | null = null;
  let consecutive = 0;

  const closeQuiet = () => {
    if (session) {
      try {
        session.destroy();
      } catch {
        // ignore
      }
    }
    session = null;
    examinedRaw = null;
  };

  const connectFresh = async (): Promise<ReadOnlyImapSession> => {
    const s = new ReadOnlyImapSession((line) => log(line));
    try {
      await s.connect(opts.target);
      await s.capability();
      await s.login(opts.username, opts.password);
      return s;
    } catch (err) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
      throw err;
    }
  };

  const withRetry = async <T>(op: (s: ReadOnlyImapSession) => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        if (!session || !session.connected) {
          session = await connectFresh();
          examinedRaw = null;
        }
        const result = await op(session);
        consecutive = 0;
        return result;
      } catch (err) {
        const kind = classifySnapshotError(err);
        if (kind === 'auth' || kind === 'fatal') {
          throw err;
        }
        consecutive += 1;
        if (consecutive > policy.maxConsecutive) {
          throw new Error(
            `retry cap ${policy.maxConsecutive} without progress reason=${retryReasonToken(err)}`
          );
        }
        const wait = retryWaitMs(consecutive, policy.baseMs, policy.capMs);
        log(
          `snapshot: retry ${consecutive}/${policy.maxConsecutive} reason=${retryReasonToken(err)} wait=${Math.round(wait / 1000)}s`
        );
        await policy.sleep(wait);
        closeQuiet();
      }
    }
  };

  try {
    const listed = await withRetry((s) => s.listAll());
    log(countLog('list', { mailboxes: listed.length }));

    const folderRows: SnapshotFolderRecord[] = [];
    const sizes: Array<number | null> = [];
    const preflightUids = new Map<string, { uids: number[]; uidvalidity: number }>();

    for (const box of listed) {
      const rec = await withRetry(async (s) => {
        const r = await preflightFolder(s, box, log);
        examinedRaw = box.selectable ? box.raw : examinedRaw;
        return r;
      });
      folderRows.push(rec);
      if (rec.status === 'fetched' || rec.status === 'listed' || rec.status === 'empty') {
        const rows =
          rec.status === 'empty'
            ? []
            : await withRetry(async (s) => {
                if (examinedRaw !== box.raw) {
                  const ex = await s.examine(box.raw);
                  if (!ex.ok) {
                    throw new Error('EXAMINE failed');
                  }
                  examinedRaw = box.raw;
                }
                return s.fetchSizes();
              });
        const unread = rows.filter((r) => !r.flags.some((f) => /^\\Seen$/i.test(f))).length;
        rec.unread = unread;
        rec.gaps = uidGaps(rows.map((r) => r.uid));
        rec.fetched = 0;
        if (rec.uidvalidity != null) {
          preflightUids.set(box.raw, {
            uids: rows.map((r) => r.uid),
            uidvalidity: rec.uidvalidity,
          });
        }
        for (const r of rows) {
          sizes.push(r.size);
        }
        log(
          countLog('examine', {
            exists: rec.exists ?? 0,
            unread,
            gaps: rec.gaps.length,
            selectable: rec.selectable ? 1 : 0,
          })
        );
      }
    }

    const inv = inventoryFolders(
      folderRows.map((f) => ({
        path: f.path,
        selectable: f.selectable,
        exists: f.exists,
        uidvalidity: f.uidvalidity,
        status: f.status,
        note: f.note,
      }))
    );
    const disk = checkDiskForSnapshot({
      dest: opts.dest,
      sizes,
      allowUnknownSizes: opts.allowUnknownSizes,
      freeBytes: opts.freeBytes,
    });
    log(
      countLog('disk', {
        rfc822: sizes.reduce((a, s) => a + (s || 0), 0),
        recommended: disk.recommendedFreeBytes,
        free: disk.freeBytes ?? 0,
        unknown: disk.unknownSizes,
      })
    );

    const manifestBase = (complete: boolean, sha: string): SnapshotManifest => ({
      version: 1,
      kind: 'imap-readonly-snapshot',
      host: opts.target.host,
      tls: opts.target.tls,
      complete,
      messageCount: folderRows.reduce((a, f) => a + f.fetched, 0),
      folderCounts: Object.fromEntries(folderRows.map((f) => [f.path, f.fetched])),
      folders: folderRows,
      missingCandidates: inv.missingCandidates,
      unselectable: inv.unselectable.map((u) => u.path),
      empty: inv.empty.map((u) => u.path),
      examineFailed: inv.examineFailed.map((u) => u.path),
      sha256All: sha,
      files: [],
      sizeMismatches: [],
      disk: {
        rfc822Bytes: sizes.reduce((a, s) => a + (s || 0), 0),
        recommendedFreeBytes: disk.recommendedFreeBytes,
        freeBytes: disk.freeBytes,
        unknownSizes: disk.unknownSizes,
      },
    });

    if (opts.preflightOnly || !opts.execute) {
      try {
        await session?.logout();
      } catch {
        closeQuiet();
      }
      return {
        ok: true,
        reason: disk.ok ? 'preflight-ok' : disk.reason,
        manifest: manifestBase(false, ''),
        preflight: true,
      };
    }

    if (opts.onAfterPreflight) {
      await opts.onAfterPreflight();
    }

    if (!disk.ok) {
      try {
        await session?.logout();
      } catch {
        closeQuiet();
      }
      return { ok: false, reason: disk.reason, manifest: manifestBase(false, ''), preflight: true };
    }

    const guard = destOverwriteGuard(opts.dest);
    if (!guard.ok) {
      try {
        await session?.logout();
      } catch {
        closeQuiet();
      }
      return { ok: false, reason: guard.reason, manifest: null, preflight: true };
    }
    fs.mkdirSync(opts.dest, { recursive: true });
    destClaimed = true;
    const state = guard.resumable ? loadState(opts.dest) : { complete: false, folders: {} };
    const stampStatus = (s: Omit<SnapshotStatus, 'updatedAt'>) => {
      const lastStatus = { ...s, updatedAt: new Date().toISOString() };
      writeSnapshotStatus(opts.dest, lastStatus);
      log(
        countLog('status', {
          ok: s.ok ? 1 : 0,
          complete: s.complete ? 1 : 0,
          files: s.fileCount ?? 0,
        })
      );
    };

    const rfc822ByRel = new Map<string, number>();
    for (const box of listed) {
      if (!box.selectable) {
        continue;
      }
      const rec = folderRows.find((f) => f.raw === box.raw);
      if (!rec || rec.status === 'examine-failed' || rec.status === 'unselectable') {
        continue;
      }
      const examined = await withRetry((s) => s.examine(box.raw));
      examinedRaw = box.raw;
      if (!examined.ok || examined.uidvalidity == null) {
        rec.status = 'examine-failed';
        rec.note = 'examine failed at download';
        continue;
      }
      const planned = preflightUids.get(box.raw);
      if (planned && planned.uidvalidity !== examined.uidvalidity) {
        rec.note = `UIDVALIDITY changed ${planned.uidvalidity}->${examined.uidvalidity}; refuse mix`;
        rec.status = 'examine-failed';
        log(countLog('uidvalidity-mismatch', { folder: 1 }));
        continue;
      }
      const prev = state.folders[box.raw];
      if (prev && prev.uidvalidity !== examined.uidvalidity) {
        rec.note = 'UIDVALIDITY changed vs resume state; refuse mix';
        rec.status = 'examine-failed';
        continue;
      }
      const expectedUv = examined.uidvalidity;
      const sizeRows = await withRetry(async (s) => {
        if (examinedRaw !== box.raw) {
          const ex = await s.examine(box.raw);
          if (!ex.ok || ex.uidvalidity !== expectedUv) {
            throw new Error(`UIDVALIDITY changed ${expectedUv}->${ex.uidvalidity}; refuse mix`);
          }
          examinedRaw = box.raw;
        }
        return s.fetchSizes();
      });
      const nowUids = sizeRows.map((r) => r.uid);
      const extra = nowUids.filter((u) => planned && !planned.uids.includes(u));
      rec.arrivedDuringSnapshot = extra;
      const toFetch = nowUids.filter((u) => !(prev && prev.doneUids.includes(u)));
      const dir = folderDir(opts.dest, rec.path);
      let fetched = prev ? prev.doneUids.length : 0;
      const doneUids = prev ? prev.doneUids.slice() : [];
      const sizeByUid = new Map(sizeRows.map((r) => [r.uid, r.size]));
      for (const r of sizeRows) {
        if (typeof r.size === 'number') {
          rfc822ByRel.set(`${rec.path}/${r.uid}.eml`, r.size);
        }
      }
      for (const uid of toFetch) {
        await withRetry(async (s) => {
          if (doneUids.includes(uid)) {
            return;
          }
          if (examinedRaw !== box.raw) {
            const ex = await s.examine(box.raw);
            if (!ex.ok || ex.uidvalidity !== expectedUv) {
              throw new Error(`UIDVALIDITY changed ${expectedUv}->${ex.uidvalidity}; refuse mix`);
            }
            examinedRaw = box.raw;
          }
          const raw = await s.fetchBodyPeek(uid, peekTimeout(sizeByUid.get(uid) ?? null));
          atomicWriteEml(dir, uid, raw);
          doneUids.push(uid);
          fetched += 1;
          state.folders[box.raw] = { uidvalidity: expectedUv, doneUids };
          saveState(opts.dest, state);
        });
      }
      rec.fetched = fetched;
      rec.status = rec.exists === 0 ? 'empty' : 'fetched';
      log(
        countLog('folder-done', {
          fetched,
          gaps: rec.gaps.length,
          arrived: rec.arrivedDuringSnapshot.length,
        })
      );
    }

    const hashed = hashEmlTree(opts.dest);
    writeHashList(opts.dest, hashed.listing);
    const mismatches = sizeMismatchesAgainstRfc822(hashed.files, rfc822ByRel);
    const examineFailed = folderRows.filter((f) => f.status === 'examine-failed');
    const countsMatch = stateFileCount(state) === hashed.files.length;
    const complete = examineFailed.length === 0 && mismatches.length === 0 && countsMatch;
    const manifest = manifestBase(complete, hashed.sha256All);
    manifest.files = hashed.files;
    manifest.sizeMismatches = mismatches;
    manifest.messageCount = hashed.files.length;
    manifest.folderCounts = Object.fromEntries(folderRows.map((f) => [f.path, f.fetched]));
    const manTmp = path.join(opts.dest, `${MANIFEST_FILE}.partial`);
    fs.writeFileSync(manTmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(manTmp, path.join(opts.dest, MANIFEST_FILE));
    state.complete = complete;
    saveState(opts.dest, state);

    if (opts.workCopy && complete) {
      const workGuard = destOverwriteGuard(opts.workCopy);
      if (!workGuard.ok) {
        try {
          await session?.logout();
        } catch {
          closeQuiet();
        }
        stampStatus({
          ok: false,
          complete: false,
          preflight: false,
          reason: `work copy: ${workGuard.reason}`,
          fileCount: hashed.files.length,
          messageCount: hashed.files.length,
          sha256All: hashed.sha256All,
        });
        return {
          ok: false,
          reason: `work copy: ${workGuard.reason}`,
          manifest,
          preflight: false,
        };
      }
      fs.mkdirSync(opts.workCopy, { recursive: true });
      materializeWorkingCopy({ originalRoot: opts.dest, workRoot: opts.workCopy, io: fs });
      const workHash = hashEmlTree(opts.workCopy);
      if (workHash.sha256All !== hashed.sha256All) {
        try {
          await session?.logout();
        } catch {
          closeQuiet();
        }
        stampStatus({
          ok: false,
          complete: false,
          preflight: false,
          reason: 'work copy hash does not match baseline',
          fileCount: hashed.files.length,
          messageCount: hashed.files.length,
          sha256All: hashed.sha256All,
        });
        return {
          ok: false,
          reason: 'work copy hash does not match baseline',
          manifest,
          preflight: false,
        };
      }
      log(countLog('work-copy', { copied: 1, files: workHash.files.length }));
    }

    try {
      await session?.logout();
    } catch {
      closeQuiet();
    }
    const reason = complete
      ? ''
      : mismatches.length
        ? `RFC822.SIZE mismatch files=${mismatches.length}`
        : examineFailed[0]
          ? examineFailed[0].note || 'examine-failed'
          : 'state/file count mismatch';
    stampStatus({
      ok: complete,
      complete,
      preflight: false,
      reason,
      fileCount: hashed.files.length,
      messageCount: hashed.files.length,
      sha256All: hashed.sha256All,
    });
    return {
      ok: complete,
      reason,
      manifest,
      preflight: false,
    };
  } catch (err) {
    try {
      await session?.logout();
    } catch {
      closeQuiet();
    }
    const reason = (err as Error).message || 'snapshot failed';
    if (destClaimed && opts.dest) {
      writeSnapshotStatus(opts.dest, {
        ok: false,
        complete: false,
        preflight: !!opts.preflightOnly,
        reason,
        fileCount: null,
        messageCount: null,
        sha256All: null,
        updatedAt: new Date().toISOString(),
      });
      appendProgressLog(opts.dest, `snapshot: status ok=0 complete=0 reason=failed`);
    }
    return {
      ok: false,
      reason,
      manifest: null,
      preflight: !!opts.preflightOnly,
    };
  }
}

async function preflightFolder(
  session: ReadOnlyImapSession,
  box: ListMailbox,
  log: SnapshotLog
): Promise<SnapshotFolderRecord> {
  const base: SnapshotFolderRecord = {
    path: box.unicode,
    raw: box.raw,
    selectable: box.selectable,
    exists: null,
    uidvalidity: null,
    uidnext: null,
    fetched: 0,
    unread: 0,
    gaps: [],
    arrivedDuringSnapshot: [],
    status: box.selectable ? 'listed' : 'unselectable',
    note: box.selectable ? '' : box.attrs.join(' '),
    examineReadOnly: false,
  };
  if (!box.selectable) {
    log(countLog('unselectable', { listed: 1 }));
    return base;
  }
  const examined = await session.examine(box.raw);
  if (!examined.ok) {
    base.status = 'examine-failed';
    base.note = 'EXAMINE failed';
    return base;
  }
  base.exists = examined.exists;
  base.uidvalidity = examined.uidvalidity;
  base.uidnext = examined.uidnext;
  base.examineReadOnly = examined.readOnly;
  if (!examined.readOnly) {
    base.note = 'EXAMINE did not advertise READ-ONLY';
  }
  if (examined.exists === 0) {
    base.status = 'empty';
  }
  return base;
}
