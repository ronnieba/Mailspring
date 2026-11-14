#!/usr/bin/env npx ts-node
/**
 * Runtime tests of the real mail-cache open sequence and demo recovery policy.
 *
 * This is the coverage that missed f176f1c: DatabaseStore.openDatabase opens
 * SQLite readonly then PRAGMA journal_mode=WAL (a write). A missing/stub file
 * throws SQLITE_READONLY; application:reset-database relaunches --demo forever.
 *
 * From repo root:
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-mail-database.ts
 *
 * From any other cwd (do not pick a local tsconfig.json):
 *   npx ts-node --project /ABS/Mailspring/app/tsconfig.json \
 *     /ABS/Mailspring/app/internal_packages/ai-sidebar/test-mail-database.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const Database = require(path.join(REPO_ROOT, 'node_modules/better-sqlite3'));
const {
  MAIL_CACHE_SQLITE_OPEN_OPTIONS,
  MAIL_CACHE_CONNECTION_PRAGMAS,
  applyMailCacheConnectionPragmas,
  openMailCacheLikeRenderer,
  shouldOpenMailCacheDatabase,
  shouldRebuildMailCacheOnError,
  mailCacheRecoveryAction,
  demoModeFromArgv,
  offlineArchiveFromArgv,
  simulateMailCacheOpenRecovery,
  demoProfileMailCacheDecision,
  fixtureOnlyQueryResult,
} = require('../../src/mail-database-policy');

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');

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

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg || 'Expected true');
}
function assertFalse(v: boolean, msg?: string) {
  if (v) throw new Error(msg || 'Expected false');
}
function assertContains(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(msg || `Expected "${haystack}" to contain "${needle}"`);
  }
}

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cache-policy-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sqliteErrorCode(err: any): string {
  return String((err && (err.code || err.message)) || err);
}

function run() {
  console.log('\n=== Mail cache open + demo recovery (runtime of production modules) ===\n');
  console.log(`APP_SRC_ROOT=${APP_SRC_ROOT}`);
  console.log(`cwd=${process.cwd()}`);
  console.log(
    `better-sqlite3=${require.resolve(path.join(REPO_ROOT, 'node_modules/better-sqlite3'))}\n`
  );

  console.log('Category: runtime — policy');
  test('production still opens and rebuilds the mail cache', () => {
    assertTrue(shouldOpenMailCacheDatabase({ demoMode: false }));
    assertTrue(shouldRebuildMailCacheOnError({ demoMode: false }));
    assertEqual(mailCacheRecoveryAction({ demoMode: false }), 'rebuild-and-relaunch');
  });
  test('demo never opens, rebuilds, or relaunches the mail cache', () => {
    assertFalse(shouldOpenMailCacheDatabase({ demoMode: true }));
    assertFalse(shouldRebuildMailCacheOnError({ demoMode: true }));
    assertEqual(mailCacheRecoveryAction({ demoMode: true }), 'ignore-keep-running');
  });
  test('offline archive never opens, rebuilds, or relaunches the mail cache', () => {
    assertFalse(shouldOpenMailCacheDatabase({ demoMode: false, offlineArchive: true }));
    assertFalse(shouldRebuildMailCacheOnError({ demoMode: false, offlineArchive: true }));
    assertEqual(
      mailCacheRecoveryAction({ demoMode: false, offlineArchive: true }),
      'ignore-keep-running'
    );
  });
  test('--offline-archive argv does not open the mail cache; path-only is not the flag', () => {
    const argv = ['electron', './app', '--dev', '--offline-archive'];
    const skipped = simulateMailCacheOpenRecovery({ argv, openWouldFail: true });
    assertEqual(skipped.relaunches, 0);
    assertEqual(skipped.stoppedBecause, 'did-not-open-mail-cache');
    assertFalse(offlineArchiveFromArgv(['--offline-archive-path=/tmp/x']));
    assertTrue(offlineArchiveFromArgv(['--offline-archive']));
  });
  test('open options stay readonly — production mailbox is not made writable', () => {
    assertEqual(MAIL_CACHE_SQLITE_OPEN_OPTIONS.readonly, true);
    assertTrue(MAIL_CACHE_CONNECTION_PRAGMAS[0] === 'journal_mode = WAL');
  });
  test('--dev --demo argv is demo after app.relaunch() keeps the same flags', () => {
    assertTrue(demoModeFromArgv(['electron', './app', '--dev', '--demo']));
    assertTrue(demoModeFromArgv(['--demo-capture=/tmp/x.png', '--demo']));
    assertFalse(demoModeFromArgv(['electron', './app', '--dev']));
  });
  test('fixture-only COUNT queries return 0, other SELECTs return []', () => {
    assertEqual(
      (fixtureOnlyQueryResult('SELECT COUNT(*) as count FROM Thread')[0] as any).count,
      0
    );
    assertEqual(fixtureOnlyQueryResult('SELECT * FROM Thread').length, 0);
  });

  console.log('\nCategory: runtime — better-sqlite3 is the DatabaseStore open sequence');
  test('missing file + renderer open is SQLITE_CANTOPEN (Linux f176f1c before stub)', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      let threw = false;
      try {
        openMailCacheLikeRenderer(Database, dbPath);
      } catch (err: any) {
        threw = true;
        const text = sqliteErrorCode(err);
        assertTrue(
          /CANTOPEN|unable to open|SQLITE_CANTOPEN/i.test(text),
          `expected SQLITE_CANTOPEN, got ${text}`
        );
      }
      assertTrue(threw, 'missing readonly db must throw');
    });
  });
  test('empty stub file + renderer open is SQLITE_READONLY at pragma (native f176f1c)', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      const created = new Database(dbPath);
      created.close();
      assertTrue(fs.existsSync(dbPath));
      let threw = false;
      try {
        openMailCacheLikeRenderer(Database, dbPath);
      } catch (err: any) {
        threw = true;
        const text = `${err.code || ''} ${err.message || err}`;
        assertContains(text, 'readonly');
        assertTrue(/SQLITE_READONLY|attempt to write a readonly database/i.test(text), text);
      }
      assertTrue(threw, 'stub + readonly WAL must throw SQLITE_READONLY');
    });
  });
  test('zero-byte file + renderer open also fails (no placeholder paper-over)', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      fs.writeFileSync(dbPath, '');
      let threw = false;
      try {
        openMailCacheLikeRenderer(Database, dbPath);
      } catch (err: any) {
        threw = true;
        const text = sqliteErrorCode(err);
        assertTrue(!/ERR_DLOPEN_FAILED|did not self-register/i.test(text), text);
        assertTrue(text.length > 0, 'must throw a sqlite error, not succeed');
      }
      assertTrue(threw, 'zero-byte file must not open as a mail cache');
    });
  });
  test('migrate-created WAL file can be reopened readonly (production path intact)', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      const writer = new Database(dbPath);
      applyMailCacheConnectionPragmas(writer);
      writer.exec('CREATE TABLE IF NOT EXISTS Thread (id TEXT PRIMARY KEY)');
      writer.close();
      const reader = openMailCacheLikeRenderer(Database, dbPath);
      const rows = (reader as any).prepare('SELECT COUNT(*) AS count FROM Thread').all();
      assertEqual(rows[0].count, 0);
      reader.close();
    });
  });

  console.log('\nCategory: runtime — Electron ABI better-sqlite3 (renderer binary)');
  test('electron helper inlines the same pragmas as mail-database-policy.ts', () => {
    const helper = fs.readFileSync(path.join(__dirname, 'mail-cache-open-electron.js'), 'utf8');
    assertContains(helper, 'readonly: true');
    for (const pragma of MAIL_CACHE_CONNECTION_PRAGMAS) {
      assertContains(helper, pragma);
    }
    assertContains(helper, 'node_modules/better-sqlite3');
  });
  test('electron ABI open of stub file is SQLITE_READONLY (native f176f1c stack)', () => {
    const electronBin = path.join(REPO_ROOT, 'node_modules/.bin/electron');
    const helper = path.join(__dirname, 'mail-cache-open-electron.js');
    assertTrue(fs.existsSync(electronBin), `missing ${electronBin}`);
    const spawned = spawnSync(electronBin, ['--disable-gpu', '--no-sandbox', helper], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    });
    const combined = `${spawned.stdout || ''}\n${spawned.stderr || ''}`;
    const jsonLine = (spawned.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{') && l.includes('"results"'))
      .pop();
    if (!jsonLine) {
      throw new Error(
        `electron harness produced no JSON (status=${spawned.status}): ${combined.slice(-800)}`
      );
    }
    const payload = JSON.parse(jsonLine);
    if (payload.failed !== 0) {
      throw new Error(`electron sqlite harness failed: ${JSON.stringify(payload.results)}`);
    }
    const names = payload.results.map((r: { name: string }) => r.name);
    assertTrue(names.includes('empty stub file + renderer open is SQLITE_READONLY at pragma'));
    assertTrue(names.includes('migrate-created WAL file can be reopened readonly'));
  });

  console.log('\nCategory: runtime — unbounded relaunch is the f176f1c demo failure');
  test('demo + failing open does not relaunch (fresh or leftover stub)', () => {
    const argv = ['electron', './app', '--enable-logging', '--dev', '--demo'];
    const fresh = simulateMailCacheOpenRecovery({ argv, openWouldFail: true });
    assertEqual(fresh.relaunches, 0);
    assertEqual(fresh.stoppedBecause, 'did-not-open-mail-cache');
    const leftover = simulateMailCacheOpenRecovery({ argv, openWouldFail: true });
    assertEqual(leftover.relaunches, 0);
  });
  test('production + successful open after migrate does not loop', () => {
    const argv = ['electron', './app'];
    const result = simulateMailCacheOpenRecovery({ argv, openWouldFail: false });
    assertEqual(result.relaunches, 0);
    assertEqual(result.stoppedBecause, 'open-succeeded');
  });
  test('opening a failing cache AND rebuilding would loop — policy must not do that in demo', () => {
    const argv = ['electron', './app', '--dev', '--demo'];
    assertFalse(shouldOpenMailCacheDatabase({ demoMode: demoModeFromArgv(argv) }));
    assertFalse(shouldRebuildMailCacheOnError({ demoMode: true }));
    const loopingIfOpened = (() => {
      let relaunches = 0;
      for (let i = 0; i < 8; i++) {
        relaunches += 1;
      }
      return relaunches;
    })();
    assertEqual(loopingIfOpened, 8);
    const actual = simulateMailCacheOpenRecovery({ argv, openWouldFail: true, maxCycles: 8 });
    assertEqual(actual.stoppedBecause, 'did-not-open-mail-cache');
    assertTrue(actual.relaunches < loopingIfOpened);
  });

  console.log('\nCategory: runtime — fresh and existing demo profiles are both no-touch');
  test('fresh demo profile does not open, rebuild, or delete mail files', () => {
    const d = demoProfileMailCacheDecision({ demoMode: true, profileState: 'fresh' });
    assertFalse(d.open);
    assertFalse(d.rebuildOnError);
    assertFalse(d.deleteFiles);
  });
  test('existing empty stub demo profile is left in place and not opened', () => {
    const d = demoProfileMailCacheDecision({
      demoMode: true,
      profileState: 'existing-empty-stub',
    });
    assertFalse(d.open);
    assertFalse(d.rebuildOnError);
    assertFalse(d.deleteFiles);
  });
  test('existing WAL leftovers in demo profile are not deleted as a workaround', () => {
    const d = demoProfileMailCacheDecision({
      demoMode: true,
      profileState: 'existing-wal-files',
    });
    assertFalse(d.open);
    assertFalse(d.deleteFiles);
  });
  test('production profile still opens the mail cache', () => {
    const d = demoProfileMailCacheDecision({ demoMode: false, profileState: 'fresh' });
    assertTrue(d.open);
    assertTrue(d.rebuildOnError);
  });

  console.log('\nCategory: source-guard — production files actually use this policy');
  const dbStore = fs.readFileSync(path.join(APP_SRC_ROOT, 'flux/stores/database-store.ts'), 'utf8');
  const appTs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser/application.ts'), 'utf8');
  const mainJs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser/main.js'), 'utf8');

  test('DatabaseStore skips open via shouldOpenMailCacheDatabase', () => {
    assertContains(dbStore, 'shouldOpenMailCacheDatabase');
    assertContains(dbStore, 'applyMailCacheConnectionPragmas');
    assertContains(dbStore, 'MAIL_CACHE_SQLITE_OPEN_OPTIONS');
    assertContains(dbStore, 'shouldRebuildMailCacheOnError');
    assertContains(dbStore, '_fixtureOnly');
  });
  test('application.ts recovery uses mailCacheRecoveryAction (no demo relaunch)', () => {
    assertContains(appTs, 'mailCacheRecoveryAction');
    assertContains(appTs, 'rebuild-and-relaunch');
    assertContains(appTs, 'Ignoring application:reset-database');
    assertContains(appTs, 'app.relaunch()');
  });
  test('main.js no longer creates a stub edgehill.db placeholder', () => {
    assertFalse(/stub edgehill\.db/.test(mainJs), 'must not create stub edgehill.db');
    assertFalse(
      /new Database\(dbPath\)/.test(mainJs),
      'must not construct better-sqlite3 in main.js for a stub cache'
    );
    assertContains(mainJs, 'MAILSPRING_DEMO');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
