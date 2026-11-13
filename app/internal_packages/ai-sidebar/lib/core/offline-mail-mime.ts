/**
 * Read-only MIME parser for the offline experiment browser.
 *
 * Input is the raw RFC822 bytes of one local .eml file (opened read-only).
 * Output is display data only. Nothing here touches the network or writes
 * to disk. HTML is returned raw; callers must render it inside a sandboxed
 * iframe with a no-network CSP (see buildSandboxedHtmlDocument).
 */

export type OfflineMailAttachment = {
  filename: string;
  contentType: string;
  size: number;
};

export type ParsedOfflineMail = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  messageId: string;
  text: string;
  html: string | null;
  attachments: OfflineMailAttachment[];
  notes: string[];
};

type HeaderMap = { [name: string]: string[] };

const MAX_DEPTH = 12;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

const CHARSET_ALIASES: { [k: string]: string } = {
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'x-unknown': 'utf-8',
  unknown: 'utf-8',
  'iso-8859-8-i': 'iso-8859-8',
  'iso-8859-8-e': 'iso-8859-8',
  visual: 'iso-8859-8',
  cp1255: 'windows-1255',
  'x-cp1255': 'windows-1255',
  cp1252: 'windows-1252',
  ascii: 'us-ascii',
  'ks_c_5601-1987': 'euc-kr',
};

function normalizeCharset(cs: string | undefined | null): string {
  const n = String(cs || 'utf-8')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  return CHARSET_ALIASES[n] || n || 'utf-8';
}

function looksLikeUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Decode bytes with a declared charset. Unknown charsets fall back to UTF-8, then latin1. */
export function decodeBytes(buf: Buffer, charset?: string | null): string {
  const cs = normalizeCharset(charset);
  if (cs === 'us-ascii' || cs === 'utf-8') {
    if (cs === 'us-ascii' && !looksLikeUtf8(buf)) {
      return buf.toString('latin1');
    }
    return new TextDecoder('utf-8').decode(buf);
  }
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    if (looksLikeUtf8(buf)) {
      return new TextDecoder('utf-8').decode(buf);
    }
    return buf.toString('latin1');
  }
}

export function decodeQuotedPrintableBytes(raw: string): Buffer {
  const soft = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const ch = soft[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Decode an RFC2047 header value. `raw` is a latin1 string holding the raw
 * header bytes, so unencoded 8-bit UTF-8 headers are also recovered.
 */
export function decodeHeaderValue(raw: string): string {
  if (!raw) {
    return '';
  }
  // Adjacent encoded words separated only by whitespace are concatenated.
  const joined = raw.replace(/(\?=)\s+(=\?)/g, '$1$2');
  const out: string[] = [];
  let last = 0;
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let m: RegExpExecArray | null;
  let pendingBytes: Buffer[] = [];
  let pendingCharset = '';
  const flush = () => {
    if (pendingBytes.length) {
      out.push(decodeBytes(Buffer.concat(pendingBytes), pendingCharset));
      pendingBytes = [];
      pendingCharset = '';
    }
  };
  while ((m = re.exec(joined))) {
    if (m.index > last) {
      flush();
      out.push(decodeRaw8bit(joined.slice(last, m.index)));
    }
    const charset = m[1].split('*')[0];
    const enc = m[2].toUpperCase();
    let bytes: Buffer;
    try {
      bytes =
        enc === 'B'
          ? Buffer.from(m[3], 'base64')
          : decodeQuotedPrintableBytes(m[3].replace(/_/g, ' '));
    } catch {
      bytes = Buffer.from(m[0], 'latin1');
    }
    // Multi-byte characters may be split across encoded words of one charset.
    if (pendingBytes.length && normalizeCharset(charset) !== normalizeCharset(pendingCharset)) {
      flush();
    }
    pendingCharset = charset;
    pendingBytes.push(bytes);
    last = m.index + m[0].length;
  }
  flush();
  if (last < joined.length) {
    out.push(decodeRaw8bit(joined.slice(last)));
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

function decodeRaw8bit(latin1: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\x80-\xff]/.test(latin1)) {
    return latin1;
  }
  const buf = Buffer.from(latin1, 'latin1');
  return looksLikeUtf8(buf) ? buf.toString('utf8') : decodeBytes(buf, 'windows-1255');
}

export function splitHeadersAndBody(rawLatin1: string): { headerText: string; body: string } {
  const m = /\r?\n\r?\n/.exec(rawLatin1);
  if (!m) {
    return { headerText: rawLatin1, body: '' };
  }
  return { headerText: rawLatin1.slice(0, m.index), body: rawLatin1.slice(m.index + m[0].length) };
}

export function parseHeaderBlock(headerText: string): HeaderMap {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const map: HeaderMap = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) {
      continue;
    }
    (map[name] = map[name] || []).push(line.slice(idx + 1).trim());
  }
  return map;
}

