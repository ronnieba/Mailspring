import React from 'react';
import classNames from 'classnames';
import { tr } from '../core/offline-i18n';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { OfflineStoreComponent } from './use-offline-store';
import { OfflineFolderNode } from '../core/offline-mail-index';
import { offlineFolderIconKind } from '../core/offline-folder-roles';
import { OfflineFolderIcon } from './offline-folder-icon';
import { LocalPlace, localFolderPath } from '../core/offline-local-overlay';
import { openBlockedList } from './offline-message-actions';

const LOCAL_ROWS: { place: LocalPlace; kind: 'trash' | 'archive' | 'spam' }[] = [
  { place: 'trash', kind: 'trash' },
  { place: 'archive', kind: 'archive' },
  { place: 'spam', kind: 'spam' },
];

export class OfflineFolderSidebar extends OfflineStoreComponent {
  static displayName = 'OfflineFolderSidebar';
  static containerStyles = { minWidth: 180, maxWidth: 520 };

  _renderNode(node: OfflineFolderNode): React.ReactNode {
    const s = offlineMailStore;
    const hasChildren = node.children.length > 0;
    const open = s.expanded.has(node.path);
    const active = s.currentFolder === node.path;
    const iconKind = offlineFolderIconKind({
      name: node.name,
      depth: node.depth,
      hasChildren,
      open,
    });
    const count = hasChildren && !open ? node.totalCount : node.count;
    return (
      <div
        key={node.path}
        className="offline-folder-node"
        role="treeitem"
        aria-expanded={hasChildren ? open : undefined}
      >
        <div
          className={classNames('offline-folder-row', { active, empty: node.totalCount === 0 })}
          style={
            {
              paddingInlineStart: 4 + node.depth * 16,
              '--ofl-depth-x': `${node.depth * 16}px`,
            } as React.CSSProperties
          }
          data-depth={node.depth}
          data-offline-folder-row="true"
          data-folder-count={node.count}
          onClick={() => {
            offlineDraftsStore.hide();
            s.setFolder(node.path);
          }}
          title={node.displayPath}
        >
          {hasChildren ? (
            <button
              type="button"
              className={classNames('offline-folder-toggle', { open })}
              aria-expanded={open}
              aria-label={tr('הרחב / כווץ תיקיות משנה', 'Expand / collapse subfolders')}
              title={tr('הרחב / כווץ תיקיות משנה', 'Expand / collapse subfolders')}
              data-offline-folder-toggle="true"
              onClick={(e) => {
                e.stopPropagation();
                s.toggleExpanded(node.path);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <span className="offline-folder-toggle-spacer" aria-hidden="true" />
          )}
          <OfflineFolderIcon kind={iconKind} />
          <span className="offline-folder-name" dir="auto">
            {node.name}
          </span>
          <span
            className={classNames('offline-folder-count', { zero: count === 0 })}
            title={tr(`${count} הודעות`, `${count} messages`)}
          >
            {count.toLocaleString()}
          </span>
          {hasChildren && !open ? (
            <span
              className="offline-folder-subcount"
              dir="ltr"
              title={tr(
                `${node.children.length} תיקיות משנה`,
                `${node.children.length} subfolders`
              )}
              data-offline-folder-subcount={node.children.length}
            >
              +{node.children.length}
            </span>
          ) : null}
        </div>
        {hasChildren && open ? (
          <div
            className="offline-folder-children"
            role="group"
            style={{ '--ofl-guide-x': `${(node.depth + 1) * 16}px` } as React.CSSProperties}
          >
            {node.children.map((c) => this._renderNode(c))}
          </div>
        ) : null}
      </div>
    );
  }

  _renderLocal(): React.ReactNode {
    const s = offlineMailStore;
    const blocked = s.overlay.blocked.length;
    return (
      <div
        className="offline-local-folders"
        role="group"
        aria-label={tr('תיקיות מקומיות', 'Local folders')}
        data-offline-local-folders="true"
      >
        <div className="offline-local-folders-title">
          {tr('במחשב הזה בלבד', 'On this computer only')}
        </div>
        {LOCAL_ROWS.map(({ place, kind }) => {
          const p = localFolderPath(place);
          const count = s.localFolderCount(place);
          return (
            <div
              key={place}
              className={classNames('offline-folder-row offline-local-entry', {
                selected: s.currentFolder === p && !offlineDraftsStore.showing,
              })}
              role="button"
              data-offline-local-entry={place}
              data-folder-count={count}
              title={tr(
                'הודעות שהוסרו רק במחשב הזה — אפשר לשחזר',
                'Messages removed on this computer only — can be restored'
              )}
              onClick={() => {
                offlineDraftsStore.hide();
                s.setFolder(p);
              }}
            >
              <span className="offline-folder-toggle-spacer" aria-hidden="true" />
              <OfflineFolderIcon kind={kind} />
              <span className="offline-folder-name">{s.folderLabel(p)}</span>
              <span className={classNames('offline-folder-count', { zero: count === 0 })}>
                {count.toLocaleString()}
              </span>
            </div>
          );
        })}
        <div
          className="offline-folder-row offline-local-entry"
          role="button"
          data-offline-blocked-entry={blocked}
          title={tr('צפייה וביטול חסימה', 'View and unblock')}
          onClick={() => openBlockedList()}
        >
          <span className="offline-folder-toggle-spacer" aria-hidden="true" />
          <span className="offline-local-blocked-icon" aria-hidden="true">
            ⛔
          </span>
          <span className="offline-folder-name">{tr('שולחים חסומים', 'Blocked senders')}</span>
          <span className={classNames('offline-folder-count', { zero: blocked === 0 })}>
            {blocked.toLocaleString()}
          </span>
        </div>
      </div>
    );
  }

  render() {
    const s = offlineMailStore;
    const summary = s.status === 'ready' ? s.summary() : null;
    return (
      <div className="offline-folder-sidebar" data-offline-folder-sidebar="true">
        <div className="offline-banner" data-offline-banner="true" role="note">
          <strong>{tr('מצב ניסוי לא מקוון', 'Offline experiment')}</strong>
          <span>
            {tr(
              'עותק מקומי לקריאה בלבד. בלי Yahoo, בלי סנכרון, בלי שליחה.',
              'Local read-only copy. No Yahoo, no sync, no sending.'
            )}
          </span>
        </div>
        {s.status === 'indexing' ? (
          <div className="offline-status">
            {tr('מאנדקס את העותק המקומי… ', 'Indexing local copy… ')}
            {s.progress ? `${s.progress.done}/${s.progress.total}` : ''}
          </div>
        ) : null}
        {s.status === 'error' ? (
          <div className="offline-status error">
            {tr('לא ניתן לפתוח את העותק המקומי: ', 'Could not open the local copy: ')}
            {s.error}
          </div>
        ) : null}
        {summary ? (
          <div
            className="offline-status"
            data-offline-total={summary.messages}
            data-offline-folders={summary.foldersTotal}
          >
            {tr(
              `${summary.messages.toLocaleString()} הודעות · ${summary.foldersTotal} תיקיות`,
              `${summary.messages.toLocaleString()} messages · ${summary.foldersTotal} folders`
            )}
            {summary.hiddenByBlock
              ? tr(
                  ` · ${summary.hiddenByBlock.toLocaleString()} מוסתרות`,
                  ` · ${summary.hiddenByBlock.toLocaleString()} hidden`
                )
              : ''}
          </div>
        ) : null}
        <div
          className={classNames('offline-folder-row offline-drafts-entry', {
            selected: offlineDraftsStore.showing,
          })}
          role="button"
          data-offline-drafts-entry="true"
          data-drafts-count={offlineDraftsStore.count}
          title={tr(
            'טיוטות שנשמרו רק במחשב הזה (אין שליחה)',
            'Drafts saved only on this computer (no sending)'
          )}
          onClick={() => offlineDraftsStore.showList()}
        >
          <span className="offline-folder-toggle-spacer" aria-hidden="true" />
          <OfflineFolderIcon kind="local-drafts" />
          <span className="offline-folder-name">{tr('טיוטות מקומיות', 'Local drafts')}</span>
          <span
            className={classNames('offline-folder-count', { zero: offlineDraftsStore.count === 0 })}
          >
            {offlineDraftsStore.count.toLocaleString()}
          </span>
        </div>
        <div className="offline-folder-tree" role="tree" aria-label={tr('תיקיות', 'Folders')}>
          {s.folders.map((n) => this._renderNode(n))}
        </div>
        {s.status === 'ready' ? this._renderLocal() : null}
      </div>
    );
  }
}
