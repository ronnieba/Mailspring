/**
 * Dest-local progress log and status JSON for detached/non-TTY runs.
 * Counts only — no passwords, subjects, or message bodies.
 */
import * as fs from 'fs';
import * as path from 'path';

export const PROGRESS_LOG = 'snapshot-progress.log';
export const STATUS_FILE = 'snapshot-status.json';

export type SnapshotStatus = {
  ok: boolean;
  complete: boolean;
  preflight: boolean;
  reason: string;
  fileCount: number | null;
  messageCount: number | null;
  sha256All: string | null;
  updatedAt: string;
};

export function appendProgressLog(dest: string, line: string) {
  if (!dest || !fs.existsSync(dest)) {
    return;
  }
  const stamp = new Date().toISOString();
  const text = line.endsWith('\n') ? line : `${line}\n`;
  fs.appendFileSync(path.join(dest, PROGRESS_LOG), `${stamp} ${text}`);
}

export function writeSnapshotStatus(dest: string, status: SnapshotStatus) {
  if (!dest || !fs.existsSync(dest)) {
    return;
  }
  const tmp = path.join(dest, `${STATUS_FILE}.partial`);
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dest, STATUS_FILE));
}
