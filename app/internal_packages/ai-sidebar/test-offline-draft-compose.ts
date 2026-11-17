#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t214): "✍️ write with AI" for local drafts.
 * - new mail: instruction (+ own text, subject only when ticked) → subject +
 *   body preview; applying fills the subject only when empty or ticked, and
 *   one undo restores both body and subject;
 * - reply / forward: the original message (or up to 10 conversation
 *   messages) is sent as plain text only, truncated, never attachments or
 *   the draft's recipients; the reply goes above the quote, which stays;
 * - main process admits only that shape; IPC drops mail objects; usage is
 *   logged under its own mode (usage meter keeps working).
 * Temp folders, stubbed IPC, mocked fetch and a stubbed transport only; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-draft-compose.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

const handlers = new Map<string, (...args: any[]) => any>();
const electronPath = require.resolve('electron');
const ipcInvokes: any[] = [];
Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getLocale: () => 'he' },
    session: { defaultSession: null },
    ipcMain: { handle() {}, on() {} },
    ipcRenderer: {
      on() {},
      removeListener() {},
      send() {},
      invoke: (ch: string, ...args: any[]) => {
        ipcInvokes.push({ ch, args });
        const h = handlers.get(ch);
        if (!h) return Promise.resolve(null);
        return Promise.resolve(h({ sender: {} }, ...args));
      },
    },
  },
};
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
// The AI panel store needs only a few app globals; stub them (no app boot).
const fakeExports = path.join(os.tmpdir(), `ms-compose-fake-exports-${process.pid}.js`);
fs.writeFileSync(
  fakeExports,
  'const noop=()=>{};const store={listen:()=>noop,trigger:noop};' +
    'module.exports=new Proxy({Actions:new Proxy({},{get:()=>noop}),' +
    'WorkspaceStore:{Location:{},isLocationHidden:()=>false,listen:()=>noop},' +
    'FocusedPerspectiveStore:{current:()=>null,listen:()=>noop},' +
    'AccountStore:{accounts:()=>[],listen:()=>noop}},' +
    '{get:(t,k)=>k in t?t[k]:store});'
);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req: string, ...rest: any[]) {
  if (req === 'mailspring-exports') {
    return fakeExports;
  }
  if (req === 'mailspring-store') {
    // tsconfig "paths" alias (ts-node does not apply it).
    return path.resolve(__dirname, '..', '..', 'src', 'global', 'mailspring-store.ts');
  }
  return origResolve.call(this, req, ...rest);
};
(global as any).AppEnv = (global as any).AppEnv || {
  config: { get: () => undefined, set() {}, onDidChange: () => ({ dispose() {} }) },
  getConfigDirPath: () => os.tmpdir(),
  inDevMode: () => false,
  isMainWindow: () => true,
  themes: { onDidChangeActiveThemes: () => ({ dispose() {} }) },
};

import { setOfflineArchiveOverride } from '../../src/offline-archive';
import { setOfflineLangOverride } from './lib/core/offline-i18n';
import { OfflineDraftSource, makeForwardDraft, makeReplyDraft } from './lib/core/offline-drafts';
import {
  COMPOSE_MAX_CONTEXT_CHARS,
  COMPOSE_MAX_ORIGINAL_CHARS,
  ComposeSourceMessage,
  buildComposeContext,
  buildComposeRequest,
  cleanComposeResult,
  isNearEmptyDraft,
  messageOwnText,
  subjectToApply,
} from './lib/core/offline-draft-compose';
import { htmlToPlain } from './lib/core/offline-rich-text';
import { OfflineDraftsStore } from './lib/offline-mail/offline-drafts-store';
import {
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_PAID_ENV,
  GEMINI_IPC_QUERY,
  OFFLINE_DRAFT_COMPOSE_MAX_CONTEXT_CHARS,
  buildDraftComposeInput,
  isGeminiHostFailure,
  isGeminiHostOk,
} from '../../src/browser/gemini-demo-protocol';
import {
  GeminiFetch,
  admitOfflineDraftComposeQuery,
  runGeminiDemoQuery,
} from '../../src/browser/gemini-demo-host';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerGeminiDemoIpcHandlers } = require('../../src/browser/gemini-demo-ipc');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { draftComposeViaIpc } = require('./lib/gemini-ipc-transport');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-draft-compose-test-'));
  tmpDirs.push(d);
  return d;
}

