/**
 * Offline experiment: theme and language pickers used by the top ribbon
 * (offline-ribbon.tsx). The old column toolbar buttons were replaced by it.
 */
import { OFFLINE_RELAUNCH_CHANNEL } from '../../../../src/browser/offline-relaunch';
import {
  OfflineLang,
  OFFLINE_LANG_CONFIG_KEY,
  OFFLINE_LANG_LOCALES,
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
export function showThemeMenu(anchor: HTMLElement) {
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

export function showLanguageMenu(anchor: HTMLElement) {
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