function first(h: HeaderMap, name: string): string {
  const v = h[name];
  return v && v.length ? v[0] : '';
}

/** Read a MIME parameter, including RFC2231 `name*=charset''value` and continuations. */
export function headerParam(value: string, param: string): string {
  if (!value) {
    return '';
  }
  const lower = param.toLowerCase();
  const parts = value.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/).slice(1);
  const plain: { [k: string]: string } = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const k = part.slice(0, eq).trim().toLowerCase();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    plain[k] = v;
  }
  if (plain[lower] !== undefined) {
    return decodeHeaderValue(plain[lower]);
  }
  const extended: string[] = [];
  let charset = 'utf-8';
  const keys = Object.keys(plain)
    .filter((k) => k === `${lower}*` || k.startsWith(`${lower}*`))
    .sort((a, b) => {
      const na = parseInt(a.slice(lower.length + 1), 10) || 0;
      const nb = parseInt(b.slice(lower.length + 1), 10) || 0;
      return na - nb;
    });
  for (const k of keys) {
    let v = plain[k];
    if (k.endsWith('*')) {
      const m = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (m) {
        charset = m[1] || charset;
        v = m[2];
      }
      try {
        const bytes = Buffer.from(
          v.replace(/%([0-9A-Fa-f]{2})/g, (_x, hex) => String.fromCharCode(parseInt(hex, 16))),
          'latin1'
        );
        extended.push(decodeBytes(bytes, charset));
      } catch {
        extended.push(v);
      }
    } else {
      extended.push(v);
    }
  }
  return extended.join('');
}

function mainValue(value: string): string {
  return (value.split(';')[0] || '').trim().toLowerCase();
}

function decodeTransfer(bodyLatin1: string, cte: string): Buffer {
  const enc = (cte || '').trim().toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(bodyLatin1.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintableBytes(bodyLatin1);
  }
  return Buffer.from(bodyLatin1, 'latin1');
}

function splitMultipart(bodyLatin1: string, boundary: string): string[] {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\r?\\n)--${esc}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  let start = -1;
  while ((m = re.exec(bodyLatin1))) {
    if (start !== -1) {
      parts.push(bodyLatin1.slice(start, m.index));
    }
    if (m[1]) {
      start = -1;
      break;
    }
    const nl = bodyLatin1.slice(re.lastIndex).match(/^\r?\n/);
    start = re.lastIndex + (nl ? nl[0].length : 0);
  }
  if (start !== -1 && start < bodyLatin1.length) {
    parts.push(bodyLatin1.slice(start));
  }
  return parts;
}

type Walk = {
  text: string[];
  html: string[];
  attachments: OfflineMailAttachment[];
  inlineImages: { [cid: string]: string };
  notes: Set<string>;
};

function walkEntity(rawLatin1: string, walk: Walk, depth: number, parentType: string): void {
  if (depth > MAX_DEPTH) {
    walk.notes.add('mime-depth-limit');
    return;
  }
  const { headerText, body } = splitHeadersAndBody(rawLatin1);
  const h = parseHeaderBlock(headerText);
  const ctRaw =
    first(h, 'content-type') ||
    (parentType === 'multipart/digest' ? 'message/rfc822' : 'text/plain');
  const ct = mainValue(ctRaw);
  const cte = first(h, 'content-transfer-encoding');
  const dispRaw = first(h, 'content-disposition');
  const disp = mainValue(dispRaw);
  const filename = headerParam(dispRaw, 'filename') || headerParam(ctRaw, 'name') || '';

  if (ct.startsWith('multipart/')) {
    const boundary = headerParam(ctRaw, 'boundary');
    if (!boundary) {
      walk.notes.add('multipart-without-boundary');
      return;
    }
    const parts = splitMultipart(body, boundary);
    if (ct === 'multipart/alternative') {
      // Prefer the richest renderable alternative but keep plain text for AI/snippets.
      const sub: Walk = {
        text: [],
        html: [],
        attachments: [],
        inlineImages: {},
        notes: walk.notes,
      };
      for (const p of parts) {
        walkEntity(p, sub, depth + 1, ct);
      }
      if (sub.html.length) {
        walk.html.push(sub.html[sub.html.length - 1]);
      }
      if (sub.text.length) {
        walk.text.push(sub.text[0]);
      }
      walk.attachments.push(...sub.attachments);
      Object.assign(walk.inlineImages, sub.inlineImages);
      return;
    }
    for (const p of parts) {
      walkEntity(p, walk, depth + 1, ct);
    }
    return;
  }

  const isAttachment = disp === 'attachment' || (!!filename && !ct.startsWith('text/'));
  if (ct === 'message/rfc822' || ct === 'message/global') {
    walk.attachments.push({
      filename: filename || 'attached-message.eml',
      contentType: ct,
      size: body.length,
    });
    walk.notes.add('nested-message-as-attachment');
    return;
  }

  if (!isAttachment && (ct === 'text/plain' || ct === 'text/html' || ct === 'text/enriched')) {
    const bytes = decodeTransfer(body, cte);
    const charset = headerParam(ctRaw, 'charset');
    let text = decodeBytes(bytes, charset);
    if (ct === 'text/html' && !charset) {
      const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.toString('latin1'));
      if (meta) {
        text = decodeBytes(bytes, meta[1]);
      }
    }
    if (ct === 'text/html') {
      walk.html.push(text);
    } else {
      walk.text.push(text);
    }
    return;
  }

  const bytes = decodeTransfer(body, cte);
  const cid = (first(h, 'content-id') || '').replace(/^<|>$/g, '').trim();
  if (cid && ct.startsWith('image/') && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
    walk.inlineImages[cid] = `data:${ct};base64,${bytes.toString('base64')}`;
    if (disp !== 'attachment') {
      return;
    }
  }
  walk.attachments.push({
    filename: filename || `(unnamed ${ct || 'part'})`,
    contentType: ct,
    size: bytes.length,
  });
}

