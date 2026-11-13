#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t209): local full-text search.
 * Synthetic messages in a temp folder only; the index file goes into a temp
 * "profile" folder. Checks Hebrew/English matching, operators, scopes,
 * incremental updates, snippets/highlights, and that the mail copy is never
 * written (no network code either).
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-search.ts
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OfflineSearchIndex,
  OFFLINE_SEARCH_DB,
  assertSearchDbPath,
  buildFtsMatch,
  buildSnippet,
  hebrewPrefixVariants,
  highlightParts,
  normalizeSearchText,
  parseSearchDate,
  parseSearchQuery,
} from './lib/core/offline-search';
import { extractOfflineSearchText } from './lib/core/offline-mail-mime';

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

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const hdr = (o: { from: string; to?: string; subject: string; date: string }, ct: string) =>
  `From: ${o.from}\r\nTo: ${o.to || 'Me <me@example.test>'}\r\nSubject: =?UTF-8?B?${b64(o.subject)}?=\r\n` +
  `Date: ${o.date}\r\nMessage-ID: <${crypto.randomBytes(6).toString('hex')}@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: ${ct}\r\n`;
const plain = (o: any, body: string) =>
  `${hdr(o, 'text/plain; charset=utf-8')}Content-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`;
const htmlMail = (o: any, body: string) =>
  `${hdr(o, 'text/html; charset=utf-8')}Content-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`;
const withFile = (o: any, body: string, file: string) =>
  `${hdr(o, 'multipart/mixed; boundary="B"')}\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n` +
  `--B\r\nContent-Type: application/pdf; name="${file}"\r\nContent-Disposition: attachment; filename="${file}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(3000, 7).toString('base64')}\r\n--B--\r\n`;

const MAILS: { [rel: string]: string } = {
  'Inbox/1.eml': plain(
    {
      from: 'דנה כהן <dana@example.test>',
      subject: 'דו"ח שנתי 2024',
      date: 'Tue, 05 Mar 2024 10:00:00 +0200',
    },
    'שָׁלוֹם רב,\nמצורף הדו״ח ובבית יש עוד מסמכים. נדבר מחר.'
  ),
  'Inbox/2.eml': htmlMail(
    {
      from: 'Bob Smith <bob@example.test>',
      subject: 'Meeting at the Café',
      date: 'Mon, 10 Jun 2024 09:00:00 +0000',
    },
    '<html><head><style>.x{color:red}</style></head><body><p>Hello <b>TEAM</b>, the &quot;quarterly&quot; meeting moved.</p></body></html>'
  ),
  'Inbox/Sub/3.eml': withFile(
    {
      from: 'Insurance <ins@example.test>',
      subject: 'פוליסה חדשה',
      date: 'Wed, 01 Jan 2025 08:00:00 +0200',
    },
    'מצורפת הפוליסה המעודכנת למשפחה.',
    'policy-2025.pdf'
  ),
  'Sent/4.eml': plain(
    {
      from: 'Me <me@example.test>',
      to: 'Dana <dana@example.test>',
      subject: 'Re: family trip',
      date: 'Fri, 15 Nov 2023 12:00:00 +0000',
    },
    'The family trip to Eilat is booked. משפחה'
  ),
  'Archive/5.eml': plain(
    {
      from: 'Spam <spam@example.test>',
      subject: 'You won',
      date: 'Sat, 01 Jul 2023 12:00:00 +0000',
    },
    'meeting family prize spam'
  ),
};

