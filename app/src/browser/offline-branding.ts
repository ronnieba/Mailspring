/**
 * Offline experiment branding ("Mail AI"): the app icon used for the window,
 * taskbar and tray on Windows. Only when the app runs as the offline
 * experiment; the regular Mailspring build (and macOS/Linux) is unchanged.
 */
import fs from 'fs';
import path from 'path';
import { isOfflineArchiveMode } from '../offline-archive';

export const OFFLINE_APP_NAME = 'Mail AI';

export function offlineBrandDir(resourcePath: string): string {
  return path.join(resourcePath, 'static', 'images', 'offline');
}

/** Multi-size .ico for the offline experiment on Windows, else null. */
export function offlineAppIconPath(
  resourcePath: string | null | undefined,
  opts: { platform?: string; offline?: boolean } = {}
): string | null {
  const platform = opts.platform || process.platform;
  const offline = typeof opts.offline === 'boolean' ? opts.offline : isOfflineArchiveMode();
  if (platform !== 'win32' || !offline || !resourcePath) {
    return null;
  }
  const p = path.join(offlineBrandDir(resourcePath), 'mail-ai.ico');
  return fs.existsSync(p) ? p : null;
}
