import React from 'react';
import classNames from 'classnames';
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
          style={{ paddingInlineStart: 8 + node.depth * 14 }}
          data-offline-folder-row="true"
          data-folder-count={node.count}
          onClick={() => s.setFolder(node.path)}
          title={node.displayPath}
        >
          <span
            className="offline-folder-toggle"
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) {
                s.toggleExpanded(node.path);
              }
            }}
          >
            {hasChildren ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="offline-folder-name" dir="auto">
            {node.name}
          </span>
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
          <strong>מצב ניסוי לא מקוון</strong>
          <span>Offline experiment — local read-only copy. No Yahoo, no sync, no sending.</span>
        </div>
        {s.status === 'indexing' ? (
          <div className="offline-status">
            Indexing local copy… {s.progress ? `${s.progress.done}/${s.progress.total}` : ''}
          </div>
        ) : null}
        {s.status === 'error' ? (
          <div className="offline-status error">Could not open the local copy: {s.error}</div>
        ) : null}
        {summary ? (
          <div
            className="offline-status"
            data-offline-total={summary.messages}
            data-offline-folders={summary.foldersTotal}
          >
            {summary.messages.toLocaleString()} messages · {summary.foldersTotal} folders
          </div>
        ) : null}
        <div className="offline-folder-tree" role="tree" aria-label="Offline folders">
          {s.folders.map((n) => this._renderNode(n))}
        </div>
      </div>
    );
  }
}
