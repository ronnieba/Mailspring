#!/usr/bin/env npx ts-node
/**
 * Provider-neutral AI boundary: host-calculated 2/5/6 coverage, fail-closed
 * schema/citation checks, mock-subprocess cancel/timeout/stale.
 *
 * UNRUN in cloud. Parent must execute locally on Mac.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-ai-boundary.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-ai-boundary.ts"
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  LIVE_AI_DISABLED_REASON,
  LIVE_AI_PROVIDERS_ENABLED,
  hostCoverageFooter,
  mockOnlyProviderGuard,
  validateProviderPayload,
} from './lib/core/ai-boundary';
import {
  MOCK_AI_WORKER_PATH,
  mockAiSpawnPlan,
  runMockAiSubprocess,
} from './lib/core/mock-ai-subprocess';
import { SearchResult } from './lib/core/types';
import {
  DEMO_EXHAUSTIVE_COUNTS,
  SYNTHETIC_MESSAGES,
  filterDemoMessagesByScope,
  getDemoScope,
  searchDemoMessages,
} from './lib/synthetic-demo';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e: any) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${e.message}`);
      failed++;
    }
  })();
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

function exhaustive(mode: 'selected-messages' | 'current-folder' | 'all-mail'): SearchResult {
  return searchDemoMessages(getDemoScope(mode), 'חשבונית', 10, 0, 'exhaustive');
}

function validPayload(messageId: string) {
  return {
    isMock: true as const,
    mockLabel: 'Mock AI (No External Connection)',
    response: '🔧 MOCK — deterministic',
    tokensUsed: 3,
    citations: [
      {
        messageId,
        threadId: 'demo-thread-1',
        subject: '🧪 [DEMO] test',
        from: 'demo@synthetic.test',
        date: new Date('2024-11-01T00:00:00Z'),
        snippet: 'fixture',
      },
    ],
  };
}

async function run() {
  console.log('\n=== AI boundary / coverage 2-5-6 / mock subprocess (UNRUN until local) ===\n');

  console.log('Category: live providers disabled');
  await test('live providers stay disabled and non-mock is rejected', () => {
    assertEqual(LIVE_AI_PROVIDERS_ENABLED, false);
    assertTrue(mockOnlyProviderGuard(true) === null);
    const blocked = mockOnlyProviderGuard(false);
    assertTrue(!!blocked && blocked.ok === false);
    assertEqual(blocked!.reason, 'not-mock');
    assertContains(LIVE_AI_DISABLED_REASON, 'Live AI providers are disabled');
  });

  console.log('\nCategory: host-calculated selected/folder/all coverage 2/5/6');
  await test('exhaustive selected is 2, folder 5, all 6', () => {
    assertEqual(DEMO_EXHAUSTIVE_COUNTS['selected-messages'], 2);
    assertEqual(DEMO_EXHAUSTIVE_COUNTS['current-folder'], 5);
    assertEqual(DEMO_EXHAUSTIVE_COUNTS['all-mail'], 6);
    const selected = exhaustive('selected-messages');
    const folder = exhaustive('current-folder');
    const all = exhaustive('all-mail');
    assertEqual(selected.progress.processed, 2);
    assertEqual(selected.progress.totalEligible, 2);
    assertEqual(folder.progress.processed, 5);
    assertEqual(folder.progress.totalEligible, 5);
    assertEqual(all.progress.processed, 6);
    assertEqual(all.progress.totalEligible, 6);
    assertEqual(filterDemoMessagesByScope(SYNTHETIC_MESSAGES, getDemoScope('all-mail')).length, 6);
  });

  await test('host coverage footer uses SearchResult, not a provider-claimed count', () => {
    const all = exhaustive('all-mail');
    const text = hostCoverageFooter(all, 100);
    assertContains(text, 'סריקה מלאה (exhaustive)');
    assertContains(text, 'סה"כ בטווח (נסרקו): 6');
    assertFalse(text.includes('נסרקו): 1'), 'must not adopt a fake top-k count');
  });

  console.log('\nCategory: fail-closed schema and citations');
  await test('valid marked mock with in-scope citation is accepted', () => {
    const id = 'demo-msg-1';
    const out = validateProviderPayload(validPayload(id), {
      allowedSourceIds: new Set([id]),
      startedGeneration: 1,
      currentGeneration: 1,
      aborted: false,
    });
    assertTrue(out.ok);
    if (out.ok) {
      assertEqual(out.origin, 'mock');
      assertEqual(out.result.isMock, true);
      assertEqual(out.result.citations[0].messageId, id);
      assertContains(out.result.mockLabel, 'Mock');
    }
  });

  await test('unknown source id fails closed and does not substitute demo output', () => {
    const out = validateProviderPayload(validPayload('production-msg-1'), {
      allowedSourceIds: new Set(['demo-msg-1', 'demo-msg-2']),
      startedGeneration: 1,
      currentGeneration: 1,
      aborted: false,
    });
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.reason, 'unknown-source-id');
      assertEqual(out.origin, 'local');
    }
  });

  await test('invalid schema fails closed', () => {
    const out = validateProviderPayload(
      { isMock: true, response: 12 },
      {
        allowedSourceIds: new Set(['demo-msg-1']),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
      }
    );
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.reason, 'invalid-schema');
    }
  });

  await test('isMock false is rejected as live-disabled/not-mock', () => {
    const out = validateProviderPayload(
      { isMock: false, response: 'secret', citations: [] },
      {
        allowedSourceIds: new Set(['demo-msg-1']),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
      }
    );
    assertFalse(out.ok);
    if (!out.ok) {
      assertTrue(out.reason === 'live-disabled' || out.reason === 'not-mock');
    }
  });

  await test('bidi spoof citation id does not match a real source id', () => {
    const out = validateProviderPayload(validPayload('\u202edemo-msg-1'), {
      allowedSourceIds: new Set(['demo-msg-1']),
      startedGeneration: 1,
      currentGeneration: 1,
      aborted: false,
    });
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.reason, 'unknown-source-id');
    }
  });

  await test('local abort and stale generation are not remote completion', () => {
    const cancelled = validateProviderPayload(validPayload('demo-msg-1'), {
      allowedSourceIds: new Set(['demo-msg-1']),
      startedGeneration: 1,
      currentGeneration: 1,
      aborted: true,
    });
    assertFalse(cancelled.ok);
    if (!cancelled.ok) {
      assertEqual(cancelled.origin, 'local');
      assertEqual(cancelled.reason, 'cancelled');
    }
    const stale = validateProviderPayload(validPayload('demo-msg-1'), {
      allowedSourceIds: new Set(['demo-msg-1']),
      startedGeneration: 1,
      currentGeneration: 2,
      aborted: false,
    });
    assertFalse(stale.ok);
    if (!stale.ok) {
      assertEqual(stale.origin, 'local');
      assertEqual(stale.reason, 'stale-generation');
    }
  });

  console.log('\nCategory: mock subprocess argv / UTF-8 / lifecycle');
  await test('spawn plan is fixed exec+args, no shell, query not on argv', () => {
    const plan = mockAiSpawnPlan();
    assertEqual(plan.execPath, process.execPath);
    assertEqual(plan.args.length, 1);
    assertEqual(plan.args[0], MOCK_AI_WORKER_PATH);
    assertEqual(plan.options.shell, false);
    const joined = `${plan.execPath} ${plan.args.join(' ')}`;
    assertFalse(joined.includes('חפש'));
    assertFalse(joined.includes('$(reboot)'));
    assertFalse(joined.includes('rm -rf'));
    const worker = fs.readFileSync(MOCK_AI_WORKER_PATH, 'utf8');
    assertFalse(/https?:\/\//.test(worker));
    assertFalse(worker.includes('fetch('));
    assertFalse(worker.includes('openai'));
    assertFalse(worker.includes('anthropic'));
  });

  await test('subprocess UTF-8 Hebrew query round-trips as marked mock', async () => {
    const adversarial = 'חפש חשבוניות $(reboot); `id` \u202eLTR';
    const out = await runMockAiSubprocess(
      {
        op: 'ok',
        generation: 1,
        query: adversarial,
        allowedSourceIds: ['demo-msg-3'],
      },
      { timeoutMs: 4000, currentGeneration: () => 1 }
    );
    assertTrue(out.ok, out.ok ? '' : out.message);
    if (out.ok) {
      assertEqual(out.origin, 'mock');
      assertEqual(out.result.isMock, true);
      assertContains(out.result.response, 'MOCK');
      assertContains(out.result.response, 'חפש חשבוניות');
      assertEqual(out.result.citations[0].messageId, 'demo-msg-3');
    }
  });

  await test('subprocess unknown citation is fail-closed', async () => {
    const out = await runMockAiSubprocess(
      {
        op: 'unknown-citation',
        generation: 1,
        query: 'x',
        allowedSourceIds: ['demo-msg-1'],
        unknownId: 'production-msg-1',
      },
      { timeoutMs: 4000, currentGeneration: () => 1 }
    );
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.reason, 'unknown-source-id');
    }
  });

  await test('subprocess bidi citation is fail-closed', async () => {
    const out = await runMockAiSubprocess(
      {
        op: 'bidi-citation',
        generation: 1,
        query: 'x',
        allowedSourceIds: ['demo-msg-1'],
      },
      { timeoutMs: 4000, currentGeneration: () => 1 }
    );
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.reason, 'unknown-source-id');
    }
  });

  await test('subprocess cancel is local and yields no answer', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const out = await runMockAiSubprocess(
      {
        op: 'delay',
        delayMs: 800,
        generation: 1,
        query: 'x',
        allowedSourceIds: ['demo-msg-1'],
      },
      { timeoutMs: 4000, signal: controller.signal, currentGeneration: () => 1 }
    );
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.origin, 'local');
      assertEqual(out.reason, 'cancelled');
    }
    assertTrue(Date.now() - started < 600, 'local cancel must not wait out the worker delay');
  });

  await test('subprocess timeout is local and yields no answer', async () => {
    const out = await runMockAiSubprocess(
      {
        op: 'hang',
        generation: 1,
        query: 'x',
        allowedSourceIds: ['demo-msg-1'],
      },
      { timeoutMs: 80, currentGeneration: () => 1 }
    );
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.origin, 'local');
      assertEqual(out.reason, 'timeout');
    }
  });

  await test('subprocess stale generation is rejected after a newer query', async () => {
    let gen = 1;
    const pending = runMockAiSubprocess(
      {
        op: 'delay',
        delayMs: 60,
        generation: 1,
        query: 'x',
        allowedSourceIds: ['demo-msg-1'],
      },
      { timeoutMs: 4000, currentGeneration: () => gen }
    );
    gen = 2;
    const out = await pending;
    assertFalse(out.ok);
    if (!out.ok) {
      assertEqual(out.origin, 'local');
      assertEqual(out.reason, 'stale-generation');
    }
  });

  await test('worker and store keep fail-closed source paths', () => {
    const store = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar-store.ts'), 'utf8');
    assertContains(store, 'validateProviderPayload');
    assertContains(store, 'hostCoverageFooter');
    assertContains(store, 'mockOnlyProviderGuard');
    const worker = fs.readFileSync(MOCK_AI_WORKER_PATH, 'utf8');
    assertContains(worker, 'MOCK subprocess');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('UNRUN in this cloud agent — expected 17 until local Mac run.');
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
