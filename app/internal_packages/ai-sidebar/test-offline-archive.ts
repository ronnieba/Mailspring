#!/usr/bin/env npx ts-node
/**
 * Disconnected local-archive reader. Fake fixtures only.
 * No live Yahoo, credentials, official profile, or paid Gemini calls.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-archive.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  assertReadOnlyImapCommand,
  estimateArchiveDisk,
  estimateBaselineAndWorkCopy,
  inventoryFolders,
  plannedImapSnapshotSteps,
  YAHOO_FOLDER_CANDIDATES,
  YAHOO_IMAP_HOST,
} from './lib/core/offline-imap-snapshot-plan';
import {
  FsLike,
  isForbiddenArchiveRoot,
  isOfflineArchiveMailRef,
  materializeWorkingCopy,
  originalHashesUnchanged,
  readOfflineArchive,
  sha256Hex,
  stripRemoteHtml,
} from './lib/core/offline-archive-format';
import {
  getOfflineArchiveCatalog,
  getOfflineArchiveScope,
  searchOfflineArchive,
  setOfflineArchiveCatalog,
  setOfflineArchiveSelected,
} from './lib/offline-archive-catalog';
import {
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_PAID_ENV,
  GeminiDemoMailRef,
  isGeminiHostFailure,
  isGeminiHostOk,
  OFFLINE_ARCHIVE_ACCOUNT_ID,
} from '../../src/browser/gemini-demo-protocol';
import {
  GeminiFetch,
  resolveGeminiDemoStatus,
  runGeminiDemoQuery,
} from '../../src/browser/gemini-demo-host';
import { isOfflineArchiveMode, setOfflineArchiveOverride } from '../../src/offline-archive';
import { shouldOpenMailCacheDatabase } from '../../src/mail-database-policy';

const { identityFromArgv, startupFlagsFromArgv } = require('../../src/browser/dev-isolation.js');

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');
const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/offline-archive');

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
function assertContains(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(msg || `Expected to contain ${JSON.stringify(needle)}`);
  }
}

const FAKE_KEY = 'test-not-a-secret-gemini-key';
const FAKE_ARCHIVE: GeminiDemoMailRef = {
  id: 'offline-0123456789abcdef',
  threadId: 'offline-thread-0123456789',
  accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
  subject: 'Welcome to the local archive',
  from: 'Archive Sender <archive-sender@example.test>',
  date: '2024-11-01T10:00:00Z',
  snippet: 'Inbox body',
  bodyText: 'Inbox body for the disconnected archive reader.',
};

function paidEnv(): NodeJS.ProcessEnv {
  return {
    [GEMINI_DEMO_KEY_ENV]: FAKE_KEY,
    [GEMINI_DEMO_PAID_ENV]: '1',
  };
}

function liveFetch(messageId = FAKE_ARCHIVE.id): GeminiFetch {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: 'completed',
        output: [
          JSON.stringify({
            response: 'One-message summary of a local archive TEST fixture.',
            citations: [
              {
                messageId,
                threadId: FAKE_ARCHIVE.threadId,
                subject: FAKE_ARCHIVE.subject,
                from: FAKE_ARCHIVE.from,
                date: String(FAKE_ARCHIVE.date),
                snippet: FAKE_ARCHIVE.snippet,
              },
            ],
          }),
        ],
        usage: { total_tokens: 7 },
      });
    },
  });
}

class MemoryFs implements FsLike {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(['/']);

  addFile(p: string, content: string) {
    const abs = p.startsWith('/') ? p : `/${p}`;
    const parts = abs.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      this.dirs.add(cur);
    }
    this.dirs.add(path.posix.dirname(abs));
    this.files.set(abs, Buffer.from(content, 'latin1'));
  }

  readdirSync(p: string, _opts?: { withFileTypes?: boolean }) {
    const prefix = `${p.replace(/\/$/, '')}/`;
    const names = new Set<string>();
    const consider = (key: string) => {
      if (key.startsWith(prefix)) {
        const name = key.slice(prefix.length).split('/')[0];
        if (name) names.add(name);
      }
    };
    for (const key of this.dirs) consider(key);
    for (const key of this.files.keys()) consider(key);
    return [...names].map((name) => {
      const full = `${p.replace(/\/$/, '')}/${name}`;
      const isDir = this.dirs.has(full);
      const isFile = this.files.has(full);
      return {
        name,
        isDirectory: () => isDir && !isFile,
        isFile: () => isFile,
      };
    });
  }

  readFileSync(p: string): Buffer {
    const buf = this.files.get(p);
    if (!buf) throw new Error(`ENOENT ${p}`);
    return buf;
  }

  statSync(p: string) {
    if (this.files.has(p)) {
      return { isDirectory: () => false, isFile: () => true, size: this.files.get(p)!.length };
    }
    if (this.dirs.has(p)) {
      return { isDirectory: () => true, isFile: () => false, size: 0 };
    }
    throw new Error(`ENOENT ${p}`);
  }

  mkdirSync(p: string, _opts?: { recursive?: boolean }) {
    this.dirs.add(p);
  }

  copyFileSync(src: string, dest: string) {
    this.files.set(dest, Buffer.from(this.readFileSync(src)));
  }

  writeFileSync(p: string, data: string | Buffer) {
    this.files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
}

async function run() {
  console.log('\n=== Offline archive reader (fake fixtures, no Yahoo) ===\n');

  console.log('Category: IMAP snapshot plan (no socket)');
  await test('STORE / SELECT / BODY[] / RFC822 are forbidden', () => {
    assertFalse(assertReadOnlyImapCommand('A1 STORE 1 +FLAGS (\\Seen)').ok);
    assertFalse(assertReadOnlyImapCommand('A2 UID STORE 1 +FLAGS (\\Deleted)').ok);
    assertFalse(assertReadOnlyImapCommand('A3 EXPUNGE').ok);
    assertFalse(assertReadOnlyImapCommand('A4 SELECT INBOX').ok);
    assertFalse(assertReadOnlyImapCommand('A5 UID FETCH 1:* BODY[]').ok);
    assertFalse(assertReadOnlyImapCommand('A6 FETCH 1 RFC822').ok);
    assertFalse(assertReadOnlyImapCommand('A7 FETCH 1 RFC822.TEXT').ok);
    assertFalse(assertReadOnlyImapCommand('A8 MOVE 1 Trash').ok);
  });

  await test('EXAMINE / BODY.PEEK / RFC822.SIZE are allowed', () => {
    assertTrue(assertReadOnlyImapCommand('EXAMINE INBOX').ok);
    assertTrue(assertReadOnlyImapCommand('A1 EXAMINE INBOX').ok);
    assertTrue(assertReadOnlyImapCommand('UID FETCH 1:* BODY.PEEK[]').ok);
    assertTrue(assertReadOnlyImapCommand('A2 UID FETCH 1:* BODY.PEEK[]').ok);
    assertTrue(assertReadOnlyImapCommand('UID FETCH 1:* (RFC822.SIZE)').ok);
    assertTrue(assertReadOnlyImapCommand('LIST "" "*"').ok);
    assertEqual(YAHOO_IMAP_HOST, 'imap.mail.yahoo.com');
  });

  await test('folder inventory discloses missing Bulk/Spam/Trash', () => {
    const inv = inventoryFolders([
      {
        path: 'Inbox',
        selectable: true,
        exists: 3,
        uidvalidity: 1,
        status: 'listed',
        note: '',
      },
      {
        path: 'Noselect',
        selectable: false,
        exists: null,
        uidvalidity: null,
        status: 'unselectable',
        note: '\\Noselect',
      },
    ]);
    assertTrue(inv.missingCandidates.includes('Bulk Mail'));
    assertTrue(inv.missingCandidates.includes('Spam'));
    assertTrue(inv.missingCandidates.includes('Trash'));
    assertEqual(inv.unselectable.length, 1);
    assertTrue(YAHOO_FOLDER_CANDIDATES.includes('Bulk Mail'));
  });

  await test('disk estimate is rfc822*1.15 + 64MiB and unknown sizes are counted', () => {
    const est = estimateArchiveDisk([1000, null, 3000]);
    assertEqual(est.messageCount, 3);
    assertEqual(est.rfc822Bytes, 4000);
    assertEqual(est.unknownSizes, 1);
    assertEqual(est.recommendedFreeBytes, Math.ceil(4000 * 1.15) + 64 * 1024 * 1024);
    const two = estimateBaselineAndWorkCopy([1000, null, 3000]);
    assertEqual(two.rfc822Bytes, 4000);
    assertEqual(two.recommendedFreeBytes, Math.ceil(4000 * 1.15) * 2 + 64 * 1024 * 1024);
  });

  await test('planned steps never claim the cloud agent connects', () => {
    const steps = plannedImapSnapshotSteps().join('\n');
    assertContains(steps, 'never this cloud agent');
    assertContains(steps, 'EXAMINE');
    assertContains(steps, 'BODY.PEEK[]');
    assertFalse(steps.includes('openssl s_client'));
  });

  console.log('\nCategory: archive format / fixtures');
  await test('stripRemoteHtml disables scripts and https images', () => {
    const out = stripRemoteHtml(
      '<script>alert(1)</script><img src="https://evil.example.test/x.png" onerror="alert(1)"><p>ok</p>'
    );
    assertFalse(out.includes('<script'));
    assertFalse(out.includes('https://evil.example.test'));
    assertFalse(/onerror/i.test(out));
    assertContains(out, '<p>ok</p>');
  });

  await test('committed fixtures load Inbox/Bulk/Trash/Spam/Draft/Sent/Starred', () => {
    const { messages, manifest } = readOfflineArchive(FIXTURE_ROOT);
    assertEqual(manifest.messageCount, 8);
    assertEqual(manifest.unreadable.length, 0);
    assertTrue(manifest.folderCounts.Inbox >= 1);
    assertTrue(manifest.folderCounts['Bulk Mail'] >= 1);
    assertTrue(manifest.folderCounts.Trash >= 1);
    assertTrue(manifest.folderCounts.Spam >= 2);
    assertTrue(manifest.folderCounts.Draft >= 1);
    assertTrue(manifest.folderCounts.Sent >= 1);
    assertTrue(manifest.folderCounts.Starred >= 1);
    assertTrue(messages.every((m) => m.from.includes('@example.test')));
    assertTrue(messages.every((m) => isOfflineArchiveMailRef(m)));
    const welcome = messages.find((m) => m.subject.includes('Welcome'));
    assertTrue(!!welcome);
    if (welcome) {
      assertEqual(welcome.attachmentCount, 1);
      assertFalse(welcome.bodyText.includes('<script'));
      assertFalse(welcome.bodyText.includes('https://evil.example.test'));
    }
  });

  await test('refuses official Mailspring profile/cache as an archive root', () => {
    const profile = isForbiddenArchiveRoot(
      '/Users/d623300/Library/Application Support/Mailspring/edgehill.db'
    );
    assertTrue(profile.forbidden);
    assertContains(profile.reason, 'not a complete backup');
    const rel = isForbiddenArchiveRoot('relative/mail');
    assertTrue(rel.forbidden);
    const ok = isForbiddenArchiveRoot(FIXTURE_ROOT);
    assertFalse(ok.forbidden);
    const offlineProfile = isForbiddenArchiveRoot(
      '/Users/d623300/Library/Application Support/Mailspring-offline/work'
    );
    assertFalse(offlineProfile.forbidden);
  });

  await test('working copy does not mutate original hashes', () => {
    const io = new MemoryFs();
    io.dirs.add('/orig');
    io.dirs.add('/orig/Inbox');
    io.addFile('/orig/Inbox/a.eml', 'From: archive-sender@example.test\nSubject: copy\n\nbody\n');
    const before = sha256Hex(io.readFileSync('/orig/Inbox/a.eml'));
    const { originalHashes } = materializeWorkingCopy({
      originalRoot: '/orig',
      workRoot: '/work',
      io,
    });
    assertEqual(originalHashes['Inbox/a.eml'], before);
    io.files.set('/work/Inbox/a.eml', Buffer.from('deleted-locally'));
    assertTrue(originalHashesUnchanged('/orig', originalHashes, io));
    assertEqual(sha256Hex(io.readFileSync('/orig/Inbox/a.eml')), before);
  });

  console.log('\nCategory: catalog / selected-only Gemini surface');
  await test('catalog selected-messages is exactly one local id', () => {
    const { messages } = readOfflineArchive(FIXTURE_ROOT);
    setOfflineArchiveCatalog(messages);
    const first = messages[0];
    const second = messages[1];
    assertTrue(!!first && !!second);
    const scope = getOfflineArchiveScope('selected-messages');
    assertEqual(scope.messageIds?.length, 1);
    assertEqual(scope.isEmpty, false);
    const searched = searchOfflineArchive(scope, '', 'ranked', 10, 0);
    assertEqual(searched.messages.length, 1);
    assertEqual(searched.progress.missingBodies, 0);
    assertTrue(setOfflineArchiveSelected(second.id));
    const next = getOfflineArchiveScope('selected-messages');
    assertEqual(next.messageIds?.[0], second.id);
    setOfflineArchiveCatalog([]);
  });

  console.log('\nCategory: isolation / mail cache');
  await test('offline identity is Mailspring-offline, skipMailsync, mock keychain', () => {
    const id = identityFromArgv(
      ['electron', './app', '--dev', '--offline-archive', '--offline-archive-path=/tmp/x'],
      { developerBuild: true }
    );
    assertEqual(id.appName, 'Mailspring-offline');
    assertEqual(id.configDirName, 'Mailspring-offline');
    assertTrue(id.skipMailsync);
    assertTrue(id.useMockKeychain);
    assertTrue(id.skipAutoUpdate);
    assertFalse(shouldOpenMailCacheDatabase({ demoMode: false, offlineArchive: true }));
  });

  await test('--demo wins; --offline-archive wins over live real-selected', () => {
    const demo = identityFromArgv(['electron', './app', '--dev', '--demo', '--offline-archive'], {
      developerBuild: true,
    });
    assertEqual(demo.appName, 'Mailspring-demo');
    const offline = identityFromArgv(
      ['electron', './app', '--dev', '--offline-archive', '--real-selected-summary'],
      { developerBuild: true }
    );
    assertEqual(offline.appName, 'Mailspring-offline');
    const flags = startupFlagsFromArgv(['--offline-archive-path=/tmp/x']);
    assertFalse(flags.offlineArchive);
    const packaged = identityFromArgv(['electron', './app', '--offline-archive'], {
      developerBuild: false,
    });
    assertEqual(packaged.appName, 'Mailspring');
  });

  await test('detector override; --demo still wins', () => {
    setOfflineArchiveOverride(true);
    assertTrue(isOfflineArchiveMode());
    setOfflineArchiveOverride(false);
    assertFalse(isOfflineArchiveMode());
    setOfflineArchiveOverride(null);
  });

  console.log('\nCategory: Gemini host fail-closed (mocked fetch, no paid call)');
  await test('offline host rejects bulk and synthetic; admits one archive fixture', async () => {
    let called = 0;
    const { fetch } = (() => {
      const impl = liveFetch();
      const wrap: GeminiFetch = async (url, init) => {
        called += 1;
        return impl(url, init);
      };
      return { fetch: wrap };
    })();
    const deps = {
      demoMode: false,
      offlineArchive: true,
      env: paidEnv(),
      fetch,
    };
    const bulk = await runGeminiDemoQuery(
      {
        generation: 1,
        query: 'summarize all mail',
        messages: [FAKE_ARCHIVE, { ...FAKE_ARCHIVE, id: 'offline-ffffffffffffffff' }],
        mode: 'offline-archive-selected',
        allowedMessageId: FAKE_ARCHIVE.id,
        snapshotEpoch: 1,
      },
      deps
    );
    assertTrue(isGeminiHostFailure(bulk));
    const synthetic = await runGeminiDemoQuery(
      {
        generation: 1,
        query: 'summarize',
        messages: [
          {
            id: 'demo-msg-1',
            threadId: 'demo-thread-1',
            accountId: 'demo-synthetic-account',
            subject: '🧪 [DEMO] test',
            from: 'demo-manager@synthetic.test',
            date: '2024-11-01T00:00:00Z',
            snippet: 'fixture',
            bodyText: 'fixture',
          },
        ],
        mode: 'offline-archive-selected',
        allowedMessageId: 'demo-msg-1',
        snapshotEpoch: 1,
      },
      deps
    );
    assertTrue(isGeminiHostFailure(synthetic));
    const ok = await runGeminiDemoQuery(
      {
        generation: 1,
        query:
          'Summarize this one selected email. Use only the provided message. Do not invent other mail.',
        messages: [FAKE_ARCHIVE],
        mode: 'offline-archive-selected',
        allowedMessageId: FAKE_ARCHIVE.id,
        snapshotEpoch: 1,
      },
      deps
    );
    assertTrue(isGeminiHostOk(ok));
    assertEqual(called, 1);
    const status = resolveGeminiDemoStatus({
      demoMode: false,
      offlineArchive: true,
      env: paidEnv(),
    });
    assertTrue(status.configured);
    assertTrue(!!status.offlineArchive);
    assertContains(status.reason, 'Not bulk upload');
  });

  await test('without offline flag, archive query stays unconfigured', async () => {
    let called = false;
    const fetch: GeminiFetch = async () => {
      called = true;
      throw new Error('must not fetch');
    };
    const out = await runGeminiDemoQuery(
      {
        generation: 1,
        query: 'summarize',
        messages: [FAKE_ARCHIVE],
        mode: 'offline-archive-selected',
        allowedMessageId: FAKE_ARCHIVE.id,
        snapshotEpoch: 1,
      },
      { demoMode: false, env: paidEnv(), fetch }
    );
    assertTrue(isGeminiHostFailure(out));
    if (isGeminiHostFailure(out)) assertEqual(out.reason, 'unconfigured');
    assertFalse(called);
  });

  console.log('\nCategory: launchers / source-guards');
  await test('snapshot script refuses to connect', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/offline-imap-snapshot.sh'), 'utf8');
    assertContains(script, 'REFUSES');
    assertContains(script, 'EXAMINE');
    assertContains(script, 'BODY.PEEK');
    assertContains(script, 'exit 2');
    assertFalse(script.includes('openssl s_client'));
    assertFalse(/\bnc\b/.test(script));
    assertFalse(script.includes('imap.mail.yahoo.com:993"'));
    const gitSh = path.join('C:\\Program Files', 'Git', 'bin', 'sh.exe');
    const sh = fs.existsSync(gitSh) ? gitSh : 'sh';
    const spawn = require('child_process').spawnSync(sh, [
      path.join(ROOT, 'scripts/offline-imap-snapshot.sh'),
    ]);
    assertEqual(spawn.status, 2);
  });

  await test('offline launcher never --demo / production user-data-dir / live real-selected', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/start-offline-archive.sh'), 'utf8');
    assertContains(script, '--offline-archive');
    assertContains(script, '--dev');
    assertContains(script, 'env -u MAILSPRING_DEMO_GEMINI_API_KEY');
    const execLines = script.split('\n').filter((l) => l.includes('"$ELECTRON" "$ROOT/app"'));
    assertTrue(execLines.length > 0);
    for (const line of execLines) {
      assertFalse(line.includes('--demo'));
      assertFalse(line.includes('--user-data-dir'));
      assertFalse(line.includes('--real-selected-summary'));
      assertContains(line, '--dev');
      assertContains(line, '--offline-archive');
    }
    assertContains(script, 'Never --demo. Never --user-data-dir');
    assertContains(script, 'Mailspring-offline');
    assertContains(script, '/Applications/Mailspring.app is unused');
    assertContains(script, 'refuses official Mailspring profile/cache');
  });

  await test('store/sidebar/host keep Yahoo out of the experiment reader', () => {
    const store = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar-store.ts'), 'utf8');
    assertContains(store, 'offline-archive-selected');
    assertContains(store, 'isOfflineArchiveMode');
    assertContains(store, 'selectOfflineArchiveMessage');
    assertFalse(store.includes('setFocus'));
    const sidebar = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar.tsx'), 'utf8');
    assertContains(sidebar, 'data-offline-archive');
    assertContains(sidebar, 'data-offline-archive-summarize');
    assertFalse(sidebar.includes('Actions.queueTask'));
    const adapter = fs.readFileSync(path.join(__dirname, 'lib/mailspring-adapter.ts'), 'utf8');
    assertContains(adapter, 'getOfflineArchiveScope');
    assertContains(adapter, 'isOfflineArchiveMode');
    const appTs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'application.ts'), 'utf8');
    assertContains(appTs, 'offlineArchive');
    assertContains(appTs, 'Skipping mailsync');
    assertContains(appTs, 'Yahoo IMAP is not opened');
    const db = fs.readFileSync(path.join(APP_SRC_ROOT, 'flux/stores/database-store.ts'), 'utf8');
    assertContains(db, 'offlineArchive: isOfflineArchiveMode()');
    const host = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser/gemini-demo-host.ts'), 'utf8');
    assertContains(host, 'admitOfflineArchiveQuery');
    assertContains(host, 'GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION');
  });

  await test('docs do not call the official cache a complete backup', () => {
    const guide = fs.readFileSync(path.join(__dirname, 'MAC-BUILD-GUIDE.md'), 'utf8');
    assertContains(guide, 'start-offline-archive.sh');
    assertContains(guide, 'Mailspring-offline');
    assertContains(guide, 'BODY.PEEK');
    assertContains(guide, 'not a complete backup');
    assertContains(guide, 'GetManyRFC2822Task');
    assertFalse(guide.includes('copy the production profile'));
    const exportSrc = fs.readFileSync(
      path.join(APP_SRC_ROOT, '../internal_packages/account-sidebar/lib/sidebar-item.ts'),
      'utf8'
    );
    assertContains(exportSrc, 'EXCLUDED_EXPORT_ROLES');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
