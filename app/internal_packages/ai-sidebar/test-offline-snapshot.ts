#!/usr/bin/env npx ts-node
/**
 * Fake-IMAP snapshotter tests. No Yahoo, no real mail, no paid calls.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-snapshot.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { PassThrough } from 'stream';
import { estimateBaselineAndWorkCopy } from './lib/core/offline-imap-snapshot-plan';
import { displayFromRfc822, decodeRfc2047 } from './lib/core/offline-mime-display';
import { readOfflineArchive } from './lib/core/offline-archive-format';
import { fixtureRfc822, startFakeImapServer, FakeFolder } from '../../src/offline-snapshot/fake-imap-server';
import {
  runReadOnlySnapshot,
  destOverwriteGuard,
  bodyPeekTimeoutMs,
  classifySnapshotError,
} from '../../src/offline-snapshot/snapshot-run';
import { verifySnapshotArchive } from '../../src/offline-snapshot/archive-hash';
import {
  YAHOO_IMAP_KEYCHAIN_SERVICE,
  SECURITY_BIN,
  classifySecurityFindResult,
  classifyWindowsCredResult,
  readYahooImapPasswordFromKeychain,
  securityFindPasswordArgs,
  windowsCredentialTarget,
  windowsCredReadArgs,
} from '../../src/offline-snapshot/keychain-password';
import {
  encodeArchiveRelPath,
  encodeArchiveSegment,
  maybeWindowsLongPath,
} from '../../src/offline-snapshot/archive-path';
import { freeBytesForPath } from '../../src/offline-snapshot/disk';
import { startKeepAwake } from '../../src/offline-snapshot/keep-awake';
import { PROGRESS_LOG, STATUS_FILE } from '../../src/offline-snapshot/progress';
import { SnapshotAuthError } from '../../src/offline-snapshot/read-only-session';
import { ReadOnlyImapSession } from '../../src/offline-snapshot/read-only-session';
import { parseSnapshotArgv, runSnapshotCli, usage, isAbsoluteSnapshotPath } from '../../src/offline-snapshot/cli';
import {
  argvLooksLikePasswordFlag,
  assertNoEnvSecrets,
} from '../../src/offline-snapshot/secret-input';
import { resolveSnapshotTarget, YAHOO_IMAP_HOST } from '../../src/offline-snapshot/yahoo-config';

const ROOT = path.resolve(__dirname, '../../..');
const APP_SRC = path.resolve(__dirname, '../../src');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
    failed++;
  }
}

function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg || 'Expected true');
}
function assertFalse(v: boolean, msg?: string) {
  if (v) throw new Error(msg || 'Expected false');
}
function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertContains(h: string, n: string) {
  if (!h.includes(n)) throw new Error(`Expected to contain ${JSON.stringify(n)}`);
}

const USER = 'archive-user@example.test';
const PASS = 'test-password-not-yahoo';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function posixSh(): string | null {
  const candidates = [
    path.join('C:\\Program Files', 'Git', 'bin', 'sh.exe'),
    path.join('C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe'),
    '/bin/sh',
    '/usr/bin/sh',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return 'sh';
}


function fastRetry(max = 8) {
  return {
    maxConsecutive: max,
    baseMs: 5,
    capMs: 15,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  };
}

const TARGET = (port: number) => ({ host: '127.0.0.1' as const, port, tls: false });
const AMPLE_DISK = 10 * 1024 * 1024 * 1024;

function logsHaveContent(logs: string[]): boolean {
  const joined = logs.join('\n');
  return /Inbox one|unread-body|archive-sender@|שלום|test-password-not-yahoo/.test(joined);
}

async function run() {
  console.log('\n=== Offline IMAP snapshotter (fake server only) ===\n');

  console.log('Category: CLI / secret / host policy');
  await test('no-args wrapper still refuses to connect (exit 2)', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/offline-imap-snapshot.sh'), 'utf8');
    assertContains(script, 'REFUSES');
    assertContains(script, 'BODY.PEEK');
    assertFalse(script.includes('openssl s_client'));
    assertFalse(/\bnc\b/.test(script));
    const sh = posixSh();
    const spawn = spawnSync(sh || 'sh', [path.join(ROOT, 'scripts/offline-imap-snapshot.sh')]);
    assertEqual(spawn.status, 2);
  });

  await test('refuses password argv/env; stdin secret is test-server only', () => {
    assertTrue(argvLooksLikePasswordFlag(['--execute', '--password=secret']));
    assertFalse(argvLooksLikePasswordFlag(['--execute', '--password-from-keychain']));
    assertFalse(assertNoEnvSecrets({ YAHOO_IMAP_PASSWORD: 'x' } as NodeJS.ProcessEnv).ok);
    assertTrue(assertNoEnvSecrets({ PATH: '/bin' } as NodeJS.ProcessEnv).ok);
    const args = parseSnapshotArgv(['--execute', '--dest=/tmp/a', '--username', USER]);
    assertTrue(args.execute);
    assertContains(usage(), 'REFUSES mutation');
    const yahoo = resolveSnapshotTarget({ insecureTestServer: true, host: YAHOO_IMAP_HOST });
    assertFalse(yahoo.ok);
    const local = resolveSnapshotTarget({
      insecureTestServer: true,
      host: '127.0.0.1',
      port: 1,
    });
    assertTrue(local.ok);
    if (local.ok) assertFalse(local.target.tls);
  });

  await test('Yahoo execute without TTY is fail-closed (no socket)', async () => {
    const code = await runSnapshotCli(
      ['--execute', '--dest=/tmp/offline-snapshot-no-tty', '--username', USER],
      {
        stdin: { isTTY: false, read: () => null } as unknown as NodeJS.ReadStream,
        stdout: { write: () => true } as unknown as NodeJS.WritableStream,
        stderr: { write: () => true } as unknown as NodeJS.WritableStream,
        env: { PATH: '/bin' },
      }
    );
    assertEqual(code, 1);
  });

  console.log('\nCategory: fake-server snapshot');
  await test('preflight lists real folders, gaps, unread, missing Archive; no BODY.PEEK dest', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-pre-');
    const logs: string[] = [];
    try {
      const out = await runReadOnlySnapshot({
        target: { host: '127.0.0.1', port: fake.port, tls: false },
        username: USER,
        password: PASS,
        dest,
        preflightOnly: true,
        execute: false,
        freeBytes: 10 * 1024 * 1024 * 1024,
        log: (l) => logs.push(l),
      });
      assertTrue(out.preflight);
      assertTrue(!!out.manifest);
      if (!out.manifest) {
        throw new Error('expected preflight manifest');
      }
      const m = out.manifest;
      assertTrue(m.missingCandidates.includes('Archive'));
      assertTrue(m.unselectable.includes('Noselect') || m.unselectable.length >= 1);
      const inbox = m.folders.find((f) => f.path === 'INBOX' || f.raw === 'INBOX');
      assertTrue(!!inbox);
      if (inbox) {
        assertEqual(inbox.gaps.join(','), '3,4');
        assertTrue(inbox.unread >= 1);
        assertTrue(inbox.examineReadOnly);
      }
      assertTrue(m.folders.some((f) => f.path === 'Trash'));
      assertTrue(m.folders.some((f) => f.path === 'Spam'));
      assertTrue(m.folders.some((f) => f.path === 'Draft'));
      assertTrue(m.folders.some((f) => f.path === 'Bulk Mail'));
      assertTrue(m.folders.some((f) => f.path === 'תיקייה'));
      assertTrue(
        m.empty.some((n) => n === 'Starred') ||
          m.folders.some((f) => f.path === 'Starred' && f.exists === 0)
      );
      assertFalse(fs.existsSync(path.join(dest, 'INBOX', '1.eml')));
      assertFalse(logsHaveContent(logs));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('execute writes raw .eml atomically, hashes, no STORE, flags unread unchanged', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-ex-');
    const work = tmpDir('snap-work-');
    fs.rmSync(work, { recursive: true, force: true });
    const logs: string[] = [];
    try {
      const out = await runReadOnlySnapshot({
        target: { host: '127.0.0.1', port: fake.port, tls: false },
        username: USER,
        password: PASS,
        dest,
        workCopy: work,
        execute: true,
        freeBytes: 10 * 1024 * 1024 * 1024,
        log: (l) => logs.push(l),
      });
      assertTrue(out.ok, out.reason);
      assertTrue(!!out.manifest && out.manifest.complete);
      assertEqual(
        out.manifest && out.manifest.files.length,
        out.manifest && out.manifest.messageCount
      );
      assertEqual((out.manifest && out.manifest.sha256All.length) || 0, 64);
      assertTrue(fs.existsSync(path.join(dest, 'INBOX', '1.eml')));
      assertTrue(fs.existsSync(path.join(dest, 'INBOX', '5.eml')));
      assertFalse(fs.existsSync(path.join(dest, 'INBOX', '3.eml')));
      assertTrue(fs.existsSync(path.join(dest, 'Trash', '1.eml')));
      assertTrue(fs.existsSync(path.join(dest, 'Spam', '1.eml')));
      assertTrue(fs.existsSync(path.join(dest, 'Draft', '1.eml')));
      assertTrue(fs.existsSync(path.join(dest, 'Bulk Mail', '1.eml')));
      assertTrue(fs.existsSync(path.join(dest, 'תיקייה', '1.eml')));
      assertEqual(fake.storeCommands.length, 0);
      const unread = fake.messagesOf('INBOX').find((m) => m.uid === 2);
      assertTrue(!!unread);
      if (unread) {
        assertFalse(unread.flags.some((f) => /^\\Seen$/i.test(f)));
      }
      const raw = fs.readFileSync(path.join(dest, 'INBOX', '5.eml'));
      assertTrue(raw.includes(Buffer.from('Content-Disposition: attachment')));
      const imported = readOfflineArchive(dest);
      const htmlMsg = imported.messages.find((m) => m.sourceRelPath.includes('INBOX/5.eml'));
      assertTrue(!!htmlMsg);
      if (htmlMsg) {
        assertFalse(htmlMsg.bodyText.includes('<script'));
        assertFalse(htmlMsg.bodyText.includes('https://evil.example.test'));
        assertTrue(htmlMsg.attachmentCount >= 1);
      }
      const heb = imported.messages.find((m) => m.folderPath === 'תיקייה');
      assertTrue(!!heb);
      if (heb) {
        assertTrue(heb.subject.includes('שלום') || heb.bodyText.includes('שלום'));
      }
      assertTrue(fs.existsSync(path.join(work, 'INBOX', '1.eml')));
      fs.writeFileSync(path.join(work, 'INBOX', '1.eml'), Buffer.from('local-delete-test'));
      const orig = fs.readFileSync(path.join(dest, 'INBOX', '1.eml'));
      assertFalse(orig.equals(Buffer.from('local-delete-test')));
      assertFalse(logsHaveContent(logs));
      const session = new ReadOnlyImapSession();
      assertFalse(session.assertForbidden('A9 STORE 1 +FLAGS (\\Seen)').ok);
      assertFalse(session.assertForbidden('A9 SELECT INBOX').ok);
      assertFalse(session.assertForbidden('A9 UID FETCH 1 BODY[]').ok);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('refuses overwrite of complete archive; UIDVALIDITY mismatch disclosed', async () => {
    const destSidecar = tmpDir('snap-side-');
    fs.writeFileSync(path.join(destSidecar, PROGRESS_LOG), 'snapshot: counts only\n');
    fs.writeFileSync(path.join(destSidecar, STATUS_FILE), '{}\n');
    fs.writeFileSync(path.join(destSidecar, 'snapshot-console.log'), 'nohup\n');
    const gSide = destOverwriteGuard(destSidecar);
    assertTrue(gSide.ok);
    assertFalse(gSide.resumable);
    fs.rmSync(destSidecar, { recursive: true, force: true });
    const dest = tmpDir('snap-ov-');
    fs.writeFileSync(
      path.join(dest, 'snapshot-manifest.json'),
      JSON.stringify({ version: 1, kind: 'imap-readonly-snapshot', complete: true })
    );
    const g = destOverwriteGuard(dest);
    assertFalse(g.ok);
    assertContains(g.reason, 'overwrite');
    fs.rmSync(dest, { recursive: true, force: true });
    const dest2 = tmpDir('snap-uv-');
    fs.writeFileSync(
      path.join(dest2, 'snapshot-state.json'),
      JSON.stringify({ complete: false, folders: { INBOX: { uidvalidity: 999, doneUids: [1] } } })
    );
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    try {
      const out = await runReadOnlySnapshot({
        target: { host: '127.0.0.1', port: fake.port, tls: false },
        username: USER,
        password: PASS,
        dest: dest2,
        execute: true,
        freeBytes: 10 * 1024 * 1024 * 1024,
      });
      const inbox = out.manifest && out.manifest.folders.find((f) => f.raw === 'INBOX');
      assertTrue(!!inbox);
      if (inbox) {
        assertContains(inbox.note, 'UIDVALIDITY');
      }
    } finally {
      fs.rmSync(dest2, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('new UID after preflight is disclosed as arrivedDuringSnapshot', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-arr-');
    try {
      const logs: string[] = [];
      const sessionTarget = { host: '127.0.0.1' as const, port: fake.port, tls: false };
      const out = await runReadOnlySnapshot({
        target: sessionTarget,
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: 10 * 1024 * 1024 * 1024,
        log: (l) => logs.push(l),
        onAfterPreflight: () => {
          fake.inject('INBOX', {
            uid: 9,
            flags: [],
            raw: fixtureRfc822({ subject: 'Arrived later', body: 'new' }),
          });
        },
      });
      assertTrue(out.ok, out.reason);
      if (!out.manifest) {
        throw new Error('expected snapshot manifest');
      }
      const inbox = out.manifest.folders.find((f) => f.raw === 'INBOX');
      assertTrue(!!inbox);
      if (inbox) {
        assertTrue(inbox.arrivedDuringSnapshot.includes(9));
      }
      assertTrue(fs.existsSync(path.join(dest, 'INBOX', '9.eml')));
      assertFalse(logsHaveContent(logs));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('insufficient disk for baseline+work copy blocks execute', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-disk-');
    try {
      const out = await runReadOnlySnapshot({
        target: { host: '127.0.0.1', port: fake.port, tls: false },
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: 1,
      });
      assertFalse(out.ok);
      assertContains(out.reason, 'free disk');
      assertFalse(fs.existsSync(path.join(dest, 'INBOX', '1.eml')));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  console.log('\nCategory: MIME display (partial, not complete)');
  await test('RFC2047 Hebrew + QP/base64 + remote HTML stripped; nested rfc822 noted', () => {
    const sub = `=?UTF-8?B?${Buffer.from('שלום', 'utf8').toString('base64')}?=`;
    assertEqual(decodeRfc2047(sub), 'שלום');
    const raw = [
      `Subject: ${sub}`,
      'From: Archive Sender <archive-sender@example.test>',
      'Date: Fri, 01 Nov 2024 10:00:00 +0000',
      'Content-Type: multipart/mixed; boundary=b1',
      '',
      '--b1',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=D7=A9=D7=9C=D7=95=D7=9D',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<script>x</script><img src="https://evil.example.test/x.png">',
      '--b1',
      'Content-Type: application/octet-stream; name="a.bin"',
      'Content-Disposition: attachment; filename="a.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'Zg==',
      '--b1--',
      '',
    ].join('\n');
    const d = displayFromRfc822(raw);
    assertEqual(d.subject, 'שלום');
    assertTrue(d.bodyText.includes('שלום'));
    assertFalse(d.bodyText.includes('<script'));
    assertFalse(d.bodyText.includes('https://evil.example.test'));
    assertEqual(d.attachmentCount, 1);
    assertTrue(d.notes.includes('display-parse-partial'));
    const nested = displayFromRfc822(
      'Content-Type: multipart/mixed; boundary=z\n\n--z\nContent-Type: message/rfc822\n\nFrom: x\n\n--z--\n'
    );
    assertTrue(nested.notes.includes('nested-message-rfc822-not-expanded'));
  });

  await test('baseline+work-copy disk estimate is ~2x plus 64MiB', () => {
    const est = estimateBaselineAndWorkCopy([1000, 3000]);
    assertEqual(est.rfc822Bytes, 4000);
    assertEqual(est.recommendedFreeBytes, Math.ceil(4000 * 1.15) * 2 + 64 * 1024 * 1024);
  });

  console.log('\nCategory: isolation from experiment app');
  await test('Mailspring-offline modules do not import the snapshotter', () => {
    const files = [
      path.join(APP_SRC, 'offline-archive.ts'),
      path.join(APP_SRC, 'browser/application.ts'),
      path.join(__dirname, 'lib/offline-archive-catalog.ts'),
      path.join(__dirname, 'lib/mailspring-adapter.ts'),
      path.join(__dirname, 'lib/ai-sidebar-store.ts'),
      path.join(__dirname, 'lib/main.ts'),
    ];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      assertFalse(src.includes('offline-snapshot'), f);
      assertFalse(src.includes('ReadOnlyImapSession'));
      assertFalse(src.includes('YAHOO_IMAP_PASSWORD'));
    }
    const snap = fs.readFileSync(path.join(APP_SRC, 'offline-snapshot/snapshot-run.ts'), 'utf8');
    assertFalse(snap.includes('gemini-demo'));
    assertFalse(snap.includes('queueTask'));
  });

  await test('CLI fake-server execute via secret-from-stdin (counts only)', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-cli-');
    const stdin = new PassThrough();
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    try {
      const pending = runSnapshotCli(
        [
          '--execute',
          '--insecure-test-server',
          '--host',
          '127.0.0.1',
          '--port',
          String(fake.port),
          '--username',
          USER,
          '--dest',
          dest,
          '--secret-from-stdin',
        ],
        {
          stdin: Object.assign(stdin, { isTTY: false }) as unknown as NodeJS.ReadStream,
          stdout: {
            write: (s: string) => (stdoutChunks.push(String(s)), true),
          } as NodeJS.WritableStream,
          stderr: {
            write: (s: string) => (stderrChunks.push(String(s)), true),
          } as NodeJS.WritableStream,
          env: { PATH: '/bin' },
        }
      );
      stdin.end(PASS + '\n');
      const code = await pending;
      assertEqual(code, 0);
      const out = stdoutChunks.join('');
      assertFalse(out.includes(PASS));
      assertFalse(stderrChunks.join('').includes(PASS));
      assertTrue(fs.existsSync(path.join(dest, 'snapshot-manifest.json')));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  console.log('\nCategory: retry / reconnect / hash / verify');
  await test('classifies auth vs transient; BODY.PEEK timeout scales with SIZE', () => {
    assertEqual(classifySnapshotError(new SnapshotAuthError('LOGIN failed')), 'auth');
    assertEqual(classifySnapshotError(new Error('IMAP BODY.PEEK timeout')), 'transient');
    assertEqual(classifySnapshotError(new Error('IMAP socket closed')), 'transient');
    assertEqual(
      classifySnapshotError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
      'transient'
    );
    assertEqual(classifySnapshotError(new Error('UIDVALIDITY changed 1->2; refuse mix')), 'fatal');
    assertEqual(
      classifySnapshotError(new Error('IMAP command is not on the read-only allowlist')),
      'fatal'
    );
    assertTrue(bodyPeekTimeoutMs(null) >= 20000);
    assertTrue(bodyPeekTimeoutMs(10 * 1024 * 1024) <= 5 * 60 * 1000);
    assertTrue(bodyPeekTimeoutMs(10 * 1024 * 1024) > bodyPeekTimeoutMs(1000));
  });

  await test('disconnect mid-fetch reconnects, no duplicate .eml, unread unchanged', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-re-');
    const logs: string[] = [];
    try {
      fake.destroyNextBodyPeeks = 1;
      const out = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
        retry: fastRetry(),
        log: (l) => logs.push(l),
      });
      assertTrue(out.ok, out.reason);
      assertTrue(logs.some((l) => /snapshot: retry 1\/8 reason=/.test(l)));
      assertFalse(logsHaveContent(logs));
      const inbox = fs.readdirSync(path.join(dest, 'INBOX')).filter((n) => n.endsWith('.eml'));
      assertEqual(inbox.sort().join(','), '1.eml,2.eml,5.eml');
      assertEqual(fake.storeCommands.length, 0);
      const unread = fake.messagesOf('INBOX').find((m) => m.uid === 2);
      assertTrue(!!unread && !unread.flags.some((f) => /^\\Seen$/i.test(f)));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('BODY.PEEK hang times out and retries the in-flight UID', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-hang-');
    const logs: string[] = [];
    try {
      fake.hangNextBodyPeeks = 1;
      const out = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
        retry: fastRetry(),
        peekTimeoutMs: () => 80,
        log: (l) => logs.push(l),
      });
      assertTrue(out.ok, out.reason);
      assertTrue(logs.some((l) => /reason=body-peek-timeout/.test(l)));
      assertTrue(fs.existsSync(path.join(dest, 'INBOX', '1.eml')));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('UIDVALIDITY change on reconnect fails closed without mixing', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-uv2-');
    try {
      fake.destroyEveryBodyPeekAfter = 1;
      fake.onBodyPeekDestroy = () => fake.setUidvalidity('INBOX', 777);
      const out = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
        retry: fastRetry(3),
      });
      assertFalse(out.ok);
      assertContains(out.reason, 'UIDVALIDITY');
      assertTrue(fs.existsSync(path.join(dest, 'INBOX', '1.eml')));
      assertFalse(fs.existsSync(path.join(dest, 'INBOX', '2.eml')));
      const st = JSON.parse(fs.readFileSync(path.join(dest, 'snapshot-state.json'), 'utf8'));
      assertFalse(st.complete);
      assertTrue(st.folders.INBOX.doneUids.includes(1));
      assertFalse(st.folders.INBOX.doneUids.includes(2));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('LOGIN AUTHENTICATIONFAILED is not retried', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-auth-');
    const logs: string[] = [];
    try {
      const out = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: 'wrong-password',
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
        retry: fastRetry(),
        log: (l) => logs.push(l),
      });
      assertFalse(out.ok);
      assertContains(out.reason, 'LOGIN failed');
      assertFalse(logs.some((l) => /snapshot: retry /.test(l)));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('retry cap exits nonzero with resumable 55bab0ba-shaped state', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-cap-');
    const logs: string[] = [];
    try {
      fake.destroyEveryBodyPeekAfter = 2;
      const out = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
        retry: fastRetry(2),
        log: (l) => logs.push(l),
      });
      assertFalse(out.ok);
      assertContains(out.reason, 'retry cap');
      assertTrue(logs.some((l) => /snapshot: retry 2\/2 reason=/.test(l)));
      assertFalse(fs.existsSync(path.join(dest, 'snapshot-manifest.json')));
      const st = JSON.parse(fs.readFileSync(path.join(dest, 'snapshot-state.json'), 'utf8'));
      assertFalse(st.complete);
      assertTrue(Object.keys(st.folders).length >= 1);
      assertTrue(typeof st.folders[Object.keys(st.folders)[0]].uidvalidity === 'number');
      assertTrue(Array.isArray(st.folders[Object.keys(st.folders)[0]].doneUids));
      const g = destOverwriteGuard(dest);
      assertTrue(g.ok && g.resumable);
      fake.destroyEveryBodyPeekAfter = null;
      const resume = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
        retry: fastRetry(),
      });
      assertTrue(resume.ok, resume.reason);
      if (!resume.manifest) {
        throw new Error('expected resumed manifest');
      }
      assertEqual(resume.manifest.files.length, resume.manifest.messageCount);
      assertTrue(resume.manifest.files.length >= 9);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('--verify is offline, detects tamper/missing, work-copy mismatch', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-ver-');
    const work = tmpDir('snap-ver-work-');
    fs.rmSync(work, { recursive: true, force: true });
    try {
      const out = await runReadOnlySnapshot({
        target: TARGET(fake.port),
        username: USER,
        password: PASS,
        dest,
        workCopy: work,
        execute: true,
        freeBytes: AMPLE_DISK,
      });
      assertTrue(out.ok, out.reason);
      const good = verifySnapshotArchive(dest, work);
      assertTrue(good.ok);
      assertTrue(good.complete);
      const vcli = await runSnapshotCli(['--verify', '--dest', dest, '--work-copy', work], {
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stdout: { write: () => true } as unknown as NodeJS.WritableStream,
        stderr: { write: () => true } as unknown as NodeJS.WritableStream,
        env: { PATH: '/bin' },
      });
      assertEqual(vcli, 0);
      const inbox1 = path.join(dest, 'INBOX', '1.eml');
      const orig = fs.readFileSync(inbox1);
      fs.writeFileSync(inbox1, Buffer.concat([orig, Buffer.from('x')]));
      const tamper = verifySnapshotArchive(dest);
      assertFalse(tamper.ok);
      assertTrue(tamper.issues.some((i) => i.kind === 'hash' || i.kind === 'size'));
      fs.writeFileSync(inbox1, orig);
      fs.unlinkSync(inbox1);
      const missing = verifySnapshotArchive(dest);
      assertFalse(missing.ok);
      assertTrue(
        missing.issues.some((i) => i.kind === 'missing' || i.kind === 'count' || i.kind === 'hash')
      );
      fs.writeFileSync(inbox1, orig);
      fs.writeFileSync(path.join(work, 'INBOX', '1.eml'), Buffer.from('local-tamper'));
      const workBad = verifySnapshotArchive(dest, work);
      assertFalse(workBad.ok);
      assertTrue(workBad.issues.some((i) => i.kind === 'work-copy'));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
      await fake.close();
    }
  });

  console.log('\nCategory: keychain / non-TTY / dest progress');
  await test('security find argv is -s -a -w; missing/denied fail closed', () => {
    const args = securityFindPasswordArgs(YAHOO_IMAP_KEYCHAIN_SERVICE, USER);
    assertEqual(args[0], 'find-generic-password');
    assertTrue(args.includes('-s'));
    assertTrue(args.includes('-a'));
    assertTrue(args.includes('-w'));
    assertFalse(args.includes(PASS));
    const missing = classifySecurityFindResult({
      status: 44,
      stdout: '',
      stderr: 'could not be found',
      argv: [SECURITY_BIN, ...args],
    });
    assertFalse(missing.ok);
    if (missing.ok === false) assertEqual(missing.kind, 'missing');
    const denied = classifySecurityFindResult({
      status: 128,
      stdout: '',
      stderr: 'User canceled',
      argv: [SECURITY_BIN, ...args],
    });
    assertFalse(denied.ok);
    if (denied.ok === false) assertEqual(denied.kind, 'denied');
    const linux = readYahooImapPasswordFromKeychain({ account: USER, platform: 'linux' });
    assertFalse(linux.ok);
  });

  await test('non-TTY Yahoo without keychain still fail-closed; denied Keychain does not connect', async () => {
    const calls: string[][] = [];
    const code = await runSnapshotCli(
      [
        '--execute',
        '--dest=/tmp/offline-snapshot-kc-denied',
        '--username',
        USER,
        '--password-from-keychain',
      ],
      {
        stdin: { isTTY: false, read: () => null } as unknown as NodeJS.ReadStream,
        stdout: { write: () => true } as unknown as NodeJS.WritableStream,
        stderr: { write: () => true } as unknown as NodeJS.WritableStream,
        env: { PATH: '/bin' },
        keychainExec: (file, args) => {
          calls.push([file, ...args]);
          return {
            status: 128,
            stdout: '',
            stderr: 'User canceled',
            argv: [file, ...args],
          };
        },
      }
    );
    assertEqual(code, 1);
    assertTrue(calls.length >= 1);
    assertFalse(calls[0].includes(PASS));
    assertTrue(calls[0].includes('-w'));
  });

  await test('non-TTY --password-from-keychain execute; secret not in logs/argv; progress+status files', async () => {
    const fake = await startFakeImapServer({ user: USER, password: PASS });
    const dest = tmpDir('snap-kc-');
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const spawned: string[][] = [];
    try {
      const code = await runSnapshotCli(
        [
          '--execute',
          '--insecure-test-server',
          '--host',
          '127.0.0.1',
          '--port',
          String(fake.port),
          '--username',
          USER,
          '--dest',
          dest,
          '--password-from-keychain',
        ],
        {
          stdin: { isTTY: false, read: () => null } as unknown as NodeJS.ReadStream,
          stdout: {
            write: (s: string) => (stdoutChunks.push(String(s)), true),
          } as NodeJS.WritableStream,
          stderr: {
            write: (s: string) => (stderrChunks.push(String(s)), true),
          } as NodeJS.WritableStream,
          env: { PATH: '/bin' },
          keychainExec: (file, args) => {
            spawned.push([file, ...args]);
            assertEqual(file, SECURITY_BIN);
            assertFalse(args.includes(PASS));
            assertFalse(args.some((a) => a.includes(PASS)));
            return {
              status: 0,
              stdout: PASS + '\n',
              stderr: '',
              argv: [file, ...args],
            };
          },
        }
      );
      assertEqual(code, 0);
      const joined = stdoutChunks.join('') + stderrChunks.join('');
      assertFalse(joined.includes(PASS));
      assertTrue(spawned.length >= 1);
      assertTrue(fs.existsSync(path.join(dest, PROGRESS_LOG)));
      assertTrue(fs.existsSync(path.join(dest, STATUS_FILE)));
      const progress = fs.readFileSync(path.join(dest, PROGRESS_LOG), 'utf8');
      assertFalse(progress.includes(PASS));
      assertContains(progress, 'snapshot:');
      const status = JSON.parse(fs.readFileSync(path.join(dest, STATUS_FILE), 'utf8'));
      assertTrue(status.ok);
      assertTrue(status.complete);
      assertEqual(typeof status.sha256All, 'string');
      assertFalse(JSON.stringify(status).includes(PASS));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });


  console.log('\nCategory: Windows path / cred / sanitization / launcher');
  await test('dest and work-copy accept Windows and POSIX absolute paths; reject relative', () => {
    assertTrue(isAbsoluteSnapshotPath('/tmp/archive'));
    assertTrue(isAbsoluteSnapshotPath(path.resolve(os.tmpdir(), 'archive')));
    if (process.platform === 'win32') {
      assertTrue(isAbsoluteSnapshotPath('D:\\\\Yahoo-Offline\\\\baseline'));
      assertTrue(isAbsoluteSnapshotPath('C:/Users/Public/archive'));
    }
    assertFalse(isAbsoluteSnapshotPath('relative/archive'));
    assertFalse(isAbsoluteSnapshotPath(''));
  });

  await test('Windows Credential Manager target is service|account; missing/denied fail closed; linux stays macOS-only', () => {
    const target = windowsCredentialTarget(YAHOO_IMAP_KEYCHAIN_SERVICE, USER);
    assertEqual(target, YAHOO_IMAP_KEYCHAIN_SERVICE + '|' + USER);
    const args = windowsCredReadArgs('scripts/windows-cred-read.ps1', target, USER);
    assertTrue(args.includes('-File'));
    assertTrue(args.includes('-Target'));
    assertTrue(args.includes(target));
    assertTrue(args.includes(USER));
    assertFalse(args.includes(PASS));
    const missing = classifyWindowsCredResult({
      status: 44,
      stdout: '',
      stderr: 'item could not be found',
      argv: ['powershell.exe', ...args],
    });
    assertFalse(missing.ok);
    if (missing.ok === false) assertEqual(missing.kind, 'missing');
    const denied = classifyWindowsCredResult({
      status: 128,
      stdout: '',
      stderr: 'denied',
      argv: ['powershell.exe', ...args],
    });
    assertFalse(denied.ok);
    if (denied.ok === false) assertEqual(denied.kind, 'denied');
    const linux = readYahooImapPasswordFromKeychain({ account: USER, platform: 'linux' });
    assertFalse(linux.ok);
  });

  await test('archive folder names are encoded deterministically without collisions', () => {
    assertEqual(encodeArchiveRelPath('INBOX'), 'INBOX');
    assertEqual(encodeArchiveRelPath('Work:Urgent'), 'Work%3AUrgent');
    assertEqual(encodeArchiveSegment('CON'), '%43ON');
    assertEqual(encodeArchiveSegment('aux.txt'), '%61ux.txt');
    const dotted = encodeArchiveSegment('folder.');
    assertTrue(dotted.includes('%2E'));
    const encodedPct = encodeArchiveRelPath('A%3AB');
    assertTrue(encodedPct !== encodeArchiveRelPath('A:B'));
    assertEqual(encodeArchiveRelPath('A:B'), 'A%3AB');
    const long = maybeWindowsLongPath("D:\\" + 'a'.repeat(300), 'win32');
    assertTrue(long.startsWith("\\\\?\\"));
    const short = maybeWindowsLongPath("D:\\short", 'win32');
    assertFalse(short.startsWith("\\\\?\\"));
  });

  await test('illegal IMAP folder names write sanitized paths and record mapping', async () => {
    const folders: FakeFolder[] = [
      {
        raw: 'INBOX',
        attrs: ['\\\\HasNoChildren'],
        uidvalidity: 1,
        uidnext: 2,
        messages: [{ uid: 1, flags: ['\\\\Seen'], raw: fixtureRfc822({ subject: 'ok', body: 'ok-body' }) }],
      },
      {
        raw: 'Work:Urgent',
        attrs: ['\\\\HasNoChildren'],
        uidvalidity: 2,
        uidnext: 2,
        messages: [{ uid: 1, flags: ['\\\\Seen'], raw: fixtureRfc822({ subject: 'urgent', body: 'urgent-body' }) }],
      },
      {
        raw: 'CON',
        attrs: ['\\\\HasNoChildren'],
        uidvalidity: 3,
        uidnext: 2,
        messages: [{ uid: 1, flags: ['\\\\Seen'], raw: fixtureRfc822({ subject: 'reserved', body: 'reserved-body' }) }],
      },
    ];
    const fake = await startFakeImapServer({ user: USER, password: PASS, folders });
    const dest = tmpDir('snap-sanitize-');
    try {
      const out = await runReadOnlySnapshot({
        target: { host: '127.0.0.1', port: fake.port, tls: false },
        username: USER,
        password: PASS,
        dest,
        execute: true,
        freeBytes: AMPLE_DISK,
      });
      assertTrue(out.ok, out.reason);
      assertTrue(!!out.manifest);
      const mapping = out.manifest!.folderPathMapping;
      const work = mapping.find((m) => m.original === 'Work:Urgent');
      const reserved = mapping.find((m) => m.original === 'CON');
      assertTrue(!!work);
      assertEqual(work!.stored, 'Work%3AUrgent');
      assertTrue(!!reserved);
      assertEqual(reserved!.stored, '%43ON');
      assertTrue(fs.existsSync(path.join(dest, 'Work%3AUrgent', '1.eml')));
      assertTrue(fs.existsSync(path.join(dest, '%43ON', '1.eml')));
      assertFalse(fs.existsSync(path.join(dest, 'Work:Urgent')));
      assertFalse(fs.existsSync(path.join(dest, 'CON')));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      await fake.close();
    }
  });

  await test('Windows launcher refuses no-args and --password', () => {
    const ps1 = path.join(ROOT, 'scripts', 'offline-imap-snapshot.ps1');
    assertTrue(fs.existsSync(ps1));
    const script = fs.readFileSync(ps1, 'utf8');
    assertContains(script, 'REFUSES');
    assertContains(script, 'BODY.PEEK');
    if (process.platform === 'win32') {
      const none = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
        encoding: 'utf8',
      });
      assertEqual(none.status, 2);
      const pw = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '--execute', '--password=secret'],
        { encoding: 'utf8' }
      );
      assertEqual(pw.status, 1);
      const joined = String(pw.stdout || '') + String(pw.stderr || '');
      assertFalse(joined.includes('secret'));
    }
  });

  await test('free disk space can be read on this platform', () => {
    const n = freeBytesForPath(os.tmpdir());
    assertTrue(n != null && n > 0);
  });

  await test('keep-awake start/release is safe', () => {
    const handle = startKeepAwake();
    handle.release();
    handle.release();
  });


  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
