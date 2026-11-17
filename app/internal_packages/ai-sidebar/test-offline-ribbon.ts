#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t201): top ribbon above the columns replaces the column
 * toolbar buttons and the hamburger menu; Views and the side rail are off.
 * Temp folders only; nothing is opened on screen.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-ribbon.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  nextRibbonCompact,
  OFFLINE_RIBBON_FILE,
  OFFLINE_RIBBON_TABS,
  readRibbonPrefs,
  writeRibbonPrefs,
} from './lib/core/offline-ribbon';
import { OFFLINE_ARCHIVE_DISABLED_PACKAGES } from '../../src/offline-archive';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).stack || err}`);
  }
}
function ok(v: unknown, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}
const appRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const ribbon = read('internal_packages/ai-sidebar/lib/offline-mail/offline-ribbon.tsx');

console.log('offline ribbon (t201)');

test('five tabs, Hebrew and English names', () => {
  ok(OFFLINE_RIBBON_TABS.map((t) => t.id).join() === 'home,view,drafts,ai,settings');
  ok(OFFLINE_RIBBON_TABS.every((t) => t.label[0] && t.label[1]));
  ok(
    OFFLINE_RIBBON_TABS[0].label[0] === 'בית' && OFFLINE_RIBBON_TABS[4].label[0] === 'עזרה והגדרות'
  );
});

test('last tab is remembered in the profile (and bad values fall back)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-ribbon-'));
  ok(readRibbonPrefs(dir).tab === 'home' && readRibbonPrefs(dir).collapsed === false, 'default');
  writeRibbonPrefs(dir, { tab: 'ai', collapsed: true });
  const p = readRibbonPrefs(dir);
  ok(p.tab === 'ai' && p.collapsed === true, JSON.stringify(p));
  fs.writeFileSync(path.join(dir, OFFLINE_RIBBON_FILE), '{"tab":"nope"}');
  ok(readRibbonPrefs(dir).tab === 'home', 'unknown tab');
  ok(readRibbonPrefs(null).tab === 'home', 'no profile');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('labels collapse to icons when narrow and come back when there is room', () => {
  let r = nextRibbonCompact(false, 800, 1200, null);
  ok(r.compact && r.fullWidthNeeded === 1200, 'to icons');
  r = nextRibbonCompact(true, 1000, 600, r.fullWidthNeeded);
  ok(r.compact, 'still too narrow for labels');
  r = nextRibbonCompact(true, 1300, 600, r.fullWidthNeeded);
  ok(!r.compact, 'labels back');
  ok(!nextRibbonCompact(false, 1300, 900, null).compact, 'fits');
});

test('ribbon sits above all columns, not in a column toolbar', () => {
  const reg = read('internal_packages/ai-sidebar/lib/offline-mail/register.ts');
  ok(
    reg.includes('ComponentRegistry.register(OfflineRibbon') && reg.includes('Sheet.Global.Header')
  );
  ok(!reg.includes('ThreadList.Toolbar'), 'no column toolbar buttons');
});

test('everything from the hamburger menu is in the ribbon', () => {
  for (const s of [
    'wc().undo()',
    'wc().redo()',
    'wc().cut()',
    'wc().copy()',
    'wc().paste()',
    'wc().pasteAndMatchStyle()',
    'selectAllInField(', // Edit → Select all text (t224: the draft field, not the window)
    'AppEnv.setFullScreen(',
    'AppEnv.minimize()',
    'setZoomLevel(',
    "sendCommand('application:open-preferences')",
    'showThemeMenu(',
    'showLanguageMenu(',
    'offlineVersionLabel(',
    "sendCommand('application:quit')",
    'Actions.toggleWorkspaceLocationHidden(',
  ]) {
    ok(ribbon.includes(s), s);
  }
});

test('labels collapse to icons (tooltips keep the name); hamburger and side rail are off offline', () => {
  ok(
    ribbon.includes('compact ? null') &&
      ribbon.includes('title={b.title || (compact ? b.label : undefined)}')
  );
  const tb = read('src/sheet-toolbar.tsx');
  const i = tb.indexOf('class ToolbarMenuControl');
  ok(i > 0 && tb.indexOf('isOfflineArchiveMode()', i) > i, 'hamburger hidden offline');
  const sc = read('src/sheet-container.tsx');
  ok(sc.includes('AppEnv.isMainWindow() && !isOfflineArchiveMode()'), 'rail hidden offline');
  const less = read('internal_packages/ai-sidebar/styles/offline-mail.less');
  ok(
    less.includes('body.platform-win32.offline-ribbon-on .sheet-toolbar'),
    'empty toolbar row hidden on Windows'
  );
});

test('Views (Create a View) is not loaded offline', () => {
  ok(OFFLINE_ARCHIVE_DISABLED_PACKAGES.includes('views'));
});

test('ribbon has no send / network calls', () => {
  // The only IPC is Mailspring's own menu-command channel (preferences, exit).
  ok(ribbon.includes("ipcRenderer.send('command', command)"));
  const src = ribbon.replace("ipcRenderer.send('command', command)", '');
  for (const re of [
    /SendDraftTask/,
    /\bsend\s*\(/,
    /smtp/i,
    /imap/i,
    /fetch\(/,
    /XMLHttpRequest/,
    /WebSocket/,
    /mailsync/i,
  ]) {
    ok(!re.test(src), String(re));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
