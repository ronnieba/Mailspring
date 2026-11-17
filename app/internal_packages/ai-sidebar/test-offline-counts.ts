#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t204): folder counts are consistent everywhere.
 * - folder badge = unique messages in that exact folder (a duplicate copy of
 *   the same Message-ID in the same folder counts once);
 * - flat list rows == badge; header "N messages · M conversations";
 * - messages pulled into a conversation from other folders do not inflate
 *   the folder count; the AI folder / whole-copy scopes count the same way.
 * Synthetic messages in a temp folder only; no network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-counts.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { messageKey, uniqueInFolder } from './lib/core/offline-threads';
import { buildFolderTree } from './lib/core/offline-mail-index';
import { offlineMailStore } from './lib/offline-mail/offline-mail-store';
import { getOfflineArchiveScope, getOfflineScopeFacts } from './lib/offline-archive-catalog';
import { setOfflineLangOverride } from './lib/core/offline-i18n';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).stack || err}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) {
    throw new Error(msg);
  }
}
const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const A = 'Alpha Person <alpha@example.test>';
const B = 'Beta Person <beta@example.test>';

function eml(o: {
  from: string;
  to: string;
  subject: string;
  date: string;
  id?: string;
  irt?: string;
}) {
  const h = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    o.id ? `Message-ID: ${o.id}` : '',
    o.irt ? `In-Reply-To: ${o.irt}` : '',
    o.irt ? `References: ${o.irt}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].filter(Boolean);
  return `${h.join('\r\n')}\r\n\r\nsynthetic body\r\n`;
}

async function main() {
  console.log('offline folder counts (t204)');
  setOfflineLangOverride('he');

  await test('messageKey / uniqueInFolder: same Message-ID once, no-id messages each count', () => {
    const list = [
      { id: 'a', msgId: '<X@y>' },
      { id: 'b', msgId: '<x@y>' },
      { id: 'c' },
      { id: 'd' },
    ];
    assert(messageKey(list[0]) === messageKey(list[1]), 'case-insensitive');
    assert(
      uniqueInFolder(list)
        .map((e) => e.id)
        .join() === 'a,c,d',
      'kept first'
    );
  });

  await test('folder tree badge counts unique messages in the exact folder', () => {
    const entries: any[] = [
      { id: '1', folder: 'P/Q/R', msgId: '<m1@x>' },
      { id: '2', folder: 'P/Q/R', msgId: '<m1@x>' },
      { id: '3', folder: 'P/Q/R' },
      { id: '4', folder: 'P/Q', msgId: '<m1@x>' },
    ];
    const tree = buildFolderTree({ entries, folderNames: {} } as any);
    const r = tree[0].children[0].children[0];
    assert(r.count === 2, `R count ${r.count}`);
    assert(tree[0].children[0].count === 1, 'copy in parent counted in parent only');
  });

  // ---- store: a nested folder shaped like the reported one ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-cnt-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-cnt-prof-'));
  const deep = path.join('Lvl1', 'Lvl2', 'Lvl3');
  fs.mkdirSync(path.join(root, deep), { recursive: true });
  fs.mkdirSync(path.join(root, 'Sent'));
  const w = (rel: string, body: string) => fs.writeFileSync(path.join(root, rel), body);
  // 13 single messages in the deep folder.
  for (let i = 1; i <= 13; i++) {
    const d = `Mon, ${String(i).padStart(2, '0')} Nov 2026 09:00:00 +0000`;
    w(
      path.join(deep, `m${i}.eml`),
      eml({ from: B, to: A, subject: `Item ${i}`, date: d, id: `<m${i}@x>` })
    );
  }
  // The 14th: a reply in the deep folder to a message that lives in Sent.
  w(
    'Sent/q1.eml',
    eml({
      from: A,
      to: B,
      subject: 'Question',
      date: 'Sat, 14 Nov 2026 08:00:00 +0000',
      id: '<q1@x>',
    })
  );
  w(
    path.join(deep, 'r1.eml'),
    eml({
      from: B,
      to: A,
      subject: 'Re: Question',
      date: 'Sat, 14 Nov 2026 10:00:00 +0000',
      id: '<r1@x>',
      irt: '<q1@x>',
    })
  );
  // A duplicate copy of m1 stored twice in the same folder (export artefact).
  w(
    path.join(deep, 'm1-copy.eml'),
    eml({
      from: B,
      to: A,
      subject: 'Item 1',
      date: 'Mon, 01 Nov 2026 09:00:00 +0000',
      id: '<m1@x>',
    })
  );
  // The same m2 also filed in Sent (a copy in another folder).
  w(
    'Sent/m2.eml',
    eml({
      from: B,
      to: A,
      subject: 'Item 2',
      date: 'Mon, 02 Nov 2026 09:00:00 +0000',
      id: '<m2@x>',
    })
  );

  const cache = path.join(profile, 'offline-mail-index.json');
  await offlineMailStore.start(root, cache);
  const s = offlineMailStore;
  const deepPath = 'Lvl1/Lvl2/Lvl3';

  await test('badge == flat rows == unique messages (duplicate copy counted once)', () => {
    const node = s.findFolder(deepPath)!;
    assert(node, 'folder found');
    assert(node.count === 14, `badge ${node.count}`);
    s.setThreaded(false);
    s.setFolder(deepPath);
    assert(s.visibleRows().length === 14, `flat rows ${s.visibleRows().length}`);
    assert(s.visibleMessages().length === 14, 'messages');
  });

  await test('threaded: the reply shows its Sent parent but the folder count stays 14', () => {
    s.setThreaded(true);
    s.setFolder(deepPath);
    const rows = s.visibleRows();
    assert(rows.length === 14, `conversations ${rows.length}`);
    const thread = rows.find((r) => r.ids.length === 2)!;
    assert(thread && thread.inFolder === 1, 'one in folder, one pulled from Sent');
    assert(rows.reduce((n, r) => n + r.inFolder, 0) === 14, 'in-folder sum == badge');
    assert(s.visibleMessages().length === s.findFolder(deepPath)!.count, 'header == badge');
  });

  await test('AI scopes count the same way (folder 14; whole copy counts each message once)', () => {
    s.setFolder(deepPath);
    const folderScope = getOfflineArchiveScope('current-folder');
    assert(folderScope.messageCount === 14, `folder scope ${folderScope.messageCount}`);
    assert(getOfflineScopeFacts(folderScope).totalInScope === 14, 'facts');
    const all = getOfflineArchiveScope('all-mail');
    // 14 in the deep folder + q1 in Sent; m2's Sent copy and m1's copy are the same messages.
    assert(all.messageCount === 15, `all ${all.messageCount}`);
    const sent = s.findFolder('Sent')!;
    assert(sent.count === 2, `Sent badge ${sent.count}`);
  });

  await test('summary reports duplicate copies as a number only', () => {
    const sum = s.summary() as any;
    assert(sum.messages === 17, `raw files ${sum.messages}`);
    assert(sum.duplicateCopies === 1, `dups ${sum.duplicateCopies}`);
    assert(sum.listedMessages === 16, `listed ${sum.listedMessages}`);
  });

  await test('list header shows "N messages · M conversations" and a "more below" hint', () => {
    const src = read('lib/offline-mail/offline-message-list.tsx');
    assert(src.includes('הודעות · ${rows.length.toLocaleString()} שיחות'), 'threaded header');
    assert(src.includes('data-offline-list-messages={messageCount}'), 'messages attr');
    assert(src.includes('data-offline-list-more={below}'), 'more below');
  });

  await test('list keeps measuring after the drafts list was shown (no "only 8 rows" blank list)', () => {
    const src = read('lib/offline-mail/offline-message-list.tsx');
    assert(src.includes('ref={this._setScrollEl}'), 'callback ref');
    assert(
      /this\._ro\.unobserve\(prev\)/.test(src) && /this\._ro\.observe\(el\)/.test(src),
      're-observe'
    );
    assert(src.includes('const liveHeight = this._scrollRef.current'), 'live height');
  });

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
