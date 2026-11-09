/**
 * Standalone Yahoo IMAP snapshot CLI. Not loaded by the Mailspring-offline
 * experiment app. Password is never on argv/env/logs.
 *
 *   --preflight-only  LIST + EXAMINE + SIZE + disk (no BODY.PEEK, no dest write)
 *   --execute         download after preflight (TTY hidden password for Yahoo)
 *   --insecure-test-server --host 127.0.0.1 --port N  fake server tests only
 */
import { verifySnapshotArchive } from './archive-hash';
import { writeSnapshotStatus } from './progress';
import { DEFAULT_MAX_CONSECUTIVE_RETRIES } from './retry';
import { runReadOnlySnapshot } from './snapshot-run';
import {
  argvLooksLikePasswordFlag,
  assertNoEnvSecrets,
  obtainSnapshotSecret,
} from './secret-input';
import { resolveSnapshotTarget } from './yahoo-config';

export type SnapshotCliArgs = {
  dest: string | null;
  workCopy: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  preflightOnly: boolean;
  execute: boolean;
  insecureTestServer: boolean;
  secretFromStdin: boolean;
  allowUnknownSizes: boolean;
  verify: boolean;
  maxRetries: number | null;
  passwordFromKeychain: boolean;
  keychainService: string | null;
  help: boolean;
};

export function parseSnapshotArgv(argv: string[]): SnapshotCliArgs {
  const out: SnapshotCliArgs = {
    dest: null,
    workCopy: null,
    host: null,
    port: null,
    username: null,
    preflightOnly: false,
    execute: false,
    insecureTestServer: false,
    secretFromStdin: false,
    allowUnknownSizes: false,
    verify: false,
    maxRetries: null,
    passwordFromKeychain: false,
    keychainService: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--preflight-only') out.preflightOnly = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--insecure-test-server') out.insecureTestServer = true;
    else if (a === '--secret-from-stdin') out.secretFromStdin = true;
    else if (a === '--allow-unknown-sizes') out.allowUnknownSizes = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--password-from-keychain') out.passwordFromKeychain = true;
    else if (a === '--keychain-service') out.keychainService = next() || null;
    else if (a.startsWith('--keychain-service=')) {
      out.keychainService = a.slice('--keychain-service='.length) || null;
    } else if (a === '--max-retries') {
      const n = parseInt(next() || '', 10);
      out.maxRetries = Number.isFinite(n) ? n : null;
    } else if (a.startsWith('--max-retries=')) {
      const n = parseInt(a.slice('--max-retries='.length), 10);
      out.maxRetries = Number.isFinite(n) ? n : null;
    } else if (a === '--dest') out.dest = next() || null;
    else if (a.startsWith('--dest=')) out.dest = a.slice('--dest='.length) || null;
    else if (a === '--work-copy') out.workCopy = next() || null;
    else if (a.startsWith('--work-copy=')) out.workCopy = a.slice('--work-copy='.length) || null;
    else if (a === '--host') out.host = next() || null;
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length) || null;
    else if (a === '--port') out.port = parseInt(next() || '', 10);
    else if (a.startsWith('--port=')) out.port = parseInt(a.slice('--port='.length), 10);
    else if (a === '--username') out.username = next() || null;
    else if (a.startsWith('--username=')) out.username = a.slice('--username='.length) || null;
  }
  return out;
}

export function usage(): string {
  return [
    'offline-imap-snapshot: read-only Yahoo IMAP snapshot (EXAMINE / BODY.PEEK).',
    'REFUSES mutation. Password is never on argv/env/logs.',
    '',
    '  --preflight-only --username EMAIL',
    '  --execute --dest /abs/archive --username EMAIL [--work-copy /abs/work]',
    '  --password-from-keychain [--keychain-service NAME]  (non-TTY Mac; login Keychain)',
    '  --verify --dest /abs/archive [--work-copy /abs/work]  (offline, no password)',
    '  Fake tests: --insecure-test-server --host 127.0.0.1 --port N --secret-from-stdin',
    '',
    'Does not connect to Yahoo unless --execute or --preflight-only (TTY prompt or --password-from-keychain).',
    'Never overwrites a preexisting complete archive.',
    'Disk check is baseline + independent work copy, not a single tree.',
  ].join('\n');
}

