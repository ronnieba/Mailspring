/**
 * In-memory catalog of a local offline archive. Original files stay on disk;
 * this index is a disposable working view. Tests inject fixtures.
 */
import { MessageRef, ResolvedScope, RetrievalMode, SearchResult } from './core/types';
import { messageMatchesQuery } from './core/query-filter';
import {
  isForbiddenArchiveRoot,
  OFFLINE_ARCHIVE_ACCOUNT_ID,
  OfflineArchiveManifest,
  OfflineArchiveMessage,
  readOfflineArchive,
} from './core/offline-archive-format';
import {
  GEMINI_SCOPED_BODY_SCAN,
  planScopedRetrieval,
  selectScopedForGemini,
} from './core/gemini-context';
import { tr } from './core/offline-i18n';

/**
 * Stable, collision-free folder id for a folder path. Letters/digits/dot stay
 * as they are; every other character (Hebrew, '/', '-', '_', spaces…) is
 * encoded by its code point, so "Work/2024", "Work-2024" and two Hebrew
 * folders of the same length never share an id.
 */
export function offlineFolderIdFor(p: string): string {
  if (!p) {
    return 'INBOX';
  }
  return Array.from(p)
    .map((c) => (/[A-Za-z0-9.]/.test(c) ? c : `_${(c.codePointAt(0) || 0).toString(16)}_`))
    .join('');
}

/**
 * Folder scope is exactly one folder: messages whose folder path equals the
 * selected path. Subfolders are NOT included.
 */
export const OFFLINE_FOLDER_SCOPE_INCLUDES_SUBFOLDERS = false;

function inScopeFolder(m: OfflineArchiveMessage, folder: { id: string; name: string }): boolean {
  if (m.folderPath) {
    return m.folderPath === folder.name;
  }
  return m.folderId === folder.id;
}

let catalog: OfflineArchiveMessage[] = [];
let selectedId: string | null = null;
let manifest: OfflineArchiveManifest | null = null;

/**
 * Browser-driven mode (Windows/macOS offline experiment): the folder tree and
 * message list in the main window own selection and the current folder.
 * Bodies are loaded lazily, read-only, one message at a time.
 */
let browserDriven = false;
let browserSelectedIds: string[] = [];
let browserFolder: { path: string; name: string } | null = null;
let bodyLoader: ((m: OfflineArchiveMessage) => string) | null = null;
const byId = new Map<string, OfflineArchiveMessage>();
const lazyBodies = new Map<string, string>();
const LAZY_BODY_CACHE = 200;

/** Whole copy with each message once (copies in several folders share a dedupeKey). */
let uniqueCatalog: OfflineArchiveMessage[] = [];

function rebuildById() {
  byId.clear();
  const seen = new Set<string>();
  uniqueCatalog = [];
  for (const m of catalog) {
    byId.set(m.id, m);
    const k = m.dedupeKey || m.id;
    if (!seen.has(k)) {
      seen.add(k);
      uniqueCatalog.push(m);
    }
  }
}

export function setOfflineArchiveBrowserCatalog(
  messages: OfflineArchiveMessage[],
  nextManifest: OfflineArchiveManifest | null,
  loader: (m: OfflineArchiveMessage) => string
): void {
  browserDriven = true;
  bodyLoader = loader;
  lazyBodies.clear();
  catalog = messages.slice();
  manifest = nextManifest;
  rebuildById();
  browserSelectedIds = browserSelectedIds.filter((id) => byId.has(id));
}

let offlineNavigator: ((id: string) => boolean) | null = null;

/** The offline browser registers how a citation opens a message in the main window. */
export function setOfflineArchiveNavigator(fn: ((id: string) => boolean) | null): void {
  offlineNavigator = fn;
}

export function navigateOfflineArchive(id: string): boolean {
  return !!offlineNavigator && byId.has(id) && offlineNavigator(id);
}

export function isOfflineArchiveBrowserDriven(): boolean {
  return browserDriven;
}

export function setOfflineArchiveSelection(ids: string[]): void {
  browserSelectedIds = (ids || []).filter((id) => byId.has(id));
  selectedId = browserSelectedIds[0] || null;
}

export function setOfflineArchiveCurrentFolder(
  folder: { path: string; name: string } | null
): void {
  browserFolder = folder;
}

