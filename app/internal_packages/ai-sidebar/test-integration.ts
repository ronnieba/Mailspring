#!/usr/bin/env npx ts-node
/**
 * Mixed checks for demo fixtures + portable source-path guards.
 *
 * Categories are printed on each section:
 * - runtime: executes production fixture helpers
 * - source-guard: reads sibling source files via path relative to THIS file
 *   (not /workspace). These do not prove Electron runtime.
 *
 * Run from any cwd:
 *   npx ts-node /absolute/path/to/app/internal_packages/ai-sidebar/test-integration.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  SYNTHETIC_MESSAGES,
  getDemoScope,
  searchDemoMessages,
  getDemoMessageBody,
} from './lib/synthetic-demo';
import { setDemoModeOverride, isDemoMode, _resetDemoModeCache } from '../../src/demo-mode';

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');

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

function assertTrue(value: boolean, msg?: string) {
  if (!value) throw new Error(msg || 'Expected true');
}
function assertFalse(value: boolean, msg?: string) {
  if (value) throw new Error(msg || 'Expected false');
}
function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) throw new Error(msg || `Expected ${expected}, got ${actual}`);
}
function assertContains(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) throw new Error(msg || `Expected to contain "${needle}"`);
}

async function runTests() {
  console.log('\n=== AI Sidebar integration / portable guards ===\n');
  console.log(`APP_SRC_ROOT=${APP_SRC_ROOT}`);
  console.log(`cwd=${process.cwd()}\n`);

  console.log('Category: runtime — demo-mode.ts');
  await test('isDemoMode is false by default (empty accounts are not demo)', () => {
    setDemoModeOverride(null);
    delete process.env.MAILSPRING_DEMO;
    _resetDemoModeCache();
    assertFalse(isDemoMode());
  });
  await test('setDemoModeOverride(true) is explicit demo', () => {
    setDemoModeOverride(true);
    assertTrue(isDemoMode());
    setDemoModeOverride(null);
    _resetDemoModeCache();
  });
  await test('MAILSPRING_DEMO=1 is explicit demo', () => {
    process.env.MAILSPRING_DEMO = '1';
    _resetDemoModeCache();
    assertTrue(isDemoMode());
    delete process.env.MAILSPRING_DEMO;
    _resetDemoModeCache();
  });

  console.log('\nCategory: runtime — synthetic fixtures');
  await test('SYNTHETIC_MESSAGES are clearly marked', () => {
    assertTrue(SYNTHETIC_MESSAGES.length > 0);
    for (const msg of SYNTHETIC_MESSAGES) {
      assertContains(msg.subject, '[DEMO]');
      assertContains(msg.from, 'synthetic.test');
      assertContains(msg.id, 'demo-');
    }
  });
  await test('getDemoScope labels all three modes', () => {
    assertContains(getDemoScope('selected-messages').description, 'DEMO');
    assertContains(getDemoScope('current-folder').description, 'DEMO');
    assertContains(getDemoScope('all-mail').description, 'DEMO');
    assertFalse(getDemoScope('selected-messages').isEmpty);
  });
  await test('searchDemoMessages paginates without overlap', () => {
    const scope = getDemoScope('all-mail');
    const page1 = searchDemoMessages(scope, '', 2, 0);
    const page2 = searchDemoMessages(scope, '', 2, 2);
    assertEqual(page1.messages.length, 2);
    const ids1 = page1.messages.map((m) => m.id);
    for (const id of page2.messages.map((m) => m.id)) {
      assertFalse(ids1.includes(id));
    }
  });
  await test('searchDemoMessages supports Hebrew query', () => {
    const result = searchDemoMessages(getDemoScope('all-mail'), 'חשבונית', 10, 0);
    assertTrue(result.messages.length > 0);
    assertContains(result.messages[0].subject, 'חשבונית');
  });
  await test('getDemoMessageBody returns synthetic text only', () => {
    const body = getDemoMessageBody('demo-msg-1');
    assertTrue(!!body);
    assertContains(body || '', '[DEMO]');
    assertEqual(getDemoMessageBody('nope'), null);
  });

  console.log('\nCategory: source-guard (portable paths, not Electron runtime)');
  const appTs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'application.ts'), 'utf8');
  const mainJs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'main.js'), 'utf8');
  const isolationJs = fs.readFileSync(
    path.join(APP_SRC_ROOT, 'browser', 'dev-isolation.js'),
    'utf8'
  );
  const keyManager = fs.readFileSync(path.join(APP_SRC_ROOT, 'key-manager.ts'), 'utf8');

  await test('application.ts skips protocol registration outside production', () => {
    assertContains(appTs, '!this.devMode && !this.specMode');
    assertContains(appTs, 'setAsDefaultProtocolClient');
  });
  await test('main.js applies isolationIdentity before setName / paths', () => {
    assertContains(mainJs, 'isolationIdentity');
    assertContains(mainJs, 'app.setName(identity.appName)');
    assertContains(mainJs, "appendSwitch('use-mock-keychain')");
    assertContains(mainJs, "appendSwitch('crash-dumps-dir'");
  });
  await test('main.js skips single-instance lock when identity says so', () => {
    assertContains(mainJs, 'skipSingleInstanceLock');
    assertContains(mainJs, 'requestSingleInstanceLock');
  });
  await test('dev-isolation.js keeps production name Mailspring', () => {
    assertContains(isolationJs, "appName: 'Mailspring'");
    assertContains(isolationJs, "appName: 'Mailspring-demo'");
    assertContains(isolationJs, "appName: 'Mailspring-dev'");
  });
  await test('application.ts opens main window in demoMode, not onboarding', () => {
    assertContains(appTs, 'if (this.demoMode)');
    assertContains(appTs, 'demoMode: true');
    assertContains(appTs, 'Skipping mailsync migrate');
    assertContains(appTs, 'capturePage');
    assertContains(appTs, 'evaluateDemoSidebarReady');
  });
  await test('application.ts does not rebuild/relaunch the mail cache in demo', () => {
    assertContains(appTs, 'mailCacheRecoveryAction');
    assertContains(appTs, 'Ignoring application:reset-database');
  });
  await test('main.js does not create a stub edgehill.db', () => {
    assertFalse(/stub edgehill\.db/.test(mainJs));
    assertFalse(/edgehill\.db/.test(mainJs));
  });
  await test('default-client notification is skipped in demo', () => {
    const notif = fs.readFileSync(
      path.join(__dirname, '../notifications/lib/items/default-client-notif.tsx'),
      'utf8'
    );
    assertContains(notif, 'isDemoMode()');
    assertContains(notif, "registerForURLScheme('mailto'");
  });
  await test('key-manager never loads safeStorage at module top', () => {
    assertFalse(
      /^const \{ safeStorage \} = require\('@electron\/remote'\)/m.test(keyManager),
      'must not bind safeStorage at module load'
    );
    assertContains(keyManager, 'function nativeSafeStorage');
    assertContains(keyManager, 'if (isDemoMode())');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