export async function runSnapshotCli(
  argv: string[],
  io: {
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    env?: NodeJS.ProcessEnv;
    keychainExec?: import('./keychain-password').KeychainExec;
    keychainReader?: typeof import('./keychain-password').readYahooImapPasswordFromKeychain;
  }
): Promise<number> {
  const argsv = argv.slice();
  if (argsv.length === 0 || argsv.includes('--help') || argsv.includes('-h')) {
    io.stderr.write(usage() + '\n');
    return 2;
  }
  if (argvLooksLikePasswordFlag(argsv)) {
    io.stderr.write('offline-imap-snapshot: refuses --password on argv\n');
    return 1;
  }
  const envCheck = assertNoEnvSecrets(io.env || process.env);
  if (!envCheck.ok) {
    io.stderr.write(`offline-imap-snapshot: ${envCheck.reason}\n`);
    return 1;
  }
  const args = parseSnapshotArgv(argsv);
  if (args.verify && (args.execute || args.preflightOnly)) {
    io.stderr.write(
      'offline-imap-snapshot: --verify cannot be combined with --execute/--preflight-only\n'
    );
    return 1;
  }
  if (args.verify) {
    if (!args.dest) {
      io.stderr.write('offline-imap-snapshot: --verify requires --dest (absolute)\n');
      return 1;
    }
    if (!args.dest.startsWith('/')) {
      io.stderr.write('offline-imap-snapshot: --dest must be absolute\n');
      return 1;
    }
    if (args.workCopy && !args.workCopy.startsWith('/')) {
      io.stderr.write('offline-imap-snapshot: --work-copy must be absolute\n');
      return 1;
    }
    const verified = verifySnapshotArchive(args.dest, args.workCopy);
    io.stdout.write(
      JSON.stringify(
        {
          ok: verified.ok,
          complete: verified.complete,
          reason: verified.reason,
          fileCount: verified.fileCount,
          sha256All: verified.sha256All,
          issues: verified.issues.length,
          sizeMismatches: verified.sizeMismatches.length,
        },
        null,
        2
      ) + '\n'
    );
    if (!verified.ok) {
      io.stderr.write(`offline-imap-snapshot: ${verified.reason}\n`);
    }
    writeSnapshotStatus(args.dest, {
      ok: verified.ok,
      complete: verified.complete,
      preflight: false,
      reason: verified.reason || (verified.ok ? 'verify-ok' : 'verify-failed'),
      fileCount: verified.fileCount,
      messageCount: verified.fileCount,
      sha256All: verified.sha256All,
      updatedAt: new Date().toISOString(),
    });
    return verified.ok ? 0 : 1;
  }
  if (args.secretFromStdin && !args.insecureTestServer) {
    io.stderr.write('offline-imap-snapshot: --secret-from-stdin is fake-server tests only\n');
    return 1;
  }
  if (args.passwordFromKeychain && args.secretFromStdin) {
    io.stderr.write(
      'offline-imap-snapshot: --password-from-keychain cannot be combined with --secret-from-stdin\n'
    );
    return 1;
  }
  const target = resolveSnapshotTarget({
    host: args.host || undefined,
    port: args.port || undefined,
    insecureTestServer: args.insecureTestServer,
  });
  if (target.ok === false) {
    io.stderr.write(`offline-imap-snapshot: ${target.reason}\n`);
    return 1;
  }
  if (!args.username) {
    io.stderr.write('offline-imap-snapshot: --username is required (not a password)\n');
    return 1;
  }
  if (args.execute && !args.dest) {
    io.stderr.write('offline-imap-snapshot: --execute requires --dest (absolute)\n');
    return 1;
  }
  if (args.dest && !args.dest.startsWith('/')) {
    io.stderr.write('offline-imap-snapshot: --dest must be absolute\n');
    return 1;
  }
  if (args.workCopy && !args.workCopy.startsWith('/')) {
    io.stderr.write('offline-imap-snapshot: --work-copy must be absolute\n');
    return 1;
  }
  if (!args.execute && !args.preflightOnly) {
    io.stderr.write(usage() + '\n');
    return 2;
  }
  if (!args.insecureTestServer && args.secretFromStdin) {
    return 1;
  }
  if (
    !args.insecureTestServer &&
    !io.stdin.isTTY &&
    !args.secretFromStdin &&
    !args.passwordFromKeychain
  ) {
    io.stderr.write(
      'offline-imap-snapshot: Yahoo download needs a Terminal hidden password prompt or --password-from-keychain. Not initiated.\n'
    );
    return 1;
  }

  const secret = await obtainSnapshotSecret({
    allowStdinPipe: !!args.insecureTestServer && !!args.secretFromStdin,
    passwordFromKeychain: args.passwordFromKeychain,
    keychainAccount: args.username || '',
    keychainService: args.keychainService || undefined,
    keychainExec: io.keychainExec,
    keychainReader: io.keychainReader,
    stdin: io.stdin,
    stderr: io.stderr,
  });
  if (secret.ok === false) {
    io.stderr.write(`offline-imap-snapshot: ${secret.reason}\n`);
    return 1;
  }

  const logs: string[] = [];
  const result = await runReadOnlySnapshot({
    target: target.target,
    username: args.username,
    password: secret.secret,
    dest: args.dest || process.cwd(),
    workCopy: args.workCopy,
    preflightOnly: args.preflightOnly && !args.execute,
    execute: args.execute,
    allowUnknownSizes: args.allowUnknownSizes,
    retry: {
      maxConsecutive: args.maxRetries == null ? DEFAULT_MAX_CONSECUTIVE_RETRIES : args.maxRetries,
    },
    log: (line) => {
      logs.push(line);
      if (line.startsWith('snapshot:') || /LOGIN \(redacted\)/.test(line)) {
        io.stderr.write(line + '\n');
      }
    },
  });
  secret.secret = '';
  const leak = logs.some((l) => /test-password-not-yahoo|imap_password/i.test(l));
  if (leak) {
    io.stderr.write('offline-imap-snapshot: internal log leak detected\n');
    return 1;
  }
  if (result.manifest) {
    io.stdout.write(
      JSON.stringify(
        {
          ok: result.ok,
          reason: result.reason,
          preflight: result.preflight,
          messageCount: result.manifest.messageCount,
          sha256All: result.manifest.sha256All,
          folderCounts: result.manifest.folderCounts,
          missingCandidates: result.manifest.missingCandidates,
          unselectable: result.manifest.unselectable,
          empty: result.manifest.empty,
          examineFailed: result.manifest.examineFailed,
          disk: result.manifest.disk,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    io.stderr.write(`offline-imap-snapshot: ${result.reason}\n`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  runSnapshotCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`offline-imap-snapshot: ${err.message}\n`);
      process.exit(1);
    }
  );
}
