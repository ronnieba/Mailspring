/**
 * State for the offline experiment mail browser (folder tree, message list,
 * reader). Data comes only from a local read-only work copy. No account, no
 * mailsync, no Mailspring database, no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildFolderTree,
  buildOfflineMailIndex,
  IndexProgress,
  loadOfflineMessage,
  OfflineFolderNode,
  OfflineIndexEntry,
  OfflineMailIndex,
  readOfflineMessageRaw,
  readOfflineMessageRawSync,
} from '../core/offline-mail-index';
import {
  OfflineMailAttachment,
  parseOfflineMail,
  ParsedOfflineMail,
} from '../core/offline-mail-mime';
import { cleanAttachmentTemp } from '../core/offline-attachments';
import {
  buildThreads,
  dedupeCopies,
  messageKey,
  uniqueInFolder,
  OfflineThread,
  readThreadedPref,
  writeThreadedPref,
} from '../core/offline-threads';
import { OFFLINE_ARCHIVE_ACCOUNT_ID, OfflineArchiveMessage } from '../core/offline-archive-format';
import {
  DEFAULT_SORT,
  OfflineListDensity,
  OfflineSort,
  OfflineSortKey,
  defaultDirFor,
  previewLine,
  readListPrefs,
  senderName,
  sortRows,
  writeListPrefs,
} from '../core/offline-list-view';
import {
  offlineFolderIdFor,
  setOfflineArchiveNavigator,
  setOfflineArchiveBrowserCatalog,
  setOfflineArchiveCurrentFolder,
  setOfflineArchiveSelection,
} from '../offline-archive-catalog';

export type OfflineBrowserStatus = 'idle' | 'indexing' | 'ready' | 'error';

export type OpenMessageState = {
  id: string;
  loading: boolean;
  parsed: ParsedOfflineMail | null;
  error: string | null;
};

/** One line in the message list: a single message or a whole conversation. */
export type OfflineListRow = {
  /** Message id (flat view) or conversation key (threaded view). */
  key: string;
  /** Newest message of the row in the current folder (what the line shows). */
  entry: OfflineIndexEntry;
  /** Every message of the row, oldest first (all folders, for conversations). */
  ids: string[];
  /** How many of those are in the current folder. */
  inFolder: number;
};

export type OpenThreadState = {
  key: string;
  /** Messages oldest first. */
  ids: string[];
  parsed: { [id: string]: ParsedOfflineMail };
  errors: { [id: string]: string };
  expanded: Set<string>;
  loading: boolean;
};

/** Longest conversation the reader loads at once (newest messages kept). */
export const OFFLINE_THREAD_READER_MAX = 100;

type Listener = () => void;

// Which folders are open in the tree; kept in the offline profile (config dir).
export const OFFLINE_FOLDER_EXPANDED_FILE = 'offline-folder-expanded.json';

export function readExpandedFolders(file: string | null): Set<string> | null {
  if (!file) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === 1 && Array.isArray(raw.expanded)) {
      return new Set(raw.expanded.filter((p: any) => typeof p === 'string'));
    }
  } catch {
    // first run or unreadable: start collapsed
  }
  return null;
}

export function writeExpandedFolders(file: string | null, expanded: Iterable<string>) {
  if (!file) {
    return;
  }
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, expanded: Array.from(expanded).sort() }));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[Offline mail] could not save open folders', (err as any)?.code);
  }
}

function folderIdFor(p: string): string {
  return offlineFolderIdFor(p);
}

