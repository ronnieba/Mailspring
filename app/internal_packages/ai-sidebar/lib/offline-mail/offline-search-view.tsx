import React from 'react';
import classNames from 'classnames';
import { tr, offlineDir, offlineDateLocale } from '../core/offline-i18n';
import { highlightParts, SnippetPart, truncateMiddlePath } from '../core/offline-search';
import { offlineMailStore } from './offline-mail-store';
import { offlineSearchStore, OfflineSearchScope, OfflineSearchSort } from './offline-search-store';
import { OfflineStoreComponent } from './use-offline-store';
import { askAiAboutMail } from './write-with-ai';
import { ASK_AI_QUESTION_HINT, ASK_AI_TOOLTIP, looksLikeQuestion } from '../core/offline-search-qa';
import { OfflineHelpTip } from './offline-tour';
import { OfflineMic } from './offline-voice';

const ROW = 78;
const OVERSCAN = 6;

function shortFrom(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (m ? m[1] : from).trim();
}

function formatDate(ts: number): string {
  if (!ts) {
    return '';
  }
  return new Date(ts).toLocaleDateString(offlineDateLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderParts(parts: SnippetPart[]): React.ReactNode[] {
  return parts.map((p, i) =>
    p.hit ? (
      <mark key={i} className="offline-search-hit">
        {p.t}
      </mark>
    ) : (
      <React.Fragment key={i}>{p.t}</React.Fragment>
    )
  );
}

function focusSearch() {
  const input = document.querySelector('.offline-search-input') as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
  }
}

export const OFFLINE_SEARCH_HELP: [string, string] = [
  'חיפוש בכל שדות ההודעה: נושא, שולח, נמענים, גוף ההודעה ושמות קבצים מצורפים. ' +
    'מילים חלקיות מתאימות (משפ ← משפחה), בלי ניקוד ואותיות סופיות, גם עם ו/ה/ב/ל/מ/ש בתחילת מילה. ' +
    '"ביטוי מדויק" במירכאות, או / OR בין מילים. מסננים: from: / מאת:, to: / אל:, subject: / נושא:, file: / קובץ:, ' +
    'has:attachment / יש:צרופות, after:2024-01-01, before:2024-06, date:2023, folder: / תיקייה:, -מילה להוצאה. ' +
    'החיפוש מקומי בלבד (אינדקס בפרופיל הלא-מקוון), שום דבר לא נשלח לרשת.',
  'Searches subject, sender, recipients, body text and attachment names. ' +
    'Partial words match (fam → family); Hebrew without niqqud/final letters, with or without ו/ה/ב/ל/מ/ש prefixes. ' +
    '"Exact phrase" in quotes, OR between words. Filters: from:, to:, subject:, file:, has:attachment, ' +
    'after:2024-01-01, before:2024-06, date:2023, folder:, -word to exclude. ' +
    'Local only (index in the offline profile); nothing is sent to the network.',
];

/** Search box above the message list: text, scope, sort and index progress. */
export class OfflineSearchBar extends OfflineStoreComponent {
  static displayName = 'OfflineSearchBar';

  _onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      offlineSearchStore.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      offlineSearchStore.clear();
    } else if (e.key === 'ArrowDown' && offlineSearchStore.active) {
      e.preventDefault();
      const el = document.querySelector('.offline-search-scroll') as HTMLElement | null;
      if (el) {
        el.focus();
      }
      moveSearchSelection(1);
    }
  };

  render() {
    const s = offlineSearchStore;
    const b = s.build;
    const pct = b.total ? Math.floor((b.done / b.total) * 100) : 0;
    const question = looksLikeQuestion(s.query);
    return (
      <div className="offline-search-bar" dir={offlineDir()} data-offline-search-bar="true">
        <div className="offline-search-row">
          <span className="offline-search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            className="offline-search-input"
            type="text"
            dir="auto"
            data-offline-search-input="true"
            placeholder={tr(
              'חפש מילים, או כתוב שאלה ולחץ שאל AI',
              'Search words, or type a question and click Ask AI'
            )}
            title={tr(OFFLINE_SEARCH_HELP[0], OFFLINE_SEARCH_HELP[1])}
            value={s.query}
            onChange={(e) => s.setQuery(e.target.value)}
            onKeyDown={this._onKeyDown}
          />
          <OfflineMic
            target="[data-offline-search-input]"
            scope=".offline-search-row"
            size="small"
          />
          {s.query ? (
            <button
              type="button"
              className="offline-search-clear"
              data-offline-search-clear="true"
              title={tr('נקה חיפוש וחזור לתיקייה (Esc)', 'Clear search, back to the folder (Esc)')}
              onClick={() => s.clear()}
            >
              ✕
            </button>
          ) : null}
          <button
            type="button"
            className={`offline-search-ask-ai${question ? ' is-question' : ''}`}
            data-offline-search-ask-ai="true"
            data-offline-search-question={question ? 'true' : undefined}
            disabled={!s.query.trim()}
            title={tr(ASK_AI_TOOLTIP[0], ASK_AI_TOOLTIP[1])}
            onClick={() => askAiAboutMail(s.query)}
          >
            {tr('🤖 שאל AI', '🤖 Ask AI')}
          </button>
          <OfflineHelpTip tip="search" />
        </div>
        {question ? (
          <div
            className="offline-search-question-hint"
            data-offline-search-question-hint="true"
            role="status"
          >
            ✨ {tr(ASK_AI_QUESTION_HINT[0], ASK_AI_QUESTION_HINT[1])}
          </div>
        ) : null}
        <div className="offline-search-options">
          <select
            data-offline-search-scope="true"
            value={s.scope}
            title={tr('איפה לחפש', 'Where to search')}
            onChange={(e) => s.setScope(e.target.value as OfflineSearchScope)}
          >
            <option value="all">{tr('כל התיקיות', 'All folders')}</option>
            <option value="folder">{tr('התיקייה הנוכחית', 'Current folder')}</option>
            <option value="subtree">{tr('התיקייה + תת־תיקיות', 'Folder + subfolders')}</option>
          </select>
          <select
            data-offline-search-sort="true"
            value={s.sort}
            title={tr('סדר התוצאות', 'Result order')}
            onChange={(e) => s.setSort(e.target.value as OfflineSearchSort)}
          >
            <option value="relevance">{tr('הכי רלוונטי', 'Most relevant')}</option>
            <option value="date">{tr('הכי חדש', 'Newest')}</option>
          </select>
          {offlineMailStore.hasRelocations() ? (
            <label
              className="offline-search-include-hidden"
              data-offline-search-include-hidden={s.includeHidden ? 'true' : 'false'}
              title={tr(
                'חפש גם בהודעות שהוסתרו במחשב הזה: שולחים חסומים, אשפה (מקומי) וספאם (מקומי)',
                'Also search messages hidden on this computer: blocked senders, Trash (local) and Spam (local)'
              )}
            >
              <input
                type="checkbox"
                checked={s.includeHidden}
                onChange={(e) => s.setIncludeHidden(e.target.checked)}
              />
              {tr('כולל מוסתרות', 'Include hidden')}
            </label>
          ) : null}
          {b.running ? (
            <span
              className="offline-search-progress"
              data-offline-search-progress={pct}
              title={tr(
                'בונה אינדקס חיפוש מקומי (פעם אחת; אחר כך רק הודעות חדשות). אפשר כבר לחפש – התוצאות יתמלאו.',
                'Building the local search index (once; later only new mail). You can search already – results fill in.'
              )}
            >
              <span className="offline-search-progress-bar">
                <span style={{ width: `${pct}%` }} />
              </span>
              {tr(
                `אינדקס ${b.done.toLocaleString()}/${b.total.toLocaleString()}`,
                `Indexing ${b.done.toLocaleString()}/${b.total.toLocaleString()}`
              )}
            </span>
          ) : b.error ? (
            <span className="offline-search-progress error" title={b.error}>
              {tr('אינדקס החיפוש לא זמין', 'Search index unavailable')}
            </span>
          ) : b.indexed ? (
            <span className="offline-search-progress done" data-offline-search-indexed={b.indexed}>
              {tr(
                `${b.indexed.toLocaleString()} הודעות באינדקס`,
                `${b.indexed.toLocaleString()} messages indexed`
              )}
            </span>
          ) : null}
        </div>
      </div>
    );
  }
}

