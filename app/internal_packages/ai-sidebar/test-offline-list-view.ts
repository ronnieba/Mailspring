#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t206 + t207): message list sorting, the
 * "📎 attachments only" chip and compact/expanded density.
 * - sort by date (default newest first) / subject / sender / attachments
 *   (+ size), asc/desc, flat and conversations, Hebrew-aware collation;
 * - sort remembered per folder, density remembered globally, saving them
 *   never loses the "conversations" setting (and vice versa);
 * - expanded rows get a one-line preview without the quoted reply.
 * Synthetic messages in a temp folder only; no network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-list-view.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compareRows,
  previewLine,
  readListPrefs,
  senderName,
  sortRows,
} from './lib/core/offline-list-view';
import { OFFLINE_VIEW_PREFS_FILE, readThreadedPref } from './lib/core/offline-threads';
import { offlineMailStore } from './lib/offline-mail/offline-mail-store';
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function eml(o: {
  from: string;
  subject: string;
  date: string;
  id: string;
  irt?: string;
  attach?: number;
  body?: string;
}) {
  const h = [
    `From: ${o.from}`,
    'To: Me <me@example.test>',
    `Subject: =?UTF-8?B?${Buffer.from(o.subject).toString('base64')}?=`,
    `Date: ${o.date}`,
    `Message-ID: ${o.id}`,
    o.irt ? `In-Reply-To: ${o.irt}` : '',
    o.irt ? `References: ${o.irt}` : '',
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const body = o.body || 'synthetic body';
  if (!o.attach) {
    return `${h.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  }
  const b = 'BOUNDARY42';
  return (
    `${h.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n` +
    `--${b}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="f.bin"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(o.attach, 7).toString('base64')}\r\n--${b}--\r\n`
  );
}

async function main() {
  console.log('offline list sorting + density (t206/t207)');
  setOfflineLangOverride('he');

  await test('Hebrew-aware collation: Hebrew in alphabet order, case-insensitive Latin, natural numbers', () => {
    const rows = ['תמר', 'אבי', 'bob', 'Alice', 'גיל', 'item 10', 'item 9'].map((from, i) => ({
      ts: i,
      subject: '',
      from,
      hasAttachments: false,
      size: 0,
    }));
    const out = sortRows(rows, (r) => r, { key: 'from', dir: 'asc' }).map((r) => r.from);
    const he = out.filter((x) => /[א-ת]/.test(x));
    assert(he.join() === 'אבי,גיל,תמר', `hebrew order ${he.join()}`);
    const lat = out.filter((x) => /[a-z]/i.test(x));
    assert(lat.join() === 'Alice,bob,item 9,item 10', `latin order ${lat.join()}`);
  });

  await test('subject sort ignores Re:/Fwd: prefixes; empty values stay last both ways', () => {
    const mk = (subject: string, ts: number) => ({
      ts,
      subject,
      from: 'x',
      hasAttachments: false,
      size: 0,
    });
    const rows = [mk('Re: בננה', 1), mk('', 2), mk('אגס', 3), mk('Fwd: גזר', 4)];
    const asc = sortRows(rows, (r) => r, { key: 'subject', dir: 'asc' }).map((r) => r.ts);
    assert(asc.join() === '3,1,4,2', `asc ${asc.join()}`);
    const desc = sortRows(rows, (r) => r, { key: 'subject', dir: 'desc' }).map((r) => r.ts);
    assert(desc.join() === '4,1,3,2', `desc ${desc.join()}`);
    assert(senderName('"דנה כהן" <d@example.test>') === 'דנה כהן', 'display name');
    assert(
      compareRows(mk('a', 1), mk('a', 2), { key: 'subject', dir: 'asc' }) > 0,
      'tie → newest first'
    );
  });

  await test('preview line: no quoted reply, collapsed spaces, bounded length', () => {
    const t = 'Hello   there\n\nsecond line\n> quoted old\nOn Mon, X wrote:\n> more';
    assert(previewLine(t) === 'Hello there second line', previewLine(t));
    assert(previewLine('א'.repeat(500)).length <= 161, 'bounded');
  });

  // ---- store over a synthetic folder ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-lv-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-lv-prof-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  fs.mkdirSync(path.join(root, 'Other'));
  const w = (rel: string, body: string) => fs.writeFileSync(path.join(root, rel), body);
  const d = (day: number) => `Mon, ${String(day).padStart(2, '0')} Nov 2026 09:00:00 +0000`;
  w('Inbox/1.eml', eml({ from: 'תמר <t@example.test>', subject: 'שלום', date: d(1), id: '<1@x>' }));
  w(
    'Inbox/2.eml',
    eml({ from: 'Bob <b@example.test>', subject: 'Apple', date: d(5), id: '<2@x>', attach: 9000 })
  );
  w(
    'Inbox/3.eml',
    eml({ from: 'אבי <a@example.test>', subject: 'בדיקה', date: d(3), id: '<3@x>', attach: 300 })
  );
  w(
    'Inbox/4.eml',
    eml({
      from: 'alice <c@example.test>',
      subject: 'zebra',
      date: d(2),
      id: '<4@x>',
      body: 'First line here\n> quoted',
    })
  );
  // A conversation: started by גיל on day 4, reply from Bob on day 9.
  w('Inbox/5.eml', eml({ from: 'גיל <g@example.test>', subject: 'אגם', date: d(4), id: '<5@x>' }));
  w(
    'Inbox/6.eml',
    eml({ from: 'Bob <b@example.test>', subject: 'Re: אגם', date: d(9), id: '<6@x>', irt: '<5@x>' })
  );
  w(
    'Other/7.eml',
    eml({ from: 'Zed <z@example.test>', subject: 'other', date: d(7), id: '<7@x>' })
  );

  const cache = path.join(profile, 'offline-mail-index.json');
  const s = offlineMailStore;
  await s.start(root, cache);
  const ids = () =>
    s
      .visibleRows()
      .map((r) => path.basename(r.entry.rel, '.eml'))
      .join();

  await test('flat: default date newest first; subject / sender / attachments both ways', () => {
    s.setThreaded(false);
    s.setFolder('Inbox');
    assert(s.sort.key === 'date' && s.sort.dir === 'desc', 'default');
    assert(ids() === '6,2,5,3,4,1', `date desc ${ids()}`);
    s.toggleSortDir();
    assert(ids() === '1,4,3,5,2,6', `date asc ${ids()}`);
    s.setSortKey('subject');
    assert(s.sort.dir === 'asc', 'subject defaults to A→Z');
    // Latin then Hebrew (he,en collator puts Latin first for "en"? check by membership).
    const subj = ids();
    assert(
      subj.indexOf('5') < subj.indexOf('3') && subj.indexOf('3') < subj.indexOf('1'),
      `hebrew subjects ${subj}`
    );
    assert(subj.indexOf('2') < subj.indexOf('4'), `latin subjects ${subj}`);
    s.setSortKey('from');
    const fr = ids();
    assert(
      fr.indexOf('3') < fr.indexOf('5') && fr.indexOf('5') < fr.indexOf('1'),
      `hebrew senders ${fr}`
    );
    s.setSortKey('attachments');
    assert(s.sort.dir === 'desc', 'attachments: with (large) first');
    assert(ids().startsWith('2,3'), `attachments desc ${ids()}`);
    s.setSortKey('attachments');
    assert(ids().endsWith('3,2'), `attachments asc ${ids()}`);
  });

  await test('conversations: sorted by latest message, subject and first sender', () => {
    s.setThreaded(true);
    s.setFolder('Inbox');
    s.setSortKey('date');
    if (s.sort.dir !== 'desc') s.toggleSortDir();
    const rows = s.visibleRows();
    assert(rows.length === 5, `rows ${rows.length}`);
    assert(rows[0].ids.length === 2, 'conversation with the day-9 reply first');
    s.setSortKey('from');
    const fr = s.visibleRows();
    const pos = fr.findIndex((r) => r.ids.length === 2);
    const hebrewRows = fr.filter((r) => /[א-ת]/.test(senderName(s.getEntry(r.ids[0])!.from)));
    assert(
      hebrewRows[1] === fr[pos],
      'conversation sorted by its first sender (גיל) between אבי and תמר'
    );
  });

  await test('"📎 attachments only" chip filters rows and the header count', () => {
    s.setThreaded(false);
    s.setAttachmentsOnly(true);
    assert(
      s.visibleRows().length === 2 && s.visibleMessages().length === 2,
      'two with attachments'
    );
    s.setAttachmentsOnly(false);
    assert(s.visibleRows().length === 6, 'all back');
  });

  await test('sort remembered per folder; default folders not stored', () => {
    s.setFolder('Inbox');
    s.setSortKey('subject');
    s.setFolder('Other');
    assert(s.sort.key === 'date' && s.sort.dir === 'desc', 'other folder default');
    s.setFolder('Inbox');
    assert(s.sort.key === 'subject', 'inbox kept subject');
    const prefs = readListPrefs(profile);
    assert(prefs.sortByFolder.Inbox?.key === 'subject', 'saved');
    assert(!prefs.sortByFolder.Other, 'default not saved');
  });

  await test('density remembered globally; saving does not lose "conversations" (and back)', () => {
    s.setThreaded(false);
    s.setDensity('compact');
    assert(readListPrefs(profile).density === 'compact', 'density saved');
    assert(readThreadedPref(profile) === false, 'threaded kept');
    s.setThreaded(true);
    const raw = JSON.parse(fs.readFileSync(path.join(profile, OFFLINE_VIEW_PREFS_FILE), 'utf8'));
    assert(
      raw.threaded === true && raw.density === 'compact' && raw.sortByFolder.Inbox,
      'all kept'
    );
    s.setDensity('expanded');
  });

  await test('expanded preview loads lazily from the local copy', async () => {
    s.setFolder('Inbox');
    const e4 = s.visibleMessages().find((e) => e.rel.endsWith('4.eml'))!;
    assert(s.previewFor(e4.id) === null, 'not loaded yet');
    for (let i = 0; i < 50 && s.previewFor(e4.id) === null; i++) await sleep(20);
    assert(s.previewFor(e4.id) === 'First line here', `preview "${s.previewFor(e4.id)}"`);
  });

  await test('UI: list header tools + compact/expanded rows; ribbon View tab has sort + density', () => {
    const list = read('lib/offline-mail/offline-message-list.tsx');
    for (const k of [
      'data-offline-sort-key',
      'data-offline-sort-dir',
      'data-offline-attach-only',
      'data-offline-density-btn="compact"',
      'data-offline-density-btn="expanded"',
      "tr('📎 רק עם צרופות'",
      'data-offline-preview',
    ]) {
      assert(list.includes(k), k);
    }
    const rib = read('lib/offline-mail/offline-ribbon.tsx');
    for (const k of [
      "id: 'density-compact'",
      "id: 'density-expanded'",
      "id: 'sort'",
      "id: 'sort-dir'",
      "id: 'attach-only'",
      "tr('מצומצם', 'Compact')",
      "tr('מורחב', 'Expanded')",
    ]) {
      assert(rib.includes(k), k);
    }
    const less = read('styles/offline-mail.less');
    assert(less.includes('.density-compact') && less.includes('.offline-row-preview'), 'styles');
  });

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
