import React from 'react';
import ReactDOM from 'react-dom';
import { Decoration, Editor, Mark, Point, Value } from 'slate';
import { ComposerEditorPlugin, ComposerEditorPluginTopLevelComponentProps } from './types';
import { findFixtureTypos } from '../../spellcheck/spell-core';
import {
  findOfflineTypos,
  loadOfflineSpellEngine,
  offlineSuggest,
  peekOfflineSpellStatus,
  OfflineTypo,
} from '../../spellcheck/nspell-engine';
import {
  PersonalDictionary,
  getActivePersonalDictionary,
  installPersonalDictionary,
} from '../../spellcheck/personal-dictionary';

export const SPELL_ERROR_MARK = 'spell-error';

let spellPopoverHost: HTMLElement | null = null;

/** Demo composer overlay host. Production composer leaves this null. */
export function setSpellPopoverHost(el: HTMLElement | null) {
  spellPopoverHost = el;
}

export function setSpellPersonalDictionary(dict: PersonalDictionary | null) {
  installPersonalDictionary(dict);
}

export function getSpellPersonalDictionary(): PersonalDictionary | null {
  return getActivePersonalDictionary();
}

export interface SpellRange {
  key: string;
  start: number;
  end: number;
  word: string;
}

/** Last overlay target. AX/keyboard replace must not depend on the live caret. */
let stickyRange: SpellRange | null = null;
let decoGen = 0;
const hunspellHitCache = new Map<string, OfflineTypo[]>();

export function rememberSpellRange(range: SpellRange | null) {
  stickyRange = range;
}

export function getStickySpellRange(): SpellRange | null {
  return stickyRange;
}

export function spellRangeForWord(editor: Editor, word: string): SpellRange | null {
  let found: SpellRange | null = null;
  editor.value.document.getTexts().forEach((textNode) => {
    if (found || !textNode) return;
    const idx = textNode.text.indexOf(word);
    if (idx >= 0) {
      found = { key: textNode.key, start: idx, end: idx + word.length, word };
    }
  });
  return found;
}

function rangeAtSelection(value: Value): SpellRange | null {
  const decorations = (value as any).get('decorations');
  if (!decorations || !value.selection || !value.selection.anchor) return null;
  let found: SpellRange | null = null;
  decorations.forEach((d: any) => {
    if (found) return;
    if (!d.mark || d.mark.type !== SPELL_ERROR_MARK) return;
    if (d.anchor.key !== value.selection.anchor.key) return;
    const start = Math.min(d.anchor.offset, d.focus.offset);
    const end = Math.max(d.anchor.offset, d.focus.offset);
    if (value.selection.anchor.offset >= start && value.selection.anchor.offset <= end) {
      found = {
        key: d.anchor.key,
        start,
        end,
        word: d.mark.data.get('word'),
      };
    }
  });
  return found;
}

function collectNonSpellDecorations(editor: Editor): Decoration[] {
  const decorations: Decoration[] = [];
  const existing = (editor.value as any).get('decorations');
  if (existing && existing.filter) {
    existing.forEach((d: any) => {
      if (d.mark && d.mark.type !== SPELL_ERROR_MARK) {
        decorations.push(d);
      }
    });
  }
  return decorations;
}

function pushTypoDecoration(decorations: Decoration[], textNode: any, miss: any, backend: string) {
  decorations.push(
    Decoration.create({
      anchor: Point.create({ key: textNode.key, offset: miss.start }),
      focus: Point.create({ key: textNode.key, offset: miss.end }),
      mark: Mark.create({
        type: SPELL_ERROR_MARK,
        data: {
          word: miss.word,
          script: miss.script,
          backend,
          suggestions: miss.suggestions || [],
        },
      }),
    })
  );
}

