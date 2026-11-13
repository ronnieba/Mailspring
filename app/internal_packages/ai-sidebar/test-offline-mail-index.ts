#!/usr/bin/env npx ts-node
/**
 * Offline experiment browser: header index, MIME display, catalog scopes,
 * read-only guarantees, network guard decisions. Synthetic fixtures only.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-mail-index.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertBrowsableRoot,
  buildFolderTree,
  buildOfflineMailIndex,
  extractJsonField,
  folderFromRel,
  isBaselineRoot,
  loadOfflineMessage,
} from './lib/core/offline-mail-index';
import {
  buildSandboxedHtmlDocument,
  containsHebrew,
  decodeHeaderValue,
  headerParam,
  parseOfflineMail,
} from './lib/core/offline-mail-mime';
import {
  getOfflineArchiveBody,
  getOfflineArchiveScope,
  searchOfflineArchive,
  setOfflineArchiveBrowserCatalog,
  setOfflineArchiveCatalog,
  setOfflineArchiveCurrentFolder,
  setOfflineArchiveSelection,
} from './lib/offline-archive-catalog';
import { OFFLINE_ARCHIVE_ACCOUNT_ID } from './lib/core/offline-archive-format';
import { isPackageDisabledInOfflineArchive } from '../../src/offline-archive';
import { offlineRequestDecision } from '../../src/browser/offline-network-guard';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function eq(a: unknown, b: unknown, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}
function ok(v: unknown, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}

const HEB_SUBJECT_B64 = Buffer.from('שלום עולם', 'utf8').toString('base64');
const HEB_1255 = Buffer.from([0xf9, 0xec, 0xe5, 0xed]); // "שלום" in windows-1255

function makeTree(): { root: string; work: string; cacheDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-mail-'));
  const work = path.join(base, 'work');
  const write = (rel: string, content: string | Buffer) => {
    const p = path.join(work, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write(
    'Inbox/1.eml',
    [
      'From: =?UTF-8?B?' + Buffer.from('דני', 'utf8').toString('base64') + '?= <dani@example.test>',
      'To: me@example.test',
      `Subject: =?UTF-8?B?${HEB_SUBJECT_B64}?=`,
      'Date: Tue, 03 Nov 2026 10:00:00 +0200',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('גוף ההודעה בעברית\nשורה שנייה', 'utf8').toString('base64'),
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div dir="rtl">גוף <b>HTML</b><img src="https://tracker.example/x.gif"><script>alert(1)</script></div>',
      '--b1--',
      '',
    ].join('\r\n')
  );
  write(
    'Inbox/2.eml',
    Buffer.concat([
      Buffer.from(
        [
          'From: Shop <shop@example.test>',
          'Subject: Invoice 42',
          'Date: Wed, 04 Nov 2026 09:00:00 +0000',
          'Content-Type: multipart/mixed; boundary="mx"',
          '',
          '--mx',
          'Content-Type: text/plain; charset=windows-1255',
          'Content-Transfer-Encoding: 8bit',
          '',
          '',
        ].join('\r\n'),
        'latin1'
      ),
      HEB_1255,
      Buffer.from(
        [
          '',
          '--mx',
          'Content-Type: application/pdf; name="=?UTF-8?B?' +
            Buffer.from('חשבונית.pdf', 'utf8').toString('base64') +
            '?="',
          'Content-Disposition: attachment',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from('%PDF-fake').toString('base64'),
          '--mx--',
          '',
        ].join('\r\n'),
        'latin1'
      ),
    ])
  );
  write(
    'Archive/Sub/3.eml',
    'From: a@b.test\r\nSubject: Plain\r\nDate: Mon, 02 Nov 2026 08:00:00 +0000\r\n\r\nhello\r\n'
  );
  write('snapshot-status.json', '{"ok":true}');
  write(
    'snapshot-manifest.json',
    JSON.stringify({
      version: 1,
      messageCount: 3,
      folderCounts: { Inbox: 2, 'Archive/Sub': 1 },
      folders: [{ path: 'x', gaps: [1, 2, 3] }],
      folderPathMapping: [
        { original: 'Inbox', stored: 'Inbox' },
        { original: 'Archive/Sub:odd', stored: 'Archive/Sub' },
      ],
    })
  );
  const cacheDir = path.join(base, 'profile');
  fs.mkdirSync(path.join(base, 'baseline'));
  return { root: base, work, cacheDir };
}

function snapshotTree(dir: string): string {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else {
        const st = fs.statSync(p);
        out.push(
          `${path.relative(dir, p)}|${st.size}|${st.mtimeMs}|${fs.readFileSync(p).toString('base64')}`
        );
      }
    }
  };
  rec(dir);
  return out.sort().join('\n');
}

async function run() {
  console.log('\n=== Offline experiment browser (synthetic fixtures, no network) ===\n');
  const t = makeTree();
  const before = snapshotTree(t.work);

  await test('refuses baseline and official profile roots', () => {
    ok(isBaselineRoot(path.join(t.root, 'baseline')));
    let threw = false;
    try {
      assertBrowsableRoot(path.join(t.root, 'baseline'));
    } catch {
      threw = true;
    }
    ok(threw, 'baseline must be refused');
    threw = false;
    try {
      assertBrowsableRoot('relative/path');
    } catch {
      threw = true;
    }
    ok(threw, 'relative path must be refused');
  });

  await test('folderFromRel handles nested and maildir paths', () => {
    eq(folderFromRel('Inbox/1.eml'), 'Inbox');
    eq(folderFromRel('A/B/cur/x'), 'A/B');
    eq(folderFromRel('x.eml'), 'INBOX');
  });

  const cachePath = path.join(t.cacheDir, 'offline-mail-index.json');
  let index = await buildOfflineMailIndex(t.work, { cachePath });

  await test('index counts only mail files, not snapshot metadata', () => {
    eq(index.entries.length, 3);
    eq(index.manifestMessageCount, 3);
    eq(index.unreadable.length, 0);
  });

  await test('Hebrew headers decode (RFC2047 base64)', () => {
    const e = index.entries.find((x) => x.rel === 'Inbox/1.eml')!;
    eq(e.subject, 'שלום עולם');
    ok(e.hebrew);
    ok(containsHebrew(e.from));
  });

  await test('manifest folder mapping restores original folder names', () => {
    eq(index.folderNames['Archive/Sub'], 'Archive/Sub:odd');
    const tree = buildFolderTree(index);
    eq(
      tree.map((n) => n.path),
      ['Inbox', 'Archive']
    );
    eq(tree[1].totalCount, 1);
    eq(tree[1].children[0].name, 'Sub:odd');
  });

  await test('second build reuses the cache', async () => {
    index = await buildOfflineMailIndex(t.work, { cachePath });
    eq(index.stats.reused, 3);
    eq(index.stats.parsed, 0);
  });

  await test('cache is never written inside the archive', () => {
    let threw = false;
    return buildOfflineMailIndex(t.work, { cachePath: path.join(t.work, 'idx.json') }).then(
      (idx) => {
        threw = idx.unreadable.some((u) => u.rel === '(index cache)');
        ok(threw, 'expected cache write refusal to be recorded');
        ok(!fs.existsSync(path.join(t.work, 'idx.json')));
      }
    );
  });

  await test('MIME: windows-1255 body and RFC2047 attachment name', async () => {
    const m = await loadOfflineMessage(t.work, 'Inbox/2.eml');
    eq(m.text.trim(), 'שלום');
    eq(m.attachments.length, 1);
    eq(m.attachments[0].filename, 'חשבונית.pdf');
  });

  await test('MIME: alternative keeps html + text; sandbox doc blocks network and scripts', async () => {
    const m = await loadOfflineMessage(t.work, 'Inbox/1.eml');
    ok(m.html && m.html.includes('HTML'));
    ok(m.text.includes('גוף ההודעה בעברית'));
    const doc = buildSandboxedHtmlDocument(m.html as string);
    ok(doc.includes("default-src 'none'"));
    ok(doc.includes('img-src data:'));
    ok(!/<script/i.test(doc), 'scripts must be removed');
  });

  await test('header helpers: RFC2231 + split encoded words', () => {
    eq(
      headerParam("attachment; filename*=utf-8''%D7%A9%D7%9C%D7%95%D7%9D.txt", 'filename'),
      'שלום.txt'
    );
    const b = Buffer.from('שלום', 'utf8');
    const w1 = b.subarray(0, 3).toString('base64');
    const w2 = b.subarray(3).toString('base64');
    eq(decodeHeaderValue(`=?UTF-8?B?${w1}?= =?UTF-8?B?${w2}?=`), 'שלום');
    eq(parseOfflineMail('Subject: x\r\n\r\nbody').text, 'body');
  });

  await test('catalog scopes follow browser selection and folder', () => {
    const msgs = index.entries.map((e) => ({
      id: e.id,
      threadId: `t-${e.id}`,
      accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
      folderId: e.folder,
      folderPath: e.folder,
      subject: e.subject,
      from: e.from,
      date: new Date(e.ts).toISOString(),
      snippet: '',
      bodyText: '',
      sha256: '',
      byteLength: e.size,
      attachmentCount: 0,
      sourceRelPath: e.rel,
    }));
    let loads = 0;
    setOfflineArchiveBrowserCatalog(msgs as any, null, (m) => {
      loads++;
      return parseOfflineMail(fs.readFileSync(path.join(t.work, ...m.sourceRelPath.split('/'))))
        .text;
    });
    eq(getOfflineArchiveScope('selected-messages').isEmpty, true);
    const inbox = msgs.filter((m) => m.folderPath === 'Inbox');
    setOfflineArchiveSelection([inbox[0].id, inbox[1].id]);
    const sel = getOfflineArchiveScope('selected-messages');
    eq(sel.messageIds!.length, 2);
    const r = searchOfflineArchive(sel, '', 'ranked', 50, 0);
    eq(r.messages.length, 2);
    ok(
      r.messages.every((m) => typeof m.bodyText === 'string' && m.bodyText.length > 0),
      'lazy bodies'
    );
    setOfflineArchiveCurrentFolder({ path: 'Inbox', name: 'Inbox' });
    const folder = getOfflineArchiveScope('current-folder');
    eq(searchOfflineArchive(folder, '', 'exhaustive', 50, 0).progress.totalEligible, 2);
    eq(getOfflineArchiveScope('all-mail').isEmpty, false);
    eq(
      searchOfflineArchive(getOfflineArchiveScope('all-mail'), 'Invoice', 'ranked', 1, 0)
        .messages[0].subject,
      'Invoice 42'
    );
    ok(getOfflineArchiveBody(inbox[0].id) !== null);
    ok(loads > 0);
    setOfflineArchiveCatalog([], null);
  });

  await test('archive files are byte-for-byte unchanged after indexing and reading', () => {
    eq(snapshotTree(t.work) === before, true);
  });

  await test('offline mode disables account/sync/send packages only', () => {
    for (const p of [
      'composer',
      'thread-list',
      'message-list',
      'account-sidebar',
      'send-later',
      'mcp-server',
    ]) {
      ok(isPackageDisabledInOfflineArchive(p), p);
    }
    for (const p of ['ai-sidebar', 'preferences', 'ui-light', 'attachments']) {
      ok(!isPackageDisabledInOfflineArchive(p), p);
    }
  });

  await test('network guard: remote blocked, local + Gemini API allowed', () => {
    eq(offlineRequestDecision('https://imap.mail.yahoo.com/'), 'block');
    eq(offlineRequestDecision('https://id.getmailspring.com/api/me'), 'block');
    eq(offlineRequestDecision('http://tracker.example/x.gif'), 'block');
    eq(offlineRequestDecision('wss://example.com/'), 'block');
    eq(offlineRequestDecision('file:///C:/x/index.html'), 'allow');
    eq(offlineRequestDecision('data:image/png;base64,AA=='), 'allow');
    eq(offlineRequestDecision('devtools://devtools/bundled/x'), 'allow');
    eq(
      offlineRequestDecision('https://generativelanguage.googleapis.com/v1beta/x'),
      'allow-remote'
    );
    eq(offlineRequestDecision('http://generativelanguage.googleapis.com/v1beta/x'), 'block');
  });

  await test('extractJsonField parses only the requested array', () => {
    const buf = Buffer.from('{"a":[1,"]",{"b":"[x"}],"n":5,"o":{"k":"}"}}');
    eq(extractJsonField(buf, 'a'), [1, ']', { b: '[x' }]);
    eq(extractJsonField(buf, 'n'), 5);
    eq(extractJsonField(buf, 'o'), { k: '}' });
    eq(extractJsonField(buf, 'missing'), undefined);
  });

  fs.rmSync(t.root, { recursive: true, force: true });
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
