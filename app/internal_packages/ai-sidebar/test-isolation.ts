#!/usr/bin/env npx ts-node
/**
 * RUNTIME tests of isolationIdentity / isolatedPaths (production module).
 * Category: production-import runtime — not source-text guards.
 *
 * Run with: npx ts-node app/internal_packages/ai-sidebar/test-isolation.ts
 */
import * as path from 'path';

const {
  isolationIdentity,
  isolatedPaths,
  startupFlagsFromArgv,
  identityFromArgv,
  productionKeychainItemName,
  keychainItemNameForApp,
} = require('../../src/browser/dev-isolation.js');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void) {
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

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected)
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg || 'Expected true');
}
function assertFalse(v: boolean, msg?: string) {
  if (v) throw new Error(msg || 'Expected false');
}

function run() {
  console.log('\n=== Dev isolation identity (runtime of production module) ===\n');
  console.log('Category: production-import runtime\n');

  test('production identity is unchanged', () => {
    const id = isolationIdentity({});
    assertEqual(id.appName, 'Mailspring');
    assertEqual(id.configDirName, 'Mailspring');
    assertFalse(id.useMockKeychain);
    assertFalse(id.skipProtocolRegistration);
    assertFalse(id.skipSingleInstanceLock);
    assertFalse(id.skipMailsync);
    assertFalse(id.skipDefaultClient);
  });

  test('dev uses Mailspring-dev and skips protocol/lock/default-client', () => {
    const id = isolationIdentity({ devMode: true });
    assertEqual(id.appName, 'Mailspring-dev');
    assertEqual(id.configDirName, 'Mailspring-dev');
    assertTrue(id.skipProtocolRegistration);
    assertTrue(id.skipSingleInstanceLock);
    assertTrue(id.skipDefaultClient);
    assertFalse(id.useMockKeychain);
    assertFalse(id.skipMailsync);
  });

  test('demo uses distinct name, mock keychain, no mailsync', () => {
    const id = isolationIdentity({ devMode: true, demoMode: true });
    assertEqual(id.appName, 'Mailspring-demo');
    assertEqual(id.configDirName, 'Mailspring-demo');
    assertTrue(id.useMockKeychain);
    assertTrue(id.skipMailsync);
    assertTrue(id.skipProtocolRegistration);
    assertTrue(id.skipAutoUpdate);
  });

  test('demo keychain item name is not production Mailspring Safe Storage', () => {
    const id = isolationIdentity({ demoMode: true });
    const item = keychainItemNameForApp(id.appName);
    assertEqual(productionKeychainItemName(), 'Mailspring Safe Storage');
    assertFalse(item === productionKeychainItemName());
    assertEqual(item, 'Mailspring-demo Safe Storage');
  });

  test('dev keychain item name is not production', () => {
    const id = isolationIdentity({ devMode: true });
    assertEqual(keychainItemNameForApp(id.appName), 'Mailspring-dev Safe Storage');
  });

  test('isolated crashDumps is under the isolated config dir, not Mailspring/Crashpad', () => {
    const appData = '/tmp/fake-app-data';
    const demo = isolationIdentity({ demoMode: true });
    const paths = isolatedPaths(appData, demo);
    assertEqual(paths.configDirPath, path.join(appData, 'Mailspring-demo'));
    assertEqual(paths.crashDumps, path.join(appData, 'Mailspring-demo', 'Crashpad'));
    assertFalse(paths.crashDumps.includes(`${path.sep}Mailspring${path.sep}Crashpad`));
    assertFalse(paths.userData.endsWith(`${path.sep}Mailspring`));
  });

  test('custom --config-dir-path still keeps crash dumps inside that dir', () => {
    const id = isolationIdentity({ demoMode: true });
    const paths = isolatedPaths('/unused', id, '/custom/demo-profile');
    assertEqual(paths.crashDumps, path.join('/custom/demo-profile', 'Crashpad'));
    assertEqual(paths.userData, '/custom/demo-profile');
  });

  test('spec mode is isolated from production and demo', () => {
    const id = isolationIdentity({ specMode: true, devMode: true, demoMode: true });
    assertEqual(id.appName, 'Mailspring-spec');
    assertTrue(id.useMockKeychain);
  });

  test('startupFlagsFromArgv treats --demo-delay-ms as not --demo', () => {
    const withDemo = startupFlagsFromArgv(['--dev', '--demo', '--demo-delay-ms=8000']);
    assertTrue(withDemo.demoMode);
    assertFalse(startupFlagsFromArgv(['--demo-delay-ms=8000']).demoMode);
    assertFalse(startupFlagsFromArgv(['--demo-capture=/tmp/x.png']).demoMode);
  });

  test('identityFromArgv isolates demo before CLI parse; packaged stays production', () => {
    const demo = identityFromArgv(['electron', './app', '--dev', '--demo'], {
      developerBuild: true,
    });
    assertEqual(demo.appName, 'Mailspring-demo');
    const packaged = identityFromArgv(['electron', './app', '--dev', '--demo'], {
      developerBuild: false,
    });
    assertEqual(packaged.appName, 'Mailspring');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
