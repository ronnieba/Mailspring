/**
 * Offline experiment: remember the main window's size, position, maximized
 * state and display in the offline profile (config dir), and restore them on
 * the next launch. Only the very first launch (no saved state) opens
 * maximized. Stores geometry only, nothing about mail.
 */
import fs from 'fs';
import path from 'path';

export const OFFLINE_WINDOW_STATE_FILE = 'offline-window-state.json';
export const OFFLINE_WINDOW_MIN = { width: 875, height: 250 };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OfflineWindowState {
  version: 1;
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
  displayId: number | null;
  savedAt: string;
}

export interface DisplayLike {
  id: number;
  workArea: Rect;
}

export interface RestorePlan {
  source: 'saved' | 'moved-to-primary' | 'first-launch';
  bounds: Rect | null;
  maximize: boolean;
  fullScreen: boolean;
}

function isNum(n: any) {
  return typeof n === 'number' && Number.isFinite(n);
}

function isRect(r: any): r is Rect {
  return !!r && isNum(r.x) && isNum(r.y) && isNum(r.width) && isNum(r.height);
}

export function loadOfflineWindowState(file: string): OfflineWindowState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || raw.version !== 1 || !isRect(raw.bounds)) return null;
    if (raw.bounds.width <= 0 || raw.bounds.height <= 0) return null;
    return {
      version: 1,
      bounds: {
        x: Math.round(raw.bounds.x),
        y: Math.round(raw.bounds.y),
        width: Math.round(raw.bounds.width),
        height: Math.round(raw.bounds.height),
      },
      maximized: !!raw.maximized,
      fullScreen: !!raw.fullScreen,
      displayId: isNum(raw.displayId) ? raw.displayId : null,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    };
  } catch {
    return null;
  }
}

export function saveOfflineWindowState(file: string, state: OfflineWindowState) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[Offline window] could not save window state', err && err.code);
  }
}

function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

// A window counts as on a display when a good part of it, including its top
// edge (title bar), is inside that display's work area.
export function isOnDisplay(bounds: Rect, display: DisplayLike) {
  const wa = display.workArea;
  const o = overlap(bounds, wa);
  const titleInside = bounds.y >= wa.y - 8 && bounds.y <= wa.y + wa.height - 40;
  return titleInside && o.w >= Math.min(200, bounds.width) && o.h >= Math.min(100, bounds.height);
}

function fitSize(bounds: Rect, wa: Rect) {
  return {
    width: Math.max(Math.min(bounds.width, wa.width), Math.min(OFFLINE_WINDOW_MIN.width, wa.width)),
    height: Math.max(
      Math.min(bounds.height, wa.height),
      Math.min(OFFLINE_WINDOW_MIN.height, wa.height)
    ),
  };
}

export function planOfflineWindowRestore(
  state: OfflineWindowState | null,
  displays: DisplayLike[],
  primary: DisplayLike
): RestorePlan {
  if (!state) {
    return { source: 'first-launch', bounds: null, maximize: true, fullScreen: false };
  }
  const ordered = [
    ...displays.filter((d) => d.id === state.displayId),
    ...displays.filter((d) => d.id !== state.displayId),
  ];
  const home = ordered.find((d) => isOnDisplay(state.bounds, d));
  if (home) {
    const size = fitSize(state.bounds, home.workArea);
    const wa = home.workArea;
    const x = Math.min(Math.max(state.bounds.x, wa.x - size.width + 200), wa.x + wa.width - 200);
    const y = Math.min(Math.max(state.bounds.y, wa.y), wa.y + wa.height - 40);
    return {
      source: 'saved',
      bounds: { x, y, ...size },
      maximize: state.maximized,
      fullScreen: state.fullScreen,
    };
  }
  // Saved display is gone (or the window was off-screen): keep the size and
  // the maximized choice, centered on the primary display.
  const wa = primary.workArea;
  const size = fitSize(state.bounds, wa);
  return {
    source: 'moved-to-primary',
    bounds: {
      x: wa.x + Math.round((wa.width - size.width) / 2),
      y: wa.y + Math.round((wa.height - size.height) / 2),
      ...size,
    },
    maximize: state.maximized,
    fullScreen: false,
  };
}

