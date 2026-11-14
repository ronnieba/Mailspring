#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t235): the interactive guide with Maily the mascot.
 * Steps cover every area, Hebrew + English text, prefs in the profile,
 * bubble placement, the tour flow, the Help button, "?" tips, light + dark,
 * nothing from the network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-tour.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_TOUR_PREFS,
  OFFLINE_TOUR_FILE,
  TOUR_STEPS,
  TOUR_TIPS,
  placeBubble,
  readTourPrefs,
  shouldOfferTour,
  writeTourPrefs,
} from './lib/core/offline-tour';
import { setOfflineLangOverride } from './lib/core/offline-i18n';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).stack || err}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = [
  'lib/offline-mail/offline-ribbon.tsx',
  'lib/offline-mail/offline-folder-sidebar.tsx',
  'lib/offline-mail/offline-message-list.tsx',
  'lib/offline-mail/offline-search-view.tsx',
  'lib/offline-mail/offline-attachments-view.tsx',
  'lib/offline-mail/offline-message-reader.tsx',
  'lib/ai-sidebar.tsx',
]
  .map(read)
  .join('\n');

async function main() {
  console.log('offline interactive guide (t235)');
  setOfflineLangOverride('he');

  await test('the tour covers every area, in order, Hebrew + English', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    for (const want of [
      'ribbon',
      'folders',
      'list',
      'search',
      'ai-panel',
      'write-ai',
      'drafts',
      'actions',
      'viewer',
      'rules',
      'reset',
    ]) {
      assert(ids.includes(want), `missing ${want}`);
    }
    assert(ids[0] === 'welcome' && ids[ids.length - 1] === 'done', 'welcome … done');
    for (const s of TOUR_STEPS) {
      for (const pair of [s.title, s.body]) {
        assert(
          /[\u05d0-\u05ea]/.test(pair[0]) &&
            /[A-Za-z]/.test(pair[1]) &&
            !/[\u05d0-\u05ea]/.test(pair[1]),
          `${s.id} he/en`
        );
      }
    }
  });

  await test('every spotlight target exists in the real UI code', () => {
    for (const s of TOUR_STEPS) {
      for (const sel of s.targets) {
        const attr = /\[(data-[a-z-]+)(?:="([^"]+)")?\]/.exec(sel);
        if (attr) {
          const name = attr[1];
          assert(SRC.includes(`${name}=`) || SRC.includes(name), `${s.id}: ${name}`);
          if (attr[2] && name === 'data-offline-ribbon-btn') {
            assert(SRC.includes(`id: '${attr[2]}'`), `${s.id}: ribbon button ${attr[2]}`);
          }
          if (attr[2] && name === 'data-offline-ribbon-group') {
            assert(SRC.includes(`id: '${attr[2]}'`), `${s.id}: ribbon group ${attr[2]}`);
          }
        } else {
          const cls = /^\.([a-z-]+)$/.exec(sel);
          assert(cls && SRC.includes(cls[1]), `${s.id}: ${sel}`);
        }
      }
    }
  });

  await test('prefs live in the offline profile; first-run offer until done or "never"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-tour-'));
    assert(JSON.stringify(readTourPrefs(dir)) === JSON.stringify(DEFAULT_TOUR_PREFS), 'defaults');
    assert(shouldOfferTour(readTourPrefs(dir)), 'offered first');
    writeTourPrefs(dir, { done: true, promptNever: false, tips: false });
    const p = readTourPrefs(dir);
    assert(p.done && !p.tips && !shouldOfferTour(p), 'done');
    assert(!shouldOfferTour({ done: false, promptNever: true, tips: true }), 'never');
    fs.writeFileSync(path.join(dir, OFFLINE_TOUR_FILE), '{bad');
    assert(readTourPrefs(dir).tips === true, 'bad file = defaults');
    assert(
      fs.readdirSync(dir).every((f) => f === OFFLINE_TOUR_FILE),
      'one small file'
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('bubble placement: below, above, beside, centered, always inside the window', () => {
    const v = { width: 1200, height: 800 };
    const b = { width: 360, height: 200 };
    const below = placeBubble({ left: 100, top: 40, width: 200, height: 60 }, b, v);
    assert(below.side === 'below' && below.top === 114 && below.left >= 10, JSON.stringify(below));
    const above = placeBubble({ left: 600, top: 650, width: 100, height: 60 }, b, v);
    assert(above.side === 'above' && above.top + 200 <= 650, JSON.stringify(above));
    const side = placeBubble({ left: 10, top: 100, width: 300, height: 650 }, b, v);
    assert(side.side === 'end' && side.left === 324, JSON.stringify(side));
    const full = placeBubble({ left: 0, top: 0, width: 1200, height: 800 }, b, v);
    assert(full.left >= 10 && full.top + 200 <= 790, JSON.stringify(full));
    const none = placeBubble(null, b, v);
    assert(none.side === 'center' && none.left === 420 && none.top === 300, JSON.stringify(none));
    const edge = placeBubble({ left: 1150, top: 20, width: 40, height: 20 }, b, v);
    assert(edge.left + 360 <= 1190, 'clamped to the window');
  });

  await test('tour flow: start, next/back, ribbon tab per step, finish remembers', () => {
    const tour = read('lib/offline-mail/offline-tour.tsx');
    assert(
      /start\(at = 0\)[\s\S]*_prepare\(\)/.test(tour) &&
        /finish\(\) \{[\s\S]{0,80}_save\(\{ done: true \}\)/.test(tour),
      'flow'
    );
    assert(
      /window\.dispatchEvent\(new CustomEvent\(OFFLINE_RIBBON_TAB_EVENT/.test(tour),
      'tab event'
    );
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(
      ribbon.includes('window.addEventListener(OFFLINE_RIBBON_TAB_EVENT, onShowTab)'),
      'ribbon listens'
    );
    assert(/e\.key === 'Escape'\) offlineTour\.finish\(\)/.test(tour), 'Esc skips');
    assert(
      /data-offline-tour-skip/.test(tour) &&
        /data-offline-tour-back/.test(tour) &&
        /data-offline-tour-next/.test(tour),
      'buttons'
    );
  });

  await test('Help tab: "מדריך אינטראקטיבי" replays; "?" tips toggle; host mounted', () => {
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(
      /id: 'interactive-tour',[\s\S]{0,80}label: tr\('מדריך אינטראקטיבי', 'Interactive guide'\)[\s\S]{0,400}onClick: \(\) => startOfflineTour\(\)/.test(
        ribbon
      ),
      'help button'
    );
    assert(
      /id: 'tips'[\s\S]{0,600}offlineTour\.setTips\(!offlineTour\.tipsOn\)/.test(ribbon),
      'tips toggle'
    );
    assert(ribbon.includes('<OfflineTourHost />'), 'host');
  });

  await test('"?" tips next to search, AI, rules and Save as (Hebrew + English)', () => {
    assert(
      read('lib/offline-mail/offline-search-view.tsx').includes('<OfflineHelpTip tip="search" />'),
      'search'
    );
    assert(read('lib/ai-sidebar.tsx').includes('<OfflineHelpTip tip="ai" />'), 'ai');
    assert(
      read('lib/offline-mail/offline-rules-view.tsx').includes('<OfflineHelpTip tip="rules" />'),
      'rules'
    );
    assert(
      read('lib/offline-mail/offline-export.tsx').includes('<OfflineHelpTip tip="export" />'),
      'export'
    );
    for (const [k, v] of Object.entries(TOUR_TIPS)) {
      assert(/[\u05d0-\u05ea]/.test(v[0]) && !/[\u05d0-\u05ea]/.test(v[1]), k);
    }
  });

  await test('mascot: inline SVG from the logo (envelope + sparkle), moods, reduced motion, light + dark', () => {
    const tour = read('lib/offline-mail/offline-tour.tsx');
    assert(/<svg[\s\S]*className="ofl-m-sparkle"[\s\S]*<\/svg>/.test(tour), 'svg + sparkle');
    assert(
      /#8be32f[\s\S]*#0bc3d6/.test(tour) && tour.includes('#6f4bd8'),
      'logo colours (green→teal, purple)'
    );
    for (const mood of ['wave', 'happy', 'think', 'wink'])
      assert(tour.includes(`'${mood}'`) || tour.includes(`"${mood}"`), mood);
    const less = read('styles/offline-mail.less');
    assert(
      less.includes('@media (prefers-reduced-motion: reduce)') &&
        less.includes('.offline-tour-spot'),
      'motion + spot'
    );
    assert(/body\.theme-ui-dark \{[\s\S]{0,200}\.offline-tour-bubble/.test(less), 'dark theme');
  });

  await test('nothing from the network in the guide', () => {
    for (const f of ['lib/core/offline-tour.ts', 'lib/offline-mail/offline-tour.tsx']) {
      const src = read(f);
      assert(
        !/https?:\/\/|\bfetch\(|XMLHttpRequest|WebSocket|require\(['"](https?|net|tls)['"]\)|ipcRenderer|gemini-ipc|<img/i.test(
          src
        ),
        f
      );
    }
  });

  await test('renders (React): mascot, tour bubble markup', () => {
    let server: any = null;
    try {
      server = require('react-dom/server');
    } catch {
      console.log('    (react-dom not available here; skipped)');
      return;
    }
    const React = require('react');
    const { OfflineMascot } = require('./lib/offline-mail/offline-tour');
    const html = server.renderToStaticMarkup(
      React.createElement(OfflineMascot, { size: 64, mood: 'wave' })
    );
    assert(
      html.startsWith('<svg') &&
        html.includes('data-offline-mascot="wave"') &&
        html.includes('aria-label="מיילי"'),
      html.slice(0, 200)
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
