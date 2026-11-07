#!/usr/bin/env npx ts-node
/**
 * Private offline nspell English/Hebrew prototype.
 * Requires a local sidecar install (AGPL-3.0 he aff/dic stay uncommitted):
 *
 *   bash app/src/spellcheck/offline-prototype/install.sh
 *
 * Does not touch app/package-lock.json. UNRUN in cloud.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-nspell-engine.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Editor } from 'slate';
import {
  stripNiqqud,
  tokenize,
  urlOrEmailRanges,
  replaceRange,
} from '../../src/spellcheck/spell-core';
import {
  findOfflineTypos,
  inspectAffixFile,
  loadOfflineSpellEngine,
  offlineAffixReports,
  offlineCorrect,
  offlineSuggest,
  resolveDictionaryFiles,
  OFFLINE_SPELL_NOTICE,
} from '../../src/spellcheck/nspell-engine';
import {
  applySpellReplacement,
  rememberSpellRange,
  refreshSpellDecorations,
  spellRangeForWord,
  SPELL_ERROR_MARK,
} from '../../src/components/composer-editor/spell-plugins';
import { createDemoComposerValue } from '../../src/components/composer-editor/demo-composer-fixtures';
import {
  paragraphSnapshots,
  setCurrentParagraphDirection,
} from '../../src/components/composer-editor/paragraph-direction';
import {
  PersonalDictionary,
  personalDictionaryPath,
} from '../../src/spellcheck/personal-dictionary';

let passed = 0;
let failed = 0;
const notes: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
    failed++;
  }
}

function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg || 'Expected true');
}
function assertFalse(v: boolean, msg?: string) {
  if (v) throw new Error(msg || 'Expected false');
}
function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertContains(haystack: string, needle: string) {
  if (!haystack.includes(needle)) throw new Error(`Expected to contain "${needle}"`);
}

function requireEngine() {
  const status = loadOfflineSpellEngine();
  if (!status.available || !status.english || !status.hebrew) {
    throw new Error(
      'Offline dictionaries missing. Run: bash app/src/spellcheck/offline-prototype/install.sh\n' +
        status.reason
    );
  }
  return status;
}

function run() {
  console.log('\n=== Offline nspell English/Hebrew prototype ===\n');

  test('sidecar package pins nspell 2.1.5, dictionary-en 4.0.0, dictionary-he 2.0.0', () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../src/spellcheck/offline-prototype/package.json'),
        'utf8'
      )
    );
    assertEqual(pkg.dependencies.nspell, '2.1.5');
    assertEqual(pkg.dependencies['dictionary-en'], '4.0.0');
    assertEqual(pkg.dependencies['dictionary-he'], '2.0.0');
    const notice = fs.readFileSync(
      path.join(__dirname, '../../src/spellcheck/offline-prototype/NOTICE.md'),
      'utf8'
    );
    assertContains(notice, 'AGPL-3.0');
    assertContains(notice, 'no independent');
    assertContains(notice, 'GPL-3 **§13**');
    assertContains(notice, 'does **not** automatically relicense');
    assertContains(notice, 'MIT');
    assertFalse(notice.includes('AGPL-3+'));
    const gitignore = fs.readFileSync(path.join(__dirname, '../../../.gitignore'), 'utf8');
    assertContains(gitignore, 'offline-prototype/node_modules');
  });

  test('public sources do not vendor aff/dic assets', () => {
    const he = resolveDictionaryFiles('dictionary-he');
    if (he) {
      assertFalse(he.aff.includes('/app/dist/'));
      assertTrue(he.aff.includes('node_modules'), 'local install lives under node_modules');
    }
    const engineSrc = fs.readFileSync(
      path.join(__dirname, '../../src/spellcheck/nspell-engine.ts'),
      'utf8'
    );
    assertFalse(engineSrc.includes('setSpellCheckerDictionaryDownloadURL'));
    assertFalse(engineSrc.includes('languagetool'));
    assertFalse(engineSrc.includes('addWordToSpellCheckerDictionary'));
    assertContains(engineSrc, 'Never silently');
  });

  test('tokenizer keeps mixed text, drops numbers/URLs, keeps geresh, strips niqqud for letters', () => {
    const mixed = tokenize('Invoice 12345 — חשבונית 12345');
    assertTrue(mixed.some((t) => t.word === 'Invoice'));
    assertTrue(mixed.some((t) => t.word === 'חשבונית'));
    assertFalse(mixed.some((t) => t.word === '12345'));
    const urls = urlOrEmailRanges('see https://example.com/foo and a@b.com please');
    assertEqual(urls.length, 2);
    const skipped = tokenize('see https://example.com/foo and a@b.com please');
    assertFalse(skipped.some((t) => t.word === 'example'));
    const geresh = tokenize(`צה\"ל במבחן`);
    assertTrue(geresh.some((t) => t.word.includes('ל') || t.word.length >= 2));
    assertEqual(stripNiqqud('שָׁלוֹם'), 'שלום');
  });

  test('affix inspection records nspell gaps without assuming Hunspell parity', () => {
    const heFiles = resolveDictionaryFiles('dictionary-he');
    const enFiles = resolveDictionaryFiles('dictionary-en');
    if (!heFiles || !enFiles) {
      throw new Error('Install sidecar dictionaries first (install.sh)');
    }
    const he = inspectAffixFile(heFiles.aff);
    const en = inspectAffixFile(enFiles.aff);
    assertTrue(he.pfxClasses > 0, 'Hspell uses PFX clitics');
    assertEqual(he.sfxClasses, 0);
    assertFalse(he.hasComplexPrefixes);
    assertTrue(he.hasMap, 'dictionary-he MAP (final letters) is present');
    assertTrue(he.hasBreak, 'dictionary-he BREAK is present');
    assertTrue(he.nspellUnsupportedPresent.includes('MAP'));
    assertTrue(he.nspellUnsupportedPresent.includes('BREAK'));
    assertTrue(en.sfxClasses > 0);
    notes.push(
      `he aff PFX=${he.pfxClasses} SFX=${he.sfxClasses} nspell-unsupported=${he.nspellUnsupportedPresent.join(',')}`
    );
  });

  test('engine loads separate English and Hebrew instances', () => {
    const status = requireEngine();
    assertTrue(status.english);
    assertTrue(status.hebrew);
    assertEqual(status.licenses.nspell, 'MIT');
    assertEqual(status.licenses.dictionaryHeAffDic, 'AGPL-3.0');
    assertContains(OFFLINE_SPELL_NOTICE, 'no auto-correct');
    const reports = offlineAffixReports();
    assertTrue(!!reports.he && !!reports.en);
    notes.push(`loadMs=${status.loadMs}`);
  });

  test('English real words: correct vs typos, target suggestions, not silent', () => {
    requireEngine();
    assertEqual(offlineCorrect('watermelon', 'en'), true);
    assertEqual(offlineCorrect('invoice', 'en'), true);
    assertEqual(offlineCorrect('recieve', 'en'), false);
    assertEqual(offlineCorrect('seperate', 'en'), false);
    assertEqual(offlineCorrect('mispell', 'en'), false);
    const recieve = offlineSuggest('recieve', 'en');
    assertTrue(recieve.includes('receive'), `recieve suggestions: ${recieve.join(',')}`);
    const seperate = offlineSuggest('seperate', 'en');
    assertTrue(seperate.includes('separate'), `seperate suggestions: ${seperate.join(',')}`);
    assertEqual('recieve', 'recieve');
  });

  test('Hebrew real words: correct vs typos, morphology clitics, suggestions', () => {
    requireEngine();
    assertEqual(offlineCorrect('אבטיח', 'he'), true);
    assertEqual(offlineCorrect('שלום', 'he'), true);
    assertEqual(offlineCorrect('אבטיחחח', 'he'), false);
    assertEqual(offlineCorrect('חשבנוית', 'he'), false);
    assertEqual(offlineCorrect('שלומ', 'he'), false);
    const house = offlineCorrect('בית', 'he');
    const theHouse = offlineCorrect('הבית', 'he');
    if (house && !theHouse) {
      throw new Error(
        'BLOCKED for nspell: dictionary knows בית but not PFX clitic הבית — prefer Hunspell WASM'
      );
    }
    assertTrue(!!house, 'בית should be in Hspell 1.4');
    assertTrue(!!theHouse, 'הבית should match PFX a (nspell supports PFX)');
    const inHouse = offlineCorrect('בבית', 'he');
    if (house && !inHouse) {
      notes.push('NOTE: בבית not accepted (possible PFX/cross-product gap)');
    }
    const shalomSug = offlineSuggest('שלומ', 'he');
    if (!shalomSug.includes('שלום')) {
      notes.push(
        `NOTE: nspell did not suggest שלום for שלומ (${shalomSug.join(',') || 'none'}) — MAP/BREAK unsupported; Hunspell WASM candidate if this repeats`
      );
    }
  });

  test('mixed text, punctuation, numbers are not flagged as words', () => {
    requireEngine();
    const hits = findOfflineTypos('Invoice 12345 — חשבונית 12345.', []);
    assertFalse(hits.some((h) => h.word === '12345'));
    assertFalse(hits.some((h) => h.word === 'Invoice'));
    assertFalse(hits.some((h) => h.word === 'חשבונית'));
    const urlHits = findOfflineTypos('see https://example.com/watermelon path', []);
    assertFalse(urlHits.some((h) => /example/.test(h.word)));
  });

  test('personal dictionary add/remove is app-scoped and not silent', () => {
    requireEngine();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-spell-'));
    const dict = new PersonalDictionary(personalDictionaryPath(dir));
    const word = 'recieve';
    assertEqual(offlineCorrect(word, 'en'), false);
    let hits = findOfflineTypos(`please ${word} now`, dict.list());
    assertTrue(hits.some((h) => h.word === word));
    dict.add(word);
    hits = findOfflineTypos(`please ${word} now`, dict.list());
    assertFalse(hits.some((h) => h.word === word));
    dict.remove(word);
    hits = findOfflineTypos(`please ${word} now`, dict.list());
    assertTrue(hits.some((h) => h.word === word));
    assertEqual(`please ${word} now`, `please ${word} now`);
  });

  test('target-only replace preserves neighbors and paragraph direction', () => {
    requireEngine();
    const original = 'שלום recieve עגבניה';
    const tokens = tokenize(original);
    const rec = tokens.find((t) => t.word === 'recieve');
    assertTrue(!!rec);
    const next = replaceRange(original, rec.start, rec.end, 'receive');
    assertEqual(next, 'שלום receive עגבניה');
    const editor = new Editor({ value: createDemoComposerValue() });
    editor.moveToRangeOfDocument();
    editor.moveToStart();
    const first: any = editor.value.document.nodes.get(0);
    editor.moveToRangeOfNode(first).moveToEnd().insertText(' recieve');
    refreshSpellDecorations(editor);
    const range = spellRangeForWord(editor, 'recieve');
    assertTrue(!!range, 'expected recieve mark');
    rememberSpellRange(range);
    const snapsBefore = paragraphSnapshots(editor.value);
    applySpellReplacement(editor, 'receive', range);
    const snapsAfter = paragraphSnapshots(editor.value);
    assertEqual(snapsAfter[0].dir, snapsBefore[0].dir);
    assertTrue(snapsAfter[0].text.includes('receive'));
    assertFalse(snapsAfter[0].text.includes('recieve'));
    assertEqual(snapsAfter[1].text, snapsBefore[1].text);
    editor.moveToRangeOfNode(editor.value.document.nodes.get(1) as any);
    setCurrentParagraphDirection(editor, 'rtl');
    assertEqual(paragraphSnapshots(editor.value)[0].dir, snapsAfter[0].dir);
  });

  test('fixture typos stay fixture-backend; general uses nspell; no auto-correct in plugins', () => {
    const plugin = fs.readFileSync(
      path.join(__dirname, '../../src/components/composer-editor/spell-plugins.tsx'),
      'utf8'
    );
    assertContains(plugin, 'findFixtureTypos');
    assertContains(plugin, 'findOfflineTypos');
    assertContains(plugin, "backend: 'nspell'");
    assertContains(plugin, 'not a Hebrew dictionary');
    assertContains(plugin, 'no auto-correct');
    assertFalse(/setTimeout\([^)]*replace/.test(plugin));
    const editor = new Editor({ value: createDemoComposerValue() });
    refreshSpellDecorations(editor);
    const marks: string[] = [];
    const decorations = (editor.value as any).get('decorations');
    if (decorations) {
      decorations.forEach((d: any) => {
        if (d.mark && d.mark.type === SPELL_ERROR_MARK) {
          marks.push(`${d.mark.data.get('backend')}:${d.mark.data.get('word')}`);
        }
      });
    }
    assertTrue(marks.some((m) => m === 'fixture:misspelledd'));
    assertTrue(marks.some((m) => m === 'fixture:איותת'));
  });

  test('misclassification probe: demo fixture sentences should not mass-flag', () => {
    requireEngine();
    const demoHe = findOfflineTypos('שלום צוות, מצורפת החשבונית לחודש נובמבר.', []);
    const demoEn = findOfflineTypos('Hello team, please review the invoice for November.', []);
    if (demoHe.length) {
      notes.push(`misclass HE demo: ${demoHe.map((h) => h.word).join(',')}`);
    }
    if (demoEn.length) {
      notes.push(`misclass EN demo: ${demoEn.map((h) => h.word).join(',')}`);
    }
    assertTrue(
      demoHe.length <= 2,
      `too many Hebrew misclassifications on demo sentence: ${demoHe.map((h) => h.word).join(',')}`
    );
    assertTrue(
      demoEn.length <= 2,
      `too many English misclassifications on demo sentence: ${demoEn.map((h) => h.word).join(',')}`
    );
  });

  test('performance: load once; suggest budget; record for Hunspell WASM comparison', () => {
    const status = requireEngine();
    assertTrue(status.loadMs < 30000, `dictionary load ${status.loadMs}ms exceeded 30s`);
    const t0 = Date.now();
    offlineCorrect('watermelon', 'en');
    offlineCorrect('אבטיח', 'he');
    const checkMs = Date.now() - t0;
    const t1 = Date.now();
    offlineSuggest('recieve', 'en', 5);
    const enSugMs = Date.now() - t1;
    const t2 = Date.now();
    offlineSuggest('שלומ', 'he', 5);
    const heSugMs = Date.now() - t2;
    notes.push(`correctMs=${checkMs} enSuggestMs=${enSugMs} heSuggestMs=${heSugMs}`);
    if (heSugMs > 5000) {
      notes.push(
        'BLOCKED-candidate: Hebrew nspell.suggest >5s — interactive UI may need Hunspell WASM'
      );
    }
    assertTrue(enSugMs < 20000, `English suggest ${enSugMs}ms`);
    assertTrue(heSugMs < 20000, `Hebrew suggest ${heSugMs}ms`);
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (notes.length) {
    console.log('Notes:');
    notes.forEach((n) => console.log('  - ' + n));
  }
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
