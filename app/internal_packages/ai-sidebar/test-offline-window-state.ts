#!/usr/bin/env npx ts-node
/**
 * Offline experiment: window size/position/maximized state is remembered in
 * the offline profile and restored only onto a connected display.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-window-state.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OFFLINE_WINDOW_STATE_FILE,
  OfflineWindowState,
  captureOfflineWindowState,
  isOnDisplay,
  loadOfflineWindowState,
  planOfflineWindowRestore,
  saveOfflineWindowState,
} from '../../src/browser/offline-window-state';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e && e.message}`);
  }
}
function eq(a: any, b: any) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`expected ${y}, got ${x}`);
}
function ok(v: any, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } };
const left = { id: 3, workArea: { x: -1600, y: 100, width: 1600, height: 860 } };

function state(over: Partial<OfflineWindowState> = {}): OfflineWindowState {
  return {
    version: 1,
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    maximized: false,
    fullScreen: false,
    displayId: 1,
    savedAt: '2026-11-13T14:00:00.000Z',
    ...over,
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-window-'));
const file = path.join(dir, OFFLINE_WINDOW_STATE_FILE);

console.log('Category: first launch');
test('no saved state -> maximized, no bounds', () => {
  const p = planOfflineWindowRestore(null, [primary], primary);
  eq(p.source, 'first-launch');
  eq(p.maximize, true);
  eq(p.bounds, null);
});
test('missing / corrupt file reads as no state', () => {
  eq(loadOfflineWindowState(path.join(dir, 'nope.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  eq(loadOfflineWindowState(path.join(dir, 'bad.json')), null);
  fs.writeFileSync(
    path.join(dir, 'zero.json'),
    JSON.stringify(state({ bounds: { x: 0, y: 0, width: 0, height: 0 } }))
  );
  eq(loadOfflineWindowState(path.join(dir, 'zero.json')), null);
});

console.log('Category: save / load');
test('round trip keeps size, position, maximized, display', () => {
  saveOfflineWindowState(file, state({ maximized: true, displayId: 2 }));
  const s = loadOfflineWindowState(file);
  eq(s.bounds, { x: 100, y: 80, width: 1200, height: 800 });
  eq(s.maximized, true);
  eq(s.displayId, 2);
});
test('file holds geometry only', () => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq(Object.keys(raw).sort(), [
    'bounds',
    'displayId',
    'fullScreen',
    'maximized',
    'savedAt',
    'version',
  ]);
});

test('a file saved with a BOM (e.g. by Notepad) still loads', () => {
  const f = path.join(dir, 'bom.json');
  fs.writeFileSync(f, '\uFEFF' + JSON.stringify(state()));
  ok(loadOfflineWindowState(f) !== null);
});

console.log('Category: restore');
test('normal window restored exactly, not maximized', () => {
  const p = planOfflineWindowRestore(state(), [primary, second], primary);
  eq(p.source, 'saved');
  eq(p.bounds, { x: 100, y: 80, width: 1200, height: 800 });
  eq(p.maximize, false);
});
test('maximized state restored as maximized', () => {
  const p = planOfflineWindowRestore(state({ maximized: true }), [primary], primary);
  eq(p.source, 'saved');
  eq(p.maximize, true);
});
test('window on second display stays there', () => {
  const s = state({ displayId: 2, bounds: { x: 2000, y: 50, width: 1000, height: 700 } });
  const p = planOfflineWindowRestore(s, [primary, second], primary);
  eq(p.source, 'saved');
  eq(p.bounds, { x: 2000, y: 50, width: 1000, height: 700 });
});
test('display at negative coordinates is valid', () => {
  const s = state({ displayId: 3, bounds: { x: -1500, y: 150, width: 1200, height: 700 } });
  eq(planOfflineWindowRestore(s, [primary, left], primary).source, 'saved');
});
test('disconnected display -> centered on primary, keeps size and maximized', () => {
  const s = state({
    displayId: 2,
    maximized: true,
    bounds: { x: 2000, y: 50, width: 1000, height: 700 },
  });
  const p = planOfflineWindowRestore(s, [primary], primary);
  eq(p.source, 'moved-to-primary');
  eq(p.bounds, { x: 460, y: 170, width: 1000, height: 700 });
  eq(p.maximize, true);
});
test('off-screen window is moved back', () => {
  const s = state({ bounds: { x: 5000, y: 3000, width: 1000, height: 700 } });
  eq(planOfflineWindowRestore(s, [primary], primary).source, 'moved-to-primary');
});
test('title bar above the screen is not valid', () => {
  ok(!isOnDisplay({ x: 100, y: -500, width: 1200, height: 800 }, primary));
});
test('bigger than display (resolution changed) is shrunk to fit', () => {
  const s = state({ bounds: { x: 0, y: 0, width: 2500, height: 1400 } });
  const p = planOfflineWindowRestore(s, [primary], primary);
  eq(p.bounds.width, 1920);
  eq(p.bounds.height, 1040);
});

console.log('Category: capture');
function fakeWin(o: any) {
  return {
    isDestroyed: () => false,
    isMinimized: () => !!o.min,
    isMaximized: () => !!o.max,
    isFullScreen: () => false,
    getNormalBounds: () => o.normal,
  } as any;
}
const fakeScreen = { getDisplayMatching: () => second } as any;
test('captures normal bounds and display while maximized', () => {
  const s = captureOfflineWindowState(
    fakeWin({ max: true, normal: { x: 10, y: 20, width: 1000, height: 700 } }),
    fakeScreen,
    null
  );
  eq(s.bounds, { x: 10, y: 20, width: 1000, height: 700 });
  eq(s.maximized, true);
  eq(s.displayId, 2);
});
test('minimized keeps the previous maximized choice', () => {
  const prev = state({ maximized: true });
  const s = captureOfflineWindowState(
    fakeWin({ min: true, normal: { x: 10, y: 20, width: 1000, height: 700 } }),
    fakeScreen,
    prev
  );
  eq(s.maximized, true);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
