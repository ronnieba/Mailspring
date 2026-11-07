#!/usr/bin/env npx ts-node
/**
 * Demo sidebar readiness + fixture routing (production modules).
 *
 * Native d979449 captured Calendar/Participants with no AI tab because
 * capture used waitForLoad + 2s, while ai-sidebar was not syncInit.
 *
 * From repo root:
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-sidebar.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-demo-sidebar.ts"
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  evaluateDemoSidebarReady,
  evaluateDemoQueryComplete,
  DEMO_SIDEBAR_SNAPSHOT_JS,
  DEMO_SIDEBAR_RUN_QUERY_JS,
  DEMO_CAPTURE_QUERY,
  DemoSidebarSnapshot,
} from '../../src/demo-sidebar-readiness';
import { getDemoScope, searchDemoMessages, SYNTHETIC_MESSAGES } from './lib/synthetic-demo';

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');
const PKG_JSON = path.join(__dirname, 'package.json');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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
function assertContains(haystack: string, needle: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected to contain "${needle}"`);
  }
}

const emptySnap = (): DemoSidebarSnapshot => ({
  readyAttr: false,
  hasRoot: false,
  hasDemoBanner: false,
  hasMockWarning: false,
  scopeCount: 0,
  citationCount: 0,
  conversationCount: 0,
  tabs: ['Calendar', 'Participants'],
  reason: 'missing .ai-sidebar',
});

function run() {
  console.log('\n=== Demo sidebar readiness (runtime of production modules) ===\n');

  console.log('Category: runtime — evaluateDemoSidebarReady');
  test('d979449-style empty sidebar (Calendar/Participants only) is not ready', () => {
    const ev = evaluateDemoSidebarReady(emptySnap());
    assertFalse(ev.ready);
    assertContains(ev.reason, 'missing .ai-sidebar');
  });
  test('null snapshot is not ready', () => {
    assertFalse(evaluateDemoSidebarReady(null).ready);
  });
  test('mounted DEMO sidebar with three scopes is ready', () => {
    const ev = evaluateDemoSidebarReady({
      readyAttr: true,
      hasRoot: true,
      hasDemoBanner: true,
      hasMockWarning: true,
      scopeCount: 3,
      citationCount: 0,
      conversationCount: 0,
      tabs: ['Participants', 'Calendar', 'עוזר AI'],
    });
    assertTrue(ev.ready);
  });
  test('root without DEMO banner is not ready', () => {
    const ev = evaluateDemoSidebarReady({
      readyAttr: true,
      hasRoot: true,
      hasDemoBanner: false,
      hasMockWarning: false,
      scopeCount: 3,
      citationCount: 0,
      conversationCount: 0,
      tabs: ['עוזר AI'],
    });
    assertFalse(ev.ready);
    assertContains(ev.reason, 'DEMO/MOCK');
  });

  console.log('\nCategory: runtime — mock query completeness');
  test('no citations is incomplete', () => {
    assertFalse(
      evaluateDemoQueryComplete({
        readyAttr: true,
        hasRoot: true,
        hasDemoBanner: true,
        hasMockWarning: true,
        scopeCount: 3,
        citationCount: 0,
        conversationCount: 0,
        tabs: [],
      }).complete
    );
  });
  test('fixture citations after query is complete', () => {
    const ev = evaluateDemoQueryComplete({
      readyAttr: true,
      hasRoot: true,
      hasDemoBanner: true,
      hasMockWarning: true,
      scopeCount: 3,
      citationCount: 2,
      conversationCount: 2,
      tabs: ['עוזר AI'],
    });
    assertTrue(ev.complete);
  });

  console.log('\nCategory: runtime — fixture routing without thread selection');
  test('demo all-mail scope is non-empty synthetic', () => {
    const scope = getDemoScope('all-mail');
    assertFalse(scope.isEmpty);
    assertContains(scope.description, 'DEMO');
    assertEqual(scope.accountIds[0], 'demo-synthetic-account');
  });
  test('demo selected-messages is fixture-backed, not empty', () => {
    const scope = getDemoScope('selected-messages');
    assertFalse(scope.isEmpty);
    assertTrue((scope.messageIds || []).length > 0);
  });
  test('invoice query returns [DEMO] fixtures with subjects', () => {
    const result = searchDemoMessages(getDemoScope('all-mail'), 'חשבונית', 10, 0);
    assertTrue(result.messages.length > 0);
    assertContains(result.messages[0].subject, '[DEMO]');
    assertContains(result.messages[0].subject, 'חשבונית');
    assertTrue(SYNTHETIC_MESSAGES.length >= 4);
  });
  test('tokenized "חפש חשבוניות" still hits the invoice fixture', () => {
    const result = searchDemoMessages(getDemoScope('all-mail'), DEMO_CAPTURE_QUERY, 10, 0);
    assertTrue(result.messages.length > 0);
    assertContains(result.messages[0].subject, 'חשבונית');
  });
  test('capture query string is the Hebrew invoice search', () => {
    assertEqual(DEMO_CAPTURE_QUERY, 'חפש חשבוניות');
    assertContains(DEMO_SIDEBAR_RUN_QUERY_JS, DEMO_CAPTURE_QUERY);
    assertContains(DEMO_SIDEBAR_RUN_QUERY_JS, '__mailspringDemoSidebar');
  });

  console.log('\nCategory: runtime — snapshot script is the live DOM probe');
  test('snapshot JS looks for .ai-sidebar, DEMO banner, and scope buttons', () => {
    assertContains(DEMO_SIDEBAR_SNAPSHOT_JS, '.ai-sidebar');
    assertContains(DEMO_SIDEBAR_SNAPSHOT_JS, 'data-demo-ready');
    assertContains(DEMO_SIDEBAR_SNAPSHOT_JS, '.scope-btn');
    assertContains(DEMO_SIDEBAR_SNAPSHOT_JS, '.citation-btn');
    assertContains(DEMO_SIDEBAR_SNAPSHOT_JS, '.sidebar-panel-tab');
    assertContains(DEMO_SIDEBAR_SNAPSHOT_JS, 'מצב DEMO');
  });

  console.log('\nCategory: source-guard — capture no longer uses a fixed 2s screenshot');
  const appTs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'application.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  const mainTs = fs.readFileSync(path.join(__dirname, 'lib/main.ts'), 'utf8');
  const storeTs = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar-store.ts'), 'utf8');
  const sidebarTs = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar.tsx'), 'utf8');
  const mainJs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'main.js'), 'utf8');

  test('ai-sidebar package is syncInit so it loads with Calendar, not 800ms later', () => {
    assertTrue(pkg.syncInit === true);
  });
  test('application.ts polls evaluateDemoSidebarReady instead of setTimeout 2000', () => {
    assertContains(appTs, 'evaluateDemoSidebarReady');
    assertContains(appTs, '_captureDemoWhenReady');
    assertContains(appTs, 'DEMO_SIDEBAR_SNAPSHOT_JS');
    assertFalse(/setTimeout\(async \(\) => \{[\s\S]*capturePage[\s\S]*\}, 2000\)/.test(appTs));
  });
  test('activate() logs registration and selects the ai-sidebar panel', () => {
    assertContains(mainTs, 'AISidebar registered');
    assertContains(mainTs, "core.messageListSidebar.panel', 'ai-sidebar'");
  });
  test('demo store/UI default to all-mail fixtures', () => {
    assertContains(storeTs, "isDemoMode() ? 'all-mail'");
    assertContains(sidebarTs, "isDemoMode() ? 'all-mail'");
    assertContains(sidebarTs, 'data-demo-ready');
    assertContains(sidebarTs, '__mailspringDemoSidebar');
  });
  test('Full Scan radio has a stable AX name and stores retrievalMode', () => {
    assertContains(sidebarTs, 'aria-label="סריקה מלאה"');
    assertContains(sidebarTs, 'aria-label="דירוג (מהיר)"');
    assertContains(sidebarTs, 'data-retrieval-mode');
    assertContains(storeTs, 'this._state.retrievalMode');
  });
  test('adapter passes retrievalMode into searchDemoMessages (native full-scan bug)', () => {
    const adapterTs = fs.readFileSync(path.join(__dirname, 'lib/mailspring-adapter.ts'), 'utf8');
    assertContains(adapterTs, 'searchDemoMessages(scope, query, limit, offset, mode)');
  });
  test('coverage comes from searchResult.retrievalMode, not the radio alone', () => {
    assertContains(storeTs, 'hostCoverageFooter(searchResult');
    assertContains(storeTs, 'validateProviderPayload');
    const coverageTs = fs.readFileSync(
      path.join(__dirname, 'lib/core/coverage-disclosure.ts'),
      'utf8'
    );
    assertContains(coverageTs, "retrievalMode === 'ranked'");
    assertContains(coverageTs, 'סריקה מלאה (exhaustive)');
    assertContains(coverageTs, 'לא כל ההודעות נסרקו');
  });
  test('citation click opens a DEMO fixture preview and keeps the navigate log', () => {
    assertContains(storeTs, 'Would navigate to message:');
    assertContains(storeTs, 'Opened DEMO fixture preview');
    assertContains(storeTs, 'getDemoMessagePreview');
    assertContains(sidebarTs, 'DEMO source preview');
    assertContains(sidebarTs, 'data-demo-preview');
    assertContains(sidebarTs, 'data-message-id');
  });
  test('Cancel is visible while processing and late responses are generation-gated', () => {
    assertContains(sidebarTs, 'aria-label="ביטול"');
    assertContains(storeTs, 'shouldAcceptAssistantResponse');
    assertContains(storeTs, 'nextQueryGeneration');
    assertContains(mainJs, 'demo-delay-ms');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