class OfflineMailStore {
  status: OfflineBrowserStatus = 'idle';
  progress: IndexProgress | null = null;
  error: string | null = null;
  root: string | null = null;
  index: OfflineMailIndex | null = null;
  folders: OfflineFolderNode[] = [];
  currentFolder: string | null = null;
  /** Message ids behind the selected rows (what the AI "selected" scope uses). */
  selectedIds: string[] = [];
  /** Selected list rows (message ids or conversation keys). */
  selectedKeys: string[] = [];
  anchorId: string | null = null;
  filter = '';
  openMessage: OpenMessageState | null = null;
  openThread: OpenThreadState | null = null;
  /** Conversations view (remembered in the offline profile). */
  threaded = true;
  /** List rows: one line ('compact') or three lines ('expanded'); remembered. */
  density: OfflineListDensity = 'expanded';
  /** Quick filter "📎 only with attachments" (this session). */
  attachmentsOnly = false;
  /** Sort per folder (remembered); default newest first. */
  private _sortByFolder: { [folder: string]: OfflineSort } = {};
  private _previews = new Map<string, string>();
  private _previewQueue = new Set<string>();
  private _previewTimer: ReturnType<typeof setTimeout> | null = null;
  expanded = new Set<string>();
  /** Offline profile folder (opened attachment copies live under it). */
  configDir: string | null = null;

  private _listeners = new Set<Listener>();
  private _byId = new Map<string, OfflineIndexEntry>();
  private _byFolder = new Map<string, OfflineIndexEntry[]>();
  private _visibleCache: { key: string; rows: OfflineIndexEntry[] } | null = null;
  private _rowsCache: {
    key: string;
    rows: OfflineListRow[];
    byKey: Map<string, OfflineListRow>;
  } | null = null;
  private _threads = new Map<string, OfflineThread>();
  private _threadOf = new Map<string, string>();
  /** Message ids shown in folder lists (one per duplicate copy in a folder). */
  private _listed = new Set<string>();
  private _parsedCache = new Map<string, ParsedOfflineMail>();
  private _openSeq = 0;
  private _expandedFile: string | null = null;

