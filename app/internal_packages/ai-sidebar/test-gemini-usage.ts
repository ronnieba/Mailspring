#!/usr/bin/env npx ts-node
/**
 * Offline experiment: local Gemini usage ledger, cost estimate, budget warning,
 * and HTTP error classification. No network.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-gemini-usage.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GEMINI_DEFAULT_BUDGET_ILS,
  USD_TO_ILS_ESTIMATE,
} from '../../src/browser/gemini-demo-protocol';
import { classifyGeminiHttpError, readUsage } from '../../src/browser/gemini-demo-host';
import {
  GEMINI_USAGE_FILE,
  GeminiUsageLedger,
  estimateUsd,
} from '../../src/browser/gemini-usage-ledger';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
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
function near(a: number, b: number) {
  if (Math.abs(a - b) > 1e-9) throw new Error(`expected ~${b}, got ${a}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-'));

console.log('Category: usage parsing');
test('Interactions usage block', () => {
  const u = readUsage({
    usage: { total_input_tokens: 1000, total_output_tokens: 200, total_tokens: 1200 },
  });
  eq(u.inputTokens, 1000);
  eq(u.outputTokens, 200);
  eq(u.totalTokens, 1200);
});
test('generateContent usageMetadata', () => {
  const u = readUsage({
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  eq(u.inputTokens, 10);
  eq(u.outputTokens, 5);
  eq(u.totalTokens, 15);
});
test('missing usage -> zeros', () => {
  eq(readUsage({}).totalTokens, 0);
});

console.log('\nCategory: cost estimate');
test('price uses input/output per million', () => {
  near(estimateUsd('gemini-3.5-flash-lite', 1_000_000, 0, 1_000_000), 0.3);
  near(estimateUsd('gemini-3.5-flash-lite', 0, 1_000_000, 1_000_000), 2.5);
});
test('unknown split prices total as output (upper bound)', () => {
  near(estimateUsd('gemini-3.5-flash-lite', 0, 0, 1_000_000), 2.5);
});

console.log('\nCategory: ledger');
test('records, sums today/session/total, persists to profile file', () => {
  const l = new GeminiUsageLedger(dir);
  l.record({ mode: 'offline-archive-scoped', input: 1000, output: 100, total: 1100 });
  l.record({ mode: 'offline-archive-selected', input: 500, output: 50, total: 550 });
  const s = l.summary();
  eq(s.total.calls, 2);
  eq(s.today.calls, 2);
  eq(s.session.calls, 2);
  eq(s.total.totalTokens, 1650);
  near(s.total.ils, s.total.usd * USD_TO_ILS_ESTIMATE);
  ok(s.since);
  ok(fs.existsSync(path.join(dir, GEMINI_USAGE_FILE)));
  const raw = fs.readFileSync(path.join(dir, GEMINI_USAGE_FILE), 'utf8');
  ok(
    !/query|subject|body|key/i.test(
      raw.replace(/"(ts|model|mode|input|output|total|usd|version|since|budgetIls|records)"/g, '')
    ),
    'only counts stored'
  );
  const again = new GeminiUsageLedger(dir).summary();
  eq(again.total.calls, 2);
  eq(again.session.calls, 0);
});
test('older records count in total but not today', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-'));
  const l = new GeminiUsageLedger(d2);
  l.record({ input: 10, output: 1, total: 11 }, new Date(Date.now() - 3 * 86400000));
  l.record({ input: 10, output: 1, total: 11 });
  const s = l.summary();
  eq(s.total.calls, 2);
  eq(s.today.calls, 1);
});
test('default budget 60 ILS; warn at 80%', () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-'));
  const l = new GeminiUsageLedger(d3);
  eq(l.summary().budgetIls, GEMINI_DEFAULT_BUDGET_ILS);
  eq(l.summary().warn, false);
  ok(l.setBudget(1));
  // 0.8 ILS ~= 0.2508 USD ~= 100k output tokens
  l.record({ input: 0, output: 101000, total: 101000 });
  ok(l.summary().warn, 'warn at >=80%');
  ok(!l.setBudget(-5));
  eq(l.summary().budgetIls, 1);
});
test('reset clears counts but keeps budget', () => {
  const l = new GeminiUsageLedger(dir);
  l.setBudget(75);
  l.reset();
  const s = l.summary();
  eq(s.total.calls, 0);
  eq(s.budgetIls, 75);
  ok(s.since);
});

console.log('\nCategory: error classification');
const body = (code: number, status: string, message: string) =>
  JSON.stringify({ error: { code, status, message } });
test('402 -> billing-exhausted', () => {
  eq(classifyGeminiHttpError(402, '').reason, 'billing-exhausted');
});
test('429 with billing/credit text -> billing-exhausted', () => {
  eq(
    classifyGeminiHttpError(
      429,
      body(
        429,
        'RESOURCE_EXHAUSTED',
        'Your prepayment credits are depleted. Please check your plan and billing details.'
      )
    ).reason,
    'billing-exhausted'
  );
});
test('plain 429 -> rate-limited, keeps HTTP 429 tag', () => {
  const c = classifyGeminiHttpError(
    429,
    body(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).')
  );
  eq(c.reason, 'rate-limited');
  ok(c.message.includes('429'));
});
test('403 billing disabled -> billing-exhausted', () => {
  eq(
    classifyGeminiHttpError(
      403,
      body(403, 'PERMISSION_DENIED', 'Billing is disabled for this project.')
    ).reason,
    'billing-exhausted'
  );
});
test('400 FAILED_PRECONDITION -> billing-exhausted', () => {
  eq(
    classifyGeminiHttpError(
      400,
      body(400, 'FAILED_PRECONDITION', 'User location is not supported or billing not enabled')
    ).reason,
    'billing-exhausted'
  );
});
test('400 API_KEY_INVALID -> invalid-key', () => {
  eq(
    classifyGeminiHttpError(
      400,
      body(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')
    ).reason,
    'invalid-key'
  );
});
test('500 -> http-500, message has no body text', () => {
  const c = classifyGeminiHttpError(500, body(500, 'INTERNAL', 'secret-ish detail'));
  eq(c.reason, 'http-500');
  ok(!c.message.includes('secret-ish'));
});
test('messages are Hebrew and never echo Google message text', () => {
  const c = classifyGeminiHttpError(
    429,
    body(429, 'RESOURCE_EXHAUSTED', 'credit balance is zero XYZ')
  );
  ok(/[\u0590-\u05FF]/.test(c.message));
  ok(!c.message.includes('XYZ'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
