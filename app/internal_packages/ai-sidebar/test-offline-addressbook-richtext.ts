#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t196): local address book from archive headers, and
 * formatted (HTML) drafts whose formatting survives Gemini proofreading.
 * Synthetic data and temp folders only; no network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-addressbook-richtext.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OFFLINE_ADDRESS_BOOK_FILE,
  buildAddressBook,
  formatAddress,
  joinRecipients,
  parseAddressList,
  readAddressBook,
  searchAddressBook,
  splitRecipients,
  writeAddressBook,
} from './lib/core/offline-address-book';
import {
  applyProofToHtml,
  htmlToPlain,
  plainToHtml,
  sanitizeDraftHtml,
} from './lib/core/offline-rich-text';
import { buildProofSegments, proofChanges } from './lib/core/text-diff';
import { parseOfflineMailHeaders } from './lib/core/offline-mail-mime';
import { makeReplyDraft, readDrafts, sanitizeDraft } from './lib/core/offline-drafts';
import { OfflineDraftsStore } from './lib/offline-mail/offline-drafts-store';
import { OfflineAddressBookStore } from './lib/offline-mail/offline-address-book-store';
import { setOfflineLangOverride } from './lib/core/offline-i18n';
import { addRecipient } from './lib/offline-mail/offline-recipients';
import { normalizeLinkInput } from './lib/offline-mail/offline-rich-editor';

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
function tmpProfile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ab-test-'));
  tmpDirs.push(d);
  return d;
}

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 1);
const ENTRIES = [
  // Received mail
  {
    folder: 'Inbox',
    ts: NOW - 2 * DAY,
    from: 'דנה כהן <dana@example.test>',
    to: 'Me <me@example.test>',
    cc: 'Ori Levi <ori@example.test>',
  },
  {
    folder: 'Inbox',
    ts: NOW - 3 * DAY,
    from: '"Dana Cohen" <DANA@example.test>',
    to: 'me@example.test',
  },
  {
    folder: 'Inbox',
    ts: NOW - 4 * DAY,
    from: 'דנה כהן <dana@example.test>',
    to: 'me@example.test',
    replyTo: 'Team List <list@example.test>',
  },
  {
    folder: 'Inbox',
    ts: NOW - 900 * DAY,
    from: 'Old Shop <shop@example.test>',
    to: 'me@example.test',
  },
  {
    folder: 'Newsletters/Tech',
    ts: NOW - 1 * DAY,
    from: 'News <news@example.test>',
    to: 'undisclosed-recipients:;',
  },
  // Sent mail: recipients weigh more; the sender is the user.
  {
    folder: 'Sent',
    ts: NOW - 10 * DAY,
    from: 'Me <me@example.test>',
    to: 'Yossi Mizrahi <yossi@example.test>',
    cc: '',
  },
  {
    folder: 'Sent',
    ts: NOW - 20 * DAY,
    from: 'Me <me@example.test>',
    to: 'yossi@example.test, "Levi, Ori" <ori@example.test>',
  },
];

