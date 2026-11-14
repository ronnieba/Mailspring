#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t192–t195):
 * - folder tree: folder / system-box icons, indent guides, count badge after the name;
 * - language switch restarts hidden (no console window), only after the old copy exits;
 * - application menu: follows the language, hides what cannot work offline,
 *   shows "Ctrl+," as typed, clean version line;
 * - top-bar "New" and reader "Reply" / "Forward" labels.
 * Temp folders only; no network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-tree-menu.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { offlineFolderIconKind, offlineFolderRole } from './lib/core/offline-folder-roles';
import {
  OFFLINE_RELAUNCH_CHANNEL,
  OFFLINE_RELAUNCH_HELPER_SOURCE,
  offlineRelaunchPlan,
  startHiddenRelaunch,
} from '../../src/browser/offline-relaunch';
import {
  OFFLINE_MENU_HIDDEN_COMMANDS,
  needsTypedShortcut,
  offlineMenuTemplate,
  offlineVersionLabel,
  readShortCommit,
  typedShortcut,
} from '../../src/offline-menu';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
  }
}
function ok(v: unknown, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}
function eq(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const appRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ms-t192-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('Category: folder tree icons');
  await test('system boxes are recognized at the top level only', () => {
    eq(offlineFolderRole('Inbox', 0), 'inbox');
    eq(offlineFolderRole('INBOX', 0), 'inbox');
    eq(offlineFolderRole('Sent', 0), 'sent');
    eq(offlineFolderRole('Draft', 0), 'drafts');
    eq(offlineFolderRole('Archive', 0), 'archive');
    eq(offlineFolderRole('Bulk', 0), 'spam');
    eq(offlineFolderRole('Bulk Mail', 0), 'spam');
    eq(offlineFolderRole('Trash', 0), 'trash');
    eq(offlineFolderRole('אשפה', 0), 'trash');
    eq(offlineFolderRole('Inbox', 1), null);
    eq(offlineFolderRole('Projects', 0), null);
  });
  await test('closed / open folders for parents, plain folder for leaves', () => {
    eq(offlineFolderIconKind({ name: 'X', depth: 0, hasChildren: true, open: false }), 'folder');
    eq(
      offlineFolderIconKind({ name: 'X', depth: 0, hasChildren: true, open: true }),
      'folder-open'
    );
    eq(
      offlineFolderIconKind({ name: 'X', depth: 2, hasChildren: false, open: false }),
      'folder-leaf'
    );
    eq(offlineFolderIconKind({ name: 'Inbox', depth: 0, hasChildren: true, open: true }), 'inbox');
  });
  await test('every icon kind has inline SVG (no remote assets)', () => {
    const src = read('internal_packages/ai-sidebar/lib/offline-mail/offline-folder-icon.tsx');
    for (const k of [
      'folder',
      "'folder-open'",
      "'folder-leaf'",
      'inbox',
      'sent',
      'drafts',
      'archive',
      'spam',
      'trash',
      "'local-drafts'",
    ]) {
      ok(src.includes(`${k}: (`), k);
    }
    ok(!/https?:\/\//.test(src.replace('http://www.w3.org/2000/svg', '')), 'no URLs');
  });
  await test('row: chevron, icon, name, count badge, then +N; children get a guide line', () => {
    const src = read('internal_packages/ai-sidebar/lib/offline-mail/offline-folder-sidebar.tsx');
    const icon = src.indexOf('<OfflineFolderIcon kind={iconKind} />');
    const name = src.indexOf('className="offline-folder-name"', icon);
    const count = src.indexOf("'offline-folder-count'", name);
    const sub = src.indexOf('className="offline-folder-subcount"', count);
    ok(icon > 0 && name > icon && count > name && sub > count, 'order');
    ok(src.includes('className="offline-folder-children"') && src.includes('--ofl-guide-x'));
    ok(src.includes('<OfflineFolderIcon kind="local-drafts" />'));
    ok(!src.includes('📝'));
  });
  await test('styles: guides use logical sides (RTL + LTR) and every theme', () => {
    const less = read('internal_packages/ai-sidebar/styles/offline-mail.less');
    const i = less.indexOf('Folder tree look (t192)');
    ok(i > 0);
    const block = less.slice(i);
    ok(block.includes('inset-inline-start: var(--ofl-guide-x'));
    ok(block.includes('border-inline-start'));
    ok(!/\bleft:|\bright:/.test(block), 'no physical left/right');
    for (const t of [
      'theme-ui-dark',
      'theme-ui-darkside',
      'theme-ui-ubuntu',
      'theme-ui-taiga',
      'less-is-more',
    ]) {
      ok(block.includes(t), t);
    }
  });

  console.log('\nCategory: hidden restart after a language switch');
  await test('Windows uses the hidden helper; macOS / Linux keep app.relaunch', () => {
    const base = {
      execPath: 'C:\\e\\electron.exe',
      argv: ['C:\\e\\electron.exe', 'app', '--offline-archive'],
      cwd: 'C:\\src',
      configDir: 'C:\\p',
      pid: 42,
    };
    const w = offlineRelaunchPlan({ ...base, platform: 'win32' });
    eq(w.mode, 'hidden');
    if (w.mode === 'hidden') {
      eq(JSON.stringify(w.args), JSON.stringify(['app', '--offline-archive']));
      eq(w.waitForPid, 42);
      ok(w.logFile.endsWith(path.join('logs', 'app.log')));
    }
    eq(offlineRelaunchPlan({ ...base, platform: 'darwin' }).mode, 'electron');
    eq(offlineRelaunchPlan({ ...base, platform: 'linux' }).mode, 'electron');
  });
  await test('helper and app start detached, hidden, with no console output', () => {
    const calls: any[] = [];
    const fake: any = (file: string, args: string[], opts: any) => {
      calls.push({ file, args, opts });
      return { unref() {} };
    };
    const plan = offlineRelaunchPlan({
      platform: 'win32',
      execPath: 'E',
      argv: ['E', 'app'],
      cwd: 'C',
      configDir: 'P',
      pid: 1,
    });
    ok(plan.mode === 'hidden' && startHiddenRelaunch(plan as any, fake));
    eq(calls.length, 1);
    eq(calls[0].opts.windowsHide, true);
    eq(calls[0].opts.detached, true);
    eq(calls[0].opts.stdio, 'ignore');
    eq(calls[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
    ok(OFFLINE_RELAUNCH_HELPER_SOURCE.includes('windowsHide: true'));
    ok(OFFLINE_RELAUNCH_HELPER_SOURCE.includes('detached: true'));
    ok(OFFLINE_RELAUNCH_HELPER_SOURCE.includes('delete env.ELECTRON_RUN_AS_NODE'));
  });
  await test('helper waits for the old process to exit before starting the new one', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'started.txt');
    const old = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 1200)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const t0 = Date.now();
    const plan = {
      mode: 'hidden' as const,
      execPath: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now()))`],
      cwd: dir,
      logFile: path.join(dir, 'logs', 'app.log'),
      errFile: path.join(dir, 'logs', 'app.log.err'),
      waitForPid: old.pid as number,
    };
    ok(startHiddenRelaunch(plan));
    let exitedAt = 0;
    old.on('exit', () => (exitedAt = Date.now()));
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await sleep(100);
    ok(fs.existsSync(marker), 'new process started');
    const startedAt = Number(fs.readFileSync(marker, 'utf8'));
    ok(
      exitedAt > 0 && startedAt >= exitedAt - 50,
      `started ${startedAt - t0}ms, old exited ${exitedAt - t0}ms`
    );
    ok(fs.existsSync(path.join(dir, 'logs', 'app.log')), 'output goes to the log file');
  });
  await test('renderer asks the main process (no direct app.relaunch first)', () => {
    const src = read('internal_packages/ai-sidebar/lib/offline-mail/offline-pane-toggles.tsx');
    ok(src.includes('ipcRenderer.invoke(OFFLINE_RELAUNCH_CHANNEL)'));
    const appTs = read('src/browser/application.ts');
    ok(appTs.includes('handleFromMailspringWindows(ipcMain, OFFLINE_RELAUNCH_CHANNEL'));
    eq(OFFLINE_RELAUNCH_CHANNEL, 'offline-archive:relaunch-hidden');
  });

  console.log('\nCategory: application menu');
  const sample = () => [
    {
      id: 'Edit',
      label: 'Edit',
      submenu: [
        { label: 'Undo', command: 'core:undo', enabled: true },
        { type: 'separator' },
        { label: 'Select All Read', command: 'thread-list:select-read', enabled: false },
      ],
    },
    {
      id: 'Thread',
      label: 'Thread',
      submenu: [{ label: 'Reply', command: 'core:reply', enabled: false }],
    },
    {
      id: 'Developer',
      label: 'Developer',
      submenu: [{ label: 'Reload', command: 'window:reload', enabled: true }],
    },
    { type: 'separator' },
    { label: 'Help...', command: 'application:view-help' },
    { label: 'Getting Started Guide...', command: 'application:view-getting-started' },
    { label: 'Mailspring Community...', command: 'application:view-community' },
    { type: 'separator' },
    { label: 'Sync New Mail Now', command: 'window:sync-mail-now', enabled: true },
    { type: 'separator' },
    { label: 'Preferences', command: 'application:open-preferences' },
    { label: 'Add Account...', command: 'application:add-account' },
    { label: 'Change Theme...', command: 'window:launch-theme-picker', enabled: true },
    { label: 'Install Theme...', command: 'window:install-package', enabled: true },
    { type: 'separator' },
    { label: 'VERSION', enabled: false },
    { type: 'separator' },
    { label: 'Print Current Thread', command: 'core:print-thread', enabled: false },
    { type: 'separator' },
    { label: 'Exit', command: 'application:quit' },
  ];
  const flat = (items: any[]): any[] =>
    items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
  const keys = { 'application:open-preferences': ['mod+,'], 'core:undo': ['mod+z'] };
  await test('Hebrew: every label translated, irrelevant items hidden', () => {
    const { template } = offlineMenuTemplate(sample(), keys, {
      lang: 'he',
      platform: 'win32',
      shortCommit: 'abc1234',
      developerMenu: false,
    });
    const labels = flat(template)
      .filter((i) => i.type !== 'separator')
      .map((i) => i.label);
    for (const l of labels)
      ok(!/[A-Za-z]{3,}/.test(l.replace(/Ctrl\+,|offline|abc1234/g, '')), `English left: ${l}`);
    const cmds = flat(template)
      .map((i) => i.command)
      .filter(Boolean);
    for (const c of OFFLINE_MENU_HIDDEN_COMMANDS) ok(!cmds.includes(c), c);
    ok(!template.some((i) => i.id === 'Developer'), 'Developer hidden');
    ok(!template.some((i) => i.id === 'Thread'), 'empty Thread menu hidden');
    ok(!cmds.includes('core:print-thread'), 'disabled print hidden');
    ok(
      labels.includes('ביטול פעולה') &&
        labels.includes('יציאה') &&
        labels.includes('החלפת ערכת נושא…')
    );
  });
  await test('settings shortcut shows "Ctrl+," (not a spelled key name)', () => {
    const { template, keystrokes } = offlineMenuTemplate(sample(), keys, {
      lang: 'he',
      platform: 'win32',
      shortCommit: '',
      developerMenu: false,
    });
    const pref = flat(template).find((i) => i.command === 'application:open-preferences');
    ok(pref.label.includes('\u2066Ctrl+,\u2069'), pref.label);
    ok(!keystrokes['application:open-preferences'], 'native accelerator not sent');
    eq(JSON.stringify(keystrokes['core:undo']), JSON.stringify(['mod+z']));
    eq(typedShortcut('mod+shift+,'), 'Ctrl+Shift+,');
    eq(typedShortcut('ctrl+up'), 'Ctrl+↑');
    ok(needsTypedShortcut('mod+,') && !needsTypedShortcut('mod+z') && !needsTypedShortcut('f11'));
  });
  await test('macOS keeps native accelerators', () => {
    const { keystrokes } = offlineMenuTemplate(sample(), keys, {
      lang: 'en',
      platform: 'darwin',
      shortCommit: '',
      developerMenu: false,
    });
    ok(keystrokes['application:open-preferences']);
  });
  await test('version line and English labels', () => {
    const { template } = offlineMenuTemplate(sample(), keys, {
      lang: 'en',
      platform: 'win32',
      shortCommit: 'abc1234',
      developerMenu: false,
    });
    const labels = flat(template).map((i) => i.label);
    ok(labels.includes('Offline experiment abc1234'));
    eq(offlineVersionLabel('he', 'abc1234'), 'גרסת ניסוי offline abc1234');
    ok(!labels.some((l) => /COMMIT_INSERTED/.test(l || '')));
    ok(labels.includes('Exit') && labels.includes('Change Theme…'));
  });
  await test('Developer menu only with MAILSPRING_OFFLINE_DEVELOPER_MENU', () => {
    const { template } = offlineMenuTemplate(sample(), keys, {
      lang: 'he',
      platform: 'win32',
      shortCommit: '',
      developerMenu: true,
    });
    const dev = template.find((i) => i.id === 'Developer');
    ok(dev && dev.label === 'מפתחים' && dev.submenu![0].label === 'טעינה מחדש');
    const mm = read('src/menu-manager.ts');
    ok(mm.includes("process.env.MAILSPRING_OFFLINE_DEVELOPER_MENU === '1'"));
  });
  await test('no doubled / leading / trailing separators', () => {
    const { template } = offlineMenuTemplate(sample(), keys, {
      lang: 'he',
      platform: 'win32',
      shortCommit: '',
      developerMenu: false,
    });
    const shown = template.filter((i) => i.visible !== false);
    ok(shown[0].type !== 'separator' && shown[shown.length - 1].type !== 'separator');
    for (let i = 1; i < shown.length; i++)
      ok(!(shown[i].type === 'separator' && shown[i - 1].type === 'separator'), `double at ${i}`);
    const edit = template.find((i) => i.id === 'Edit');
    eq(edit!.submenu!.length, 1);
  });
  await test('short commit read from .git (branch ref, packed refs, worktree)', () => {
    const repo = tmp();
    const git = path.join(repo, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(git, 'refs', 'heads', 'main'),
      '0123456789abcdef0123456789abcdef01234567\n'
    );
    eq(readShortCommit(repo), '012345678');
    fs.unlinkSync(path.join(git, 'refs', 'heads', 'main'));
    fs.writeFileSync(
      path.join(git, 'packed-refs'),
      '# pack\nfedcba9876543210fedcba9876543210fedcba98 refs/heads/main\n'
    );
    eq(readShortCommit(repo), 'fedcba987');
    const wt = tmp();
    const wtGit = path.join(git, 'worktrees', 'w');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    eq(readShortCommit(wt), 'fedcba987');
    eq(readShortCommit(tmp()), '');
  });

  console.log('\nCategory: button labels');
  await test('top bar "New", reader "Reply" / "Forward" (still local drafts)', () => {
    const t = read('internal_packages/ai-sidebar/lib/offline-mail/offline-ribbon.tsx');
    ok(t.includes("tr('טיוטה חדשה', 'New draft')") && t.includes('d.createNew()'));
    const r = read('internal_packages/ai-sidebar/lib/offline-mail/offline-message-reader.tsx');
    ok(r.includes("tr('השב', 'Reply')") && r.includes("tr('העבר', 'Forward')"));
    ok(
      r.includes('offlineDraftsStore.createReply(') &&
        r.includes('offlineDraftsStore.createForward(')
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
