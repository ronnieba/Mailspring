/**
 * Offline experiment: built-in attachment viewer (pure helpers).
 *
 * Everything here works on bytes already copied into the offline profile's
 * temp folder; nothing is written anywhere and nothing goes to the network.
 * Libraries are bundled (see THIRD_PARTY_VIEWER_LIBS) and passed in, so the
 * helpers stay testable without Electron.
 */
import { attachmentKind, extensionOf, isDangerousAttachment } from './offline-attachments';
import { buildSandboxedHtmlDocument, decodeBytes, parseOfflineMail } from './offline-mail-mime';

export type ViewerKind =
  | 'pdf'
  | 'image'
  | 'svg'
  | 'docx'
  | 'sheet'
  | 'csv'
  | 'pptx'
  | 'html'
  | 'text'
  | 'json'
  | 'xml'
  | 'eml'
  | 'legacy-office'
  | 'heic'
  | 'danger'
  | 'unsupported';

/** Bundled, offline-only viewer libraries and their licenses (checked t205). */
export const THIRD_PARTY_VIEWER_LIBS = [
  { name: 'pdfjs-dist', version: '6.5.438', license: 'Apache-2.0', use: 'PDF pages' },
  { name: 'xlsx (SheetJS CE)', version: '0.20.3', license: 'Apache-2.0', use: 'Excel / CSV' },
  { name: 'mammoth', version: '1.12.3', license: 'BSD-2-Clause', use: 'Word .docx' },
  {
    name: 'jszip',
    version: '3.10.1',
    license: 'MIT (dual MIT / GPL-3.0, used under MIT)',
    use: 'PowerPoint .pptx (slides and outline)',
  },
  {
    name: 'dompurify',
    version: '3.4.16',
    license: 'Apache-2.0 (dual MPL-2.0 / Apache-2.0)',
    use: 'HTML clean-up',
  },
];

const MB = 1024 * 1024;
/** Larger files are not previewed (open externally instead). */
export const VIEWER_MAX_BYTES: { [k in ViewerKind]?: number } = {
  pdf: 60 * MB,
  image: 30 * MB,
  svg: 2 * MB,
  docx: 30 * MB,
  sheet: 20 * MB,
  csv: 10 * MB,
  pptx: 60 * MB,
  html: 5 * MB,
  text: 10 * MB,
  json: 10 * MB,
  xml: 10 * MB,
  eml: 30 * MB,
};
/** Text shown at most (the rest: open externally). */
export const VIEWER_TEXT_MAX_CHARS = 1000000;
export const VIEWER_SHEET_MAX_ROWS = 2000;
export const VIEWER_SHEET_MAX_COLS = 60;
export const VIEWER_PPTX_MAX_SLIDES = 300;
export const VIEWER_PDF_MAX_PAGES = 300;
export const VIEWER_ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function zoomStep(zoom: number, dir: 1 | -1): number {
  const i = VIEWER_ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
  const cur = i < 0 ? VIEWER_ZOOM_STEPS.length - 1 : i;
  const next = Math.max(0, Math.min(VIEWER_ZOOM_STEPS.length - 1, cur + dir));
  return VIEWER_ZOOM_STEPS[next];
}

