/**
 * Transient IMAP/network failures are retried. Auth and protocol violations
 * are not. Password is never in these strings.
 */

export const DEFAULT_MAX_CONSECUTIVE_RETRIES = 8;
export const DEFAULT_RETRY_BASE_MS = 5000;
export const DEFAULT_RETRY_CAP_MS = 5 * 60 * 1000;

export type SnapshotErrorKind = 'transient' | 'auth' | 'fatal';

export type RetryPolicy = {
  maxConsecutive: number;
  baseMs: number;
  capMs: number;
  sleep: (ms: number) => Promise<void>;
};

export function defaultRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return {
    maxConsecutive: DEFAULT_MAX_CONSECUTIVE_RETRIES,
    baseMs: DEFAULT_RETRY_BASE_MS,
    capMs: DEFAULT_RETRY_CAP_MS,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

export function retryWaitMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitterMs?: number
): number {
  const n = Math.max(1, attempt);
  const exp = Math.min(capMs, baseMs * Math.pow(2, n - 1));
  const jitter =
    typeof jitterMs === 'number'
      ? jitterMs
      : Math.floor(Math.random() * Math.min(1000, Math.max(0, exp * 0.2)));
  return Math.max(0, Math.floor(exp + jitter));
}

export function retryReasonToken(err: unknown): string {
  const msg = errorMessage(err);
  const code = errorCode(err);
  if (/BODY\.PEEK timeout/i.test(msg)) {
    return 'body-peek-timeout';
  }
  if (/greeting timeout/i.test(msg)) {
    return 'greeting-timeout';
  }
  if (/IMAP timeout/i.test(msg)) {
    return 'imap-timeout';
  }
  if (/IMAP BYE/i.test(msg)) {
    return 'bye';
  }
  if (/socket closed|socket hang up/i.test(msg) || code === 'EPIPE') {
    return 'socket-closed';
  }
  if (code === 'ECONNRESET' || /ECONNRESET/i.test(msg)) {
    return 'socket-reset';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(msg)) {
    return 'dns';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ECONNABORTED' ||
    /network/i.test(msg)
  ) {
    return 'network';
  }
  if (/TLS|SSL|secure protocol/i.test(msg) && !isCertVerificationError(msg, code)) {
    return 'tls';
  }
  return 'transient';
}

export function classifySnapshotError(err: unknown): SnapshotErrorKind {
  const msg = errorMessage(err);
  const code = errorCode(err);
  if (
    (err && typeof err === 'object' && (err as { name?: string }).name === 'SnapshotAuthError') ||
    /AUTHENTICATIONFAILED/i.test(msg) ||
    /^LOGIN failed/i.test(msg) ||
    /LOGIN NO\b/i.test(msg) ||
    /not authenticated/i.test(msg)
  ) {
    return 'auth';
  }
  if (isCertVerificationError(msg, code)) {
    return 'fatal';
  }
  if (
    /not on the read-only allowlist/i.test(msg) ||
    /would mutate mailbox/i.test(msg) ||
    /FETCH BODY\[\] can set/i.test(msg) ||
    /SELECT is read-write/i.test(msg) ||
    /UIDVALIDITY/i.test(msg) ||
    /refuses to overwrite/i.test(msg) ||
    /command-allowlist/i.test(msg)
  ) {
    return 'fatal';
  }
  if (
    /BODY\.PEEK timeout/i.test(msg) ||
    /IMAP timeout/i.test(msg) ||
    /greeting timeout/i.test(msg) ||
    /IMAP socket/i.test(msg) ||
    /IMAP BYE/i.test(msg) ||
    /socket hang up/i.test(msg) ||
    /Client network socket disconnected/i.test(msg) ||
    /not connected/i.test(msg) ||
    /missing BODY literal/i.test(msg)
  ) {
    return 'transient';
  }
  if (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ECONNABORTED' ||
    code === 'EPROTO' ||
    code === 'ERR_SOCKET_CLOSED'
  ) {
    return 'transient';
  }
  if (/TLS|SSL/i.test(msg) && !isCertVerificationError(msg, code)) {
    return 'transient';
  }
  return 'fatal';
}

export function bodyPeekTimeoutMs(rfc822Size: number | null | undefined): number {
  const base = 20_000;
  const extra =
    typeof rfc822Size === 'number' && Number.isFinite(rfc822Size) && rfc822Size > 0
      ? Math.ceil(rfc822Size / 32768) * 1000
      : 0;
  return Math.min(5 * 60 * 1000, base + extra);
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message || '');
  }
  return String(err || '');
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code || '');
  }
  return '';
}

function isCertVerificationError(msg: string, code: string): boolean {
  return (
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT/i.test(
      msg
    ) ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  );
}
