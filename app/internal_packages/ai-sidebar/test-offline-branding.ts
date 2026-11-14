#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t217): "Mail AI" branding. Checks the icon assets
 * (transparent PNG 16-512, multi-size .ico), that only the offline experiment
 * on Windows picks the brand icon (window + tray; Mac/Linux and the normal
 * app are unchanged) and the in-app logo wiring (ribbon + AI panel header).
 * No Electron, no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-branding.ts
 */
import fs from 'fs';
import path from 'path';
import {
  offlineAppIconPath,
  offlineBrandDir,
  OFFLINE_APP_NAME,
} from '../../src/browser/offline-branding';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: any) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra === undefined ? '' : extra);
  }
}

const appDir = path.resolve(__dirname, '..', '..');
const brandDir = offlineBrandDir(appDir);
const read = (p: string) => fs.readFileSync(path.join(appDir, p), 'utf8');

console.log('assets');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
for (const s of sizes) {
  const file = path.join(brandDir, `mail-ai-${s}.png`);
  const ok = fs.existsSync(file);
  if (!ok) {
    check(`mail-ai-${s}.png exists`, false);
    continue;
  }
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const colorType = buf[25];
  check(`mail-ai-${s}.png is ${s}x${s} RGBA`, w === s && h === s && colorType === 6, {
    w,
    h,
    colorType,
  });
}
const ico = fs.readFileSync(path.join(brandDir, 'mail-ai.ico'));
const count = ico.readUInt16LE(4);
const icoSizes: number[] = [];
for (let i = 0; i < count; i++) {
  const v = ico[6 + i * 16];
  icoSizes.push(v === 0 ? 256 : v);
}
check(
  'mail-ai.ico holds 16/24/32/48/64/128/256',
  [16, 24, 32, 48, 64, 128, 256].every((s) => icoSizes.includes(s)),
  icoSizes
);
check(
  'icon script + source kept for re-runs',
  fs.existsSync(path.join(brandDir, 'make-icons.py')) &&
    fs.existsSync(path.join(brandDir, 'mail-ai-source.jpg'))
);

console.log('window / tray icon selection');
check(
  'win32 + offline -> brand .ico',
  offlineAppIconPath(appDir, { platform: 'win32', offline: true }) ===
    path.join(brandDir, 'mail-ai.ico')
);
check(
  'win32, normal app -> unchanged',
  offlineAppIconPath(appDir, { platform: 'win32', offline: false }) === null
);
check(
  'mac offline -> unchanged',
  offlineAppIconPath(appDir, { platform: 'darwin', offline: true }) === null
);
check(
  'linux offline -> unchanged',
  offlineAppIconPath(appDir, { platform: 'linux', offline: true }) === null
);
check(
  'missing assets -> unchanged',
  offlineAppIconPath(path.join(appDir, 'nope'), { platform: 'win32', offline: true }) === null
);
check('name', OFFLINE_APP_NAME === 'Mail AI');

const win = read('src/browser/mailspring-window.ts');
check(
  'window uses the brand icon before BrowserWindow is created',
  /offlineAppIconPath\(this\.resourcePath\)[\s\S]*browserWindowOptions\.icon = offlineIcon[\s\S]*new BrowserWindow\(browserWindowOptions\)/.test(
    win
  )
);
const tray = read('src/browser/system-tray-manager.ts');
check(
  'tray default icon prefers the brand icon offline',
  /_defaultIconPath\(\) \{[\s\S]{0,200}offlineAppIconPath/.test(tray)
);
check(
  'tray ignores renderer icon swaps offline',
  /updateTraySettings\(iconPath[\s\S]{0,300}offlineAppIconPath[\s\S]{0,200}iconPath = this\._iconPath/.test(
    tray
  )
);

console.log('in-app logo');
const brand = read('internal_packages/ai-sidebar/lib/offline-mail/offline-brand.tsx');
check(
  'brand label "Mail AI · מצב לא מקוון" / "Offline"',
  brand.includes("tr('מצב לא מקוון', 'Offline')") &&
    brand.includes('`${OFFLINE_BRAND_NAME} · ${offlineBrandSubtitle()}`')
);
check(
  'logo file URL from resourcePath',
  brand.includes('pathToFileURL') && brand.includes("'static', 'images', 'offline'")
);
const ribbon = read('internal_packages/ai-sidebar/lib/offline-mail/offline-ribbon.tsx');
check(
  'ribbon tab row starts with the brand',
  /offline-ribbon-tabs"[^>]*>\s*<OfflineBrand compact=\{compact\} \/>/.test(ribbon)
);
const sidebar = read('internal_packages/ai-sidebar/lib/ai-sidebar.tsx');
check(
  'AI header branded only offline, demo text kept',
  /offline \? \([\s\S]{0,200}ai-brand-title[\s\S]{0,400}\) : \(\s*<h2>\{tr\('🤖 עוזר AI', '🤖 AI assistant'\)\}<\/h2>/.test(
    sidebar
  )
);
const less = read('internal_packages/ai-sidebar/styles/offline-mail.less');
const block = less.slice(less.indexOf('/* Mail AI branding'));
check(
  'brand styles present',
  block.includes('.offline-brand {') && block.includes('.ai-brand-title')
);
check(
  'brand styles use logical properties only',
  !/(margin|padding)-(left|right)|\bleft:|\bright:|text-align: (left|right)/.test(block)
);
check('brand colours inherit (light + dark palettes)', !/#[0-9a-f]{3,6}/i.test(block));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
