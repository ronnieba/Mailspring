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
import {
  LocalPlace,
  LOCAL_PLACE_LABELS,
  OverlayData,
  OverlayMessage,
  applyOverlay,
  emptyOverlay,
  localFolderPath,
  localPlaceOf,
  overlayCounts,
  patchMessage,
  readOverlay,
  senderDisplayName,
  senderEmail,
  writeOverlay,
} from '../core/offline-local-overlay';
import { tr } from '../core/offline-i18n';
import {
  LocalRule,
  LocalRuleThen,
  LocalRuleWhen,
  MAX_RULE_RUNS,
  MAX_RULES,
  RuleRun,
  newRuleId,
  planRules,
  ruleHasCondition,
  sanitizeRule,
} from '../core/offline-rules';

/** Result of one rules run (counts only). */
export type OfflineRuleRunResult = {
  run: RuleRun | null;
  changed: number;
  blocked: number;
  perRule: { [ruleId: string]: number };
};

/** Undo for one local change (restores the previous records). */
export type OfflineUndo = () => void;

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
  /** Local changes (t227): flags, local folders, moves, blocked senders. */
  overlay: OverlayData = emptyOverlay();
  /** Bumped on every local change (list caches key on it). */
  overlayVersion = 0;
  /** Show messages of blocked senders anyway (this session). */
  showBlocked = false;
  /** Quick filters (this session). */
  unreadOnly = false;
  starredOnly = false;
  private _hidden = new Set<string>();
  private _rawById = new Map<string, OfflineIndexEntry>();

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
    this.overlay = readOverlay(this.configDir);
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
      this._runRulesOnNewMail();
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
    this._rawById = new Map(index.entries.map((e) => [e.id, e]));
    this._rebuildView(true);
  }

  /**
   * Lists, counts, conversations, folder tree and the AI catalog from the
   * read-only index with the local changes applied on top.
   */
  private _rebuildView(initial: boolean) {
    const index = this.index;
    if (!index) {
      return;
    }
    const view = applyOverlay(index.entries, this.overlay, { showBlocked: this.showBlocked });
    this._hidden = view.hidden;
    const shown = view.entries.filter((e) => !view.hidden.has(e.id));
    this._byId.clear();
    this._byFolder.clear();
    for (const e of view.entries) {
      this._byId.set(e.id, e);
    }
    for (const e of shown) {
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
    const grouped = buildThreads(shown);
    this._threads = grouped.threads;
    this._threadOf = grouped.threadOf;
    this._rowsCache = null;
    this._visibleCache = null;
    this.folders = buildFolderTree({
      entries: shown.filter((e) => !localPlaceOf(e.folder)),
      folderNames: index.folderNames,
    });
    const root = this.root as string;
    const messages: OfflineArchiveMessage[] = shown
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
    if (initial) {
      const first = this.folders.find((f) => f.count > 0) || this.folders[0];
      if (first) {
        this.setFolder(first.path, false);
      }
      return;
    }
    // Keep the folder; drop rows that left it (moved, deleted, blocked).
    const keep = this.selectedKeys.filter((k) => this.getRow(k));
    if (keep.length !== this.selectedKeys.length) {
      this.selectedKeys = keep;
      this.anchorId = keep[0] || null;
      this._applySelection();
    } else {
      this._emit();
    }
  }

  // ---- Local changes (t227) -------------------------------------------

  /** Folder name for display (local virtual folders included). */
  folderLabel(p: string | null): string {
    if (!p) {
      return '';
    }
    const place = localPlaceOf(p);
    if (place) {
      const l = LOCAL_PLACE_LABELS[place];
      return tr(l[0], l[1]);
    }
    return this.findFolder(p)?.displayPath || p;
  }

  /** Messages in each local virtual folder. */
  localFolderCount(place: LocalPlace): number {
    return (this._byFolder.get(localFolderPath(place)) || []).length;
  }

  localPlaceOfCurrent(): LocalPlace | null {
    return localPlaceOf(this.currentFolder);
  }

  isLocalFolder(p: string | null = this.currentFolder): boolean {
    return !!localPlaceOf(p);
  }

  /** The stored folder a message really lives in (read-only copy). */
  originalFolder(id: string): string | null {
    return this._rawById.get(id)?.folder || null;
  }

  /** Where the message shows now. */
  effectiveFolderOf(id: string): string | null {
    return this._byId.get(id)?.folder || null;
  }

  /** Any local move / delete / archive / spam or blocked sender? */
  hasRelocations(): boolean {
    return (
      this.overlay.blocked.length > 0 ||
      Object.values(this.overlay.messages).some((m) => !!(m.place || m.folder))
    );
  }

  isHidden(id: string): boolean {
    return this._hidden.has(id);
  }

  hiddenCount(): number {
    return this._hidden.size;
  }

  /** Changed locally (moved / deleted / archived / spam): "Restore" applies. */
  isRelocated(id: string): boolean {
    const m = this.overlay.messages[id];
    return !!(m && (m.place || m.folder));
  }

  isStarred(id: string): boolean {
    return !!this.overlay.messages[id]?.star;
  }

  isUnread(id: string): boolean {
    return !!this.overlay.messages[id]?.unread;
  }

  /** Row flags: a conversation counts its messages in this folder. */
  rowFlags(row: OfflineListRow): { unread: boolean; starred: boolean } {
    const ids = this.rowIdsInFolder(row);
    return {
      unread: ids.some((id) => this.isUnread(id)),
      starred: ids.some((id) => this.isStarred(id)),
    };
  }

  rowIdsInFolder(row: OfflineListRow): string[] {
    const inFolder = row.ids.filter((id) => this._byId.get(id)?.folder === this.currentFolder);
    return inFolder.length ? inFolder : [row.entry.id];
  }

  /**
   * Messages the actions apply to: the selected rows' messages in the
   * current folder (a conversation acts on its messages here, like Yahoo),
   * or the selected search results.
   */
  actionIds(): string[] {
    const inFolder = this.selectedIds.filter(
      (id) => this._byId.get(id)?.folder === this.currentFolder
    );
    return inFolder.length ? inFolder : this.selectedIds.slice();
  }

  private _commit(ids: string[], before: [string, OverlayMessage | undefined][]): OfflineUndo {
    this.overlayVersion++;
    this._saveOverlay();
    this._rebuildView(false);
    return () => {
      for (const [id, m] of before) {
        if (m) {
          this.overlay.messages[id] = m;
        } else {
          delete this.overlay.messages[id];
        }
      }
      this.overlayVersion++;
      this._saveOverlay();
      this._rebuildView(false);
    };
  }

  private _saveOverlay() {
    try {
      writeOverlay(this.configDir, this.overlay);
    } catch (err) {
      console.warn('[Offline mail] could not save local changes', (err as any)?.code);
    }
  }

  private _snap(ids: string[]): [string, OverlayMessage | undefined][] {
    return ids.map((id) => [
      id,
      this.overlay.messages[id] ? { ...this.overlay.messages[id] } : undefined,
    ]);
  }

  private _patch(ids: string[], patch: (id: string) => Partial<OverlayMessage>): OfflineUndo {
    const known = ids.filter((id) => this._rawById.has(id));
    const before = this._snap(known);
    const now = Date.now();
    for (const id of known) {
      patchMessage(this.overlay, id, patch(id), now);
    }
    return this._commit(known, before);
  }

  /** Delete / archive / spam: into the local virtual folder (restorable). */
  moveToPlace(ids: string[], place: LocalPlace): OfflineUndo {
    return this._patch(ids, () => ({ place }));
  }

  /** Move to another folder (its own folder = back where it was). */
  moveToFolder(ids: string[], folder: string): OfflineUndo {
    return this._patch(ids, (id) =>
      folder === this.originalFolder(id)
        ? { place: undefined, folder: undefined }
        : { folder, place: undefined }
    );
  }

  /** Back to the folder it really is in. */
  restore(ids: string[]): OfflineUndo {
    return this._patch(ids, () => ({ place: undefined, folder: undefined }));
  }

  setStarred(ids: string[], on: boolean): OfflineUndo {
    return this._patch(ids, () => ({ star: on }));
  }

  setUnread(ids: string[], on: boolean): OfflineUndo {
    return this._patch(ids, () => ({ unread: on }));
  }

  isBlocked(email: string): boolean {
    const e = (email || '').toLowerCase();
    return !!e && this.overlay.blocked.some((b) => b.email === e);
  }

  /** Hide every message from this sender (locally); undo = unblock. */
  blockSender(email: string, name = ''): OfflineUndo | null {
    const e = (email || '').trim().toLowerCase();
    if (!e || this.isBlocked(e)) {
      return null;
    }
    this.overlay.blocked = [...this.overlay.blocked, { email: e, name, at: Date.now() }];
    this.overlayVersion++;
    this._saveOverlay();
    this._rebuildView(false);
    return () => this.unblockSender(e);
  }

  unblockSender(email: string) {
    const e = (email || '').toLowerCase();
    const next = this.overlay.blocked.filter((b) => b.email !== e);
    if (next.length === this.overlay.blocked.length) {
      return;
    }
    this.overlay.blocked = next;
    this.overlayVersion++;
    this._saveOverlay();
    this._rebuildView(false);
  }

  isSavedContact(email: string): boolean {
    const e = (email || '').toLowerCase();
    return !!e && this.overlay.contacts.some((c) => c.email === e);
  }

  addContact(email: string, name = ''): OfflineUndo | null {
    const e = (email || '').trim().toLowerCase();
    if (!e || this.isSavedContact(e)) {
      return null;
    }
    this.overlay.contacts = [...this.overlay.contacts, { email: e, name, at: Date.now() }];
    this.overlayVersion++;
    this._saveOverlay();
    this._emit();
    return () => this.removeContact(e);
  }

  removeContact(email: string) {
    const e = (email || '').toLowerCase();
    this.overlay.contacts = this.overlay.contacts.filter((c) => c.email !== e);
    this.overlayVersion++;
    this._saveOverlay();
    this._emit();
  }

  /** Senders of the given messages (unique, lower-case). */
  sendersOf(ids: string[]): { email: string; name: string }[] {
    const out: { email: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const e = this._rawById.get(id);
      const email = e ? senderEmail(e.from) : '';
      if (email && !seen.has(email)) {
        seen.add(email);
        const m = /^\s*"?([^"<]+?)"?\s*</.exec(e?.from || '');
        out.push({ email, name: m ? m[1].trim() : '' });
      }
    }
    return out;
  }

  /** Forget every local change (flags, local folders, moves, blocks, contacts). */
  resetLocalChanges(): number {
    const n = overlayCounts(this.overlay).total;
    this.overlay = emptyOverlay();
    this.overlayVersion++;
    this._saveOverlay();
    this._rebuildView(false);
    return n;
  }

  localChangeCounts() {
    return overlayCounts(this.overlay);
  }

  // ---- Local rules (t233) ----------------------------------------------

  /** Last automatic run on new mail (for a toast), cleared once shown. */
  pendingRuleNotice: OfflineRuleRunResult | null = null;

  get rules(): LocalRule[] {
    return this.overlay.rules;
  }

  private _saveRules() {
    this.overlayVersion++;
    this._saveOverlay();
    this._emit();
  }

  /** Add or replace a rule. Returns the saved rule, or null when invalid. */
  saveRule(input: {
    id?: string;
    name?: string;
    enabled?: boolean;
    when: LocalRuleWhen;
    then: LocalRuleThen;
  }): LocalRule | null {
    const now = Date.now();
    const old = input.id ? this.overlay.rules.find((r) => r.id === input.id) : undefined;
    const rule = sanitizeRule({
      id: old ? old.id : newRuleId(now),
      name: input.name || '',
      enabled: input.enabled !== false,
      when: input.when,
      then: input.then,
      createdAt: old ? old.createdAt : now,
      // New mail = mail that arrives after the rule was made / last ran.
      lastRunAt: old ? old.lastRunAt : now,
      applied: old ? old.applied : 0,
    });
    if (!rule || !ruleHasCondition(rule.when)) {
      return null;
    }
    if (old) {
      this.overlay.rules = this.overlay.rules.map((r) => (r.id === rule.id ? rule : r));
    } else {
      if (this.overlay.rules.length >= MAX_RULES) {
        return null;
      }
      this.overlay.rules = [...this.overlay.rules, rule];
    }
    this._saveRules();
    return rule;
  }

  setRuleEnabled(id: string, on: boolean) {
    const r = this.overlay.rules.find((x) => x.id === id);
    if (!r || r.enabled === !!on) {
      return;
    }
    this.overlay.rules = this.overlay.rules.map((x) =>
      x.id === id ? { ...x, enabled: !!on, lastRunAt: on ? Date.now() : x.lastRunAt } : x
    );
    this._saveRules();
  }

  /** Delete a rule (what it already did stays; "Undo last run" still works). */
  deleteRule(id: string): OfflineUndo | null {
    const idx = this.overlay.rules.findIndex((r) => r.id === id);
    if (idx < 0) {
      return null;
    }
    const removed = this.overlay.rules[idx];
    this.overlay.rules = this.overlay.rules.filter((r) => r.id !== id);
    this._saveRules();
    return () => {
      if (!this.overlay.rules.some((r) => r.id === removed.id)) {
        const next = this.overlay.rules.slice();
        next.splice(Math.min(idx, next.length), 0, removed);
        this.overlay.rules = next;
        this._saveRules();
      }
    };
  }

  moveRule(id: string, delta: number) {
    const list = this.overlay.rules.slice();
    const i = list.findIndex((r) => r.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) {
      return;
    }
    [list[i], list[j]] = [list[j], list[i]];
    this.overlay.rules = list;
    this._saveRules();
  }

  /** Delete every rule (their past changes stay until undone / reset). */
  deleteAllRules(): number {
    const n = this.overlay.rules.length;
    if (n) {
      this.overlay.rules = [];
      this._saveRules();
    }
    return n;
  }

  /**
   * Run rules: `ids` = these rules (else every enabled rule). 'manual' looks
   * at all mail; 'new-mail' only at mail newer than each rule's last run.
   * One recorded run, undoable with undoLastRuleRun().
   */
  runRules(ids: string[] | null, trigger: 'manual' | 'new-mail' = 'manual'): OfflineRuleRunResult {
    const empty: OfflineRuleRunResult = { run: null, changed: 0, blocked: 0, perRule: {} };
    if (!this.index) {
      return empty;
    }
    const chosen = this.overlay.rules.filter(
      (r) => (ids ? ids.includes(r.id) : true) && (ids && trigger === 'manual' ? true : r.enabled)
    );
    if (!chosen.length) {
      return empty;
    }
    const now = Date.now();
    const targets = this.index.entries
      .filter((e) => !this._hidden.has(e.id) && this._byId.has(e.id))
      .map((e) => ({
        id: e.id,
        folder: this._byId.get(e.id)!.folder,
        from: e.from,
        to: e.to,
        cc: e.cc,
        subject: e.subject,
        hasAttachments: e.hasAttachments,
        attachCount: e.attachCount,
        ts: e.ts,
        mtimeMs: e.mtimeMs,
      }));
    const plan = planRules(
      chosen.map((r) => ({ ...r, enabled: true })),
      targets,
      this.overlay,
      {
        since: trigger === 'new-mail' ? (r) => r.lastRunAt : undefined,
        senderOf: (from) => ({ email: senderEmail(from), name: senderDisplayName(from) }),
        placeOf: (f) => localPlaceOf(f),
      }
    );
    const changes = Array.from(plan.patches.keys()).map((id) => ({
      id,
      before: this.overlay.messages[id] ? { ...this.overlay.messages[id] } : null,
    }));
    for (const [id, patch] of plan.patches) {
      const p = { ...patch };
      // Moved back to the folder it really is in = no move record.
      if (p.folder && p.folder === this.originalFolder(id)) {
        p.folder = undefined;
      }
      patchMessage(this.overlay, id, p, now);
    }
    const blocked: string[] = [];
    for (const [email, name] of plan.block) {
      if (!this.overlay.blocked.some((b) => b.email === email)) {
        this.overlay.blocked = [...this.overlay.blocked, { email, name, at: now }];
        blocked.push(email);
      }
    }
    this.overlay.rules = this.overlay.rules.map((r) =>
      chosen.some((c) => c.id === r.id)
        ? { ...r, lastRunAt: now, applied: r.applied + (plan.perRule[r.id] || 0) }
        : r
    );
    let run: RuleRun | null = null;
    if (changes.length || blocked.length) {
      run = {
        id: `run-${now.toString(36)}`,
        at: now,
        trigger,
        ruleIds: chosen.map((r) => r.id),
        changes,
        blocked,
      };
      this.overlay.ruleRuns = [...this.overlay.ruleRuns, run].slice(-MAX_RULE_RUNS);
    }
    this.overlayVersion++;
    this._saveOverlay();
    if (run) {
      this._rebuildView(false);
    } else {
      this._emit();
    }
    return { run, changed: changes.length, blocked: blocked.length, perRule: plan.perRule };
  }

  /** The last recorded rules run (what "Undo last run" would undo). */
  lastRuleRun(): RuleRun | null {
    const runs = this.overlay.ruleRuns;
    return runs.length ? runs[runs.length - 1] : null;
  }

  /** Put back what the last rules run changed (messages and blocks). */
  undoLastRuleRun(): number {
    const run = this.lastRuleRun();
    if (!run) {
      return 0;
    }
    for (const c of run.changes) {
      if (c.before) {
        this.overlay.messages[c.id] = { ...c.before };
      } else {
        delete this.overlay.messages[c.id];
      }
    }
    if (run.blocked.length) {
      const undo = new Set(run.blocked);
      this.overlay.blocked = this.overlay.blocked.filter((b) => !undo.has(b.email));
    }
    this.overlay.ruleRuns = this.overlay.ruleRuns.slice(0, -1);
    this.overlayVersion++;
    this._saveOverlay();
    this._rebuildView(false);
    return run.changes.length + run.blocked.length;
  }

  /** After (re)indexing: enabled rules act on mail that arrived since they last ran. */
  private _runRulesOnNewMail() {
    if (!this.overlay.rules.some((r) => r.enabled)) {
      return;
    }
    try {
      const res = this.runRules(null, 'new-mail');
      if (res.run) {
        this.pendingRuleNotice = res;
      }
    } catch (err) {
      console.warn('[Offline mail] rules on new mail failed', (err as Error)?.message);
    }
  }

  setShowBlocked(on: boolean) {
    if (this.showBlocked === !!on) {
      return;
    }
    this.showBlocked = !!on;
    this.overlayVersion++;
    this._rebuildView(false);
  }

  setUnreadOnly(on: boolean) {
    this.unreadOnly = !!on;
    this._visibleCache = null;
    this._rowsCache = null;
    this._emit();
  }

  setStarredOnly(on: boolean) {
    this.starredOnly = !!on;
    this._visibleCache = null;
    this._rowsCache = null;
    this._emit();
  }

  /** Search filter: hidden = blocked senders and the local trash/spam. */
  searchShows(id: string, includeHidden: boolean, scope: string[] | null): boolean {
    const e = this._byId.get(id);
    if (!e) {
      return false;
    }
    if (scope) {
      return !this._hidden.has(id) && scope.includes(e.folder);
    }
    if (includeHidden) {
      return true;
    }
    const place = localPlaceOf(e.folder);
    return !this._hidden.has(id) && place !== 'trash' && place !== 'spam';
  }

  /** Opening a message marks it read (local flag only). */
  private _markOpenedRead(ids: string[]) {
    const unread = ids.filter((id) => this.isUnread(id));
    if (!unread.length) {
      return;
    }
    for (const id of unread) {
      patchMessage(this.overlay, id, { unread: undefined });
    }
    this.overlayVersion++;
    this._saveOverlay();
    this._visibleCache = null;
    this._rowsCache = null;
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
      node ? { path: node.path, name: node.displayPath } : { path: p, name: this.folderLabel(p) }
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
    const key = `${this.currentFolder}\u0000${this.filter}\u0000${this.attachmentsOnly ? 1 : 0}\u0000${
      this.unreadOnly ? 1 : 0
    }${this.starredOnly ? 1 : 0}\u0000${this.overlayVersion}`;
    if (this._visibleCache && this._visibleCache.key === key) {
      return this._visibleCache.rows;
    }
    const all = (this.currentFolder && this._byFolder.get(this.currentFolder)) || [];
    let list = this.attachmentsOnly ? all.filter((e) => e.hasAttachments) : all;
    if (this.unreadOnly) {
      list = list.filter((e) => this.isUnread(e.id));
    }
    if (this.starredOnly) {
      list = list.filter((e) => this.isStarred(e.id));
    }
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
    }${this.unreadOnly ? 1 : 0}${this.starredOnly ? 1 : 0}\u0000${sort.key}:${sort.dir}\u0000${
      this.overlayVersion
    }`;
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
      if (this.openMessage?.id !== ids[0]) {
        this._markOpenedRead(ids);
      }
      void this._open(ids[0]);
    } else if (this.selectedKeys.length === 1 && ids.length > 1) {
      this.openMessage = null;
      if (this.openThread?.key !== this.selectedKeys[0]) {
        this._markOpenedRead(ids);
      }
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
      /** Local overlay (counts only): stars, read marks, local folders, blocks. */
      localChanges: overlayCounts(this.overlay),
      hiddenByBlock: this._hidden.size,
    };
  }
}

export const offlineMailStore = new OfflineMailStore();
