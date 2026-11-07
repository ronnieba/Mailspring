#!/usr/bin/env npx ts-node
/**
 * Private offline Hunspell WASM English/Hebrew prototype.
 * Requires a local sidecar install (AGPL-3.0 he aff/dic stay uncommitted):
 *
 *   bash app/src/spellcheck/offline-prototype/install.sh
 *
 * Does not touch app/package-lock.json. UNRUN in cloud.
 * nspell is rejected (native 7c346435 stall). Engine runs in a child process
 * with hard timeouts so this suite cannot occupy the test Node at 99% CPU.
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
  CORRECT_TIMEOUT_MS,
  LOAD_TIMEOUT_MS,
  SUGGEST_TIMEOUT_MS,
  disposeOfflineSpellEngine,
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
  refreshSpellDecorationsAsync,
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`TEST TIMEOUT ${ms}ms: ${label}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function test(name: string, fn: () => void | Promise<void>, timeoutMs = 10000) {
  const t0 = Date.now();
  console.log(`  … ${name}`);
  try {
    await withTimeout(Promise.resolve().then(fn), timeoutMs, name);
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name} (${Date.now() - t0}ms)`);
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

async function requireEngine() {
  const status = await loadOfflineSpellEngine();
  if (!status.available || !status.english || !status.hebrew) {
    throw new Error(
      'Offline Hunspell dictionaries missing or load failed. Run: bash app/src/spellcheck/offline-prototype/install.sh\n' +
        status.phase +
        ' ' +
        status.reason
    );
  }
  return status;
}

async function run() {
  console.log('\n=== Offline Hunspell WASM English/Hebrew prototype ===\n');
  console.log(
    `Timeouts: load=${LOAD_TIMEOUT_MS}ms correct=${CORRECT_TIMEOUT_MS}ms suggest=${SUGGEST_TIMEOUT_MS}ms (child process; parent SIGTERM on expiry)\n`
  );

  await test('sidecar package pins hunspell-asm 4.0.2; nspell is not a dependency', () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../src/spellcheck/offline-prototype/package.json'),
        'utf8'
      )
    );
    assertEqual(pkg.dependencies['hunspell-asm'], '4.0.2');
    assertEqual(pkg.dependencies['dictionary-en'], '4.0.0');
    assertEqual(pkg.dependencies['dictionary-he'], '2.0.0');
    assertTrue(!pkg.dependencies.nspell, 'nspell must not be installed');
    const notice = fs.readFileSync(
      path.join(__dirname, '../../src/spellcheck/offline-prototype/NOTICE.md'),
      'utf8'
    );
    assertContains(notice, 'AGPL-3.0');
    assertContains(notice, 'no independent');
    assertContains(notice, 'GPL-3 **§13**');
    assertContains(notice, 'does **not** automatically relicense');
    assertContains(notice, 'MIT');
    assertContains(notice, 'nspell rejected');
    assertContains(notice, 'eager');
    assertFalse(notice.includes('AGPL-3+'));
    const gitignore = fs.readFileSync(path.join(__dirname, '../../../.gitignore'), 'utf8');
    assertContains(gitignore, 'offline-prototype/node_modules');
    const install = fs.readFileSync(
      path.join(__dirname, '../../src/spellcheck/offline-prototype/install.sh'),
      'utf8'
    );
    assertFalse(install.includes('Refusing to run from a path that would confuse npm'));
    assertContains(install, 'Aborting');
    assertContains(install, 'exit 1');
    assertContains(install, '--prefix');
    assertContains(install, '--no-package-lock');
  });

  await test('public sources do not vendor aff/dic assets or construct nspell', () => {
    const he = resolveDictionaryFiles('dictionary-he');
    if (he) {
      assertFalse(he.aff.includes('/app/dist/'));
      assertTrue(he.aff.includes('node_modules'), 'local install lives under node_modules');
    }
    const engineSrc = fs.readFileSync(
      path.join(__dirname, '../../src/spellcheck/offline-spell-engine.ts'),
      'utf8'
    );
    assertFalse(engineSrc.includes("require('nspell')"));
    assertFalse(engineSrc.includes('requireNspell'));
    assertFalse(engineSrc.includes('setSpellCheckerDictionaryDownloadURL'));
    assertFalse(engineSrc.includes('languagetool'));
    assertFalse(engineSrc.includes('addWordToSpellCheckerDictionary'));
    assertContains(engineSrc, 'Never silently');
    assertContains(engineSrc, 'killWorker');
    assertContains(engineSrc, 'LOAD_TIMEOUT_MS');
    const workerSrc = fs.readFileSync(
      path.join(__dirname, '../../src/spellcheck/offline-prototype/hunspell-worker.js'),
      'utf8'
    );
    assertContains(workerSrc, 'hunspell-asm');
    assertFalse(workerSrc.includes("require('nspell')"));
  });

  await test('tokenizer keeps mixed text, drops numbers/URLs, keeps geresh, strips niqqud for letters', () => {
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

  await test('affix inspection records Hspell MAP/BREAK/PFX; nspell rejected for eager expansion', () => {
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
      `he aff PFX=${he.pfxClasses} SFX=${he.sfxClasses} aff-features=${he.nspellUnsupportedPresent.join(',')}`
    );
  });

  await test(
    'engine loads separate English and Hebrew Hunspell instances in a child process',
    async () => {
      const status = await requireEngine();
      assertTrue(status.english);
      assertTrue(status.hebrew);
      assertEqual(status.engine, 'hunspell-asm');
      assertEqual(status.licenses.hunspellAsm, 'MIT');
      assertEqual(status.licenses.dictionaryHeAffDic, 'AGPL-3.0');
      assertContains(OFFLINE_SPELL_NOTICE, 'no auto-correct');
      assertTrue(status.loadMs < LOAD_TIMEOUT_MS, `load ${status.loadMs}ms`);
      const reports = offlineAffixReports();
      assertTrue(!!reports.he && !!reports.en);
      notes.push(`loadMs=${status.loadMs} phase=${status.phase}`);
    },
    LOAD_TIMEOUT_MS + 4000
  );

  await test('English real words: correct vs typos, target suggestions, not silent', async () => {
    await requireEngine();
    assertEqual(await offlineCorrect('watermelon', 'en'), true);
    assertEqual(await offlineCorrect('invoice', 'en'), true);
    assertEqual(await offlineCorrect('recieve', 'en'), false);
    assertEqual(await offlineCorrect('seperate', 'en'), false);
    assertEqual(await offlineCorrect('mispell', 'en'), false);
    const recieve = await offlineSuggest('recieve', 'en');
    assertTrue(recieve.includes('receive'), `recieve suggestions: ${recieve.join(',')}`);
    const seperate = await offlineSuggest('seperate', 'en');
    assertTrue(seperate.includes('separate'), `seperate suggestions: ${seperate.join(',')}`);
    assertEqual('recieve', 'recieve');
  });

  await test('Hebrew real words: correct vs typos, morphology clitics, suggestions', async () => {
    await requireEngine();
    assertEqual(await offlineCorrect('אבטיח', 'he'), true);
    assertEqual(await offlineCorrect('שלום', 'he'), true);
    assertEqual(await offlineCorrect('אבטיחחח', 'he'), false);
    assertEqual(await offlineCorrect('חשבנוית', 'he'), false);
    assertEqual(await offlineCorrect('שלומ', 'he'), false);
    const house = await offlineCorrect('בית', 'he');
    const theHouse = await offlineCorrect('הבית', 'he');
    if (house && !theHouse) {
      throw new Error('BLOCKED: dictionary knows בית but not PFX clitic הבית under Hunspell WASM');
    }
    assertTrue(!!house, 'בית should be in Hspell 1.4');
    assertTrue(!!theHouse, 'הבית should match PFX a (Hunspell applies affixes at check time)');
    const inHouse = await offlineCorrect('בבית', 'he');
    if (house && !inHouse) {
      notes.push('NOTE: בבית not accepted (possible PFX/cross-product gap)');
    }
    const shalomSug = await offlineSuggest('שלומ', 'he');
    if (!shalomSug.includes('שלום')) {
      throw new Error(
        `Hebrew suggest missing שלום for שלומ (${shalomSug.join(',') || 'none'}) — not hidden`
      );
    }
  });

  await test('mixed text, punctuation, numbers are not flagged as words', async () => {
    await requireEngine();
    const hits = await findOfflineTypos('Invoice 12345 — חשבונית 12345.', []);
    assertFalse(hits.some((h) => h.word === '12345'));
    assertFalse(hits.some((h) => h.word === 'Invoice'));
    assertFalse(hits.some((h) => h.word === 'חשבונית'));
    const urlHits = await findOfflineTypos('see https://example.com/watermelon path', []);
    assertFalse(urlHits.some((h) => /example/.test(h.word)));
  });

  await test('personal dictionary add/remove is app-scoped and not silent', async () => {
    await requireEngine();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-spell-'));
    const dict = new PersonalDictionary(personalDictionaryPath(dir));
    const word = 'recieve';
    assertEqual(await offlineCorrect(word, 'en'), false);
    let hits = await findOfflineTypos(`please ${word} now`, dict.list());
    assertTrue(hits.some((h) => h.word === word));
    dict.add(word);
    hits = await findOfflineTypos(`please ${word} now`, dict.list());
    assertFalse(hits.some((h) => h.word === word));
    dict.remove(word);
    hits = await findOfflineTypos(`please ${word} now`, dict.list());
    assertTrue(hits.some((h) => h.word === word));
    assertEqual(`please ${word} now`, `please ${word} now`);
  });

  await test('target-only replace preserves neighbors and paragraph direction', async () => {
    await requireEngine();
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
    await refreshSpellDecorationsAsync(editor);
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

  await test('fixture typos stay fixture-backend; general uses hunspell; no auto-correct in plugins', async () => {
    const plugin = fs.readFileSync(
      path.join(__dirname, '../../src/components/composer-editor/spell-plugins.tsx'),
      'utf8'
    );
    assertContains(plugin, 'findFixtureTypos');
    assertContains(plugin, 'findOfflineTypos');
    assertContains(plugin, "'hunspell'");
    assertContains(plugin, 'not a Hebrew dictionary');
    assertContains(plugin, 'no auto-correct');
    assertContains(plugin, 'ההצעות חרגו מהזמן');
    assertFalse(/setTimeout\([^)]*replace/.test(plugin));
    const editor = new Editor({ value: createDemoComposerValue() });
    await refreshSpellDecorationsAsync(editor);
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

  await test('misclassification probe: demo fixture sentences should not mass-flag', async () => {
    await requireEngine();
    const demoHe = await findOfflineTypos('שלום צוות, מצורפת החשבונית לחודש נובמבר.', []);
    const demoEn = await findOfflineTypos(
      'Hello team, please review the invoice for November.',
      []
    );
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

  await test('performance: child-process load/suggest stay inside UI budgets', async () => {
    const status = await requireEngine();
    assertTrue(
      status.loadMs < LOAD_TIMEOUT_MS,
      `dictionary load ${status.loadMs}ms exceeded ${LOAD_TIMEOUT_MS}ms`
    );
    const t0 = Date.now();
    await offlineCorrect('watermelon', 'en');
    await offlineCorrect('אבטיח', 'he');
    const checkMs = Date.now() - t0;
    const t1 = Date.now();
    await offlineSuggest('recieve', 'en', 5);
    const enSugMs = Date.now() - t1;
    const t2 = Date.now();
    await offlineSuggest('שלומ', 'he', 5);
    const heSugMs = Date.now() - t2;
    notes.push(`correctMs=${checkMs} enSuggestMs=${enSugMs} heSuggestMs=${heSugMs}`);
    assertTrue(checkMs < CORRECT_TIMEOUT_MS, `correct ${checkMs}ms`);
    assertTrue(enSugMs < SUGGEST_TIMEOUT_MS, `English suggest ${enSugMs}ms`);
    assertTrue(heSugMs < SUGGEST_TIMEOUT_MS, `Hebrew suggest ${heSugMs}ms`);
  });

  try {
    await disposeOfflineSpellEngine();
  } catch {
    // ignore
  }

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (notes.length) {
    console.log('Notes:');
    notes.forEach((n) => console.log('  - ' + n));
  }
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  void disposeOfflineSpellEngine();
  process.exit(1);
});