export function moveSearchSelection(delta: number) {
  const rows = offlineSearchStore.results;
  if (!rows.length) {
    return;
  }
  const sel = offlineMailStore.selectedKeys;
  const cur = sel.length ? rows.findIndex((r) => r.id === sel[sel.length - 1]) : -1;
  const next = Math.max(0, Math.min(rows.length - 1, cur + delta));
  offlineMailStore.selectIds([rows[next].id]);
}

type State = { scrollTop: number; height: number };

/** Results (all folders) with the folder name, highlighted subject and text. */
export class OfflineSearchResults extends OfflineStoreComponent<Record<string, never>, State> {
  static displayName = 'OfflineSearchResults';
  state: State = { scrollTop: 0, height: 600 };
  private _el: HTMLDivElement | null = null;
  private _ro: ResizeObserver | null = null;
  private _lastResults: unknown = null;

  componentDidMount() {
    super.componentDidMount();
    if (typeof ResizeObserver !== 'undefined' && this._el) {
      this._ro = new ResizeObserver(() => {
        if (this._el && this._el.clientHeight > 0) {
          this.setState({ height: this._el.clientHeight });
        }
      });
      this._ro.observe(this._el);
    }
  }

  componentWillUnmount() {
    super.componentWillUnmount();
    this._ro?.disconnect();
  }

