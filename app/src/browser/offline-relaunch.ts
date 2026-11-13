/**
 * Offline experiment: restart without a console window (Windows).
 *
 * The desktop shortcut starts the app hidden (wscript → hidden PowerShell →
 * Electron with its output sent to a log file). Electron's own app.relaunch()
 * starts a fresh process with no output file, and on Windows that process
 * opens a visible console window for the dev log. So in offline mode the
 * restart goes through a tiny hidden helper instead:
 *   1. the helper (Electron running as plain Node, no window, no console)
 *      waits until this process has fully exited, so there is never a second
 *      copy running at the same time;
 *   2. it starts the app again with the same arguments and environment,
 *      hidden, with output going to <profile>/logs/app.log like the shortcut.
 * macOS / Linux keep Electron's normal app.relaunch().
 */
import { spawn } from 'child_process';
import path from 'path';

export const OFFLINE_RELAUNCH_CHANNEL = 'offline-archive:relaunch-hidden';
/** Give up waiting for the old process after this long and start anyway. */
export const OFFLINE_RELAUNCH_MAX_WAIT_MS = 20000;

export type OfflineRelaunchPlan =
  | { mode: 'electron' }
  | {
      mode: 'hidden';
      execPath: string;
      args: string[];
      cwd: string;
      logFile: string;
      errFile: string;
      waitForPid: number;
    };

export function offlineRelaunchPlan(opts: {
  platform: string;
  execPath: string;
  argv: string[];
  cwd: string;
  configDir: string;
  pid: number;
}): OfflineRelaunchPlan {
  if (opts.platform !== 'win32') {
    return { mode: 'electron' };
  }
  const logDir = path.join(opts.configDir, 'logs');
  return {
    mode: 'hidden',
    execPath: opts.execPath,
    args: opts.argv.slice(1),
    cwd: opts.cwd,
    logFile: path.join(logDir, 'app.log'),
    errFile: path.join(logDir, 'app.log.err'),
    waitForPid: opts.pid,
  };
}

/**
 * Helper program run with ELECTRON_RUN_AS_NODE=1. Reads its job from argv[1]
 * (JSON), waits for the old process to exit, rotates the log like the
 * launcher (.ps1) does, then starts the app hidden and detached.
 */
export const OFFLINE_RELAUNCH_HELPER_SOURCE = `
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const job = JSON.parse(process.argv[process.argv.length - 1]);
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function openLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = file.replace(/app\\.log/, 'app.prev.log');
    try { if (fs.existsSync(file)) fs.renameSync(file, prev); } catch (e) {}
    return fs.openSync(file, 'w');
  } catch (e) {
    try { return fs.openSync(file.replace(/app\\.log/, 'app.relaunch.log'), 'w'); } catch (e2) { return 'ignore'; }
  }
}
const started = Date.now();
(function wait() {
  if (alive(job.waitForPid) && Date.now() - started < job.maxWaitMs) { setTimeout(wait, 150); return; }
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(job.execPath, job.args, {
    cwd: job.cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', openLog(job.logFile), openLog(job.errFile)],
  });
  child.unref();
  setTimeout(() => process.exit(0), 300);
})();
`;

/** Start the hidden helper. Returns false if it could not be started. */
export function startHiddenRelaunch(
  plan: Extract<OfflineRelaunchPlan, { mode: 'hidden' }>,
  spawnImpl: typeof spawn = spawn
): boolean {
  try {
    const job = JSON.stringify({
      execPath: plan.execPath,
      args: plan.args,
      cwd: plan.cwd,
      logFile: plan.logFile,
      errFile: plan.errFile,
      waitForPid: plan.waitForPid,
      maxWaitMs: OFFLINE_RELAUNCH_MAX_WAIT_MS,
    });
    const helper = spawnImpl(plan.execPath, ['-e', OFFLINE_RELAUNCH_HELPER_SOURCE, job], {
      cwd: plan.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    helper.unref();
    return true;
  } catch {
    return false;
  }
}
