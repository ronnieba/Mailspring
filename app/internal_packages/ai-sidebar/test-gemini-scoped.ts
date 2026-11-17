#!/usr/bin/env npx ts-node
/**
 * Offline experiment: "Send" with Gemini over a scope (selected / folder / all).
 * Local retrieval + cost bounds + host admission. Mocked fetch only; no network.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-gemini-scoped.ts
 */
import {
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_PAID_ENV,
  GeminiDemoMailRef,
  OFFLINE_ARCHIVE_ACCOUNT_ID,
  OFFLINE_SCOPED_MAX_MESSAGES,
  isGeminiHostFailure,
  isGeminiHostOk,
} from '../../src/browser/gemini-demo-protocol';
import { GeminiFetch, runGeminiDemoQuery } from '../../src/browser/gemini-demo-host';
import { isAIBoundaryOk, validateProviderPayload } from './lib/core/ai-boundary';
import {
  GEMINI_SCOPED_MAX_BODY_CHARS,
  GEMINI_SCOPED_MAX_MESSAGES,
  GEMINI_SCOPED_MAX_TOTAL_CHARS,
  cleanBodyForGemini,
  estimateGeminiSendCount,
  geminiQueryTerms,
  planScopedRetrieval,
  selectScopedForGemini,
} from './lib/core/gemini-context';

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

const FAKE_KEY = 'ms-scoped-test-key-not-live';
const paidEnv = { [GEMINI_DEMO_KEY_ENV]: FAKE_KEY, [GEMINI_DEMO_PAID_ENV]: '1' };

function hex16(n: number) {
  return n.toString(16).padStart(16, '0');
}
function offlineRef(n: number, body = 'שלום'): GeminiDemoMailRef {
  return {
    id: `offline-${hex16(n)}`,
    threadId: `offline-${hex16(n)}`,
    accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
    subject: `subject ${n}`,
    from: 'a@example.test',
    date: '2026-01-01T00:00:00Z',
    snippet: body.slice(0, 40),
    bodyText: body,
  };
}
function recordingFetch(response: object) {
  const calls: Array<{ body: any }> = [];
  const fetch: GeminiFetch = async (_url, init) => {
    calls.push({ body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify(response),
          usage: { total_tokens: 9 },
        });
      },
    };
  };
  return { fetch, calls };
}

