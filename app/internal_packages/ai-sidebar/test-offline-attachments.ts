#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t197): attachments in the reader and in local drafts.
 * Synthetic messages and temp folders only; no network, no real profile,
 * nothing is opened on screen (the opener and dialogs are replaced).
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-attachments.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OFFLINE_ATTACHMENTS_TEMP_DIR,
  OFFLINE_DRAFT_FILES_DIR,
  addDraftAttachmentBytes,
  attachmentKind,
  cleanAttachmentTemp,
  extractAttachmentToProfile,
  isDangerousAttachment,
  isPreviewableImage,
  isProtectedArchivePath,
  safeFileName,
  sanitizeDraftAttachment,
} from './lib/core/offline-attachments';
import { parseOfflineMail } from './lib/core/offline-mail-mime';
import { readDrafts } from './lib/core/offline-drafts';
import { OfflineDraftsStore } from './lib/offline-mail/offline-drafts-store';
import {
  droppedFilePaths,
  saveBytesAs,
  setOfflineFileActions,
  openWithDefaultApp,
} from './lib/offline-mail/offline-file-actions';
import { setOfflineLangOverride } from './lib/core/offline-i18n';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
  }
}
function ok(v: unknown, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}
function eq(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const appRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const tmpDirs: string[] = [];
function tmp(prefix = 'ms-att-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function listAll(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...listAll(p));
  }
  return out;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4 synthetic\n');
const EML = [
  'From: Sender <s@example.test>',
  'To: me@example.test',
  'Subject: =?UTF-8?B?16fXkdem15nXnQ==?=',
  'Message-ID: <att1@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Body text.',
  '--b1',
  'Content-Type: image/png; name="photo.png"',
  'Content-Disposition: attachment; filename="photo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  PNG.toString('base64'),
  '--b1',
  'Content-Type: application/pdf',
  "Content-Disposition: attachment; filename*=UTF-8''%D7%93%D7%95%D7%97.pdf",
  'Content-Transfer-Encoding: base64',
  '',
  PDF.toString('base64'),
  '--b1',
  'Content-Type: application/octet-stream; name="setup.exe"',
  'Content-Disposition: attachment; filename="setup.exe"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('MZ fake').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

(async () => {
  setOfflineLangOverride('he');

  console.log('Category: reading attachments from the local message');
  await test('list has name, size and type; bytes only on request', () => {
    const plain = parseOfflineMail(Buffer.from(EML, 'latin1'));
    eq(plain.attachments.length, 3);
    eq(plain.attachments[1].filename, 'דוח.pdf');
    ok(plain.attachments.every((a) => a.data === undefined));
    const full = parseOfflineMail(Buffer.from(EML, 'latin1'), { withBytes: true });
    ok(full.attachments[0].data?.equals(PNG));
    ok(full.attachments[1].data?.equals(PDF));
    eq(full.attachments[0].size, PNG.length);
  });
  await test('type icons and image previews', () => {
    eq(attachmentKind('photo.png', 'image/png'), 'image');
    eq(attachmentKind('דוח.pdf', 'application/pdf'), 'pdf');
    eq(attachmentKind('a.xlsx', ''), 'sheet');
    eq(attachmentKind('a.docx', ''), 'doc');
    eq(attachmentKind('a.zip', ''), 'archive');
    eq(attachmentKind('setup.exe', 'application/octet-stream'), 'danger');
    ok(isPreviewableImage('photo.png', 'image/png', 100));
    ok(isPreviewableImage('x.JPG', 'application/octet-stream', 100));
    ok(!isPreviewableImage('x.svg', 'image/svg+xml', 100), 'no svg');
    ok(!isPreviewableImage('big.png', 'image/png', 50 * 1024 * 1024), 'size cap');
  });
  await test('dangerous types are flagged (incl. hidden double extensions and macros)', () => {
    for (const n of [
      'a.exe',
      'A.JS',
      'run.bat',
      'x.cmd',
      'x.vbs',
      'x.ps1',
      'x.msi',
      'x.scr',
      'x.lnk',
      'x.hta',
      'x.jar',
      'invoice.pdf.exe',
      'invoice.pdf   .exe',
      'report.docm',
      'x.iso',
    ]) {
      ok(isDangerousAttachment(n), n);
    }
    for (const n of ['a.pdf', 'a.docx', 'a.png', 'a.txt', 'exe', 'a.exe.pdf']) {
      ok(!isDangerousAttachment(n), n);
    }
    ok(isDangerousAttachment('noext', 'application/x-msdownload'));
  });
  await test('file names are made safe for Windows and cannot leave their folder', () => {
    eq(safeFileName('..\\..\\evil.txt'), '.._.._evil.txt');
    eq(safeFileName('a/b:c*?.pdf'), 'a_b_c__.pdf');
    eq(safeFileName('CON.txt'), '_CON.txt');
    eq(safeFileName('name. . '), 'name');
    eq(safeFileName(''), 'attachment');
    eq(safeFileName('x\u202Etxt.exe'), 'x_txt.exe');
    ok(safeFileName('a'.repeat(300) + '.pdf').endsWith('.pdf'));
    ok(safeFileName('a'.repeat(300) + '.pdf').length <= 120);
  });

  console.log('\nCategory: open = copy into the offline profile only');
  await test('extracts into <profile>/offline-attachments-open and nowhere else', () => {
    const profile = tmp();
    const archive = tmp('ms-att-archive-');
    fs.writeFileSync(path.join(archive, 'm.eml'), EML);
    const before = listAll(archive).length;
    const file = extractAttachmentToProfile(
      profile,
      'offline-abc',
      2,
      '..\\..\\setup.exe',
      Buffer.from('x')
    );
    ok(file.startsWith(path.join(profile, OFFLINE_ATTACHMENTS_TEMP_DIR)));
    ok(fs.existsSync(file));
    eq(path.basename(file), '.._.._setup.exe');
    eq(listAll(archive).length, before);
    cleanAttachmentTemp(profile);
    ok(!fs.existsSync(path.join(profile, OFFLINE_ATTACHMENTS_TEMP_DIR)));
  });
  await test('the opener is called with the profile copy (no real app in tests)', async () => {
    const opened: string[] = [];
    setOfflineFileActions({
      opener: async (p) => {
        opened.push(p);
        return '';
      },
    });
    eq(await openWithDefaultApp('C:\\x\\a.pdf'), '');
    eq(opened.length, 1);
    setOfflineFileActions({
      opener: async () => {
        throw new Error('boom');
      },
    });
    eq(await openWithDefaultApp('a'), 'boom');
  });
  await test('Save as writes where the user chose; never inside work or baseline', async () => {
    const snap = tmp('ms-att-snap-');
    const work = path.join(snap, 'work');
    fs.mkdirSync(path.join(snap, 'baseline'), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    ok(isProtectedArchivePath(path.join(work, 'Inbox', 'x.pdf'), work));
    ok(isProtectedArchivePath(path.join(snap, 'baseline', 'x.pdf'), work));
    ok(!isProtectedArchivePath(path.join(snap, 'x.pdf'), work));
    const out = tmp('ms-att-out-');
    setOfflineFileActions({ saveChooser: async () => path.join(out, 'saved.pdf') });
    eq(await saveBytesAs('דוח.pdf', PDF, work), path.join(out, 'saved.pdf'));
    ok(fs.readFileSync(path.join(out, 'saved.pdf')).equals(PDF));
    setOfflineFileActions({ saveChooser: async () => path.join(work, 'bad.pdf') });
    let err = '';
    try {
      await saveBytesAs('x.pdf', PDF, work);
    } catch (e) {
      err = (e as Error).message;
    }
    eq(err, 'protected-archive');
    ok(!fs.existsSync(path.join(work, 'bad.pdf')));
    setOfflineFileActions({ saveChooser: async () => null });
    eq(await saveBytesAs('x.pdf', PDF, work), null);
  });

  console.log('\nCategory: files in local drafts');
  await test('add / remove files; copies live under the profile only', () => {
    const profile = tmp();
    const src = tmp('ms-att-src-');
    fs.writeFileSync(path.join(src, 'notes.txt'), 'synthetic');
    const s = new OfflineDraftsStore();
    s.configure({ configDir: profile });
    const d = s.createNew();
    const res = s.addAttachmentFiles(d.id, [
      path.join(src, 'notes.txt'),
      path.join(src, 'missing.txt'),
    ]);
    eq(res.added, 1);
    eq(res.failed.length, 1);
    const a = s.open!.attachments![0];
    eq(a.filename, 'notes.txt');
    ok(a.file.startsWith(`${OFFLINE_DRAFT_FILES_DIR}/${d.id}/`));
    ok(fs.existsSync(path.join(profile, a.file)));
    eq(readDrafts(profile)[0].attachments!.length, 1);
    s.removeAttachment(d.id, a.id);
    ok(!fs.existsSync(path.join(profile, a.file)));
    eq((s.open!.attachments || []).length, 0);
  });
  await test('deleting a draft removes its files', () => {
    const profile = tmp();
    const s = new OfflineDraftsStore();
    s.configure({ configDir: profile });
    const d = s.createNew();
    const a = addDraftAttachmentBytes(profile, d.id, 'x.bin', '', Buffer.from('1'));
    ok(fs.existsSync(path.join(profile, a.file)));
    s.delete(d.id);
    ok(!fs.existsSync(path.join(profile, OFFLINE_DRAFT_FILES_DIR, d.id)));
  });
  await test('forward carries the original attachments into the draft', () => {
    const profile = tmp();
    const s = new OfflineDraftsStore();
    s.configure({ configDir: profile });
    const parsed = parseOfflineMail(Buffer.from(EML, 'latin1'), { withBytes: true });
    const d = s.createForward(
      {
        id: 'offline-1',
        subject: 'S',
        from: 'a@example.test',
        to: '',
        cc: '',
        date: 'D',
        text: 'x',
      },
      parsed.attachments.map((x) => ({
        filename: x.filename,
        contentType: x.contentType,
        data: x.data as Buffer,
      }))
    );
    eq(d.attachments!.length, 3);
    ok(fs.readFileSync(path.join(profile, d.attachments![0].file)).equals(PNG));
    eq(d.attachments![1].filename, 'דוח.pdf');
    const r = s.createReply({
      id: 'offline-1',
      subject: 'S',
      from: 'a@example.test',
      to: '',
      cc: '',
      date: 'D',
      text: 'x',
    });
    eq((r.attachments || []).length, 0);
  });
  await test('stored attachment paths cannot point outside the draft folder', () => {
    eq(sanitizeDraftAttachment({ id: 'abcd', file: '../../x' }, 'dabc'), null);
    eq(
      sanitizeDraftAttachment({ id: 'abcd', file: `${OFFLINE_DRAFT_FILES_DIR}/other/x` }, 'dabc'),
      null
    );
    eq(
      sanitizeDraftAttachment(
        { id: 'abcd', file: `${OFFLINE_DRAFT_FILES_DIR}/dabc/sub/x` },
        'dabc'
      ),
      null
    );
    ok(
      sanitizeDraftAttachment(
        { id: 'abcd', file: `${OFFLINE_DRAFT_FILES_DIR}/dabc/abcd-x.pdf` },
        'dabc'
      )
    );
  });

  console.log('\nCategory: wiring and safety');
  await test('no network code in the attachment files', () => {
    for (const f of [
      'internal_packages/ai-sidebar/lib/core/offline-attachments.ts',
      'internal_packages/ai-sidebar/lib/offline-mail/offline-file-actions.ts',
      'internal_packages/ai-sidebar/lib/offline-mail/offline-attachments-view.tsx',
    ]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|openExternal|gemini/i.test(src), f);
    }
  });
  await test('reader uses the attachment list with open / save / previews; forward carries files', () => {
    const r = read('internal_packages/ai-sidebar/lib/offline-mail/offline-message-reader.tsx');
    ok(r.includes('<OfflineAttachmentList') && r.includes('extractAttachmentToProfile('));
    ok(r.includes('saveBytesAs(') && r.includes('loadImage='));
    ok(r.includes('createForward(src, forwardFiles(src.id))'));
    const v = read('internal_packages/ai-sidebar/lib/offline-mail/offline-attachments-view.tsx');
    ok(v.includes('isDangerousAttachment(') && v.includes("tr('פתח בכל זאת', 'Open anyway')"));
    const d = read('internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-view.tsx');
    ok(d.includes('chooseFilesToAttach()') && d.includes('onDropCapture'));
  });

  await test('attach is always visible in the draft and drops use real file paths', () => {
    const d = read('internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-view.tsx');
    // Bar with the button renders for every draft (new / reply / forward), not only when files exist.
    ok(
      d.includes('data-offline-draft-attach-main') && d.includes('data-offline-draft-attach="true"')
    );
    ok(!/list\.length\s*\?\s*\(\s*<div className=\{classNames\('offline-draft-attachbar'/.test(d));
    ok(d.includes('droppedFilePaths(files)') && !d.includes('(f as any).path'));
    const fa = read('internal_packages/ai-sidebar/lib/offline-mail/offline-file-actions.ts');
    ok(fa.includes('webUtils.getPathForFile'));
    ok(
      droppedFilePaths([{ path: 'C:\\tmp\\a.txt' } as any, {} as any]).join('|') ===
        'C:\\tmp\\a.txt'
    );
  });

  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