function bodyOf(m: OfflineArchiveMessage): string {
  if (m.bodyText || !browserDriven || !bodyLoader) {
    return m.bodyText;
  }
  const hit = lazyBodies.get(m.id);
  if (hit !== undefined) {
    return hit;
  }
  let text = '';
  try {
    text = bodyLoader(m) || '';
  } catch {
    text = '';
  }
  if (lazyBodies.size >= LAZY_BODY_CACHE) {
    const oldest = lazyBodies.keys().next().value;
    if (oldest !== undefined) {
      lazyBodies.delete(oldest);
    }
  }
  lazyBodies.set(m.id, text);
  return text;
}

export function setOfflineArchiveCatalog(
  messages: OfflineArchiveMessage[],
  nextManifest?: OfflineArchiveManifest | null
): void {
  browserDriven = false;
  bodyLoader = null;
  lazyBodies.clear();
  browserSelectedIds = [];
  browserFolder = null;
  catalog = Array.isArray(messages) ? messages.slice() : [];
  manifest = nextManifest || null;
  rebuildById();
  if (!selectedId || !catalog.some((m) => m.id === selectedId)) {
    selectedId = catalog[0] ? catalog[0].id : null;
  }
}

export function setOfflineArchiveSelected(id: string | null): boolean {
  if (browserDriven) {
    if (!id || !byId.has(id)) {
      return false;
    }
    setOfflineArchiveSelection([id]);
    return true;
  }
  if (!id) {
    selectedId = catalog[0] ? catalog[0].id : null;
    return !!selectedId;
  }
  if (!catalog.some((m) => m.id === id)) {
    return false;
  }
  selectedId = id;
  return true;
}

export function getOfflineArchiveSelected(): string | null {
  return selectedId;
}

export function getOfflineArchiveManifest(): OfflineArchiveManifest | null {
  return manifest;
}

export function loadOfflineArchiveCatalog(originalRoot: string): {
  ok: boolean;
  reason: string;
  manifest: OfflineArchiveManifest | null;
} {
  const forbidden = isForbiddenArchiveRoot(originalRoot);
  if (forbidden.forbidden) {
    setOfflineArchiveCatalog([], null);
    return { ok: false, reason: forbidden.reason, manifest: null };
  }
  try {
    const loaded = readOfflineArchive(originalRoot);
    setOfflineArchiveCatalog(loaded.messages, loaded.manifest);
    return { ok: true, reason: '', manifest: loaded.manifest };
  } catch (err) {
    setOfflineArchiveCatalog([], null);
    return {
      ok: false,
      reason: (err as Error).message || 'failed to read archive',
      manifest: null,
    };
  }
}

export function getOfflineArchiveCatalog(): OfflineArchiveMessage[] {
  return catalog.slice();
}

export function offlineMessageToRef(m: OfflineArchiveMessage, withBody = true): MessageRef {
  if (browserDriven) {
    const body = withBody ? bodyOf(m) : '';
    return {
      id: m.id,
      threadId: m.threadId,
      accountId: m.accountId,
      subject: m.subject,
      from: m.from,
      date: m.date ? new Date(m.date) : new Date(0),
      snippet: m.snippet || body.replace(/\s+/g, ' ').trim().slice(0, 160),
      folderId: m.folderId,
      bodyText: body,
    };
  }
  return {
    id: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    subject: m.subject,
    from: m.from,
    date: m.date ? new Date(m.date) : new Date(0),
    snippet: m.snippet,
    folderId: m.folderId,
    bodyText: m.bodyText,
  };
}

function browserScope(mode: ResolvedScope['mode']): ResolvedScope {
  if (mode === 'selected-messages') {
    const selected = browserSelectedIds
      .map((id) => byId.get(id))
      .filter(Boolean) as OfflineArchiveMessage[];
    const threadIds = Array.from(new Set(selected.map((m) => m.threadId)));
    // A selected conversation counts as all of its messages.
    const conv =
      threadIds.length < selected.length
        ? tr(` (${threadIds.length} שיחות)`, ` (${threadIds.length} conversation(s))`)
        : '';
    return {
      mode,
      threadIds,
      messageIds: selected.map((m) => m.id),
      accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
      description: selected.length
        ? tr(
            `${selected.length} הודעות נבחרות מהעותק המקומי${conv} / ${selected.length} selected local message(s)`,
            `${selected.length} selected local message(s)${conv}`
          )
        : tr('לא נבחרה הודעה — בחר הודעה ברשימה / No message selected', 'No message selected'),
      isEmpty: selected.length === 0,
      messageCount: selected.length,
    };
  }
  if (mode === 'current-folder') {
    const folder = browserFolder;
    const count = folder ? catalog.filter((m) => m.folderPath === folder.path).length : 0;
    return {
      mode,
      folder: folder
        ? {
            id: catalog.find((m) => m.folderPath === folder.path)?.folderId || folder.path,
            accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
            name: folder.path,
            role: null,
          }
        : undefined,
      accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
      description: folder
        ? tr(
            `תיקייה: ${folder.name} (${count}, בלי תת-תיקיות) / Folder (${count})`,
            `Folder: ${folder.name} (${count}, without subfolders)`
          )
        : tr('לא נבחרה תיקייה / No folder selected', 'No folder selected'),
      isEmpty: count === 0,
      messageCount: count,
    };
  }
  return {
    mode,
    accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
    description: tr(
      `כל העותק המקומי (${uniqueCatalog.length} הודעות) / Whole offline copy (${uniqueCatalog.length})`,
      `Whole offline copy (${uniqueCatalog.length} messages)`
    ),
    isEmpty: uniqueCatalog.length === 0,
    messageCount: uniqueCatalog.length,
  };
}