export function viewerKindFor(name: string, contentType = ''): ViewerKind {
  if (isDangerousAttachment(name, contentType)) {
    return 'danger';
  }
  const ext = extensionOf(name);
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (ext === 'pdf' || ct === 'application/pdf') return 'pdf';
  if (ext === 'svg' || ct === 'image/svg+xml') return 'svg';
  if (ext === 'heic' || ext === 'heif' || ct === 'image/heic' || ct === 'image/heif') return 'heic';
  if (
    /^(png|jpe?g|gif|webp|bmp|ico|avif)$/.test(ext) ||
    /^image\/(png|jpe?g|pjpeg|gif|webp|bmp|x-icon|avif)$/.test(ct)
  )
    return 'image';
  if (
    ext === 'docx' ||
    ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return 'docx';
  if (
    ext === 'pptx' ||
    ct === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )
    return 'pptx';
  if (
    /^(xlsx|xlsm|xlsb|xls|ods)$/.test(ext) ||
    /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(ct)
  )
    return 'sheet';
  if (ext === 'csv' || ext === 'tsv' || ct === 'text/csv') return 'csv';
  if (
    /^(doc|ppt|pps|rtf|odt|odp|pages|key|numbers)$/.test(ext) ||
    ct === 'application/msword' ||
    ct === 'application/vnd.ms-powerpoint'
  )
    return 'legacy-office';
  if (/^html?$/.test(ext) || ct === 'text/html') return 'html';
  if (ext === 'eml' || ct === 'message/rfc822') return 'eml';
  if (ext === 'json' || ct === 'application/json') return 'json';
  if (ext === 'xml' || /^(application|text)\/xml$/.test(ct)) return 'xml';
  if (/^(txt|log|md|ini|cfg|conf|yaml|yml|vcf|ics)$/.test(ext) || ct.startsWith('text/'))
    return 'text';
  // Fall back on the general classifier for odd names.
  const k = attachmentKind(name, contentType);
  if (k === 'image') return 'image';
  return 'unsupported';
}

export type ViewerGuard = {
  kind: ViewerKind;
  /** null = can be shown inside the app. */
  blocked: null | 'danger' | 'too-large' | 'legacy' | 'heic' | 'unsupported';
};

export function viewerGuard(name: string, contentType: string, size: number): ViewerGuard {
  const kind = viewerKindFor(name, contentType);
  if (kind === 'danger') return { kind, blocked: 'danger' };
  if (kind === 'legacy-office') return { kind, blocked: 'legacy' };
  if (kind === 'heic') return { kind, blocked: 'heic' };
  if (kind === 'unsupported') return { kind, blocked: 'unsupported' };
  const max = VIEWER_MAX_BYTES[kind];
  if (max && size > max) return { kind, blocked: 'too-large' };
  return { kind, blocked: null };
}

/** True when the viewer can show this type at all (size aside). */
export function canViewInApp(name: string, contentType = ''): boolean {
  const k = viewerKindFor(name, contentType);
  return !['danger', 'legacy-office', 'heic', 'unsupported'].includes(k);
}

/** Decode a text attachment: BOM aware, UTF-8, else Hebrew Windows-1255. */
export function decodeTextBytes(buf: Buffer, charset?: string | null): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.slice(2, 2 + ((buf.length - 2) & ~1)));
    sw.swap16();
    return sw.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.slice(3).toString('utf8');
  if (charset) return decodeBytes(buf, charset);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8;
  return decodeBytes(buf, 'windows-1255');
}

export function limitText(
  s: string,
  max = VIEWER_TEXT_MAX_CHARS
): { text: string; truncated: boolean } {
  return s.length > max
    ? { text: s.slice(0, max), truncated: true }
    : { text: s, truncated: false };
}

export function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch (e) {
    return s;
  }
}

/**
 * SVG cleaned of scripts, event handlers, foreign HTML and external links.
 * It is then shown through <img>, which never runs scripts or fetches anything.
 */
