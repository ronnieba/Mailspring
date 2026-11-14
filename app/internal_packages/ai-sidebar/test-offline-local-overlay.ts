#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t227): Yahoo-style message actions as a LOCAL overlay.
 * Delete / archive / spam / move / star / unread / block / contacts / reset,
 * undo, counts, filters, search visibility, print page. Synthetic messages
 * in temp folders only; the mail copy must never change; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-local-overlay.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  OFFLINE_LOCAL_CHANGES_FILE,
  applyOverlay,
  emptyOverlay,
  localFolderPath,
  localPlaceOf,
  patchMessage,
  sanitizeOverlay,
  readOverlay,
  writeOverlay,
} from './lib/core/offline-local-overlay';
import { offlineMailStore } from './lib/offline-mail/offline-mail-store';
import { offlineAddressBook } from './lib/offline-mail/offline-address-book-store';
import {
  offlineActionsUi,
  actDelete,
  actArchive,
  actSpam,
  actMoveToFolder,
  actRestore,
  actToggleStar,
  actSetUnread,
  actBlockSenders,
  actUnblock,
  actAddContacts,
  actResetLocalChanges,
  actPrint,
  buildPrintDocument,
} from './lib/offline-mail/offline-message-actions';
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
const B = 'Beta Sender <beta@example.test>';
const C = 'Gamma <gamma@example.test>';

