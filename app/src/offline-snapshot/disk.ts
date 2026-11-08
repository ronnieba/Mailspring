import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { estimateBaselineAndWorkCopy } from '../../internal_packages/ai-sidebar/lib/core/offline-imap-snapshot-plan';

export { estimateBaselineAndWorkCopy };

export type DiskCheck = {
  ok: boolean;
  reason: string;
  freeBytes: number | null;
  recommendedFreeBytes: number;
  unknownSizes: number;
};

export function freeBytesForPath(p: string): number | null {
  const resolved = path.resolve(p);
  let probe = resolved;
  try {
    if (!fs.existsSync(probe)) {
      probe = path.dirname(probe);
    }
    const statfs = (
      fs as typeof fs & {
        statfsSync?: (p: string) => { bavail: number | bigint; bsize: number | bigint };
      }
    ).statfsSync;
    if (typeof statfs !== 'function') {
      return freeBytesFromDf(probe);
    }
    const s = statfs(probe);
    const bavail = typeof s.bavail === 'bigint' ? Number(s.bavail) : s.bavail;
    const bsize = typeof s.bsize === 'bigint' ? Number(s.bsize) : s.bsize;
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) {
      return null;
    }
    return bavail * bsize;
  } catch {
    return freeBytesFromDf(probe);
  }
}

function freeBytesFromDf(p: string): number | null {
  try {
    const out = execFileSync('df', ['-Pk', p], { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const data = (lines[lines.length - 1] || '').split(/\s+/);
    const availKb = parseInt(data[3], 10);
    if (!Number.isFinite(availKb) || availKb < 0) {
      return null;
    }
    return availKb * 1024;
  } catch {
    return null;
  }
}

export function checkDiskForSnapshot(opts: {
  dest: string;
  sizes: Array<number | null | undefined>;
  allowUnknownSizes?: boolean;
  freeBytes?: number | null;
}): DiskCheck {
  const est = estimateBaselineAndWorkCopy(opts.sizes);
  if (est.unknownSizes > 0 && !opts.allowUnknownSizes) {
    return {
      ok: false,
      reason: `RFC822.SIZE missing for ${est.unknownSizes} message(s); refuse execute (counts disclosed, not skipped)`,
      freeBytes: opts.freeBytes ?? null,
      recommendedFreeBytes: est.recommendedFreeBytes,
      unknownSizes: est.unknownSizes,
    };
  }
  const free = opts.freeBytes === undefined ? freeBytesForPath(opts.dest) : opts.freeBytes;
  if (free === null) {
    return {
      ok: false,
      reason: 'could not read free disk space; refuse execute until a number is available',
      freeBytes: null,
      recommendedFreeBytes: est.recommendedFreeBytes,
      unknownSizes: est.unknownSizes,
    };
  }
  if (free < est.recommendedFreeBytes) {
    return {
      ok: false,
      reason: `free disk ${free} < recommended ${est.recommendedFreeBytes} (baseline + work copy + 64MiB)`,
      freeBytes: free,
      recommendedFreeBytes: est.recommendedFreeBytes,
      unknownSizes: est.unknownSizes,
    };
  }
  return {
    ok: true,
    reason: '',
    freeBytes: free,
    recommendedFreeBytes: est.recommendedFreeBytes,
    unknownSizes: est.unknownSizes,
  };
}