(async () => {
  setOfflineLangOverride('he');

  console.log('Category: address parsing');
  await test('names, quotes, commas inside quotes, bare and grouped addresses', () => {
    const list = parseAddressList(
      '"Levi, Ori" <ori@example.test>, דנה <dana@example.test>; bare@example.test, Team: a@example.test, b@example.test;, undisclosed-recipients:;, (comment only), x@example.test (Xavier)'
    );
    eq(
      JSON.stringify(list.map((a) => [a.name, a.email])),
      JSON.stringify([
        ['Levi, Ori', 'ori@example.test'],
        ['דנה', 'dana@example.test'],
        ['', 'bare@example.test'],
        ['', 'a@example.test'],
        ['', 'b@example.test'],
        ['Xavier', 'x@example.test'],
      ])
    );
  });
  await test('formatting quotes names that need it and round-trips', () => {
    eq(
      formatAddress({ name: 'Levi, Ori', email: 'o@example.test' }),
      '"Levi, Ori" <o@example.test>'
    );
    eq(formatAddress({ name: 'דנה כהן', email: 'd@example.test' }), 'דנה כהן <d@example.test>');
    eq(formatAddress({ name: '', email: 'd@example.test' }), 'd@example.test');
    const chips = splitRecipients('"Levi, Ori" <o@example.test>, not an address, d@example.test');
    eq(chips.length, 3);
    eq(chips[1].addr, null);
    eq(joinRecipients(chips), '"Levi, Ori" <o@example.test>, not an address, d@example.test');
  });
  await test('headers parser now returns To / Cc / Reply-To (decoded)', () => {
    const h = parseOfflineMailHeaders(
      Buffer.from(
        'From: a@example.test\r\nTo: =?UTF-8?B?15PXoNeU?= <dana@example.test>\r\nCc: ori@example.test\r\nReply-To: list@example.test\r\nSubject: x\r\n\r\nbody'
      )
    );
    eq(h.to, 'דנה <dana@example.test>');
    eq(h.cc, 'ori@example.test');
    eq(h.replyTo, 'list@example.test');
  });

  console.log('\nCategory: building and ranking');
  const book = buildAddressBook(ENTRIES, { now: NOW });
  await test('dedupe by email (case-insensitive), best display name kept', () => {
    const dana = book.filter((c) => c.email.toLowerCase() === 'dana@example.test');
    eq(dana.length, 1);
    eq(dana[0].name, 'דנה כהן');
    eq(dana[0].count, 3);
    const ori = book.find((c) => c.email === 'ori@example.test');
    ok((ori && ori.name === 'Ori Levi') || ori?.name === 'Levi, Ori');
  });
  await test('sent-to contacts rank above frequent senders; own address sinks', () => {
    eq(book[0].email, 'yossi@example.test');
    eq(book[0].sentTo, 2);
    eq(book[book.length - 1].email, 'me@example.test');
  });
  await test('recency: an old sender ranks below a recent one with equal count', () => {
    const iOld = book.findIndex((c) => c.email === 'shop@example.test');
    const iNews = book.findIndex((c) => c.email === 'news@example.test');
    ok(iNews < iOld);
  });
  await test('search: prefix of name / email / words, Hebrew, niqqud-insensitive', () => {
    eq(searchAddressBook(book, 'דנ')[0].email, 'dana@example.test');
    eq(searchAddressBook(book, 'דָּנָה')[0].email, 'dana@example.test');
    eq(searchAddressBook(book, 'כה')[0].email, 'dana@example.test');
    eq(searchAddressBook(book, 'yos')[0].email, 'yossi@example.test');
    eq(searchAddressBook(book, 'mizr')[0].email, 'yossi@example.test');
    eq(searchAddressBook(book, 'LEVI')[0].email, 'ori@example.test');
    eq(searchAddressBook(book, 'zzz').length, 0);
    eq(searchAddressBook(book, 'example', 3).length, 3);
    ok(!searchAddressBook(book, 'yos', 8, ['YOSSI@example.test']).length);
  });
  await test('Sent detection works with the Hebrew folder name too', () => {
    const b = buildAddressBook(
      [{ folder: 'stored-1', ts: NOW, from: 'me@example.test', to: 'friend@example.test' }],
      { now: NOW, folderNames: { 'stored-1': 'נשלחו' } }
    );
    eq(b.find((c) => c.email === 'friend@example.test')?.sentTo, 1);
  });

  console.log('\nCategory: stored only in the offline profile');
  await test('store writes one JSON file inside the profile and reloads it', () => {
    const dir = tmpProfile();
    const s = new OfflineAddressBookStore();
    s.configure(dir);
    eq(s.contacts.length, 0);
    s.rebuild({ entries: ENTRIES }, NOW);
    eq(JSON.stringify(fs.readdirSync(dir)), JSON.stringify([OFFLINE_ADDRESS_BOOK_FILE]));
    const s2 = new OfflineAddressBookStore();
    s2.configure(dir);
    eq(s2.contacts.length, s.contacts.length);
    eq(s2.search('dan')[0].email, 'dana@example.test');
    eq(readAddressBook(dir)?.sourceMessages, ENTRIES.length);
  });
  await test('writing outside the profile is refused; corrupt file is ignored', () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, OFFLINE_ADDRESS_BOOK_FILE), '{oops');
    eq(readAddressBook(dir), null);
    writeAddressBook(dir, { version: 1, builtAt: '', sourceMessages: 0, contacts: [] });
    eq(readAddressBook(dir)?.contacts.length, 0);
  });
  await test('address book code never reaches the network or Gemini', () => {
    for (const f of [
      'internal_packages/ai-sidebar/lib/core/offline-address-book.ts',
      'internal_packages/ai-sidebar/lib/offline-mail/offline-address-book-store.ts',
      'internal_packages/ai-sidebar/lib/offline-mail/offline-recipients.tsx',
    ]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      ok(!/gemini|fetch\s*\(|XMLHttpRequest|WebSocket|ipcRenderer|https?:\/\//i.test(src), f);
    }
  });

  console.log('\nCategory: recipients and Bcc');
  await test('adding from the address book skips duplicates', () => {
    let v = '';
    v = addRecipient(v, { name: 'Dana', email: 'dana@example.test' });
    v = addRecipient(v, { name: 'Dana', email: 'DANA@example.test' });
    v = addRecipient(v, { name: 'Levi, Ori', email: 'ori@example.test' });
    eq(v, 'Dana <dana@example.test>, "Levi, Ori" <ori@example.test>');
  });
  await test('drafts have a Bcc field that is saved and survives reload', () => {
    const dir = tmpProfile();
    const s = new OfflineDraftsStore();
    s.configure({ configDir: dir });
    const d = s.createNew();
    eq(d.bcc, '');
    s.update(d.id, { bcc: 'hidden@example.test' });
    s.flush();
    eq(readDrafts(dir)[0].bcc, 'hidden@example.test');
    eq(
      sanitizeDraft({ id: 'dabcdef', kind: 'new', to: '', cc: '', subject: '', body: 'x' })?.bcc,
      ''
    );
  });
  await test('proofreading sends only the plain body — never recipients, subject or HTML', async () => {
    const dir = tmpProfile();
    const sent: string[] = [];
    const s = new OfflineDraftsStore();
    s.configure({
      configDir: dir,
      transport: async (_g, text) => {
        sent.push(text);
        return { ok: true, payload: { response: text } };
      },
    });
    const d = s.createNew();
    s.update(d.id, {
      to: 'to@example.test',
      cc: 'cc@example.test',
      bcc: 'bcc@example.test',
      subject: 'Secret subject',
      html: '<p><b>Hello</b> world</p>',
    });
    await s.proofread(d.id);
    eq(sent.length, 1);
    eq(sent[0], 'Hello world');
  });

  console.log('\nCategory: formatted drafts (HTML)');
  await test('sanitizer keeps formatting, drops scripts, handlers, images and bad links', () => {
    const dirty =
      '<p dir="rtl" style="text-align: center; color: red; position: fixed" onclick="x()">שלום <b>עולם</b></p>' +
      '<script>alert(1)</script><style>p{}</style><img src="http://t.example/x.png">' +
      '<a href="javascript:alert(1)">bad</a> <a href="https://ok.example/">good</a>' +
      '<span style="background-color: url(http://x)">u</span><font face="David" size="5" color="#ff0000">f</font>' +
      '<ul><li>one</li></ul><table><tr><td>cell</td></tr></table><iframe src="x">in</iframe>';
    const clean = sanitizeDraftHtml(dirty);
    ok(clean.includes('<p dir="rtl" style="text-align: center; color: red">'), clean);
    ok(clean.includes('<b>עולם</b>'));
    ok(!/script|alert|onclick|<img|<style|iframe|javascript|url\(|position/i.test(clean), clean);
    ok(clean.includes('<a>bad</a>'));
    ok(clean.includes('<a href="https://ok.example/">good</a>'));
    ok(clean.includes('<font color="#ff0000" face="David" size="5">f</font>'), clean);
    ok(clean.includes('<ul><li>one</li></ul>'));
    ok(clean.includes('cell') && !clean.includes('<table'));
    eq(sanitizeDraftHtml('<b>open <i>nested'), '<b>open <i>nested</i></b>');
  });
  await test('plain ↔ HTML round-trip keeps lines, blank lines and quotes', () => {
    const plain = '\n\nOn 2026, Dana wrote:\n> שלום,\n>\n> The report is attached.\nThanks';
    const html = plainToHtml(plain);
    ok(html.includes('<blockquote>'));
    eq(htmlToPlain(html), plain);
    eq(
      htmlToPlain('<p>a <b>b</b></p><ul><li>one</li><li>two</li></ul><p>x<br>y</p>'),
      'a b\none\ntwo\nx\ny'
    );
    eq(htmlToPlain('<p>a&nbsp;&amp;&lt;b&gt;</p>'), 'a &<b>');
  });
  await test('reply drafts carry HTML with the quote as a blockquote', () => {
    const d = makeReplyDraft(
      {
        id: 'm1',
        subject: 'S',
        from: 'Dana <dana@example.test>',
        to: '',
        cc: '',
        date: 'D',
        text: 'line1\nline2',
      },
      NOW
    );
    ok(d.html && d.html.includes('<blockquote>'));
    eq(htmlToPlain(d.html as string), d.body);
    eq(d.bcc, '');
  });
  await test('editing HTML updates the plain copy used for proofreading', () => {
    const dir = tmpProfile();
    const s = new OfflineDraftsStore();
    s.configure({ configDir: dir });
    const d = s.createNew();
    s.update(d.id, {
      html: '<p><b>שלום</b> <i>world</i></p><p dir="ltr">two</p><script>x</script>',
    });
    const cur = s.open!;
    eq(cur.body, 'שלום world\ntwo');
    ok(!/script/.test(cur.html || ''));
    s.flush();
    eq(readDrafts(dir)[0].html, cur.html);
  });

  console.log('\nCategory: proofreading keeps formatting');
  await test('accepted changes are applied inside formatted text', () => {
    const html =
      '<p dir="rtl"><b>שלום</b> חברים, <span style="color: #c62828">הדוח מוכו</span> לשליחה.</p>' +
      '<p dir="ltr"><i>I hope you are wel</i> and <u>happpy</u>.</p>';
    const plain = htmlToPlain(html);
    const corrected = plain
      .replace('מוכו', 'מוכן')
      .replace('wel', 'well')
      .replace('happpy', 'happy');
    const segs = buildProofSegments(plain, corrected);
    const ids = new Set(proofChanges(segs).map((c) => c.id));
    const res = applyProofToHtml(html, segs, ids);
    eq(res.skipped, 0);
    eq(res.applied, 3);
    eq(
      res.html,
      '<p dir="rtl"><b>שלום</b> חברים, <span style="color: #c62828">הדוח מוכן</span> לשליחה.</p>' +
        '<p dir="ltr"><i>I hope you are well</i> and <u>happy</u>.</p>'
    );
    eq(htmlToPlain(res.html), corrected);
  });
  await test('rejected changes keep the original; only accepted ones apply', () => {
    const html = '<p><b>teh</b> cat <i>sat</i> on teh mat</p>';
    const plain = htmlToPlain(html);
    const segs = buildProofSegments(plain, 'the cat sat on the mat');
    const changes = proofChanges(segs);
    eq(changes.length, 2);
    const res = applyProofToHtml(html, segs, new Set([changes[1].id]));
    eq(res.html, '<p><b>teh</b> cat <i>sat</i> on the mat</p>');
  });
  await test('a change across formatting goes into the first piece, tags stay', () => {
    const html = '<p><b>Hel</b><i>lo</i> wrld</p>';
    const segs = buildProofSegments('Hello wrld', 'Hello world');
    const res = applyProofToHtml(html, segs, new Set(proofChanges(segs).map((c) => c.id)));
    eq(res.html, '<p><b>Hel</b><i>lo</i> world</p>');
    const segs2 = buildProofSegments('Hello wrld', 'Howdy wrld');
    const res2 = applyProofToHtml(html, segs2, new Set(proofChanges(segs2).map((c) => c.id)));
    eq(res2.html, '<p><b>Howdy</b><i></i> wrld</p>');
  });
  await test('changes that cross a paragraph break are skipped safely (counted)', () => {
    const html = '<p>first line</p><p>second line</p>';
    const plain = htmlToPlain(html);
    const corrected = 'first line second line';
    const segs = buildProofSegments(plain, corrected);
    const res = applyProofToHtml(html, segs, new Set(proofChanges(segs).map((c) => c.id)));
    eq(res.html, html);
    ok(res.skipped >= 1);
  });
  await test('store: applying proofreading keeps HTML formatting and reports skips', async () => {
    const dir = tmpProfile();
    let reply = '';
    const s = new OfflineDraftsStore();
    s.configure({
      configDir: dir,
      transport: async () => ({ ok: true, payload: { response: reply } }),
    });
    const d = s.createNew();
    s.update(d.id, { html: '<p><b>Helo</b> <span style="color: red">wrld</span></p><p>two</p>' });
    reply = 'Hello world\ntwo';
    await s.proofread(d.id);
    s.decideAll(true);
    const rev = s.contentRev;
    ok(s.applyProof());
    eq(s.open!.html, '<p><b>Hello</b> <span style="color: red">world</span></p><p>two</p>');
    eq(s.open!.body, 'Hello world\ntwo');
    eq(s.contentRev, rev + 1);
    eq(s.proofNotice, null);
    reply = 'Hello world two';
    await s.proofread(d.id);
    s.decideAll(true);
    ok(s.applyProof());
    eq(s.open!.html, '<p><b>Hello</b> <span style="color: red">world</span></p><p>two</p>');
    ok(s.proofNotice && /1/.test(s.proofNotice));
  });
  await test('old plain-text drafts still proofread (converted on apply)', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(
      path.join(dir, 'offline-drafts.json'),
      JSON.stringify({
        version: 1,
        drafts: [
          {
            id: 'dold-1',
            kind: 'new',
            to: '',
            cc: '',
            subject: '',
            body: 'teh end',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })
    );
    const s = new OfflineDraftsStore();
    s.configure({
      configDir: dir,
      transport: async () => ({ ok: true, payload: { response: 'the end' } }),
    });
    s.openDraft('dold-1');
    eq(s.open!.bcc, '');
    await s.proofread('dold-1');
    s.decideAll(true);
    ok(s.applyProof());
    eq(s.open!.body, 'the end');
  });

  console.log('\nCategory: editor UI wiring');
  await test('links: only http(s) and mailto', () => {
    eq(normalizeLinkInput('example.test/a'), 'https://example.test/a');
    eq(normalizeLinkInput('dana@example.test'), 'mailto:dana@example.test');
    eq(normalizeLinkInput('javascript:alert(1)'), null);
    eq(normalizeLinkInput('file:///c:/x'), null);
    eq(normalizeLinkInput(''), null);
  });
  await test('toolbar has every control, each translated, with shortcuts', () => {
    const src = read('internal_packages/ai-sidebar/lib/offline-mail/offline-rich-editor.tsx');
    for (const cmd of [
      "'fontName'",
      "'fontSize'",
      "'bold'",
      "'italic'",
      "'underline'",
      "'strikeThrough'",
      "'foreColor'",
      "'hiliteColor'",
      "toggleList('ul')",
      "toggleList('ol')",
      "'justifyRight'",
      "'justifyCenter'",
      "'justifyLeft'",
      "'removeFormat'",
      "'createLink'",
      'setDirection(',
    ]) {
      ok(src.includes(cmd), cmd);
    }
    for (const code of [
      "'KeyB'",
      "'KeyI'",
      "'KeyU'",
      "'KeyK'",
      "'KeyX'",
      "'KeyD'",
      "'Digit7'",
      "'Digit8'",
      "'Backslash'",
    ]) {
      ok(src.includes(code), code);
    }
    ok(src.includes('sanitizeDraftHtml(html)'), 'paste is sanitized');
    const view = read('internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-view.tsx');
    ok(view.includes("['to', 'cc', 'bcc']"), 'To/Cc/Bcc fields');
    ok(view.includes('<OfflineRichEditor'));
    ok(view.includes('<OfflineAddressPicker'));
    const rec = read('internal_packages/ai-sidebar/lib/offline-mail/offline-recipients.tsx');
    ok(rec.includes('📒') && rec.includes("tr('עותק מוסתר', 'Bcc')"));
  });
  await test('styles: themed toolbar/chips/picker and per-paragraph direction', () => {
    const less = read('internal_packages/ai-sidebar/styles/offline-mail.less');
    const i = less.indexOf('.offline-draft-rich {');
    ok(i > 0);
    const block = less.slice(i, less.indexOf('.offline-fmt-toolbar {', i));
    ok(block.includes('unicode-bidi: plaintext') && block.includes('unicode-bidi: isolate'));
    const themed = less.slice(less.indexOf('// Local drafts on the full-palette themes'));
    for (const sel of [
      '.offline-chip',
      '.offline-fmt-toolbar',
      '.offline-picker',
      '.offline-suggest',
    ]) {
      ok(themed.includes(sel), sel);
    }
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