interface WindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getNormalBounds(): Rect;
  getBounds(): Rect;
  setBounds(r: Rect): void;
  maximize(): void;
  show(): void;
  hide(): void;
  setFullScreen(f: boolean): void;
  on(ev: string, fn: (...args: any[]) => void): any;
  once(ev: string, fn: (...args: any[]) => void): any;
}

interface ScreenLike {
  getAllDisplays(): DisplayLike[];
  getPrimaryDisplay(): DisplayLike;
  getDisplayMatching(r: Rect): DisplayLike;
}

export function captureOfflineWindowState(
  win: WindowLike,
  screen: ScreenLike,
  previous: OfflineWindowState | null
): OfflineWindowState | null {
  if (win.isDestroyed()) return null;
  // While minimized, keep the last known maximized state.
  const minimized = win.isMinimized();
  const bounds = win.getNormalBounds();
  if (!isRect(bounds) || bounds.width <= 0 || bounds.height <= 0) return previous;
  let displayId: number | null = null;
  try {
    displayId = screen.getDisplayMatching(bounds).id;
  } catch {
    displayId = previous ? previous.displayId : null;
  }
  return {
    version: 1,
    bounds,
    maximized: minimized && previous ? previous.maximized : win.isMaximized(),
    fullScreen: minimized && previous ? previous.fullScreen : win.isFullScreen(),
    displayId,
    savedAt: new Date().toISOString(),
  };
}

// Restore the saved geometry (or maximize on first launch) once the window has
// loaded, then keep the file up to date on move/resize/maximize/close.
export function applyAndTrackOfflineWindowState(
  win: WindowLike,
  configDirPath: string,
  screen: ScreenLike
) {
  const file = path.join(configDirPath, OFFLINE_WINDOW_STATE_FILE);
  let last = loadOfflineWindowState(file);
  const plan = planOfflineWindowRestore(last, screen.getAllDisplays(), screen.getPrimaryDisplay());
  console.log(`[Offline window] restore: ${plan.source}${plan.maximize ? ' (maximized)' : ''}`);
  if (plan.bounds) win.setBounds(plan.bounds);

  let armed = false;
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (!armed || win.isDestroyed()) return;
    const next = captureOfflineWindowState(win, screen, last);
    if (next) {
      last = next;
      saveOfflineWindowState(file, next);
    }
  };
  const saveSoon = () => {
    if (!armed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(
    (ev) => win.on(ev, saveSoon)
  );
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });

  // On Windows a later show() (from the renderer's own startup) restores a
  // maximized window, and when the app is started hidden (the no-console
  // launcher) the first show() is swallowed. So apply a few times during
  // startup (idempotent), then start saving.
  const apply = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (plan.maximize) {
      if (!win.isMaximized()) win.maximize();
      if (!win.isMaximized()) {
        // Window still in the state left by the swallowed first show():
        // a hide/show cycle makes maximize() take effect.
        win.hide();
        win.show();
        win.maximize();
      }
    } else if (plan.bounds) {
      const b = win.getBounds();
      if (b.width !== plan.bounds.width || b.height !== plan.bounds.height) {
        win.setBounds(plan.bounds);
      }
    }
    if (plan.fullScreen && !win.isFullScreen()) win.setFullScreen(true);
  };
  // During startup the renderer may show() the window again (which restores
  // a maximized window on Windows); re-apply until the grace period ends.
  const GRACE_MS = 6000;
  let inGrace = true;
  const reapply = () => {
    if (inGrace) setTimeout(apply, 50);
  };
  win.on('unmaximize', reapply);
  win.on('show', reapply);
  apply();
  [150, 900, 2000, 4000].forEach((ms) => setTimeout(apply, ms));
  setTimeout(() => {
    inGrace = false;
    armed = true;
    save();
    if (!win.isDestroyed()) {
      console.log(`[Offline window] startup done (maximized=${win.isMaximized()})`);
    }
  }, GRACE_MS);
}
