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
import { fixtureRfc822, startFakeImapServer } from '../../src/offline-snapshot/fake-imap-server';
import { runReadOnlySnapshot, destOverwriteGuard } from '../../src/offline-snapshot/snapshot-run';
import { ReadOnlyImapSession } from '../../src/offline-snapshot/read-only-session';
import { parseSnapshotArgv, runSnapshotCli, usage } from '../../src/offline-snapshot/cli';
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
    const spawn = spawnSync('sh', [path.join(ROOT, 'scripts/offline-imap-snapshot.sh')]);
    assertEqual(spawn.status, 2);
  });

  await test('refuses password argv/env; stdin secret is test-server only', () => {
    assertTrue(argvLooksLikePasswordFlag(['--execute', '--password=secret']));
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

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
