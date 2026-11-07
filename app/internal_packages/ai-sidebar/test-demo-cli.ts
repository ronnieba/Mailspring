#!/usr/bin/env npx ts-node
/**
 * Early startup CLI + isolation (no Electron).
 *
 * Native 63b7210: Optimist 0.4 `options.number is not a function` at
 * declareOptions, before setName/setPath. GPU/network helpers then used
 * production --user-data-dir=.../Mailspring. These checks cover that path.
 *
 * UNRUN in cloud. Parent must execute locally on Mac.
 *
 * From repo root:
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-cli.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-demo-cli.ts"
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseDemoQueryDelayMs } from './lib/core/query-generation';

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');
const APP_ROOT = path.resolve(__dirname, '../..');
const {
  startupFlagsFromArgv,
  identityFromArgv,
  isolatedPaths,
} = require('../../src/browser/dev-isolation.js');

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
function assertContains(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(msg || `Expected to contain "${needle}"`);
  }
}

const DEMO_LAUNCH = [
  'electron',
  './app',
  '--enable-logging',
  '--dev',
  '--demo',
  '--force-renderer-accessibility',
  '--demo-delay-ms=8000',
];

function run() {
  console.log('\n=== Demo CLI / early isolation (UNRUN until local) ===\n');

  const mainJs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser', 'main.js'), 'utf8');
  const optimistPath = path.join(APP_ROOT, 'node_modules', 'optimist');
  const optimist = require(optimistPath);

  console.log('Category: Optimist 0.4 has no .number (native 63b7210)');
  test('bundled optimist is 0.4.x without .number', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(optimistPath, 'package.json'), 'utf8'));
    assertTrue(String(pkg.version).startsWith('0.4'), `unexpected optimist ${pkg.version}`);
    const options = optimist(['node', 'app']);
    assertEqual(typeof options.string, 'function');
    assertEqual(typeof options.boolean, 'function');
    assertFalse(typeof options.number === 'function');
  });

  test('calling options.number throws the native TypeError', () => {
    const options = optimist(['node', 'app']);
    let threw: Error | null = null;
    try {
      options.number('demo-delay-ms');
    } catch (e: any) {
      threw = e;
    }
    assertTrue(!!threw, 'expected TypeError');
    assertContains(String(threw), 'number is not a function');
  });

  test('main.js does not call options.number', () => {
    assertFalse(/\.number\s*\(/.test(mainJs));
    assertContains(mainJs, ".string('demo-delay-ms')");
  });

  console.log('\nCategory: delay flag still demo-gated and capped');
  test('demo-delay-ms parse stays demo-gated and capped at 30000', () => {
    assertEqual(parseDemoQueryDelayMs('8000', true), 8000);
    assertEqual(parseDemoQueryDelayMs('8000', false), 0);
    assertEqual(parseDemoQueryDelayMs(99999, true), 30000);
    assertContains(mainJs, "demoMode && args['demo-delay-ms']");
    assertContains(mainJs, 'Math.min(n, 30000)');
  });

  console.log('\nCategory: raw argv flags without Optimist');
  test('--dev --demo --demo-delay-ms=8000 is demo, delay is not --demo', () => {
    const flags = startupFlagsFromArgv(DEMO_LAUNCH);
    assertTrue(flags.demoMode);
    assertTrue(flags.devMode);
    assertFalse(flags.specMode);
  });

  test('--demo-delay-ms alone is not demo mode', () => {
    assertFalse(startupFlagsFromArgv(['electron', './app', '--demo-delay-ms=8000']).demoMode);
  });

  test('--demo-capture alone is not demo mode', () => {
    assertFalse(startupFlagsFromArgv(['electron', './app', '--demo-capture=/tmp/x.png']).demoMode);
  });

  console.log('\nCategory: isolation even if CLI parse throws');
  test('developer --dev --demo isolates to Mailspring-demo, not production Mailspring', () => {
    const id = identityFromArgv(DEMO_LAUNCH, { developerBuild: true });
    const paths = isolatedPaths('/Users/d623300/Library/Application Support', id);
    assertEqual(id.appName, 'Mailspring-demo');
    assertEqual(id.configDirName, 'Mailspring-demo');
    assertTrue(id.useMockKeychain);
    assertEqual(paths.userData, '/Users/d623300/Library/Application Support/Mailspring-demo');
    assertFalse(paths.userData.endsWith(`${path.sep}Mailspring`));
    assertContains(paths.crashDumps, `${path.sep}Mailspring-demo${path.sep}Crashpad`);
    assertFalse(paths.crashDumps.includes(`${path.sep}Mailspring${path.sep}Crashpad`));
  });

  test('packaged production with --demo still uses Mailspring (no demo on release)', () => {
    const id = identityFromArgv(DEMO_LAUNCH, { developerBuild: false });
    assertEqual(id.appName, 'Mailspring');
    assertFalse(id.useMockKeychain);
    const paths = isolatedPaths('/Users/d623300/Library/Application Support', id);
    assertEqual(paths.userData, '/Users/d623300/Library/Application Support/Mailspring');
  });

  test('plain production argv uses Mailspring paths', () => {
    const id = identityFromArgv(['/Applications/Mailspring.app/Contents/MacOS/Mailspring'], {
      developerBuild: false,
    });
    assertEqual(id.appName, 'Mailspring');
    assertEqual(id.configDirName, 'Mailspring');
  });

  test('identity is computed without calling Optimist even if .number would throw', () => {
    const options = optimist(['node', 'app']);
    let parseThrew = false;
    try {
      options.number('demo-delay-ms');
    } catch {
      parseThrew = true;
    }
    assertTrue(parseThrew);
    const paths = isolatedPaths(
      '/Users/d623300/Library/Application Support',
      identityFromArgv(DEMO_LAUNCH, { developerBuild: true })
    );
    assertEqual(paths.userData, '/Users/d623300/Library/Application Support/Mailspring-demo');
  });

  console.log('\nCategory: source order — setName/setPath before parseCommandLine');
  test('start() applies identityFromArgv and setName before parseCommandLine(process.argv)', () => {
    const startFn = mainJs.slice(mainJs.indexOf('const start = () =>'));
    const identPos = startFn.indexOf('identityFromArgv');
    const setNamePos = startFn.indexOf('app.setName');
    const setupPos = startFn.indexOf('setupConfigDir');
    const parsePos = startFn.indexOf('parseCommandLine(process.argv)');
    assertTrue(identPos >= 0 && setNamePos >= 0 && setupPos >= 0 && parsePos >= 0);
    assertTrue(identPos < parsePos, 'identityFromArgv must precede parseCommandLine');
    assertTrue(setNamePos < parsePos, 'setName must precede parseCommandLine');
    assertTrue(setupPos < parsePos, 'setupConfigDir must precede parseCommandLine');
    assertContains(mainJs, 'startupFlagsFromArgv');
    assertContains(mainJs, 'use-mock-keychain');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('UNRUN in this cloud agent — expected counts only until local Mac run.');
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
