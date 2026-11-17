#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t215): conversation memory for the open-draft AI.
 * Follow-ups ("shorter", "refer to the mail", "in Hebrew") are sent with the
 * earlier instructions and Gemini answers about the SAME draft (which one was
 * applied), capped at 6 turns / 16,000 characters, in memory only. Reset by
 * "🆕 New conversation", "Clear chat" or opening another draft. Both write
 * mode and draft-help (rewrite) mode share it.
 * Stubbed IPC, mocked fetch and a stubbed transport only; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-draft-conversation.ts
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
const fakeExports = path.join(os.tmpdir(), `ms-conv-fake-exports-${process.pid}.js`);
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
import { OfflineDraftSource } from './lib/core/offline-drafts';
import {
  DRAFT_HISTORY_MAX_CHARS,
  DRAFT_HISTORY_MAX_OUTPUT_CHARS,
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_PAID_ENV,
  GEMINI_IPC_QUERY,
  GEMINI_OFFLINE_DRAFT_ASSIST_SYSTEM_INSTRUCTION,
  GEMINI_OFFLINE_DRAFT_COMPOSE_SYSTEM_INSTRUCTION,
  buildDraftAssistInput,
  buildDraftComposeInput,
  draftHistoryChars,
  formatDraftHistory,
  isGeminiHostOk,
  sanitizeDraftHistory,
} from '../../src/browser/gemini-demo-protocol';
import {
  admitOfflineDraftAssistQuery,
  admitOfflineDraftComposeQuery,
} from '../../src/browser/gemini-demo-host';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerGeminiDemoIpcHandlers } = require('../../src/browser/gemini-demo-ipc');

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
const tmpDirs: string[] = [];
function tmpProfile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-draft-conv-test-'));
  tmpDirs.push(d);
  return d;
}
const SRC: OfflineDraftSource = {
  id: 'offline-00000000000000bb',
  subject: 'Schedule',
  from: 'Dana Example <dana@example.test>',
  to: 'me@example.test',
  cc: '',
  date: '2026-01-02 10:00',
  text: 'ORIGINAL-LINE can you do it this week?',
};
const FAKE_KEY = 'ms-draft-conv-test-key-not-live';
const paidEnv = { [GEMINI_DEMO_KEY_ENV]: FAKE_KEY, [GEMINI_DEMO_PAID_ENV]: '1' };
const turn = (i: number, out = 'x') => ({ instruction: `I${i}`, output: `${out}${i}` });

