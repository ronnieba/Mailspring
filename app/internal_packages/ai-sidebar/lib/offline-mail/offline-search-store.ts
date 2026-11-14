/**
 * Offline experiment: local full-text search (state + background indexing).
 *
 * The FTS index lives in the offline profile (offline-search.sqlite). It is
 * filled once from the read-only work copy and then only updated for new /
 * changed / removed messages. No network; mail content stays on this PC.
 */
import * as path from 'path';
import {
  OfflineSearchIndex,
  OFFLINE_SEARCH_DB,
  ParsedSearchQuery,
  SEARCH_HEAD_BYTES,
  SearchDoc,
  SnippetPart,
  buildSnippet,
  normalizeSearchText,
  parseSearchQuery,
  SEARCH_RESULT_LIMIT,
} from '../core/offline-search';
import { readOfflineMessageHead, OfflineIndexEntry } from '../core/offline-mail-index';
import { extractOfflineSearchText } from '../core/offline-mail-mime';
import { offlineMailStore } from './offline-mail-store';
import { QA_MAX_MESSAGES, questionToSearchQuery } from '../core/offline-search-qa';
import { setOfflineQuestionSearcher } from '../offline-archive-catalog';

export type OfflineSearchScope = 'folder' | 'subtree' | 'all';
export type OfflineSearchSort = 'relevance' | 'date';

export type OfflineSearchResult = {
  id: string;
  folder: string;
  ts: number;
  entry: OfflineIndexEntry;
};

export type OfflineSearchBuild = {
  running: boolean;
  done: number;
  total: number;
  /** Messages in the index when the last pass finished. */
  indexed: number;
  added: number;
  removed: number;
  ms: number;
  error: string | null;
};

type Listener = () => void;

const BATCH = 24;
const READ_CONCURRENCY = 12;

class OfflineSearchStore {
  /** Text in the search box. */
  query = '';
  scope: OfflineSearchScope = 'all';
  /** Also find messages hidden locally (blocked senders, local trash/spam). */
  includeHidden = false;
  sort: OfflineSearchSort = 'relevance';
  /** Results replace the folder list while true. */
  active = false;
  parsed: ParsedSearchQuery | null = null;
  results: OfflineSearchResult[] = [];
  total = 0;
  searchMs = 0;
  error: string | null = null;
  build: OfflineSearchBuild = {
    running: false,
    done: 0,
    total: 0,
    indexed: 0,
    added: 0,
    removed: 0,
    ms: 0,
    error: null,
  };

  private _ix: OfflineSearchIndex | null = null;
  private _root: string | null = null;
  private _listeners = new Set<Listener>();
  private _gen = 0;
  private _builtFor: unknown = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _snippets = new Map<string, SnippetPart[]>();
  private _snipQueue = new Set<string>();
  private _snipTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastFolder: string | null = null;

