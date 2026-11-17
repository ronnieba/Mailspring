#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t209 bug): only real attachments count.
 * HTML mails (multipart/mixed with just a body, inline cid images, calendar
 * alternatives, S/MIME signatures, delivery reports) must NOT get 📎; real
 * files, inline-disposition files and attached messages must. The same rule
 * drives the index flag (list 📎, conversation 📎, "attachments only" filter,
 * sort, AI metadata) and the attachment cards in the reader. Older index
 * caches are re-checked once. Synthetic messages in a temp folder only.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-attachment-flags.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseOfflineMail, scanOfflineMailAttachments } from './lib/core/offline-mail-mime';
import {
  ATTACH_SCAN_VERSION,
  buildOfflineMailIndex,
  writeIndexCache,
} from './lib/core/offline-mail-index';

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

const HEAD = (ct: string, extra = '') =>
  `From: Synthetic <s@example.test>\r\nTo: Me <me@example.test>\r\nSubject: synthetic\r\nDate: Mon, 02 Nov 2026 09:00:00 +0000\r\nMIME-Version: 1.0\r\n${extra}Content-Type: ${ct}\r\n\r\n`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
).toString('base64');
const html = (body: string) =>
  `Content-Type: text/html; charset=utf-8\r\n\r\n<html><body>${body}</body></html>\r\n`;
const mp = (b: string, parts: string[]) =>
  `${parts.map((p) => `--${b}\r\n${p}`).join('')}--${b}--\r\n`;