(async () => {
  setOfflineArchiveOverride(true);
  setOfflineLangOverride('he');

  console.log('Category: what the history may contain');
  await test('capped: last 6 turns, each answer ≤ 6,000, total ≤ 16,000; junk dropped', () => {
    const h = sanitizeDraftHistory(Array.from({ length: 9 }, (_, i) => turn(i)))!;
    eq(h.length, 6);
    eq(h[0].instruction, 'I3');
    eq(h[5].instruction, 'I8');
    const big = sanitizeDraftHistory(
      Array.from({ length: 6 }, (_, i) => ({ instruction: `I${i}`, output: 'א'.repeat(9000) }))
    )!;
    ok(big.every((t) => t.output.length <= DRAFT_HISTORY_MAX_OUTPUT_CHARS));
    ok(draftHistoryChars(big) <= DRAFT_HISTORY_MAX_CHARS, String(draftHistoryChars(big)));
    eq(big[big.length - 1].instruction, 'I5');
    const junk = sanitizeDraftHistory([
      null,
      { instruction: 1, output: 'x' },
      { instruction: 'ok', output: 'y', applied: 'bogus', to: 'boss@example.test' },
    ])!;
    eq(junk.length, 1);
    eq(junk[0].applied, null);
    ok(!JSON.stringify(junk).includes('boss@example.test'));
    eq(sanitizeDraftHistory([]), undefined);
  });
  await test('HISTORY block: oldest first, latest answer and applied state marked', () => {
    const block = formatDraftHistory([
      { instruction: 'תענה באנגלית', output: 'Hello, next week.', applied: 'replace' },
      { instruction: 'קצר', output: 'Next week.', applied: null },
    ]);
    ok(block.startsWith('<<<HISTORY>>>'));
    ok(block.indexOf('תענה באנגלית') < block.indexOf('קצר'));
    ok(block.includes('applied to the draft (replaced the text)'));
    ok(block.includes('YOUR LATEST ANSWER) - not applied'));
    eq(formatDraftHistory(undefined), '');
  });
  await test('inputs: HISTORY before the new instruction; unchanged without history', () => {
    const h = [{ instruction: 'A', output: 'B', applied: null }];
    const c = buildDraftComposeInput('NEW', 'reply', '', undefined, 'ORIG', h as any);
    ok(c.indexOf('<<<HISTORY>>>') < c.indexOf('<<<INSTRUCTION>>>\nNEW'));
    ok(c.includes('<<<ORIGINAL>>>\nORIG'));
    eq(
      buildDraftAssistInput('R', 'D'),
      '<<<REQUEST>>>\nR\n<<<END_REQUEST>>>\n<<<DRAFT>>>\nD\n<<<END_DRAFT>>>'
    );
    ok(buildDraftAssistInput('R', 'D', undefined, h as any).startsWith('<<<HISTORY>>>'));
  });
  await test('system instructions: refine the latest answer, keep earlier constraints and language', () => {
    for (const si of [
      GEMINI_OFFLINE_DRAFT_COMPOSE_SYSTEM_INSTRUCTION,
      GEMINI_OFFLINE_DRAFT_ASSIST_SYSTEM_INSTRUCTION,
    ]) {
      ok(si.includes('refine YOUR LATEST ANSWER'));
      ok(si.includes('keep every earlier requirement (language'));
      ok(si.includes('keep using it until they ask for another'));
    }
    ok(GEMINI_OFFLINE_DRAFT_COMPOSE_SYSTEM_INSTRUCTION.includes('"refer to the mail"'));
  });

  console.log('\nCategory: main process');
  await test('host admits bounded history only, in both draft modes', () => {
    const c = {
      generation: 1,
      query: 'q',
      messages: [],
      mode: 'offline-draft-compose' as const,
      draftText: '',
      composeKind: 'new' as const,
    };
    const a = { ...c, mode: 'offline-draft-assist' as const, draftText: 'text' };
    const h = [turn(1)];
    eq(admitOfflineDraftComposeQuery({ ...c, draftHistory: h }), null);
    eq(admitOfflineDraftAssistQuery({ ...a, draftHistory: h }), null);
    ok(
      admitOfflineDraftComposeQuery({
        ...c,
        draftHistory: Array.from({ length: 7 }, (_, i) => turn(i)),
      })
    );
    ok(
      admitOfflineDraftComposeQuery({
        ...c,
        draftHistory: [{ instruction: 'a', output: 'b'.repeat(7000) }],
      })
    );
    ok(
      admitOfflineDraftAssistQuery({ ...a, draftHistory: [{ ...turn(1), applied: 'sent' }] as any })
    );
    ok(admitOfflineDraftAssistQuery({ ...a, draftHistory: [] }));
  });
  await test('IPC → Gemini: history reaches the HISTORY block; extra fields dropped', async () => {
    const bodies: any[] = [];
    registerGeminiDemoIpcHandlers(
      { handle: (ch: string, fn: any) => handlers.set(ch, fn), on() {} } as any,
      {
        isDemoMode: () => false,
        isOfflineArchive: () => true,
        env: paidEnv,
        configDirPath: tmpProfile(),
        fetch: async (_url: string, init: { body?: string }) => {
          bodies.push(JSON.parse(String(init.body)));
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                output_text: JSON.stringify({ subject: '', response: 'ok', citations: [] }),
                usage: { total_tokens: 3 },
              });
            },
          };
        },
      }
    );
    const res = await handlers.get(GEMINI_IPC_QUERY)!(
      { sender: {} },
      {
        generation: 2,
        mode: 'offline-draft-compose',
        query: 'אבל תתייחס לתוכן המייל',
        draftText: '',
        composeKind: 'reply',
        composeContext: 'ORIGINAL-LINE',
        draftHistory: [
          {
            instruction: 'תענה באנגלית',
            output: 'EARLIER-ENGLISH-ANSWER',
            applied: 'replace',
            to: 'boss@example.test',
            attachments: ['SECRET-FILE'],
          },
        ],
      }
    );
    ok(isGeminiHostOk(res), JSON.stringify(res));
    const input = String(bodies[0].input);
    ok(input.includes('EARLIER-ENGLISH-ANSWER'));
    ok(input.indexOf('EARLIER-ENGLISH-ANSWER') < input.indexOf('אבל תתייחס לתוכן המייל'));
    ok(!input.includes('boss@example.test') && !input.includes('SECRET-FILE'));
    ok(!JSON.stringify(bodies[0]).includes(FAKE_KEY));
  });

  console.log('\nCategory: AI panel memory (stubbed transport, no Gemini)');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { offlineDraftsStore } = require('./lib/offline-mail/offline-drafts-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AISidebarStore = require('./lib/ai-sidebar-store').default;
  offlineDraftsStore.configure({ configDir: tmpProfile(), now: () => 7000 });
  handlers.set('gemini-demo:status', () => ({ configured: true, keyPresent: true, paid: true }));
  const sent: any[] = [];
  const answers = [
    'Hello, I can only do it next week.',
    'Hello, about the request: next week works.',
    'שלום, רק בשבוע הבא.',
  ];
  AISidebarStore.setDraftComposeForTests(
    async (_g: number, req: any) => {
      sent.push(JSON.parse(JSON.stringify(req)));
      return {
        ok: true,
        payload: {
          isMock: false,
          response: answers[(sent.length - 1) % answers.length],
          composeSubject: '',
          citations: [],
          tokensUsed: 5,
          draftKind: 'rewrite',
        },
      };
    },
    {
      message: async () => ({
        from: SRC.from,
        date: SRC.date,
        subject: SRC.subject,
        text: SRC.text,
      }),
      threadIds: () => [SRC.id],
    }
  );
  const assistSent: any[] = [];
  AISidebarStore.setDraftAssistTransportForTests(async (_g: number, req: any) => {
    assistSent.push(JSON.parse(JSON.stringify(req)));
    return {
      ok: true,
      payload: {
        isMock: false,
        response: 'Next week.',
        citations: [],
        tokensUsed: 3,
        draftKind: 'rewrite',
      },
    };
  });
  const last = () => {
    const c = AISidebarStore.getState().conversation;
    return c[c.length - 1];
  };
  let draftId = '';
  await test('first request has no history; the follow-up carries it (instruction + answer)', async () => {
    const d = offlineDraftsStore.createReply(SRC);
    draftId = d.id;
    await AISidebarStore.onOpenDraftChanged(d.id, null);
    ok(AISidebarStore.getState().draftWriteMode);
    await AISidebarStore.submitQuery('תענה באנגלית שרק שבוע הבא אוכל');
    eq(sent[0].draftHistory, undefined);
    eq(AISidebarStore.getState().draftHistoryTurns, 1);
    await AISidebarStore.submitQuery('אבל תתייחס לתוכן המייל');
    eq(sent[1].draftHistory.length, 1);
    eq(sent[1].draftHistory[0].instruction, 'תענה באנגלית שרק שבוע הבא אוכל');
    eq(sent[1].draftHistory[0].output, answers[0]);
    eq(sent[1].draftHistory[0].applied, null);
    ok(sent[1].composeContext.includes('ORIGINAL-LINE'), 'original still sent');
    ok(String(last().content).includes('המשך שיחה'), 'note says it continued');
  });
  await test('applied answer is marked; undo clears the mark', async () => {
    const msgId = last().id;
    ok(offlineDraftsStore.applyAiText(draftId, last().draftCompose.body, 'replace'));
    AISidebarStore.markDraftTurnApplied(msgId, 'replace');
    await AISidebarStore.submitQuery('בעברית');
    const h = sent[2].draftHistory;
    eq(h.length, 2);
    eq(h[1].applied, 'replace');
    ok(sent[2].draftText.startsWith('Hello, about the request'), 'current draft text sent');
    AISidebarStore.markDraftTurnApplied(last().id, 'append');
    AISidebarStore.markDraftTurnUndone();
    await AISidebarStore.submitQuery('קצר');
    eq(sent[3].draftHistory[2].applied, null);
  });
  await test('draft-help (rewrite) mode shares the same conversation', async () => {
    AISidebarStore.setDraftWriteMode(false);
    await AISidebarStore.submitQuery('תקצר');
    eq(assistSent[0].draftHistory.length, 4);
    AISidebarStore.setDraftWriteMode(true);
  });
  await test('🆕 New conversation forgets it; the next request has no history', async () => {
    AISidebarStore.resetDraftConversation();
    eq(AISidebarStore.getState().draftHistoryTurns, 0);
    ok(String(last().content).includes('שיחה חדשה'));
    await AISidebarStore.submitQuery('תענה שאני מסכים');
    eq(sent[sent.length - 1].draftHistory, undefined);
  });
  await test('opening another draft starts a new conversation automatically', async () => {
    eq(AISidebarStore.getState().draftHistoryTurns, 1);
    const d2 = offlineDraftsStore.createNew();
    await AISidebarStore.onOpenDraftChanged(d2.id, draftId);
    eq(AISidebarStore.getState().draftHistoryTurns, 0);
    await AISidebarStore.submitQuery('כתוב מייל');
    eq(sent[sent.length - 1].draftHistory, undefined);
    eq(sent[sent.length - 1].composeKind, 'new');
  });
  await test('Clear chat also forgets the draft conversation', async () => {
    eq(AISidebarStore.getState().draftHistoryTurns, 1);
    AISidebarStore.clearConversation();
    eq(AISidebarStore.getState().draftHistoryTurns, 0);
    offlineDraftsStore.flush();
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
