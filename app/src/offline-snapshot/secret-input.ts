/**
 * Password is never on argv, never copied from env, never written to logs.
 * Yahoo path: hidden TTY prompt only. Fake-server tests may pipe stdin.
 */
export const FORBIDDEN_SECRET_ENV = [
  'YAHOO_IMAP_PASSWORD',
  'IMAP_PASSWORD',
  'MAILSPRING_YAHOO_PASSWORD',
  'MAILSPRING_IMAP_PASSWORD',
];

export function envSecretNamesPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  return FORBIDDEN_SECRET_ENV.filter((name) => Object.prototype.hasOwnProperty.call(env, name));
}

export function assertNoEnvSecrets(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reason: string;
} {
  const names = envSecretNamesPresent(env);
  if (names.length) {
    return {
      ok: false,
      reason: 'refuses password from environment; unset the variable and use a hidden prompt',
    };
  }
  return { ok: true, reason: '' };
}

export function argvLooksLikePasswordFlag(argv: string[]): boolean {
  return argv.some(
    (a) =>
      a === '--password' ||
      a.startsWith('--password=') ||
      a === '--imap-password' ||
      a.startsWith('--imap-password=') ||
      a === '-p'
  );
}

export async function readSecretFromStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  }
  const text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
  const line = text.split('\n')[0] || '';
  return line.replace(/\r$/, '');
}

export function readHiddenTtyPassword(opts: {
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WritableStream;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!opts.stdin.isTTY) {
      reject(new Error('hidden password prompt requires a Terminal TTY; not argv/env'));
      return;
    }
    const stdin = opts.stdin;
    opts.stderr.write('IMAP password (hidden, not echoed, not logged): ');
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let acc = '';
    const restore = () => {
      stdin.setRawMode?.(!!wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (ch: string) => {
      if (ch === '\n' || ch === '\r') {
        restore();
        opts.stderr.write('\n');
        resolve(acc);
        acc = '';
        return;
      }
      if (ch === '\u0003') {
        restore();
        reject(new Error('cancelled'));
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        acc = acc.slice(0, -1);
        return;
      }
      acc += ch;
    };
    stdin.on('data', onData);
  });
}

export async function obtainSnapshotSecret(opts: {
  allowStdinPipe: boolean;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WritableStream;
}): Promise<{ ok: true; secret: string } | { ok: false; reason: string }> {
  try {
    if (opts.allowStdinPipe) {
      const secret = await readSecretFromStdin(opts.stdin);
      if (!secret) {
        return { ok: false, reason: 'empty password on stdin' };
      }
      return { ok: true, secret };
    }
    const secret = await readHiddenTtyPassword({ stdin: opts.stdin, stderr: opts.stderr });
    if (!secret) {
      return { ok: false, reason: 'empty password' };
    }
    return { ok: true, secret };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'password input failed' };
  }
}