const CASES: { [name: string]: { raw: string; want: number } } = {
  'HTML only, sent as multipart/mixed (the reported bug)': {
    raw: HEAD('multipart/mixed; boundary="M"') + mp('M', [html('<p>שלום</p>')]),
    want: 0,
  },
  'HTML + text alternative + calendar part': {
    raw:
      HEAD('multipart/alternative; boundary="A"') +
      mp('A', [
        'Content-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n',
        html('<p>hello</p>'),
        'Content-Type: text/calendar; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      ]),
    want: 0,
  },
  'related: inline cid image shown by the HTML': {
    raw:
      HEAD('multipart/related; boundary="R"') +
      mp('R', [
        html('<img src="cid:logo123@x">'),
        `Content-Type: image/png; name="logo.png"\r\nContent-ID: <logo123@x>\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${PNG}\r\n`,
      ]),
    want: 0,
  },
  'cid image marked "attachment" but shown by the HTML (Outlook style)': {
    raw:
      HEAD('multipart/mixed; boundary="M"') +
      mp('M', [
        'Content-Type: multipart/related; boundary="R"\r\n\r\n' +
          mp('R', [
            html('<img src="cid:sig%40x">'),
            `Content-Type: image/png\r\nContent-ID: <sig@x>\r\nContent-Disposition: attachment; filename="image001.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${PNG}\r\n`,
          ]),
      ]),
    want: 0,
  },
  'cid image the HTML does not show → attachment': {
    raw:
      HEAD('multipart/related; boundary="R"') +
      mp('R', [
        html('<p>no image here</p>'),
        `Content-Type: image/png; name="photo.png"\r\nContent-ID: <photo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n${PNG}\r\n`,
      ]),
    want: 1,
  },
  'S/MIME signed (smime.p7s) → no attachment': {
    raw:
      HEAD('multipart/signed; protocol="application/pkcs7-signature"; boundary="S"') +
      mp('S', [
        'Content-Type: text/plain; charset=utf-8\r\n\r\nsigned text\r\n',
        'Content-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Disposition: attachment; filename="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAAA\r\n',
      ]),
    want: 0,
  },
  'delivery report parts are body, not attachments': {
    raw:
      HEAD('multipart/report; report-type=delivery-status; boundary="D"') +
      mp('D', [
        'Content-Type: text/plain\r\n\r\nDelivery failed\r\n',
        'Content-Type: message/delivery-status\r\n\r\nStatus: 5.0.0\r\n',
        'Content-Type: text/rfc822-headers\r\n\r\nSubject: x\r\n',
      ]),
    want: 0,
  },
  'real PDF attachment': {
    raw:
      HEAD('multipart/mixed; boundary="M"') +
      mp('M', [
        html('<p>see attached</p>'),
        'Content-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n',
      ]),
    want: 1,
  },
  'inline-disposition document with a name (Apple Mail) → attachment': {
    raw:
      HEAD('multipart/mixed; boundary="M"') +
      mp('M', [
        'Content-Type: text/plain\r\n\r\nhi\r\n',
        'Content-Type: application/pdf; name="b.pdf"\r\nContent-Disposition: inline; filename="b.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n',
      ]),
    want: 1,
  },
  'forwarded message (.eml inside) → attachment': {
    raw:
      HEAD('multipart/mixed; boundary="M"') +
      mp('M', [
        'Content-Type: text/plain\r\n\r\nfwd\r\n',
        `Content-Type: message/rfc822\r\n\r\n${HEAD('text/plain')}inner\r\n`,
      ]),
    want: 1,
  },
  'named text file attachment counts, unnamed inline text does not': {
    raw:
      HEAD('multipart/mixed; boundary="M"') +
      mp('M', [
        'Content-Type: text/plain\r\n\r\nbody\r\n',
        'Content-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nfooter\r\n',
        'Content-Type: text/csv; name="t.csv"\r\nContent-Disposition: attachment; filename="t.csv"\r\n\r\na,b\r\n',
      ]),
    want: 1,
  },
};

async function main() {
  console.log('offline attachment flags (t209)');

  for (const [name, c] of Object.entries(CASES)) {
    await test(`${name}: index count ${c.want} == reader cards`, () => {
      const scan = scanOfflineMailAttachments(c.raw);
      const cards = parseOfflineMail(c.raw, { withBytes: true }).attachments;
      assert(scan.count === c.want, `scan ${scan.count} want ${c.want}`);
      assert(cards.length === c.want, `cards ${cards.length} want ${c.want}`);
    });
  }

  await test('the inline cid image still renders inside the HTML', () => {
    const m = parseOfflineMail(CASES['related: inline cid image shown by the HTML'].raw);
    assert(m.html && m.html.includes('data:image/png;base64,'), 'inlined');
  });

  // ---- index: big messages (attachments past the first 64 KB) and old caches ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-att-root-'));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-att-prof-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  const bigHtml = html(`<p>${'שלום עולם '.repeat(12000)}</p><img src="cid:big@x">`);
  const bigImg = Buffer.alloc(200 * 1024, 3)
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const files: { [f: string]: { raw: string; want: boolean } } = {
    'html-mixed.eml': {
      raw: CASES['HTML only, sent as multipart/mixed (the reported bug)'].raw,
      want: false,
    },
    'big-inline.eml': {
      raw:
        HEAD('multipart/mixed; boundary="M"') +
        mp('M', [
          'Content-Type: multipart/related; boundary="R"\r\n\r\n' +
            mp('R', [
              bigHtml,
              `Content-Type: image/png\r\nContent-ID: <big@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n${bigImg}\r\n`,
            ]),
        ]),
      want: false,
    },
    'big-real.eml': {
      raw:
        HEAD('multipart/mixed; boundary="M"') +
        mp('M', [
          html(`<p>${'x'.repeat(100000)}</p>`),
          `Content-Type: application/zip; name="z.zip"\r\nContent-Disposition: attachment; filename="z.zip"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bigImg}\r\n`,
        ]),
      want: true,
    },
    'pdf.eml': { raw: CASES['real PDF attachment'].raw, want: true },
    'signed.eml': { raw: CASES['S/MIME signed (smime.p7s) → no attachment'].raw, want: false },
  };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, 'Inbox', f), c.raw);
  const cache = path.join(prof, 'offline-mail-index.json');

  await test('index: flags from the MIME structure, also past the first 64 KB', async () => {
    const idx = await buildOfflineMailIndex(root, { cachePath: cache });
    for (const e of idx.entries) {
      const want = files[path.basename(e.rel)].want;
      assert(e.hasAttachments === want, `${path.basename(e.rel)} ${e.hasAttachments}`);
      assert(e.attachScan === ATTACH_SCAN_VERSION, 'scan version');
    }
    const real = idx.entries.find((e) => e.rel.endsWith('big-real.eml'))!;
    assert(real.attachCount === 1 && (real.attachBytes || 0) > 150000, 'real attachment size');
  });

  await test('older cache (header guess) is re-checked once, then reused', async () => {
    const idx = JSON.parse(fs.readFileSync(cache, 'utf8'));
    for (const e of idx.entries) {
      delete e.attachScan;
      delete e.attachCount;
      e.hasAttachments = true; // what the old header guess said for multipart/mixed
    }
    writeIndexCache(cache, idx, root);
    const again = await buildOfflineMailIndex(root, { cachePath: cache });
    assert(
      again.stats.rescanned === 5 && again.stats.parsed === 0,
      `stats ${JSON.stringify(again.stats)}`
    );
    assert(again.entries.filter((e) => e.hasAttachments).length === 2, 'fixed flags');
    const third = await buildOfflineMailIndex(root, { cachePath: cache });
    assert(third.stats.reused === 5 && !third.stats.rescanned, 'reused next time');
  });

  await test('store: list 📎, attachments-only filter and AI catalog use the same flag', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { offlineMailStore } = require('./lib/offline-mail/offline-mail-store');
    await offlineMailStore.start(root, cache);
    offlineMailStore.setThreaded(false);
    offlineMailStore.setFolder('Inbox');
    offlineMailStore.setAttachmentsOnly(true);
    const names = offlineMailStore
      .visibleMessages()
      .map((e: any) => path.basename(e.rel))
      .sort()
      .join();
    assert(names === 'big-real.eml,pdf.eml', names);
    offlineMailStore.setAttachmentsOnly(false);
    const src = fs.readFileSync(
      path.join(__dirname, 'lib/offline-mail/offline-mail-store.ts'),
      'utf8'
    );
    assert(
      src.includes('attachmentCount: e.hasAttachments ? e.attachCount || 1 : 0'),
      'AI metadata count'
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(prof, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