  listen(cb: Listener): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (err) {
        console.error('[Offline mail] listener failed', err);
      }
    }
  }

  async start(root: string, cachePath: string | undefined) {
    if (this.status === 'indexing') {
      return;
    }
    this.root = root;
    this.configDir = cachePath ? path.dirname(cachePath) : null;
    if (this.configDir) {
      cleanAttachmentTemp(this.configDir);
    }
    this.threaded = readThreadedPref(this.configDir);
    const listPrefs = readListPrefs(this.configDir);
    this.density = listPrefs.density;
    this._sortByFolder = listPrefs.sortByFolder;
    this._expandedFile = cachePath
      ? path.join(path.dirname(cachePath), OFFLINE_FOLDER_EXPANDED_FILE)
      : null;
    const saved = readExpandedFolders(this._expandedFile);
    if (saved) {
      this.expanded = saved;
    }
    this.status = 'indexing';
    this.error = null;
    this.progress = { phase: 'scan', done: 0, total: 0 };
    this._emit();
    let lastEmit = 0;
    try {
      const index = await buildOfflineMailIndex(root, {
        cachePath,
        onProgress: (p) => {
          this.progress = p;
          const now = Date.now();
          if (now - lastEmit > 150 || p.phase === 'done') {
            lastEmit = now;
            this._emit();
          }
        },
      });
      this._applyIndex(index);
      this.status = 'ready';
      console.log(
        `[Offline mail] indexed ${index.entries.length} messages in ${
          Object.keys(this._countsByFolder()).length
        } folders (reused ${index.stats.reused}, parsed ${index.stats.parsed}, attachments re-checked ${index.stats.rescanned || 0}, ${index.stats.ms}ms, unreadable ${index.unreadable.length})`
      );
    } catch (err) {
      this.status = 'error';
      this.error = (err as Error).message || String(err);
      console.error('[Offline mail] index failed:', this.error);
    }
    this._emit();
  }

  /** Unique messages per exact folder (what the badge, header and list show). */
  private _countsByFolder(): { [p: string]: number } {
    const out: { [p: string]: number } = {};
    for (const [k, v] of this._byFolder) {
      out[k] = v.length;
    }
    return out;
  }

  /** Raw files per folder (duplicate copies included), to compare with the manifest. */
  private _rawCountsByFolder(): { [p: string]: number } {
    const out: { [p: string]: number } = {};
    for (const e of this.index?.entries || []) {
      out[e.folder] = (out[e.folder] || 0) + 1;
    }
    return out;
  }

  private _applyIndex(index: OfflineMailIndex) {
    this.index = index;
    this._previews.clear();
    this._byId.clear();
    this._byFolder.clear();
    for (const e of index.entries) {
      this._byId.set(e.id, e);
      const list = this._byFolder.get(e.folder) || [];
      list.push(e);
      this._byFolder.set(e.folder, list);
    }
    for (const [k, list] of this._byFolder) {
      list.sort((a, b) => b.ts - a.ts);
      // The same message stored twice in one folder is listed (and counted) once.
      this._byFolder.set(k, uniqueInFolder(list));
    }
    const listed = new Set<string>();
    for (const list of this._byFolder.values()) {
      for (const e of list) {
        listed.add(e.id);
      }
    }
    this._listed = listed;
    const grouped = buildThreads(index.entries);
    this._threads = grouped.threads;
    this._threadOf = grouped.threadOf;
    this._rowsCache = null;
    this.folders = buildFolderTree(index);
    const root = this.root as string;
    const messages: OfflineArchiveMessage[] = index.entries
      .filter((e) => listed.has(e.id))
      .map((e) => ({
        id: e.id,
        threadId: this._threadOf.get(e.id) || `thread-${e.id}`,
        accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
        folderId: folderIdFor(e.folder),
        folderPath: e.folder,
        subject: e.subject,
        from: e.from,
        date: e.ts ? new Date(e.ts).toISOString() : '',
        snippet: '',
        bodyText: '',
        sha256: '',
        byteLength: e.size,
        attachmentCount: e.hasAttachments ? e.attachCount || 1 : 0,
        sourceRelPath: e.rel,
        dedupeKey: messageKey(e),
      }));
    const folderCounts = this._countsByFolder();
    setOfflineArchiveBrowserCatalog(
      messages,
      {
        version: 1,
        kind: 'offline-archive',
        originalRoot: root,
        messageCount: new Set(messages.map((m) => m.dedupeKey)).size,
        folderCounts,
        sha256All: '',
        unreadable: index.unreadable.map((u) => ({ path: u.rel, reason: u.reason })),
        emptyFolders: this._allFolderPaths().filter((p) => !folderCounts[p]),
      },
      (m) => {
        const raw = readOfflineMessageRawSync(root, m.sourceRelPath);
        return parseOfflineMail(raw).text;
      }
    );
    setOfflineArchiveNavigator((id) => this.reveal(id));
    const first = this.folders.find((f) => f.count > 0) || this.folders[0];
    if (first) {
      this.setFolder(first.path, false);
    }
  }

  private _allFolderPaths(): string[] {
    const out: string[] = [];
    const rec = (list: OfflineFolderNode[]) => {
      for (const n of list) {
        out.push(n.path);
        rec(n.children);
      }
    };
    rec(this.folders);
    return out;
  }

  /** Every folder node (tree order). */
  allFolderNodes(): OfflineFolderNode[] {
    const out: OfflineFolderNode[] = [];
    const rec = (list: OfflineFolderNode[]) => {
      for (const n of list) {
        out.push(n);
        rec(n.children);
      }
    };
    rec(this.folders);
    return out;
  }

  /** Listed in its folder (false for the second copy of a duplicate). */
  isListed(id: string): boolean {
    return this._listed.has(id);
  }

  /**
   * Select messages by id outside the folder list (search results): opens one
   * in the reader, several become the AI "selected" scope. The folder stays.
   */
  selectIds(ids: string[], opts: { additive?: boolean } = {}) {
    const known = ids.filter((x) => this._byId.has(x));
    if (opts.additive && known.length === 1) {
      const id = known[0];
      this.selectedKeys = this.selectedKeys.includes(id)
        ? this.selectedKeys.filter((x) => x !== id)
        : [...this.selectedKeys, id];
    } else {
      this.selectedKeys = known;
    }
    this.anchorId = this.selectedKeys[0] || null;
    this._applySelection();
  }

  folderCount(): number {
    return this._allFolderPaths().length;
  }

  findFolder(p: string | null): OfflineFolderNode | null {
    if (!p) {
      return null;
    }
    let found: OfflineFolderNode | null = null;
    const rec = (list: OfflineFolderNode[]) => {
      for (const n of list) {
        if (n.path === p) {
          found = n;
          return;
        }
        rec(n.children);
      }
    };
    rec(this.folders);
    return found;
  }

  setFolder(p: string, emit = true) {
    this.currentFolder = p;
    this.selectedIds = [];
    this.selectedKeys = [];
    this.anchorId = null;
    this.openMessage = null;
    this.openThread = null;
    this._visibleCache = null;
    this._rowsCache = null;
    // Expand ancestors so the selection is visible.
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      this.expanded.add(parts.slice(0, i).join('/'));
    }
    const node = this.findFolder(p);
    setOfflineArchiveCurrentFolder(
      node ? { path: node.path, name: node.displayPath } : { path: p, name: p }
    );
    setOfflineArchiveSelection([]);
    if (emit) {
      this._emit();
    }
  }

  toggleExpanded(p: string) {
    if (this.expanded.has(p)) {
      this.expanded.delete(p);
    } else {
      this.expanded.add(p);
    }
    const known = new Set(this._allFolderPaths());
    writeExpandedFolders(
      this._expandedFile,
      Array.from(this.expanded).filter((x) => known.size === 0 || known.has(x))
    );
    this._emit();
  }

  setFilter(filter: string) {
    this.filter = filter;
    this._visibleCache = null;
    this._rowsCache = null;
    this._emit();
  }

  /** Current folder's sort (default: date, newest first). */
  get sort(): OfflineSort {
    return (this.currentFolder && this._sortByFolder[this.currentFolder]) || DEFAULT_SORT;
  }

  /** Sort the current folder by a key; picking the active key flips the direction. */
  setSortKey(key: OfflineSortKey) {
    const cur = this.sort;
    this._setSort(
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: defaultDirFor(key) }
    );
  }

  toggleSortDir() {
    const cur = this.sort;
    this._setSort({ key: cur.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' });
  }

  private _setSort(sort: OfflineSort) {
    if (!this.currentFolder) {
      return;
    }
    if (sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir) {
      delete this._sortByFolder[this.currentFolder];
    } else {
      this._sortByFolder[this.currentFolder] = sort;
    }
    this._rowsCache = null;
    writeListPrefs(this.configDir, { density: this.density, sortByFolder: this._sortByFolder });
    this._emit();
  }

  setDensity(density: OfflineListDensity) {
    if (this.density === density) {
      return;
    }
    this.density = density;
    writeListPrefs(this.configDir, { density, sortByFolder: this._sortByFolder });
    this._emit();
  }

  setAttachmentsOnly(on: boolean) {
    if (this.attachmentsOnly === !!on) {
      return;
    }
    this.attachmentsOnly = !!on;
    this._visibleCache = null;
    this._rowsCache = null;
    this._emit();
  }

  /**
   * One-line preview of a message for the expanded list (read lazily from
   * the local copy, only for rows on screen). Null until loaded.
   */
  previewFor(id: string): string | null {
    const p = this._previews.get(id);
    if (p !== undefined) {
      return p;
    }
    if (this.root && !this._previewQueue.has(id)) {
      this._previewQueue.add(id);
      if (!this._previewTimer) {
        this._previewTimer = setTimeout(() => void this._loadPreviews(), 30);
      }
    }
    return null;
  }

  private async _loadPreviews() {
    const ids = Array.from(this._previewQueue).slice(0, 40);
    const root = this.root;
    for (const id of ids) {
      const e = this._byId.get(id);
      let text = '';
      if (e && root) {
        try {
          text = previewLine(parseOfflineMail(await readOfflineMessageRaw(root, e.rel)).text);
        } catch (err) {
          text = '';
        }
      }
      if (this._previews.size > 3000) {
        this._previews.clear();
      }
      this._previews.set(id, text);
      this._previewQueue.delete(id);
    }
    this._previewTimer = null;
    if (this._previewQueue.size) {
      this._previewTimer = setTimeout(() => void this._loadPreviews(), 30);
    }
    this._emit();
  }

  visibleMessages(): OfflineIndexEntry[] {
    const key = `${this.currentFolder}\u0000${this.filter}\u0000${this.attachmentsOnly ? 1 : 0}`;
    if (this._visibleCache && this._visibleCache.key === key) {
      return this._visibleCache.rows;
    }
    const all = (this.currentFolder && this._byFolder.get(this.currentFolder)) || [];
    const list = this.attachmentsOnly ? all.filter((e) => e.hasAttachments) : all;
    const q = this.filter.trim().toLowerCase();
    const rows = q ? list.filter((e) => `${e.subject} ${e.from}`.toLowerCase().includes(q)) : list;
    this._visibleCache = { key, rows };
    return rows;
  }

  getEntry(id: string): OfflineIndexEntry | undefined {
    return this._byId.get(id);
  }

  /**
   * Header lines + plain text of one archived message, read locally (no
   * attachment bytes). Used by "write with AI" on an explicit click only.
   */
  async messageTextFor(
    id: string
  ): Promise<{ from: string; date: string; subject: string; text: string } | null> {
    const entry = this._byId.get(id);
    if (!entry || !this.root) {
      return null;
    }
    let p = this._parsedCache.get(id) || null;
    if (!p) {
      try {
        p = await loadOfflineMessage(this.root, entry.rel);
      } catch (err) {
        return null;
      }
    }
    return { from: p.from || '', date: p.date || '', subject: p.subject || '', text: p.text || '' };
  }

  /** Conversation key of a message (its own id in the flat view). */
  rowKeyFor(id: string): string {
    return this.threaded ? this._threadOf.get(id) || id : id;
  }

  /** All messages of the conversation a message belongs to, oldest first. */
  threadIdsFor(id: string): string[] {
    const key = this._threadOf.get(id);
    const t = key ? this._threads.get(key) : null;
    return t ? this._unique(t.ids, this._byId.get(id)?.folder || null) : [id];
  }

  /** Thread messages with duplicate copies (same Message-ID) shown once. */
  private _unique(list: string[], preferFolder: string | null): string[] {
    return dedupeCopies(list, (x) => this._byId.get(x), preferFolder);
  }

  /** Lines of the message list: conversations (threaded) or single messages. */
  visibleRows(): OfflineListRow[] {
    return this._rows().rows;
  }

  getRow(key: string): OfflineListRow | undefined {
    return this._rows().byKey.get(key);
  }

  private _rows() {
    const sort = this.sort;
    const key = `${this.currentFolder}\u0000${this.filter}\u0000${this.threaded ? 1 : 0}\u0000${
      this.attachmentsOnly ? 1 : 0
    }\u0000${sort.key}:${sort.dir}`;
    if (this._rowsCache && this._rowsCache.key === key) {
      return this._rowsCache;
    }
    const messages = this.visibleMessages();
    const rows: OfflineListRow[] = [];
    const byKey = new Map<string, OfflineListRow>();
    for (const e of messages) {
      const k = this.rowKeyFor(e.id);
      if (byKey.has(k)) {
        continue;
      }
      const t = this.threaded ? this._threads.get(k) : null;
      const rowIds = t ? this._unique(t.ids, this.currentFolder) : [e.id];
      const inFolder = rowIds.filter(
        (x) => this._byId.get(x)?.folder === this.currentFolder
      ).length;
      const row: OfflineListRow = { key: k, entry: e, ids: rowIds, inFolder };
      byKey.set(k, row);
      rows.push(row);
    }
    const sorted =
      sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir && !this.threaded
        ? rows // already newest first
        : sortRows(rows, (r) => this._sortable(r), sort);
    this._rowsCache = { key, rows: sorted, byKey };
    return this._rowsCache;
  }

  /** What a row sorts by: conversations use the latest date, first sender, any attachment. */
  private _sortable(r: OfflineListRow) {
    if (r.ids.length <= 1) {
      const e = r.entry;
      return {
        ts: e.ts,
        subject: e.subject,
        from: e.from,
        hasAttachments: e.hasAttachments,
        // Real attachment bytes when known (older caches: message size).
        size: e.hasAttachments ? e.attachBytes || e.size : 0,
      };
    }
    const ents = r.ids.map((x) => this._byId.get(x)).filter(Boolean) as OfflineIndexEntry[];
    return {
      ts: Math.max(...ents.map((x) => x.ts || 0)),
      subject: (ents[0] || r.entry).subject,
      from: senderName((ents[0] || r.entry).from),
      hasAttachments: ents.some((x) => x.hasAttachments),
      size: ents.reduce((n, x) => n + (x.hasAttachments ? x.attachBytes || x.size || 0 : 0), 0),
    };
  }

  /** Switch between conversations and single messages; remembered. */
  setThreaded(threaded: boolean) {
    if (this.threaded === threaded) {
      return;
    }
    const keepId =
      this.openMessage?.id || this.openThread?.ids[this.openThread.ids.length - 1] || null;
    this.threaded = threaded;
    this._rowsCache = null;
    writeThreadedPref(this.configDir, threaded);
    this.selectedKeys = [];
    this.selectedIds = [];
    this.anchorId = null;
    this.openMessage = null;
    this.openThread = null;
    setOfflineArchiveSelection([]);
    const keepEntry = keepId ? this._byId.get(keepId) : undefined;
    if (keepEntry && keepEntry.folder === this.currentFolder) {
      this.select(this.rowKeyFor(keepId as string));
      return;
    }
    this._emit();
  }

  /** Select a row by its key (a message id is accepted too). */
  select(keyOrId: string, opts: { additive?: boolean; range?: boolean } = {}) {
    let key = keyOrId;
    if (!this.getRow(key)) {
      if (!this._byId.has(keyOrId)) {
        return;
      }
      key = this.rowKeyFor(keyOrId);
    }
    if (opts.range && this.anchorId) {
      const rows = this.visibleRows();
      const a = rows.findIndex((r) => r.key === this.anchorId);
      const b = rows.findIndex((r) => r.key === key);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.selectedKeys = rows.slice(lo, hi + 1).map((r) => r.key);
      } else {
        this.selectedKeys = [key];
      }
    } else if (opts.additive) {
      this.selectedKeys = this.selectedKeys.includes(key)
        ? this.selectedKeys.filter((x) => x !== key)
        : [...this.selectedKeys, key];
      this.anchorId = key;
    } else {
      this.selectedKeys = [key];
      this.anchorId = key;
    }
    this._applySelection(keyOrId !== key ? keyOrId : null);
  }

  private _idsForKey(key: string): string[] {
    const row = this.getRow(key);
    if (row) {
      return row.ids;
    }
    const t = this._threads.get(key);
    if (t) {
      return this._unique(t.ids, this.currentFolder);
    }
    return this._byId.has(key) ? [key] : [];
  }

  private _applySelection(focusId: string | null = null) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const k of this.selectedKeys) {
      for (const id of this._idsForKey(k)) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    this.selectedIds = ids;
    // AI "selected" scope: a selected conversation means all of its messages.
    setOfflineArchiveSelection(this.selectedIds);
    if (this.selectedKeys.length === 1 && ids.length === 1) {
      this.openThread = null;
      void this._open(ids[0]);
    } else if (this.selectedKeys.length === 1 && ids.length > 1) {
      this.openMessage = null;
      void this._openThread(this.selectedKeys[0], ids, focusId);
    } else {
      this.openMessage = null;
      this.openThread = null;
    }
    this._emit();
  }

  /** Row checkbox: add/remove one row without dropping the others. */
  toggleChecked(key: string) {
    this.select(key, { additive: true });
  }

  /** Select every row in the current (filtered) folder view. */
  selectAllVisible() {
    const rows = this.visibleRows();
    if (!rows.length) {
      return;
    }
    this.selectedKeys = rows.map((r) => r.key);
    this.anchorId = rows[0].key;
    this._applySelection();
  }

  clearSelection() {
    this.selectedKeys = [];
    this.selectedIds = [];
    this.openMessage = null;
    this.openThread = null;
    setOfflineArchiveSelection([]);
    this._emit();
  }

  /** Open a message by id (e.g. from an AI citation): switch folder, select it. */
  reveal(id: string): boolean {
    const entry = this._byId.get(id);
    if (!entry) {
      return false;
    }
    if (this.currentFolder !== entry.folder) {
      this.filter = '';
      this.setFolder(entry.folder, false);
    }
    this.select(id);
    return true;
  }

  moveSelection(delta: number) {
    const rows = this.visibleRows();
    if (!rows.length) {
      return;
    }
    const cur = this.selectedKeys.length
      ? rows.findIndex((r) => r.key === this.selectedKeys[this.selectedKeys.length - 1])
      : -1;
    const next = Math.max(0, Math.min(rows.length - 1, cur + delta));
    this.select(rows[next].key);
  }

  /** Expand/collapse one message inside the open conversation. */
  toggleThreadMessage(id: string) {
    const t = this.openThread;
    if (!t) {
      return;
    }
    const expanded = new Set(t.expanded);
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    this.openThread = { ...t, expanded };
    this._emit();
  }

  setThreadExpandedAll(expandAll: boolean) {
    const t = this.openThread;
    if (!t) {
      return;
    }
    const expanded = expandAll ? new Set(t.ids) : new Set([t.ids[t.ids.length - 1]]);
    this.openThread = { ...t, expanded };
    this._emit();
  }

  private async _openThread(key: string, allIds: string[], focusId: string | null) {
    if (!this.root) {
      return;
    }
    const seq = ++this._openSeq;
    const ids = allIds
      .filter((id) => this._byId.has(id))
      .sort((a, b) => (this._byId.get(a)?.ts || 0) - (this._byId.get(b)?.ts || 0))
      .slice(-OFFLINE_THREAD_READER_MAX);
    const newest = ids[ids.length - 1];
    const expanded = new Set<string>([newest]);
    if (focusId && ids.includes(focusId)) {
      expanded.add(focusId);
    }
    const parsed: { [id: string]: ParsedOfflineMail } = {};
    const missing: string[] = [];
    for (const id of ids) {
      const c = this._parsedCache.get(id);
      if (c) {
        parsed[id] = c;
      } else {
        missing.push(id);
      }
    }
    this.openThread = { key, ids, parsed, errors: {}, expanded, loading: missing.length > 0 };
    if (!missing.length) {
      return;
    }
    this._emit();
    // Newest first so the expanded message appears quickly.
    for (const id of missing.reverse()) {
      const entry = this._byId.get(id);
      if (!entry) {
        continue;
      }
      let error: string | null = null;
      let p: ParsedOfflineMail | null = null;
      try {
        p = await loadOfflineMessage(this.root, entry.rel);
        this._remember(id, p);
      } catch (err) {
        error = (err as Error).message || 'error';
      }
      if (seq !== this._openSeq || !this.openThread || this.openThread.key !== key) {
        return;
      }
      const cur: OpenThreadState = this.openThread;
      this.openThread = {
        ...cur,
        parsed: p ? { ...cur.parsed, [id]: p } : cur.parsed,
        errors: error ? { ...cur.errors, [id]: error } : cur.errors,
      };
      this._emit();
    }
    if (seq === this._openSeq && this.openThread && this.openThread.key === key) {
      this.openThread = { ...this.openThread, loading: false };
      this._emit();
    }
  }

  private _remember(id: string, parsed: ParsedOfflineMail) {
    if (this._parsedCache.size > 30 + OFFLINE_THREAD_READER_MAX) {
      const oldest = this._parsedCache.keys().next().value;
      if (oldest !== undefined) {
        this._parsedCache.delete(oldest);
      }
    }
    this._parsedCache.set(id, parsed);
  }

  private async _open(id: string) {
    const entry = this._byId.get(id);
    if (!entry || !this.root) {
      return;
    }
    const seq = ++this._openSeq;
    const cached = this._parsedCache.get(id);
    if (cached) {
      this.openMessage = { id, loading: false, parsed: cached, error: null };
      return;
    }
    this.openMessage = { id, loading: true, parsed: null, error: null };
    this._emit();
    try {
      const parsed = await loadOfflineMessage(this.root, entry.rel);
      this._remember(id, parsed);
      if (seq === this._openSeq) {
        this.openMessage = { id, loading: false, parsed, error: null };
      }
    } catch (err) {
      if (seq === this._openSeq) {
        this.openMessage = { id, loading: false, parsed: null, error: (err as Error).message };
      }
    }
    this._emit();
  }

  /** Attachments of one message with their bytes (read-only from the work copy). */
  attachmentData(id: string): OfflineMailAttachment[] {
    const entry = this._byId.get(id);
    if (!entry || !this.root) {
      return [];
    }
    return parseOfflineMail(readOfflineMessageRawSync(this.root, entry.rel), { withBytes: true })
      .attachments;
  }

  /** Sanitized counts only (no names), for logs and verification hooks. */
  summary() {
    const counts = this._rawCountsByFolder();
    const unique = this._countsByFolder();
    const manifestCounts = this.index?.manifestFolderCounts || null;
    let mismatchedFolders = 0;
    if (manifestCounts) {
      // The manifest keys folders by their server name; files live under the
      // sanitized stored path. Map server names back to stored paths first.
      const originalToStored: { [k: string]: string } = {};
      for (const [stored, original] of Object.entries(this.index?.folderNames || {})) {
        originalToStored[original] = stored;
      }
      const mapped: { [k: string]: number } = {};
      for (const [k, v] of Object.entries(manifestCounts)) {
        const stored = counts[k] !== undefined ? k : originalToStored[k] || k;
        mapped[stored] = (mapped[stored] || 0) + v;
      }
      const keys = new Set([...Object.keys(mapped), ...Object.keys(counts)]);
      for (const k of keys) {
        if ((mapped[k] || 0) !== (counts[k] || 0)) {
          mismatchedFolders++;
        }
      }
    }
    return {
      status: this.status,
      messages: this.index ? this.index.entries.length : 0,
      foldersWithMail: Object.keys(counts).length,
      /** Same message stored twice in one folder (shown and counted once). */
      duplicateCopies: Object.keys(counts).reduce((n, k) => n + counts[k] - (unique[k] || 0), 0),
      listedMessages: Object.values(unique).reduce((n, v) => n + v, 0),
      foldersTotal: this.folderCount(),
      manifestMessageCount: this.index?.manifestMessageCount ?? null,
      manifestFolderCount: manifestCounts ? Object.keys(manifestCounts).length : null,
      mismatchedFolders,
      unreadable: this.index ? this.index.unreadable.length : 0,
      hebrewHeaderMessages: this.index ? this.index.entries.filter((e) => e.hebrew).length : 0,
      stats: this.index?.stats || null,
      rootBase: this.root ? path.basename(this.root) : null,
    };
  }
}

export const offlineMailStore = new OfflineMailStore();
