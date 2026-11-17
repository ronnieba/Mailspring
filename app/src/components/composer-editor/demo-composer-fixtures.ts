import { Value } from 'slate';
import { ParagraphDir } from './paragraph-direction';

/**
 * Synthetic DEMO composer body. Not a real draft. Used by the accountless
 * composer surface and Node tests of per-paragraph direction + spell overlay.
 */
export const DEMO_HE_RTL = 'שלום צוות, מצורפת החשבונית לחודש נובמבר.';
export const DEMO_EN_LTR = 'Hello team, please review the invoice for November.';
export const DEMO_HE_MISS = 'זו שגיאת איותת בפסקה העברית.';
export const DEMO_EN_MISS = 'This is a misspelledd word in English.';
export const DEMO_MIXED = 'Invoice 12345 — חשבונית 12345.';

export const DEMO_HE_MISS_WORD = 'איותת';
export const DEMO_HE_CORRECT_WORD = 'איות';
export const DEMO_EN_MISS_WORD = 'misspelledd';
export const DEMO_EN_CORRECT_WORD = 'misspelled';

export interface DemoComposerParagraph {
  dir: ParagraphDir;
  text: string;
}

export const DEMO_COMPOSER_PARAGRAPHS: DemoComposerParagraph[] = [
  { dir: 'rtl', text: DEMO_HE_RTL },
  { dir: 'ltr', text: DEMO_EN_LTR },
  { dir: 'rtl', text: DEMO_HE_MISS },
  { dir: 'ltr', text: DEMO_EN_MISS },
  { dir: 'ltr', text: DEMO_MIXED },
];

export function demoComposerValueJSON() {
  return {
    object: 'value' as const,
    document: {
      object: 'document' as const,
      nodes: DEMO_COMPOSER_PARAGRAPHS.map((p) => ({
        object: 'block' as const,
        type: 'div',
        data: p.dir === 'auto' ? {} : { dir: p.dir },
        nodes: [
          {
            object: 'text' as const,
            leaves: [{ object: 'leaf' as const, text: p.text, marks: [] }],
          },
        ],
      })),
    },
  };
}

export function createDemoComposerValue(): Value {
  return Value.fromJSON(demoComposerValueJSON() as any);
}
