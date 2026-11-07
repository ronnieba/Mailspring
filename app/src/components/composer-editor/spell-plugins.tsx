import React from 'react';
import { Decoration, Editor, Mark, Point } from 'slate';
import { ComposerEditorPlugin, ComposerEditorPluginTopLevelComponentProps } from './types';
import { findFixtureTypos } from '../../spellcheck/spell-core';
import {
  PersonalDictionary,
  getActivePersonalDictionary,
  installPersonalDictionary,
} from '../../spellcheck/personal-dictionary';

export const SPELL_ERROR_MARK = 'spell-error';

export function setSpellPersonalDictionary(dict: PersonalDictionary | null) {
  installPersonalDictionary(dict);
}

export function getSpellPersonalDictionary(): PersonalDictionary | null {
  return getActivePersonalDictionary();
}

function applySpellDecorations(editor: Editor) {
  const personal = getActivePersonalDictionary();
  const decorations: Decoration[] = [];
  const existing = (editor.value as any).get('decorations');
  if (existing && existing.filter) {
    existing.forEach((d: any) => {
      if (d.mark && d.mark.type !== SPELL_ERROR_MARK) {
        decorations.push(d);
      }
    });
  }

  editor.value.document.getTexts().forEach((textNode) => {
    for (const miss of findFixtureTypos(textNode.text, personal ? personal.list() : [])) {
      decorations.push(
        Decoration.create({
          anchor: Point.create({ key: textNode.key, offset: miss.start }),
          focus: Point.create({ key: textNode.key, offset: miss.end }),
          mark: Mark.create({
            type: SPELL_ERROR_MARK,
            data: {
              word: miss.word,
              script: miss.script,
              suggestions: [miss.suggestion],
            },
          }),
        })
      );
    }
  });

  editor.withoutSaving(() => {
    (editor as any).setDecorations(decorations);
  });
}

function applyReplacement(editor: Editor, replacement: string) {
  const decorations = (editor.value as any).get('decorations');
  if (!decorations) return;
  const { selection } = editor.value;
  if (!selection || !selection.anchor) return;
  let range: any = null;
  decorations.forEach((d: any) => {
    if (!d.mark || d.mark.type !== SPELL_ERROR_MARK) return;
    if (d.anchor.key !== selection.anchor.key) return;
    const start = Math.min(d.anchor.offset, d.focus.offset);
    const end = Math.max(d.anchor.offset, d.focus.offset);
    if (selection.anchor.offset >= start && selection.anchor.offset <= end) {
      range = { start, end, key: d.anchor.key };
    }
  });
  if (!range) return;
  editor
    .moveAnchorTo(range.key, range.start)
    .moveFocusTo(range.key, range.end)
    .insertText(replacement);
}

function renderMark({ mark, children }: any, _ed?: Editor, next?: () => any) {
  if (mark.type !== SPELL_ERROR_MARK) {
    return next ? next() : undefined;
  }
  return (
    <span className="spell-error" data-spell-error="true" title={mark.data.get('word')}>
      {children}
    </span>
  );
}

function SpellSuggestionPopover({ editor, value }: ComposerEditorPluginTopLevelComponentProps) {
  if (!value.selection || !value.selection.isFocused || !value.selection.isCollapsed) {
    return null;
  }
  const decorations = value.get('decorations') as any;
  if (!decorations || !decorations.size) return null;

  let mark: any = null;
  decorations.forEach((d: any) => {
    if (!d.mark || d.mark.type !== SPELL_ERROR_MARK) return;
    if (d.anchor.key !== value.selection.anchor.key) return;
    const start = Math.min(d.anchor.offset, d.focus.offset);
    const end = Math.max(d.anchor.offset, d.focus.offset);
    if (value.selection.anchor.offset >= start && value.selection.anchor.offset <= end) {
      mark = d.mark;
    }
  });
  if (!mark) return null;

  const word = mark.data.get('word');
  const suggestions: string[] = mark.data.get('suggestions') || [];
  const personal = getActivePersonalDictionary();
  const inDict = personal ? personal.has(word) : false;

  return (
    <div className="spell-suggestion-popover" role="region" aria-label="הצעות איות">
      <div className="spell-word">
        {word} <small>(UI-test overlay · not a Hebrew dictionary · no auto-correct)</small>
      </div>
      {suggestions.length === 0 ? (
        <div className="spell-empty">אין הצעות</div>
      ) : (
        suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="spell-suggestion"
            aria-label={`החלף ב-${s}`}
            onMouseDown={(e) => {
              e.preventDefault();
              applyReplacement(editor, s);
            }}
          >
            {s}
          </button>
        ))
      )}
      <button
        type="button"
        className="spell-dict-add"
        aria-label="הוסף למילון האישי"
        onMouseDown={(e) => {
          e.preventDefault();
          personal?.add(word);
          applySpellDecorations(editor);
        }}
      >
        הוסף למילון האישי
      </button>
      {inDict && (
        <button
          type="button"
          className="spell-dict-remove"
          aria-label="הסר מהמילון האישי"
          onMouseDown={(e) => {
            e.preventDefault();
            personal?.remove(word);
            applySpellDecorations(editor);
          }}
        >
          הסר מהמילון האישי
        </button>
      )}
    </div>
  );
}

const plugins: ComposerEditorPlugin[] = [
  {
    renderMark,
    topLevelComponent: SpellSuggestionPopover,
    onChange: (editor, next) => {
      const result = next();
      try {
        applySpellDecorations(editor);
      } catch {
        // Editor not ready
      }
      return result;
    },
  },
];

export default plugins;
