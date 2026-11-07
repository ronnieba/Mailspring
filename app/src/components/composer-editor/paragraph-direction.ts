import { Map as ImmutableMap } from 'immutable';
import { Editor, Block, Value } from 'slate';

export type ParagraphDir = 'rtl' | 'ltr' | 'auto';

function dataGet(block: Block, key: string): unknown {
  const data: any = block && (block as any).data;
  if (!data) return undefined;
  if (typeof data.get === 'function') return data.get(key);
  return data[key];
}

export function getBlockDirection(block: Block | null | undefined): ParagraphDir {
  if (!block || (block as any).object !== 'block') {
    return 'auto';
  }
  const d = dataGet(block, 'dir');
  if (d === 'rtl' || d === 'ltr') {
    return d;
  }
  return 'auto';
}

/**
 * lang for native NSSpellChecker / Chromium. Homogeneous Hebrew → he,
 * homogeneous English → en, mixed → omitted so the OS can auto-detect.
 * Not a claim that native Hebrew underlines work; parent still verifies.
 */
export function htmlLangForBlock(node: Block): 'he' | 'en' | undefined {
  const text = node && typeof (node as any).text === 'string' ? (node as any).text : '';
  let he = 0;
  let en = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0590 && c <= 0x05ff) he += 1;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) en += 1;
  }
  if (he > 0 && en === 0) return 'he';
  if (en > 0 && he === 0) return 'en';
  return undefined;
}

/** Explicit dir wins. Auto uses Slate's first strong directional character. */
export function htmlDirForBlock(node: Block): 'rtl' | 'ltr' | undefined {
  const explicit = getBlockDirection(node);
  if (explicit === 'rtl' || explicit === 'ltr') {
    return explicit;
  }
  if (typeof (node as any).isLeafBlock === 'function' && (node as any).isLeafBlock()) {
    if (typeof (node as any).getTextDirection === 'function' && node.getTextDirection() === 'rtl') {
      return 'rtl';
    }
  }
  return undefined;
}

export function parseDirAttribute(attr: string | null | undefined): 'rtl' | 'ltr' | undefined {
  if (attr === 'rtl' || attr === 'ltr') {
    return attr;
  }
  return undefined;
}

export function deserializeBlockData(el: { getAttribute: (name: string) => string | null }) {
  const className = el.getAttribute('class');
  const dir = parseDirAttribute(el.getAttribute('dir'));
  if (!className && !dir) {
    return undefined;
  }
  const data: { className?: string; dir?: 'rtl' | 'ltr' } = {};
  if (className) data.className = className;
  if (dir) data.dir = dir;
  return data;
}

/**
 * Set dir on the focus block only so neighboring paragraphs stay independent.
 * Restores the current selection.
 */
export function setCurrentParagraphDirection(editor: Editor, dir: ParagraphDir): Editor {
  const block = editor.value.focusBlock;
  if (!block) {
    return editor;
  }
  const selection = editor.value.selection;
  const data = (block as any).data;
  const map = data && typeof data.set === 'function' ? data : ImmutableMap(data || {});
  const next = dir === 'auto' ? map.delete('dir') : map.set('dir', dir);
  editor.setNodeByKey(block.key, { data: next } as any);
  if (selection && selection.anchor && selection.anchor.key) {
    editor.select(selection);
  }
  return editor;
}

export function focusedParagraphDirection(value: Value): ParagraphDir {
  return getBlockDirection(value.focusBlock);
}

export interface ParagraphSnapshot {
  dir: ParagraphDir;
  text: string;
  htmlDir?: 'rtl' | 'ltr';
}

export function paragraphSnapshots(value: Value): ParagraphSnapshot[] {
  const nodes: any = value.document.nodes;
  const list = typeof nodes.toArray === 'function' ? nodes.toArray() : nodes;
  return (list as Block[])
    .filter((n) => n && (n as any).object === 'block')
    .map((block) => ({
      dir: getBlockDirection(block),
      text: block.text,
      htmlDir: htmlDirForBlock(block),
    }));
}