export function getOfflineArchiveScope(mode: ResolvedScope['mode']): ResolvedScope {
  if (browserDriven) {
    return browserScope(mode);
  }
  const messages = catalog;
  if (mode === 'selected-messages') {
    const selected = messages.find((m) => m.id === selectedId) || messages[0];
    return {
      mode,
      threadIds: selected ? [selected.threadId] : [],
      messageIds: selected ? [selected.id] : [],
      accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
      description: selected
        ? `הודעה אחת מהארכיון המקומי (${selected.id})`
        : 'ארכיון מקומי ריק — לא נבחרה הודעה',
      isEmpty: !selected,
    };
  }
  if (mode === 'current-folder') {
    const folder = messages[0]?.folderPath || 'INBOX';
    const inFolder = messages.filter((m) => m.folderPath === folder);
    return {
      mode,
      folder: {
        id: inFolder[0]?.folderId || 'INBOX',
        accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
        name: folder,
        role: null,
      },
      accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
      description: `תיקיית ארכיון: ${folder} (${inFolder.length})`,
      isEmpty: inFolder.length === 0,
    };
  }
  return {
    mode,
    accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
    description: `ארכיון מקומי מנותק (${messages.length} הודעות)`,
    isEmpty: messages.length === 0,
  };
}

