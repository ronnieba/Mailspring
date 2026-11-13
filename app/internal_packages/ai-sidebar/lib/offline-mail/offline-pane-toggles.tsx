import React from 'react';
import classNames from 'classnames';
import { Actions, WorkspaceStore } from 'mailspring-exports';

/** Hebrew names for Mailspring's bundled themes (others keep their displayName). */
const THEME_LABELS: { [name: string]: string } = {
  'ui-automatic': 'אוטומטי (לפי Windows)',
  'ui-light': 'בהיר',
  'ui-dark': 'כהה',
  'ui-darkside': 'Darkside (כהה כחלחל)',
  'ui-taiga': 'Taiga (צבעוני)',
  'ui-ubuntu': 'Ubuntu (צבעוני)',
  'less-is-more': 'Less Is More (מינימלי)',
  'ui-less-is-more': 'Less Is More (מינימלי)',
};
const THEME_ORDER = [
  'ui-automatic',
  'ui-light',
  'ui-dark',
  'ui-darkside',
  'ui-taiga',
  'ui-ubuntu',
  'less-is-more',
  'ui-less-is-more',
];

export function offlineThemeChoices(): { name: string; label: string }[] {
  const themes = (AppEnv.themes.getAvailableThemes() || []) as any[];
  const names = themes.map((t) => t.name as string);
  names.sort((a, b) => {
    const ia = THEME_ORDER.indexOf(a);
    const ib = THEME_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return names.map((name) => {
    const pkg = themes.find((t) => t.name === name);
    return { name, label: THEME_LABELS[name] || pkg?.displayName || name };
  });
}

/** Theme picker (native menu). Saved as core.theme in the offline profile. */
function showThemeMenu(anchor: HTMLElement) {
  const { Menu, MenuItem } = require('@electron/remote');
  const current = AppEnv.themes.getActiveThemeSetting()?.name;
  const menu = new Menu();
  for (const t of offlineThemeChoices()) {
    menu.append(
      new MenuItem({
        label: t.label,
        type: 'radio',
        checked: t.name === current,
        click: () => AppEnv.themes.setActiveTheme(t.name),
      })
    );
  }
  const rect = anchor.getBoundingClientRect();
  menu.popup({ x: Math.round(rect.left), y: Math.round(rect.bottom) });
}

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

  private _themeSub: { dispose: () => void } | null = null;

  componentDidMount() {
    this._unlisten = WorkspaceStore.listen(() => this.forceUpdate());
    this._themeSub = AppEnv.themes.onDidChangeActiveThemes(() => this.forceUpdate());
  }

  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
    if (this._themeSub) {
      this._themeSub.dispose();
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
        <button
          className="offline-pane-toggle offline-theme-btn"
          data-offline-theme-picker="true"
          title="בחר ערכת צבעים (בהיר / כהה / צבעוני)"
          aria-haspopup="menu"
          onClick={(e) => showThemeMenu(e.currentTarget)}
        >
          <span className="offline-pane-toggle-icon">🎨</span>
          ערכה
        </button>
      </div>
    );
  }
}
