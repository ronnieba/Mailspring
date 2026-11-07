#!/usr/bin/env npx ts-node
/**
 * Accountless DEMO composer surface: same ComposerEditor, no send/save,
 * serialize/reopen of per-paragraph dir, demo-profile dictionary only.
 *
 * UNRUN in cloud. Parent must execute locally on Mac.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-demo-composer.ts
 *
 * Alternate cwd:
 *   npx --prefix "$REPO" ts-node --project "$REPO/app/tsconfig.json" \
 *     "$REPO/app/internal_packages/ai-sidebar/test-demo-composer.ts"
 */
import * as fs from 'fs';
import * as path from 'path';
import { Editor } from 'slate';
import {
  createDemoComposerValue,
  DEMO_COMPOSER_PARAGRAPHS,
  DEMO_EN_LTR,
  DEMO_HE_RTL,
} from '../../src/components/composer-editor/demo-composer-fixtures';
import {
  deserializeBlockData,
  paragraphSnapshots,
  setCurrentParagraphDirection,
} from '../../src/components/composer-editor/paragraph-direction';

const APP_SRC_ROOT = path.resolve(__dirname, '../../src');
const PKG_ROOT = __dirname;

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
  console.log('\n=== DEMO composer surface (same editor, no send) ===\n');

  const demoTsx = fs.readFileSync(path.join(PKG_ROOT, 'lib/demo-composer.tsx'), 'utf8');
  const sidebarTsx = fs.readFileSync(path.join(PKG_ROOT, 'lib/ai-sidebar.tsx'), 'utf8');
  const editorTsx = fs.readFileSync(
    path.join(APP_SRC_ROOT, 'components/composer-editor/composer-editor.tsx'),
    'utf8'
  );

  test('demo composer imports the real ComposerEditor, not a lookalike', () => {
    assertContains(demoTsx, "from 'mailspring-component-kit'");
    assertContains(demoTsx, 'ComposerEditor');
    assertContains(demoTsx, '<ComposerEditor');
    assertContains(demoTsx, 'createDemoComposerValue');
    assertFalse(demoTsx.includes('contentEditable'));
    assertFalse(demoTsx.includes('textarea'));
  });

  test('demo composer has no send, DraftStore, or production save', () => {
    assertFalse(demoTsx.includes('SendActionButton'));
    assertFalse(demoTsx.includes('DraftStore'));
    assertFalse(demoTsx.includes('Actions.sendDraft'));
    assertFalse(demoTsx.includes('queueTask'));
    assertContains(demoTsx, 'אין שליחה');
    assertContains(demoTsx, 'אין שמירת טיוטה');
  });

  test('native Chromium spellcheck stays on; overlay is extraPlugins only', () => {
    assertContains(demoTsx, 'nativeSpellCheck={true}');
    assertContains(demoTsx, 'enableNativeSpellSession');
    assertContains(demoTsx, 'data-hebrew-runtime="pending"');
    assertContains(demoTsx, 'data-hebrew-bundled="not-shipped"');
    assertContains(demoTsx, 'data-hebrew-native=');
    assertFalse(demoTsx.includes('data-hebrew-general="blocked"'));
    assertContains(demoTsx, 'formatBackendStatusText');
    assertContains(demoTsx, 'extraPlugins={SpellPlugins}');
    assertContains(editorTsx, 'extraPlugins');
  });

  test('personal dictionary is created from AppEnv config dir (demo profile)', () => {
    assertContains(demoTsx, 'ensurePersonalDictionary(AppEnv.getConfigDirPath())');
    assertContains(demoTsx, 'aria-label="מילון אישי"');
    assertContains(demoTsx, 'הסר מהמילון האישי');
    assertContains(demoTsx, 'refreshSpellDecorations');
    assertContains(demoTsx, 'onUpdatedSlateEditor');
    assertContains(demoTsx, '_removeDictWord');
    assertContains(demoTsx, '_refreshOverlay');
  });

  test('accessible names for tab, serialize, reload, backend, composer region', () => {
    assertContains(sidebarTsx, 'aria-label="עורך DEMO"');
    assertContains(sidebarTsx, 'aria-label="עוזר AI"');
    assertContains(sidebarTsx, "demoTab: 'ai'");
    assertContains(demoTsx, 'aria-label="DEMO composer (synthetic)"');
    assertContains(demoTsx, 'aria-label="סריאליזציה ופתיחה מחדש"');
    assertContains(demoTsx, 'aria-label="טען טיוטת DEMO מחדש"');
    assertContains(demoTsx, 'aria-label="מצב בודק איות"');
  });

  test('serialize uses real convertToHTML/convertFromHTML then restore', () => {
    assertContains(demoTsx, 'convertToHTML(this.state.value)');
    assertContains(demoTsx, 'convertFromHTML(html)');
    assertContains(demoTsx, 'ComposerSupport.Conversion');
  });

  test('demo tab default stays AI so capture/sidebar ready is unchanged', () => {
    assertContains(sidebarTsx, "demoTab: 'ai'");
    assertContains(sidebarTsx, 'data-demo-ready');
    assertContains(sidebarTsx, '!composerTab && this._renderScopeSelector()');
  });

  test('in-memory serialize/reopen of dir attributes via deserializeBlockData', () => {
    const editor = new Editor({ value: createDemoComposerValue() });
    const first: any = editor.value.document.nodes.get(0);
    editor.moveToRangeOfNode(first);
    setCurrentParagraphDirection(editor, 'ltr');
    const snaps = paragraphSnapshots(editor.value);
    const fakeEl = (dir: string, text: string) => ({
      getAttribute: (name: string) => (name === 'dir' ? dir : null),
      text,
    });
    const roundtrip = snaps.map((s) => {
      const attr = s.dir === 'auto' ? null : s.dir;
      return deserializeBlockData({
        getAttribute: (name: string) => (name === 'dir' ? attr : null),
      });
    });
    assertEqual(roundtrip[0] && roundtrip[0].dir, 'ltr');
    assertEqual(roundtrip[1] && roundtrip[1].dir, 'ltr');
    assertEqual(snaps[0].text, DEMO_HE_RTL);
    assertEqual(snaps[1].text, DEMO_EN_LTR);
    assertTrue(!!fakeEl);
  });

  test('fixture paragraphs remain independently directed after editor mutation', () => {
    assertEqual(DEMO_COMPOSER_PARAGRAPHS[0].dir, 'rtl');
    assertEqual(DEMO_COMPOSER_PARAGRAPHS[1].dir, 'ltr');
    const editor = new Editor({ value: createDemoComposerValue() });
    const second: any = editor.value.document.nodes.get(1);
    editor.moveToRangeOfNode(second);
    setCurrentParagraphDirection(editor, 'rtl');
    const snaps = paragraphSnapshots(editor.value);
    assertEqual(snaps[0].dir, 'rtl');
    assertEqual(snaps[1].dir, 'rtl');
    assertEqual(snaps[2].dir, 'rtl');
    assertEqual(snaps[3].dir, 'ltr');
  });

  test('demo composer is gated on isDemoMode and not registered in production activate', () => {
    const mainTs = fs.readFileSync(path.join(PKG_ROOT, 'lib/main.ts'), 'utf8');
    assertContains(mainTs, 'AISidebar');
    assertFalse(mainTs.includes('DemoComposer'));
    assertContains(sidebarTsx, 'isDemoMode()');
    assertContains(sidebarTsx, '<DemoComposer');
  });

  test('no grammar cloud service and no new network endpoint', () => {
    assertFalse(demoTsx.includes('languagetool'));
    assertFalse(demoTsx.includes('LanguageTool'));
    assertFalse(demoTsx.includes('http.createServer'));
    assertFalse(demoTsx.includes('fetch('));
  });

  test('demo composer layout is scrollable with contrast buttons (sidebar only)', () => {
    const less = fs.readFileSync(path.join(PKG_ROOT, 'styles/ai-sidebar.less'), 'utf8');
    assertContains(less, '.demo-composer');
    assertContains(less, '.demo-composer-workspace');
    assertContains(less, 'overflow-y: auto');
    assertContains(less, 'overflow: hidden');
    assertContains(less, '-webkit-appearance: none');
    assertFalse(less.includes('min-height: 240px'));
    assertContains(demoTsx, 'demo-composer-workspace');
    const editorIdx = demoTsx.indexOf('<ComposerEditor');
    const dictIdx = demoTsx.indexOf('aria-label="מילון אישי"');
    assertTrue(editorIdx >= 0 && dictIdx > editorIdx, 'dictionary must follow the editor in DOM');
    const sidebar = fs.readFileSync(path.join(PKG_ROOT, 'lib/ai-sidebar.tsx'), 'utf8');
    assertContains(sidebar, 'contact cards (maxWidth 300)');
  });

  test('early raw-argv isolation source is unchanged', () => {
    const mainJs = fs.readFileSync(path.join(APP_SRC_ROOT, 'browser/main.js'), 'utf8');
    assertContains(mainJs, 'startupFlagsFromArgv(process.argv)');
    assertContains(mainJs, 'identityFromArgv(process.argv');
    assertContains(mainJs, 'app.setName(identity.appName)');
    assertContains(mainJs, 'parseCommandLine(process.argv)');
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run();