function eml(from: string, subject: string, day: number, id: string) {
  return (
    [
      `From: ${from}`,
      `To: ${A}`,
      `Subject: ${subject}`,
      `Date: Mon, ${String(day).padStart(2, '0')} Nov 2026 09:00:00 +0000`,
      `Message-ID: <${id}@x>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ].join('\r\n') + '\r\n\r\nsynthetic body <b>not html</b>\r\n'
  );
}

function hashTree(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) {
        walk(p);
      } else {
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

async function main() {
  console.log('offline local overlay actions (t227)');
  setOfflineLangOverride('he');
  offlineActionsUi.printDryRun = true;

  await test('local folder paths are distinct and recognised', () => {
    const t = localFolderPath('trash');
    assert(localPlaceOf(t) === 'trash', 'trash');
    assert(localPlaceOf(localFolderPath('spam')) === 'spam', 'spam');
    assert(
      localPlaceOf('Trash') === null && localPlaceOf('local:trash') === null,
      'real folders are not local'
    );
  });

  await test('sanitizeOverlay drops junk, patchMessage keeps place/folder exclusive', () => {
    const d = sanitizeOverlay({
      version: 1,
      messages: { a: { star: true }, b: 'x', c: { place: 'bogus' } },
      blocked: [{ email: 'not-an-email' }, { email: 'X@Example.test', name: 'X' }],
      contacts: 'nope',
    });
    assert(d.messages.a && d.messages.a.star, 'kept a');
    assert(!d.messages.b, 'dropped b');
    assert(d.blocked.length === 1 && d.blocked[0].email === 'x@example.test', 'blocked normalised');
    assert(Array.isArray(d.contacts) && d.contacts.length === 0, 'contacts default');
    const e = emptyOverlay();
    patchMessage(e, 'm', { place: 'trash' });
    patchMessage(e, 'm', { folder: 'Inbox' });
    assert(e.messages.m.folder === 'Inbox' && !e.messages.m.place, 'folder replaces place');
    patchMessage(e, 'm', { folder: undefined });
    assert(!e.messages.m, 'empty record removed');
  });

  await test('applyOverlay: relocations and blocked senders', () => {
    const d = emptyOverlay();
    patchMessage(d, '1', { place: 'archive' });
    d.blocked.push({ email: 'beta@example.test', name: '', at: 1 });
    const entries = [
      { id: '1', folder: 'Inbox', from: A },
      { id: '2', folder: 'Inbox', from: B },
      { id: '3', folder: 'Inbox', from: C },
    ];
    const v = applyOverlay(entries, d, { showBlocked: false });
    assert(v.entries.find((e) => e.id === '1')!.folder === localFolderPath('archive'), 'archived');
    assert(v.hidden.has('2') && !v.hidden.has('3'), 'blocked hidden');
    assert(entries[0].folder === 'Inbox', 'input not mutated');
    const v2 = applyOverlay(entries, d, { showBlocked: true });
    assert(v2.hidden.size === 0, 'show blocked');
  });

  await test('overlay file must stay inside the profile', () => {
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-ovl-'));
    const d = emptyOverlay();
    patchMessage(d, 'z', { star: true });
    writeOverlay(prof, d);
    assert(fs.existsSync(path.join(prof, OFFLINE_LOCAL_CHANGES_FILE)), 'written');
    assert(readOverlay(prof).messages.z.star, 'read back');
    assert(readOverlay(null).version === 1, 'null profile → empty');
  });

  // ---- store with a synthetic copy ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-ovl-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-ovl-prof-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  fs.mkdirSync(path.join(root, 'Work', 'Projects'), { recursive: true });
  for (let i = 1; i <= 6; i++) {
    fs.writeFileSync(
      path.join(root, 'Inbox', `i${i}.eml`),
      eml(i % 2 ? B : C, `Note ${i}`, i, `i${i}`)
    );
  }
  fs.writeFileSync(path.join(root, 'Work', 'Projects', 'p1.eml'), eml(B, 'Plan', 7, 'p1'));
  const before = hashTree(root);
  const s = offlineMailStore;
  await s.start(root, path.join(profile, 'offline-mail-index.json'));
  s.setFolder('Inbox');
  const inboxIds = s.visibleMessages().map((e) => e.id);
  const count = (p: string) => (s as any)._byFolder.get(p)?.length || 0;

  await test('store starts with all messages read and nothing relocated', () => {
    assert(inboxIds.length === 6, `inbox ${inboxIds.length}`);
    assert(
      inboxIds.every((id) => !s.isUnread(id) && !s.isStarred(id)),
      'defaults'
    );
    assert(!s.hasRelocations(), 'no relocations');
  });

  await test('delete → local Trash with toast; Undo puts it back', () => {
    const id = inboxIds[0];
    actDelete([id]);
    assert(count('Inbox') === 5, `inbox ${count('Inbox')}`);
    assert(s.localFolderCount('trash') === 1, 'trash 1');
    assert(s.effectiveFolderOf(id) === localFolderPath('trash'), 'effective');
    assert(s.originalFolder(id) === 'Inbox', 'original kept');
    assert(offlineActionsUi.toast && offlineActionsUi.toast.undo, 'toast with undo');
    assert(/אשפה/.test(offlineActionsUi.toast!.text), 'Hebrew toast');
    offlineActionsUi.undoToast();
    assert(count('Inbox') === 6 && s.localFolderCount('trash') === 0, 'undone');
  });

  await test('archive / spam / move to folder / restore', () => {
    actArchive([inboxIds[0]]);
    actSpam([inboxIds[1]]);
    actMoveToFolder('Work/Projects', [inboxIds[2]]);
    assert(
      s.localFolderCount('archive') === 1 && s.localFolderCount('spam') === 1,
      'local folders'
    );
    assert(count('Work/Projects') === 2 && count('Inbox') === 3, 'moved');
    const node = s.findFolder('Work/Projects');
    assert(node && node.count === 2, `tree badge ${node && node.count}`);
    assert(s.isRelocated(inboxIds[2]), 'relocated');
    actMoveToFolder('Inbox', [inboxIds[2]]);
    assert(!s.isRelocated(inboxIds[2]), 'moving back to the original clears the change');
    actRestore([inboxIds[0], inboxIds[1]]);
    assert(count('Inbox') === 6 && !s.hasRelocations(), 'restored');
  });

  await test('multi-select: actions apply to the selected messages in the folder', () => {
    s.setFolder('Inbox');
    s.select(s.visibleRows()[0].key);
    s.select(s.visibleRows()[1].key, { additive: true });
    assert(s.actionIds().length === 2, `selected ${s.actionIds().length}`);
    actArchive();
    assert(s.localFolderCount('archive') === 2 && count('Inbox') === 4, 'two archived');
    offlineActionsUi.undoToast();
    assert(count('Inbox') === 6, 'undo both');
  });

  await test('star / unread flags, list filters, opening marks read', () => {
    s.setFolder('Inbox');
    actToggleStar([inboxIds[3]]);
    actSetUnread(true, [inboxIds[4], inboxIds[5]]);
    assert(s.isStarred(inboxIds[3]) && s.isUnread(inboxIds[4]), 'flags');
    const row = s.visibleRows().find((r) => r.ids.includes(inboxIds[4]))!;
    assert(s.rowFlags(row).unread, 'row unread');
    s.setStarredOnly(true);
    assert(s.visibleMessages().length === 1, `starred only ${s.visibleMessages().length}`);
    s.setStarredOnly(false);
    s.setUnreadOnly(true);
    assert(s.visibleMessages().length === 2, `unread only ${s.visibleMessages().length}`);
    s.setUnreadOnly(false);
    s.select(row.key);
    assert(!s.isUnread(inboxIds[4]), 'opened → read');
    actToggleStar([inboxIds[3]]);
    assert(!s.isStarred(inboxIds[3]), 'unstar');
  });

  await test('block sender hides all their mail (lists, counts, search); unblock brings it back', () => {
    s.setFolder('Inbox');
    const bIds = inboxIds.filter((id) => /beta@/.test(s.getEntry(id)!.from));
    actBlockSenders([bIds[0]]);
    assert(s.isBlocked('beta@example.test'), 'blocked');
    assert(count('Inbox') === 3, `inbox now ${count('Inbox')}`);
    assert(count('Work/Projects') === 0, 'other folders too');
    assert(s.hiddenCount() === 4, `hidden ${s.hiddenCount()}`);
    assert(
      !s.searchShows(bIds[0], false, null) && s.searchShows(bIds[0], true, null),
      'search option'
    );
    assert(s.summary().hiddenByBlock === 4, 'summary hidden count');
    s.setShowBlocked(true);
    assert(count('Inbox') === 6, 'show blocked');
    s.setShowBlocked(false);
    actUnblock('beta@example.test');
    assert(count('Inbox') === 6 && s.hiddenCount() === 0, 'unblocked');
  });

  await test('search hides local Trash/Spam unless "include hidden"', () => {
    actDelete([inboxIds[0]]);
    assert(!s.searchShows(inboxIds[0], false, null), 'trash hidden from search');
    assert(s.searchShows(inboxIds[0], true, null), 'included when asked');
    assert(
      s.searchShows(inboxIds[0], false, [localFolderPath('trash')]),
      'shown when searching the local Trash'
    );
    assert(!s.searchShows(inboxIds[0], false, ['Inbox']), 'not in the original folder');
    actRestore([inboxIds[0]]);
  });

  await test('add sender to contacts → local address book (ranked first)', () => {
    actAddContacts([inboxIds[1]]);
    const email = s.sendersOf([inboxIds[1]])[0].email;
    assert(s.isSavedContact(email), 'saved');
    offlineAddressBook.savedProvider = () => s.overlay.contacts;
    const hits = offlineAddressBook.search(email.slice(0, 3));
    assert(hits.length && hits[0].email.toLowerCase() === email, 'ranked first');
    actAddContacts([inboxIds[1]]);
    assert(/כבר/.test(offlineActionsUi.toast!.text), 'already saved');
  });

  await test('print page: escaped headers, sanitized body, no scripts; dry run never opens a dialog', async () => {
    const doc = buildPrintDocument({
      subject: '<script>x</script>',
      from: B,
      to: A,
      cc: '',
      date: 'd',
      messageId: '',
      text: 'a < b',
      html: null,
      attachments: [],
      notes: [],
    });
    assert(!/<script>x/.test(doc), 'subject escaped');
    assert(/Content-Security-Policy/i.test(doc), 'CSP');
    assert(/a &#60; b/.test(doc), 'text escaped');
    offlineActionsUi.lastPrint = null;
    await actPrint(inboxIds[2]);
    assert(
      offlineActionsUi.lastPrint && offlineActionsUi.lastPrint.hasHeader,
      'dry run built the page'
    );
    assert(!fs.existsSync(path.join(profile, 'offline-print')), 'no print file in dry run');
  });

  await test('changes persist in the profile file only; reset clears everything (with confirm)', async () => {
    actArchive([inboxIds[0]]);
    actToggleStar([inboxIds[1]]);
    actBlockSenders([inboxIds[2]]);
    const file = path.join(profile, OFFLINE_LOCAL_CHANGES_FILE);
    assert(fs.existsSync(file), 'overlay file');
    const saved = readOverlay(profile);
    assert(
      saved.messages[inboxIds[0]].place === 'archive' &&
        saved.messages[inboxIds[1]].star &&
        saved.blocked.length === 1,
      'persisted'
    );
    offlineActionsUi.confirm = () => false;
    assert(actResetLocalChanges() === 0 && s.hasRelocations(), 'cancel keeps changes');
    let asked = '';
    offlineActionsUi.confirm = (t) => {
      asked = t;
      return true;
    };
    assert(actResetLocalChanges() > 0, 'reset');
    assert(/ארכיון: 1/.test(asked) && /שולחים חסומים: 1/.test(asked), 'confirm lists counts');
    assert(!s.hasRelocations() && s.localChangeCounts().total === 0, 'cleared');
    assert(count('Inbox') === 6, 'all back');
    assert(Object.keys(readOverlay(profile).messages).length === 0, 'file cleared');
  });

  await test('the mail copy never changed', () => {
    assert(hashTree(root) === before, 'root hash');
  });

  await test('UI wiring: ribbon actions, reader ⋯ menu, list, sidebar, settings', () => {
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    for (const id of [
      'act-delete',
      'act-archive',
      'act-move',
      'act-spam',
      'act-star',
      'act-unread',
      'act-block',
      'act-contact',
      'act-print',
      'act-restore',
      'blocked-senders',
      'reset-local',
    ]) {
      assert(ribbon.includes(`'${id}'`), `ribbon ${id}`);
    }
    assert(/<OfflineActionsHost \/>/.test(ribbon), 'host mounted');
    const reader = read('lib/offline-mail/offline-message-reader.tsx');
    assert(/showMessageMoreMenu/.test(reader) && /⋯/.test(reader), 'reader ⋯');
    assert(!/אין שליחה\/העברה\/מחיקה/.test(reader), 'old read-only pill text gone');
    const list = read('lib/offline-mail/offline-message-list.tsx');
    assert(
      /data-offline-unread-only/.test(list) && /data-offline-starred-only/.test(list),
      'chips'
    );
    assert(
      /data-offline-row-star/.test(list) && /data-offline-show-blocked/.test(list),
      'row star / blocked'
    );
    const side = read('lib/offline-mail/offline-folder-sidebar.tsx');
    assert(
      /data-offline-local-entry/.test(side) && /data-offline-blocked-entry/.test(side),
      'sidebar'
    );
    const actions = read('lib/offline-mail/offline-message-actions.tsx');
    assert(/javascript: false/.test(actions) && /silent: false/.test(actions), 'print hardened');
    assert(!/imap|yahoo\.com|mailsync|fetch\(/i.test(actions.replace(/Yahoo/g, '')), 'no network');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
