/**
 * Mail SQLite cache policy shared by renderer DatabaseStore and the main process.
 *
 * Electron DatabaseStore opens edgehill.db with { readonly: true }, then runs
 * `PRAGMA journal_mode = WAL`, which writes. Production is fine because
 * mailsync migrate creates that WAL database first. Demo skips mailsync.
 * Opening a missing or empty stub file yields:
 *   SqliteError: attempt to write a readonly database (SQLITE_READONLY)
 * at Database.pragma → openDatabase → DatabaseStore.open → new DatabaseStore.
 * application:reset-database then app.relaunch() with the same --demo argv,
 * which is an unbounded Okay-dialog loop (native f176f1c).
 *
 * Demo must not open, rebuild, or relaunch over a mail cache. Production
 * recovery (user Okay → delete cache → relaunch) is unchanged.
 */

export const MAIL_CACHE_SQLITE_OPEN_OPTIONS = {
  readonly: true as const,
  timeout: 10000,
};

/** Exact pragmas DatabaseStore.openDatabase applies after a readonly open. */
export const MAIL_CACHE_CONNECTION_PRAGMAS = [
  'journal_mode = WAL',
  'main.page_size = 8192',
  'main.cache_size = 20000',
  'main.synchronous = NORMAL',
  'mmap_size = 2147418112',
] as const;

export function applyMailCacheConnectionPragmas(db: { pragma: (sql: string) => unknown }) {
  for (const pragma of MAIL_CACHE_CONNECTION_PRAGMAS) {
    db.pragma(pragma);
  }
}

type SqliteDatabaseCtor = new (
  filename: string,
  options: typeof MAIL_CACHE_SQLITE_OPEN_OPTIONS
) => { pragma: (sql: string) => unknown; close: () => void };

/** Same open + pragma sequence as DatabaseStore.openDatabase. */
export function openMailCacheLikeRenderer(Database: SqliteDatabaseCtor, dbPath: string) {
  const db = new Database(dbPath, MAIL_CACHE_SQLITE_OPEN_OPTIONS);
  applyMailCacheConnectionPragmas(db);
  return db;
}

export function shouldOpenMailCacheDatabase(opts: {
  demoMode: boolean;
  offlineArchive?: boolean;
}): boolean {
  return !opts.demoMode && !opts.offlineArchive;
}

export function shouldRebuildMailCacheOnError(opts: {
  demoMode: boolean;
  offlineArchive?: boolean;
}): boolean {
  return !opts.demoMode && !opts.offlineArchive;
}

export type MailCacheRecoveryAction = 'rebuild-and-relaunch' | 'ignore-keep-running';

export function mailCacheRecoveryAction(opts: {
  demoMode: boolean;
  offlineArchive?: boolean;
}): MailCacheRecoveryAction {
  if (opts.demoMode || opts.offlineArchive) {
    return 'ignore-keep-running';
  }
  return 'rebuild-and-relaunch';
}

export function demoModeFromArgv(argv: string[]): boolean {
  return argv.some((arg) => arg === '--demo' || arg.startsWith('--demo='));
}

export function offlineArchiveFromArgv(argv: string[]): boolean {
  return argv.some((arg) => arg === '--offline-archive' || arg.startsWith('--offline-archive='));
}

/**
 * Simulate SQLITE_READONLY → reset-database → app.relaunch() with the same argv.
 * Production: one rebuild relaunch, then success if migrate created a real DB.
 * Demo: never open, so 0 relaunches even on a leftover stub file.
 * Returning stoppedBecause 'unbounded-relaunch' is the f176f1c failure mode.
 */
export function simulateMailCacheOpenRecovery(opts: {
  argv: string[];
  openWouldFail: boolean;
  maxCycles?: number;
}): { relaunches: number; stoppedBecause: string } {
  const maxCycles = opts.maxCycles ?? 8;
  let relaunches = 0;
  for (let i = 0; i < maxCycles; i++) {
    const demoMode = demoModeFromArgv(opts.argv);
    const offlineArchive = offlineArchiveFromArgv(opts.argv);
    if (!shouldOpenMailCacheDatabase({ demoMode, offlineArchive })) {
      return { relaunches, stoppedBecause: 'did-not-open-mail-cache' };
    }
    if (!opts.openWouldFail) {
      return { relaunches, stoppedBecause: 'open-succeeded' };
    }
    const action = mailCacheRecoveryAction({ demoMode, offlineArchive });
    if (action !== 'rebuild-and-relaunch') {
      return { relaunches, stoppedBecause: action };
    }
    relaunches += 1;
  }
  return { relaunches, stoppedBecause: 'unbounded-relaunch' };
}

export function demoProfileMailCacheDecision(opts: {
  demoMode: boolean;
  profileState: 'fresh' | 'existing-empty-stub' | 'existing-wal-files';
}): { open: boolean; rebuildOnError: boolean; deleteFiles: boolean } {
  void opts.profileState;
  return {
    open: shouldOpenMailCacheDatabase(opts),
    rebuildOnError: shouldRebuildMailCacheOnError(opts),
    deleteFiles: false,
  };
}

/** Empty SELECT COUNT result so fixture-only UI does not hang on DatabaseStore. */
export function fixtureOnlyQueryResult(sql: string): Array<{ [key: string]: unknown }> {
  if (/^\s*SELECT\s+COUNT\b/i.test(sql)) {
    return [{ count: 0 }];
  }
  return [];
}
