import React from 'react';
import classNames from 'classnames';
import { tr, offlineDir, offlineDateLocale } from '../core/offline-i18n';
import { offlineMailStore, OfflineListRow } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { OfflineDraftsList } from './offline-drafts-view';
import { OfflineStoreComponent } from './use-offline-store';
import {
  OFFLINE_SORT_KEYS,
  OfflineSortKey,
  ROW_HEIGHTS,
  SORT_LABELS,
} from '../core/offline-list-view';

const OVERSCAN = 8;

/** Row height for the current density (compact = one line, expanded = three). */
function rowHeight(): number {
  return ROW_HEIGHTS[offlineMailStore.density] || ROW_HEIGHTS.expanded;
}

function formatDate(ts: number): string {
  if (!ts) {
    return '';
  }
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(offlineDateLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(offlineDateLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function shortFrom(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (m ? m[1] : from).trim();
}

type State = { scrollTop: number; height: number };

export class OfflineMessageList extends OfflineStoreComponent<Record<string, never>, State> {
  static displayName = 'OfflineMessageList';
  static containerStyles = { minWidth: 280, maxWidth: 900 };

  state: State = { scrollTop: 0, height: 800 };
  private _scrollRef: { current: HTMLDivElement | null } = { current: null };
  private _lastFolder: string | null = null;
  private _ro: ResizeObserver | null = null;

  componentDidMount() {
    super.componentDidMount();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        const el = this._scrollRef.current;
        if (el && el.clientHeight > 0) {
          this.setState({ height: el.clientHeight });
        }
      });
      if (this._scrollRef.current) {
        this._ro.observe(this._scrollRef.current);
      }
    }
  }

  /**
   * The scroll box is re-created after the drafts list was shown. Watch the
   * new one; the old (detached) one reports height 0, which used to leave only
   * the first 8 rows drawn with blank space below.
   */
  _setScrollEl = (el: HTMLDivElement | null) => {
    const prev = this._scrollRef.current;
    if (prev === el) {
      return;
    }
    if (prev && this._ro) {
      this._ro.unobserve(prev);
    }
    this._scrollRef.current = el;
    if (el && this._ro) {
      this._ro.observe(el);
    }
    if (el && prev) {
      this.setState({ scrollTop: el.scrollTop, height: el.clientHeight || this.state.height });
    }
  };

  componentWillUnmount() {
    super.componentWillUnmount();
    if (this._ro) {
      this._ro.disconnect();
    }
  }

  private _lastSelected: string | null = null;

  componentDidUpdate() {
    if (this._lastFolder !== offlineMailStore.currentFolder) {
      this._lastFolder = offlineMailStore.currentFolder;
      if (this._scrollRef.current) {
        this._scrollRef.current.scrollTop = 0;
      }
    }
    const keys = offlineMailStore.selectedKeys;
    const last = keys.length ? keys[keys.length - 1] : null;
    if (last !== this._lastSelected) {
      this._lastSelected = last;
      this._ensureVisible();
    }
  }

  _onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      offlineMailStore.moveSelection(1);
      this._ensureVisible();
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      offlineMailStore.moveSelection(-1);
      this._ensureVisible();
    }
  };

  _ensureVisible() {
    const el = this._scrollRef.current;
    const keys = offlineMailStore.selectedKeys;
    if (!el || !keys.length) {
      return;
    }
    const idx = offlineMailStore.visibleRows().findIndex((r) => r.key === keys[keys.length - 1]);
    if (idx === -1) {
      return;
    }
    const ROW_HEIGHT = rowHeight();
    const top = idx * ROW_HEIGHT;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
  }

  _people(row: OfflineListRow): string {
    // Conversation line: who wrote in it (newest last), short names only.
    const names: string[] = [];
    for (const id of row.ids) {
      const ent = offlineMailStore.getEntry(id);
      const n = ent ? shortFrom(ent.from) : '';
      if (n && !names.includes(n)) {
        names.push(n);
      }
    }
    if (names.length <= 3) {
      return names.join(', ');
    }
    return `${names[0]} … ${names.slice(-2).join(', ')}`;
  }

  _renderRow(row: OfflineListRow, i: number) {
    const e = row.entry;
    const selected = offlineMailStore.selectedKeys.includes(row.key);
    const isThread = row.ids.length > 1;
    const hasAttachments =
      e.hasAttachments ||
      (isThread && row.ids.some((id) => offlineMailStore.getEntry(id)?.hasAttachments));
    const ROW_HEIGHT = rowHeight();
    const compact = offlineMailStore.density === 'compact';
    const preview = compact ? null : offlineMailStore.previewFor(e.id);
    return (
      <div
        key={row.key}
        className={classNames('offline-message-row', { selected, 'is-thread': isThread })}
        style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
        data-offline-message-id={e.id}
        data-offline-row-key={row.key}
        data-offline-thread-count={isThread ? row.ids.length : undefined}
        data-hebrew={e.hebrew ? 'true' : undefined}
        role="option"
        aria-selected={selected}
        onClick={(ev) =>
          offlineMailStore.select(row.key, {
            additive: ev.ctrlKey || ev.metaKey,
            range: ev.shiftKey,
          })
        }
      >
        <span
          className={classNames('offline-row-check', { checked: selected })}
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? tr('בטל בחירה', 'Unselect') : tr('בחר הודעה', 'Select message')}
          title={
            selected
              ? tr('בטל בחירה', 'Unselect')
              : tr('בחר הודעה (אפשר לבחור כמה)', 'Select message (you can select several)')
          }
          data-offline-row-check="true"
          onClick={(ev) => {
            ev.stopPropagation();
            if (ev.shiftKey) {
              offlineMailStore.select(row.key, { range: true });
            } else {
              offlineMailStore.toggleChecked(row.key);
            }
          }}
        >
          {selected ? '✓' : ''}
        </span>
        <div className="offline-row-main">
          <div className="offline-row-line1">
            <span className="offline-row-from" dir="auto">
              {isThread ? this._people(row) : shortFrom(e.from)}
            </span>
            {isThread ? (
              <span
                className="offline-row-thread-count"
                data-offline-thread-badge="true"
                title={tr(
                  `${row.ids.length} הודעות בשיחה (${row.inFolder} בתיקייה הזו)`,
                  `${row.ids.length} messages in this conversation (${row.inFolder} in this folder)`
                )}
              >
                {row.ids.length}
              </span>
            ) : null}
            {compact ? (
              <span
                className="offline-row-subject offline-row-subject-inline"
                dir="auto"
                data-offline-subject="true"
              >
                {e.subject}
              </span>
            ) : null}
            {hasAttachments ? (
              <span className="offline-row-attach" title={tr('קבצים מצורפים', 'Attachments')}>
                📎
              </span>
            ) : null}
            <span className="offline-row-date">{formatDate(e.ts)}</span>
          </div>
          {compact ? null : (
            <div className="offline-row-subject" dir="auto" data-offline-subject="true">
              {e.subject}
            </div>
          )}
          {compact ? null : (
            <div className="offline-row-preview" dir="auto" data-offline-preview="true">
              {preview === null ? '\u00a0' : preview || tr('(אין טקסט)', '(no text)')}
            </div>
          )}
        </div>
      </div>
    );
  }

  _renderTools() {
    const s = offlineMailStore;
    const sort = s.sort;
    const asc = sort.dir === 'asc';
    const dirLabel =
      sort.key === 'date'
        ? asc
          ? tr('ישן לחדש', 'Oldest first')
          : tr('חדש לישן', 'Newest first')
        : sort.key === 'attachments'
          ? asc
            ? tr('בלי צרופות קודם', 'Without attachments first')
            : tr('עם צרופות (גדולות) קודם', 'With (large) attachments first')
          : asc
            ? tr('א→ת / A→Z', 'A→Z / א→ת')
            : tr('ת→א / Z→A', 'Z→A / ת→א');
    return (
      <div className="offline-list-tools" dir={offlineDir()} data-offline-list-tools="true">
        <label
          className="offline-list-sort"
          title={tr('מיון הרשימה (נשמר לכל תיקייה)', 'Sort the list (remembered per folder)')}
        >
          <span className="offline-list-tools-label">{tr('מיון:', 'Sort:')}</span>
          <select
            data-offline-sort-key="true"
            value={sort.key}
            onChange={(e) => s.setSortKey(e.target.value as OfflineSortKey)}
          >
            {OFFLINE_SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {tr(SORT_LABELS[k][0], SORT_LABELS[k][1])}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="offline-list-tool-btn"
          data-offline-sort-dir={sort.dir}
          title={tr(
            `כיוון המיון: ${dirLabel} (לחץ להפוך)`,
            `Sort direction: ${dirLabel} (click to reverse)`
          )}
          onClick={() => s.toggleSortDir()}
        >
          {asc ? '↑' : '↓'} {dirLabel}
        </button>
        <button
          type="button"
          className={classNames('offline-list-chip', { active: s.attachmentsOnly })}
          data-offline-attach-only={s.attachmentsOnly ? 'true' : 'false'}
          aria-pressed={s.attachmentsOnly}
          title={tr(
            'הצג רק הודעות/שיחות עם קבצים מצורפים',
            'Show only messages/conversations with attachments'
          )}
          onClick={() => s.setAttachmentsOnly(!s.attachmentsOnly)}
        >
          {tr('📎 רק עם צרופות', '📎 Attachments only')}
        </button>
        <span className="offline-list-density" role="group" aria-label={tr('צפיפות', 'Density')}>
          <button
            type="button"
            className={classNames('offline-list-tool-btn', { active: s.density === 'compact' })}
            data-offline-density-btn="compact"
            aria-pressed={s.density === 'compact'}
            title={tr('שורה אחת להודעה (נשמר)', 'One line per message (remembered)')}
            onClick={() => s.setDensity('compact')}
          >
            {tr('מצומצם', 'Compact')}
          </button>
          <button
            type="button"
            className={classNames('offline-list-tool-btn', { active: s.density === 'expanded' })}
            data-offline-density-btn="expanded"
            aria-pressed={s.density === 'expanded'}
            title={tr(
              'שלוש שורות: שולח ותאריך / נושא / תחילת ההודעה (נשמר)',
              'Three lines: sender and date / subject / preview (remembered)'
            )}
            onClick={() => s.setDensity('expanded')}
          >
            {tr('מורחב', 'Expanded')}
          </button>
        </span>
      </div>
    );
  }

  render() {
    if (offlineDraftsStore.showing) {
      return <OfflineDraftsList />;
    }
    const s = offlineMailStore;
    const rows = s.visibleRows();
    const messageCount = s.visibleMessages().length;
    const folder = s.findFolder(s.currentFolder);
    const { scrollTop } = this.state;
    const liveHeight = this._scrollRef.current ? this._scrollRef.current.clientHeight : 0;
    const height = liveHeight > 0 ? liveHeight : this.state.height || 800;
    const selectedSet = new Set(s.selectedKeys);
    const checkedInView = rows.reduce((n, r) => n + (selectedSet.has(r.key) ? 1 : 0), 0);
    const allChecked = rows.length > 0 && checkedInView === rows.length;
    const someChecked = checkedInView > 0;
    const ROW_HEIGHT = rowHeight();
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    // Rows not (fully) on screen below the visible part: shown as "N more below".
    const below = Math.max(0, rows.length - Math.floor((scrollTop + height) / ROW_HEIGHT));
    const visible: React.ReactNode[] = [];
    for (let i = start; i < end; i++) {
      visible.push(this._renderRow(rows[i], i));
    }
    return (
      <div
        className="offline-message-list"
        data-offline-message-list="true"
        data-row-count={rows.length}
      >
        <div className="offline-list-header">
          <div className="offline-list-title" dir="auto">
            {folder
              ? folder.displayPath
              : s.status === 'ready'
                ? tr('בחר תיקייה', 'Choose a folder')
                : ''}
            <span
              className="offline-list-count"
              data-offline-list-messages={messageCount}
              data-offline-list-conversations={s.threaded ? rows.length : undefined}
              title={tr(
                'הודעות = ההודעות בתיקייה הזו בלבד (עותק כפול של אותה הודעה נספר פעם אחת). ' +
                  'שיחות = שורות ברשימה; שיחה יכולה להציג גם הודעות מתיקיות אחרות, והן לא נספרות כאן.',
                'Messages = messages in this folder only (a duplicate copy of the same message counts once). ' +
                  'Conversations = rows in the list; a conversation may also show messages from other folders, which are not counted here.'
              )}
            >
              {s.threaded
                ? tr(
                    `${messageCount.toLocaleString()} הודעות · ${rows.length.toLocaleString()} שיחות`,
                    `${messageCount.toLocaleString()} messages · ${rows.length.toLocaleString()} conversations`
                  )
                : tr(
                    `${messageCount.toLocaleString()} הודעות`,
                    `${messageCount.toLocaleString()} messages`
                  )}
            </span>
            <label
              className="offline-list-threaded"
              data-offline-threaded-toggle="true"
              title={tr(
                'הצג הודעות מקובצות לשיחות (ההגדרה נשמרת)',
                'Group messages into conversations (remembered)'
              )}
            >
              <input
                type="checkbox"
                checked={s.threaded}
                onChange={(e) => s.setThreaded(e.target.checked)}
              />
              {tr('שיחות', 'Conversations')}
            </label>
          </div>
          <input
            className="offline-list-filter"
            type="search"
            dir="auto"
            placeholder={tr(
              'סינון לפי נושא/שולח (מקומי בלבד)',
              'Filter by subject/sender (local only)'
            )}
            value={s.filter}
            onChange={(e) => s.setFilter(e.target.value)}
          />
          {this._renderTools()}
          <div className="offline-list-selectbar" dir={offlineDir()}>
            <label className="offline-list-selectall" data-offline-select-all="true">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked && !allChecked;
                }}
                disabled={!rows.length}
                onChange={() => (allChecked ? s.clearSelection() : s.selectAllVisible())}
              />
              {tr('בחר הכל', 'Select all')}
            </label>
            {s.selectedIds.length > 0 ? (
              <span className="offline-list-selection">
                {s.selectedKeys.length === 1 && s.selectedIds.length > 1
                  ? tr(
                      `שיחה אחת (${s.selectedIds.length.toLocaleString()} הודעות) נבחרה`,
                      `1 conversation (${s.selectedIds.length.toLocaleString()} messages) selected`
                    )
                  : s.selectedKeys.length < s.selectedIds.length
                    ? tr(
                        `${s.selectedKeys.length.toLocaleString()} שיחות (${s.selectedIds.length.toLocaleString()} הודעות) נבחרו`,
                        `${s.selectedKeys.length.toLocaleString()} conversation(s) (${s.selectedIds.length.toLocaleString()} messages) selected`
                      )
                    : tr(
                        `${s.selectedIds.length.toLocaleString()} נבחרו`,
                        `${s.selectedIds.length.toLocaleString()} selected`
                      )}
                <button className="offline-list-clear" onClick={() => s.clearSelection()}>
                  {tr('נקה', 'Clear')}
                </button>
              </span>
            ) : (
              <span className="offline-list-selection-hint">
                {tr(
                  'סמן עיגול ליד הודעה כדי לבחור כמה',
                  'Tick the circle next to a message to select several'
                )}
              </span>
            )}
          </div>
        </div>
        <div
          className={`offline-list-scroll density-${s.density}`}
          data-offline-density={s.density}
          ref={this._setScrollEl}
          tabIndex={0}
          role="listbox"
          aria-multiselectable
          onKeyDown={this._onKeyDown}
          onScroll={(e) => this.setState({ scrollTop: (e.target as HTMLDivElement).scrollTop })}
        >
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>{visible}</div>
        </div>
        {below > 0 ? (
          <button
            type="button"
            className="offline-list-more"
            data-offline-list-more={below}
            onClick={() => {
              const el = this._scrollRef.current;
              if (el) {
                el.scrollTop += Math.max(ROW_HEIGHT, el.clientHeight - ROW_HEIGHT);
              }
            }}
          >
            {tr(`▼ עוד ${below.toLocaleString()} למטה`, `▼ ${below.toLocaleString()} more below`)}
          </button>
        ) : null}
      </div>
    );
  }
}
