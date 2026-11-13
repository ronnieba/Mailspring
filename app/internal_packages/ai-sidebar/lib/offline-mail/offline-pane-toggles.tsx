import React from 'react';
import classNames from 'classnames';
import { offlineDraftsStore } from './offline-drafts-store';
import { OFFLINE_RELAUNCH_CHANNEL } from '../../../../src/browser/offline-relaunch';
import { Actions, WorkspaceStore } from 'mailspring-exports';
import {
  OfflineLang,
  OFFLINE_LANG_CONFIG_KEY,
  OFFLINE_LANG_LOCALES,
  offlineDir,
  offlineLang,
  tr,
} from '../core/offline-i18n';

/** Names for Mailspring's bundled themes (others keep their displayName). */
const THEME_LABELS: { [name: string]: [string, string] } = {
  'ui-automatic': ['אוטומטי (לפי Windows)', 'Automatic (follows Windows)'],
  'ui-light': ['בהיר', 'Light'],
  'ui-dark': ['כהה', 'Dark'],
  'ui-darkside': ['Darkside (כהה כחלחל)', 'Darkside (bluish dark)'],
  'ui-taiga': ['Taiga (צבעוני)', 'Taiga (colorful)'],
  'ui-ubuntu': ['Ubuntu (צבעוני)', 'Ubuntu (colorful)'],
  'less-is-more': ['Less Is More (מינימלי)', 'Less Is More (minimal)'],
  'ui-less-is-more': ['Less Is More (מינימלי)', 'Less Is More (minimal)'],
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
    const l = THEME_LABELS[name];
    return { name, label: (l && tr(l[0], l[1])) || pkg?.displayName || name };
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

export const OFFLINE_LANGUAGE_CHOICES: { lang: OfflineLang; label: string }[] = [
  { lang: 'he', label: 'עברית' },
  { lang: 'en', label: 'English' },
];

/**
 * Save the UI language in the offline profile (core.intl.language) and
 * relaunch, like Mailspring's own language preference: the string table and
 * the right-to-left / left-to-right layout are chosen at startup.
 */
export function switchOfflineLanguage(lang: OfflineLang): boolean {
  if (lang === offlineLang()) {
    return false;
  }
  AppEnv.config.set(OFFLINE_LANG_CONFIG_KEY, OFFLINE_LANG_LOCALES[lang]);
  // Give the config a moment to reach config.json before restarting.
  // The main process restarts the app hidden (no console window on Windows)
  // and only after this copy has fully exited, so there is never a second one.
  window.setTimeout(() => {
    const fallback = () => {
      const { app } = require('@electron/remote');
      app.relaunch();
      app.quit();
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ipcRenderer } = require('electron');
      ipcRenderer.invoke(OFFLINE_RELAUNCH_CHANNEL).catch(fallback);
    } catch {
      fallback();
    }
  }, 700);
  return true;
}

function showLanguageMenu(anchor: HTMLElement) {
  const { Menu, MenuItem } = require('@electron/remote');
  const current = offlineLang();
  const menu = new Menu();
  for (const c of OFFLINE_LANGUAGE_CHOICES) {
    menu.append(
      new MenuItem({
        label: c.label,
        type: 'radio',
        checked: c.lang === current,
        click: () => switchOfflineLanguage(c.lang),
      })
    );
  }
  const rect = anchor.getBoundingClientRect();
  menu.popup({ x: Math.round(rect.left), y: Math.round(rect.bottom) });
}

const PANES: { id: string; label: [string, string]; icon: string }[] = [
  { id: 'RootSidebar', label: ['תיקיות', 'Folders'], icon: '📁' },
  { id: 'MessageList', label: ['קורא', 'Reader'], icon: '📄' },
  { id: 'MessageListSidebar', label: ['עוזר AI', 'AI assistant'], icon: '🤖' },
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
        dir={offlineDir()}
        role="toolbar"
        aria-label={tr('הצג או הסתר אזורים', 'Show or hide areas')}
        data-offline-pane-toggles="true"
      >
        <span className="offline-pane-toggles-label">{tr('הצג:', 'Show:')}</span>
        {PANES.map((p) => {
          const loc = WorkspaceStore.Location[p.id];
          if (!loc) {
            return null;
          }
          const hidden = WorkspaceStore.isLocationHidden(loc);
          const label = tr(p.label[0], p.label[1]);
          return (
            <button
              key={p.id}
              className={classNames('offline-pane-toggle', { off: hidden })}
              data-pane={p.id}
              aria-pressed={!hidden}
              title={
                hidden ? tr(`הצג ${label}`, `Show ${label}`) : tr(`הסתר ${label}`, `Hide ${label}`)
              }
              onClick={() => Actions.toggleWorkspaceLocationHidden(loc)}
            >
              <span className="offline-pane-toggle-icon">{p.icon}</span>
              {label}
            </button>
          );
        })}
        <button
          className="offline-pane-toggle offline-theme-btn"
          data-offline-theme-picker="true"
          title={tr(
            'בחר ערכת צבעים (בהיר / כהה / צבעוני)',
            'Choose a color theme (light / dark / colorful)'
          )}
          aria-haspopup="menu"
          onClick={(e) => showThemeMenu(e.currentTarget)}
        >
          <span className="offline-pane-toggle-icon">🎨</span>
          {tr('ערכה', 'Theme')}
        </button>
        <button
          className="offline-pane-toggle offline-new-draft-btn"
          data-offline-new-draft="true"
          title={tr(
            'טיוטה חדשה — נשמרת רק במחשב, אין שליחה',
            'New draft — saved only on this computer, no sending'
          )}
          onClick={() => offlineDraftsStore.createNew()}
        >
          <span className="offline-pane-toggle-icon">✉️</span>
          {tr('חדש', 'New')}
        </button>
        <button
          className="offline-pane-toggle offline-lang-btn"
          data-offline-language-picker="true"
          data-offline-lang={offlineLang()}
          title={tr(
            'שפת הממשק (עברית / English) — האפליקציה תיפתח מחדש',
            'Interface language (עברית / English) — the app restarts'
          )}
          aria-haspopup="menu"
          onClick={(e) => showLanguageMenu(e.currentTarget)}
        >
          <span className="offline-pane-toggle-icon">🌐</span>
          {tr('שפה', 'Language')}
        </button>
      </div>
    );
  }
}
