#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t197): conversations (threads) in the offline browser.
 * Synthetic messages in a temp folder only; no network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-threads.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildThreads,
  dedupeCopies,
  isReplyOrForwardSubject,
  normalizeSubject,
  OFFLINE_VIEW_PREFS_FILE,
  participantsKey,
  readThreadedPref,
  writeThreadedPref,
} from './lib/core/offline-threads';
import { parseOfflineMailHeaders } from './lib/core/offline-mail-mime';
import { buildOfflineMailIndex } from './lib/core/offline-mail-index';
import { offlineMailStore } from './lib/offline-mail/offline-mail-store';
import { getOfflineArchiveScope } from './lib/offline-archive-catalog';
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

const A = 'Alpha Person <alpha@example.test>';
const B = 'Beta Person <beta@example.test>';
const C = 'Gamma Person <gamma@example.test>';

function eml(o: {
  from: string;
  to: string;
  subject: string;
  date: string;
  id?: string;
  irt?: string;
  refs?: string;
  body?: string;
}): string {
  const h = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    o.id ? `Message-ID: ${o.id}` : '',
    o.irt ? `In-Reply-To: ${o.irt}` : '',
    o.refs ? `References: ${o.refs}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].filter(Boolean);
  return `${h.join('\r\n')}\r\n\r\n${o.body || 'synthetic body'}\r\n`;
}

const e = (id: string, ts: number, x: any) => ({ id, ts, subject: '', from: '', ...x });

async function main() {
  console.log('offline threads (t197)');
  setOfflineLangOverride('en');

  await test('normalizeSubject strips Re/Fwd/Hebrew prefixes and tags', () => {
    assert(normalizeSubject('Re: RE: Fwd: Plan') === 'plan', 'en');
    assert(normalizeSubject('תשובה: הועבר: תוכנית') === 'תוכנית', 'he');
    assert(normalizeSubject('[list] Re[2]: Plan') === 'plan', 'tag/counter');
    assert(normalizeSubject('Report') === 'report', 'plain');
    assert(isReplyOrForwardSubject('Re: x') && isReplyOrForwardSubject('השב: x'), 'reply');
    assert(!isReplyOrForwardSubject('Regarding x'), 'not a prefix');
  });

  await test('participantsKey is order-free', () => {
    assert(participantsKey({ from: A, to: B }) === participantsKey({ from: B, to: A }), 'same');
    assert(participantsKey({ from: A, to: B }) !== participantsKey({ from: A, to: C }), 'diff');
  });

  await test('headers expose Message-ID / In-Reply-To / References', () => {
    const h = parseOfflineMailHeaders(
      eml({
        from: A,
        to: B,
        subject: 'x',
        date: 'Mon, 2 Nov 2026 10:00:00 +0000',
        id: '<m2@x>',
        irt: '<m1@x>',
        refs: '<m0@x> <m1@x>',
      })
    );
    assert(
      h.msgId === '<m2@x>' && h.inReplyTo === '<m1@x>' && h.refs === '<m0@x> <m1@x>',
      JSON.stringify(h)
    );
  });

  await test('References / In-Reply-To group messages; unrelated stays alone', () => {
    const { threads, threadOf } = buildThreads([
      e('a', 1, { msgId: '<1@x>', subject: 'Plan', from: A, to: B }),
      e('b', 2, { msgId: '<2@x>', inReplyTo: '<1@x>', subject: 'Re: Plan', from: B, to: A }),
      e('c', 3, { msgId: '<3@x>', refs: '<1@x> <2@x>', subject: 'Re: Plan', from: A, to: B }),
      e('d', 4, { msgId: '<4@x>', subject: 'Other', from: C, to: A }),
    ]);
    assert(threads.size === 2, `threads ${threads.size}`);
    const t = threads.get(threadOf.get('c') as string)!;
    assert(t.ids.join() === 'a,b,c' && t.key === 'thread-a' && t.latestTs === 3, JSON.stringify(t));
    assert(threadOf.get('d') === 'thread-d', 'single');
  });

  await test('missing parent still joins through a shared reference', () => {
    const { threadOf } = buildThreads([
      e('x', 1, { msgId: '<b@x>', refs: '<root@x>', subject: 'Re: Q', from: A, to: B }),
      e('y', 2, { msgId: '<c@x>', inReplyTo: '<root@x>', subject: 'Re: Q', from: C, to: A }),
    ]);
    assert(threadOf.get('x') === threadOf.get('y'), 'joined');
  });

  await test('fallback: Re: with same subject + people joins; different people do not', () => {
    const { threadOf } = buildThreads([
      e('o', 1, { subject: 'Budget', from: A, to: B }),
      e('r', 2, { subject: 'RE: Budget', from: B, to: A }),
      e('s', 3, { subject: 'Re: Budget', from: C, to: A }),
      e('p', 4, { subject: 'Budget', from: A, to: B }),
    ]);
    assert(threadOf.get('o') === threadOf.get('r'), 'reply joined');
    assert(threadOf.get('s') !== threadOf.get('o'), 'other people separate');
    assert(threadOf.get('p') !== threadOf.get('o'), 'no prefix -> separate');
  });

  await test('fallback ignores empty and "(No Subject)" subjects', () => {
    const { threadOf } = buildThreads([
      e('n1', 1, { subject: '(No Subject)', from: A, to: B }),
      e('n2', 2, { subject: 'Re: (No Subject)', from: B, to: A }),
      e('n3', 3, { subject: '', from: A, to: B }),
      e('n4', 4, { subject: 'Re:', from: B, to: A }),
    ]);
    assert(new Set(['n1', 'n2', 'n3', 'n4'].map((x) => threadOf.get(x))).size === 4, 'all apart');
  });

  await test('the same message in two folders is one conversation', () => {
    const { threads } = buildThreads([
      e('i', 1, { msgId: '<dup@x>', subject: 'S', from: A, to: B }),
      e('j', 1, { msgId: '<DUP@x>', subject: 'S', from: A, to: B }),
    ]);
    assert(threads.size === 1, 'one');
    const info = (id: string) =>
      (
        ({
          i: { msgId: '<dup@x>', folder: 'A' },
          j: { msgId: '<DUP@x>', folder: 'B' },
          k: { folder: 'B' },
        }) as any
      )[id];
    assert(dedupeCopies(['i', 'j', 'k'], info, 'B').join() === 'j,k', 'prefer folder copy');
    assert(dedupeCopies(['i', 'j', 'k'], info, null).join() === 'i,k', 'first copy');
  });

  await test('view preference is remembered in the profile (default on)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-thr-pref-'));
    assert(readThreadedPref(dir) === true, 'default');
    writeThreadedPref(dir, false);
    assert(readThreadedPref(dir) === false, 'saved');
    assert(fs.existsSync(path.join(dir, OFFLINE_VIEW_PREFS_FILE)), 'file');
    assert(readThreadedPref(null) === true, 'no profile');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- store: synthetic archive + throwaway profile ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-thr-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-thr-prof-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  fs.mkdirSync(path.join(root, 'Sent'));
  const w = (rel: string, body: string) => fs.writeFileSync(path.join(root, rel), body);
  w(
    'Inbox/t1.eml',
    eml({ from: B, to: A, subject: 'Trip', date: 'Mon, 2 Nov 2026 09:00:00 +0000', id: '<t1@x>' })
  );
  w(
    'Sent/t2.eml',
    eml({
      from: A,
      to: B,
      subject: 'Re: Trip',
      date: 'Mon, 2 Nov 2026 10:00:00 +0000',
      id: '<t2@x>',
      irt: '<t1@x>',
      refs: '<t1@x>',
    })
  );
  w(
    'Inbox/t3.eml',
    eml({
      from: B,
      to: A,
      subject: 'Re: Trip',
      date: 'Mon, 2 Nov 2026 11:00:00 +0000',
      id: '<t3@x>',
      irt: '<t2@x>',
      refs: '<t1@x> <t2@x>',
    })
  );
  w(
    'Inbox/f1.eml',
    eml({ from: C, to: A, subject: 'Notes', date: 'Tue, 3 Nov 2026 09:00:00 +0000' })
  );
  w(
    'Inbox/f2.eml',
    eml({ from: C, to: A, subject: 'Re: Notes', date: 'Tue, 3 Nov 2026 12:00:00 +0000' })
  );
  w(
    'Inbox/s1.eml',
    eml({ from: A, to: C, subject: 'Solo', date: 'Wed, 4 Nov 2026 09:00:00 +0000', id: '<s1@x>' })
  );
  const cache = path.join(profile, 'offline-mail-index.json');
  const before = fs
    .readdirSync(path.join(root, 'Inbox'))
    .map((f) => fs.statSync(path.join(root, 'Inbox', f)).mtimeMs)
    .join();

  await test('index stores thread headers and re-reads older caches once', async () => {
    const idx = await buildOfflineMailIndex(root, { cachePath: cache });
    assert(
      idx.entries.every((x) => x.msgId !== undefined),
      'msgId present'
    );
    const old = JSON.parse(fs.readFileSync(cache, 'utf8'));
    for (const x of old.entries) {
      delete x.msgId;
      delete x.inReplyTo;
      delete x.refs;
    }
    fs.writeFileSync(cache, JSON.stringify(old));
    const again = await buildOfflineMailIndex(root, { cachePath: cache });
    assert(again.stats.parsed === 6 && again.stats.reused === 0, JSON.stringify(again.stats));
    const third = await buildOfflineMailIndex(root, { cachePath: cache });
    assert(third.stats.reused === 6, JSON.stringify(third.stats));
  });

  await offlineMailStore.start(root, cache);
  const s = offlineMailStore;
  const inboxRows = () => {
    s.setFolder('Inbox');
    return s.visibleRows();
  };

  await test('threaded list: one row per conversation with counts', () => {
    assert(s.threaded === true, 'default threaded');
    const rows = inboxRows();
    assert(rows.length === 3, `rows ${rows.length}`);
    const trip = rows.find((r) => r.ids.length === 3)!;
    assert(trip && trip.inFolder === 2, 'trip thread spans Sent');
    assert(s.getEntry(trip.entry.id)!.rel.endsWith('t3.eml'), 'row shows newest in folder');
    assert(
      rows.some((r) => r.ids.length === 2),
      'fallback thread'
    );
    assert(rows[0] === trip || rows[0].ids.length === 1, 'sorted by newest');
  });

  await test('selecting a conversation = all its messages for the AI; reader stacks them', async () => {
    const trip = inboxRows().find((r) => r.ids.length === 3)!;
    s.select(trip.key);
    assert(s.selectedIds.length === 3, `ids ${s.selectedIds.length}`);
    const scope = getOfflineArchiveScope('selected-messages');
    assert(
      scope.messageIds!.length === 3 && scope.threadIds!.length === 1,
      JSON.stringify(scope.messageIds)
    );
    assert(/1 conversation/.test(scope.description), scope.description);
    assert(s.openThread && s.openThread.ids.length === 3, 'thread open');
    for (let i = 0; i < 50 && s.openThread!.loading; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const t = s.openThread!;
    assert(Object.keys(t.parsed).length === 3, 'all parsed');
    const newest = t.ids[2];
    assert(t.expanded.size === 1 && t.expanded.has(newest), 'newest expanded only');
    s.toggleThreadMessage(t.ids[0]);
    assert(s.openThread!.expanded.has(t.ids[0]), 'expand one');
    s.setThreadExpandedAll(true);
    assert(s.openThread!.expanded.size === 3, 'expand all');
    s.setThreadExpandedAll(false);
    assert(s.openThread!.expanded.size === 1, 'collapse all');
  });

  await test('multi-select of rows unions messages; select-all covers threads', () => {
    const rows = inboxRows();
    s.select(rows[0].key);
    s.toggleChecked(rows[1].key);
    assert(s.selectedKeys.length === 2, 'two rows');
    assert(s.selectedIds.length === rows[0].ids.length + rows[1].ids.length, 'union');
    assert(s.openThread === null && s.openMessage === null, 'reader multi');
    s.selectAllVisible();
    assert(s.selectedIds.length === 6, `all ${s.selectedIds.length}`);
    s.clearSelection();
    assert(s.selectedIds.length === 0, 'cleared');
  });

  await test('reveal(id) opens its conversation with that message expanded', () => {
    const first = s.threadIdsFor(s.visibleMessages()[0].id);
    const oldest = s.getEntry(
      s.threadIdsFor(inboxRows().find((r) => r.ids.length === 3)!.entry.id)[0]
    )!;
    assert(first.length >= 1, 'ids');
    s.reveal(oldest.id);
    assert(s.openThread && s.openThread.expanded.has(oldest.id), 'focus expanded');
  });

  await test('flat view: one row per message; preference saved', () => {
    s.setThreaded(false);
    assert(inboxRows().length === 5, 'flat inbox');
    assert(readThreadedPref(profile) === false, 'saved off');
    s.select(inboxRows()[0].key);
    assert(s.selectedIds.length === 1 && s.openThread === null, 'single');
    s.setThreaded(true);
    assert(readThreadedPref(profile) === true, 'saved on');
  });

  await test('archive files are not modified', () => {
    const after = fs
      .readdirSync(path.join(root, 'Inbox'))
      .map((f) => fs.statSync(path.join(root, 'Inbox', f)).mtimeMs)
      .join();
    assert(after === before, 'mtimes');
  });

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
