/**
 * Offline experiment: formatted editor for local drafts (contentEditable +
 * formatting toolbar). Saves sanitized HTML through onChange. Local only.
 */
import React from 'react';
import classNames from 'classnames';
import { isSafeHref, sanitizeDraftHtml } from '../core/offline-rich-text';
import { tr } from '../core/offline-i18n';
import { OfflineMic } from './offline-voice';

const MOD = typeof process !== 'undefined' && process.platform === 'darwin' ? '⌘' : 'Ctrl';

const FONTS = [
  'Arial',
  'Calibri',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Courier New',
  'David',
  'Miriam',
  'Narkisim',
];
const SIZES: { v: string; he: string; en: string }[] = [
  { v: '2', he: 'קטן', en: 'Small' },
  { v: '3', he: 'רגיל', en: 'Normal' },
  { v: '5', he: 'גדול', en: 'Large' },
  { v: '6', he: 'ענק', en: 'Huge' },
];
const TEXT_COLORS = [
  '#000000',
  '#5f6368',
  '#c62828',
  '#e65100',
  '#f9a825',
  '#2e7d32',
  '#00838f',
  '#1565c0',
  '#6a1b9a',
  '#ad1457',
];
const HIGHLIGHTS = ['#fff59d', '#c5e1a5', '#b3e5fc', '#f8bbd0', '#ffe0b2', 'transparent'];

const BLOCK_SEL = 'p,div,li,blockquote';

/** Turn what the user typed into a safe link target, or null. */
export function normalizeLinkInput(input: string): string | null {
  let v = (input || '').trim();
  if (!v) {
    return null;
  }
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) {
    v = `mailto:${v}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    v = `https://${v}`;
  }
  return isSafeHref(v) ? v : null;
}

type Props = {
  draftId: string;
  /** Changes when the body was replaced from outside (proofreading applied). */
  rev: number;
  html: string;
  readOnly: boolean;
  placeholder: string;
  onChange: (html: string) => void;
};
type State = {
  palette: 'fore' | 'back' | null;
  linkOpen: boolean;
  linkValue: string;
  linkError: boolean;
  active: { [cmd: string]: boolean };
};

const SHORTCUTS = {
  bold: `${MOD}+B`,
  italic: `${MOD}+I`,
  underline: `${MOD}+U`,
  strike: `${MOD}+Shift+X`,
  link: `${MOD}+K`,
  bullets: `${MOD}+Shift+8`,
  numbers: `${MOD}+Shift+7`,
  left: `${MOD}+Shift+L`,
  center: `${MOD}+Shift+E`,
  right: `${MOD}+Shift+R`,
  dir: `${MOD}+Shift+D`,
  clear: `${MOD}+\\`,
};

