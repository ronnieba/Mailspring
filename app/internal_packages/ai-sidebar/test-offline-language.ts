#!/usr/bin/env npx ts-node
/**
 * Offline experiment: Hebrew / English UI language switch.
 * - the choice lives in the offline profile (core.intl.language);
 * - Hebrew is the default when the profile has no choice;
 * - layout direction follows the language (Hebrew RTL, English LTR);
 * - Mailspring's own strings come from its Hebrew table when Hebrew is on;
 * - demo / Mac modes keep their original (Hebrew) AI panel strings.
 * No network, no real profile.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-language.ts
 * (--transpile-only: intl.ts uses Electron process typings; tsc checks types.)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

// intl.ts asks Electron for the system locale when it loads. Outside Electron,
// stand in an English system so the offline default is what is under test.
const electronPath = require.resolve('electron');
Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getLocale: () => 'en-US' } },
};

import { setOfflineArchiveOverride } from '../../src/offline-archive';
import {
  OFFLINE_DEFAULT_LANG,
  OFFLINE_LANG_CONFIG_KEY,
  offlineDir,
  offlineLang,
  offlineLangBodyClass,
  offlineLangFromSetting,
  setOfflineLangOverride,
  tr,
} from './lib/core/offline-i18n';
import {
  answerScopeMetadataLocally,
  offlineSummaryLabel,
  offlineSummaryLanguageHint,
  OFFLINE_SUMMARY_LABEL,
  LOCAL_ANSWER_FOOTER,
  LOCAL_ANSWER_FOOTER_EN,
} from './lib/core/scope-answers';
import { buildCoverageDisclosure } from './lib/core/coverage-disclosure';
import {
  GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION,
  GEMINI_OFFLINE_SCOPED_SYSTEM_INSTRUCTION,
  GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION,
  geminiUiLangFromLocale,
  localizeOfflineInstruction,
} from '../../src/browser/gemini-demo-protocol';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
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
const HEB = /[\u0590-\u05FF]/;
const root = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function profile(language?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-lang-'));
  const cfg: any = { '*': { core: {} } };
  if (language !== undefined) {
    cfg['*'].core.intl = { language };
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  return dir;
}

console.log('Setting and default');
test('config key is Mailspring core.intl.language (in the offline profile)', () => {
  eq(OFFLINE_LANG_CONFIG_KEY, 'core.intl.language');
});
test('Hebrew is the default', () => {
  eq(OFFLINE_DEFAULT_LANG, 'he');
  eq(offlineLangFromSetting(undefined), 'he');
  eq(offlineLangFromSetting(''), 'he');
  eq(offlineLangFromSetting('  '), 'he');
});
test('stored values map to he / en', () => {
  eq(offlineLangFromSetting('he'), 'he');
  eq(offlineLangFromSetting('he-IL'), 'he');
  eq(offlineLangFromSetting('en'), 'en');
  eq(offlineLangFromSetting('en-US'), 'en');
  eq(offlineLangFromSetting('fr'), 'en');
});

console.log('Mailspring localization (startup)');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intl = require('../../src/intl');
test('offline profile without a choice starts in Hebrew, right-to-left', () => {
  intl.initializeLocalization({ configDirPath: profile(), defaultLocale: 'he' });
  eq(intl.getCurrentLocale(), 'he');
  eq(intl.isRTL, true);
});
test('Mailspring strings come from the Hebrew table', () => {
  intl.initializeLocalization({ configDirPath: profile(), defaultLocale: 'he' });
  const he = intl.localized('Preferences');
  ok(HEB.test(he), `got ${he}`);
});
test('English choice starts English, left-to-right', () => {
  intl.initializeLocalization({ configDirPath: profile('en'), defaultLocale: 'he' });
  eq(intl.getCurrentLocale(), 'en');
  eq(intl.isRTL, false);
  eq(intl.localized('Preferences'), 'Preferences');
});
test('Hebrew choice saved explicitly also works', () => {
  intl.initializeLocalization({ configDirPath: profile('he'), defaultLocale: 'he' });
  eq(intl.isRTL, true);
});
test('non-offline modes keep the system default (no defaultLocale)', () => {
  intl.initializeLocalization({ configDirPath: profile() });
  eq(intl.getCurrentLocale(), 'en-US');
  eq(intl.isRTL, false);
});

console.log('Offline UI strings');
test('offline UI language follows the active locale', () => {
  setOfflineArchiveOverride(true);
  intl.initializeLocalization({ configDirPath: profile('en'), defaultLocale: 'he' });
  eq(offlineLang(), 'en');
  eq(offlineDir(), 'ltr');
  eq(tr('שלום', 'Hello'), 'Hello');
  intl.initializeLocalization({ configDirPath: profile(), defaultLocale: 'he' });
  eq(offlineLang(), 'he');
  eq(offlineDir(), 'rtl');
  eq(tr('שלום', 'Hello'), 'שלום');
  setOfflineArchiveOverride(null);
});
test('demo / Mac modes stay Hebrew whatever the locale', () => {
  setOfflineArchiveOverride(false);
  intl.initializeLocalization({ configDirPath: profile('en') });
  eq(offlineLang(), 'he');
  eq(tr('שלום', 'Hello'), 'שלום');
  setOfflineArchiveOverride(null);
});
test('body class names', () => {
  eq(offlineLangBodyClass('he'), 'ofl-lang-he');
  eq(offlineLangBodyClass('en'), 'ofl-lang-en');
});
const facts = {
  scopeKind: 'folder' as const,
  includesSubfolders: false,
  totalInScope: 16,
  sent: 0,
  distinctSenders: 5,
  oldest: '2024-01-02T10:00:00Z',
  newest: '2024-03-04T10:00:00Z',
};
test('local metadata answer in English', () => {
  setOfflineLangOverride('en');
  const a = answerScopeMetadataLocally('how many messages are in this folder?', facts as any) || '';
  ok(a.includes('16 messages'), a);
  ok(a.includes(LOCAL_ANSWER_FOOTER_EN));
  ok(!HEB.test(a), a);
  setOfflineLangOverride(null);
});
test('local metadata answer in Hebrew unchanged', () => {
  setOfflineLangOverride('he');
  const a = answerScopeMetadataLocally('כמה מיילים יש בתיקייה הזו?', facts as any) || '';
  ok(a.includes('16 הודעות'), a);
  ok(a.includes(LOCAL_ANSWER_FOOTER));
  setOfflineLangOverride(null);
});
test('Summarize label and summary language follow the UI language', () => {
  setOfflineLangOverride('en');
  ok(!HEB.test(offlineSummaryLabel()));
  ok(offlineSummaryLanguageHint().includes('English'));
  setOfflineLangOverride('he');
  eq(offlineSummaryLabel(), OFFLINE_SUMMARY_LABEL);
  ok(offlineSummaryLanguageHint().includes('Hebrew'));
  setOfflineLangOverride(null);
});

test('coverage footer follows the UI language', () => {
  const sr: any = {
    retrievalMode: 'ranked',
    progress: { processed: 1, totalEligible: 1, missingBodies: 0, isComplete: true },
  };
  setOfflineLangOverride('en');
  ok(!HEB.test(buildCoverageDisclosure(sr, 100)));
  setOfflineLangOverride('he');
  ok(HEB.test(buildCoverageDisclosure(sr, 100)));
  setOfflineLangOverride(null);
});

console.log('Gemini answers in the UI language');
test('main-process locale maps to he / en (Hebrew default)', () => {
  eq(geminiUiLangFromLocale(null), 'he');
  eq(geminiUiLangFromLocale(''), 'he');
  eq(geminiUiLangFromLocale('he'), 'he');
  eq(geminiUiLangFromLocale('en'), 'en');
  eq(geminiUiLangFromLocale('en-US'), 'en');
});
test('English UI asks Gemini for English; Hebrew UI unchanged', () => {
  const sumEn = localizeOfflineInstruction(GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION, 'en');
  ok(sumEn.includes('Write the summary in English'));
  ok(!sumEn.includes('in Hebrew'));
  const scopedEn = localizeOfflineInstruction(GEMINI_OFFLINE_SCOPED_SYSTEM_INSTRUCTION, 'en');
  ok(scopedEn.includes('if unclear, write in English'));
  eq(
    localizeOfflineInstruction(GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION, 'he'),
    GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION
  );
  eq(
    localizeOfflineInstruction(GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION, 'en'),
    GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION
  );
});
test('only the offline instructions are localized in the host', () => {
  const host = read('src/browser/gemini-demo-host.ts');
  eq((host.match(/localizeOfflineInstruction\(GEMINI_OFFLINE_/g) || []).length, 2);
});

console.log('Wiring');
test('main and renderer pass the offline Hebrew default', () => {
  ok(/defaultLocale: offlineArchive && !demoMode \? 'he'/.test(read('src/browser/application.ts')));
  ok(
    /defaultLocale: loadSettings\?\.windowProps\?\.offlineArchive === true \? 'he'/.test(
      read('src/app-env.ts')
    )
  );
});
test('language menu saves to the profile and relaunches', () => {
  const src = read('internal_packages/ai-sidebar/lib/offline-mail/offline-pane-toggles.tsx');
  ok(src.includes('AppEnv.config.set(OFFLINE_LANG_CONFIG_KEY'));
  ok(src.includes('app.relaunch()'));
  ok(src.includes("label: 'עברית'") && src.includes("label: 'English'"));
});
test('offline panes have no hard-coded right-to-left', () => {
  for (const f of [
    'offline-pane-toggles.tsx',
    'offline-message-list.tsx',
    'offline-folder-sidebar.tsx',
    'offline-message-reader.tsx',
  ]) {
    const src = read(`internal_packages/ai-sidebar/lib/offline-mail/${f}`);
    ok(!src.includes('dir="rtl"'), f);
  }
});
test('AI panel follows the language in offline mode only', () => {
  const src = read('internal_packages/ai-sidebar/lib/ai-sidebar.tsx');
  ok(src.includes("dir={offline ? offlineDir() : 'rtl'}"));
});
test('English stylesheet override sits inside the RTL-ignore block', () => {
  const less = read('internal_packages/ai-sidebar/styles/ai-sidebar.less');
  const i = less.indexOf('body.ofl-lang-en .ai-sidebar');
  ok(i > less.indexOf('/*!rtl:begin:ignore*/') && i < less.indexOf('/*!rtl:end:ignore*/'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
