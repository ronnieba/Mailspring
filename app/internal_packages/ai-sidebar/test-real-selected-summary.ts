#!/usr/bin/env npx ts-node
/**
 * Opt-in real selected-single-message summary. Offline fake fixtures only.
 * No live Yahoo content, credentials, or paid Gemini calls.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-real-selected-summary.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  formatRealSelectedDisclosure,
  htmlToPlainText,
  isStaleRealSelectedSnapshot,
  prepareRealSelectedBody,
  REAL_SELECTED_MAX_BODY_CHARS,
  REAL_SELECTED_QUERY,
  resolveExactSelectedMessage,
} from './lib/core/real-selected-mail';
import {
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_MODEL,
  GEMINI_DEMO_PAID_ENV,
  GeminiDemoMailRef,
  isGeminiHostFailure,
  isGeminiHostOk,
  isSyntheticDemoMailRef,
} from '../../src/browser/gemini-demo-protocol';
import {
  GeminiFetch,
  resolveGeminiDemoStatus,
  runGeminiDemoQuery,
} from '../../src/browser/gemini-demo-host';
import { isAIBoundaryFailure, validateProviderPayload } from './lib/core/ai-boundary';
import {
  isRealSelectedSummaryMode,
  setRealSelectedSummaryOverride,
} from '../../src/real-selected-summary';

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');
const ROOT = path.resolve(__dirname, '../../..');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
    failed++;
  }
}

function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg || 'Expected true');
}
function assertFalse(v: boolean, msg?: string) {
  if (v) throw new Error(msg || 'Expected false');
}
function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertContains(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(msg || `Expected to contain ${JSON.stringify(needle)}`);
  }
}

function eligibilityReason(out: { ok: boolean; reason?: string }): string {
  if (out.ok || typeof out.reason !== 'string') {
    throw new Error(`expected eligibility failure, got ${JSON.stringify(out)}`);
  }
  return out.reason;
}

const FAKE_KEY = 'test-not-a-secret-gemini-key';
const FAKE_REAL: GeminiDemoMailRef = {
  id: 'test-real-msg-1',
  threadId: 'test-real-thread-1',
  accountId: 'test-account-1',
  subject: '[TEST] Invoice reminder',
  from: 'vendor@example.test',
  date: '2026-01-01T00:00:00Z',
  snippet: 'please pay',
  bodyText: 'Please pay invoice 99.',
};

function paidEnv(): NodeJS.ProcessEnv {
  return {
    [GEMINI_DEMO_KEY_ENV]: FAKE_KEY,
    [GEMINI_DEMO_PAID_ENV]: '1',
  };
}

function liveFetch(messageId = 'test-real-msg-1'): GeminiFetch {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: 'completed',
        output: [
          JSON.stringify({
            response: 'One-message summary of the selected TEST fixture.',
            citations: [
              {
                messageId,
                threadId: 'test-real-thread-1',
                subject: '[TEST] Invoice reminder',
                from: 'vendor@example.test',
                date: '2026-01-01T00:00:00Z',
                snippet: 'please pay',
              },
            ],
          }),
        ],
        usage: { total_tokens: 7 },
      });
    },
  });
}

function recordingFetch(impl: GeminiFetch) {
  const calls: Array<{ url: string; init: Parameters<GeminiFetch>[1] }> = [];
  const fetch: GeminiFetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { fetch, calls };
}

async function run() {
  console.log('\n=== Real selected-single-message summary (fake fixtures only) ===\n');

  console.log('Category: eligibility');
  await test('empty selection is rejected', () => {
    const out = resolveExactSelectedMessage({ threadIds: [], messages: [], expansion: {} });
    assertEqual(eligibilityReason(out), 'empty-selection');
  });

  await test('multi-thread is rejected', () => {
    const out = resolveExactSelectedMessage({
      threadIds: ['t1', 't2'],
      messages: [{ id: 'test-real-msg-1', threadId: 't1' }],
      expansion: {},
    });
    assertEqual(eligibilityReason(out), 'multi-thread');
  });

  await test('one-message thread is eligible even with default expansion', () => {
    const out = resolveExactSelectedMessage({
      threadIds: ['test-real-thread-1'],
      messages: [{ id: 'test-real-msg-1', threadId: 'test-real-thread-1' }],
      expansion: { 'test-real-msg-1': 'default' },
    });
    assertTrue(out.ok);
    assertEqual((out as { messageId: string }).messageId, 'test-real-msg-1');
  });

  await test('two messages need exactly one explicit expansion', () => {
    const ambiguous = resolveExactSelectedMessage({
      threadIds: ['test-real-thread-1'],
      messages: [
        { id: 'test-real-msg-1', threadId: 'test-real-thread-1' },
        { id: 'test-real-msg-2', threadId: 'test-real-thread-1' },
      ],
      expansion: {
        'test-real-msg-1': 'default',
        'test-real-msg-2': 'default',
      },
    });
    assertEqual(ambiguous.ok, false);
    const one = resolveExactSelectedMessage({
      threadIds: ['test-real-thread-1'],
      messages: [
        { id: 'test-real-msg-1', threadId: 'test-real-thread-1' },
        { id: 'test-real-msg-2', threadId: 'test-real-thread-1' },
      ],
      expansion: {
        'test-real-msg-1': 'explicit',
        'test-real-msg-2': 'default',
      },
    });
    assertTrue(one.ok);
    assertEqual((one as { messageId: string }).messageId, 'test-real-msg-1');
    const multi = resolveExactSelectedMessage({
      threadIds: ['test-real-thread-1'],
      messages: [
        { id: 'test-real-msg-1', threadId: 'test-real-thread-1' },
        { id: 'test-real-msg-2', threadId: 'test-real-thread-1' },
      ],
      expansion: {
        'test-real-msg-1': 'explicit',
        'test-real-msg-2': 'explicit',
      },
    });
    assertEqual(eligibilityReason(multi), 'multi-message');
  });

  console.log('\nCategory: sanitizer / disclosure');
  await test('quoted HTML is stripped and disclosed; attachments counted not sent', () => {
    const html =
      '<p>Please pay invoice 99.</p><blockquote class="gmail_quote">older mail</blockquote>';
    const prepared = prepareRealSelectedBody(html, 2);
    assertTrue(prepared.quotedStripped);
    assertFalse(prepared.bodyText.includes('older mail'));
    assertContains(prepared.bodyText, 'Please pay invoice 99.');
    assertEqual(prepared.attachmentCount, 2);
    const text = formatRealSelectedDisclosure(prepared);
    assertContains(text, 'Only this one selected message will be sent.');
    assertContains(text, '2 attachment');
    assertContains(text, 'Quoted');
  });

  await test('plain HTML entities decode and long bodies truncate', () => {
    assertEqual(htmlToPlainText('A&nbsp;&amp;&lt;b&gt;'), 'A &<b>');
    const long = `<p>${'x'.repeat(REAL_SELECTED_MAX_BODY_CHARS + 50)}</p>`;
    const prepared = prepareRealSelectedBody(long, 0);
    assertTrue(prepared.truncated);
    assertEqual(prepared.bodyText.length, REAL_SELECTED_MAX_BODY_CHARS);
    assertContains(formatRealSelectedDisclosure(prepared), 'truncated');
  });

  await test('stale snapshot detects id or epoch change', () => {
    assertTrue(
      isStaleRealSelectedSnapshot(
        { messageId: 'test-real-msg-1', snapshotEpoch: 1 },
        { messageId: 'test-real-msg-2', snapshotEpoch: 1 }
      )
    );
    assertTrue(
      isStaleRealSelectedSnapshot(
        { messageId: 'test-real-msg-1', snapshotEpoch: 1 },
        { messageId: 'test-real-msg-1', snapshotEpoch: 2 }
      )
    );
    assertFalse(
      isStaleRealSelectedSnapshot(
        { messageId: 'test-real-msg-1', snapshotEpoch: 3 },
        { messageId: 'test-real-msg-1', snapshotEpoch: 3 }
      )
    );
  });

  console.log('\nCategory: host fail-closed (mocked fetch, no paid call)');
  await test('demo mode still rejects the fake real fixture', async () => {
    let called = false;
    const fetch: GeminiFetch = async () => {
      called = true;
      throw new Error('must not fetch');
    };
    const out = await runGeminiDemoQuery(
      {
        generation: 1,
        query: REAL_SELECTED_QUERY,
        messages: [FAKE_REAL],
        mode: 'real-selected-single',
        allowedMessageId: FAKE_REAL.id,
        snapshotEpoch: 1,
      },
      { demoMode: true, realSelectedSummary: true, env: paidEnv(), fetch }
    );
    assertTrue(isGeminiHostFailure(out));
    if (isGeminiHostFailure(out)) assertEqual(out.reason, 'non-synthetic-source');
    assertFalse(called);
    assertFalse(isSyntheticDemoMailRef(FAKE_REAL));
  });

  await test('without the opt-in flag, real query stays unconfigured', async () => {
    let called = false;
    const fetch: GeminiFetch = async () => {
      called = true;
      throw new Error('must not fetch');
    };
    const status = resolveGeminiDemoStatus({ demoMode: false, env: paidEnv() });
    assertFalse(status.configured);
    const out = await runGeminiDemoQuery(
      {
        generation: 1,
        query: REAL_SELECTED_QUERY,
        messages: [FAKE_REAL],
        mode: 'real-selected-single',
        allowedMessageId: FAKE_REAL.id,
        snapshotEpoch: 1,
      },
      { demoMode: false, env: paidEnv(), fetch }
    );
    assertTrue(isGeminiHostFailure(out));
    if (isGeminiHostFailure(out)) assertEqual(out.reason, 'unconfigured');
    assertFalse(called);
  });

  await test('real path rejects missing snapshot, wrong id, synthetic id, extra messages', async () => {
    const { fetch, calls } = recordingFetch(liveFetch());
    const deps = {
      demoMode: false,
      realSelectedSummary: true,
      env: paidEnv(),
      fetch,
    };
    const base = {
      generation: 1,
      query: REAL_SELECTED_QUERY,
      messages: [FAKE_REAL],
      mode: 'real-selected-single' as const,
      allowedMessageId: FAKE_REAL.id,
      snapshotEpoch: 1,
    };
    const noEpoch = await runGeminiDemoQuery({ ...base, snapshotEpoch: undefined }, deps);
    assertEqual(noEpoch.ok, false);
    const wrongId = await runGeminiDemoQuery({ ...base, allowedMessageId: 'other-id' }, deps);
    assertEqual(wrongId.ok, false);
    const synthetic = await runGeminiDemoQuery(
      {
        ...base,
        messages: [
          {
            id: 'demo-msg-1',
            threadId: 'demo-thread-1',
            accountId: 'demo-synthetic-account',
            subject: '🧪 [DEMO] test',
            from: 'demo-manager@synthetic.test',
            date: '2024-11-01T00:00:00Z',
            snippet: 'fixture',
            bodyText: 'synthetic body',
          },
        ],
        allowedMessageId: 'demo-msg-1',
      },
      deps
    );
    assertEqual(synthetic.ok, false);
    const extra = await runGeminiDemoQuery(
      {
        ...base,
        messages: [FAKE_REAL, { ...FAKE_REAL, id: 'test-real-msg-2' }],
      },
      deps
    );
    assertEqual(extra.ok, false);
    assertEqual(calls.length, 0);
  });

  await test('admitted fake real message includes body and pinned model only', async () => {
    const { fetch, calls } = recordingFetch(liveFetch());
    const out = await runGeminiDemoQuery(
      {
        generation: 1,
        query: REAL_SELECTED_QUERY,
        messages: [FAKE_REAL],
        mode: 'real-selected-single',
        allowedMessageId: FAKE_REAL.id,
        snapshotEpoch: 4,
      },
      { demoMode: false, realSelectedSummary: true, env: paidEnv(), fetch }
    );
    assertTrue(isGeminiHostOk(out));
    if (isGeminiHostOk(out)) {
      assertEqual(out.payload.isMock, false);
      assertEqual((out.payload.citations[0] as { messageId: string }).messageId, 'test-real-msg-1');
    }
    assertEqual(calls.length, 1);
    const body = calls[0].init.body || '';
    assertContains(body, GEMINI_DEMO_MODEL);
    assertContains(body, 'body=Please pay invoice 99.');
    assertContains(body, 'one user-selected email message');
    assertFalse(body.includes(FAKE_KEY));
  });

  await test('citations outside the allowed fake id fail closed at the boundary', () => {
    const out = validateProviderPayload(
      {
        isMock: false,
        response: 'x',
        citations: [
          {
            messageId: 'some-other-msg',
            threadId: 'test-real-thread-1',
            subject: '[TEST]',
            from: 'vendor@example.test',
            date: new Date('2026-01-01T00:00:00Z'),
            snippet: 'nope',
          },
        ],
      },
      {
        allowedSourceIds: new Set(['test-real-msg-1']),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
        allowLiveRealSelectedSingle: true,
        sourcesAreSynthetic: false,
      }
    );
    assertTrue(isAIBoundaryFailure(out));
    if (isAIBoundaryFailure(out)) assertEqual(out.reason, 'unknown-source-id');
  });

  console.log('\nCategory: detector / source-guards');
  await test('detector override and --demo win', () => {
    setRealSelectedSummaryOverride(true);
    assertTrue(isRealSelectedSummaryMode());
    setRealSelectedSummaryOverride(false);
    assertFalse(isRealSelectedSummaryMode());
    setRealSelectedSummaryOverride(null);
  });

  await test('launcher never points at official profile or --demo', () => {
    const script = fs.readFileSync(
      path.join(ROOT, 'scripts/start-real-selected-summary.sh'),
      'utf8'
    );
    assertContains(script, '--real-selected-summary');
    assertContains(script, '--dev');
    assertContains(script, 'env -u MAILSPRING_DEMO_GEMINI_API_KEY');
    const execLines = script.split('\n').filter((l) => l.includes('"$ELECTRON" "$ROOT/app"'));
    assertTrue(execLines.length > 0);
    for (const line of execLines) {
      assertFalse(line.includes('--demo'));
      assertFalse(line.includes('--user-data-dir'));
      assertContains(line, '--dev');
      assertContains(line, '--real-selected-summary');
    }
    assertContains(script, 'Never --demo. Never --user-data-dir');
    assertContains(script, 'Mailspring-dev');
    assertContains(script, '/Applications/Mailspring.app is unused');
    assertContains(script, 'never copies');
  });

  await test('store does not generate on refreshScope; summarize is explicit', () => {
    const store = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar-store.ts'), 'utf8');
    assertContains(store, 'summarizeSelectedMessage');
    assertContains(store, 'isStaleRealSelectedSnapshot');
    assertContains(store, 'allowLiveRealSelectedSingle');
    assertContains(store, 'Free-form mailbox search is disabled');
    assertFalse(store.includes('setFocus'));
    const refresh = store.slice(
      store.indexOf('async refreshScope'),
      store.indexOf('async refreshGeminiStatus')
    );
    assertFalse(refresh.includes('processQuery'));
    assertFalse(refresh.includes('runGeminiDemoQuery'));
    assertContains(store, 'isRealSelectedSummaryMode()');
    const nav = store.slice(store.indexOf('async navigateToCitation'));
    assertContains(nav, 'isRealSelectedSummaryMode()');
    assertContains(nav, 'in-sidebar preview, not marked read');
  });

  await test('sidebar preview + Summarize; no send/delete/move', () => {
    const sidebar = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar.tsx'), 'utf8');
    assertContains(sidebar, 'data-real-selected-summary');
    assertContains(sidebar, 'data-real-selected-summarize');
    assertContains(sidebar, 'summarizeSelectedMessage');
    assertContains(sidebar, '_renderRealSelectionPreview');
    assertFalse(sidebar.includes('Actions.queueTask'));
    const adapter = fs.readFileSync(path.join(__dirname, 'lib/mailspring-adapter.ts'), 'utf8');
    assertContains(adapter, 'focusedThreadMessages');
    assertContains(adapter, 'MessageStore.items()');
    assertContains(adapter, 'itemsExpandedState');
    assertContains(adapter, 'can mark it read');
    const appTs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'application.ts'), 'utf8');
    assertContains(appTs, 'realSelectedSummary');
    assertContains(appTs, '_mainWindowOptions');
    assertContains(appTs, 'Official /Applications/Mailspring.app is unused');
    const migrateBlock = appTs.slice(
      appTs.indexOf('if (this.demoMode)'),
      appTs.indexOf('} catch (err)')
    );
    assertContains(migrateBlock, 'Skipping mailsync migrate');
    assertContains(migrateBlock, 'this.realSelectedSummary');
    assertContains(migrateBlock, 'await mailsync.migrate()');
  });

  await test('docs name isolated Mailspring-dev login and forbid official-profile copy', () => {
    const guide = fs.readFileSync(path.join(__dirname, 'MAC-BUILD-GUIDE.md'), 'utf8');
    assertContains(guide, 'start-real-selected-summary.sh');
    assertContains(guide, 'Mailspring-dev');
    assertContains(guide, 'Do not copy');
    assertContains(guide, '/Applications/Mailspring.app');
    assertContains(guide, 'test-real-selected-summary.ts');
    assertContains(guide, 'one selected message');
    assertFalse(guide.includes('copy the production profile'));
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
