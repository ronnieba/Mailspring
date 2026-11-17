#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t234): save a message / a conversation as PDF or .eml
 * to a file the user picks. Synthetic messages in temp folders; the save
 * dialog and the PDF engine are replaced by hooks; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-export.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
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
const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

function eml(subject: string, day: number, id: string, reply?: string) {
  return (
    [
      'From: Beta Sender <beta@example.test>',
      'To: Alpha <alpha@example.test>',
      `Subject: ${subject}`,
      `Date: Mon, ${String(day).padStart(2, '0')} Nov 2026 09:00:00 +0000`,
      `Message-ID: <${id}@x>`,
      ...(reply ? [`In-Reply-To: <${reply}@x>`, `References: <${reply}@x>`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ].join('\r\n') + `\r\n\r\nsynthetic body ${id}\r\n`
  );
}

function hashTree(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

async function main() {
  console.log('offline export (t234)');
  setOfflineLangOverride('he');
  const ex = require('./lib/offline-mail/offline-export');
  const { offlineMailStore: s } = require('./lib/offline-mail/offline-mail-store');
  const { offlineActionsUi } = require('./lib/offline-mail/offline-message-actions');

  await test('file names from subjects are safe', () => {
    assert(
      ex.safeFileName('Re: a/b\\c:d*e?"f"<g>|h') === 'Re a b c d e f g h',
      ex.safeFileName('Re: a/b\\c:d*e?"f"<g>|h')
    );
    assert(
      ex.safeFileName('  ') === 'message' && ex.safeFileName('con') === 'con_',
      'fallback + reserved'
    );
    assert(ex.safeFileName('x'.repeat(200)).length === 80, 'length');
    assert(ex.safeFileName('דוח שנתי.') === 'דוח שנתי', 'Hebrew, no trailing dot');
  });

  await test('a conversation .eml is a MIME digest with the original messages unchanged', () => {
    const a = Buffer.from(eml('One', 1, 'a'));
    const b = Buffer.from(eml('Two', 2, 'b', 'a'));
    const d = ex.buildDigestEml([a, b], 'שיחה לדוגמה').toString('latin1');
    const m = /boundary="([^"]+)"/.exec(d)!;
    assert(/Content-Type: multipart\/digest/.test(d) && m, 'digest');
    assert(
      d.includes(`=?UTF-8?B?${Buffer.from('שיחה לדוגמה').toString('base64')}?=`),
      'encoded subject'
    );
    const parts = d.split(`--${m[1]}`);
    assert(parts.length === 4 && parts[3].startsWith('--'), `parts ${parts.length}`);
    assert(
      parts[1].includes('message/rfc822') && parts[1].includes(a.toString('latin1')),
      'first original'
    );
    assert(parts[2].includes(b.toString('latin1')), 'second original');
  });

  await test('never inside the mail copy', () => {
    const root = path.join(os.tmpdir(), 'copy');
    assert(ex.isInsideMailCopy(path.join(root, 'Inbox', 'x.pdf'), root), 'inside');
    assert(ex.isInsideMailCopy(root, root), 'root itself');
    assert(!ex.isInsideMailCopy(path.join(os.tmpdir(), 'copy2', 'x.pdf'), root), 'sibling');
  });

  // ---- store with a synthetic copy ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-exp-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-exp-prof-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-exp-out-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  fs.writeFileSync(path.join(root, 'Inbox', 'a.eml'), eml('Plan: Q4 / budget', 1, 'a'));
  fs.writeFileSync(path.join(root, 'Inbox', 'b.eml'), eml('Re: Plan: Q4 / budget', 2, 'b', 'a'));
  fs.writeFileSync(path.join(root, 'Inbox', 'c.eml'), eml('Other', 3, 'c'));
  await s.start(root, path.join(profile, 'offline-mail-index.json'));
  const before = hashTree(root);
  const idOf = (f: string) => s.index.entries.find((e: any) => e.rel.endsWith(f)).id;
  let asked: { def: string; format: string } | null = null;
  let html = '';
  ex.offlineExportHooks.choosePath = async (def: string, format: string) => {
    asked = { def, format };
    return path.join(out, path.basename(def));
  };
  ex.offlineExportHooks.renderPdf = async (h: string) => {
    html = h;
    return Buffer.from('%PDF-1.4 synthetic');
  };

  await test('one message as .eml = the original bytes, to the picked file', async () => {
    const res = await ex.exportMessages(idOf('b.eml'), 'message', 'eml');
    assert(asked!.format === 'eml' && /Re Plan Q4 budget\.eml$/.test(asked!.def), asked!.def);
    assert(
      res.messages === 1 &&
        fs.readFileSync(res.file).equals(fs.readFileSync(path.join(root, 'Inbox', 'b.eml'))),
      'identical'
    );
    assert(!fs.existsSync(`${res.file}.part`), 'no temp left');
    assert(offlineActionsUi.toast && /נשמר/.test(offlineActionsUi.toast.text), 'toast');
  });

  await test('the whole conversation as .eml (oldest first) and as PDF', async () => {
    assert(ex.exportIds(idOf('b.eml'), 'conversation').length === 2, 'thread of 2');
    const e = await ex.exportMessages(idOf('b.eml'), 'conversation', 'eml');
    const txt = fs.readFileSync(e.file, 'latin1');
    assert(/\(שיחה\)\.eml$/.test(e.file) || / \(\S+\)\.eml$/.test(e.file), e.file);
    assert(
      e.messages === 2 && txt.indexOf('synthetic body a') < txt.indexOf('synthetic body b'),
      'order'
    );
    const p = await ex.exportMessages(idOf('b.eml'), 'conversation', 'pdf');
    assert(
      p.format === 'pdf' && fs.readFileSync(p.file, 'latin1').startsWith('%PDF'),
      'pdf written'
    );
    assert(
      (html.match(/page-break-before:always/g) || []).length === 1 &&
        html.includes('Content-Security-Policy'),
      'two pages, sanitized page'
    );
    assert(html.includes('synthetic body a') && html.includes('synthetic body b'), 'both bodies');
  });

  await test('cancel saves nothing; a path inside the mail copy is refused', async () => {
    const n0 = fs.readdirSync(out).length;
    ex.offlineExportHooks.choosePath = async () => null;
    assert((await ex.exportMessages(idOf('c.eml'), 'message', 'pdf')) === null, 'cancel');
    ex.offlineExportHooks.choosePath = async () => path.join(root, 'Inbox', 'copy.eml');
    assert((await ex.exportMessages(idOf('c.eml'), 'message', 'eml')) === null, 'refused');
    assert(
      !fs.existsSync(path.join(root, 'Inbox', 'copy.eml')) && fs.readdirSync(out).length === n0,
      'nothing written'
    );
    assert(/עותק הדואר/.test(offlineActionsUi.toast.text), 'explained');
  });

  await test('"Save as" window: defaults and choices', () => {
    s.setFolder('Inbox');
    ex.openExport(idOf('c.eml'));
    assert(
      ex.offlineExportUi.target.what === 'message' && ex.offlineExportUi.target.format === 'pdf',
      'defaults'
    );
    ex.offlineExportUi.target = null;
  });

  await test('entry points: ribbon "Save as", ⋯ menu; no network code', () => {
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(
      /id: 'act-export'[\s\S]{0,500}openExport\(ids\[0\]\)/.test(ribbon) &&
        ribbon.includes('<OfflineExportDialog />'),
      'ribbon'
    );
    assert(
      read('lib/offline-mail/offline-message-actions.tsx').includes(
        "require('./offline-export').openExport(ids[0])"
      ),
      'menu'
    );
    const src = read('lib/offline-mail/offline-export.tsx');
    assert(
      !/\b(fetch|XMLHttpRequest|WebSocket|require\(['"](https?|net|tls)['"]\)|gemini)\b/i.test(src),
      'no network'
    );
    assert(
      /cancel: !String\(details\.url\)\.startsWith\('file:'\)/.test(src) &&
        src.includes('javascript: false'),
      'PDF window blocks network + scripts'
    );
  });

  await test('the mail copy never changed', () => {
    assert(hashTree(root) === before, 'unchanged');
  });

  for (const d of [root, profile, out]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
