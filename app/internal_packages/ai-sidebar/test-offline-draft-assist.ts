#!/usr/bin/env npx ts-node
/**
 * Offline experiment: "📝 open draft" AI scope.
 * - only the user's request + the draft's own plain text leave the app
 *   (subject only when ticked; never recipients, quoted/forwarded mail,
 *   attachments or archive messages);
 * - the main process admits only that shape and logs usage;
 * - rewrites can be applied (formatting kept when possible, plain fallback
 *   with a warning), appended, copied, and undone.
 * Temp folders, stubbed IPC and mocked fetch only; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-draft-assist.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

// Renderer IPC → fake main-process handlers (registered below).
const handlers = new Map<string, (...args: any[]) => any>();
const electronPath = require.resolve('electron');
Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getLocale: () => 'he' },
    session: { defaultSession: null },
    ipcMain: { handle() {}, on() {} },
    ipcRenderer: {
      invoke: (ch: string, ...args: any[]) => {
        const h = handlers.get(ch);
        if (!h) throw new Error(`no handler ${ch}`);
        return Promise.resolve(h({ sender: {} }, ...args));
      },
    },
  },
};

// Window-sender check needs real BrowserWindows; the test calls handlers directly.
const trustedPath = require.resolve('../../src/browser/trusted-ipc');
Module._cache[trustedPath] = {
  id: trustedPath,
  filename: trustedPath,
  loaded: true,
  exports: {
    handleFromMailspringWindows: (m: any, ch: string, h: any) => m.handle(ch, h),
    onFromMailspringWindows: (m: any, ch: string, h: any) => m.on(ch, h),
  },
};

import { setOfflineArchiveOverride } from '../../src/offline-archive';
import { setOfflineLangOverride } from './lib/core/offline-i18n';
import { OfflineDraftSource, makeForwardDraft, makeReplyDraft } from './lib/core/offline-drafts';
import {
  DRAFT_QUICK_ACTIONS,
  appendDraftHtml,
  buildDraftAssistRequest,
  cleanRewrite,
  replaceDraftHtml,
  splitDraftForAssist,
} from './lib/core/offline-draft-assist';
import { htmlToPlain } from './lib/core/offline-rich-text';
import { OfflineDraftsStore } from './lib/offline-mail/offline-drafts-store';
import {
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_PAID_ENV,
  GEMINI_IPC_QUERY,
  OFFLINE_DRAFT_ASSIST_MAX_CHARS,
  buildDraftAssistInput,
  isGeminiHostFailure,
  isGeminiHostOk,
} from '../../src/browser/gemini-demo-protocol';
import {
  GeminiFetch,
  admitOfflineDraftAssistQuery,
  runGeminiDemoQuery,
} from '../../src/browser/gemini-demo-host';
// Loaded after the stubs above (import statements may be hoisted).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerGeminiDemoIpcHandlers } = require('../../src/browser/gemini-demo-ipc');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { draftAssistViaIpc } = require('./lib/gemini-ipc-transport');

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
const read = (rel: string) =>
  fs.readFileSync(path.join(appRoot, rel), 'utf8').replace(/\r\n/g, '\n');
const tmpDirs: string[] = [];
function tmpProfile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-draft-assist-test-'));
  tmpDirs.push(d);
  return d;
}

const SRC: OfflineDraftSource = {
  id: 'offline-00000000000000aa',
  subject: 'SECRET-SUBJECT quarterly',
  from: 'Dana Example <dana@example.test>',
  to: 'me@example.test',
  cc: '',
  date: '2026-01-02 10:00',
  text: 'ARCHIVED-QUOTE-LINE\nThe report is attached.',
};
const FAKE_KEY = 'ms-draft-assist-test-key-not-live';
const paidEnv = { [GEMINI_DEMO_KEY_ENV]: FAKE_KEY, [GEMINI_DEMO_PAID_ENV]: '1' };

function replyDraft() {
  const d = makeReplyDraft(SRC, 1000);
  d.body = `שלום דנה,\nMY-OWN-TEXT תודה על הדוח.${d.body}`;
  d.to = 'dana@example.test';
  d.cc = 'boss@example.test';
  d.bcc = 'hidden@example.test';
  d.html = '';
  return d;
}

(async () => {
  setOfflineArchiveOverride(true);
  setOfflineLangOverride('he');

  console.log('Category: what may leave the app');
  await test('only the own draft text is taken: no recipients, subject or quote', () => {
    const d = replyDraft();
    const b = buildDraftAssistRequest(d, 'תקצר');
    ok(b.ok);
    const req = (b as any).req;
    eq(Object.keys(req).sort().join(','), 'draftText,request');
    const all = JSON.stringify(req);
    ok(all.includes('MY-OWN-TEXT'));
    for (const banned of [
      'dana@example.test',
      'boss@example.test',
      'hidden@example.test',
      'SECRET-SUBJECT',
      'ARCHIVED-QUOTE-LINE',
      SRC.id,
    ]) {
      ok(!all.includes(banned), `leaked ${banned}`);
    }
  });
  await test('subject only when ticked', () => {
    const b = buildDraftAssistRequest(replyDraft(), 'x', true) as any;
    ok(b.ok && b.req.draftSubject.includes('SECRET-SUBJECT'));
  });
  await test('forwarded block is never sent', () => {
    const d = makeForwardDraft(SRC, 1000);
    d.body = `FYI-OWN${d.body}`;
    const s = splitDraftForAssist(d.body);
    eq(s.own, 'FYI-OWN');
    eq(s.own + s.tail, d.body);
    const b = buildDraftAssistRequest(d, 'x') as any;
    ok(!JSON.stringify(b.req).includes('ARCHIVED-QUOTE-LINE'));
    ok(!JSON.stringify(b.req).includes('dana@example.test'));
  });
  await test('empty own text (only a quote) or too long is refused locally', () => {
    const d = makeReplyDraft(SRC, 1000);
    eq((buildDraftAssistRequest(d, 'x') as any).reason, 'empty-draft');
    eq(
      (
        buildDraftAssistRequest(
          { body: 'x'.repeat(OFFLINE_DRAFT_ASSIST_MAX_CHARS + 1) },
          'x'
        ) as any
      ).reason,
      'too-long'
    );
    eq((buildDraftAssistRequest({ body: 'hi' }, '   ') as any).reason, 'empty-request');
  });
  await test('six quick actions with Hebrew labels', () => {
    eq(
      DRAFT_QUICK_ACTIONS.map((a) => a.he).join('|'),
      'תקצר|רשמי יותר|ידידותי יותר|תרגם לאנגלית|תרגם לעברית|בדוק טון'
    );
  });

  console.log('\nCategory: main process');
  const base = {
    generation: 1,
    query: 'תקצר',
    messages: [],
    mode: 'offline-draft-assist' as const,
    draftText: 'שלום',
  };
  await test('host admits only request + draft, no mail, bounded', () => {
    eq(admitOfflineDraftAssistQuery(base), null);
    ok(admitOfflineDraftAssistQuery({ ...base, messages: [{ id: 'offline-1' } as any] }));
    ok(admitOfflineDraftAssistQuery({ ...base, draftText: ' ' }));
    ok(admitOfflineDraftAssistQuery({ ...base, query: '' }));
    ok(
      admitOfflineDraftAssistQuery({
        ...base,
        draftText: 'x'.repeat(OFFLINE_DRAFT_ASSIST_MAX_CHARS + 1),
      })
    );
    ok(admitOfflineDraftAssistQuery({ ...base, allowedMessageId: 'offline-1' } as any));
    ok(admitOfflineDraftAssistQuery({ ...base, scopeFacts: {} } as any));
  });
  await test('request body = REQUEST + DRAFT blocks only; rewrite kind passes through, no citations needed', async () => {
    const calls: any[] = [];
    const fetch: GeminiFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body || '{}') });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            output_text: JSON.stringify({ response: 'קצר.', kind: 'rewrite' }),
            usage: { total_tokens: 7 },
          });
        },
      };
    };
    const out = await runGeminiDemoQuery(base, {
      demoMode: false,
      offlineArchive: true,
      env: paidEnv,
      fetch,
    });
    ok(isGeminiHostOk(out), JSON.stringify(out));
    eq(calls.length, 1);
    eq(calls[0].body.input, buildDraftAssistInput('תקצר', 'שלום'));
    eq(
      calls[0].body.input,
      '<<<REQUEST>>>\nתקצר\n<<<END_REQUEST>>>\n<<<DRAFT>>>\nשלום\n<<<END_DRAFT>>>'
    );
    ok(String(calls[0].body.system_instruction).includes('email draft'));
    eq((out as any).payload.draftKind, 'rewrite');
    eq((out as any).payload.citations.length, 0);
  });
  await test('draft assist with mail attached is refused before any fetch', async () => {
    let fetched = 0;
    const out = await runGeminiDemoQuery(
      { ...base, messages: [{ id: 'offline-0000000000000001' } as any] },
      {
        demoMode: false,
        offlineArchive: true,
        env: paidEnv,
        fetch: async () => {
          fetched++;
          throw new Error('no');
        },
      }
    );
    ok(isGeminiHostFailure(out));
    eq(fetched, 0);
  });
  await test('renderer → IPC → Gemini end to end: only draft text sent; usage logged', async () => {
    const dir = tmpProfile();
    const bodies: string[] = [];
    registerGeminiDemoIpcHandlers(
      { handle: (ch: string, fn: any) => handlers.set(ch, fn), on() {} } as any,
      {
        isDemoMode: () => false,
        isOfflineArchive: () => true,
        env: paidEnv,
        configDirPath: dir,
        fetch: async (_url: string, init: { body?: string }) => {
          bodies.push(String(init.body));
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                output_text: JSON.stringify({ response: 'ok', kind: 'answer', citations: [] }),
                usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
              });
            },
          };
        },
      }
    );
    ok(handlers.has(GEMINI_IPC_QUERY));
    const d = replyDraft();
    const b = buildDraftAssistRequest(d, 'בדוק טון') as any;
    // A buggy caller adding mail must still not leak it: IPC drops it.
    const res = await handlers.get(GEMINI_IPC_QUERY)!(
      { sender: {} },
      {
        ...b.req,
        query: b.req.request,
        generation: 3,
        mode: 'offline-draft-assist',
        messages: [{ id: 'offline-1', subject: 'SECRET-SUBJECT', bodyText: 'ARCHIVED-QUOTE-LINE' }],
      }
    );
    ok(isGeminiHostOk(res), JSON.stringify(res));
    const viaRenderer = await draftAssistViaIpc(4, b.req);
    ok(isGeminiHostOk(viaRenderer), JSON.stringify(viaRenderer));
    eq(bodies.length, 2);
    for (const body of bodies) {
      ok(body.includes('MY-OWN-TEXT'));
      for (const banned of [
        'dana@example.test',
        'boss@example.test',
        'hidden@example.test',
        'SECRET-SUBJECT',
        'ARCHIVED-QUOTE-LINE',
        'offline-1',
      ]) {
        ok(!body.includes(banned), `leaked ${banned}`);
      }
    }
    const ledger = fs.readFileSync(path.join(dir, 'gemini-usage.json'), 'utf8');
    ok(ledger.includes('offline-draft-assist'), 'usage logged with mode');
    ok(!ledger.includes('MY-OWN-TEXT'), 'ledger has counts only');
  });

  console.log('\nCategory: applying the answer');
  await test('rewrite of a word keeps formatting', () => {
    const html = '<p dir="auto">Hello <b>wrld</b> there</p><p dir="auto">Bye</p>';
    const r = replaceDraftHtml(html, htmlToPlain(html), 'Hello world there\nBye');
    ok(r.formattingKept);
    ok(r.html.includes('<b>world</b>'));
  });
  await test('structural rewrite falls back to plain paragraphs and says so', () => {
    const html = '<p dir="auto">Hello <b>wrld</b> there</p><p dir="auto">Bye</p>';
    const r = replaceDraftHtml(html, htmlToPlain(html), 'Short.');
    eq(r.formattingKept, false);
    eq(htmlToPlain(r.html), 'Short.');
  });
  await test('replace keeps the quoted mail below; append goes before the quote', () => {
    const d = replyDraft();
    const r = replaceDraftHtml('', d.body, 'Hi Dana, thanks.');
    const plain = htmlToPlain(r.html);
    ok(plain.startsWith('Hi Dana, thanks.'));
    ok(plain.includes('> ARCHIVED-QUOTE-LINE'));
    ok(!plain.includes('MY-OWN-TEXT'));
    const a = appendDraftHtml('', d.body, 'P.S. later');
    const ap = htmlToPlain(a.html);
    ok(ap.indexOf('MY-OWN-TEXT') < ap.indexOf('P.S. later'));
    ok(ap.indexOf('P.S. later') < ap.indexOf('ARCHIVED-QUOTE-LINE'));
  });
  await test('code fences around a rewrite are stripped', () => {
    eq(cleanRewrite('```\nשלום\n```'), 'שלום');
  });
  await test('store: apply → undo restores the exact HTML; notice warns on plain fallback', () => {
    const s = new OfflineDraftsStore();
    s.configure({ configDir: tmpProfile(), now: () => 5000 });
    const d = s.createNew();
    const html = '<p dir="auto">Hello <b>wrld</b></p><p dir="auto">Second</p>';
    s.update(d.id, { html });
    const before = s.drafts.find((x) => x.id === d.id)!.html;
    const rev = s.contentRev;
    ok(s.applyAiText(d.id, 'One line only.', 'replace'));
    eq(s.drafts.find((x) => x.id === d.id)!.body, 'One line only.');
    ok(s.aiNotice && s.aiNotice.warn, 'plain fallback warning');
    ok(s.contentRev > rev, 'editor refreshed');
    ok(s.canUndoAi);
    ok(s.undoAi());
    eq(s.drafts.find((x) => x.id === d.id)!.html, before);
    ok(!s.canUndoAi);
    ok(s.applyAiText(d.id, 'Added.', 'append'));
    ok(s.drafts.find((x) => x.id === d.id)!.html.includes('<b>wrld</b>'));
    ok(s.drafts.find((x) => x.id === d.id)!.body.endsWith('Added.'));
    ok(s.aiNotice && !s.aiNotice.warn);
    s.flush();
  });

  console.log('\nCategory: wiring');
  await test('scope type, auto-select on open draft, ribbon button, chips and actions', () => {
    ok(read('internal_packages/ai-sidebar/lib/core/types.ts').includes("'open-draft'"));
    const reg = read('internal_packages/ai-sidebar/lib/offline-mail/register.ts');
    ok(reg.includes('onOpenDraftChanged'));
    const ribbon = read('internal_packages/ai-sidebar/lib/offline-mail/offline-ribbon.tsx');
    ok(ribbon.includes("scope('open-draft', '📝', 'טיוטה פתוחה'"));
    const ui = read('internal_packages/ai-sidebar/lib/ai-sidebar.tsx');
    ok(ui.includes('data-scope-mode="open-draft"'));
    ok(ui.includes('DRAFT_QUICK_ACTIONS.map'));
    for (const t of ['החל על הטיוטה', 'הוסף בסוף', 'העתק', 'בטל שינוי']) {
      ok(ui.includes(t), t);
    }
    ok(!ui.includes("'בחר הודעות או תיקייה תחילה…'"), 'old hint replaced');
  });
  await test('store sends via draft transport only (no mail context, no mock)', () => {
    const st = read('internal_packages/ai-sidebar/lib/ai-sidebar-store.ts');
    const start = st.indexOf('private async _runDraftAssist(');
    ok(start > 0, 'method found');
    const body = st.slice(start, st.indexOf('\n  }\n', start));
    ok(body.includes('buildDraftAssistRequest(d, query'));
    ok(body.includes('this._draftAssistTransport('));
    ok(
      !/buildOfflineGeminiContext|searchMessages|processQuery|mockProvider|\.to\b|\.cc\b|\.bcc\b/.test(
        body
      )
    );
    ok(st.includes("if (scope.mode === 'open-draft')"));
    const ipc = read('src/browser/gemini-demo-ipc.ts');
    ok(ipc.includes('draftAssist ? [] :'), 'IPC drops messages');
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
