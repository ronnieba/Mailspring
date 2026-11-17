/**
 * Offline experiment UI language (Hebrew / English).
 *
 * The choice is Mailspring's own `core.intl.language` setting, stored in the
 * offline profile's config.json (the experiment never opens the official
 * profile). The offline window defaults to Hebrew when nothing is saved.
 * Mailspring's localization picks the same value up at startup: it loads the
 * Hebrew string table and switches the whole layout to right-to-left, or
 * stays English and left-to-right.
 *
 * Outside the offline experiment (demo, Mac selected-summary) the AI panel
 * keeps its original Hebrew strings, so those modes are unchanged.
 */

import { isOfflineArchiveMode } from '../../../../src/offline-archive';

export type OfflineLang = 'he' | 'en';

export const OFFLINE_DEFAULT_LANG: OfflineLang = 'he';
export const OFFLINE_LANG_CONFIG_KEY = 'core.intl.language';
/** Values written to core.intl.language for each choice. */
export const OFFLINE_LANG_LOCALES: { [k in OfflineLang]: string } = { he: 'he', en: 'en' };

let override: OfflineLang | null = null;

/** Tests only. */
export function setOfflineLangOverride(lang: OfflineLang | null): void {
  override = lang;
}

/** Map a stored core.intl.language value to the offline UI language. */
export function offlineLangFromSetting(value: unknown): OfflineLang {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!s) {
    return OFFLINE_DEFAULT_LANG;
  }
  return s === 'he' || s.startsWith('he-') || s === 'iw' ? 'he' : 'en';
}

function offlineMode(): boolean {
  return isOfflineArchiveMode();
}

function activeLocale(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const intl = require('../../../../src/intl');
    return typeof intl.getCurrentLocale === 'function' ? intl.getCurrentLocale() : null;
  } catch {
    return null;
  }
}

/** Language the offline UI is showing right now (fixed for the window's life). */
export function offlineLang(): OfflineLang {
  if (override) {
    return override;
  }
  if (!offlineMode()) {
    return 'he';
  }
  return offlineLangFromSetting(activeLocale());
}

export function isOfflineEnglish(): boolean {
  return offlineLang() === 'en';
}

/** Pick the Hebrew or English string for the current offline UI language. */
export function tr(he: string, en: string): string {
  return offlineLang() === 'en' ? en : he;
}

export function offlineDir(): 'rtl' | 'ltr' {
  return offlineLang() === 'en' ? 'ltr' : 'rtl';
}

/** Locale for dates and numbers shown by the offline panes. */
export function offlineDateLocale(): string {
  return offlineLang() === 'en' ? 'en-GB' : 'he-IL';
}

/** Class put on <body> so stylesheets can follow the language. */
export function offlineLangBodyClass(lang: OfflineLang = offlineLang()): string {
  return `ofl-lang-${lang}`;
}
