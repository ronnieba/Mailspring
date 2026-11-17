/**
 * Offline experiment: rich-text helpers for local drafts.
 *
 * Drafts keep sanitized HTML (formatting) plus a plain-text copy (`body`).
 * Proofreading only ever sends the plain text; accepted corrections are
 * spliced back into the HTML text nodes so formatting survives. Changes that
 * would cross a paragraph boundary are skipped (counted) instead of guessed.
 * Pure string code, no DOM, no network.
 */
import { ProofSegment } from './text-diff';

export const OFFLINE_DRAFT_HTML_MAX_CHARS = 400000;

const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'span',
  'font',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'sub',
  'sup',
]);
const VOID_TAGS = new Set(['br']);
/** Tags whose whole content is dropped. */
const DROP_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'head',
  'title',
  'template',
  'svg',
  'math',
  'noscript',
  'textarea',
  'select',
  'button',
]);
const BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'li', 'blockquote']);
const STYLE_PROPS = new Set([
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'text-align',
  'direction',
]);

export type HtmlToken =
  | { t: 'text'; text: string }
  | { t: 'open'; name: string; raw: string }
  | { t: 'close'; name: string; raw: string };

const ENTITIES: { [k: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      } catch (err) {
        return '';
      }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export function encodeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;');
}

function encodeAttr(s: string): string {
  return encodeText(s).replace(/"/g, '&quot;');
}

/** Split HTML into text and tag tokens (comments / doctype are dropped). */
export function tokenizeHtml(html: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  const re =
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html || ''))) {
    if (m[3] !== undefined) {
      out.push({ t: 'text', text: decodeEntities(m[3]) });
    } else if (m[4] !== undefined) {
      out.push({ t: 'text', text: '<' });
    } else if (m[1] !== undefined) {
      const name = m[1].toLowerCase();
      out.push(m[0][1] === '/' ? { t: 'close', name, raw: m[0] } : { t: 'open', name, raw: m[0] });
    }
  }
  return out;
}

function parseAttrs(raw: string): { [k: string]: string } {
  const out: { [k: string]: string } = {};
  const inner = raw.replace(/^<[a-zA-Z][a-zA-Z0-9-]*/, '').replace(/\/?>$/, '');
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) {
      out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
  }
  return out;
}