(async () => {
  console.log('Category: query terms (Hebrew-aware)');
  await test('drops stopwords and strips Hebrew prefixes', () => {
    const t = geminiQueryTerms('מה כתוב בחשבוניות של הבנק?');
    ok(t.includes('חשבונית') || t.includes('חשבוניות'), JSON.stringify(t));
    ok(t.includes('בנק'), JSON.stringify(t));
    ok(!t.includes('מה') && !t.includes('של'), JSON.stringify(t));
  });
  await test('English terms are lower-cased; stopwords removed', () => {
    const t = geminiQueryTerms('What is the Invoice total?');
    ok(t.includes('invoice'), JSON.stringify(t));
    ok(!t.includes('the') && !t.includes('is'));
  });

  console.log('\nCategory: body cleaning');
  await test('removes long URLs, quoted history and HTML; truncates', () => {
    const body =
      '<p>Hello</p> see https://example.test/' +
      'x'.repeat(60) +
      '\n> quoted line\nreal text\nOn Mon, someone wrote:\nold history';
    const c = cleanBodyForGemini(body);
    ok(!c.includes('<p>'), c);
    ok(!c.includes('xxxxxxxxxx'), c);
    ok(!c.includes('quoted line'), c);
    ok(!c.includes('old history'), c);
    ok(c.includes('real text'), c);
    ok(cleanBodyForGemini('word '.repeat(5000)).length <= GEMINI_SCOPED_MAX_BODY_CHARS + 2);
  });

  console.log('\nCategory: retrieval + budget');
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`,
    subject: i % 50 === 0 ? `חשבונית ${i}` : `newsletter ${i}`,
    from: 'x@example.test',
    ts: i,
  }));
  await test('header ranking puts keyword hits first; scan limit honored', () => {
    const plan = planScopedRetrieval(rows, 'חשבונית', 40);
    eq(plan.toScan.length, 40);
    ok(plan.toScan.slice(0, 10).every((r) => r.subject.startsWith('חשבונית')));
  });
  await test('with hits only hits are sent', () => {
    const plan = planScopedRetrieval(rows, 'חשבונית', 40);
    const scanned = plan.toScan.map((r) => ({ ...r, body: 'text' }));
    const sel = selectScopedForGemini(scanned, plan.terms);
    eq(sel.matched, 10);
    eq(sel.chosen.length, 10);
  });
  await test('without hits newest are sent, capped at max messages', () => {
    const plan = planScopedRetrieval(rows, 'סכם', 150);
    const scanned = plan.toScan.map((r) => ({ ...r, body: 'text' }));
    const sel = selectScopedForGemini(scanned, plan.terms);
    eq(sel.chosen.length, GEMINI_SCOPED_MAX_MESSAGES);
    eq(sel.chosen[0].ts, 499);
  });
  await test('character budget is never exceeded', () => {
    const scanned = rows.slice(0, 100).map((r) => ({ ...r, body: 'חשבונית '.repeat(2000) }));
    const sel = selectScopedForGemini(scanned, ['חשבונית']);
    ok(sel.totalChars <= GEMINI_SCOPED_MAX_TOTAL_CHARS, String(sel.totalChars));
    ok(sel.chosen.length <= GEMINI_SCOPED_MAX_MESSAGES);
  });
  await test('estimate is min(scope, 30)', () => {
    eq(estimateGeminiSendCount(5), 5);
    eq(estimateGeminiSendCount(24000), 30);
    eq(estimateGeminiSendCount(0), 0);
  });

  console.log('\nCategory: host admission (offline-archive-scoped)');
  await test('accepts 3 offline messages, sends bodies, uses scoped instruction', async () => {
    const msgs = [offlineRef(1, 'גוף 1'), offlineRef(2, 'גוף 2'), offlineRef(3, 'גוף 3')];
    const { fetch, calls } = recordingFetch({
      response: 'תשובה',
      citations: [{ messageId: msgs[1].id }],
    });
    const out = await runGeminiDemoQuery(
      { generation: 1, query: 'שאלה', messages: msgs, mode: 'offline-archive-scoped' },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostOk(out), JSON.stringify(out));
    eq(calls.length, 1);
    const input = JSON.stringify(calls[0].body.input);
    ok(input.includes('גוף 2'), 'body included');
    ok(String(calls[0].body.system_instruction).includes('same language'));
  });
  await test('scope facts reach Gemini; sent is forced to the real count', async () => {
    const msgs = [offlineRef(1, 'גוף 1'), offlineRef(2, 'גוף 2')];
    const { fetch, calls } = recordingFetch({ response: 'תשובה', citations: [] });
    const out = await runGeminiDemoQuery(
      {
        generation: 1,
        query: 'כמה מיילים יש בתיקייה הזו?',
        messages: msgs,
        mode: 'offline-archive-scoped',
        scopeFacts: {
          scopeKind: 'folder',
          includesSubfolders: false,
          totalInScope: 16,
          sent: 30,
          oldest: '2024-01-02T00:00:00.000Z',
          newest: '2024-11-05T00:00:00.000Z',
          distinctSenders: 4,
        },
      },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostOk(out), JSON.stringify(out));
    const input = String(calls[0].body.input);
    ok(input.includes('<<<SCOPE_FACTS>>>'), 'facts block');
    ok(input.includes('total_messages_in_scope=16'), 'total');
    ok(input.includes('messages_sent_to_you=2'), 'sent forced to request size');
    ok(input.includes('NOT including subfolders'), 'subfolders stated');
    ok(String(calls[0].body.system_instruction).includes('SCOPE_FACTS'));
  });
  await test('rejects more than 30 messages without fetching', async () => {
    const msgs = Array.from({ length: OFFLINE_SCOPED_MAX_MESSAGES + 1 }, (_, i) =>
      offlineRef(i + 1)
    );
    const { fetch, calls } = recordingFetch({ response: 'x', citations: [] });
    const out = await runGeminiDemoQuery(
      { generation: 1, query: 'q', messages: msgs, mode: 'offline-archive-scoped' },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostFailure(out));
    eq(calls.length, 0);
  });
  await test('rejects non-archive ids and oversized payloads', async () => {
    const { fetch, calls } = recordingFetch({ response: 'x', citations: [] });
    const bad = { ...offlineRef(1), id: 'real-msg-1', accountId: 'acct' };
    const o1 = await runGeminiDemoQuery(
      { generation: 1, query: 'q', messages: [bad], mode: 'offline-archive-scoped' },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostFailure(o1));
    const huge = [offlineRef(1, 'x'.repeat(90000))];
    const o2 = await runGeminiDemoQuery(
      { generation: 1, query: 'q', messages: huge, mode: 'offline-archive-scoped' },
      { demoMode: false, offlineArchive: true, env: paidEnv, fetch }
    );
    ok(isGeminiHostFailure(o2));
    eq(calls.length, 0);
  });
  await test('scoped mode is refused outside the offline experiment', async () => {
    const { fetch, calls } = recordingFetch({ response: 'x', citations: [] });
    const out = await runGeminiDemoQuery(
      { generation: 1, query: 'q', messages: [offlineRef(1)], mode: 'offline-archive-scoped' },
      { demoMode: false, offlineArchive: false, env: paidEnv, fetch }
    );
    ok(isGeminiHostFailure(out));
    eq(calls.length, 0);
  });

  console.log('\nCategory: renderer boundary');
  const payload = {
    response: 'r',
    citations: [
      {
        messageId: offlineRef(2).id,
        threadId: offlineRef(2).threadId,
        subject: offlineRef(2).subject,
        from: offlineRef(2).from,
        date: offlineRef(2).date,
        snippet: offlineRef(2).snippet,
      },
    ],
    isMock: false,
    mockLabel: 'Gemini',
  };
  await test('allowLiveOfflineScoped accepts cited allowed ids', () => {
    const v = validateProviderPayload(
      payload as any,
      {
        allowedSourceIds: new Set([offlineRef(1).id, offlineRef(2).id]),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
        allowLiveOfflineScoped: true,
        sourcesAreSynthetic: false,
      } as any
    );
    ok(isAIBoundaryOk(v), JSON.stringify(v));
  });
  await test('rejects citations outside the sent set', () => {
    const v = validateProviderPayload(
      payload as any,
      {
        allowedSourceIds: new Set([offlineRef(1).id]),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
        allowLiveOfflineScoped: true,
        sourcesAreSynthetic: false,
      } as any
    );
    ok(!isAIBoundaryOk(v));
  });
  await test('live payload without the flag is rejected', () => {
    const v = validateProviderPayload(
      payload as any,
      {
        allowedSourceIds: new Set([offlineRef(2).id]),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
        sourcesAreSynthetic: false,
      } as any
    );
    ok(!isAIBoundaryOk(v));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
