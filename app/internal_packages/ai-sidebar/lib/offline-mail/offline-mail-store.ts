/**
 * State for the offline experiment mail browser (folder tree, message list,
 * reader). Data comes only from a local read-only work copy. No account, no
 * mailsync, no Mailspring database, no network.
 */
import * as path from 'path';
import {
  buildFolderTree,
  buildOfflineMailIndex,
  IndexProgress,
  loadOfflineMessage,
  OfflineFolderNode,
  OfflineIndexEntry,
  OfflineMailIndex,
  readOfflineMessageRawSync,
} from '../core/offline-mail-index';
import { parseOfflineMail, ParsedOfflineMail } from '../core/offline-mail-mime';
import { OFFLINE_ARCHIVE_ACCOUNT_ID, OfflineArchiveMessage } from '../core/offline-archive-format';
import {
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

type Listener = () => void;

function folderIdFor(p: string): string {
  return p.replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_') || 'INBOX';
}

class OfflineMailStore {
  status: OfflineBrowserStatus = 'idle';
  progress: IndexProgress | null = null;
  error: string | null = null;
  root: string | null = null;
  index: OfflineMailIndex | null = null;
  folders: OfflineFolderNode[] = [];
  currentFolder: string | null = null;
  selectedIds: string[] = [];
  anchorId: string | null = null;
  filter = '';
  openMessage: OpenMessageState | null = null;
  expanded = new Set<string>();

  private _listeners = new Set<Listener>();
  private _byId = new Map<string, OfflineIndexEntry>();
  private _byFolder = new Map<string, OfflineIndexEntry[]>();
  private _visibleCache: { key: string; rows: OfflineIndexEntry[] } | null = null;
  private _parsedCache = new Map<string, ParsedOfflineMail>();
  private _openSeq = 0;

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
        } folders (reused ${index.stats.reused}, parsed ${index.stats.parsed}, ${index.stats.ms}ms, unreadable ${index.unreadable.length})`
      );
    } catch (err) {
      this.status = 'error';
      this.error = (err as Error).message || String(err);
      console.error('[Offline mail] index failed:', this.error);
    }
    this._emit();
  }

  private _countsByFolder(): { [p: string]: number } {
    const out: { [p: string]: number } = {};
    for (const [k, v] of this._byFolder) {
      out[k] = v.length;
    }
    return out;
  }

  private _applyIndex(index: OfflineMailIndex) {
    this.index = index;
    this._byId.clear();
    this._byFolder.clear();
    for (const e of index.entries) {
      this._byId.set(e.id, e);
      const list = this._byFolder.get(e.folder) || [];
      list.push(e);
      this._byFolder.set(e.folder, list);
    }
    for (const list of this._byFolder.values()) {
      list.sort((a, b) => b.ts - a.ts);
    }
    this.folders = buildFolderTree(index);
    const root = this.root as string;
    const messages: OfflineArchiveMessage[] = index.entries.map((e) => ({
      id: e.id,
      threadId: `offline-thread-${e.id.slice(8, 20)}`,
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
      attachmentCount: e.hasAttachments ? 1 : 0,
      sourceRelPath: e.rel,
    }));
    const folderCounts = this._countsByFolder();
    setOfflineArchiveBrowserCatalog(
      messages,
      {
        version: 1,
        kind: 'offline-archive',
        originalRoot: root,
        messageCount: messages.length,
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
    this.anchorId = null;
    this.openMessage = null;
    this._visibleCache = null;
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
    this._emit();
  }

  setFilter(filter: string) {
    this.filter = filter;
    this._visibleCache = null;
    this._emit();
  }

  visibleMessages(): OfflineIndexEntry[] {
    const key = `${this.currentFolder}\u0000${this.filter}`;
    if (this._visibleCache && this._visibleCache.key === key) {
      return this._visibleCache.rows;
    }
    const list = (this.currentFolder && this._byFolder.get(this.currentFolder)) || [];
    const q = this.filter.trim().toLowerCase();
    const rows = q ? list.filter((e) => `${e.subject} ${e.from}`.toLowerCase().includes(q)) : list;
    this._visibleCache = { key, rows };
    return rows;
  }

  getEntry(id: string): OfflineIndexEntry | undefined {
    return this._byId.get(id);
  }

  select(id: string, opts: { additive?: boolean; range?: boolean } = {}) {
    if (!this._byId.has(id)) {
      return;
    }
    if (opts.range && this.anchorId) {
      const rows = this.visibleMessages();
      const a = rows.findIndex((r) => r.id === this.anchorId);
      const b = rows.findIndex((r) => r.id === id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.selectedIds = rows.slice(lo, hi + 1).map((r) => r.id);
      } else {
        this.selectedIds = [id];
      }
    } else if (opts.additive) {
      this.selectedIds = this.selectedIds.includes(id)
        ? this.selectedIds.filter((x) => x !== id)
        : [...this.selectedIds, id];
      this.anchorId = id;
    } else {
      this.selectedIds = [id];
      this.anchorId = id;
    }
    setOfflineArchiveSelection(this.selectedIds);
    if (this.selectedIds.length === 1) {
      void this._open(this.selectedIds[0]);
    } else {
      this.openMessage = null;
    }
    this._emit();
  }

  /** Row checkbox: add/remove one message without dropping the others. */
  toggleChecked(id: string) {
    this.select(id, { additive: true });
  }

  /** Select every message in the current (filtered) folder view. */
  selectAllVisible() {
    const rows = this.visibleMessages();
    if (!rows.length) {
      return;
    }
    this.selectedIds = rows.map((r) => r.id);
    this.anchorId = rows[0].id;
    setOfflineArchiveSelection(this.selectedIds);
    if (this.selectedIds.length === 1) {
      void this._open(this.selectedIds[0]);
    } else {
      this.openMessage = null;
    }
    this._emit();
  }

  clearSelection() {
    this.selectedIds = [];
    this.openMessage = null;
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
    const rows = this.visibleMessages();
    if (!rows.length) {
      return;
    }
    const cur = this.selectedIds.length
      ? rows.findIndex((r) => r.id === this.selectedIds[this.selectedIds.length - 1])
      : -1;
    const next = Math.max(0, Math.min(rows.length - 1, cur + delta));
    this.select(rows[next].id);
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
      if (this._parsedCache.size > 30) {
        const oldest = this._parsedCache.keys().next().value;
        if (oldest !== undefined) {
          this._parsedCache.delete(oldest);
        }
      }
      this._parsedCache.set(id, parsed);
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

  /** Sanitized counts only (no names), for logs and verification hooks. */
  summary() {
    const counts = this._countsByFolder();
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
