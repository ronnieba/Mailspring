import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  inventoryFolders,
  ImapFolderInventory,
} from '../../internal_packages/ai-sidebar/lib/core/offline-imap-snapshot-plan';
import { isForbiddenArchiveRoot } from '../../internal_packages/ai-sidebar/lib/core/offline-archive-format';
import { materializeWorkingCopy } from '../../internal_packages/ai-sidebar/lib/core/offline-archive-format';
import { checkDiskForSnapshot } from './disk';
import { ListMailbox, uidGaps } from './imap-protocol';
import { ReadOnlyImapSession, SnapshotLog } from './read-only-session';
import { SnapshotConnectTarget } from './yahoo-config';

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
  const names = fs.readdirSync(dest).filter((n) => n !== '.' && n !== '..');
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
}): Promise<{
  ok: boolean;
  reason: string;
  manifest: SnapshotManifest | null;
  preflight: boolean;
}> {
  const log = opts.log || (() => undefined);
  const session = new ReadOnlyImapSession((line) => log(line));
  try {
    await session.connect(opts.target);
    await session.capability();
    await session.login(opts.username, opts.password);
    const listed = await session.listAll();
    log(countLog('list', { mailboxes: listed.length }));

    const folderRows: SnapshotFolderRecord[] = [];
    const sizes: Array<number | null> = [];
    const preflightUids = new Map<string, { uids: number[]; uidvalidity: number }>();

    for (const box of listed) {
      const rec = await preflightFolder(session, box, log);
      folderRows.push(rec);
      if (rec.status === 'fetched' || rec.status === 'listed' || rec.status === 'empty') {
        const rows = rec.status === 'empty' ? [] : await session.fetchSizes();
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
      disk: {
        rfc822Bytes: sizes.reduce((a, s) => a + (s || 0), 0),
        recommendedFreeBytes: disk.recommendedFreeBytes,
        freeBytes: disk.freeBytes,
        unknownSizes: disk.unknownSizes,
      },
    });

    if (opts.preflightOnly || !opts.execute) {
      await session.logout();
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
      await session.logout();
      return { ok: false, reason: disk.reason, manifest: manifestBase(false, ''), preflight: true };
    }

    const guard = destOverwriteGuard(opts.dest);
    if (!guard.ok) {
      await session.logout();
      return { ok: false, reason: guard.reason, manifest: null, preflight: true };
    }
    fs.mkdirSync(opts.dest, { recursive: true });
    const state = guard.resumable ? loadState(opts.dest) : { complete: false, folders: {} };

    const hashes: string[] = [];
    for (const box of listed) {
      if (!box.selectable) {
        continue;
      }
      const rec = folderRows.find((f) => f.raw === box.raw);
      if (!rec || rec.status === 'examine-failed' || rec.status === 'unselectable') {
        continue;
      }
      const examined = await session.examine(box.raw);
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
      const sizeRows = await session.fetchSizes();
      const nowUids = sizeRows.map((r) => r.uid);
      const extra = nowUids.filter((u) => planned && !planned.uids.includes(u));
      rec.arrivedDuringSnapshot = extra;
      const toFetch = nowUids.filter((u) => !(prev && prev.doneUids.includes(u)));
      const dir = folderDir(opts.dest, rec.path);
      let fetched = prev ? prev.doneUids.length : 0;
      const doneUids = prev ? prev.doneUids.slice() : [];
      for (const uid of toFetch) {
        const raw = await session.fetchBodyPeek(uid);
        const written = atomicWriteEml(dir, uid, raw);
        hashes.push(`${written.sha256} ${rec.path}/${uid}.eml`);
        fetched += 1;
        doneUids.push(uid);
        state.folders[box.raw] = { uidvalidity: examined.uidvalidity, doneUids };
        saveState(opts.dest, state);
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

    const sha256All = sha256Hex(Buffer.from(hashes.sort().join('\n')));
    const examineFailed = folderRows.filter((f) => f.status === 'examine-failed');
    const complete = examineFailed.length === 0;
    const manifest = manifestBase(complete, sha256All);
    manifest.messageCount = folderRows.reduce((a, f) => a + f.fetched, 0);
    manifest.folderCounts = Object.fromEntries(folderRows.map((f) => [f.path, f.fetched]));
    const manTmp = path.join(opts.dest, `${MANIFEST_FILE}.partial`);
    fs.writeFileSync(manTmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(manTmp, path.join(opts.dest, MANIFEST_FILE));
    state.complete = complete;
    saveState(opts.dest, state);

    if (opts.workCopy && complete) {
      const workGuard = destOverwriteGuard(opts.workCopy);
      if (!workGuard.ok) {
        await session.logout();
        return {
          ok: false,
          reason: `work copy: ${workGuard.reason}`,
          manifest,
          preflight: false,
        };
      }
      fs.mkdirSync(opts.workCopy, { recursive: true });
      materializeWorkingCopy({ originalRoot: opts.dest, workRoot: opts.workCopy, io: fs });
      log(countLog('work-copy', { copied: 1 }));
    }

    await session.logout();
    return {
      ok: complete,
      reason: complete ? '' : examineFailed[0].note || 'examine-failed',
      manifest,
      preflight: false,
    };
  } catch (err) {
    try {
      await session.logout();
    } catch {
      // ignore
    }
    return {
      ok: false,
      reason: (err as Error).message || 'snapshot failed',
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
