/**
 * Electron-ABI harness for the DatabaseStore mail-cache open sequence.
 * Run: electron <this-file>
 * Prints one JSON line to stdout; exit 0 on pass.
 *
 * Constants below MUST match app/src/mail-database-policy.ts
 * (asserted by test-mail-database.ts). They are inlined so this file
 * can load without ts-node.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const MAIL_CACHE_SQLITE_OPEN_OPTIONS = { readonly: true, timeout: 10000 };
const MAIL_CACHE_CONNECTION_PRAGMAS = [
  'journal_mode = WAL',
  'main.page_size = 8192',
  'main.cache_size = 20000',
  'main.synchronous = NORMAL',
  'mmap_size = 2147418112',
];

function applyMailCacheConnectionPragmas(db) {
  for (const pragma of MAIL_CACHE_CONNECTION_PRAGMAS) {
    db.pragma(pragma);
  }
}

function openMailCacheLikeRenderer(Database, dbPath) {
  const db = new Database(dbPath, MAIL_CACHE_SQLITE_OPEN_OPTIONS);
  applyMailCacheConnectionPragmas(db);
  return db;
}

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cache-e-profile-'));
app.setName('Mailspring-demo-mailcache-test');
app.setPath('userData', tmpUserData);
app.commandLine.appendSwitch('use-mock-keychain');

function sqliteText(err) {
  return `${(err && err.code) || ''} ${(err && err.message) || err}`;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cache-e-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function assertTrue(v, msg) {
  if (!v) throw new Error(msg || 'Expected true');
}

function assertContains(haystack, needle) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`Expected "${haystack}" to contain "${needle}"`);
  }
}

function runCases(Database) {
  test('open options stay readonly', () => {
    assertTrue(MAIL_CACHE_SQLITE_OPEN_OPTIONS.readonly === true);
  });

  test('missing file + renderer open is SQLITE_CANTOPEN', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      let text = '';
      try {
        openMailCacheLikeRenderer(Database, dbPath);
      } catch (err) {
        text = sqliteText(err);
      }
      assertTrue(
        /CANTOPEN|unable to open|SQLITE_CANTOPEN/i.test(text),
        `expected SQLITE_CANTOPEN, got ${text}`
      );
    });
  });

  test('empty stub file + renderer open is SQLITE_READONLY at pragma', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      const created = new Database(dbPath);
      created.close();
      let text = '';
      try {
        openMailCacheLikeRenderer(Database, dbPath);
      } catch (err) {
        text = sqliteText(err);
      }
      assertContains(text, 'readonly');
      assertTrue(/SQLITE_READONLY|attempt to write a readonly database/i.test(text), text);
    });
  });

  test('zero-byte file + renderer open fails', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      fs.writeFileSync(dbPath, '');
      let threw = false;
      try {
        openMailCacheLikeRenderer(Database, dbPath);
      } catch (err) {
        threw = true;
        const text = sqliteText(err);
        assertTrue(!/ERR_DLOPEN_FAILED|did not self-register/i.test(text), text);
      }
      assertTrue(threw, 'zero-byte file must not open as a mail cache');
    });
  });

  test('migrate-created WAL file can be reopened readonly', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'edgehill.db');
      const writer = new Database(dbPath);
      applyMailCacheConnectionPragmas(writer);
      writer.exec('CREATE TABLE IF NOT EXISTS Thread (id TEXT PRIMARY KEY)');
      writer.close();
      const reader = openMailCacheLikeRenderer(Database, dbPath);
      const rows = reader.prepare('SELECT COUNT(*) AS count FROM Thread').all();
      assertTrue(rows[0].count === 0);
      reader.close();
    });
  });
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`${JSON.stringify({ results, failed: failed.length })}\n`);
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  app.exit(failed.length > 0 ? 1 : 0);
}

process.on('uncaughtException', (err) => {
  results.push({ name: 'uncaughtException', ok: false, error: String(err) });
  finish();
});

app.whenReady().then(() => {
  let Database;
  try {
    Database = require(path.join(__dirname, '../../node_modules/better-sqlite3'));
  } catch (err) {
    results.push({ name: 'require better-sqlite3', ok: false, error: String(err) });
    finish();
    return;
  }
  runCases(Database);
  finish();
});
