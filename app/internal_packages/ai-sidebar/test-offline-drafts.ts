#!/usr/bin/env npx ts-node
/**
 * Offline experiment: local drafts.
 * - drafts are saved only in the offline profile (offline-drafts.json);
 * - new / reply / forward / edit / delete;
 * - each paragraph picks its own direction (Hebrew RTL, English LTR);
 * - "Proofread with Gemini" sends only the draft text, and the result is a
 *   per-change accept / reject diff;
 * - local spell check uses dictionaries already on this computer, no download;
 * - NO send path exists at all.
 * Temp folders and mocked fetch only; no network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-drafts.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

// Some imported main-process modules load Electron; stand in a harmless stub.
const electronPath = require.resolve('electron');
Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getLocale: () => 'en-US' },
    session: { defaultSession: null },
    ipcMain: { handle() {}, on() {} },
  },
};

import { setOfflineArchiveOverride } from '../../src/offline-archive';
import { setOfflineLangOverride } from './lib/core/offline-i18n';
import {
  OFFLINE_DRAFTS_FILE,
  OFFLINE_DRAFTS_NO_SEND_NOTE,
  OFFLINE_PROOFREAD_MAX_CHARS,
  OfflineDraftSource,
  draftsFilePath,
  isInsideProfile,
  makeForwardDraft,
  makeReplyDraft,
  paragraphDirections,
  readDrafts,
  writeDrafts,
  makeNewDraft,
} from './lib/core/offline-drafts';
import { applyProofDecisions, buildProofSegments, proofChanges } from './lib/core/text-diff';
import { OfflineDraftsStore } from './lib/offline-mail/offline-drafts-store';
import {
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_PAID_ENV,
  isGeminiHostFailure,
  isGeminiHostOk,
} from '../../src/browser/gemini-demo-protocol';
import {
  GeminiFetch,
  admitOfflineProofreadQuery,
  runGeminiDemoQuery,
} from '../../src/browser/gemini-demo-host';
import { offlineRequestDecision } from '../../src/browser/offline-network-guard';
import { OFFLINE_ARCHIVE_DISABLED_PACKAGES } from '../../src/offline-archive';
import {
  OFFLINE_SPELL_DOWNLOAD_URL,
  OFFLINE_SPELL_LANGUAGES,
  configureOfflineSpellcheck,
  ensureOfflineSpellDictionaries,
  planDictionaryCopies,
} from '../../src/browser/offline-spellcheck';

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-drafts-test-'));
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

const SRC: OfflineDraftSource = {
  id: 'offline-00000000000000aa',
  subject: 'Quarterly numbers',
  from: 'Dana Example <dana@example.test>',
  to: 'me@example.test',
  cc: '',
  date: '2026-01-02 10:00',
  text: 'שלום,\nThe report is attached.',
};
const FAKE_KEY = 'ms-drafts-test-key-not-live';
const paidEnv = { [GEMINI_DEMO_KEY_ENV]: FAKE_KEY, [GEMINI_DEMO_PAID_ENV]: '1' };

(async () => {
  setOfflineArchiveOverride(true);
  setOfflineLangOverride('he');

  console.log('Category: saved only in the offline profile');
  await test('drafts file lives inside the profile folder', () => {
    const dir = tmpProfile();
    eq(draftsFilePath(dir), path.join(dir, OFFLINE_DRAFTS_FILE));
    ok(isInsideProfile(dir, draftsFilePath(dir)));
    ok(!isInsideProfile(dir, path.join(dir, '..', 'elsewhere.json')));
    ok(!isInsideProfile(dir, dir));
  });
  await test('store writes nothing outside the profile, nothing else inside it', async () => {
    const dir = tmpProfile();
    const s = new OfflineDraftsStore();
    s.configure({ configDir: dir });
    const d = s.createNew();
    s.update(d.id, { to: 'x@example.test', subject: 'נושא', body: 'שלום עולם' });
    s.flush();
    const files = listAll(dir).map((p) => path.relative(dir, p));
    eq(JSON.stringify(files), JSON.stringify([OFFLINE_DRAFTS_FILE]));
    const back = readDrafts(dir);
    eq(back.length, 1);
    eq(back[0].body, 'שלום עולם');
  });
  await test('edits survive a restart (new store reads the same file)', () => {
    const dir = tmpProfile();
    const a = new OfflineDraftsStore();
    a.configure({ configDir: dir });
    const d = a.createNew();
    a.update(d.id, { body: 'Hello\nשלום' });
    a.flush();
    const b = new OfflineDraftsStore();
    b.configure({ configDir: dir });
    eq(b.count, 1);
    eq(b.drafts[0].body, 'Hello\nשלום');
  });
  await test('delete removes the draft from the file', () => {
    const dir = tmpProfile();
    const s = new OfflineDraftsStore();
    s.configure({ configDir: dir });
    const d1 = s.createNew();
    s.createNew();
    s.delete(d1.id);
    eq(readDrafts(dir).length, 1);
    ok(!readDrafts(dir).some((x) => x.id === d1.id));
    eq(s.openId === d1.id, false);
  });
  await test('missing, BOM-prefixed and corrupt files are handled', () => {
    const dir = tmpProfile();
    eq(readDrafts(dir).length, 0);
    const d = makeNewDraft(1000);
    fs.writeFileSync(
      draftsFilePath(dir),
      '\uFEFF' + JSON.stringify({ version: 1, drafts: [d, { id: '../evil', body: 'x' }] })
    );
    const back = readDrafts(dir);
    eq(back.length, 1);
    eq(back[0].id, d.id);
    fs.writeFileSync(draftsFilePath(dir), '{not json');
    eq(readDrafts(dir).length, 0);
  });
  await test('write is atomic (no temp file left behind)', () => {
    const dir = tmpProfile();
    writeDrafts(dir, [makeNewDraft(5)]);
    eq(fs.readdirSync(dir).length, 1);
  });

  console.log('\nCategory: new / reply / forward');
  await test('reply: Re: prefix, address only, quoted text, source id', () => {
    const d = makeReplyDraft(SRC, 10);
    eq(d.kind, 'reply');
    eq(d.subject, 'Re: Quarterly numbers');
    eq(d.to, 'dana@example.test');
    ok(d.body.includes('> שלום,') && d.body.includes('> The report is attached.'));
    eq(d.sourceMessageId, SRC.id);
  });
  await test('reply does not double the Re: prefix', () => {
    eq(makeReplyDraft({ ...SRC, subject: 'RE: x' }, 1).subject, 'RE: x');
  });
  await test('forward: Fwd: prefix, empty recipients, original header block', () => {
    const d = makeForwardDraft(SRC, 10);
    eq(d.kind, 'forward');
    eq(d.subject, 'Fwd: Quarterly numbers');
    eq(d.to, '');
    ok(d.body.includes('The report is attached.'));
    ok(d.body.includes(SRC.from));
  });
  await test('store reply/forward open the new draft in the drafts view', () => {
    const s = new OfflineDraftsStore();
    s.configure({ configDir: tmpProfile() });
    const r = s.createReply(SRC);
    ok(s.showing && s.openId === r.id);
    const f = s.createForward(SRC);
    ok(s.openId === f.id && s.count === 2);
    s.hide();
    ok(!s.showing && s.openId === null);
  });

  console.log('\nCategory: per-paragraph direction');
  await test('Hebrew paragraphs RTL, English LTR, empty neutral', () => {
    eq(
      JSON.stringify(paragraphDirections('שלום רב\nHello there\n\n123 שקל\n> quoted')),
      JSON.stringify(['rtl', 'ltr', 'neutral', 'rtl', 'ltr'])
    );
  });
  await test('editor body uses dir=auto + plaintext bidi per paragraph', () => {
    const view = read('internal_packages/ai-sidebar/lib/offline-mail/offline-rich-editor.tsx');
    const i = view.indexOf('className="offline-draft-body offline-draft-rich"');
    ok(i > 0);
    const tag = view.slice(i - 40, i + 400);
    ok(tag.includes('dir="auto"'), 'dir=auto');
    ok(/spellCheck(=\{true\})?/.test(tag), 'spellCheck on');
    const less = read('internal_packages/ai-sidebar/styles/offline-mail.less');
    const j = less.indexOf('.offline-draft-body {');
    ok(j > 0);
    const block = less.slice(j, less.indexOf('}', j));
    ok(block.includes('unicode-bidi: plaintext') && block.includes('text-align: start'));
  });

  console.log('\nCategory: proofreading diff');
  await test('per-change accept / reject', () => {
    const original = 'שלום, מה שלומך?\nI hope you are wel.\nThanks';
    const corrected = 'שלום, מה שלומך?\nI hope you are well.\nThanks!';
    const segs = buildProofSegments(original, corrected);
    const changes = proofChanges(segs);
    eq(changes.length, 2);
    eq(applyProofDecisions(segs, new Set()), original);
    eq(applyProofDecisions(segs, new Set(changes.map((c) => c.id))), corrected);
    eq(
      applyProofDecisions(segs, new Set([changes[0].id])),
      'שלום, מה שלומך?\nI hope you are well.\nThanks'
    );
  });
  await test('Hebrew typo is one change', () => {
    const segs = buildProofSegments('אני רוצה לשלוך את הדוח', 'אני רוצה לשלוח את הדוח');
    eq(proofChanges(segs).length, 1);
  });

  console.log('\nCategory: proofread sends only the draft text');
  await test('store passes only the body (no recipients, subject, mail)', async () => {
    const sent: string[] = [];
    let meter = 0;
    const s = new OfflineDraftsStore();
    s.configure({
      configDir: tmpProfile(),
      transport: async (_g, text) => {
        sent.push(text);
        return { ok: true, payload: { response: text.replace('wel.', 'well.') } };
      },
      afterProofread: () => meter++,
    });
    const d = s.createReply(SRC);
    s.update(d.id, { body: 'I hope you are wel.\nשלום' });
    await s.proofread(d.id);
    eq(sent.length, 1);
    eq(sent[0], 'I hope you are wel.\nשלום');
    ok(!sent[0].includes('dana@example.test') && !sent[0].includes('Quarterly'));
    eq(meter, 1);
    eq(s.proof.status, 'review');
    eq(s.proofChangeCount(), 1);
    s.decideAll(true);
    ok(s.applyProof());
    eq(s.drafts.find((x) => x.id === d.id)!.body, 'I hope you are well.\nשלום');
  });
  await test('nothing is sent without a click, for empty or oversized drafts', async () => {
    const sent: string[] = [];
    const s = new OfflineDraftsStore();
    s.configure({
      configDir: tmpProfile(),
      transport: async (_g, t) => {
        sent.push(t);
        return { ok: true, payload: { response: t } };
      },
    });
    const d = s.createNew();
    s.update(d.id, { body: 'x'.repeat(10) });
    eq(sent.length, 0);
    s.update(d.id, { body: '   ' });
    await s.proofread(d.id);
    eq(s.proof.status, 'error');
    s.update(d.id, { body: 'x'.repeat(OFFLINE_PROOFREAD_MAX_CHARS + 1) });
    await s.proofread(d.id);
    eq(s.proof.status, 'error');
    eq(sent.length, 0);
  });
  await test('reject keeps the original; edits during review block apply', async () => {
    const s = new OfflineDraftsStore();
    s.configure({
      configDir: tmpProfile(),
      transport: async (_g, t) => ({ ok: true, payload: { response: t + '!' } }),
    });
    const d = s.createNew();
    s.update(d.id, { body: 'Hi' });
    await s.proofread(d.id);
    s.decideAll(false);
    ok(s.applyProof());
    eq(s.drafts[0].body, 'Hi');
    await s.proofread(d.id);
    s.update(d.id, { body: 'Hi there' });
    s.decideAll(true);
    eq(s.applyProof(), false);
    eq(s.drafts[0].body, 'Hi there');
  });
  await test('host admits proofread only with zero messages and bounded text', () => {
    const base = {
      generation: 1,
      query: 'טקסט',
      messages: [],
      mode: 'offline-draft-proofread' as const,
    };
    eq(admitOfflineProofreadQuery(base), null);
    ok(admitOfflineProofreadQuery({ ...base, messages: [{ id: 'x' } as any] }));
    ok(admitOfflineProofreadQuery({ ...base, query: '' }));
    ok(admitOfflineProofreadQuery({ ...base, query: 'x'.repeat(OFFLINE_PROOFREAD_MAX_CHARS + 1) }));
    ok(admitOfflineProofreadQuery({ ...base, allowedMessageId: 'offline-1' } as any));
  });
  await test('request body carries only the DRAFT block (mocked fetch)', async () => {
    const calls: any[] = [];
    const fetch: GeminiFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body || '{}') });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            output_text: JSON.stringify({ response: 'Hello world.', citations: [] }),
            usage: { total_tokens: 5 },
          });
        },
      };
    };
    const out = await runGeminiDemoQuery(
      { generation: 1, query: 'Helo world.', messages: [], mode: 'offline-draft-proofread' },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostOk(out), JSON.stringify(out));
    eq(calls.length, 1);
    ok(String(calls[0].url).includes('generativelanguage.googleapis.com'));
    eq(calls[0].body.input, '<<<DRAFT>>>\nHelo world.\n<<<END_DRAFT>>>');
    ok(String(calls[0].body.system_instruction).toLowerCase().includes('proofread'));
  });
  await test('proofread with mail attached is refused before any fetch', async () => {
    let fetched = 0;
    const fetch: GeminiFetch = async () => {
      fetched++;
      throw new Error('should not fetch');
    };
    const out = await runGeminiDemoQuery(
      {
        generation: 1,
        query: 'x',
        messages: [{ id: 'offline-0000000000000001' } as any],
        mode: 'offline-draft-proofread',
      },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostFailure(out));
    eq(fetched, 0);
  });
  await test('IPC drops any messages for proofread; the usage meter records it', () => {
    const ipc = read('src/browser/gemini-demo-ipc.ts');
    ok(ipc.includes("mode === 'offline-draft-proofread' ? [] :"), 'messages forced empty');
    ok(/ledger|Ledger/.test(ipc), 'usage ledger in IPC');
    const reg = read('internal_packages/ai-sidebar/lib/offline-mail/register.ts');
    ok(reg.includes('afterProofread') && reg.includes('refreshGeminiUsage'));
  });

  console.log('\nCategory: local spell check, no network');
  await test('copies only missing he/en dictionaries from local folders', () => {
    const plan = planDictionaryCopies(
      '/p/Dictionaries',
      ['en-US-10-1.bdic'],
      [
        { dir: '/edge', files: ['he-IL-3-0.bdic', 'en-GB-10-1.bdic', 'he-IL-2-0.bdic'] },
        { dir: '/cef', files: ['en-US-10-1.bdic'] },
      ]
    );
    eq(plan.length, 1);
    eq(path.basename(plan[0].from), 'he-IL-3-0.bdic');
    eq(path.dirname(plan[0].from), path.normalize('/edge'));
  });
  await test('ensure copies from a local folder into <profile>/Dictionaries', () => {
    const src = tmpProfile();
    const prof = tmpProfile();
    fs.writeFileSync(path.join(src, 'he-IL-3-0.bdic'), 'x');
    fs.writeFileSync(path.join(src, 'en-US-10-1.bdic'), 'y');
    const r = ensureOfflineSpellDictionaries(prof, { MAILSPRING_OFFLINE_DICTIONARIES_DIR: src });
    eq(r.copied.length, 2);
    ok(fs.existsSync(path.join(prof, 'Dictionaries', 'he-IL-3-0.bdic')));
    eq(
      ensureOfflineSpellDictionaries(prof, { MAILSPRING_OFFLINE_DICTIONARIES_DIR: src }).copied
        .length,
      0
    );
  });
  await test('session: downloads pointed at a closed local port; he + en-US on', () => {
    const calls: string[] = [];
    let langs: string[] = [];
    const langsOut = configureOfflineSpellcheck({
      setSpellCheckerDictionaryDownloadURL: (u) => calls.push(u),
      setSpellCheckerEnabled: (on) => calls.push(`enabled:${on}`),
      setSpellCheckerLanguages: (l) => (langs = l),
      availableSpellCheckerLanguages: ['en-US', 'he', 'fr'],
    });
    eq(calls[0], OFFLINE_SPELL_DOWNLOAD_URL);
    ok(new URL(OFFLINE_SPELL_DOWNLOAD_URL).hostname === '127.0.0.1');
    eq(JSON.stringify(langs), JSON.stringify(OFFLINE_SPELL_LANGUAGES));
    eq(JSON.stringify(langsOut), JSON.stringify(['he', 'en-US']));
  });
  await test('dictionaries are never part of the repo', () => {
    const gi = read('../.gitignore');
    ok(gi.includes('*.bdic'), '.gitignore has *.bdic');
  });

  console.log('\nCategory: no-send guarantee');
  const DRAFT_FILES = [
    'internal_packages/ai-sidebar/lib/core/offline-drafts.ts',
    'internal_packages/ai-sidebar/lib/core/text-diff.ts',
    'internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-store.ts',
    'internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-view.tsx',
    'internal_packages/ai-sidebar/lib/core/offline-rich-text.ts',
    'internal_packages/ai-sidebar/lib/core/offline-address-book.ts',
    'internal_packages/ai-sidebar/lib/offline-mail/offline-address-book-store.ts',
    'internal_packages/ai-sidebar/lib/offline-mail/offline-recipients.tsx',
    'internal_packages/ai-sidebar/lib/offline-mail/offline-rich-editor.tsx',
  ];
  await test('drafts code has no send, network or mail-task calls', () => {
    const banned = [
      /SendDraftTask/,
      /SyncbackDraftTask/,
      /DestroyDraftTask/,
      /Actions\.sendDraft/,
      /sendDraft\s*\(/,
      /\bsend\s*\(/,
      /smtp/i,
      /imap/i,
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /WebSocket/,
      /require\(['"](https?|net|tls|electron)['"]\)/,
      /from ['"](https?|net|tls|electron|mailspring-exports)['"]/,
      /ipcRenderer/,
      /mailsync/i,
    ];
    for (const f of DRAFT_FILES) {
      const src = read(f);
      for (const re of banned) {
        ok(!re.test(src), `${path.basename(f)} matches ${re}`);
      }
    }
  });
  await test('store has no send method at all', () => {
    const proto = Object.getOwnPropertyNames(OfflineDraftsStore.prototype);
    ok(!proto.some((n) => /send|submit|deliver|outbox/i.test(n)), proto.join(','));
  });
  await test('send button is permanently disabled with the Hebrew note', () => {
    const view = read('internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-view.tsx');
    const i = view.indexOf('data-offline-draft-send="disabled"');
    ok(i > 0);
    const start = view.lastIndexOf('<button', i);
    const tag = view.slice(start, view.indexOf('</button>', i));
    ok(/\bdisabled\b/.test(tag.replace('data-offline-draft-send="disabled"', '')), 'disabled attr');
    ok(!/onClick|onMouseDown|onKeyDown|onSubmit/.test(tag), 'no handler');
    eq(OFFLINE_DRAFTS_NO_SEND_NOTE, 'גרסת ניסוי – אין שליחה');
    ok(view.includes('{OFFLINE_DRAFTS_NO_SEND_NOTE}'));
    eq((view.match(/data-offline-draft-send=/g) || []).length, 1);
  });
  await test("Mailspring's composer and sending packages stay disabled offline", () => {
    for (const p of ['composer', 'draft-list', 'send-later', 'send-and-archive']) {
      ok(OFFLINE_ARCHIVE_DISABLED_PACKAGES.includes(p), p);
    }
  });
  await test('network guard: only Gemini goes out; mail servers are blocked', () => {
    eq(
      offlineRequestDecision('https://generativelanguage.googleapis.com/v1beta/x'),
      'allow-remote'
    );
    eq(offlineRequestDecision('https://smtp.mail.yahoo.com/'), 'block');
    eq(offlineRequestDecision('https://imap.mail.yahoo.com/'), 'block');
    eq(
      offlineRequestDecision('https://redirector.gvt1.com/edgedl/chrome/dict/he-il-3-0.bdic'),
      'block'
    );
    eq(offlineRequestDecision('http://generativelanguage.googleapis.com/'), 'block');
  });
  await test('UI wiring: reply/forward create local drafts only', () => {
    const reader = read('internal_packages/ai-sidebar/lib/offline-mail/offline-message-reader.tsx');
    ok(
      reader.includes('offlineDraftsStore.createReply(') &&
        reader.includes('offlineDraftsStore.createForward(')
    );
    ok(!/SendDraftTask|Actions\.composeReply|composeForward/.test(reader));
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
