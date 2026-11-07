#!/usr/bin/env npx ts-node
/**
 * Demo query coverage, scope exclusion, cancel, and fixture preview.
 *
 * UNRUN in cloud. Parent must execute locally on Mac.
 *
 * From repo root:
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-query.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-demo-query.ts"
 */
import { MockAIProvider } from './lib/core/mock-provider';
import { buildCoverageDisclosure } from './lib/core/coverage-disclosure';
import {
  abortableDelay,
  demoQueryDelayFromEnv,
  isStaleQueryGeneration,
  nextQueryGeneration,
  parseDemoQueryDelayMs,
  shouldAcceptAssistantResponse,
} from './lib/core/query-generation';
import { SearchResult } from './lib/core/types';
import {
  DEMO_ARCHIVE_FOLDER_ID,
  DEMO_FOLDER_ID,
  DEMO_INVOICE_MESSAGE_ID,
  DEMO_MEETING_MESSAGE_ID,
  DEMO_OUTSIDE_INBOX_MESSAGE_ID,
  DEMO_OUTSIDE_INBOX_QUERY,
  SYNTHETIC_MESSAGES,
  filterDemoMessagesByScope,
  getDemoMessagePreview,
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
    throw new Error(msg || `Expected to contain "${needle}"`);
  }
}
function assertNotContains(haystack: string, needle: string, msg?: string) {
  if (haystack.includes(needle)) {
    throw new Error(msg || `Expected not to contain "${needle}"`);
  }
}

function rankedInvoice(): SearchResult {
  return searchDemoMessages(getDemoScope('all-mail'), 'חשבונית', 10, 0, 'ranked');
}

function exhaustiveOf(mode: 'all-mail' | 'current-folder' | 'selected-messages'): SearchResult {
  return searchDemoMessages(getDemoScope(mode), 'חשבונית', 10, 0, 'exhaustive');
}

function coverageFor(result: SearchResult): string {
  return buildCoverageDisclosure(result, 100);
}

