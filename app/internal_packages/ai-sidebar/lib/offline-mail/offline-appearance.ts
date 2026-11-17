/**
 * Offline experiment (t243): appearance. Light / dark / automatic (follows
 * Windows — Mailspring's own "ui-automatic" theme), a remembered text size
 * (A− / A+) and the bundled Hebrew font (Assistant, OFL, loaded from the
 * package folder — never from a CDN).
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { tr } from '../core/offline-i18n';
import {
  APPEARANCE_THEMES,
  OfflineAppearance,
  TEXT_SCALE_CONFIG_KEY,
  appearanceOfTheme,
  clampTextScale,
  stepTextScale,
} from '../core/offline-visual';

export const OFFLINE_FONT_FAMILY = 'OfflineAssistant';
export const OFFLINE_FONT_FILE = path.join(
  __dirname,
  '..',
  '..',
  'fonts',
  'Assistant-Variable.ttf'
);

const listeners = new Set<() => void>();
export function onAppearanceChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      // ignore
    }
  }
}

export function currentAppearance(): OfflineAppearance | null {
  try {
    return appearanceOfTheme(AppEnv.themes.getActiveThemeSetting()?.name);
  } catch (e) {
    return null;
  }
}

/** True when the theme on screen is dark (also for "automatic" at night). */
export function isDarkNow(): boolean {
  try {
    const name = AppEnv.themes.getActiveTheme()?.name || '';
    return /dark/.test(name);
  } catch (e) {
    return false;
  }
}

export function setAppearance(a: OfflineAppearance) {
  AppEnv.themes.setActiveTheme(APPEARANCE_THEMES[a]);
  notify();
}

export const APPEARANCE_CHOICES: {
  id: OfflineAppearance;
  icon: string;
  label: [string, string];
}[] = [
  { id: 'light', icon: '☀️', label: ['בהיר', 'Light'] },
  { id: 'dark', icon: '🌙', label: ['כהה', 'Dark'] },
  { id: 'auto', icon: '🌓', label: ['אוטומטי (לפי Windows)', 'Automatic (follows Windows)'] },
];

export function appearanceButton(): { icon: string; label: string } {
  const cur = currentAppearance();
  const c = APPEARANCE_CHOICES.find((x) => x.id === cur);
  if (!c) return { icon: '🎨', label: tr('מצב תצוגה', 'Appearance') };
  return {
    icon: c.icon,
    label: tr(
      `מצב: ${c.label[0].replace(/ \(.*/, '')}`,
      `Mode: ${c.label[1].replace(/ \(.*/, '')}`
    ),
  };
}

export function showAppearanceMenu(anchor: HTMLElement) {
  const { Menu, MenuItem } = require('@electron/remote');
  const cur = currentAppearance();
  const menu = new Menu();
  for (const c of APPEARANCE_CHOICES) {
    menu.append(
      new MenuItem({
        label: `${c.icon}  ${tr(c.label[0], c.label[1])}`,
        type: 'radio',
        checked: c.id === cur,
        click: () => setAppearance(c.id),
      })
    );
  }
  const rect = anchor.getBoundingClientRect();
  menu.popup({ x: Math.round(rect.left), y: Math.round(rect.bottom) });
}

// ---- Text size ----------------------------------------------------------------

export function textScale(): number {
  try {
    return clampTextScale(AppEnv.config.get(TEXT_SCALE_CONFIG_KEY));
  } catch (e) {
    return 1;
  }
}

export function applyTextScale(v = textScale()) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--ofl-text-scale', String(v));
  document.body.dataset.oflTextScale = String(v);
}

export function setTextScale(v: number) {
  const next = clampTextScale(v);
  AppEnv.config.set(TEXT_SCALE_CONFIG_KEY, next === 1 ? undefined : next);
  applyTextScale(next);
  notify();
}

export function stepText(dir: 1 | -1) {
  setTextScale(stepTextScale(textScale(), dir));
}

// ---- Font -------------------------------------------------------------------

export function fontFaceCss(file = OFFLINE_FONT_FILE): string {
  const url = pathToFileURL(file).href;
  return (
    `@font-face{font-family:"${OFFLINE_FONT_FAMILY}";` +
    `src:url("${url}") format("truetype");font-weight:200 800;font-style:normal;font-display:swap;}`
  );
}

let installed = false;
/** Once at startup: font, text size, and a re-render when the theme flips. */
export function installOfflineAppearance() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const style = document.createElement('style');
  style.id = 'offline-font-face';
  style.textContent = fontFaceCss();
  document.head.appendChild(style);
  document.body.classList.add('ofl-font');
  applyTextScale();
  try {
    AppEnv.themes.onDidChangeActiveThemes(() => notify());
  } catch (e) {
    // ignore
  }
}
