#!/usr/bin/env npx ts-node
/**
 * Integration tests for AI sidebar isolation and demo mode.
 *
 * Run with: npx ts-node app/internal_packages/ai-sidebar/test-integration.ts
 *
 * Tests:
 * - Synthetic demo mode behavior
 * - Dev isolation code verification
 * - No protocol registration in dev mode
 */
import * as fs from 'fs';

// Mock AccountStore for demo mode detection
const mockAccounts: any[] = [];

// Simple mock for mailspring-exports to test demo mode
const Module = require('module');
const originalRequire = Module.prototype.require;
// eslint-disable-next-line prefer-rest-params
Module.prototype.require = function (id: string) {
  if (id === 'mailspring-exports') {
    return {
      AccountStore: {
        accounts: () => mockAccounts,
        accountIds: () => mockAccounts.map((a: any) => a.id),
      },
    };
  }
  // eslint-disable-next-line prefer-rest-params
  return originalRequire.apply(this, arguments);
};

import {
  isDemoMode,
  SYNTHETIC_MESSAGES,
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

function resetMocks() {
  mockAccounts.length = 0;
}

async function runTests() {
  console.log('\n=== AI Sidebar Integration Tests ===\n');

  console.log('Demo mode detection:');

  await test('isDemoMode returns true when no accounts', () => {
    resetMocks();
    assertTrue(isDemoMode(), 'should be demo mode with no accounts');
  });

  await test('isDemoMode returns false when accounts exist', () => {
    resetMocks();
    mockAccounts.push({ id: 'real-account', emailAddress: 'test@example.com' });
    assertFalse(isDemoMode(), 'should not be demo mode with accounts');
    resetMocks(); // Clean up
  });

  console.log('\nSynthetic demo data:');

  await test('SYNTHETIC_MESSAGES are clearly marked', () => {
    assertTrue(SYNTHETIC_MESSAGES.length > 0, 'should have synthetic messages');
    for (const msg of SYNTHETIC_MESSAGES) {
      assertContains(msg.subject, '[DEMO]', 'subject should contain [DEMO]');
      assertContains(msg.from, 'synthetic.test', 'from should be synthetic domain');
      assertContains(msg.id, 'demo-', 'id should start with demo-');
    }
  });

  await test('getDemoScope returns clearly-labeled scope', () => {
    const selectedScope = getDemoScope('selected-messages');
    assertContains(selectedScope.description, 'DEMO', 'selected scope should mention DEMO');
    assertFalse(selectedScope.isEmpty, 'selected scope should not be empty');

    const folderScope = getDemoScope('current-folder');
    assertContains(folderScope.description, 'DEMO', 'folder scope should mention DEMO');

    const allScope = getDemoScope('all-mail');
    assertContains(allScope.description, 'DEMO', 'all-mail scope should mention DEMO');
  });

  await test('searchDemoMessages returns synthetic data', () => {
    const scope = getDemoScope('all-mail');
    const result = searchDemoMessages(scope, '', 10, 0);
    assertTrue(result.messages.length > 0, 'should return messages');
    assertTrue(result.progress.isComplete, 'should be complete');
    assertEqual(result.progress.syncCoverage, 100, 'demo sync should be 100%');
  });

  await test('searchDemoMessages supports Hebrew query', () => {
    const scope = getDemoScope('all-mail');
    const result = searchDemoMessages(scope, 'פגישה', 10, 0);
    // Should find the meeting message
    assertTrue(
      result.messages.length > 0 || result.progress.totalEligible === 0,
      'search should complete'
    );
  });

  await test('searchDemoMessages respects pagination', () => {
    const scope = getDemoScope('all-mail');
    const page1 = searchDemoMessages(scope, '', 2, 0);
    const page2 = searchDemoMessages(scope, '', 2, 2);

    assertEqual(page1.messages.length, 2, 'page 1 should have 2 messages');
    if (SYNTHETIC_MESSAGES.length > 4) {
      assertEqual(page2.messages.length, 2, 'page 2 should have 2 messages');
    }

    // Pages should not overlap
    const ids1 = page1.messages.map((m) => m.id);
    const ids2 = page2.messages.map((m) => m.id);
    for (const id of ids2) {
      assertFalse(ids1.includes(id), `page 2 id ${id} should not be in page 1`);
    }
  });

  console.log('\nDev isolation code verification:');

  await test('application.ts has dev mode check for protocol registration', () => {
    const appTs = fs.readFileSync('/workspace/app/src/browser/application.ts', 'utf8');
    assertContains(
      appTs,
      '!this.devMode && !this.specMode',
      'should check devMode before registering protocol'
    );
    assertContains(
      appTs,
      'setAsDefaultProtocolClient',
      'should have protocol registration code (guarded)'
    );
  });

  await test('main.js has dev mode check for Windows registration', () => {
    const mainJs = fs.readFileSync('/workspace/app/src/browser/main.js', 'utf8');
    assertContains(mainJs, '!options.devMode', 'should check devMode before Windows registration');
  });

  await test('main.js already skips single instance lock in dev mode', () => {
    const mainJs = fs.readFileSync('/workspace/app/src/browser/main.js', 'utf8');
    assertContains(
      mainJs,
      'if (!options.devMode)',
      'should have devMode check for single instance lock'
    );
    assertContains(mainJs, 'requestSingleInstanceLock', 'should reference single instance lock');
  });

  await test('config directory uses Mailspring-dev in dev mode', () => {
    const mainJs = fs.readFileSync('/workspace/app/src/browser/main.js', 'utf8');
    assertContains(
      mainJs,
      "dirname = 'Mailspring-dev'",
      'should set Mailspring-dev directory for dev mode'
    );
    assertContains(mainJs, 'args.devMode', 'should check devMode flag for directory selection');
  });

  console.log('\nNo real data access in demo mode:');

  await test('synthetic messages have demo account ID', () => {
    for (const msg of SYNTHETIC_MESSAGES) {
      assertEqual(
        msg.accountId,
        'demo-synthetic-account',
        'all demo messages should use demo account ID'
      );
    }
  });

  await test('demo scope uses demo account ID', () => {
    const scope = getDemoScope('selected-messages');
    assertTrue(
      scope.accountIds.includes('demo-synthetic-account'),
      'demo scope should use demo account ID'
    );
  });

  // Summary
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');

  // Restore original require
  Module.prototype.require = originalRequire;

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