function dateMs(m: OfflineArchiveMessage): number {
  const t = m.date ? Date.parse(m.date) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function searchOfflineArchive(
  scope: ResolvedScope,
  query: string,
  retrieval: RetrievalMode,
  limit: number,
  offset: number
): SearchResult {
  let rows = catalog;
  if (scope.mode === 'selected-messages') {
    const allowed = new Set(scope.messageIds || []);
    rows = browserDriven || allowed.size ? rows.filter((m) => allowed.has(m.id)) : rows;
  } else if (scope.mode === 'current-folder' && scope.folder) {
    rows = rows.filter((m) => inScopeFolder(m, scope.folder));
  } else if (scope.mode === 'current-folder' && browserDriven) {
    rows = [];
  }
  if (browserDriven) {
    // Header-level ranking (no body reads): query matches first, newest first.
    const q = (query || '').trim();
    const ranked = rows
      .map((m) => ({
        m,
        hit:
          q && retrieval === 'ranked'
            ? messageMatchesQuery(offlineMessageToRef(m, false), q)
            : false,
        t: dateMs(m),
      }))
      .sort((a, b) => (a.hit === b.hit ? b.t - a.t : a.hit ? -1 : 1));
    rows = ranked.map((r) => r.m);
  }
  const pageRows = rows.slice(offset, offset + limit);
  const page = pageRows.map((m) => offlineMessageToRef(m, true));
  return {
    messages: page,
    progress: {
      totalEligible: rows.length,
      processed: page.length,
      withBodies: browserDriven ? page.filter((m) => !!m.bodyText).length : page.length,
      missingBodies: browserDriven ? page.filter((m) => !m.bodyText).length : 0,
      syncCoverage: 100,
      isComplete: browserDriven ? offset + page.length >= rows.length : true,
      isCancelled: false,
    },
    retrievalMode: retrieval,
  };
}

function rowsInScope(scope: ResolvedScope): OfflineArchiveMessage[] {
  if (scope.mode === 'selected-messages') {
    const allowed = new Set(scope.messageIds || []);
    return catalog.filter((m) => allowed.has(m.id));
  }
  if (scope.mode === 'current-folder') {
    if (!scope.folder) {
      return [];
    }
    return catalog.filter((m) => inScopeFolder(m, scope.folder));
  }
  return browserDriven ? uniqueCatalog : catalog;
}

export interface OfflineGeminiContext {
  messages: MessageRef[];
  inScope: number;
  scanned: number;
  matched: number;
  sent: number;
  totalChars: number;
  facts: OfflineScopeFacts;
}

/** Exact, locally computed facts about the whole scope (not only what is sent). */
export interface OfflineScopeFacts {
  scopeKind: 'selected' | 'folder' | 'all';
  includesSubfolders: boolean;
  totalInScope: number;
  sent: number;
  oldest: string | null;
  newest: string | null;
  distinctSenders: number;
}

function senderKey(from: string): string {
  const s = String(from || '').toLowerCase();
  const m = s.match(/[^\s<>"']+@[^\s<>"']+/);
  return (m ? m[0] : s).trim();
}

export function computeOfflineScopeFacts(
  scope: ResolvedScope,
  rows: OfflineArchiveMessage[],
  sent: number
): OfflineScopeFacts {
  let oldest = Infinity;
  let newest = -Infinity;
  const senders = new Set<string>();
  for (const m of rows) {
    const t = dateMs(m);
    if (t > 0) {
      oldest = Math.min(oldest, t);
      newest = Math.max(newest, t);
    }
    const k = senderKey(m.from);
    if (k) {
      senders.add(k);
    }
  }
  return {
    scopeKind:
      scope.mode === 'selected-messages'
        ? 'selected'
        : scope.mode === 'current-folder'
          ? 'folder'
          : 'all',
    includesSubfolders:
      scope.mode === 'current-folder' ? OFFLINE_FOLDER_SCOPE_INCLUDES_SUBFOLDERS : true,
    totalInScope: rows.length,
    sent: Math.min(sent, rows.length),
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    distinctSenders: senders.size,
  };
}

/** Exact scope facts without reading any body (for local metadata answers). */
export function getOfflineScopeFacts(scope: ResolvedScope): OfflineScopeFacts {
  return computeOfflineScopeFacts(scope, rowsInScope(scope), 0);
}

/**
 * Local retrieval for a Gemini "Send" over a scope. Reads bodies only for the
 * best header candidates (read-only, from the local copy), never attachments,
 * and returns a bounded, cleaned set. No network here.
 */
export async function buildOfflineGeminiContext(
  scope: ResolvedScope,
  query: string,
  opts: { signal?: AbortSignal; onProgress?: (scanned: number, toScan: number) => void } = {}
): Promise<OfflineGeminiContext> {
  const rows = rowsInScope(scope);
  const selectedScope = scope.mode === 'selected-messages';
  const candidates = rows.map((m) => ({
    id: m.id,
    subject: m.subject,
    from: m.from,
    ts: dateMs(m),
    m,
  }));
  const plan = planScopedRetrieval(
    candidates,
    selectedScope ? '' : query,
    selectedScope ? candidates.length : GEMINI_SCOPED_BODY_SCAN
  );
  const scanned: Array<(typeof candidates)[number] & { body: string }> = [];
  for (let i = 0; i < plan.toScan.length; i++) {
    if (opts.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    const c = plan.toScan[i];
    scanned.push({ ...c, body: bodyOf(c.m) || '' });
    if (i % 10 === 9) {
      opts.onProgress?.(i + 1, plan.toScan.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  opts.onProgress?.(scanned.length, plan.toScan.length);
  // Selected scope: send the selected messages themselves (newest first).
  const selection = selectScopedForGemini(scanned, selectedScope ? [] : plan.terms);
  // Never more than exist in the scope.
  const chosen = selection.chosen.slice(0, rows.length);
  const messages: MessageRef[] = chosen.map((c) => ({
    id: c.m.id,
    threadId: c.m.threadId,
    accountId: c.m.accountId,
    subject: c.m.subject,
    from: c.m.from,
    date: c.m.date ? new Date(c.m.date) : new Date(0),
    snippet: c.cleanBody.replace(/\s+/g, ' ').slice(0, 160),
    folderId: c.m.folderId,
    bodyText: c.cleanBody,
  }));
  return {
    messages,
    inScope: rows.length,
    scanned: scanned.length,
    matched: selection.matched,
    sent: messages.length,
    totalChars: selection.totalChars,
    facts: computeOfflineScopeFacts(scope, rows, messages.length),
  };
}

export function getOfflineArchiveBody(messageId: string): string | null {
  const found = byId.get(messageId) || catalog.find((m) => m.id === messageId);
  return found ? bodyOf(found) : null;
}

export function getOfflineArchiveAttachmentCount(messageId: string): number {
  const found = byId.get(messageId) || catalog.find((m) => m.id === messageId);
  return found ? found.attachmentCount : 0;
}