const ENTITY_MAP: { [k: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rlm: '\u200f',
  lrm: '\u200e',
  shy: '',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    const v = ENTITY_MAP[ent.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseOfflineMail(raw: Buffer | string): ParsedOfflineMail {
  const rawLatin1 = typeof raw === 'string' ? raw : raw.toString('latin1');
  const { headerText } = splitHeadersAndBody(rawLatin1);
  const h = parseHeaderBlock(headerText);
  const walk: Walk = { text: [], html: [], attachments: [], inlineImages: {}, notes: new Set() };
  try {
    walkEntity(rawLatin1, walk, 0, '');
  } catch (err) {
    walk.notes.add(`mime-parse-error:${(err as Error).message}`);
  }
  let html: string | null = walk.html.length ? walk.html.join('<hr />') : null;
  if (html && Object.keys(walk.inlineImages).length) {
    html = html.replace(/(["'(])cid:([^"')\s>]+)/gi, (m, q: string, cid: string) => {
      const data = walk.inlineImages[cid] || walk.inlineImages[decodeURIComponent(cid)];
      return data ? `${q}${data}` : m;
    });
  }
  const text = walk.text.length ? walk.text.join('\n\n') : html ? htmlToText(html) : '';
  return {
    subject: decodeHeaderValue(first(h, 'subject')) || '(No Subject)',
    from: decodeHeaderValue(first(h, 'from')) || '(Unknown)',
    to: decodeHeaderValue((h.to || []).join(', ')),
    cc: decodeHeaderValue((h.cc || []).join(', ')),
    date: first(h, 'date'),
    messageId: first(h, 'message-id'),
    text,
    html,
    attachments: walk.attachments,
    notes: Array.from(walk.notes),
  };
}

/** Header-only parse for indexing (first chunk of the file is enough). */
export function parseOfflineMailHeaders(headChunk: Buffer | string): {
  subject: string;
  from: string;
  date: string;
  hasAttachments: boolean;
  to: string;
  cc: string;
  replyTo: string;
} {
  const rawLatin1 = typeof headChunk === 'string' ? headChunk : headChunk.toString('latin1');
  const { headerText } = splitHeadersAndBody(rawLatin1);
  const h = parseHeaderBlock(headerText);
  const ct = mainValue(first(h, 'content-type'));
  return {
    subject: decodeHeaderValue(first(h, 'subject')) || '(No Subject)',
    from: decodeHeaderValue(first(h, 'from')) || '(Unknown)',
    date: first(h, 'date'),
    hasAttachments:
      ct === 'multipart/mixed' || /Content-Disposition:\s*attachment/i.test(rawLatin1),
    // Recipients feed the local address book (kept in the offline profile only).
    to: decodeHeaderValue(first(h, 'to')).slice(0, 4000),
    cc: decodeHeaderValue(first(h, 'cc')).slice(0, 4000),
    replyTo: decodeHeaderValue(first(h, 'reply-to')).slice(0, 1000),
  };
}

export const HEBREW_RE = /[\u0590-\u05ff\ufb1d-\ufb4f]/;

export function containsHebrew(s: string): boolean {
  return HEBREW_RE.test(s || '');
}

/**
 * Wrap message HTML for a sandboxed iframe (`sandbox` without scripts or
 * same-origin). The CSP blocks every network fetch: remote images, fonts,
 * stylesheets, frames and forms. Only data: images (inline cid parts) render.
 */
export function buildSandboxedHtmlDocument(html: string): string {
  const csp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?(refresh|content-security-policy)[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<style>html,body{margin:0;padding:8px 12px;font-family:"Segoe UI",Arial,sans-serif;font-size:14px;' +
    'color:#222;background:#fff;overflow-wrap:anywhere;}img{max-width:100%;height:auto;}' +
    'table{max-width:100%;}img:not([src^="data:"]){display:none !important;}</style></head><body dir="auto">' +
    cleaned +
    '</body></html>'
  );
}