function applyCachedSpellDecorations(editor: Editor) {
  if (!editor || !editor.value) return;
  const personal = getActivePersonalDictionary();
  const decorations = collectNonSpellDecorations(editor);
  const personalList = personal ? personal.list() : [];
  const liveTexts = new Set<string>();
  editor.value.document.getTexts().forEach((textNode) => {
    liveTexts.add(textNode.text);
    for (const miss of findFixtureTypos(textNode.text, personalList)) {
      pushTypoDecoration(decorations, textNode, miss, 'fixture');
    }
    const cached = hunspellHitCache.get(textNode.text) || [];
    for (const miss of cached) {
      pushTypoDecoration(decorations, textNode, miss, 'hunspell');
    }
  });
  for (const key of Array.from(hunspellHitCache.keys())) {
    if (!liveTexts.has(key)) {
      hunspellHitCache.delete(key);
    }
  }
  editor.withoutSaving(() => {
    (editor as any).setDecorations(decorations);
  });
}

async function scanHunspellDecorations(editor: Editor, gen: number) {
  const personal = getActivePersonalDictionary();
  const personalList = personal ? personal.list() : [];
  if (!peekOfflineSpellStatus().available) return;
  if (gen !== decoGen) return;
  const texts: { key: string; text: string }[] = [];
  editor.value.document.getTexts().forEach((textNode) => {
    texts.push({ key: textNode.key, text: textNode.text });
  });
  for (const row of texts) {
    const hits = await findOfflineTypos(row.text, personalList, {
      includeSuggestions: false,
    });
    if (gen !== decoGen) return;
    hunspellHitCache.set(row.text, hits);
  }
  applyCachedSpellDecorations(editor);
}

/**
 * Fixtures apply immediately. Do not start Hunspell from this path — a live
 * child would keep Node from exiting (native cf9ca4f composer-spell 20/0 then
 * 35s SIGTERM). Demo/engine tests call loadOfflineSpellEngine first.
 */
export function refreshSpellDecorations(editor: Editor) {
  if (!editor || !editor.value) return;
  applyCachedSpellDecorations(editor);
  if (!peekOfflineSpellStatus().available) return;
  const gen = ++decoGen;
  void scanHunspellDecorations(editor, gen).catch(() => {
    // Timeout/error is visible via peekOfflineSpellStatus().phase — do not hang UI.
  });
}

export async function refreshSpellDecorationsAsync(editor: Editor) {
  if (!editor || !editor.value) return;
  applyCachedSpellDecorations(editor);
  await loadOfflineSpellEngine();
  const gen = ++decoGen;
  await scanHunspellDecorations(editor, gen);
}

/**
 * Replace using a stored range so AX Press / Space / Enter still work after
 * the editor blurs. Mouse mousedown is also wired; do not rely on it alone.
 */
export function applySpellReplacement(
  editor: Editor,
  replacement: string,
  range: SpellRange | null = stickyRange
) {
  if (!editor || !replacement || !range) return false;
  const textNode = editor.value.document.getNode(range.key) as any;
  if (!textNode || typeof textNode.text !== 'string') return false;
  const slice = textNode.text.slice(range.start, range.end);
  if (slice !== range.word) return false;
  stickyRange = null;
  editor
    .moveAnchorTo(range.key, range.start)
    .moveFocusTo(range.key, range.end)
    .focus()
    .insertText(replacement);
  return true;
}

function applyReplacement(editor: Editor, replacement: string) {
  applySpellReplacement(editor, replacement, stickyRange || rangeAtSelection(editor.value));
}

function renderMark({ mark, children }: any, _ed?: Editor, next?: () => any) {
  if (mark.type !== SPELL_ERROR_MARK) {
    return next ? next() : undefined;
  }
  const script = mark.data.get('script');
  const lang = script === 'he' ? 'he' : script === 'en' ? 'en' : undefined;
  return (
    <span
      className="spell-error"
      data-spell-error="true"
      data-spell-backend={mark.data.get('backend') || 'fixture'}
      title={mark.data.get('word')}
      lang={lang}
      spellCheck={false}
    >
      {children}
    </span>
  );
}

function activateReplace(e: React.SyntheticEvent, editor: Editor, replacement: string) {
  e.preventDefault();
  e.stopPropagation();
  applyReplacement(editor, replacement);
}