function AlignIcon({ kind }: { kind: 'left' | 'center' | 'right' }) {
  const lines = [16, 10, 14, 8];
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      {lines.map((w, i) => {
        const x = kind === 'left' ? 0 : kind === 'right' ? 16 - w : (16 - w) / 2;
        return (
          <rect
            key={i}
            x={x}
            y={i * 3.5 + 0.5}
            width={w}
            height="1.8"
            rx="0.9"
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}

function ListIcon({ numbered }: { numbered: boolean }) {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      {[0, 1, 2].map((i) =>
        numbered ? (
          <text key={`n${i}`} x="0" y={i * 5 + 4.5} fontSize="5" fill="currentColor">
            {i + 1}
          </text>
        ) : (
          <circle key={`c${i}`} cx="1.8" cy={i * 5 + 2} r="1.5" fill="currentColor" />
        )
      )}
      {[0, 1, 2].map((i) => (
        <rect
          key={`l${i}`}
          x="5"
          y={i * 5 + 1.1}
          width="11"
          height="1.8"
          rx="0.9"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

export class OfflineRichEditor extends React.Component<Props, State> {
  static displayName = 'OfflineRichEditor';
  state: State = { palette: null, linkOpen: false, linkValue: '', linkError: false, active: {} };
  private _el = React.createRef<HTMLDivElement>();
  private _range: Range | null = null;

  componentDidMount() {
    this._load();
    document.addEventListener('selectionchange', this._onSelectionChange);
  }

  componentWillUnmount() {
    document.removeEventListener('selectionchange', this._onSelectionChange);
  }

  componentDidUpdate(prev: Props) {
    if (prev.draftId !== this.props.draftId || prev.rev !== this.props.rev) {
      this._load();
    }
  }

  _load() {
    const el = this._el.current;
    if (el) {
      el.innerHTML = sanitizeDraftHtml(this.props.html || '');
      this._range = null;
    }
  }

  /** Start an empty draft with a real paragraph so the first line gets its own direction. */
  _onFocus = () => {
    const el = this._el.current;
    if (!el || this.props.readOnly || el.innerHTML !== '') {
      return;
    }
    el.innerHTML = '<p><br></p>';
    const r = document.createRange();
    r.setStart(el.firstChild as Node, 0);
    r.collapse(true);
    const sel = document.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(r);
    }
  };

  _onBlur = () => {
    const el = this._el.current;
    if (el && el.innerHTML === '<p><br></p>') {
      el.innerHTML = '';
    }
  };

  _emit() {
    const el = this._el.current;
    if (el) {
      this.props.onChange(el.innerHTML);
    }
  }

  _inside(node: Node | null): boolean {
    const el = this._el.current;
    return !!(el && node && (node === el || el.contains(node)));
  }

  _onSelectionChange = () => {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || !this._inside(sel.anchorNode)) {
      return;
    }
    this._range = sel.getRangeAt(0).cloneRange();
    const active: { [cmd: string]: boolean } = {};
    for (const c of [
      'bold',
      'italic',
      'underline',
      'strikeThrough',
      'insertUnorderedList',
      'insertOrderedList',
    ]) {
      try {
        active[c] = document.queryCommandState(c);
      } catch (e) {
        active[c] = false;
      }
    }
    const changed = Object.keys(active).some((k) => !!this.state.active[k] !== active[k]);
    if (changed) {
      this.setState({ active });
    }
  };

  /** Put the caret / selection back in the editor before a command. */
  _restore() {
    const el = this._el.current;
    if (!el) {
      return;
    }
    const sel = document.getSelection();
    if (document.activeElement === el && sel && sel.rangeCount && this._inside(sel.anchorNode)) {
      return; // caret already in the editor
    }
    el.focus();
    if (sel && this._range && this._inside(this._range.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(this._range);
    }
  }

  exec(cmd: string, value?: string) {
    if (this.props.readOnly) {
      return;
    }
    this._restore();
    document.execCommand('defaultParagraphSeparator', false, 'p');
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    this.setState({ palette: null });
    this._emit();
    this._onSelectionChange();
  }

  /** Blocks touched by the selection (wrapping loose text in a paragraph first). */
  _selectedBlocks(): HTMLElement[] {
    const el = this._el.current;
    const sel = document.getSelection();
    if (!el || !sel || !sel.rangeCount) {
      return [];
    }
    const range = sel.getRangeAt(0);
    const closestBlock = (n: Node | null): HTMLElement | null => {
      let cur: Node | null = n;
      while (cur && cur !== el) {
        if (cur.nodeType === 1 && (cur as Element).matches(BLOCK_SEL)) {
          return cur as HTMLElement;
        }
        cur = cur.parentNode;
      }
      return null;
    };
    if (!closestBlock(range.startContainer)) {
      document.execCommand('formatBlock', false, 'p');
    }
    const r = sel.getRangeAt(0);
    const out: HTMLElement[] = [];
    const first = closestBlock(r.startContainer);
    const last = closestBlock(r.endContainer);
    if (first) {
      out.push(first);
    }
    if (first && last && first !== last) {
      for (const b of Array.from(el.querySelectorAll<HTMLElement>(BLOCK_SEL))) {
        if (b !== first && r.intersectsNode(b) && !b.querySelector(BLOCK_SEL)) {
          out.push(b);
        }
      }
    }
    return out;
  }

  /**
   * Bulleted / numbered list. Done by hand: Chromium's insertList nests the
   * list inside the paragraph and moves the caret to the start.
   */
  toggleList(kind: 'ul' | 'ol') {
    if (this.props.readOnly) {
      return;
    }
    this._restore();
    const el = this._el.current;
    const sel = document.getSelection();
    if (!el || !sel || !sel.rangeCount) {
      return;
    }
    const r0 = sel.getRangeAt(0);
    const saved = {
      sc: r0.startContainer,
      so: r0.startOffset,
      ec: r0.endContainer,
      eo: r0.endOffset,
    };
    const blocks = this._selectedBlocks().filter((b) => b.matches('p,div,li'));
    if (!blocks.length) {
      return;
    }
    const copyAttrs = (from: Element, to: Element) => {
      for (const a of ['dir', 'style']) {
        const v = from.getAttribute(a);
        if (v) {
          to.setAttribute(a, v);
        }
      }
    };
    const moveChildren = (from: Element, to: Element) => {
      while (from.firstChild) {
        to.appendChild(from.firstChild);
      }
    };
    const allInKind = blocks.every(
      (b) => b.tagName === 'LI' && b.parentElement && b.parentElement.tagName === kind.toUpperCase()
    );
    if (allInKind) {
      // Turn the chosen items back into paragraphs, splitting the list.
      const list = blocks[0].parentElement as HTMLElement;
      const parent = list.parentNode as Node;
      const chosen = new Set<Element>(blocks);
      let current: HTMLElement | null = null;
      for (const li of Array.from(list.children)) {
        if (chosen.has(li)) {
          const p = document.createElement('p');
          copyAttrs(li, p);
          moveChildren(li, p);
          parent.insertBefore(p, list);
          current = null;
        } else {
          if (!current) {
            current = document.createElement(kind);
            copyAttrs(list, current);
            parent.insertBefore(current, list);
          }
          current.appendChild(li);
        }
      }
      list.remove();
    } else {
      const first = blocks[0];
      let list: HTMLElement;
      if (first.tagName === 'LI' && first.parentElement) {
        // Switch the list type (bullets ↔ numbers).
        const old = first.parentElement;
        list = document.createElement(kind);
        copyAttrs(old, list);
        moveChildren(old, list);
        old.replaceWith(list);
      } else {
        list = document.createElement(kind);
        first.parentNode?.insertBefore(list, first);
        for (const b of blocks) {
          if (b.tagName === 'LI') {
            continue;
          }
          const li = document.createElement('li');
          copyAttrs(b, li);
          moveChildren(b, li);
          if (!li.firstChild) {
            li.appendChild(document.createElement('br'));
          }
          list.appendChild(li);
          b.remove();
        }
      }
    }
    try {
      const r = document.createRange();
      r.setStart(saved.sc, saved.so);
      r.setEnd(saved.ec, saved.eo);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {
      // the caret node went away; leave the selection where the browser put it
    }
    this._emit();
    this._onSelectionChange();
  }

  setDirection(dir: 'rtl' | 'ltr' | 'toggle') {
    if (this.props.readOnly) {
      return;
    }
    this._restore();
    document.execCommand('defaultParagraphSeparator', false, 'p');
    const blocks = this._selectedBlocks();
    if (!blocks.length) {
      return;
    }
    const current = getComputedStyle(blocks[0]).direction === 'rtl' ? 'rtl' : 'ltr';
    const next = dir === 'toggle' ? (current === 'rtl' ? 'ltr' : 'rtl') : dir;
    for (const b of blocks) {
      b.setAttribute('dir', next);
    }
    this._emit();
  }

  openLink() {
    if (this.props.readOnly) {
      return;
    }
    const sel = document.getSelection();
    if (sel && sel.rangeCount && this._inside(sel.anchorNode)) {
      this._range = sel.getRangeAt(0).cloneRange();
    }
    this.setState({ linkOpen: true, linkValue: '', linkError: false, palette: null });
  }

  applyLink() {
    const href = normalizeLinkInput(this.state.linkValue);
    if (!href) {
      this.setState({ linkError: true });
      return;
    }
    this.setState({ linkOpen: false, linkValue: '', linkError: false });
    this._restore();
    const sel = document.getSelection();
    if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) {
      document.execCommand('createLink', false, href);
    } else {
      const text = href.replace(/^mailto:/i, '');
      const safe = sanitizeDraftHtml(
        `<a href="${href.replace(/"/g, '&quot;')}">${text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</a>`
      );
      document.execCommand('insertHTML', false, safe);
    }
    this._emit();
  }

  clearFormatting() {
    this.exec('removeFormat');
    this.exec('unlink');
  }

  _onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) {
      return;
    }
    // Use physical keys so the shortcuts also work with a Hebrew keyboard layout.
    const code = e.code;
    const run = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (!e.shiftKey) {
      if (code === 'KeyB') run(() => this.exec('bold'));
      else if (code === 'KeyI') run(() => this.exec('italic'));
      else if (code === 'KeyU') run(() => this.exec('underline'));
      else if (code === 'KeyK') run(() => this.openLink());
      else if (code === 'Backslash') run(() => this.clearFormatting());
      return;
    }
    if (code === 'KeyX') run(() => this.exec('strikeThrough'));
    else if (code === 'Digit8') run(() => this.toggleList('ul'));
    else if (code === 'Digit7') run(() => this.toggleList('ol'));
    else if (code === 'KeyL') run(() => this.exec('justifyLeft'));
    else if (code === 'KeyE') run(() => this.exec('justifyCenter'));
    else if (code === 'KeyR') run(() => this.exec('justifyRight'));
    else if (code === 'KeyD') run(() => this.setDirection('toggle'));
  };

  _onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (this.props.readOnly) {
      return;
    }
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (html) {
      document.execCommand('insertHTML', false, sanitizeDraftHtml(html));
    } else if (text) {
      document.execCommand('insertText', false, text);
    }
    this._emit();
  };

  _btn(key: string, title: string, content: React.ReactNode, onClick: () => void, active = false) {
    return (
      <button
        key={key}
        type="button"
        className={classNames('offline-fmt-btn', { active })}
        data-offline-fmt={key}
        title={title}
        aria-label={title}
        aria-pressed={active}
        disabled={this.props.readOnly}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  _renderPalette() {
    const kind = this.state.palette;
    if (!kind) {
      return null;
    }
    const colors = kind === 'fore' ? TEXT_COLORS : HIGHLIGHTS;
    return (
      <div className="offline-fmt-palette" data-offline-fmt-palette={kind}>
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            className={classNames('offline-fmt-swatch', { none: c === 'transparent' })}
            data-offline-fmt-color={c}
            style={{ background: c === 'transparent' ? undefined : c }}
            title={c === 'transparent' ? tr('ללא הדגשה', 'No highlight') : c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => this.exec(kind === 'fore' ? 'foreColor' : 'hiliteColor', c)}
          />
        ))}
      </div>
    );
  }

  render() {
    const a = this.state.active;
    const t = (he: string, en: string, sc?: string) => `${tr(he, en)}${sc ? ` (${sc})` : ''}`;
    return (
      <div className="offline-rich">
        <div
          className="offline-fmt-toolbar"
          role="toolbar"
          aria-label={tr('עיצוב טקסט', 'Text formatting')}
          data-offline-fmt-toolbar="true"
        >
          <select
            className="offline-fmt-select"
            data-offline-fmt="font"
            title={tr('גופן', 'Font')}
            disabled={this.props.readOnly}
            value=""
            onChange={(e) => e.target.value && this.exec('fontName', e.target.value)}
          >
            <option value="">{tr('גופן', 'Font')}</option>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
          <select
            className="offline-fmt-select"
            data-offline-fmt="size"
            title={tr('גודל', 'Size')}
            disabled={this.props.readOnly}
            value=""
            onChange={(e) => e.target.value && this.exec('fontSize', e.target.value)}
          >
            <option value="">{tr('גודל', 'Size')}</option>
            {SIZES.map((s) => (
              <option key={s.v} value={s.v}>
                {tr(s.he, s.en)}
              </option>
            ))}
          </select>
          <span className="offline-fmt-sep" />
          {this._btn(
            'bold',
            t('מודגש', 'Bold', SHORTCUTS.bold),
            <b>B</b>,
            () => this.exec('bold'),
            a.bold
          )}
          {this._btn(
            'italic',
            t('נטוי', 'Italic', SHORTCUTS.italic),
            <i>I</i>,
            () => this.exec('italic'),
            a.italic
          )}
          {this._btn(
            'underline',
            t('קו תחתון', 'Underline', SHORTCUTS.underline),
            <u>U</u>,
            () => this.exec('underline'),
            a.underline
          )}
          {this._btn(
            'strike',
            t('קו חוצה', 'Strikethrough', SHORTCUTS.strike),
            <s>S</s>,
            () => this.exec('strikeThrough'),
            a.strikeThrough
          )}
          <span className="offline-fmt-sep" />
          {this._btn(
            'color',
            t('צבע טקסט', 'Text color'),
            <span className="offline-fmt-color-a">A</span>,
            () =>
              this.setState({
                palette: this.state.palette === 'fore' ? null : 'fore',
                linkOpen: false,
              })
          )}
          {this._btn(
            'highlight',
            t('הדגשה', 'Highlight'),
            <span className="offline-fmt-highlight">ab</span>,
            () =>
              this.setState({
                palette: this.state.palette === 'back' ? null : 'back',
                linkOpen: false,
              })
          )}
          <span className="offline-fmt-sep" />
          {this._btn(
            'bullets',
            t('רשימת תבליטים', 'Bulleted list', SHORTCUTS.bullets),
            <ListIcon numbered={false} />,
            () => this.toggleList('ul'),
            a.insertUnorderedList
          )}
          {this._btn(
            'numbers',
            t('רשימה ממוספרת', 'Numbered list', SHORTCUTS.numbers),
            <ListIcon numbered />,
            () => this.toggleList('ol'),
            a.insertOrderedList
          )}
          <span className="offline-fmt-sep" />
          {/*  Physical order stays right / center / left in both languages. */}
          {this._btn(
            'align-right',
            t('יישור לימין', 'Align right', SHORTCUTS.right),
            <AlignIcon kind="right" />,
            () => this.exec('justifyRight')
          )}
          {this._btn(
            'align-center',
            t('מרכוז', 'Center', SHORTCUTS.center),
            <AlignIcon kind="center" />,
            () => this.exec('justifyCenter')
          )}
          {this._btn(
            'align-left',
            t('יישור לשמאל', 'Align left', SHORTCUTS.left),
            <AlignIcon kind="left" />,
            () => this.exec('justifyLeft')
          )}
          <span className="offline-fmt-sep" />
          {this._btn(
            'rtl',
            t('פסקה מימין לשמאל', 'Paragraph right-to-left', SHORTCUTS.dir),
            <span className="offline-fmt-dir">¶◂</span>,
            () => this.setDirection('rtl')
          )}
          {this._btn(
            'ltr',
            t('פסקה משמאל לימין', 'Paragraph left-to-right', SHORTCUTS.dir),
            <span className="offline-fmt-dir">▸¶</span>,
            () => this.setDirection('ltr')
          )}
          <span className="offline-fmt-sep" />
          {this._btn('link', t('קישור', 'Link', SHORTCUTS.link), <span>🔗</span>, () =>
            this.openLink()
          )}
          {this._btn(
            'clear',
            t('נקה עיצוב', 'Clear formatting', SHORTCUTS.clear),
            <span className="offline-fmt-clear">
              T<sub>×</sub>
            </span>,
            () => this.clearFormatting()
          )}
          {this._renderPalette()}
          {this.props.readOnly ? null : (
            <>
              <span className="offline-fmt-sep" />
              <OfflineMic target='[data-offline-draft-field="body"]' scope=".offline-rich" />
            </>
          )}
        </div>
        {this.state.linkOpen ? (
          <div className="offline-fmt-linkbar" data-offline-fmt-linkbar="true">
            <input
              type="text"
              dir="ltr"
              autoFocus
              spellCheck={false}
              className={classNames({ invalid: this.state.linkError })}
              placeholder="https://… / name@example.com"
              value={this.state.linkValue}
              onChange={(e) => this.setState({ linkValue: e.target.value, linkError: false })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  this.applyLink();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  this.setState({ linkOpen: false });
                  this._restore();
                }
              }}
            />
            <button type="button" className="btn btn-small" onClick={() => this.applyLink()}>
              {tr('הוסף קישור', 'Add link')}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                this.setState({ linkOpen: false });
                this._restore();
              }}
            >
              {tr('בטל', 'Cancel')}
            </button>
            {this.state.linkError ? (
              <span className="offline-fmt-linkerror">
                {tr('רק http, https או כתובת מייל', 'Only http, https or an email address')}
              </span>
            ) : null}
          </div>
        ) : null}
        <div
          ref={this._el}
          className="offline-draft-body offline-draft-rich"
          data-offline-draft-field="body"
          contentEditable={!this.props.readOnly}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          dir="auto"
          spellCheck
          data-placeholder={this.props.placeholder}
          onInput={() => this._emit()}
          onFocus={this._onFocus}
          onBlur={this._onBlur}
          onKeyDown={this._onKeyDown}
          onPaste={this._onPaste}
          onClick={() => this.state.palette && this.setState({ palette: null })}
        />
      </div>
    );
  }
}
