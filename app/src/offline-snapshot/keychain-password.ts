/**
 * Opt-in Yahoo IMAP password from a dedicated macOS login Keychain item.
 * Default service: "Mailspring-offline Yahoo IMAP". Account is --username.
 * Secret is captured from `security find-generic-password -w` stdout in-process
 * only — never argv/env/logs/disk. Denied/locked/missing is fail-closed.
 */
import { spawnSync } from 'child_process';

export const YAHOO_IMAP_KEYCHAIN_SERVICE = 'Mailspring-offline Yahoo IMAP';
export const SECURITY_BIN = '/usr/bin/security';

export type KeychainFailKind = 'missing' | 'denied' | 'locked' | 'error';

export type KeychainReadResult =
  | { ok: true; secret: string }
  | { ok: false; reason: string; kind: KeychainFailKind };

export type KeychainExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
};

export type KeychainExec = (file: string, args: string[]) => KeychainExecResult;

export function securityFindPasswordArgs(service: string, account: string): string[] {
  return ['find-generic-password', '-s', service, '-a', account, '-w'];
}

export function defaultSecurityExec(file: string, args: string[]): KeychainExecResult {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 30000,
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    argv: [file, ...args],
  };
}

export function classifySecurityFindResult(result: KeychainExecResult): KeychainReadResult {
  const stdout = String(result.stdout || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
  const stderr = String(result.stderr || '');
  const status = result.status;
  if (status === 0 && stdout) {
    return { ok: true, secret: stdout };
  }
  if (
    status === 44 ||
    /could not be found|item could not be found|errSecItemNotFound/i.test(stderr)
  ) {
    return {
      ok: false,
      kind: 'missing',
      reason:
        'Keychain item not found. Create a login generic password (service Mailspring-offline Yahoo IMAP, account = --username). No password fallback.',
    };
  }
  if (
    /User interaction is not allowed|interaction not allowed|errSecInteractionNotAllowed/i.test(
      stderr
    )
  ) {
    return {
      ok: false,
      kind: 'locked',
      reason:
        'Keychain is locked or interaction is not allowed. Unlock the login Keychain, then retry. No password fallback.',
    };
  }
  if (
    status === 128 ||
    status === -128 ||
    /User canceled|errSecUserCanceled|auth failed|not correct|denied|errSecAuthFailed/i.test(stderr)
  ) {
    return {
      ok: false,
      kind: 'denied',
      reason:
        'Keychain access denied or cancelled. Click Allow on the Keychain prompt, then retry. No password fallback.',
    };
  }
  if (status === 0 && !stdout) {
    return {
      ok: false,
      kind: 'missing',
      reason: 'Keychain item returned an empty password. No password fallback.',
    };
  }
  return {
    ok: false,
    kind: 'denied',
    reason: 'Keychain lookup failed (denied, locked, or error). No password fallback.',
  };
}

export function readYahooImapPasswordFromKeychain(opts: {
  account: string;
  service?: string;
  execFile?: KeychainExec;
  platform?: NodeJS.Platform;
}): KeychainReadResult {
  const account = String(opts.account || '').trim();
  if (!account) {
    return { ok: false, kind: 'error', reason: 'Keychain account (--username) is required' };
  }
  const service = String(opts.service || YAHOO_IMAP_KEYCHAIN_SERVICE).trim();
  if (!service) {
    return { ok: false, kind: 'error', reason: 'Keychain service is empty' };
  }
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin' && !opts.execFile) {
    return {
      ok: false,
      kind: 'error',
      reason: 'Keychain password is macOS only',
    };
  }
  const execFile = opts.execFile || defaultSecurityExec;
  const args = securityFindPasswordArgs(service, account);
  let result: KeychainExecResult;
  try {
    result = execFile(SECURITY_BIN, args);
  } catch {
    return {
      ok: false,
      kind: 'error',
      reason: 'Keychain lookup failed (denied, locked, or error). No password fallback.',
    };
  }
  const argvJoined = result.argv.join(' ');
  if (/test-password-not-yahoo/i.test(argvJoined)) {
    return {
      ok: false,
      kind: 'error',
      reason: 'Keychain lookup refused: secret must not appear on argv',
    };
  }
  return classifySecurityFindResult(result);
}
