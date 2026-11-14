#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t230): "Attach the original files" in a local reply,
 * and draft attachments in the built-in viewer. Synthetic messages in temp
 * folders only; nothing is sent; the mail copy is only read.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-reply-originals.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { offlineMailStore } from './lib/offline-mail/offline-mail-store';
import { offlineDraftsStore } from './lib/offline-mail/offline-drafts-store';
import {
  attachReplyOriginals,
  replyOriginalsInfo,
} from './lib/offline-mail/offline-reply-originals';
import { draftAttachmentPath } from './lib/core/offline-attachments';
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
  if (!cond) throw new Error(msg);
}
const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const PDF = Buffer.from('%PDF-1.4\n% synthetic\n');
const TXT = Buffer.from('synthetic notes\n');
function emlWithFiles(): string {
  const b = 'BOUNDARY42';
  return [
    'From: Beta Sender <beta@example.test>',
    'To: Alpha <alpha@example.test>',
    'Subject: Files for you',
    'Date: Mon, 02 Nov 2026 09:00:00 +0000',
    'Message-ID: <files1@x>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'see attached',
    `--${b}`,
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    PDF.toString('base64'),
    `--${b}`,
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    TXT.toString('base64'),
    `--${b}--`,
    '',
  ].join('\r\n');
}

async function main() {
  console.log('offline reply: attach the original files; draft files in the viewer (t230)');
  setOfflineLangOverride('he');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-orig-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-orig-prof-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  fs.writeFileSync(path.join(root, 'Inbox', 'f1.eml'), emlWithFiles());
  fs.writeFileSync(
    path.join(root, 'Inbox', 'p1.eml'),
    'From: x@example.test\r\nSubject: plain\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\nMessage-ID: <p1@x>\r\n\r\nno files\r\n'
  );
  const rootBefore = fs.readFileSync(path.join(root, 'Inbox', 'f1.eml'));
  await offlineMailStore.start(root, path.join(profile, 'offline-mail-index.json'));
  offlineDraftsStore.configure({ configDir: profile, now: () => 7000 });
  const s = offlineMailStore;
  s.setFolder('Inbox');
  const withFiles = s.visibleMessages().find((e) => e.subject === 'Files for you')!;
  const plain = s.visibleMessages().find((e) => e.subject === 'plain')!;
  const src = (id: string) => ({
    id,
    subject: 'x',
    from: 'a@example.test',
    to: '',
    cc: '',
    date: '',
    text: 'q',
  });

  await test('reply to a message with files: button info shows 2 missing', () => {
    const d = offlineDraftsStore.createReply(src(withFiles.id));
    const info = replyOriginalsInfo(d)!;
    assert(info.total === 2 && info.missing === 2 && info.tooLarge === 0, JSON.stringify(info));
  });

  await test('attach copies both files into the draft (profile only), byte-identical', () => {
    const d = offlineDraftsStore.drafts.find((x) => x.kind === 'reply')!;
    const r = attachReplyOriginals(d);
    assert(r.added === 2 && r.skipped === 0, JSON.stringify(r));
    const d2 = offlineDraftsStore.drafts.find((x) => x.id === d.id)!;
    assert((d2.attachments || []).length === 2, 'two attachments');
    const pdf = d2.attachments!.find((a) => a.filename === 'report.pdf')!;
    const file = draftAttachmentPath(profile, pdf);
    assert(file.startsWith(profile), 'inside the profile');
    assert(fs.readFileSync(file).equals(PDF), 'same bytes');
    assert(replyOriginalsInfo(d2)!.missing === 0, 'nothing missing now');
    assert(attachReplyOriginals(d2).added === 0, 'second click adds nothing');
  });

  await test('no button for new drafts, forwards, or replies to messages without files', () => {
    assert(replyOriginalsInfo(offlineDraftsStore.createNew()) === null, 'new');
    const fwd = offlineDraftsStore.createForward(src(withFiles.id));
    assert(replyOriginalsInfo(fwd) === null, 'forward');
    const r = offlineDraftsStore.createReply(src(plain.id));
    assert(replyOriginalsInfo(r)!.total === 0, 'no files');
  });

  await test('the mail copy was only read', () => {
    assert(fs.readFileSync(path.join(root, 'Inbox', 'f1.eml')).equals(rootBefore), 'unchanged');
  });

  await test('UI: reply button in the draft and the ribbon; draft files open in the viewer', () => {
    const view = read('lib/offline-mail/offline-drafts-view.tsx');
    assert(
      /data-offline-draft-attach-originals/.test(view) && /צרף את הקבצים המקוריים/.test(view),
      'draft button'
    );
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(/'draft-attach-originals'/.test(ribbon), 'ribbon button');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
