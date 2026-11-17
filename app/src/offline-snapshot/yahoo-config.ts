/**
 * Documented Yahoo IMAP endpoint. TLS is required for this host.
 * Tests use 127.0.0.1 with --insecure-test-server (plain TCP, never Yahoo).
 */
export const YAHOO_IMAP_HOST = 'imap.mail.yahoo.com';
export const YAHOO_IMAP_PORT = 993;

const TEST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export type SnapshotConnectTarget = {
  host: string;
  port: number;
  tls: boolean;
  servername?: string;
};

export function isLocalTestHost(host: string): boolean {
  return TEST_HOSTS.has(String(host || '').toLowerCase());
}

export function resolveSnapshotTarget(opts: {
  host?: string;
  port?: number;
  insecureTestServer?: boolean;
}): { ok: true; target: SnapshotConnectTarget } | { ok: false; reason: string } {
  const host = String(opts.host || YAHOO_IMAP_HOST)
    .trim()
    .toLowerCase();
  const port = typeof opts.port === 'number' && Number.isFinite(opts.port) ? opts.port : 0;
  if (opts.insecureTestServer) {
    if (!isLocalTestHost(host)) {
      return {
        ok: false,
        reason: '--insecure-test-server is localhost-only; refused for this host',
      };
    }
    return {
      ok: true,
      target: { host, port: port || 0, tls: false },
    };
  }
  if (host !== YAHOO_IMAP_HOST) {
    return {
      ok: false,
      reason: `host is not the documented Yahoo IMAP endpoint (${YAHOO_IMAP_HOST})`,
    };
  }
  if (port && port !== YAHOO_IMAP_PORT) {
    return { ok: false, reason: `Yahoo IMAP TLS port is ${YAHOO_IMAP_PORT}` };
  }
  return {
    ok: true,
    target: {
      host: YAHOO_IMAP_HOST,
      port: YAHOO_IMAP_PORT,
      tls: true,
      servername: YAHOO_IMAP_HOST,
    },
  };
}

export const TLS_CONNECT_OPTIONS = {
  minVersion: 'TLSv1.2' as const,
  rejectUnauthorized: true,
};