function SpellSuggestionPopover({ editor, value }: ComposerEditorPluginTopLevelComponentProps) {
  const fromCaret =
    value.selection && value.selection.isFocused && value.selection.isCollapsed
      ? rangeAtSelection(value)
      : null;

  if (fromCaret) {
    stickyRange = fromCaret;
  } else if (value.selection && value.selection.isFocused) {
    stickyRange = null;
  }

  const target = stickyRange;
  const decorations = (value as any).get('decorations');
  let mark: any = null;
  if (target && decorations) {
    decorations.forEach((d: any) => {
      if (mark) return;
      if (!d.mark || d.mark.type !== SPELL_ERROR_MARK) return;
      if (d.anchor.key !== target.key) return;
      const start = Math.min(d.anchor.offset, d.focus.offset);
      const end = Math.max(d.anchor.offset, d.focus.offset);
      if (start === target.start && end === target.end) {
        mark = d.mark;
      }
    });
  }

  const word = mark ? mark.data.get('word') : '';
  const script = mark ? mark.data.get('script') : 'en';
  const backend = mark ? mark.data.get('backend') || 'fixture' : 'fixture';
  const markSuggestions: string[] = mark ? mark.data.get('suggestions') || [] : [];

  const [liveSuggestions, setLiveSuggestions] = React.useState<string[]>(markSuggestions);
  const [suggestState, setSuggestState] = React.useState<
    'idle' | 'loading' | 'ready' | 'timeout' | 'error'
  >(backend === 'hunspell' ? 'loading' : 'ready');

  React.useEffect(() => {
    if (!mark) {
      setLiveSuggestions([]);
      setSuggestState('idle');
      return;
    }
    if (backend !== 'hunspell') {
      setLiveSuggestions(markSuggestions);
      setSuggestState('ready');
      return;
    }
    let cancelled = false;
    setSuggestState('loading');
    setLiveSuggestions([]);
    offlineSuggest(word, script === 'he' ? 'he' : 'en')
      .then((s) => {
        if (!cancelled) {
          setLiveSuggestions(s);
          setSuggestState('ready');
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setSuggestState(err && err.timedOut ? 'timeout' : 'error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [word, backend, script]);

  if (!target || !mark) return null;

  const suggestions = backend === 'hunspell' ? liveSuggestions : markSuggestions;
  const personal = getActivePersonalDictionary();
  const inDict = personal ? personal.has(word) : false;
  const caption =
    backend === 'hunspell'
      ? 'Hunspell WASM local prototype · no auto-correct'
      : 'UI-test overlay · not a Hebrew dictionary · no auto-correct';
  const emptyLabel =
    suggestState === 'loading'
      ? 'טוען הצעות…'
      : suggestState === 'timeout'
        ? 'ההצעות חרגו מהזמן'
        : suggestState === 'error'
          ? 'שגיאה בטעינת הצעות'
          : 'אין הצעות';

  const popover = (
    <div
      className="spell-suggestion-popover"
      role="region"
      aria-label="הצעות איות"
      data-spell-backend={backend}
      data-spell-suggest-state={backend === 'hunspell' ? suggestState : 'ready'}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) {
          e.preventDefault();
        }
      }}
    >
      <div className="spell-word">
        {word} <small>({caption})</small>
      </div>
      {suggestions.length === 0 ? (
        <div className="spell-empty">{emptyLabel}</div>
      ) : (
        suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="spell-suggestion"
            data-spell-action="replace"
            aria-label={`החלף ב-${s}`}
            onMouseDown={(e) => activateReplace(e, editor, s)}
            onClick={(e) => activateReplace(e, editor, s)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                activateReplace(e, editor, s);
              }
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
          refreshSpellDecorations(editor);
        }}
        onClick={(e) => {
          e.preventDefault();
          personal?.add(word);
          refreshSpellDecorations(editor);
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
            refreshSpellDecorations(editor);
          }}
          onClick={(e) => {
            e.preventDefault();
            personal?.remove(word);
            refreshSpellDecorations(editor);
          }}
        >
          הסר מהמילון האישי
        </button>
      )}
    </div>
  );
  if (spellPopoverHost && spellPopoverHost.isConnected) {
    return ReactDOM.createPortal(popover, spellPopoverHost);
  }
  return popover;
}

const plugins: ComposerEditorPlugin[] = [
  {
    renderMark,
    topLevelComponent: SpellSuggestionPopover,
    onChange: (editor, next) => {
      const result = next();
      try {
        refreshSpellDecorations(editor);
      } catch {
        // Editor not ready
      }
      return result;
    },
  },
];

export default plugins;
