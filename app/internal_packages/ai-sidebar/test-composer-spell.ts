#!/usr/bin/env npx ts-node
/**
 * Hebrew+English spell overlay: visible misspellings, user-invoked replace,
 * personal dictionary. Never silent auto-correct. Never OS ~/Library/Spelling.
 *
 * UNRUN in cloud. Parent must execute locally on Mac.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-composer-spell.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-composer-spell.ts"
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultSpellCheckContext,
  findFixtureTypos,
  findMisspellings,
  replaceRange,
  stripNiqqud,
  suggestionsFor,
  tokenize,
} from '../../src/spellcheck/spell-core';
import {
  ensurePersonalDictionary,
  getActivePersonalDictionary,
  installPersonalDictionary,
  isUnsafeDictionaryPath,
  PersonalDictionary,
  personalDictionaryPath,
} from '../../src/spellcheck/personal-dictionary';
import {
  describeSpellBackends,
  enableNativeSpellSession,
  formatBackendStatusText,
  formatHebrewNativeSummary,
  languagesToEnable,
  nativeContextSpellItems,
  nativeGuessSupport,
  pickSupportedLanguage,
} from '../../src/spellcheck/native-availability';
import { SPELL_WORDLIST_LICENSE, SPELL_WORDLIST_PROVENANCE } from '../../src/spellcheck/word-lists';
import {
  applySpellReplacement,
  refreshSpellDecorations,
  rememberSpellRange,
  spellRangeForWord,
  SPELL_ERROR_MARK,
} from '../../src/components/composer-editor/spell-plugins';
import {
  createDemoComposerValue,
  DEMO_EN_CORRECT_WORD,
  DEMO_EN_LTR,
  DEMO_EN_MISS,
  DEMO_EN_MISS_WORD,
  DEMO_HE_CORRECT_WORD,
  DEMO_HE_MISS,
  DEMO_HE_MISS_WORD,
  DEMO_HE_RTL,
} from '../../src/components/composer-editor/demo-composer-fixtures';
import { Editor } from 'slate';

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');

let passed = 0;
let failed = 0;

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
  if (!haystack.includes(needle)) {
    throw new Error(`Expected to contain "${needle}"`);
  }
}

function run() {
  console.log('\n=== Composer Hebrew+English spell (no auto-correct) ===\n');

  const ctx = defaultSpellCheckContext();

  test('tokenize splits mixed Hebrew and English and ignores numbers', () => {
    const tokens = tokenize('Invoice 12345 — חשבונית 12345');
    const words = tokens.map((t) => t.word);
    assertTrue(words.includes('Invoice'));
    assertTrue(words.includes('חשבונית'));
    assertFalse(words.includes('12345'));
    const geresh = tokenize('צה"ל במבחן');
    assertTrue(geresh.some((t) => t.word === 'צה"ל'));
    const marked = tokenize('שָׁלוֹם');
    assertTrue(marked.some((t) => stripNiqqud(t.word) === 'שלום'));
  });

  test('known fixture words are not misspellings', () => {
    assertEqual(findMisspellings(DEMO_HE_RTL, ctx).length, 0);
    assertEqual(findMisspellings(DEMO_EN_LTR, ctx).length, 0);
  });

  test('English misspelledd is visible and does not mutate the string', () => {
    const original = DEMO_EN_MISS;
    const misses = findFixtureTypos(original);
    assertEqual(misses.length, 1);
    assertEqual(misses[0].word, DEMO_EN_MISS_WORD);
    assertEqual(misses[0].suggestion, DEMO_EN_CORRECT_WORD);
    const flagged = new Set(misses.map((m) => m.word));
    for (const w of ['This', 'is', 'a', 'word', 'in', 'English']) {
      assertFalse(flagged.has(w), `overlay must not flag surrounding "${w}"`);
    }
    assertEqual(original, DEMO_EN_MISS);
  });

  test('Hebrew איותת is visible and does not mutate the string', () => {
    const original = DEMO_HE_MISS;
    const misses = findFixtureTypos(original);
    assertEqual(misses.length, 1);
    assertEqual(misses[0].word, DEMO_HE_MISS_WORD);
    assertEqual(misses[0].suggestion, DEMO_HE_CORRECT_WORD);
    const flagged = new Set(misses.map((m) => m.word));
    for (const w of ['זו', 'שגיאת', 'בפסקה', 'העברית']) {
      assertFalse(flagged.has(w), `overlay must not flag surrounding "${w}"`);
    }
    assertEqual(original, DEMO_HE_MISS);
  });

  test('tiny-list scan is not the overlay (surrounding words are not typos)', () => {
    const en = findMisspellings(DEMO_EN_MISS, ctx).map((t) => t.word);
    assertTrue(en.includes(DEMO_EN_MISS_WORD));
    assertTrue(en.includes('in'), 'closed-world list lacks "in"; overlay must not use this scan');
    assertTrue(en.length > 1);
    const he = findMisspellings(DEMO_HE_MISS, ctx).map((t) => t.word);
    assertTrue(he.includes(DEMO_HE_MISS_WORD));
    assertTrue(he.includes('בפסקה'));
    assertTrue(he.includes('העברית'));
    assertEqual(he.length, 3);
  });

  test('suggestionsFor is user-invoked only (text unchanged until replaceRange)', () => {
    const s = suggestionsFor(DEMO_EN_MISS_WORD, 'en', ctx);
    assertTrue(s.includes(DEMO_EN_CORRECT_WORD), `expected ${DEMO_EN_CORRECT_WORD} in ${s}`);
    const he = suggestionsFor(DEMO_HE_MISS_WORD, 'he', ctx);
    assertTrue(he.includes(DEMO_HE_CORRECT_WORD), `expected ${DEMO_HE_CORRECT_WORD} in ${he}`);
    assertEqual(DEMO_EN_MISS_WORD, 'misspelledd');
  });

  test('replaceRange only changes text when explicitly applied', () => {
    const next = replaceRange(
      DEMO_EN_MISS,
      DEMO_EN_MISS.indexOf(DEMO_EN_MISS_WORD),
      DEMO_EN_MISS.indexOf(DEMO_EN_MISS_WORD) + DEMO_EN_MISS_WORD.length,
      DEMO_EN_CORRECT_WORD
    );
    assertContains(next, DEMO_EN_CORRECT_WORD);
    assertFalse(next.includes(DEMO_EN_MISS_WORD));
    assertEqual(DEMO_EN_MISS.includes(DEMO_EN_MISS_WORD), true);
  });

  test('personal dictionary add/remove is scoped to a file and affects checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-spell-'));
    const file = personalDictionaryPath(dir);
    const dict = new PersonalDictionary(file);
    assertEqual(findFixtureTypos(DEMO_EN_MISS, dict.list()).length, 1);
    dict.add(DEMO_EN_MISS_WORD);
    assertEqual(findFixtureTypos(DEMO_EN_MISS, dict.list()).length, 0);
    assertEqual(findFixtureTypos(DEMO_HE_MISS, dict.list()).length, 1);
    dict.add(DEMO_HE_MISS_WORD);
    assertEqual(findFixtureTypos(DEMO_HE_MISS, dict.list()).length, 0);
    dict.remove(DEMO_EN_MISS_WORD);
    const enAfter = findFixtureTypos(DEMO_EN_MISS, dict.list());
    assertEqual(enAfter.length, 1);
    assertEqual(enAfter[0].word, DEMO_EN_MISS_WORD);
    dict.remove(DEMO_HE_MISS_WORD);
    const heAfter = findFixtureTypos(DEMO_HE_MISS, dict.list());
    assertEqual(heAfter.length, 1);
    assertEqual(heAfter[0].word, DEMO_HE_MISS_WORD);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertFalse(saved.words.includes(DEMO_EN_MISS_WORD));
    assertFalse(saved.words.includes(DEMO_HE_MISS_WORD));
  });

  test('module dictionary holder is let-mutable; add/remove use the isolated file', () => {
    const src = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'spellcheck/personal-dictionary.ts'),
      'utf8'
    );
    assertContains(src, 'let active:');
    assertFalse(/\bconst active\b/.test(src), 'active must be let so install/ensure can rebind');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-spell-active-'));
    installPersonalDictionary(null);
    try {
      const a = ensurePersonalDictionary(dir);
      assertEqual(getActivePersonalDictionary(), a);
      a.add(DEMO_HE_MISS_WORD);
      assertTrue(a.has(DEMO_HE_MISS_WORD));
      assertEqual(ensurePersonalDictionary(dir), a);
      a.remove(DEMO_HE_MISS_WORD);
      assertFalse(a.has(DEMO_HE_MISS_WORD));
      const saved = JSON.parse(fs.readFileSync(personalDictionaryPath(dir), 'utf8'));
      assertFalse(saved.words.includes(DEMO_HE_MISS_WORD));
      assertFalse(dir.includes('Library/Spelling'));
      assertFalse(dir.includes(`${path.sep}Mailspring${path.sep}`));
    } finally {
      installPersonalDictionary(null);
    }
  });

  test('refuses OS spelling dir and production Mailspring profile', () => {
    assertTrue(isUnsafeDictionaryPath('/Users/x/Library/Spelling/LocalDictionary'));
    assertTrue(
      isUnsafeDictionaryPath(
        '/Users/x/Library/Application Support/Mailspring/spell-personal-dictionary.json'
      )
    );
    assertFalse(
      isUnsafeDictionaryPath(
        '/Users/x/Library/Application Support/Mailspring-demo/spell-personal-dictionary.json'
      )
    );
    assertFalse(
      isUnsafeDictionaryPath(
        '/Users/x/Library/Application Support/Mailspring-dev/spell-personal-dictionary.json'
      )
    );
    const dict = new PersonalDictionary('/Users/x/Library/Spelling/LocalDictionary', {
      readFileSync: () => {
        throw Object.assign(new Error('no'), { code: 'ENOENT' });
      },
      writeFileSync: () => {
        throw new Error('should not write OS dictionary');
      },
    } as any);
    let threw = false;
    try {
      dict.add('nope');
    } catch {
      threw = true;
    }
    assertTrue(threw);
  });

  test('session list reports he when present and does not claim macOS Hebrew unavailable', () => {
    const none = describeSpellBackends(['en-US']);
    assertEqual(none.english.listedInSession, true);
    assertEqual(none.hebrew.listedInSession, false);
    assertEqual(none.hebrewBundledDictionary, 'not-shipped');
    assertEqual(none.hebrewNativeDetection, 'unproven');
    assertEqual(none.hebrewNativeSuggestions, 'unproven');
    assertEqual(none.hebrewUiTestOverlay, 'fixture-typos-only');
    assertFalse(none.note.toLowerCase().includes('unavailable'));
    assertContains(none.note, 'not a universal macOS result');
    const both = describeSpellBackends(['en-US', 'he']);
    assertEqual(both.hebrew.listedInSession, true);
    assertEqual(both.hebrew.code, 'he');
    assertEqual(both.hebrewNativeDetection, 'unproven');
    assertEqual(both.hebrewNativeSuggestions, 'unproven');
    const listed = formatBackendStatusText(both);
    assertContains(listed, 'listing is not detection');
    assertContains(listed, 'suggestions unproven');
    assertContains(listed, 'Hebrew native listed');
    assertFalse(listed.includes('runtime verification pending'));
    assertFalse(listed.includes('General Hebrew: BLOCKED'));
    const summary = formatHebrewNativeSummary(both);
    assertContains(summary, 'listing is not detection');
    assertContains(summary, 'suggestions unproven');
    assertContains(formatHebrewNativeSummary(none), 'not a universal unavailable claim');
    assertEqual(pickSupportedLanguage(['en-US'], ['he', 'he-IL']), null);
    const enabled = languagesToEnable(['en-US', 'he'], 'he');
    assertTrue(enabled.includes('he'));
    assertTrue(enabled.includes('en-US'));
    let enabledFlag = false;
    let maxRep = 0;
    const langs = enableNativeSpellSession(
      {
        availableSpellCheckerLanguages: ['en-US', 'he'],
        setSpellCheckerEnabled: (v: boolean) => {
          enabledFlag = v;
        },
        setSpellCheckerLanguages: () => {},
        setSpellCheckerMaxReplacements: (n: number) => {
          maxRep = n;
        },
      },
      null
    );
    assertTrue(enabledFlag);
    assertEqual(maxRep, 5);
    assertTrue(langs.includes('he'));
  });

  test('native context menu distinguishes empty guesses from missing misspelledWord', () => {
    const none = nativeContextSpellItems({ misspelledWord: '', dictionarySuggestions: ['x'] });
    assertEqual(none.misspelledWord, null);
    assertEqual(none.suggestions.length, 0);
    assertEqual(none.emptyGuesses, false);
    const empty = nativeContextSpellItems({
      misspelledWord: 'recieve',
      dictionarySuggestions: [],
    });
    assertEqual(empty.misspelledWord, 'recieve');
    assertEqual(empty.emptyGuesses, true);
    assertEqual(nativeGuessSupport(empty), 'empty-guesses');
    assertEqual(nativeGuessSupport(none), 'none');
    const guessed = nativeContextSpellItems({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'teh'],
    });
    assertEqual(guessed.emptyGuesses, false);
    assertEqual(nativeGuessSupport(guessed), 'has-suggestions');
    assertTrue(guessed.suggestions.includes('the'));
    assertFalse(guessed.suggestions.includes('teh'));
    const weh = fs.readFileSync(path.join(APP_SRC_ROOT, 'window-event-handler.ts'), 'utf8');
    assertContains(weh, 'nativeContextSpellItems');
    assertContains(weh, 'event.preventDefault()');
    assertContains(weh, 'replaceMisspelling');
    assertContains(weh, 'No Guesses Found');
    const win = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser/mailspring-window.ts'), 'utf8');
    assertContains(win, 'spellcheck: true');
  });

  test('UI-test overlay flags only known typos, not general Hebrew', () => {
    const hits = findFixtureTypos(`${DEMO_HE_RTL} אבטיח ${DEMO_HE_MISS} ${DEMO_EN_MISS}`);
    assertEqual(hits.length, 2);
    assertEqual(hits[0].word, DEMO_HE_MISS_WORD);
    assertEqual(hits[1].word, DEMO_EN_MISS_WORD);
    assertEqual(findFixtureTypos('שלום צוות אבטיח החשבונית').length, 0);
  });

  test('word list provenance is UI-test fixture only, not Hspell/Hunspell', () => {
    assertContains(SPELL_WORDLIST_LICENSE, 'GPL-3.0');
    assertContains(SPELL_WORDLIST_LICENSE, 'UI-test');
    assertContains(SPELL_WORDLIST_PROVENANCE, 'Not general-language');
    const lists = fs.readFileSync(path.join(APP_SRC_ROOT, 'spellcheck/word-lists.ts'), 'utf8');
    assertContains(lists, 'Not Hspell');
    assertContains(lists, 'not Hunspell');
    assertContains(lists, 'NOT general Hebrew');
  });

  test('native-availability documents Electron/macOS NSSpellChecker vs Hunspell', () => {
    const src = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'spellcheck/native-availability.ts'),
      'utf8'
    );
    assertContains(src, 'NSSpellChecker');
    assertContains(src, 'https://www.electronjs.org/docs/latest/tutorial/spellchecker');
    assertContains(src, 'Library/Spelling');
    assertContains(src, 'Do not claim macOS Hebrew is unavailable');
    assertContains(src, 'enableNativeSpellSession');
    assertContains(src, 'nativeContextSpellItems');
    assertContains(src, 'electron/issues/24455');
    const status = describeSpellBackends(['en-US', 'he']);
    assertEqual(status.hebrew.listedInSession, true);
    assertEqual(status.hebrewNativeDetection, 'unproven');
    assertEqual(status.hebrewNativeSuggestions, 'unproven');
    assertEqual(status.hebrewBundledDictionary, 'not-shipped');
    const text = formatBackendStatusText(status);
    assertContains(text, 'listing is not detection');
    assertContains(text, 'suggestions unproven');
    assertFalse(text.includes('runtime verification pending'));
    const blocker = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'spellcheck/HEBREW-SPELLCHECK.md'),
      'utf8'
    );
    assertContains(blocker, 'AGPL-3');
    assertContains(blocker, 'Hunspell unused on macOS');
    assertContains(blocker, 'detection observed, suggestions not proven');
    assertContains(blocker, 'Listing ≠ detection ≠ suggestions');
  });

  test('overlay never silently auto-corrects (no replace except user action)', () => {
    const plugin = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'components/composer-editor/spell-plugins.tsx'),
      'utf8'
    );
    assertContains(plugin, 'no auto-correct');
    assertContains(plugin, 'not a Hebrew dictionary');
    assertContains(plugin, 'findFixtureTypos');
    assertContains(plugin, 'FIXTURE_TYPOS');
    assertContains(plugin, 'typoSuggestions');
    assertContains(plugin, 'applySpellReplacement');
    assertContains(plugin, 'onClick');
    assertContains(plugin, "e.key === 'Enter'");
    assertContains(plugin, 'data-spell-action="replace"');
    assertContains(plugin, 'refreshSpellDecorations');
    assertContains(plugin, 'if (!peekOfflineSpellStatus().available)');
    assertContains(plugin, 'createPortal');
    assertContains(plugin, 'setSpellPopoverHost');
    assertContains(plugin, 'הוסף למילון האישי');
    assertContains(plugin, 'הסר מהמילון האישי');
    assertContains(plugin, 'הצעות איות');
    assertFalse(/setTimeout\([^)]*replace/.test(plugin));
  });

  test('AX/keyboard replacement uses stored range after the caret leaves the typo', () => {
    const editor = new Editor({ value: createDemoComposerValue() });
    const range = spellRangeForWord(editor, DEMO_EN_MISS_WORD);
    assertTrue(!!range, 'expected misspelledd in the fixture value');
    rememberSpellRange(range);
    editor.moveToStartOfDocument();
    const ok = applySpellReplacement(editor, DEMO_EN_CORRECT_WORD, range);
    assertTrue(ok);
    const texts: string[] = [];
    editor.value.document.getTexts().forEach((t) => texts.push(t.text));
    const text = texts.join('\n');
    assertTrue(text.includes(DEMO_EN_CORRECT_WORD));
    assertFalse(text.includes(DEMO_EN_MISS_WORD));
    assertTrue(text.includes(DEMO_HE_MISS_WORD));
  });

  test('authored fixture replacements survive refresh, dict add/remove, and reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-spell-fixture-sugg-'));
    const dict = new PersonalDictionary(personalDictionaryPath(dir));
    installPersonalDictionary(dict);
    const suggestionsOf = (editor: Editor, word: string): string[] | null => {
      const decorations = (editor.value as any).get('decorations');
      let found: string[] | null = null;
      if (decorations) {
        decorations.forEach((d: any) => {
          if (d.mark && d.mark.type === SPELL_ERROR_MARK && d.mark.data.get('word') === word) {
            found = d.mark.data.get('suggestions') || [];
          }
        });
      }
      return found;
    };
    try {
      let editor = new Editor({ value: createDemoComposerValue() });
      refreshSpellDecorations(editor);
      assertTrue((suggestionsOf(editor, DEMO_EN_MISS_WORD) || []).includes(DEMO_EN_CORRECT_WORD));
      assertTrue((suggestionsOf(editor, DEMO_HE_MISS_WORD) || []).includes(DEMO_HE_CORRECT_WORD));
      dict.add(DEMO_EN_MISS_WORD);
      refreshSpellDecorations(editor);
      assertEqual(suggestionsOf(editor, DEMO_EN_MISS_WORD), null);
      assertTrue((suggestionsOf(editor, DEMO_HE_MISS_WORD) || []).includes(DEMO_HE_CORRECT_WORD));
      dict.remove(DEMO_EN_MISS_WORD);
      refreshSpellDecorations(editor);
      assertTrue((suggestionsOf(editor, DEMO_EN_MISS_WORD) || []).includes(DEMO_EN_CORRECT_WORD));
      editor = new Editor({ value: createDemoComposerValue() });
      refreshSpellDecorations(editor);
      assertTrue((suggestionsOf(editor, DEMO_EN_MISS_WORD) || []).includes(DEMO_EN_CORRECT_WORD));
      assertTrue((suggestionsOf(editor, DEMO_HE_MISS_WORD) || []).includes(DEMO_HE_CORRECT_WORD));
    } finally {
      installPersonalDictionary(null);
    }
  });

  test('dictionary remove immediately restores only the overlay for that word', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-spell-deco-'));
    const dict = new PersonalDictionary(personalDictionaryPath(dir));
    installPersonalDictionary(dict);
    try {
      const editor = new Editor({ value: createDemoComposerValue() });
      refreshSpellDecorations(editor);
      const wordsOf = () => {
        const decorations = (editor.value as any).get('decorations');
        const words: string[] = [];
        if (decorations) {
          decorations.forEach((d: any) => {
            if (d.mark && d.mark.type === SPELL_ERROR_MARK) {
              words.push(d.mark.data.get('word'));
            }
          });
        }
        return words;
      };
      assertTrue(wordsOf().includes(DEMO_EN_MISS_WORD));
      assertTrue(wordsOf().includes(DEMO_HE_MISS_WORD));
      dict.add(DEMO_EN_MISS_WORD);
      refreshSpellDecorations(editor);
      assertFalse(wordsOf().includes(DEMO_EN_MISS_WORD));
      assertTrue(wordsOf().includes(DEMO_HE_MISS_WORD));
      dict.remove(DEMO_EN_MISS_WORD);
      refreshSpellDecorations(editor);
      assertTrue(wordsOf().includes(DEMO_EN_MISS_WORD));
      assertTrue(wordsOf().includes(DEMO_HE_MISS_WORD));
    } finally {
      installPersonalDictionary(null);
    }
  });

  test('production spellchecker does not write OS dict in demo', () => {
    const src = fs.readFileSync(path.join(APP_SRC_ROOT, 'spellchecker.ts'), 'utf8');
    assertContains(src, 'if (isDemoMode())');
    assertContains(src, 'ensurePersonalDictionary');
    assertContains(src, 'languagesToEnable');
    assertContains(src, 'enableNativeSpellSession');
    const weh = fs.readFileSync(path.join(APP_SRC_ROOT, 'window-event-handler.ts'), 'utf8');
    assertContains(weh, 'isDemoMode()');
    assertContains(weh, 'ensurePersonalDictionary');
  });

  test('production conversion plugins do not include the fixture overlay', () => {
    const conv = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'components/composer-editor/conversion.tsx'),
      'utf8'
    );
    assertFalse(conv.includes('SpellPlugins'));
    const editor = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'components/composer-editor/composer-editor.tsx'),
      'utf8'
    );
    assertContains(editor, 'extraPlugins');
    assertContains(editor, 'nativeSpellCheck');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
