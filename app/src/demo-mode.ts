/**
 * Demo mode detection for renderer and tests.
 *
 * Demo mode is an accountless synthetic-data route enabled only by `--demo`
 * (requires a developer build). It is not inferred from an empty AccountStore:
 * zero accounts is onboarding, not demo.
 */

let _override: boolean | null = null;
let _cached: boolean | null = null;

export function setDemoModeOverride(value: boolean | null) {
  _override = value;
  _cached = null;
}

export function _resetDemoModeCache(): void {
  _cached = null;
}

function parseLoadSettingsDemoFlag(): boolean {
  if (typeof process !== 'undefined' && process.env && process.env.MAILSPRING_DEMO === '1') {
    return true;
  }

  try {
    const env = (globalThis as any).AppEnv;
    if (env && typeof env.getWindowProps === 'function') {
      if (env.getWindowProps().demoMode) {
        return true;
      }
    }
  } catch {
    // AppEnv not ready
  }

  try {
    const search = typeof window !== 'undefined' ? window.location?.search : '';
    if (search && search.includes('loadSettings=')) {
      const settingsStr = decodeURIComponent(search.substring(14));
      const loadSettings = JSON.parse(settingsStr);
      return !!(loadSettings.windowProps && loadSettings.windowProps.demoMode);
    }
  } catch {
    // ignore parse errors
  }

  return false;
}

/**
 * True only for the explicit synthetic demo route.
 */
export function isDemoMode(): boolean {
  if (_override !== null) {
    return _override;
  }
  if (_cached !== null) {
    return _cached;
  }
  _cached = parseLoadSettingsDemoFlag();
  if (_cached) {
    console.log('[Demo Mode] ACTIVE — no keychain, mailsync, or real accounts');
  }
  return _cached;
}
