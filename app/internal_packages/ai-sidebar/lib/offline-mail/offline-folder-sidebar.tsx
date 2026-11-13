import React from 'react';
import classNames from 'classnames';
import { tr } from '../core/offline-i18n';
import { offlineMailStore } from './offline-mail-store';
import { OfflineStoreComponent } from './use-offline-store';
import { OfflineFolderNode } from '../core/offline-mail-index';

export class OfflineFolderSidebar extends OfflineStoreComponent {
  static displayName = 'OfflineFolderSidebar';
  static containerStyles = { minWidth: 180, maxWidth: 520 };

  _renderNode(node: OfflineFolderNode): React.ReactNode {
    const s = offlineMailStore;
    const hasChildren = node.children.length > 0;
    const open = s.expanded.has(node.path);
    const active = s.currentFolder === node.path;
    return (
      <div
        key={node.path}
        className="offline-folder-node"
        role="treeitem"
        aria-expanded={hasChildren ? open : undefined}
      >
        <div
          className={classNames('offline-folder-row', { active, empty: node.totalCount === 0 })}
          style={{ paddingInlineStart: 4 + node.depth * 16 }}
          data-offline-folder-row="true"
          data-folder-count={node.count}
          onClick={() => s.setFolder(node.path)}
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
          <span className="offline-folder-name" dir="auto">
            {node.name}
          </span>
          {hasChildren && !open ? (
            <span
              className="offline-folder-subcount"
              title={tr(
                `${node.children.length} תיקיות משנה`,
                `${node.children.length} subfolders`
              )}
              data-offline-folder-subcount={node.children.length}
            >
              +{node.children.length}
            </span>
          ) : null}
          <span className="offline-folder-count">
            {hasChildren && !open ? node.totalCount : node.count}
          </span>
        </div>
        {hasChildren && open ? node.children.map((c) => this._renderNode(c)) : null}
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
          </div>
        ) : null}
        <div className="offline-folder-tree" role="tree" aria-label={tr('תיקיות', 'Folders')}>
          {s.folders.map((n) => this._renderNode(n))}
        </div>
      </div>
    );
  }
}
