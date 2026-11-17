/**
 * Process-scoped keep-awake for long --execute runs.
 * Windows: SetThreadExecutionState via a helper process (cleared on release).
 * macOS/Linux: no-op here so existing external `caffeinate` usage is unchanged.
 */
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type KeepAwakeHandle = {
  release: () => void;
};

export function windowsKeepAwakeScriptPath(scriptsDir?: string): string {
  const dir = scriptsDir || path.resolve(__dirname, '../../../scripts');
  return path.join(dir, 'windows-keep-awake.ps1');
}

export function startKeepAwake(opts?: {
  platform?: NodeJS.Platform;
  scriptsDir?: string;
  spawn?: typeof spawn;
}): KeepAwakeHandle {
  const platform = opts?.platform || process.platform;
  const noop = { release: () => undefined };
  if (platform !== 'win32') {
    return noop;
  }
  const script = windowsKeepAwakeScriptPath(opts?.scriptsDir);
  if (!fs.existsSync(script)) {
    return noop;
  }
  const spawnFn = opts?.spawn || spawn;
  let child: ChildProcess | null = null;
  try {
    child = spawnFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return noop;
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    if (!child) {
      return;
    }
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    } catch {
      // ignore
    }
    const pending = child;
    const timer = setTimeout(() => {
      try {
        pending.kill();
      } catch {
        // ignore
      }
    }, 2000);
    pending.once('exit', () => clearTimeout(timer));
  };
  child.on('error', () => undefined);
  return { release };
}
