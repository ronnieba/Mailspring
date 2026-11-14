/**
 * Offline experiment network guard (main process).
 *
 * With --offline-archive every renderer/session request to a remote host is
 * cancelled: Yahoo, Mailspring identity/update servers, remote images in
 * mail, fonts, trackers. Local schemes (file:, data:, blob:, devtools) are
 * allowed. The only remote host left reachable is the Gemini Developer API,
 * which the app contacts solely after an explicit Summarize of one selected
 * message when a key has been configured by the user. Its live voice
 * (WebSocket) endpoint is reachable only while a voice session the user
 * started is running (gemini-live-gate); the socket itself lives in the main
 * process.
 *
 * Mailsync is not started in this mode, so there is no IMAP/SMTP process.
 */
import { session } from 'electron';
import { isLiveGateOpen } from './gemini-live-gate';

const ALLOWED_SCHEMES = new Set([
  'file:',
  'data:',
  'blob:',
  'devtools:',
  'chrome:',
  'chrome-extension:',
  'mailspring:',
  'about:',
]);

const ALLOWED_REMOTE_HOSTS = new Set(['generativelanguage.googleapis.com']);

export type OfflineGuardStats = {
  blocked: number;
  allowedRemote: number;
  blockedHosts: { [host: string]: number };
};

const stats: OfflineGuardStats = { blocked: 0, allowedRemote: 0, blockedHosts: {} };
let installed = false;

export function offlineRequestDecision(rawUrl: string): 'allow' | 'allow-remote' | 'block' {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'block';
  }
  if (ALLOWED_SCHEMES.has(u.protocol)) {
    return 'allow';
  }
  if (
    (u.protocol === 'http:' ||
      u.protocol === 'https:' ||
      u.protocol === 'ws:' ||
      u.protocol === 'wss:') &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
  ) {
    // Local dev tooling only (e.g. DevTools); never a mail server.
    return 'allow';
  }
  if (u.protocol === 'https:' && ALLOWED_REMOTE_HOSTS.has(u.hostname)) {
    return 'allow-remote';
  }
  if (u.protocol === 'wss:' && ALLOWED_REMOTE_HOSTS.has(u.hostname) && isLiveGateOpen()) {
    return 'allow-remote';
  }
  return 'block';
}

export function installOfflineNetworkGuard(): void {
  if (installed) {
    return;
  }
  installed = true;
  const s = session.defaultSession;
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const decision = offlineRequestDecision(details.url);
    if (decision === 'block') {
      stats.blocked++;
      let host = '(invalid)';
      try {
        host = new URL(details.url).hostname || new URL(details.url).protocol;
      } catch {
        // keep placeholder
      }
      stats.blockedHosts[host] = (stats.blockedHosts[host] || 0) + 1;
      if (stats.blockedHosts[host] === 1) {
        console.log(`[Offline guard] blocked network request to ${host} (offline experiment)`);
      }
      callback({ cancel: true });
      return;
    }
    if (decision === 'allow-remote') {
      stats.allowedRemote++;
    }
    callback({});
  });
  console.log('[Offline guard] installed: remote network requests from windows are blocked');
}

export function offlineNetworkGuardStats(): OfflineGuardStats {
  return { ...stats, blockedHosts: { ...stats.blockedHosts } };
}