async function run() {
  console.log('\n=== Demo query coverage / scope / cancel (UNRUN until local) ===\n');

  console.log('Category: ranked vs exhaustive coverage');
  await test('ranked invoice keeps top-k warning and processes the match only', () => {
    const result = rankedInvoice();
    assertEqual(result.retrievalMode, 'ranked');
    assertEqual(result.progress.processed, 1);
    assertEqual(result.messages[0].id, DEMO_INVOICE_MESSAGE_ID);
    const text = coverageFor(result);
    assertContains(text, 'דירוג (top-k)');
    assertContains(text, 'לא כל ההודעות נסרקו');
    assertContains(text, 'הודעות שעובדו: 1');
    assertNotContains(text, 'סריקה מלאה (exhaustive)');
  });

  await test('exhaustive all-mail scans every fixture, not only the invoice match', () => {
    const result = exhaustiveOf('all-mail');
    const inScope = filterDemoMessagesByScope(SYNTHETIC_MESSAGES, getDemoScope('all-mail'));
    assertEqual(result.retrievalMode, 'exhaustive');
    assertEqual(inScope.length, 6);
    assertEqual(result.progress.totalEligible, 6);
    assertEqual(result.progress.processed, 6);
    assertTrue(inScope.length > 1, 'all-mail must scan more than the invoice hit');
    assertTrue(result.progress.isComplete);
    const text = coverageFor(result);
    assertContains(text, 'סריקה מלאה (exhaustive)');
    assertContains(text, `סה"כ בטווח (נסרקו): ${inScope.length}`);
    assertContains(text, 'סריקת הטווח הושלמה');
    assertNotContains(text, 'דירוג (top-k)');
    assertNotContains(text, 'לא כל ההודעות נסרקו');
  });

  await test('exhaustive Inbox scan excludes the archive fixture', () => {
    const result = exhaustiveOf('current-folder');
    const inbox = SYNTHETIC_MESSAGES.filter((m) => m.folderId === DEMO_FOLDER_ID);
    assertEqual(inbox.length, 5);
    assertEqual(result.progress.processed, 5);
    assertEqual(result.progress.totalEligible, 5);
    assertFalse(result.messages.some((m) => m.id === DEMO_OUTSIDE_INBOX_MESSAGE_ID));
    assertTrue(result.progress.processed < SYNTHETIC_MESSAGES.length);
  });

  await test('exhaustive Selected scan is the two meeting fixtures only', () => {
    const result = exhaustiveOf('selected-messages');
    assertEqual(result.progress.processed, 2);
    assertEqual(result.progress.totalEligible, 2);
    assertFalse(result.messages.some((m) => m.id === DEMO_INVOICE_MESSAGE_ID));
    assertFalse(result.messages.some((m) => m.id === DEMO_OUTSIDE_INBOX_MESSAGE_ID));
  });

  await test('exhaustive incomplete disclosure still does not claim ranked coverage', () => {
    const incomplete: SearchResult = {
      messages: [],
      retrievalMode: 'exhaustive',
      progress: {
        totalEligible: 6,
        processed: 2,
        withBodies: 2,
        missingBodies: 0,
        syncCoverage: 100,
        isComplete: false,
        isCancelled: false,
      },
    };
    const text = coverageFor(incomplete);
    assertContains(text, 'סריקה לא הושלמה');
    assertNotContains(text, 'דירוג (top-k)');
    assertNotContains(text, 'לא כל ההודעות נסרקו');
  });

  console.log('\nCategory: outside-Inbox fixture vs All / Inbox / Selected');
  await test('outside-Inbox fixture is clearly synthetic and not in Inbox', () => {
    const msg = SYNTHETIC_MESSAGES.find((m) => m.id === DEMO_OUTSIDE_INBOX_MESSAGE_ID);
    assertTrue(!!msg);
    assertContains(msg!.subject, '[DEMO]');
    assertContains(msg!.from, 'synthetic.test');
    assertEqual(msg!.folderId, DEMO_ARCHIVE_FOLDER_ID);
    assertContains(DEMO_OUTSIDE_INBOX_QUERY, 'ארכיון');
  });

  await test('All includes the archive fixture for the archive query', () => {
    const result = searchDemoMessages(
      getDemoScope('all-mail'),
      DEMO_OUTSIDE_INBOX_QUERY,
      10,
      0,
      'ranked'
    );
    assertTrue(result.messages.some((m) => m.id === DEMO_OUTSIDE_INBOX_MESSAGE_ID));
  });

  await test('Inbox (current-folder) excludes the archive fixture', () => {
    const result = searchDemoMessages(
      getDemoScope('current-folder'),
      DEMO_OUTSIDE_INBOX_QUERY,
      10,
      0,
      'ranked'
    );
    assertFalse(result.messages.some((m) => m.id === DEMO_OUTSIDE_INBOX_MESSAGE_ID));
    assertEqual(result.messages.length, 0);
  });

  await test('Selected excludes the archive fixture', () => {
    const result = searchDemoMessages(
      getDemoScope('selected-messages'),
      DEMO_OUTSIDE_INBOX_QUERY,
      10,
      0,
      'ranked'
    );
    assertFalse(result.messages.some((m) => m.id === DEMO_OUTSIDE_INBOX_MESSAGE_ID));
    assertEqual(result.messages.length, 0);
  });

  await test('Inbox still finds the invoice; Selected still excludes it', () => {
    const inbox = searchDemoMessages(getDemoScope('current-folder'), 'חשבונית', 10, 0, 'ranked');
    const selected = searchDemoMessages(
      getDemoScope('selected-messages'),
      'חשבונית',
      10,
      0,
      'ranked'
    );
    assertEqual(inbox.messages[0].id, DEMO_INVOICE_MESSAGE_ID);
    assertEqual(selected.messages.length, 0);
  });

  console.log('\nCategory: fixture-only source preview');
  await test('invoice preview keeps Hebrew subject and source id', () => {
    const preview = getDemoMessagePreview(DEMO_INVOICE_MESSAGE_ID);
    assertTrue(!!preview);
    assertEqual(preview!.messageId, 'demo-msg-3');
    assertContains(preview!.subject, 'חשבונית');
    assertContains(preview!.subject, '[DEMO]');
    assertContains(preview!.from, 'demo-billing@synthetic.test');
    assertContains(preview!.body, '[DEMO]');
    assertContains(preview!.body, 'demo-msg-3');
    assertContains(preview!.folderName, 'תיבת דואר נכנס');
  });

  await test('meeting preview uses demo-msg-1 and unknown ids are null', () => {
    const preview = getDemoMessagePreview(DEMO_MEETING_MESSAGE_ID);
    assertEqual(preview!.messageId, 'demo-msg-1');
    assertContains(preview!.subject, 'פגישת צוות');
    assertEqual(getDemoMessagePreview('production-msg-1'), null);
  });

  console.log('\nCategory: demo delay parse + cancel / late response');
  await test('delay is ignored unless demo is enabled', () => {
    assertEqual(parseDemoQueryDelayMs(8000, false), 0);
    assertEqual(parseDemoQueryDelayMs('8000', false), 0);
    assertEqual(demoQueryDelayFromEnv({ MAILSPRING_DEMO_DELAY_MS: '8000' }), 0);
  });

  await test('demo delay parses, ignores junk, and caps at 30000', () => {
    assertEqual(parseDemoQueryDelayMs('8000', true), 8000);
    assertEqual(parseDemoQueryDelayMs(0, true), 0);
    assertEqual(parseDemoQueryDelayMs('nope', true), 0);
    assertEqual(parseDemoQueryDelayMs(99999, true), 30000);
    assertEqual(
      demoQueryDelayFromEnv({ MAILSPRING_DEMO: '1', MAILSPRING_DEMO_DELAY_MS: '8000' }),
      8000
    );
  });

  await test('abortableDelay throws when aborted during wait', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    let threw = false;
    try {
      await abortableDelay(500, controller.signal);
    } catch (e: any) {
      threw = true;
      assertContains(e.message, 'cancelled');
    }
    assertTrue(threw);
    assertTrue(Date.now() - started < 400, 'abort should not wait out the full delay');
  });

  await test('delayed mock processQuery abort does not return a response', async () => {
    const slow = new MockAIProvider(200);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const scope = getDemoScope('all-mail');
    let threw = false;
    try {
      await slow.processQuery(
        'חשבונית',
        SYNTHETIC_MESSAGES,
        scope,
        { maxMessages: 100, maxTokens: 1000, timeoutMs: 5000 },
        undefined,
        controller.signal
      );
    } catch (e: any) {
      threw = true;
      assertContains(e.message, 'cancelled');
    }
    assertTrue(threw, 'cancelled delay must not resolve a mock answer');
  });

  await test('late response is suppressed after generation bump (Cancel)', () => {
    const started = nextQueryGeneration(0);
    const afterCancel = nextQueryGeneration(started);
    assertTrue(isStaleQueryGeneration(started, afterCancel));
    assertFalse(
      shouldAcceptAssistantResponse({
        startedGeneration: started,
        currentGeneration: afterCancel,
        aborted: false,
      })
    );
    assertFalse(
      shouldAcceptAssistantResponse({
        startedGeneration: started,
        currentGeneration: started,
        aborted: true,
      })
    );
    assertTrue(
      shouldAcceptAssistantResponse({
        startedGeneration: started,
        currentGeneration: started,
        aborted: false,
      })
    );
  });

  await test('exhaustive mock search cites the invoice, not scan order', async () => {
    const result = exhaustiveOf('all-mail');
    const provider = new MockAIProvider();
    const out = await provider.processQuery(
      'חפש חשבוניות',
      result.messages,
      getDemoScope('all-mail'),
      { maxMessages: 100, maxTokens: 4000, timeoutMs: 5000 }
    );
    assertTrue(out.citations.some((c) => c.messageId === DEMO_INVOICE_MESSAGE_ID));
    assertContains(out.response, `נסרקו ${result.messages.length}`);
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('UNRUN in this cloud agent — expected counts only until local Mac run.');
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