  listen(cb: Listener): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (err) {
        console.error('[Offline search] listener failed', err);
      }
    }
  }

  /** Called when the mail index is ready (or changed): bring the search index up to date. */
  attach(configDir: string, root: string) {
    if (this._root !== root || !this._ix) {
      this._ix?.close();
      this._ix = null;
      try {
        this._ix = new OfflineSearchIndex(path.join(configDir, OFFLINE_SEARCH_DB), root);
        this._root = root;
        this.build = { ...this.build, indexed: this._ix.count() };
      } catch (err) {
        this.build = { ...this.build, error: (err as Error).message };
        console.error('[Offline search] index not available:', (err as Error).message);
        this._emit();
        return;
      }
    }
    void this.update();
  }

  /** Stop indexing and close the index file (window closing / tests). */
  close() {
    this._gen++;
    this._ix?.close();
    this._ix = null;
    this._root = null;
    this._builtFor = null;
  }

  get available(): boolean {
    return !!this._ix;
  }

  /** Index new / changed messages, drop removed ones. */
  async update(): Promise<void> {
    const ix = this._ix;
    const root = this._root;
    const index = offlineMailStore.index;
    if (!ix || !root || !index || this._builtFor === index) {
      return;
    }
    this._builtFor = index;
    const gen = ++this._gen;
    const started = Date.now();
    const plan = ix.plan(index.entries);
    const byRel = new Map(index.entries.map((e) => [e.rel, e]));
    this.build = {
      running: plan.add.length > 0,
      done: 0,
      total: plan.add.length,
      indexed: plan.unchanged,
      added: 0,
      removed: plan.remove.length,
      ms: 0,
      error: null,
    };
    this._emit();
    try {
      if (plan.remove.length) {
        ix.remove(plan.remove);
      }
      let lastEmit = 0;
      for (let i = 0; i < plan.add.length; i += BATCH) {
        if (gen !== this._gen) {
          return;
        }
        const rels = plan.add.slice(i, i + BATCH);
        const heads: Array<Buffer | null> = new Array(rels.length).fill(null);
        for (let k = 0; k < rels.length; k += READ_CONCURRENCY) {
          await Promise.all(
            rels.slice(k, k + READ_CONCURRENCY).map(async (rel, j) => {
              try {
                heads[k + j] = await readOfflineMessageHead(root, rel, SEARCH_HEAD_BYTES);
              } catch {
                heads[k + j] = null;
              }
            })
          );
        }
        const docs: SearchDoc[] = [];
        for (let k = 0; k < rels.length; k++) {
          const e = byRel.get(rels[k]);
          if (!e) {
            continue;
          }
          let body = '';
          const head = heads[k];
          if (head) {
            try {
              body = extractOfflineSearchText(head);
            } catch {
              body = '';
            }
          }
          docs.push({
            id: e.id,
            rel: e.rel,
            folder: e.folder,
            ts: e.ts,
            size: e.size,
            mtimeMs: e.mtimeMs,
            hasAttachments: e.hasAttachments,
            subject: e.subject,
            from: e.from,
            recipients: [e.to, e.cc].filter(Boolean).join(', '),
            body,
            attachNames: e.attachNames || [],
          });
        }
        ix.addMany(docs);
        this.build = {
          ...this.build,
          done: Math.min(plan.add.length, i + rels.length),
          added: this.build.added + docs.length,
          indexed: this.build.indexed + docs.length,
        };
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          this._emit();
        }
        // Keep the window responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.build = { ...this.build, running: false, ms: Date.now() - started, indexed: ix.count() };
      ix.setMeta('builtAt', new Date().toISOString());
      console.log(
        `[Offline search] index ${this.build.indexed} messages (added ${this.build.added}, removed ${this.build.removed}, ${this.build.ms}ms)`
      );
    } catch (err) {
      this.build = { ...this.build, running: false, error: (err as Error).message };
      console.error('[Offline search] build failed:', (err as Error).message);
    }
    if (this.active) {
      this.run();
    }
    this._emit();
  }

  setQuery(q: string) {
    this.query = q;
    if (this._timer) {
      clearTimeout(this._timer);
    }
    if (!q.trim()) {
      this.clear();
      return;
    }
    this._timer = setTimeout(() => {
      this._timer = null;
      this.run();
    }, 250);
    this._emit();
  }

  setIncludeHidden(on: boolean) {
    this.includeHidden = !!on;
    if (this.active) {
      this.run();
    } else {
      this._emit();
    }
  }

  setScope(scope: OfflineSearchScope) {
    this.scope = scope;
    if (this.active) {
      this.run();
    } else {
      this._emit();
    }
  }

  setSort(sort: OfflineSearchSort) {
    this.sort = sort;
    if (this.active) {
      this.run();
    } else {
      this._emit();
    }
  }

  clear() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.query = '';
    this.active = false;
    this.parsed = null;
    this.results = [];
    this.total = 0;
    this.error = null;
    this._snippets.clear();
    this._emit();
  }

  /** The folder (current / with subfolders / named by folder:) the search covers; null = all. */
  scopeFolders(p: ParsedSearchQuery): string[] | null {
    const all = offlineMailStore.allFolderNodes();
    if (p.folders.length) {
      const wanted = p.folders.map((f) => normalizeSearchText(f));
      return all
        .filter((n) => {
          const a = normalizeSearchText(n.path);
          const b = normalizeSearchText(n.displayPath);
          return wanted.some((w) => a.includes(w) || b.includes(w));
        })
        .map((n) => n.path);
    }
    const cur = offlineMailStore.currentFolder;
    if (this.scope === 'all' || !cur) {
      return null;
    }
    if (this.scope === 'folder' || offlineMailStore.isLocalFolder(cur)) {
      return [cur];
    }
    return all.filter((n) => n.path === cur || n.path.startsWith(`${cur}/`)).map((n) => n.path);
  }

  run() {
    const q = this.query.trim();
    if (!q) {
      this.clear();
      return;
    }
    this._lastFolder = offlineMailStore.currentFolder;
    this.active = true;
    this._snippets.clear();
    this._snipQueue.clear();
    const t0 = Date.now();
    try {
      if (!this._ix) {
        throw new Error(this.build.error || 'search index not ready');
      }
      const p = parseSearchQuery(q);
      this.parsed = p;
      const scope = this.scopeFolders(p);
      // Local changes (moves, local trash/spam, blocked senders) live outside
      // the search index: search everywhere, then keep what the views show.
      const local = offlineMailStore.hasRelocations();
      const { hits, total } = this._ix.search(p, {
        folders: local ? null : scope,
        sort: this.sort,
        limit: local ? SEARCH_RESULT_LIMIT * 10 : undefined,
      });
      let results: OfflineSearchResult[] = [];
      for (const h of hits) {
        const entry = offlineMailStore.getEntry(h.id);
        // Duplicate copies in one folder are listed once (like the folder list).
        if (!entry || !offlineMailStore.isListed(h.id)) {
          continue;
        }
        if (local && !offlineMailStore.searchShows(h.id, this.includeHidden, scope)) {
          continue;
        }
        results.push({ id: h.id, folder: entry.folder, ts: h.ts, entry });
      }
      let shownTotal = total;
      if (local) {
        shownTotal = results.length + Math.max(0, total - hits.length);
        results = results.slice(0, SEARCH_RESULT_LIMIT);
      }
      this.results = results;
      this.total = shownTotal;
      this.error = null;
    } catch (err) {
      this.results = [];
      this.total = 0;
      this.error = (err as Error).message;
    }
    this.searchMs = Date.now() - t0;
    this._emit();
  }

  /**
   * "Ask about my mail": the best local matches for a natural-language
   * question, by relevance, over the whole local copy (or folder: named in it).
   * Respects local changes (moved / deleted / blocked are left out, like the
   * views). Does not change the search box or the results list.
   */
  searchForQuestion(
    question: string,
    limit = QA_MAX_MESSAGES
  ): { query: string; terms: string[]; ids: string[]; total: number } {
    const qs = questionToSearchQuery(question);
    if (!this._ix || !qs.query) {
      return { ...qs, ids: [], total: 0 };
    }
    const p = parseSearchQuery(qs.query);
    if (!p.terms.some((t) => !t.negate)) {
      return { ...qs, ids: [], total: 0 };
    }
    const scope = p.folders.length ? this.scopeFolders(p) : null;
    const { hits, total } = this._ix.search(p, {
      folders: null,
      sort: 'relevance',
      limit: Math.max(limit * 10, 100),
    });
    const ids: string[] = [];
    for (const h of hits) {
      if (ids.length >= limit) {
        break;
      }
      if (!offlineMailStore.getEntry(h.id) || !offlineMailStore.isListed(h.id)) {
        continue;
      }
      if (!offlineMailStore.searchShows(h.id, false, scope)) {
        continue;
      }
      ids.push(h.id);
    }
    return { ...qs, ids, total: Math.max(total, ids.length) };
  }

  /** Folder changed while searching "this folder": search the new one. */
  onFolderChanged() {
    const cur = offlineMailStore.currentFolder;
    if (cur !== this._lastFolder) {
      this._lastFolder = cur;
      if (this.active && this.scope !== 'all') {
        this.run();
      }
    }
  }

  /** Highlighted piece of the body for a result row (read lazily, only rows on screen). */
  snippetFor(id: string): SnippetPart[] | null {
    const s = this._snippets.get(id);
    if (s) {
      return s;
    }
    if (!this._snipQueue.has(id)) {
      this._snipQueue.add(id);
      if (!this._snipTimer) {
        this._snipTimer = setTimeout(() => void this._loadSnippets(), 20);
      }
    }
    return null;
  }

  private async _loadSnippets() {
    const root = this._root;
    const words = this.parsed?.highlight || [];
    const ids = Array.from(this._snipQueue).slice(0, 30);
    for (const id of ids) {
      const e = offlineMailStore.getEntry(id);
      let parts: SnippetPart[] = [];
      if (e && root) {
        try {
          const text = extractOfflineSearchText(
            await readOfflineMessageHead(root, e.rel, SEARCH_HEAD_BYTES)
          );
          parts = buildSnippet(text, words);
        } catch {
          parts = [];
        }
      }
      if (this._snippets.size > 2000) {
        this._snippets.clear();
      }
      this._snippets.set(id, parts);
      this._snipQueue.delete(id);
    }
    this._snipTimer = null;
    if (this._snipQueue.size) {
      this._snipTimer = setTimeout(() => void this._loadSnippets(), 20);
    }
    this._emit();
  }

  /** Sanitized numbers only (no text), for logs and checks. */
  summary() {
    return {
      available: this.available,
      indexed: this.build.indexed,
      running: this.build.running,
      done: this.build.done,
      total: this.build.total,
      added: this.build.added,
      removed: this.build.removed,
      buildMs: this.build.ms,
      error: this.build.error ? 'error' : null,
      active: this.active,
      results: this.results.length,
      matches: this.total,
      searchMs: this.searchMs,
    };
  }
}

export const offlineSearchStore = new OfflineSearchStore();

// "Ask about my mail" in the AI panel runs its local search here (no UI change).
setOfflineQuestionSearcher((q) => offlineSearchStore.searchForQuestion(q));
