#!/usr/bin/env npx ts-node
/**
 * Per-paragraph RTL/LTR on the real Slate Value / Editor model.
 * Not DOMParser, not app-wide dir, not source-string-only.
 *
 * UNRUN in cloud. Parent must execute locally on Mac.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-composer-direction.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-composer-direction.ts"
 */
import * as fs from 'fs';
import * as path from 'path';
import { Editor, Value } from 'slate';
import {
  deserializeBlockData,
  focusedParagraphDirection,
  getBlockDirection,
  htmlDirForBlock,
  htmlLangForBlock,
  paragraphSnapshots,
  parseDirAttribute,
  setCurrentParagraphDirection,
} from '../../src/components/composer-editor/paragraph-direction';
import {
  createDemoComposerValue,
  DEMO_EN_LTR,
  DEMO_HE_RTL,
  DEMO_MIXED,
} from '../../src/components/composer-editor/demo-composer-fixtures';

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

function editorAtParagraph(value: Value, index: number): Editor {
  const editor = new Editor({ value });
  const block: any = editor.value.document.nodes.get(index);
  editor.moveToRangeOfNode(block);
  return editor;
}

function run() {
  console.log('\n=== Composer paragraph direction (Slate Value/Editor) ===\n');

  test('fixture value has independent rtl then ltr paragraphs', () => {
    const snaps = paragraphSnapshots(createDemoComposerValue());
    assertEqual(snaps[0].dir, 'rtl');
    assertEqual(snaps[0].text, DEMO_HE_RTL);
    assertEqual(snaps[1].dir, 'ltr');
    assertEqual(snaps[1].text, DEMO_EN_LTR);
    assertEqual(snaps[4].text, DEMO_MIXED);
  });

  test('htmlDirForBlock honors explicit ltr on Hebrew (explicit wins auto)', () => {
    const node: any = {
      object: 'block',
      data: { dir: 'ltr' },
      isLeafBlock: () => true,
      getTextDirection: () => 'rtl',
      text: DEMO_HE_RTL,
    };
    assertEqual(htmlDirForBlock(node), 'ltr');
  });

  test('htmlDirForBlock auto uses getTextDirection rtl', () => {
    const node: any = {
      object: 'block',
      data: {},
      isLeafBlock: () => true,
      getTextDirection: () => 'rtl',
    };
    assertEqual(htmlDirForBlock(node), 'rtl');
  });

  test('parseDirAttribute rejects junk', () => {
    assertEqual(parseDirAttribute('rtl'), 'rtl');
    assertEqual(parseDirAttribute('ltr'), 'ltr');
    assertEqual(parseDirAttribute('auto'), undefined);
    assertEqual(parseDirAttribute('yes'), undefined);
  });

  test('deserializeBlockData round-trips dir and className', () => {
    const data = deserializeBlockData({
      getAttribute: (name: string) => (name === 'dir' ? 'rtl' : name === 'class' ? 'x' : null),
    });
    assertEqual(data && data.dir, 'rtl');
    assertEqual(data && data.className, 'x');
  });

  test('setCurrentParagraphDirection changes only the focused block', () => {
    const editor = editorAtParagraph(createDemoComposerValue(), 0);
    const before = paragraphSnapshots(editor.value);
    setCurrentParagraphDirection(editor, 'ltr');
    const after = paragraphSnapshots(editor.value);
    assertEqual(after[0].dir, 'ltr');
    assertEqual(after[1].dir, before[1].dir);
    assertEqual(after[1].text, before[1].text);
    assertEqual(after[2].dir, before[2].dir);
    assertEqual(after[0].text, before[0].text);
  });

  test('neighboring English LTR is unchanged when Hebrew paragraph is set RTL', () => {
    const editor = editorAtParagraph(createDemoComposerValue(), 1);
    setCurrentParagraphDirection(editor, 'rtl');
    const after = paragraphSnapshots(editor.value);
    assertEqual(after[1].dir, 'rtl');
    assertEqual(after[0].dir, 'rtl');
    assertEqual(after[0].text, DEMO_HE_RTL);
    assertEqual(after[1].text, DEMO_EN_LTR);
  });

  test('auto clears explicit dir on focus block only', () => {
    const editor = editorAtParagraph(createDemoComposerValue(), 0);
    setCurrentParagraphDirection(editor, 'auto');
    const after = paragraphSnapshots(editor.value);
    assertEqual(after[0].dir, 'auto');
    assertEqual(after[1].dir, 'ltr');
  });

  test('selection is restored after direction change', () => {
    const editor = editorAtParagraph(createDemoComposerValue(), 1);
    const keyBefore = editor.value.selection.anchor.key;
    setCurrentParagraphDirection(editor, 'rtl');
    assertEqual(editor.value.selection.anchor.key, keyBefore);
    assertEqual(focusedParagraphDirection(editor.value), 'rtl');
  });

  test('mixed numbers and punctuation stay in the paragraph text', () => {
    const editor = editorAtParagraph(createDemoComposerValue(), 4);
    setCurrentParagraphDirection(editor, 'rtl');
    const snaps = paragraphSnapshots(editor.value);
    assertContains(snaps[4].text, '12345');
    assertContains(snaps[4].text, 'חשבונית');
    assertContains(snaps[4].text, 'Invoice');
    assertEqual(snaps[4].dir, 'rtl');
  });

  test('getBlockDirection reads Immutable data on real Value nodes', () => {
    const value = createDemoComposerValue();
    const first: any = value.document.nodes.get(0);
    const second: any = value.document.nodes.get(1);
    assertEqual(getBlockDirection(first), 'rtl');
    assertEqual(getBlockDirection(second), 'ltr');
    assertEqual(htmlDirForBlock(first), 'rtl');
    assertEqual(htmlDirForBlock(second), 'ltr');
  });

  test('htmlLangForBlock is he/en for homogeneous paragraphs and omitted when mixed', () => {
    const value = createDemoComposerValue();
    const he: any = value.document.nodes.get(0);
    const en: any = value.document.nodes.get(1);
    const mixed: any = value.document.nodes.get(4);
    assertEqual(htmlLangForBlock(he), 'he');
    assertEqual(htmlLangForBlock(en), 'en');
    assertEqual(htmlLangForBlock(mixed), undefined);
    const src = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'components/composer-editor/base-block-plugins.tsx'),
      'utf8'
    );
    assertContains(src, 'htmlLangForBlock');
  });

  test('live + HTML render and toolbar AX names are wired on the real editor', () => {
    const src = fs.readFileSync(
      path.join(APP_SRC_ROOT, 'components/composer-editor/base-block-plugins.tsx'),
      'utf8'
    );
    assertContains(src, 'htmlDirForBlock');
    assertContains(src, 'deserializeBlockData');
    assertContains(src, 'setCurrentParagraphDirection');
    assertContains(src, 'פסקה מימין לשמאל (RTL)');
    assertContains(src, 'פסקה משמאל לימין (LTR)');
    assertContains(src, 'כיוון פסקה אוטומטי');
    assertContains(src, 'aria-label="כיוון פסקה"');
    assertContains(src, 'data-paragraph-dir');
  });

  test('composer.less isolates paragraph bidi rather than flipping the app', () => {
    const less = fs.readFileSync(path.join(__dirname, '../composer/styles/composer.less'), 'utf8');
    assertContains(less, "[dir='rtl']");
    assertContains(less, 'unicode-bidi: isolate');
    assertContains(less, 'paragraph-dir-controls');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
