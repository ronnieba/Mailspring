import React from 'react';
import classNames from 'classnames';
import { tr, offlineDir, offlineDateLocale } from '../core/offline-i18n';
import { offlineMailStore } from './offline-mail-store';
import { OfflineStoreComponent } from './use-offline-store';
import { OfflineIndexEntry } from '../core/offline-mail-index';

const ROW_HEIGHT = 54;
const OVERSCAN = 8;

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
  private _scrollRef = React.createRef<HTMLDivElement>();
  private _lastFolder: string | null = null;
  private _ro: ResizeObserver | null = null;

  componentDidMount() {
    super.componentDidMount();
    const el = this._scrollRef.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.setState({ height: el.clientHeight }));
      this._ro.observe(el);
    }
  }

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
    const ids = offlineMailStore.selectedIds;
    const last = ids.length ? ids[ids.length - 1] : null;
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
    const ids = offlineMailStore.selectedIds;
    if (!el || !ids.length) {
      return;
    }
    const idx = offlineMailStore.visibleMessages().findIndex((r) => r.id === ids[ids.length - 1]);
    if (idx === -1) {
      return;
    }
    const top = idx * ROW_HEIGHT;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
  }

  _renderRow(e: OfflineIndexEntry, i: number) {
    const selected = offlineMailStore.selectedIds.includes(e.id);
    return (
      <div
        key={e.id}
        className={classNames('offline-message-row', { selected })}
        style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
        data-offline-message-id={e.id}
        data-hebrew={e.hebrew ? 'true' : undefined}
        role="option"
        aria-selected={selected}
        onClick={(ev) =>
          offlineMailStore.select(e.id, { additive: ev.ctrlKey || ev.metaKey, range: ev.shiftKey })
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
              offlineMailStore.select(e.id, { range: true });
            } else {
              offlineMailStore.toggleChecked(e.id);
            }
          }}
        >
          {selected ? '✓' : ''}
        </span>
        <div className="offline-row-main">
          <div className="offline-row-line1">
            <span className="offline-row-from" dir="auto">
              {shortFrom(e.from)}
            </span>
            {e.hasAttachments ? (
              <span className="offline-row-attach" title={tr('קבצים מצורפים', 'Attachments')}>
                📎
              </span>
            ) : null}
            <span className="offline-row-date">{formatDate(e.ts)}</span>
          </div>
          <div className="offline-row-subject" dir="auto" data-offline-subject="true">
            {e.subject}
          </div>
        </div>
      </div>
    );
  }

  render() {
    const s = offlineMailStore;
    const rows = s.visibleMessages();
    const folder = s.findFolder(s.currentFolder);
    const { scrollTop, height } = this.state;
    const selectedSet = new Set(s.selectedIds);
    const checkedInView = rows.reduce((n, r) => n + (selectedSet.has(r.id) ? 1 : 0), 0);
    const allChecked = rows.length > 0 && checkedInView === rows.length;
    const someChecked = checkedInView > 0;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
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
            <span className="offline-list-count">{rows.length.toLocaleString()}</span>
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
                {tr(
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
          className="offline-list-scroll"
          ref={this._scrollRef}
          tabIndex={0}
          role="listbox"
          aria-multiselectable
          onKeyDown={this._onKeyDown}
          onScroll={(e) => this.setState({ scrollTop: (e.target as HTMLDivElement).scrollTop })}
        >
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>{visible}</div>
        </div>
      </div>
    );
  }
}