const SRC: OfflineDraftSource = {
  id: 'offline-00000000000000aa',
  subject: 'Annual report',
  from: 'Dana Example <dana@example.test>',
  to: 'me@example.test',
  cc: '',
  date: '2026-01-02 10:00',
  text: 'ORIGINAL-LINE can we meet on Monday?\n\nOn Jan 1, Me wrote:\n> OLDER-QUOTED-LINE',
};
const FAKE_KEY = 'ms-draft-compose-test-key-not-live';
const paidEnv = { [GEMINI_DEMO_KEY_ENV]: FAKE_KEY, [GEMINI_DEMO_PAID_ENV]: '1' };
const msg = (i: number, extra = ''): ComposeSourceMessage => ({
  from: `P${i} <p${i}@example.test>`,
  date: `2026-01-0${i}`,
  subject: 'Annual report',
  text: `THREAD-${i} ${extra}`,
});

(async () => {
  setOfflineArchiveOverride(true);
  setOfflineLangOverride('he');

  console.log('Category: when write mode is on, what may leave the app');
  await test('empty / near-empty drafts default to write mode; quote not counted', () => {
    ok(isNearEmptyDraft(''));
    ok(isNearEmptyDraft('  \n שלום  '));
    ok(isNearEmptyDraft(makeReplyDraft(SRC, 1).body), 'reply with only the quote');
    ok(!isNearEmptyDraft('שלום רב, רציתי לבקש ממך את הדוח השנתי'));
  });
  await test('new mail: instruction + own text only; subject only when ticked; no context', () => {
    const d = { kind: 'new', body: '', subject: 'S1', to: 'x@example.test' };
    const b = buildComposeRequest(d, 'כתוב לי מייל לרואה החשבון', {
      context: 'SHOULD-NOT-GO',
    }) as any;
    ok(b.ok);
    eq(Object.keys(b.req).sort().join(','), 'composeKind,draftText,request');
    eq(b.req.composeKind, 'new');
    eq(b.req.draftText, '');
    const t = buildComposeRequest(d, 'x', { includeSubject: true }) as any;
    eq(t.req.draftSubject, 'S1');
  });
  await test('reply: own text without the quote + original as context; never draft recipients', () => {
    const d = makeReplyDraft(SRC, 1);
    d.to = 'dana@example.test';
    d.cc = 'boss@example.test';
    d.bcc = 'hidden@example.test';
    const ctx = buildComposeContext({ ...SRC });
    const b = buildComposeRequest(d, 'תענה שאני מסכים אבל רק ביום שלישי', {
      context: ctx.text,
    }) as any;
    ok(b.ok);
    eq(b.req.composeKind, 'reply');
    eq(b.req.draftText, '');
    ok(b.req.composeContext.includes('ORIGINAL-LINE'));
    ok(!b.req.composeContext.includes('OLDER-QUOTED-LINE'), 'old quoted history dropped');
    const all = JSON.stringify(b.req);
    for (const banned of [
      'boss@example.test',
      'hidden@example.test',
      '"to"',
      '"cc"',
      'attachments',
    ]) {
      ok(!all.includes(banned), `leaked ${banned}`);
    }
  });
  await test('context is truncated: original ≤ 12k, conversation ≤ 10 messages and ≤ 24k', () => {
    const big = buildComposeContext({ ...msg(1), text: 'א'.repeat(50000) });
    ok(big.truncated);
    ok(big.text.length < COMPOSE_MAX_ORIGINAL_CHARS + 400, String(big.text.length));
    const thread = Array.from({ length: 15 }, (_, i) => msg(i, 'ב'.repeat(6000)));
    const c = buildComposeContext(thread[14], thread);
    ok(c.messages <= 10, String(c.messages));
    ok(c.text.length <= COMPOSE_MAX_CONTEXT_CHARS, String(c.text.length));
    ok(c.truncated);
    ok(c.text.indexOf('THREAD-14') > c.text.indexOf('THREAD-13'), 'oldest first, target last');
    eq(COMPOSE_MAX_CONTEXT_CHARS, OFFLINE_DRAFT_COMPOSE_MAX_CONTEXT_CHARS);
    const t3 = [msg(1), msg(2), msg(3)];
    const small = buildComposeContext(t3[2], t3);
    eq(small.messages, 3);
    eq(small.truncated, false);
  });
  await test('message own text drops "> …" history and forwarded blocks', () => {
    eq(messageOwnText('Hi\n\nOn x, y wrote:\n> old'), 'Hi');
    eq(messageOwnText('> only\n> quoted'), '');
  });

  console.log('\nCategory: cleaning the answer and the subject rule');
  await test('Subject line inside the body is moved out; fences stripped', () => {
    const c = cleanComposeResult(
      { subject: '', body: '```\nנושא: בקשה לדוח\nשלום רב,\n```' },
      'new'
    );
    eq(c.subject, 'בקשה לדוח');
    eq(c.body, 'שלום רב,');
  });
  await test('reply answer never carries a second copy of the quote', () => {
    const c = cleanComposeResult(
      { subject: 'x', body: 'מסכים, ביום שלישי.\n\nOn Jan 2, Dana wrote:\n> ORIGINAL-LINE' },
      'reply'
    );
    eq(c.body, 'מסכים, ביום שלישי.');
  });
  await test('subject changes only when empty or ticked', () => {
    eq(subjectToApply('', 'New', false), 'New');
    eq(subjectToApply('Old', 'New', false), null);
    eq(subjectToApply('Old', 'New', true), 'New');
    eq(subjectToApply('Old', '', true), null);
  });

  console.log('\nCategory: main process');
  const base = {
    generation: 1,
    query: 'כתוב לי מייל לרואה החשבון',
    messages: [],
    mode: 'offline-draft-compose' as const,
    draftText: '',
    composeKind: 'new' as const,
  };
  await test('host admits only the compose shape', () => {
    eq(admitOfflineDraftComposeQuery(base), null);
    eq(
      admitOfflineDraftComposeQuery({
        ...base,
        composeKind: 'reply',
        composeContext: 'From: a\n\nhi',
      }),
      null
    );
    ok(admitOfflineDraftComposeQuery({ ...base, messages: [{ id: 'offline-1' } as any] }));
    ok(admitOfflineDraftComposeQuery({ ...base, composeContext: 'new mail has no context' }));
    ok(
      admitOfflineDraftComposeQuery({
        ...base,
        composeKind: 'reply',
        composeContext: 'x'.repeat(OFFLINE_DRAFT_COMPOSE_MAX_CONTEXT_CHARS + 1),
      })
    );
    ok(admitOfflineDraftComposeQuery({ ...base, composeKind: undefined } as any));
    ok(admitOfflineDraftComposeQuery({ ...base, query: ' ' }));
    ok(admitOfflineDraftComposeQuery({ ...base, allowedMessageId: 'offline-1' } as any));
  });
  await test('request = KIND/INSTRUCTION/DRAFT(/ORIGINAL) blocks; subject comes back', async () => {
    const calls: any[] = [];
    const fetch: GeminiFetch = async (url, init) => {
      calls.push(JSON.parse(init.body || '{}'));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            output_text: JSON.stringify({ subject: 'בקשה לדוח השנתי', response: 'שלום רב,' }),
            usage: { total_tokens: 9 },
          });
        },
      };
    };
    const req = { ...base, composeKind: 'reply' as const, composeContext: 'ORIGINAL-LINE' };
    const out = await runGeminiDemoQuery(req, {
      demoMode: false,
      offlineArchive: true,
      env: paidEnv,
      fetch,
    });
    ok(isGeminiHostOk(out), JSON.stringify(out));
    eq(calls[0].input, buildDraftComposeInput(req.query, 'reply', '', undefined, 'ORIGINAL-LINE'));
    ok(String(calls[0].input).includes('<<<ORIGINAL>>>\nORIGINAL-LINE'));
    ok(String(calls[0].system_instruction).includes('untrusted data'));
    ok(String(calls[0].system_instruction).includes('language of the instruction'));
    eq(calls[0].response_format.schema.properties.subject.type, 'string');
    eq((out as any).payload.composeSubject, 'בקשה לדוח השנתי');
    eq((out as any).payload.response, 'שלום רב,');
    eq((out as any).payload.citations.length, 0);
  });
  await test('mail objects with a compose request are refused before any fetch', async () => {
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
  await test('renderer → IPC → Gemini: only whitelisted fields; usage logged under its mode', async () => {
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
                output_text: JSON.stringify({ subject: 's', response: 'ok', citations: [] }),
                usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
              });
            },
          };
        },
      }
    );
    const res = await handlers.get(GEMINI_IPC_QUERY)!(
      { sender: {} },
      {
        generation: 3,
        mode: 'offline-draft-compose',
        query: 'ענה',
        draftText: '',
        composeKind: 'reply',
        composeContext: 'ORIGINAL-LINE',
        messages: [{ id: 'offline-1', subject: 'SECRET-SUBJECT', bodyText: 'SECRET-BODY' }],
        to: 'boss@example.test',
        attachments: [{ filename: 'SECRET-FILE.pdf' }],
      }
    );
    ok(isGeminiHostOk(res), JSON.stringify(res));
    const viaRenderer = await draftComposeViaIpc(4, {
      request: 'כתוב',
      draftText: '',
      composeKind: 'new',
    });
    ok(isGeminiHostOk(viaRenderer), JSON.stringify(viaRenderer));
    eq(bodies.length, 2);
    ok(bodies[0].includes('ORIGINAL-LINE'));
    for (const body of bodies) {
      for (const banned of [
        'SECRET-SUBJECT',
        'SECRET-BODY',
        'SECRET-FILE',
        'boss@example.test',
        FAKE_KEY,
      ]) {
        ok(!body.includes(banned), `leaked ${banned}`);
      }
    }
    const ledger = fs.readFileSync(path.join(dir, 'gemini-usage.json'), 'utf8');
    ok(ledger.includes('offline-draft-compose'), 'usage logged with mode');
    ok(!ledger.includes('ORIGINAL-LINE'), 'ledger has counts only');
  });

  console.log('\nCategory: applying (body + subject, one undo)');
  await test('new mail: apply fills the empty subject; undo restores body and subject', () => {
    const s = new OfflineDraftsStore();
    s.configure({ configDir: tmpProfile(), now: () => 5000 });
    const d = s.createNew();
    ok(
      s.applyAiText(d.id, 'שלום רב,\nאשמח לקבל את הדוח השנתי.\nתודה', 'replace', {
        subject: subjectToApply('', 'בקשה לדוח השנתי', false),
      })
    );
    const after = s.drafts.find((x) => x.id === d.id)!;
    eq(after.subject, 'בקשה לדוח השנתי');
    ok(after.body.startsWith('שלום רב,'));
    ok(s.aiNotice && !s.aiNotice.warn, 'no formatting warning on an empty draft');
    ok(s.undoAi());
    const back = s.drafts.find((x) => x.id === d.id)!;
    eq(back.subject, '');
    eq(back.body.trim(), '');
    s.flush();
  });
  await test('an existing subject is kept unless ticked', () => {
    const s = new OfflineDraftsStore();
    s.configure({ configDir: tmpProfile(), now: () => 5000 });
    const d = s.createNew();
    s.update(d.id, { subject: 'Mine' });
    s.applyAiText(d.id, 'Body', 'replace', { subject: subjectToApply('Mine', 'AI', false) });
    eq(s.drafts.find((x) => x.id === d.id)!.subject, 'Mine');
    s.applyAiText(d.id, 'Body2', 'replace', { subject: subjectToApply('Mine', 'AI', true) });
    eq(s.drafts.find((x) => x.id === d.id)!.subject, 'AI');
    ok(s.undoAi());
    eq(s.drafts.find((x) => x.id === d.id)!.subject, 'Mine');
    s.flush();
  });
  await test('reply: the answer goes above the quote and the quote stays intact', () => {
    const s = new OfflineDraftsStore();
    s.configure({ configDir: tmpProfile(), now: () => 5000 });
    const d = s.createReply(SRC);
    const quoteBefore = d.body.trim();
    ok(s.applyAiText(d.id, 'אני מסכים, אבל רק ביום שלישי.', 'replace', { subject: null }));
    const plain = s.drafts.find((x) => x.id === d.id)!.body;
    ok(plain.startsWith('אני מסכים, אבל רק ביום שלישי.'), plain);
    ok(plain.includes(quoteBefore.split('\n')[0]), 'wrote-line kept');
    ok(plain.includes('> ORIGINAL-LINE can we meet on Monday?'), 'quote kept');
    eq(s.drafts.find((x) => x.id === d.id)!.subject, 'Re: Annual report');
    ok(s.undoAi());
    eq(htmlToPlain(s.drafts.find((x) => x.id === d.id)!.html || '').trim(), quoteBefore);
    s.flush();
  });
  await test('forward: note above the forwarded block', () => {
    const s = new OfflineDraftsStore();
    s.configure({ configDir: tmpProfile(), now: () => 5000 });
    const d = s.createForward(SRC);
    ok(s.applyAiText(d.id, 'FYI-NOTE', 'replace'));
    const plain = s.drafts.find((x) => x.id === d.id)!.body;
    ok(plain.startsWith('FYI-NOTE'));
    ok(plain.indexOf('ORIGINAL-LINE') > plain.indexOf('FYI-NOTE'));
    s.flush();
    void makeForwardDraft;
  });

  console.log('\nCategory: AI panel store flow (stubbed transport, no Gemini)');
  await test('reply flow: original sent as text, preview message, nothing applied yet', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { offlineDraftsStore } = require('./lib/offline-mail/offline-drafts-store');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AISidebarStore = require('./lib/ai-sidebar-store').default;
    offlineDraftsStore.configure({ configDir: tmpProfile(), now: () => 7000 });
    handlers.set('gemini-demo:status', () => ({ configured: true, keyPresent: true, paid: true }));
    const sent: any[] = [];
    AISidebarStore.setDraftComposeForTests(
      async (_g: number, req: any) => {
        sent.push(req);
        return {
          ok: true,
          payload: {
            isMock: false,
            response: 'מסכים, אבל רק ביום שלישי.\n\nOn x, y wrote:\n> ECHO',
            composeSubject: '',
            citations: [],
            tokensUsed: 12,
            draftKind: 'rewrite',
          },
        };
      },
      {
        message: async (id: string) =>
          id === SRC.id
            ? { from: SRC.from, date: SRC.date, subject: SRC.subject, text: SRC.text }
            : { ...msg(1), text: 'EARLIER-MSG' },
        threadIds: () => ['offline-earlier', SRC.id],
      }
    );
    const d = offlineDraftsStore.createReply(SRC);
    await AISidebarStore.onOpenDraftChanged(d.id, null);
    eq(AISidebarStore.getState().scopeMode, 'open-draft');
    ok(AISidebarStore.getState().draftWriteMode, 'empty reply starts in write mode');
    AISidebarStore.setDraftIncludeThread(true);
    const bodyBefore = offlineDraftsStore.drafts.find((x: any) => x.id === d.id).body;
    await AISidebarStore.submitQuery('תענה שאני מסכים אבל רק ביום שלישי');
    eq(sent.length, 1);
    eq(sent[0].composeKind, 'reply');
    ok(sent[0].composeContext.includes('ORIGINAL-LINE'));
    ok(sent[0].composeContext.includes('EARLIER-MSG'), 'conversation included when ticked');
    const conv = AISidebarStore.getState().conversation;
    const last = conv[conv.length - 1];
    ok(last.draftCompose, JSON.stringify(last));
    eq(last.draftCompose.body, 'מסכים, אבל רק ביום שלישי.');
    ok(last.content.includes('בלי קבצים מצורפים'));
    eq(offlineDraftsStore.drafts.find((x: any) => x.id === d.id).body, bodyBefore);
    ok(
      ipcInvokes.some((c) => c.ch === 'gemini-demo:usage'),
      'usage meter refreshed'
    );
    offlineDraftsStore.flush();
  });

  console.log('\nCategory: wiring');
  await test('panel chip, ribbon AI tab and draft toolbar entry; disclosure text', () => {
    const ui = read('internal_packages/ai-sidebar/lib/ai-sidebar.tsx');
    for (const t of [
      'כתוב עם AI',
      'כלול את כל השיחה',
      'ההודעה המקורית',
      'החל על הטיוטה',
      'הוסף בסוף',
      'העתק',
      'גם להחליף את הנושא',
    ]) {
      ok(ui.includes(t), t);
    }
    ok(
      read('internal_packages/ai-sidebar/lib/offline-mail/offline-ribbon.tsx').includes(
        "id: 'ai-write'"
      )
    );
    ok(
      read('internal_packages/ai-sidebar/lib/offline-mail/offline-drafts-view.tsx').includes(
        'startWriteWithAi()'
      )
    );
    const ipc = read('src/browser/gemini-demo-ipc.ts');
    ok(ipc.includes("r.mode === 'offline-draft-compose'"));
    const st = read('internal_packages/ai-sidebar/lib/ai-sidebar-store.ts');
    const start = st.indexOf('private async _runDraftCompose(');
    const body = st.slice(start, st.indexOf('\n  }\n', start));
    ok(
      !/\.attachments\b|\.to\b|\.cc\b|\.bcc\b|mockProvider|withBytes/.test(body),
      'no attachments/recipients'
    );
  });

  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    fs.unlinkSync(fakeExports);
  } catch {
    // ignore
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