  componentDidUpdate() {
    if (this._lastResults !== offlineSearchStore.results) {
      this._lastResults = offlineSearchStore.results;
      if (this._el) {
        this._el.scrollTop = 0;
      }
    }
    this._ensureVisible();
  }

  _ensureVisible() {
    const el = this._el;
    const sel = offlineMailStore.selectedKeys;
    if (!el || sel.length !== 1) {
      return;
    }
    const idx = offlineSearchStore.results.findIndex((r) => r.id === sel[0]);
    if (idx === -1) {
      return;
    }
    const top = idx * ROW;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW - el.clientHeight;
    }
  }

  _onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      moveSearchSelection(1);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      moveSearchSelection(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      focusSearch();
    }
  };

  render() {
    const s = offlineSearchStore;
    const rows = s.results;
    const words = s.parsed?.highlight || [];
    const height = (this._el && this._el.clientHeight) || this.state.height;
    const start = Math.max(0, Math.floor(this.state.scrollTop / ROW) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((this.state.scrollTop + height) / ROW) + OVERSCAN);
    const selected = new Set(offlineMailStore.selectedKeys);
    const items: React.ReactNode[] = [];
    for (let i = start; i < end; i++) {
      const r = rows[i];
      const e = r.entry;
      const folderName = offlineMailStore.folderLabel(r.folder);
      const snip = s.snippetFor(r.id);
      const isSel = selected.has(r.id);
      items.push(
        <div
          key={r.id}
          className={classNames('offline-search-row-item', { selected: isSel })}
          style={{ top: i * ROW, height: ROW }}
          role="option"
          aria-selected={isSel}
          data-offline-search-result={r.id}
          onClick={(ev) =>
            offlineMailStore.selectIds([r.id], { additive: ev.ctrlKey || ev.metaKey })
          }
          onDoubleClick={() => {
            s.clear();
            offlineMailStore.reveal(r.id);
          }}
        >
          <div className="offline-search-line1">
            <span
              className="offline-search-folder"
              data-offline-search-folder={r.folder}
              title={tr(`תיקייה: ${folderName}`, `Folder: ${folderName}`)}
            >
              <span className="offline-search-folder-icon" aria-hidden="true">
                📁
              </span>
              <bdi className="offline-search-folder-name">{truncateMiddlePath(folderName)}</bdi>
            </span>
            <span className="offline-search-from" dir="auto">
              {renderParts(highlightParts(shortFrom(e.from), words))}
            </span>
            {e.hasAttachments ? (
              <span className="offline-row-attach" title={tr('קבצים מצורפים', 'Attachments')}>
                📎
              </span>
            ) : null}
            <span className="offline-search-date">{formatDate(e.ts)}</span>
          </div>
          <div className="offline-search-subject" dir="auto">
            {renderParts(highlightParts(e.subject, words))}
          </div>
          <div className="offline-search-snippet" dir="auto" data-offline-search-snippet="true">
            {snip === null
              ? '\u00a0'
              : snip.length
                ? renderParts(snip)
                : tr('(אין טקסט)', '(no text)')}
          </div>
        </div>
      );
    }
    const scopeLabel =
      s.parsed && s.parsed.folders.length
        ? tr('בתיקיות שנבחרו', 'in the chosen folders')
        : s.scope === 'all'
          ? tr('בכל התיקיות', 'in all folders')
          : s.scope === 'folder'
            ? tr('בתיקייה הנוכחית', 'in the current folder')
            : tr('בתיקייה ובתת־תיקיות', 'in the folder and subfolders');
    return (
      <div className="offline-search-results" data-offline-search-results={rows.length}>
        <div className="offline-search-summary" dir={offlineDir()}>
          {s.error ? (
            <span className="offline-search-error">
              {tr('החיפוש נכשל: ', 'Search failed: ')}
              {s.error}
            </span>
          ) : (
            <span data-offline-search-total={s.total}>
              {s.total > rows.length
                ? tr(
                    `${s.total.toLocaleString()} תוצאות ${scopeLabel} (מוצגות ${rows.length.toLocaleString()} הראשונות)`,
                    `${s.total.toLocaleString()} results ${scopeLabel} (showing the first ${rows.length.toLocaleString()})`
                  )
                : tr(
                    `${rows.length.toLocaleString()} תוצאות ${scopeLabel}`,
                    `${rows.length.toLocaleString()} results ${scopeLabel}`
                  )}
              {s.build.running ? tr(' · האינדקס עדיין נבנה', ' · index still building') : ''}
            </span>
          )}
          {rows.length ? (
            <button
              type="button"
              className="offline-list-tool-btn"
              data-offline-search-select-all="true"
              title={tr(
                'בחר את כל התוצאות (למשל כדי לשאול את ה-AI עליהן כ"הודעות שנבחרו")',
                'Select all results (e.g. to ask the AI about them as "selected messages")'
              )}
              onClick={() => offlineMailStore.selectIds(rows.map((r) => r.id))}
            >
              {tr('בחר הכל', 'Select all')}
            </button>
          ) : null}
          <span className="offline-search-hint">
            {tr('לחיצה כפולה: פתח בתיקייה', 'Double-click: open in its folder')}
          </span>
        </div>
        <div
          className="offline-search-scroll"
          ref={(el) => {
            this._el = el;
          }}
          tabIndex={0}
          role="listbox"
          aria-multiselectable
          onKeyDown={this._onKeyDown}
          onScroll={(ev) => this.setState({ scrollTop: (ev.target as HTMLDivElement).scrollTop })}
        >
          {rows.length ? (
            <div style={{ height: rows.length * ROW, position: 'relative' }}>{items}</div>
          ) : s.error ? null : (
            <div className="offline-search-empty">
              {tr('לא נמצאו הודעות.', 'No messages found.')}
            </div>
          )}
        </div>
      </div>
    );
  }
}