export function sanitizeSvg(svg: string): string {
  return String(svg || '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<(iframe|embed|object|audio|video|handler|listener)\b[\s\S]*?(<\/\1\s*>|\/>)/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(xlink:)?href\s*=\s*("(?!#|data:image\/)[^"]*"|'(?!#|data:image\/)[^']*')/gi, '')
    .replace(/url\(\s*(['"]?)(?!#|data:image\/)[^)]*\)/gi, 'none')
    .replace(/@import[^;]+;/gi, '');
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(sanitizeSvg(svg), 'utf8').toString('base64')}`;
}

/**
 * Sandboxed document for HTML / Word previews: no scripts, no network (CSP
 * default-src 'none'), each paragraph aligned by its own language (Hebrew
 * right-to-left, English left-to-right), zoomable.
 */
export function viewerHtmlDocument(html: string, zoom = 1): string {
  const doc = buildSandboxedHtmlDocument(html);
  const extra =
    `<style>html{zoom:${Math.round(zoom * 100) / 100};}` +
    'p,li,td,th,h1,h2,h3,h4,h5,h6,div{unicode-bidi:plaintext;text-align:start;}' +
    'table{border-collapse:collapse;}td,th{border:1px solid #ccc;padding:2px 6px;}' +
    'a{pointer-events:none;color:#0645ad;}</style>';
  return doc.replace('</head>', `${extra}</head>`);
}

export type SheetView = {
  name: string;
  rows: string[][];
  truncatedRows: boolean;
  truncatedCols: boolean;
  totalRows: number;
};

/** Workbook sheets as text grids (SheetJS); values only, no formulas or macros run. */
export function sheetsFromBytes(XLSX: any, buf: Buffer, csvText?: string): SheetView[] {
  const wb =
    csvText !== undefined
      ? XLSX.read(csvText, {
          type: 'string',
          raw: true,
          dense: true,
          sheetRows: VIEWER_SHEET_MAX_ROWS + 1,
        })
      : XLSX.read(buf, {
          type: 'buffer',
          dense: true,
          cellFormula: false,
          cellHTML: false,
          bookVBA: false,
          sheetRows: VIEWER_SHEET_MAX_ROWS + 1,
        });
  const out: SheetView[] = [];
  for (const name of (wb.SheetNames || []).slice(0, 50)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const range = ws['!fullref'] || ws['!ref'];
    let totalRows = 0;
    try {
      totalRows = range ? XLSX.utils.decode_range(range).e.r + 1 : 0;
    } catch (e) {
      totalRows = 0;
    }
    const all: any[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
    });
    const rows = all.slice(0, VIEWER_SHEET_MAX_ROWS);
    let truncatedCols = false;
    const grid = rows.map((r) => {
      if (r.length > VIEWER_SHEET_MAX_COLS) truncatedCols = true;
      return r
        .slice(0, VIEWER_SHEET_MAX_COLS)
        .map((c) => (c === null || c === undefined ? '' : String(c)));
    });
    out.push({
      name: String(name),
      rows: grid,
      truncatedRows: Math.max(all.length, totalRows) > VIEWER_SHEET_MAX_ROWS,
      truncatedCols,
      totalRows: Math.max(totalRows, all.length),
    });
  }
  return out;
}

/** Spreadsheet column letters (A, B, …, AA). */
export function columnName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type SlideView = {
  index: number;
  lines: string[];
  images: { mime: string; data: Buffer }[];
  notes: string[];
};

function xmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function paragraphs(xml: string): string[] {
  const out: string[] = [];
  const re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = (m[1].match(/<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>/g) || [])
      .map((x) => xmlText(x.replace(/<\/?a:t[^>]*>/g, '')))
      .join('');
    if (t.trim()) out.push(t.trim());
  }
  return out;
}

function zipSize(f: any): number {
  return (
    (f && f._data && typeof f._data.uncompressedSize === 'number' && f._data.uncompressedSize) || 0
  );
}

/**
 * PowerPoint .pptx, slide by slide: text in reading order and the slide's
 * pictures (png/jpg/gif). Not a pixel-perfect rendering.
 */
export async function pptxSlides(JSZip: any, buf: Buffer): Promise<SlideView[]> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (p: string, max = 5 * MB): Promise<string | null> => {
    const f = zip.file(p);
    if (!f || zipSize(f) > max) return null;
    return f.async('string');
  };
  // Presentation order from presentation.xml + its relationships.
  let order: string[] = [];
  const pres = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  if (pres && presRels) {
    const target: { [id: string]: string } = {};
    for (const m of presRels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0]);
      const t = /Target="([^"]+)"/.exec(m[0]);
      if (id && t && /slides\/slide\d+\.xml$/.test(t[1]))
        target[id[1]] = `ppt/${t[1].replace(/^\/?ppt\//, '').replace(/^\.\.\//, '')}`;
    }
    for (const m of pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
      if (target[m[1]]) order.push(target[m[1]]);
    }
  }
  if (!order.length) {
    order = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }
  const slides: SlideView[] = [];
  for (const p of order.slice(0, VIEWER_PPTX_MAX_SLIDES)) {
    const xml = (await read(p)) || '';
    const relsPath = p.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const rels = (await read(relsPath)) || '';
    const images: { mime: string; data: Buffer }[] = [];
    let notes: string[] = [];
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const type = /Type="([^"]+)"/.exec(m[0])?.[1] || '';
      const tgt = /Target="([^"]+)"/.exec(m[0])?.[1] || '';
      const full = tgt.startsWith('/') ? tgt.slice(1) : `ppt/${tgt.replace(/^\.\.\//, '')}`;
      if (/\/image$/.test(type) && images.length < 6) {
        const ext = extensionOf(full);
        const mime =
          ext === 'png'
            ? 'image/png'
            : ext === 'gif'
              ? 'image/gif'
              : /^jpe?g$/.test(ext)
                ? 'image/jpeg'
                : '';
        const f = zip.file(full);
        if (mime && f && zipSize(f) <= 8 * MB)
          images.push({ mime, data: await f.async('nodebuffer') });
      } else if (/\/notesSlide$/.test(type)) {
        const nx = await read(full);
        notes = nx ? paragraphs(nx).filter((t) => !/^\d+$/.test(t)) : [];
      }
    }
    slides.push({ index: slides.length + 1, lines: paragraphs(xml), images, notes });
  }
  return slides;
}

/** Word .docx as HTML (mammoth); pictures stay inline as data: images. */
export async function docxToHtml(
  mammoth: any,
  buf: Buffer
): Promise<{ html: string; messages: number }> {
  const r = await mammoth.convertToHtml({ buffer: buf });
  return { html: String(r.value || ''), messages: (r.messages || []).length };
}

export type EmlView = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  html: string | null;
  text: string;
  attachments: { filename: string; contentType: string; size: number }[];
};

/** A forwarded / attached e-mail (.eml): headers, body and its attachment list. */
export function emlView(buf: Buffer): EmlView {
  const m = parseOfflineMail(buf);
  return {
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    html: m.html,
    text: m.text,
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}