function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        out.push(
          `${path.relative(dir, p)}|${st.size}|${st.mtimeMs}|${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`
        );
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-search-'));
  const root = path.join(tmp, 'work');
  const prof = path.join(tmp, 'profile');
  fs.mkdirSync(prof, { recursive: true });
  for (const [rel, raw] of Object.entries(MAILS)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), raw);
  }
  const before = snapshot(root);

  await test('normalization: niqqud, final letters, geresh, case and accents', () => {
    assert(normalizeSearchText('שָׁלוֹם') === 'שלומ', normalizeSearchText('שָׁלוֹם'));
    assert(normalizeSearchText('צה"ל דו״ח') === 'צהל דוח', normalizeSearchText('צה"ל דו״ח'));
    assert(normalizeSearchText('CAFÉ Ångström') === 'cafe angstrom', 'latin');
    assert(hebrewPrefixVariants('ובבית שלומ').split(' ').includes('בית'), 'prefix variants');
  });

  await test('query parser: operators (English + Hebrew), phrases, negation, dates', () => {
    const p = parseSearchQuery(
      'מאת:דנה "דוח שנתי" has:attachment after:2024-01-01 before:2024-06 -spam folder:Inbox 10:30'
    );
    assert(p.terms[0].field === 'from' && p.terms[0].words[0] === 'דנה', 'from');
    assert(p.terms[1].phrase && p.terms[1].words.join(' ') === 'דוח שנתי', 'phrase');
    assert(
      p.terms.some((t) => t.negate && t.words[0] === 'spam'),
      'negate'
    );
    assert(
      p.terms.some((t) => t.words.join(':') === '10:30'),
      'not an operator stays text'
    );
    assert(p.hasAttachment === true && p.folders[0] === 'Inbox', 'filters');
    assert(
      p.after === new Date(2024, 0, 1).getTime() && p.before === new Date(2024, 5, 1).getTime(),
      'dates'
    );
    assert(parseSearchQuery('יש:צרופות').hasAttachment === true, 'Hebrew has:');
    const d = parseSearchDate('5.3.2024') as [number, number];
    assert(d && d[0] === new Date(2024, 2, 5).getTime(), 'dd.mm.yyyy');
    assert(buildFtsMatch(parseSearchQuery('has:attachment')) === null, 'filters only = no MATCH');
  });

  await test('body text: plain + base64, HTML without tags/styles, truncated message ok', () => {
    const t = extractOfflineSearchText(MAILS['Inbox/2.eml']);
    assert(
      t.includes('Hello TEAM') &&
        t.includes('"quarterly"') &&
        !t.includes('color:red') &&
        !t.includes('<'),
      t
    );
    const raw = MAILS['Inbox/Sub/3.eml'];
    const cut = extractOfflineSearchText(
      raw.slice(0, raw.indexOf('Content-Type: application/pdf') + 200)
    );
    assert(cut.includes('הפוליסה'), 'truncated');
  });

  const dbFile = path.join(prof, OFFLINE_SEARCH_DB);
  await test('index file is refused inside the mail copy or a baseline copy', () => {
    let threw = 0;
    for (const bad of [path.join(root, 'x.sqlite'), path.join(tmp, 'baseline', 'x.sqlite')]) {
      try {
        assertSearchDbPath(bad, root);
      } catch {
        threw++;
      }
    }
    assert(threw === 2, `threw ${threw}`);
    assertSearchDbPath(dbFile, root);
  });

  // Build with the real index + store code (what the app runs).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { offlineMailStore } = require('./lib/offline-mail/offline-mail-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { offlineSearchStore } = require('./lib/offline-mail/offline-search-store');
  const cache = path.join(prof, 'offline-mail-index.json');
  await offlineMailStore.start(root, cache);
  const progress: number[] = [];
  const un = offlineSearchStore.listen(() => {
    if (offlineSearchStore.build.running) {
      progress.push(offlineSearchStore.build.done);
    }
  });
  offlineSearchStore.attach(prof, root);
  while (offlineSearchStore.build.running || offlineSearchStore.build.indexed < 5) {
    await new Promise((r) => setTimeout(r, 20));
    if (offlineSearchStore.build.error) {
      break;
    }
  }
  un();

  await test('first build indexes every message, shows progress, writes only the profile', () => {
    const b = offlineSearchStore.build;
    assert(!b.error && b.indexed === 5 && b.added === 5, JSON.stringify(b));
    assert(progress.length >= 1, 'progress events');
    assert(fs.existsSync(dbFile), 'db in profile');
    assert(snapshot(root) === before, 'mail copy unchanged');
    assert(
      !fs.readdirSync(root).some((n) => /sqlite|\.json$/.test(n)),
      'nothing written into the copy'
    );
  });

  const ids = (
    q: string,
    scope: 'all' | 'folder' | 'subtree' = 'all',
    sort: 'relevance' | 'date' = 'relevance'
  ) => {
    offlineSearchStore.scope = scope;
    offlineSearchStore.sort = sort;
    offlineSearchStore.query = q;
    offlineSearchStore.run();
    assert(!offlineSearchStore.error, `error ${offlineSearchStore.error}`);
    return offlineSearchStore.results.map((r: any) => path.basename(r.entry.rel, '.eml')).join(',');
  };

  await test('Hebrew: prefixes, finals, niqqud, geresh, partial words', () => {
    assert(ids('בית') === '1', `בית ${ids('בית')}`);
    assert(ids('הבית') === '1', 'הבית');
    assert(ids('שלום') === '1', 'niqqud in mail');
    assert(ids('דוח') === '1', 'geresh in mail');
    assert(ids('משפח').split(',').sort().join() === '3,4', `prefix ${ids('משפח')}`);
    assert(ids('מסמכים') === '1' && ids('מסמכימ') === '1', 'final letter typed either way');
  });

  await test('English: case-insensitive, accents, HTML text, prefix, phrase', () => {
    assert(ids('team') === '2', 'html body');
    assert(ids('cafe') === '2', 'accent');
    assert(ids('MEET').split(',').sort().join() === '2,5', 'prefix/case');
    assert(ids('"family trip"') === '4', 'phrase');
    assert(ids('"trip family"') === '', 'phrase order');
  });

  await test('fields and filters: from/to/subject/file/has:attachment/dates/folder/-word', () => {
    assert(ids('from:dana') === '1', 'from');
    assert(ids('to:dana') === '4', 'to');
    assert(ids('מאת:דנה') === '1', 'Hebrew from');
    assert(ids('subject:meeting') === '2', 'subject only');
    assert(ids('file:policy') === '3' && ids('policy-2025.pdf') === '3', 'attachment name');
    assert(ids('has:attachment') === '3', 'has:attachment');
    assert(
      ids('family -spam').split(',').sort().join() === '3,4' || ids('family -spam') === '4',
      'negation'
    );
    assert(!ids('family -spam').includes('5'), 'excluded');
    assert(ids('date:2024').split(',').sort().join() === '1,2', 'date year');
    assert(
      ids('after:2024-06-01 before:2025-02') === '3,2' ||
        ids('after:2024-06-01 before:2025-02') === '2,3',
      'range'
    );
    assert(ids('folder:sent family') === '4', 'folder:');
    assert(
      ids('team OR policy', 'all', 'date') === '3,2' && ids('ירקות או team') === '2',
      'OR / או'
    );
  });

  await test('scope: current folder, folder + subfolders, all folders', () => {
    offlineMailStore.setFolder('Inbox');
    assert(ids('מצורף', 'folder') === '1', `folder ${ids('מצורף', 'folder')}`);
    assert(ids('מצורף', 'subtree').split(',').sort().join() === '1,3', 'subtree');
    assert(ids('family', 'all').split(',').sort().join() === '4,5', 'all');
    offlineMailStore.setFolder('Sent');
    offlineSearchStore.onFolderChanged();
    assert(
      offlineSearchStore.results.length === 0 || offlineSearchStore.scope !== 'folder',
      'rerun'
    );
  });

  await test('sort: relevance vs newest first; results carry the folder', () => {
    const byDate = ids('meeting OR family', 'all', 'date');
    assert(byDate === '2,4,5', byDate);
    assert(
      offlineSearchStore.results.map((r: any) => r.folder).join() === 'Inbox,Sent,Archive',
      'folders'
    );
    assert(offlineSearchStore.total === 3, 'total');
    // Subject hits rank above body-only hits (Hebrew prefixes too).
    assert(ids('meeting', 'all', 'relevance') === '2,5', ids('meeting', 'all', 'relevance'));
    assert(ids('פוליסה', 'all', 'relevance') === '3', 'subject');
    assert(ids('family OR משפחה', 'all', 'relevance').split(',')[0] === '4', 'subject first');
  });

  await test('snippets and highlights come from the message text', async () => {
    ids('בית');
    const id = offlineSearchStore.results[0].id;
    offlineSearchStore.snippetFor(id);
    for (let i = 0; i < 50 && offlineSearchStore.snippetFor(id) === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const parts = offlineSearchStore.snippetFor(id);
    assert(parts && parts.some((p: any) => p.hit && p.t === 'בית'), JSON.stringify(parts));
    const h = highlightParts('Re: CAFÉ meeting', ['cafe']);
    assert(h[1].hit && h[1].t === 'CAFÉ', JSON.stringify(h));
    const sn = buildSnippet('x '.repeat(200) + 'the word שָׁלוֹם here', ['שלומ']);
    assert(sn[0].t === '…' && sn.some((p) => p.hit && p.t === 'שָׁלוֹם'), JSON.stringify(sn));
  });

  await test('clicking a result opens it without leaving the results or the folder', async () => {
    offlineMailStore.setFolder('Sent');
    ids('team');
    const id = offlineSearchStore.results[0].id;
    offlineMailStore.selectIds([id]);
    for (
      let i = 0;
      i < 50 && !(offlineMailStore.openMessage && offlineMailStore.openMessage.parsed);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(
      offlineMailStore.openMessage?.id === id && offlineMailStore.openMessage.parsed,
      'opened'
    );
    assert(offlineMailStore.currentFolder === 'Sent' && offlineSearchStore.active, 'stays');
    offlineMailStore.selectIds(offlineSearchStore.results.map((r: any) => r.id));
    assert(
      offlineMailStore.selectedIds.length === offlineSearchStore.results.length,
      'select all -> AI selected'
    );
    offlineSearchStore.clear();
    assert(!offlineSearchStore.active && !offlineSearchStore.results.length, 'cleared');
  });

  await test('incremental: unchanged mail is not re-read; new / changed / deleted are applied', async () => {
    const ix = new OfflineSearchIndex(dbFile, root);
    const idx0 = offlineMailStore.index;
    assert(ix.plan(idx0.entries).add.length === 0, 'nothing to do');
    ix.close();
    // New message, a changed one and a deleted one in the *test* copy.
    fs.writeFileSync(
      path.join(root, 'Inbox/6.eml'),
      plain(
        { from: 'New <n@example.test>', subject: 'ירקות', date: 'Mon, 02 Nov 2026 09:00:00 +0000' },
        'עגבניות ומלפפונים'
      )
    );
    fs.writeFileSync(
      path.join(root, 'Inbox/2.eml'),
      htmlMail(
        {
          from: 'Bob Smith <bob@example.test>',
          subject: 'Meeting at the Café',
          date: 'Mon, 10 Jun 2024 09:00:00 +0000',
        },
        '<p>Hello TEAM, the annual meeting moved.</p>'
      )
    );
    fs.unlinkSync(path.join(root, 'Archive/5.eml'));
    await offlineMailStore.start(root, cache);
    await offlineSearchStore.update();
    const b = offlineSearchStore.build;
    assert(b.added === 2 && b.removed === 2 && b.indexed === 5, JSON.stringify(b));
    assert(ids('מלפפון') === '6', 'new');
    assert(ids('annual') === '2' && ids('quarterly') === '', 'changed');
    assert(ids('prize') === '', 'deleted');
  });

  await test('no network code in the search modules', () => {
    for (const f of [
      'lib/core/offline-search.ts',
      'lib/offline-mail/offline-search-store.ts',
      'lib/offline-mail/offline-search-view.tsx',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert(
        !/\b(fetch|XMLHttpRequest|require\(['"](https?|net|tls)['"]\)|from ['"](https?|net|tls)['"]|gemini|WebSocket)\b/i.test(
          src
        ),
        f
      );
    }
  });

  offlineSearchStore.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