const SAFE_STYLE_VALUE = /^[#a-zA-Z0-9\s,.%()'"\-\u0590-\u05FF]+$/;

export function sanitizeStyle(style: string): string {
  const keep: string[] = [];
  for (const decl of (style || '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) {
      continue;
    }
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !value || value.length > 120) {
      continue;
    }
    if (!SAFE_STYLE_VALUE.test(value) || /url\s*\(|expression|javascript|\\/i.test(value)) {
      continue;
    }
    if (/\(/.test(value) && !/^(rgba?|hsla?)\(/i.test(value)) {
      continue;
    }
    keep.push(`${prop}: ${value.replace(/"/g, "'")}`);
  }
  return keep.join('; ');
}

export function isSafeHref(href: string): boolean {
  const h = (href || '').trim();
  return /^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(h) && h.length <= 2000;
}

function cleanOpenTag(name: string, raw: string): string {
  const a = parseAttrs(raw);
  const parts: string[] = [];
  if (a.dir && /^(rtl|ltr|auto)$/i.test(a.dir)) {
    parts.push(`dir="${a.dir.toLowerCase()}"`);
  }
  if (a.style) {
    const s = sanitizeStyle(a.style);
    if (s) {
      parts.push(`style="${encodeAttr(s)}"`);
    }
  }
  if (
    (name === 'p' || name === 'div') &&
    a.align &&
    /^(left|right|center|justify)$/i.test(a.align)
  ) {
    parts.push(`align="${a.align.toLowerCase()}"`);
  }
  if (name === 'font') {
    if (a.color && /^#?[a-zA-Z0-9]{1,20}$/.test(a.color)) {
      parts.push(`color="${encodeAttr(a.color)}"`);
    }
    if (a.face && /^[a-zA-Z0-9 ,'\-\u0590-\u05FF]{1,100}$/.test(a.face)) {
      parts.push(`face="${encodeAttr(a.face)}"`);
    }
    if (a.size && /^[1-7]$/.test(a.size)) {
      parts.push(`size="${a.size}"`);
    }
  }
  if (name === 'a' && a.href && isSafeHref(a.href)) {
    parts.push(`href="${encodeAttr(a.href.trim())}"`);
  }
  return `<${name}${parts.length ? ` ${parts.join(' ')}` : ''}>`;
}

/**
 * Keep only formatting tags / attributes. Scripts, styles, frames, images,
 * event handlers and unsafe links are removed; unknown tags are unwrapped.
 */
export function sanitizeDraftHtml(html: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let drop: string | null = null;
  let dropDepth = 0;
  for (const tok of tokenizeHtml((html || '').slice(0, OFFLINE_DRAFT_HTML_MAX_CHARS))) {
    if (drop) {
      if (tok.t === 'open' && tok.name === drop && !/\/>$/.test(tok.raw)) {
        dropDepth++;
      } else if (tok.t === 'close' && tok.name === drop) {
        dropDepth--;
        if (dropDepth === 0) {
          drop = null;
        }
      }
      continue;
    }
    if (tok.t === 'text') {
      out.push(encodeText(tok.text));
      continue;
    }
    if (tok.t === 'open') {
      if (DROP_CONTENT.has(tok.name)) {
        if (!/\/>$/.test(tok.raw)) {
          drop = tok.name;
          dropDepth = 1;
        }
        continue;
      }
      if (!ALLOWED_TAGS.has(tok.name)) {
        continue;
      }
      if (VOID_TAGS.has(tok.name)) {
        out.push('<br>');
        continue;
      }
      out.push(cleanOpenTag(tok.name, tok.raw));
      stack.push(tok.name);
      continue;
    }
    // close
    if (!ALLOWED_TAGS.has(tok.name) || VOID_TAGS.has(tok.name)) {
      continue;
    }
    const at = stack.lastIndexOf(tok.name);
    if (at < 0) {
      continue;
    }
    while (stack.length > at) {
      out.push(`</${stack.pop()}>`);
    }
  }
  while (stack.length) {
    out.push(`</${stack.pop()}>`);
  }
  return out.join('');
}

interface PlainMap {
  plain: string;
  /** For each plain char: [token index, offset in that token's text] or null (synthetic). */
  map: ([number, number] | null)[];
  tokens: HtmlToken[];
}

function buildPlainMap(html: string): PlainMap {
  const tokens = tokenizeHtml(html);
  let plain = '';
  const map: ([number, number] | null)[] = [];
  let quote = 0;
  let atLineStart = true;
  const pushSynthetic = (s: string) => {
    for (const ch of s) {
      plain += ch;
      map.push(null);
    }
  };
  const newline = () => {
    pushSynthetic('\n');
    atLineStart = true;
  };
  const blockEdge = () => {
    if (plain.length && !plain.endsWith('\n')) {
      newline();
    }
  };
  const linePrefix = (empty: boolean) => {
    if (atLineStart && quote > 0) {
      pushSynthetic(empty ? '>'.repeat(quote) : `${'> '.repeat(quote)}`);
    }
    atLineStart = false;
  };
  tokens.forEach((tok, ti) => {
    if (tok.t === 'text') {
      const text = tok.text.replace(/[\r\n]+/g, ' ');
      if (!text) {
        return;
      }
      linePrefix(false);
      for (let i = 0; i < tok.text.length; i++) {
        const ch = tok.text[i];
        plain += ch === '\u00a0' || ch === '\r' || ch === '\n' ? ' ' : ch;
        map.push([ti, i]);
      }
      return;
    }
    if (tok.name === 'br') {
      if (atLineStart && quote > 0) {
        linePrefix(true);
      }
      newline();
      return;
    }
    if (BLOCK_TAGS.has(tok.name)) {
      blockEdge();
      if (tok.name === 'blockquote') {
        quote += tok.t === 'open' ? 1 : quote > 0 ? -1 : 0;
      }
    }
  });
  return { plain, map, tokens };
}

/** Plain text of draft HTML (paragraphs → lines, blockquote lines get "> "). */
export function htmlToPlain(html: string): string {
  return buildPlainMap(html).plain.replace(/\n$/, '');
}

/** Plain draft text → simple HTML (lines starting with ">" become a blockquote). */
export function plainToHtml(text: string): string {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inQuote = false;
  for (const line of lines) {
    const q = /^>/.test(line);
    if (q && !inQuote) {
      out.push('<blockquote>');
      inQuote = true;
    } else if (!q && inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
    const content = q ? line.replace(/^> ?/, '') : line;
    out.push(content ? `<p dir="auto">${encodeText(content)}</p>` : '<p dir="auto"><br></p>');
  }
  if (inQuote) {
    out.push('</blockquote>');
  }
  return out.join('');
}

function serialize(tokens: HtmlToken[]): string {
  return tokens.map((t) => (t.t === 'text' ? encodeText(t.text) : t.raw)).join('');
}

/**
 * Apply accepted proofreading changes to the HTML without touching tags.
 * `segments` must come from the plain text of this same HTML.
 * Returns the new HTML and how many accepted changes had to be skipped
 * (they crossed a line / paragraph boundary).
 */
export function applyProofToHtml(
  html: string,
  segments: ProofSegment[],
  accepted: Set<number>
): { html: string; applied: number; skipped: number } {
  const pm = buildPlainMap(html);
  const original = segments.map((s) => (s.kind === 'same' ? s.text : s.change.before)).join('');
  if (original !== pm.plain.replace(/\n$/, '')) {
    return { html, applied: 0, skipped: accepted.size };
  }
  type Edit = { start: number; end: number; after: string; id: number };
  const edits: Edit[] = [];
  let pos = 0;
  for (const s of segments) {
    if (s.kind === 'same') {
      pos += s.text.length;
      continue;
    }
    const { before, after, id } = s.change;
    if (accepted.has(id)) {
      // "Helo wrld" → "Hello world": split word by word when the spacing
      // matches, so each word keeps its own formatting.
      const bw = before.split(/(\s+)/);
      const aw = after.split(/(\s+)/);
      const sameShape =
        bw.length > 1 &&
        bw.length === aw.length &&
        bw.every((w, i) => (i % 2 === 1 ? w === aw[i] : true));
      if (sameShape) {
        let p = pos;
        bw.forEach((w, i) => {
          if (w !== aw[i]) {
            edits.push({ start: p, end: p + w.length, after: aw[i], id });
          }
          p += w.length;
        });
      } else {
        edits.push({ start: pos, end: pos + before.length, after, id });
      }
    }
    pos += before.length;
  }
  const texts = pm.tokens.map((t) => (t.t === 'text' ? t.text : ''));
  const appliedIds = new Set<number>();
  const skippedIds = new Set<number>();
  for (const e of edits.reverse()) {
    if (/\n/.test(e.after)) {
      skippedIds.add(e.id);
      continue;
    }
    if (e.start === e.end) {
      const prev = e.start > 0 ? pm.map[e.start - 1] : null;
      const next = pm.map[e.start] || null;
      if (prev) {
        texts[prev[0]] =
          texts[prev[0]].slice(0, prev[1] + 1) + e.after + texts[prev[0]].slice(prev[1] + 1);
      } else if (next) {
        texts[next[0]] = texts[next[0]].slice(0, next[1]) + e.after + texts[next[0]].slice(next[1]);
      } else {
        skippedIds.add(e.id);
        continue;
      }
      appliedIds.add(e.id);
      continue;
    }
    const cells = pm.map.slice(e.start, e.end);
    if (cells.some((c) => !c)) {
      skippedIds.add(e.id);
      continue;
    }
    // Group the range by text token; the first token gets the replacement.
    const byTok: { tok: number; from: number; to: number }[] = [];
    for (const c of cells as [number, number][]) {
      const last = byTok[byTok.length - 1];
      if (last && last.tok === c[0]) {
        last.to = c[1] + 1;
      } else {
        byTok.push({ tok: c[0], from: c[1], to: c[1] + 1 });
      }
    }
    for (let i = byTok.length - 1; i >= 0; i--) {
      const g = byTok[i];
      const repl = i === 0 ? e.after : '';
      texts[g.tok] = texts[g.tok].slice(0, g.from) + repl + texts[g.tok].slice(g.to);
    }
    appliedIds.add(e.id);
  }
  const tokens = pm.tokens.map((t, i) =>
    t.t === 'text' ? { t: 'text' as const, text: texts[i] } : t
  );
  return { html: serialize(tokens), applied: appliedIds.size, skipped: skippedIds.size };
}
