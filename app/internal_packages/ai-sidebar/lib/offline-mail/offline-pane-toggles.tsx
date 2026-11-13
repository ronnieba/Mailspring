import React from 'react';
import classNames from 'classnames';
import { Actions, WorkspaceStore } from 'mailspring-exports';

const PANES: { id: string; label: string; icon: string }[] = [
  { id: 'RootSidebar', label: 'תיקיות', icon: '📁' },
  { id: 'MessageList', label: 'קורא', icon: '📄' },
  { id: 'MessageListSidebar', label: 'עוזר AI', icon: '🤖' },
];

/**
 * Offline experiment: show/hide buttons for the folders, reader and AI panel
 * columns. Hidden columns are kept in core.workspace.hiddenLocations of the
 * offline profile, so the choice survives a restart.
 */
export class OfflinePaneToggles extends React.Component {
  static displayName = 'OfflinePaneToggles';

  private _unlisten: (() => void) | null = null;

  componentDidMount() {
    this._unlisten = WorkspaceStore.listen(() => this.forceUpdate());
  }

  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
  }

  render() {
    return (
      <div
        className="offline-pane-toggles"
        dir="rtl"
        role="toolbar"
        aria-label="הצג או הסתר אזורים"
        data-offline-pane-toggles="true"
      >
        <span className="offline-pane-toggles-label">הצג:</span>
        {PANES.map((p) => {
          const loc = WorkspaceStore.Location[p.id];
          if (!loc) {
            return null;
          }
          const hidden = WorkspaceStore.isLocationHidden(loc);
          return (
            <button
              key={p.id}
              className={classNames('offline-pane-toggle', { off: hidden })}
              data-pane={p.id}
              aria-pressed={!hidden}
              title={hidden ? `הצג ${p.label}` : `הסתר ${p.label}`}
              onClick={() => Actions.toggleWorkspaceLocationHidden(loc)}
            >
              <span className="offline-pane-toggle-icon">{p.icon}</span>
              {p.label}
            </button>
          );
        })}
      </div>
    );
  }
}
