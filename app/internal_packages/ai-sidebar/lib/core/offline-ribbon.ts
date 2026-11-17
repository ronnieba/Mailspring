/**
 * Offline experiment: the Outlook-style top bar (tabs + ribbon) that replaces
 * the column toolbar buttons and the hamburger menu. Pure helpers here: tab
 * list, remembered tab (offline profile), and the fit rule (labels -> icons).
 */
import fs from 'fs';
import path from 'path';

export type OfflineRibbonTab = 'home' | 'view' | 'drafts' | 'ai' | 'settings';

export const OFFLINE_RIBBON_TABS: { id: OfflineRibbonTab; label: [string, string] }[] = [
  { id: 'home', label: ['בית', 'Home'] },
  { id: 'view', label: ['תצוגה', 'View'] },
  { id: 'drafts', label: ['טיוטות', 'Drafts'] },
  { id: 'ai', label: ['AI', 'AI'] },
  { id: 'settings', label: ['עזרה והגדרות', 'Help & settings'] },
];

export const OFFLINE_RIBBON_FILE = 'offline-ribbon.json';

export type OfflineRibbonPrefs = { tab: OfflineRibbonTab; collapsed: boolean };

const DEFAULT_PREFS: OfflineRibbonPrefs = { tab: 'home', collapsed: false };

export function readRibbonPrefs(configDir: string | null): OfflineRibbonPrefs {
  if (!configDir) {
    return { ...DEFAULT_PREFS };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, OFFLINE_RIBBON_FILE), 'utf8'));
    const tab = OFFLINE_RIBBON_TABS.some((t) => t.id === raw?.tab) ? raw.tab : DEFAULT_PREFS.tab;
    return { tab, collapsed: raw?.collapsed === true };
  } catch (e) {
    return { ...DEFAULT_PREFS };
  }
}

export function writeRibbonPrefs(configDir: string | null, prefs: OfflineRibbonPrefs): void {
  if (!configDir) {
    return;
  }
  const file = path.join(configDir, OFFLINE_RIBBON_FILE);
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, tab: prefs.tab, collapsed: prefs.collapsed })
    );
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[Offline ribbon] could not save the tab');
  }
}

/**
 * Labels or icons only? Labels are dropped when the full ribbon does not fit
 * and come back once there is room again for the width it needed.
 */
export function nextRibbonCompact(
  compact: boolean,
  available: number,
  contentWidth: number,
  fullWidthNeeded: number | null
): { compact: boolean; fullWidthNeeded: number | null } {
  if (!compact) {
    if (contentWidth > available + 1) {
      return { compact: true, fullWidthNeeded: contentWidth };
    }
    return { compact: false, fullWidthNeeded };
  }
  if (fullWidthNeeded !== null && available >= fullWidthNeeded) {
    return { compact: false, fullWidthNeeded };
  }
  return { compact: true, fullWidthNeeded };
}
