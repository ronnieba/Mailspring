/**
 * Offline experiment: PowerPoint .pptx → slide model for the built-in viewer.
 * Real slides: positioned text boxes with fonts/sizes/colours/bullets,
 * pictures (png/jpg/gif), basic shapes (rect, rounded, ellipse, arrows,
 * polygons…), lines, tables, backgrounds, placeholders inherited from the
 * layout and master, theme colours. Everything is parsed locally from the
 * file's XML; nothing runs and nothing is loaded from the network. Colours
 * and fonts are validated; text is rendered as plain text by React.
 * Not supported (shown as a labelled box): charts, SmartArt, EMF/WMF
 * pictures, video, custom geometry paths (drawn as their box).
 */
import { extensionOf } from './offline-attachments';

const EMU_PER_PT = 12700;
const MB = 1024 * 1024;
export const PPTX_MAX_SLIDES = 300;
export const PPTX_MAX_IMAGE_BYTES = 12 * MB;
export const PPTX_MAX_TOTAL_IMAGE_BYTES = 120 * MB;
export const PPTX_MAX_ITEMS_PER_SLIDE = 400;

// ---- tiny XML reader (well-formed OOXML only) ---------------------------

export type XNode = { n: string; a: { [k: string]: string }; c: XNode[]; t: string };

function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch (e) {
    return '';
  }
}

export function parseXml(xml: string): XNode {
  const root: XNode = { n: '#root', a: {}, c: [], t: '' };
  const stack: XNode[] = [root];
  const src = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    );
  const re =
    /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      top.t += decodeEntities(m[5]);
      continue;
    }
    if (m[1]) {
      if (stack.length > 1 && top.n === m[2]) stack.pop();
      continue;
    }
    const a: { [k: string]: string } = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = ar.exec(m[3] || '')))
      a[am[1]] = decodeEntities(am[2] !== undefined ? am[2] : am[3]);
    const node: XNode = { n: m[2], a, c: [], t: '' };
    top.c.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

const local = (n: string) => n.slice(n.indexOf(':') + 1);
export function kid(node: XNode | null | undefined, name: string): XNode | null {
  if (!node) return null;
  for (const c of node.c) if (c.n === name || local(c.n) === name) return c;
  return null;
}
export function kids(node: XNode | null | undefined, name: string): XNode[] {
  if (!node) return [];
  return node.c.filter((c) => c.n === name || local(c.n) === name);
}
export function path(node: XNode | null | undefined, ...names: string[]): XNode | null {
  let cur: XNode | null | undefined = node;
  for (const n of names) {
    cur = kid(cur, n);
    if (!cur) return null;
  }
  return cur || null;
}
function num(v: string | undefined, d = 0): number {
  const n = v === undefined ? NaN : Number(v);
  return isFinite(n) ? n : d;
}

// ---- colours ------------------------------------------------------------

type Theme = {
  colors: { [k: string]: string };
  majorFont: string;
  minorFont: string;
};

const PRESET_COLORS: { [k: string]: string } = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
  grey: '808080',
  orange: 'FFA500',
  purple: '800080',
  navy: '000080',
  darkBlue: '00008B',
  lightGray: 'D3D3D3',
  darkGray: 'A9A9A9',
};

function hexToRgb(h: string): [number, number, number] {
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const clamp = (v: number, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, v));

/** A colour element (srgbClr / schemeClr / …) → CSS colour, or null. */
function colorOf(node: XNode | null, ctx: Ctx, phClr?: string | null): string | null {
  if (!node) return null;
  let hex: string | null = null;
  const name = local(node.n);
  if (name === 'srgbClr') hex = /^[0-9a-fA-F]{6}$/.test(node.a.val || '') ? node.a.val : null;
  else if (name === 'sysClr')
    hex = /^[0-9a-fA-F]{6}$/.test(node.a.lastClr || '')
      ? node.a.lastClr
      : node.a.val === 'window'
        ? 'FFFFFF'
        : '000000';
  else if (name === 'prstClr') hex = PRESET_COLORS[node.a.val] || null;
  else if (name === 'scrgbClr')
    hex = [node.a.r, node.a.g, node.a.b]
      .map((v) =>
        Math.round(clamp((num(v) / 100000) * 255))
          .toString(16)
          .padStart(2, '0')
      )
      .join('');
  else if (name === 'schemeClr') {
    const v = node.a.val;
    if (v === 'phClr') {
      if (phClr) hex = phClr.replace('#', '').slice(0, 6);
    } else {
      const mapped = ctx.clrMap[v] || v;
      hex = ctx.theme.colors[mapped] || ctx.theme.colors[v] || null;
    }
  } else if (name === 'hslClr') {
    const rgb = hslToRgb([
      num(node.a.hue) / 21600000,
      num(node.a.sat) / 100000,
      num(node.a.lum) / 100000,
    ]);
    hex = rgb.map((x) => Math.round(clamp(x)).toString(16).padStart(2, '0')).join('');
  }
  if (!hex) return null;
  let rgb = hexToRgb(hex);
  let alpha = 1;
  for (const mod of node.c) {
    const v = num(mod.a.val) / 100000;
    switch (local(mod.n)) {
      case 'lumMod': {
        const hsl = rgbToHsl(rgb);
        hsl[2] = clamp(hsl[2] * v, 0, 1);
        rgb = hslToRgb(hsl);
        break;
      }
      case 'lumOff': {
        const hsl = rgbToHsl(rgb);
        hsl[2] = clamp(hsl[2] + v, 0, 1);
        rgb = hslToRgb(hsl);
        break;
      }
      case 'tint':
        rgb = rgb.map((c) => c + (255 - c) * (1 - v)) as [number, number, number];
        break;
      case 'shade':
        rgb = rgb.map((c) => c * v) as [number, number, number];
        break;
      case 'alpha':
        alpha = clamp(v, 0, 1);
        break;
    }
  }
  const [r, g, b] = rgb.map((c) => Math.round(clamp(c)));
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha.toFixed(3)})` : `rgb(${r},${g},${b})`;
}

function firstColor(node: XNode | null, ctx: Ctx, phClr?: string | null): string | null {
  if (!node) return null;
  for (const c of node.c) {
    if (/Clr$/.test(local(c.n))) return colorOf(c, ctx, phClr);
  }
  return null;
}

// ---- model ---------------------------------------------------------------

export type PptxRun = {
  text: string;
  size: number; // pt
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  color: string | null;
  font: string | null;
  baseline: number; // superscript/subscript %
  br?: boolean;
};
export type PptxPara = {
  runs: PptxRun[];
  align: 'left' | 'center' | 'right' | 'justify' | 'start';
  rtl: boolean;
  level: number;
  bullet: string | null;
  bulletColor: string | null;
  marL: number; // EMU
  indent: number; // EMU
  spaceBefore: number; // pt
  spaceAfter: number; // pt
  lineSpacing: number; // multiple (1 = single)
  emptySize: number; // pt, for empty lines
};
export type PptxBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
};
export type PptxText = {
  paras: PptxPara[];
  anchor: 'top' | 'middle' | 'bottom';
  inset: [number, number, number, number]; // l t r b EMU
  vertical: boolean;
  fontScale: number;
  wrap: boolean;
};
export type PptxItem =
  | ({
      kind: 'shape';
      geom: string;
      fill: string | null;
      line: PptxLine | null;
      text: PptxText | null;
      image: string | null;
    } & PptxBox)
  | ({
      kind: 'pic';
      src: string | null;
      label: string;
      crop: [number, number, number, number];
      line: PptxLine | null;
    } & PptxBox)
  | ({ kind: 'line'; line: PptxLine; headEnd: boolean; tailEnd: boolean } & PptxBox)
  | ({ kind: 'table'; cols: number[]; rows: PptxRow[] } & PptxBox)
  | ({ kind: 'unsupported'; label: string } & PptxBox);
export type PptxLine = { color: string; width: number; dash: boolean };
export type PptxCell = {
  text: PptxText;
  fill: string | null;
  colSpan: number;
  rowSpan: number;
  hidden: boolean;
};
export type PptxRow = { h: number; cells: PptxCell[] };
export type PptxSlide = {
  index: number;
  hidden: boolean;
  background: string | null; // CSS colour or gradient
  backgroundImage: string | null; // data: URL
  items: PptxItem[];
  text: string[];
  notes: string[];
};
export type PptxDeck = { width: number; height: number; slides: PptxSlide[]; truncated: boolean };

// ---- parts / context ------------------------------------------------------

type Part = { path: string; xml: XNode; rels: { [id: string]: { type: string; target: string } } };

type Ctx = {
  zip: any;
  theme: Theme;
  clrMap: { [k: string]: string };
  imageBudget: { used: number };
  imageCache: Map<string, string | null>;
  parts: Map<string, Part | null>;
  defaultText: XNode | null;
};

function zipSize(f: any): number {
  return (
    (f && f._data && typeof f._data.uncompressedSize === 'number' && f._data.uncompressedSize) || 0
  );
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') dir.pop();
    else if (seg && seg !== '.') dir.push(seg);
  }
  return dir.join('/');
}

async function readText(zip: any, p: string, max = 8 * MB): Promise<string | null> {
  const f = zip.file(p);
  if (!f || zipSize(f) > max) return null;
  return f.async('string');
}

async function loadPart(ctx: Ctx, p: string): Promise<Part | null> {
  if (ctx.parts.has(p)) return ctx.parts.get(p)!;
  const txt = await readText(ctx.zip, p);
  let part: Part | null = null;
  if (txt) {
    const relsPath = p.replace(/([^/]+)$/, '_rels/$1.rels');
    const relsTxt = await readText(ctx.zip, relsPath);
    const rels: Part['rels'] = {};
    if (relsTxt) {
      for (const r of kids(kid(parseXml(relsTxt), 'Relationships'), 'Relationship')) {
        if (r.a.Id && r.a.Target && r.a.TargetMode !== 'External')
          rels[r.a.Id] = { type: r.a.Type || '', target: resolveTarget(p, r.a.Target) };
      }
    }
    part = { path: p, xml: parseXml(txt), rels };
  }
  ctx.parts.set(p, part);
  return part;
}

function relOfType(part: Part, suffix: string): string | null {
  for (const r of Object.values(part.rels)) if (r.type.endsWith(suffix)) return r.target;
  return null;
}

const IMAGE_MIME: { [ext: string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

async function imageData(ctx: Ctx, part: Part, rid: string | undefined): Promise<string | null> {
  if (!rid || !part.rels[rid]) return null;
  const target = part.rels[rid].target;
  if (ctx.imageCache.has(target)) return ctx.imageCache.get(target)!;
  let url: string | null = null;
  const mime = IMAGE_MIME[extensionOf(target)];
  const f = ctx.zip.file(target);
  const size = zipSize(f);
  if (
    mime &&
    f &&
    size <= PPTX_MAX_IMAGE_BYTES &&
    ctx.imageBudget.used + size <= PPTX_MAX_TOTAL_IMAGE_BYTES
  ) {
    const buf: Buffer = await f.async('nodebuffer');
    ctx.imageBudget.used += buf.length;
    url = `data:${mime};base64,${buf.toString('base64')}`;
  }
  ctx.imageCache.set(target, url);
  return url;
}

// ---- inheritance chain for a shape ----------------------------------------

type Layer = { part: Part; sp: XNode | null }; // slide / layout / master versions of a placeholder

function phOf(sp: XNode): XNode | null {
  return (
    path(sp, 'nvSpPr', 'nvPr', 'ph') ||
    path(sp, 'nvPicPr', 'nvPr', 'ph') ||
    path(sp, 'nvGraphicFramePr', 'nvPr', 'ph')
  );
}

function normType(t: string | undefined): string {
  if (!t) return 'body';
  if (t === 'ctrTitle') return 'title';
  if (t === 'subTitle' || t === 'obj') return 'body';
  return t;
}

function findPlaceholder(part: Part | null, ph: XNode): XNode | null {
  if (!part) return null;
  const tree =
    path(part.xml, 'sldLayout', 'cSld', 'spTree') || path(part.xml, 'sldMaster', 'cSld', 'spTree');
  if (!tree) return null;
  const all = tree.c.filter((c) => /^(sp|pic|graphicFrame)$/.test(local(c.n)) && phOf(c));
  const type = ph.a.type;
  const idx = ph.a.idx;
  if (idx !== undefined) {
    const byIdx = all.find((c) => phOf(c)!.a.idx === idx);
    if (byIdx) return byIdx;
  }
  const exact = all.find(
    (c) => (phOf(c)!.a.type || 'body') === (type || 'body') && (!idx || !phOf(c)!.a.idx)
  );
  if (exact) return exact;
  return all.find((c) => normType(phOf(c)!.a.type) === normType(type)) || null;
}

function xfrmOf(sp: XNode | null): XNode | null {
  if (!sp) return null;
  return path(sp, 'spPr', 'xfrm') || path(sp, 'grpSpPr', 'xfrm') || kid(sp, 'xfrm');
}

function boxFromXfrm(x: XNode): PptxBox {
  const off = kid(x, 'off');
  const ext = kid(x, 'ext');
  return {
    x: num(off?.a.x),
    y: num(off?.a.y),
    w: num(ext?.a.cx),
    h: num(ext?.a.cy),
    rot: num(x.a.rot) / 60000,
    flipH: x.a.flipH === '1',
    flipV: x.a.flipV === '1',
  };
}

type GroupTf = { ox: number; oy: number; sx: number; sy: number; cx: number; cy: number };
const IDENTITY: GroupTf = { ox: 0, oy: 0, sx: 1, sy: 1, cx: 0, cy: 0 };
function applyTf(b: PptxBox, t: GroupTf): PptxBox {
  return {
    ...b,
    x: t.ox + (b.x - t.cx) * t.sx,
    y: t.oy + (b.y - t.cy) * t.sy,
    w: b.w * t.sx,
    h: b.h * t.sy,
  };
}

// ---- text ---------------------------------------------------------------------

type Ph = { kind: 'title' | 'body' | 'other' };

function lvlNodes(lst: XNode | null, level: number): XNode[] {
  if (!lst) return [];
  const n = kid(lst, `lvl${level + 1}pPr`);
  const d = kid(lst, 'defPPr');
  return [n, d].filter(Boolean) as XNode[];
}

function textChain(
  ctx: Ctx,
  layers: Layer[],
  phKind: Ph['kind'],
  level: number,
  shapeLst: XNode | null,
  masterPart: Part | null
): XNode[] {
  const chain: XNode[] = [];
  chain.push(...lvlNodes(shapeLst, level));
  for (const l of layers.slice(1)) chain.push(...lvlNodes(path(l.sp, 'txBody', 'lstStyle'), level));
  if (masterPart) {
    const styles = path(masterPart.xml, 'sldMaster', 'txStyles');
    const style = kid(
      styles,
      phKind === 'title' ? 'titleStyle' : phKind === 'body' ? 'bodyStyle' : 'otherStyle'
    );
    chain.push(...lvlNodes(style, level));
  }
  chain.push(...lvlNodes(ctx.defaultText, level));
  return chain;
}

function pick<T>(chain: XNode[], get: (n: XNode) => T | null | undefined): T | null {
  for (const n of chain) {
    const v = get(n);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

const SAFE_FONT = /^[\w .'-]{1,60}$/;
function fontName(ctx: Ctx, rPr: XNode | null): string | null {
  const latin = kid(rPr, 'latin') || kid(rPr, 'cs');
  let f = latin?.a.typeface;
  if (!f) return null;
  if (f === '+mj-lt' || f === '+mj-cs') f = ctx.theme.majorFont;
  else if (f === '+mn-lt' || f === '+mn-cs') f = ctx.theme.minorFont;
  return f && SAFE_FONT.test(f) ? f : null;
}

function spacing(n: XNode | null): number | null {
  if (!n) return null;
  const pts = kid(n, 'spcPts');
  if (pts) return num(pts.a.val) / 100;
  const pct = kid(n, 'spcPct');
  if (pct) return (num(pct.a.val) / 100000) * 12; // approx. of one line at 12pt
  return null;
}

function parseText(
  ctx: Ctx,
  txBody: XNode | null,
  layers: Layer[],
  phKind: Ph['kind'],
  masterPart: Part | null,
  styleFontColor: string | null,
  tableCell = false
): PptxText | null {
  if (!txBody) return null;
  const bodyPrs = [
    kid(txBody, 'bodyPr'),
    ...layers.slice(1).map((l) => path(l.sp, 'txBody', 'bodyPr')),
  ].filter(Boolean) as XNode[];
  const bp = (k: string) => pick(bodyPrs, (n) => n.a[k]);
  const anchorV = bp('anchor');
  const fit = path(txBody, 'bodyPr', 'normAutofit');
  const fontScale = fit && fit.a.fontScale ? num(fit.a.fontScale, 100000) / 100000 : 1;
  const lnReduce = fit && fit.a.lnSpcReduction ? num(fit.a.lnSpcReduction) / 100000 : 0;
  const defIns = tableCell ? [91440, 45720, 91440, 45720] : [91440, 45720, 91440, 45720];
  const inset: [number, number, number, number] = [
    num(bp('lIns') ?? undefined, defIns[0]),
    num(bp('tIns') ?? undefined, defIns[1]),
    num(bp('rIns') ?? undefined, defIns[2]),
    num(bp('bIns') ?? undefined, defIns[3]),
  ];
  const vert = bp('vert');
  const shapeLst = kid(txBody, 'lstStyle');
  const paras: PptxPara[] = [];
  const counters: number[] = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const level = Math.min(8, num(pPr?.a.lvl));
    const chain = [pPr, ...textChain(ctx, layers, phKind, level, shapeLst, masterPart)].filter(
      Boolean
    ) as XNode[];
    const defRPrs = chain.map((n) => kid(n, 'defRPr')).filter(Boolean) as XNode[];
    const algn = pick(chain, (n) => n.a.algn) || (tableCell ? 'l' : 'l');
    const rtl = pick(chain, (n) => n.a.rtl) === '1';
    const runs: PptxRun[] = [];
    const endSize =
      num(kid(p, 'endParaRPr')?.a.sz ?? pick(defRPrs, (n) => n.a.sz) ?? undefined, 1800) / 100;
    for (const r of p.c) {
      const name = local(r.n);
      if (name !== 'r' && name !== 'br' && name !== 'fld') continue;
      const rPr = kid(r, 'rPr');
      const all = [rPr, ...defRPrs].filter(Boolean) as XNode[];
      const flag = (k: string) => {
        const v = pick(all, (n) => n.a[k]);
        return v === '1' || v === 'true';
      };
      // Colour: the run / paragraph / shape's own list style first, then the
      // shape style's font colour, then the layout / master / theme defaults.
      const own = [
        rPr,
        kid(pPr, 'defRPr'),
        ...lvlNodes(shapeLst, level).map((n) => kid(n, 'defRPr')),
      ].filter(Boolean) as XNode[];
      const ownFill = pick(own, (n) => kid(n, 'solidFill'));
      const inhFill = pick(all, (n) => kid(n, 'solidFill'));
      const color =
        (ownFill && firstColor(ownFill, ctx)) ||
        styleFontColor ||
        (inhFill && firstColor(inhFill, ctx)) ||
        null;
      const run: PptxRun = {
        text: name === 'br' ? '' : (kid(r, 't')?.t || '').replace(/\t/g, '    '),
        size: num(pick(all, (n) => n.a.sz) ?? undefined, 1800) / 100,
        b: flag('b'),
        i: flag('i'),
        u: !!pick(all, (n) => (n.a.u && n.a.u !== 'none' ? n.a.u : null)),
        strike: !!pick(all, (n) => (n.a.strike && n.a.strike !== 'noStrike' ? n.a.strike : null)),
        color,
        font: pick(all, (n) => fontName(ctx, n)),
        baseline: num(pick(all, (n) => n.a.baseline) ?? undefined, 0) / 1000,
        br: name === 'br',
      };
      runs.push(run);
    }
    // Bullets
    let bullet: string | null = null;
    let bulletColor: string | null = null;
    const buNone = pick(chain, (n) =>
      kid(n, 'buNone') ? 'none' : kid(n, 'buChar') || kid(n, 'buAutoNum') ? 'some' : null
    );
    const hasText = runs.some((r) => r.text.trim());
    if (buNone === 'some' && hasText) {
      const ch = pick(chain, (n) => kid(n, 'buChar')?.a.char);
      const auto = pick(chain, (n) => kid(n, 'buAutoNum')?.a.type);
      if (auto && !ch) {
        counters.length = level + 1;
        counters[level] =
          (counters[level] ||
            num(pick(chain, (n) => kid(n, 'buAutoNum')?.a.startAt) ?? undefined, 1) - 1) + 1;
        const n = counters[level];
        bullet = /alpha/i.test(auto)
          ? `${String.fromCharCode((/UcPeriod|Uc/.test(auto) ? 64 : 96) + ((n - 1) % 26) + 1)}.`
          : /roman/i.test(auto)
            ? `${toRoman(n, /Uc/.test(auto))}.`
            : `${n}.`;
      } else {
        bullet = ch && ch.length <= 2 ? mapSymbolBullet(ch) : '•';
      }
      const bc = pick(chain, (n) => kid(n, 'buClr'));
      bulletColor = bc ? firstColor(bc, ctx) : null;
    }
    const lnSpc = pick(chain, (n) => kid(n, 'lnSpc'));
    const lnPct =
      lnSpc && kid(lnSpc, 'spcPct') ? num(kid(lnSpc, 'spcPct')!.a.val, 100000) / 100000 : 1;
    paras.push({
      runs,
      align:
        ({ l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' } as any)[algn] ||
        'left',
      rtl,
      level,
      bullet,
      bulletColor,
      marL: num(pick(chain, (n) => n.a.marL) ?? undefined, 0),
      indent: num(pick(chain, (n) => n.a.indent) ?? undefined, 0),
      spaceBefore: spacing(pick(chain, (n) => kid(n, 'spcBef'))) ?? 0,
      spaceAfter: spacing(pick(chain, (n) => kid(n, 'spcAft'))) ?? 0,
      lineSpacing: Math.max(0.5, lnPct - lnReduce),
      emptySize: endSize,
    });
  }
  return {
    paras,
    anchor: anchorV === 'ctr' ? 'middle' : anchorV === 'b' ? 'bottom' : 'top',
    inset,
    vertical: !!vert && vert !== 'horz',
    fontScale,
    wrap: bp('wrap') !== 'none',
  };
}

function mapSymbolBullet(ch: string): string {
  // Wingdings / Symbol private-use bullets → plain look-alikes.
  const map: { [c: string]: string } = {
    '\u00a7': '▪',
    '\u00d8': '➢',
    '\u00fc': '✓',
    q: '❑',
    v: '❖',
    n: '■',
    l: '●',
    '\u0178': '•',
    '\uf0a7': '▪',
    '\uf0b7': '•',
    '\uf0d8': '➢',
    '\uf0fc': '✓',
  };
  return map[ch] || ch;
}

function toRoman(n: number, upper: boolean): string {
  const t: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let s = '';
  for (const [v, r] of t)
    while (n >= v) {
      s += r;
      n -= v;
    }
  return upper ? s.toUpperCase() : s;
}

// ---- fills / lines -------------------------------------------------------------

function fillOf(ctx: Ctx, spPr: XNode | null, style: XNode | null): string | null | undefined {
  // undefined = not specified here (inherit); null = no fill
  if (spPr) {
    if (kid(spPr, 'noFill')) return null;
    const solid = kid(spPr, 'solidFill');
    if (solid) return firstColor(solid, ctx);
    const grad = kid(spPr, 'gradFill');
    if (grad) return gradientCss(ctx, grad);
    if (kid(spPr, 'grpFill')) return undefined;
  }
  if (style) {
    const ref = kid(style, 'fillRef');
    if (ref && num(ref.a.idx) > 0) return firstColor(ref, ctx);
    if (ref && num(ref.a.idx) === 0) return null;
  }
  return undefined;
}

function gradientCss(ctx: Ctx, grad: XNode): string | null {
  const stops = kids(kid(grad, 'gsLst'), 'gs')
    .map((g) => ({ pos: num(g.a.pos) / 1000, c: firstColor(g, ctx) }))
    .filter((s) => s.c)
    .sort((a, b) => a.pos - b.pos);
  if (!stops.length) return null;
  if (stops.length === 1) return stops[0].c;
  const lin = kid(grad, 'lin');
  const ang = lin ? num(lin.a.ang) / 60000 + 90 : 180;
  return `linear-gradient(${ang.toFixed(1)}deg, ${stops.map((s) => `${s.c} ${s.pos.toFixed(1)}%`).join(', ')})`;
}

function lineOf(ctx: Ctx, spPr: XNode | null, style: XNode | null): PptxLine | null | undefined {
  const ln = kid(spPr, 'ln');
  const styleRef = kid(style, 'lnRef');
  if (ln) {
    if (kid(ln, 'noFill')) return null;
    const solid = kid(ln, 'solidFill');
    const color = solid
      ? firstColor(solid, ctx)
      : styleRef && num(styleRef.a.idx) > 0
        ? firstColor(styleRef, ctx)
        : null;
    if (!color) return solid || (styleRef && num(styleRef.a.idx) > 0) ? null : undefined;
    const dash = kid(ln, 'prstDash')?.a.val;
    return { color, width: num(ln.a.w, 12700), dash: !!dash && dash !== 'solid' };
  }
  if (styleRef && num(styleRef.a.idx) > 0) {
    const c = firstColor(styleRef, ctx);
    return c
      ? { color: c, width: 12700 * Math.max(1, num(styleRef.a.idx)) * 0.75, dash: false }
      : undefined;
  }
  return undefined;
}

// ---- shapes ---------------------------------------------------------------------

type SlideParts = { slide: Part; layout: Part | null; master: Part | null };

async function shapeItems(
  ctx: Ctx,
  part: Part,
  tree: XNode,
  tf: GroupTf,
  parts: SlideParts,
  isSlide: boolean,
  out: PptxItem[],
  text: string[]
) {
  for (const el of tree.c) {
    if (out.length >= PPTX_MAX_ITEMS_PER_SLIDE) return;
    const name = local(el.n);
    const cNvPr = path(
      el,
      `nv${name === 'sp' ? 'Sp' : name === 'pic' ? 'Pic' : name === 'grpSp' ? 'GrpSp' : name === 'cxnSp' ? 'CxnSp' : 'GraphicFrame'}Pr`,
      'cNvPr'
    );
    if (cNvPr?.a.hidden === '1') continue;
    if (name === 'grpSp') {
      const x = path(el, 'grpSpPr', 'xfrm');
      if (!x) {
        await shapeItems(ctx, part, el, tf, parts, isSlide, out, text);
        continue;
      }
      const off = kid(x, 'off');
      const ext = kid(x, 'ext');
      const chOff = kid(x, 'chOff');
      const chExt = kid(x, 'chExt');
      const sx = num(chExt?.a.cx) ? num(ext?.a.cx) / num(chExt?.a.cx) : 1;
      const sy = num(chExt?.a.cy) ? num(ext?.a.cy) / num(chExt?.a.cy) : 1;
      const inner: GroupTf = {
        ox: num(off?.a.x),
        oy: num(off?.a.y),
        sx,
        sy,
        cx: num(chOff?.a.x),
        cy: num(chOff?.a.y),
      };
      // compose: child → group space → parent
      const composed: GroupTf = {
        ox: tf.ox + (inner.ox - tf.cx) * tf.sx,
        oy: tf.oy + (inner.oy - tf.cy) * tf.sy,
        sx: inner.sx * tf.sx,
        sy: inner.sy * tf.sy,
        cx: inner.cx,
        cy: inner.cy,
      };
      await shapeItems(ctx, part, el, composed, parts, isSlide, out, text);
      continue;
    }
    if (!/^(sp|pic|cxnSp|graphicFrame)$/.test(name)) continue;
    const ph = phOf(el);
    // Layout / master: only decorations, never placeholders.
    if (!isSlide && ph) continue;
    const layers: Layer[] = [{ part, sp: el }];
    if (ph && isSlide) {
      const lsp = findPlaceholder(parts.layout, ph);
      layers.push({ part: parts.layout!, sp: lsp });
      const mph = lsp ? phOf(lsp) || ph : ph;
      layers.push({ part: parts.master!, sp: findPlaceholder(parts.master, mph) });
    }
    const xf = pick(layers.map((l) => l.sp).filter(Boolean) as XNode[], (n) => xfrmOf(n));
    if (!xf) continue;
    const box = applyTf(boxFromXfrm(xf), tf);
    const phType = ph ? ph.a.type : undefined;
    const phKind: Ph['kind'] = !ph
      ? 'other'
      : phType === 'title' || phType === 'ctrTitle'
        ? 'title'
        : /^(dt|ftr|sldNum|hdr)$/.test(phType || '')
          ? 'other'
          : 'body';
    if (
      ph &&
      /^(dt|ftr|sldNum|hdr)$/.test(phType || '') &&
      !kids(kid(el, 'txBody'), 'p').some((p) => kids(p, 'r').length)
    )
      continue;
    const style = kid(el, 'style');
    if (name === 'pic') {
      const blip = path(el, 'blipFill', 'blip');
      const rid = blip?.a['r:embed'];
      const src = await imageData(ctx, part, rid);
      const sr = path(el, 'blipFill', 'srcRect');
      const ext = rid && part.rels[rid] ? extensionOf(part.rels[rid].target).toUpperCase() : '';
      out.push({
        kind: 'pic',
        ...box,
        src,
        label: src ? '' : ext ? `🖼️ ${ext}` : '🖼️',
        crop: [
          num(sr?.a.l) / 100000,
          num(sr?.a.t) / 100000,
          num(sr?.a.r) / 100000,
          num(sr?.a.b) / 100000,
        ],
        line: lineOf(ctx, kid(el, 'spPr'), style) || null,
      });
      continue;
    }
    if (name === 'cxnSp') {
      const ln = lineOf(ctx, kid(el, 'spPr'), style);
      const lnNode = path(el, 'spPr', 'ln');
      if (ln)
        out.push({
          kind: 'line',
          ...box,
          line: ln,
          headEnd:
            !!kid(lnNode, 'headEnd') &&
            kid(lnNode, 'headEnd')!.a.type !== 'none' &&
            !!kid(lnNode, 'headEnd')!.a.type,
          tailEnd:
            !!kid(lnNode, 'tailEnd') &&
            kid(lnNode, 'tailEnd')!.a.type !== 'none' &&
            !!kid(lnNode, 'tailEnd')!.a.type,
        });
      continue;
    }
    if (name === 'graphicFrame') {
      const gd = path(el, 'graphic', 'graphicData');
      const tbl = kid(gd, 'tbl');
      if (tbl) {
        out.push(tableItem(ctx, tbl, box, parts.master, text));
      } else {
        const uri = gd?.a.uri || '';
        const label = /chart/.test(uri) ? '📊' : /diagram/.test(uri) ? '🔷' : '▫️';
        out.push({ kind: 'unsupported', ...box, label });
      }
      continue;
    }
    // sp
    const spPrs = layers.map((l) => kid(l.sp, 'spPr'));
    let fill: string | null | undefined;
    for (let i = 0; i < layers.length && fill === undefined; i++)
      fill = fillOf(ctx, spPrs[i], i === 0 ? style : kid(layers[i].sp, 'style'));
    let line: PptxLine | null | undefined;
    for (let i = 0; i < layers.length && line === undefined; i++)
      line = lineOf(ctx, spPrs[i], i === 0 ? style : kid(layers[i].sp, 'style'));
    let image: string | null = null;
    const bf = kid(kid(el, 'spPr'), 'blipFill');
    if (bf) image = await imageData(ctx, part, path(bf, 'blip')?.a['r:embed']);
    const geom =
      pick(spPrs.filter(Boolean) as XNode[], (n) => kid(n, 'prstGeom')?.a.prst) ||
      pick(spPrs.filter(Boolean) as XNode[], (n) => (kid(n, 'custGeom') ? 'cust' : null)) ||
      'rect';
    const fontRefColor = style ? firstColor(kid(style, 'fontRef'), ctx) : null;
    const txt = parseText(ctx, kid(el, 'txBody'), layers, phKind, parts.master, fontRefColor);
    const hasText = !!txt && txt.paras.some((p) => p.runs.some((r) => r.text.trim()));
    if (!hasText && !fill && !line && !image) continue;
    if (hasText)
      for (const p of txt!.paras) {
        const t = p.runs
          .map((r) => (r.br ? '\n' : r.text))
          .join('')
          .trim();
        if (t) text.push(t);
      }
    out.push({
      kind: 'shape',
      ...box,
      geom,
      fill: fill || null,
      line: line || null,
      text: hasText ? txt : null,
      image,
    });
  }
}

function tableItem(
  ctx: Ctx,
  tbl: XNode,
  box: PptxBox,
  master: Part | null,
  text: string[]
): PptxItem {
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(c.a.w));
  const rows: PptxRow[] = [];
  for (const tr of kids(tbl, 'tr')) {
    const cells: PptxCell[] = [];
    for (const tc of kids(tr, 'tc')) {
      const tcPr = kid(tc, 'tcPr');
      const solid = kid(tcPr, 'solidFill');
      const t = parseText(
        ctx,
        kid(tc, 'txBody'),
        [{ part: null as any, sp: null }],
        'other',
        master,
        null,
        true
      ) || {
        paras: [],
        anchor: 'top',
        inset: [91440, 45720, 91440, 45720],
        vertical: false,
        fontScale: 1,
        wrap: true,
      };
      if (tcPr) {
        t.inset = [
          num(tcPr.a.marL, 91440),
          num(tcPr.a.marT, 45720),
          num(tcPr.a.marR, 91440),
          num(tcPr.a.marB, 45720),
        ];
        t.anchor = tcPr.a.anchor === 'ctr' ? 'middle' : tcPr.a.anchor === 'b' ? 'bottom' : 'top';
      }
      for (const p of t.paras) {
        const s = p.runs
          .map((r) => r.text)
          .join('')
          .trim();
        if (s) text.push(s);
      }
      cells.push({
        text: t,
        fill: solid ? firstColor(solid, ctx) : null,
        colSpan: Math.max(1, num(tc.a.gridSpan, 1)),
        rowSpan: Math.max(1, num(tc.a.rowSpan, 1)),
        hidden: tc.a.hMerge === '1' || tc.a.vMerge === '1',
      });
    }
    rows.push({ h: num(tr.a.h), cells });
  }
  return { kind: 'table', ...box, cols, rows };
}

// ---- backgrounds ------------------------------------------------------------------

async function backgroundOf(
  ctx: Ctx,
  parts: Part[]
): Promise<{ color: string | null; image: string | null }> {
  for (const part of parts) {
    const root = part.xml.c[0];
    const bg = path(root, 'cSld', 'bg');
    if (!bg) continue;
    const bgPr = kid(bg, 'bgPr');
    if (bgPr) {
      const solid = kid(bgPr, 'solidFill');
      if (solid) return { color: firstColor(solid, ctx), image: null };
      const grad = kid(bgPr, 'gradFill');
      if (grad) return { color: gradientCss(ctx, grad), image: null };
      const blip = path(bgPr, 'blipFill', 'blip');
      if (blip) return { color: null, image: await imageData(ctx, part, blip.a['r:embed']) };
      if (kid(bgPr, 'noFill')) return { color: null, image: null };
    }
    const ref = kid(bg, 'bgRef');
    if (ref) return { color: firstColor(ref, ctx), image: null };
  }
  return { color: null, image: null };
}

// ---- theme ---------------------------------------------------------------------------

function parseTheme(part: Part | null): Theme {
  const theme: Theme = { colors: {}, majorFont: 'Calibri Light', minorFont: 'Calibri' };
  if (!part) return theme;
  const te = path(part.xml, 'theme', 'themeElements');
  const scheme = kid(te, 'clrScheme');
  for (const c of scheme ? scheme.c : []) {
    const inner = c.c[0];
    if (!inner) continue;
    const v =
      local(inner.n) === 'sysClr'
        ? inner.a.lastClr || (inner.a.val === 'window' ? 'FFFFFF' : '000000')
        : inner.a.val;
    if (/^[0-9a-fA-F]{6}$/.test(v || '')) theme.colors[local(c.n)] = v;
  }
  const fonts = kid(te, 'fontScheme');
  const mj = path(fonts, 'majorFont', 'latin')?.a.typeface;
  const mn = path(fonts, 'minorFont', 'latin')?.a.typeface;
  if (mj && SAFE_FONT.test(mj)) theme.majorFont = mj;
  if (mn && SAFE_FONT.test(mn)) theme.minorFont = mn;
  return theme;
}

const DEFAULT_CLR_MAP = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};

// ---- entry point ------------------------------------------------------------------------

export async function renderPptx(JSZip: any, buf: Buffer): Promise<PptxDeck> {
  const zip = await JSZip.loadAsync(buf);
  const ctx: Ctx = {
    zip,
    theme: { colors: {}, majorFont: 'Calibri Light', minorFont: 'Calibri' },
    clrMap: { ...DEFAULT_CLR_MAP },
    imageBudget: { used: 0 },
    imageCache: new Map(),
    parts: new Map(),
    defaultText: null,
  };
  const pres = await loadPart(ctx, 'ppt/presentation.xml');
  const sz = path(pres?.xml, 'presentation', 'sldSz');
  const width = num(sz?.a.cx, 12192000) || 12192000;
  const height = num(sz?.a.cy, 6858000) || 6858000;
  ctx.defaultText = path(pres?.xml, 'presentation', 'defaultTextStyle');
  let order: string[] = [];
  if (pres) {
    for (const s of kids(path(pres.xml, 'presentation', 'sldIdLst'), 'sldId')) {
      const r = pres.rels[s.a['r:id']];
      if (r) order.push(r.target);
    }
  }
  if (!order.length) {
    order = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }
  const slides: PptxSlide[] = [];
  for (const p of order.slice(0, PPTX_MAX_SLIDES)) {
    const slide = await loadPart(ctx, p);
    if (!slide) continue;
    const layoutPath = relOfType(slide, '/slideLayout');
    const layout = layoutPath ? await loadPart(ctx, layoutPath) : null;
    const masterPath = layout ? relOfType(layout, '/slideMaster') : null;
    const master = masterPath ? await loadPart(ctx, masterPath) : null;
    const themePath = master ? relOfType(master, '/theme') : null;
    ctx.theme = parseTheme(themePath ? await loadPart(ctx, themePath) : null);
    const cm = path(master?.xml, 'sldMaster', 'clrMap');
    ctx.clrMap = { ...DEFAULT_CLR_MAP, ...(cm ? cm.a : {}) };
    const ovr =
      path(slide.xml, 'sld', 'clrMapOvr', 'overrideClrMapping') ||
      path(layout?.xml, 'sldLayout', 'clrMapOvr', 'overrideClrMapping');
    if (ovr) ctx.clrMap = { ...ctx.clrMap, ...ovr.a };
    const parts: SlideParts = { slide, layout, master };
    const bg = await backgroundOf(ctx, [slide, layout, master].filter(Boolean) as Part[]);
    const items: PptxItem[] = [];
    const text: string[] = [];
    const sldRoot = path(slide.xml, 'sld');
    const showMaster =
      sldRoot?.a.showMasterSp !== '0' && path(layout?.xml, 'sldLayout')?.a.showMasterSp !== '0';
    if (master && showMaster) {
      const t = path(master.xml, 'sldMaster', 'cSld', 'spTree');
      if (t) await shapeItems(ctx, master, t, IDENTITY, parts, false, items, []);
    }
    if (layout && sldRoot?.a.showMasterSp !== '0') {
      const t = path(layout.xml, 'sldLayout', 'cSld', 'spTree');
      if (t) await shapeItems(ctx, layout, t, IDENTITY, parts, false, items, []);
    }
    const tree = path(slide.xml, 'sld', 'cSld', 'spTree');
    if (tree) await shapeItems(ctx, slide, tree, IDENTITY, parts, true, items, text);
    let notes: string[] = [];
    const notesPath = relOfType(slide, '/notesSlide');
    if (notesPath) {
      const np = await loadPart(ctx, notesPath);
      const body = np ? path(np.xml, 'notes', 'cSld', 'spTree') : null;
      if (body) {
        for (const sp of kids(body, 'sp')) {
          const ph = phOf(sp);
          if (ph && ph.a.type !== 'body') continue;
          for (const para of kids(kid(sp, 'txBody'), 'p')) {
            const t = kids(para, 'r')
              .map((r) => kid(r, 't')?.t || '')
              .join('')
              .trim();
            if (t && !/^\d+$/.test(t)) notes.push(t);
          }
        }
      }
      notes = notes.slice(0, 200);
    }
    slides.push({
      index: slides.length + 1,
      hidden: sldRoot?.a.show === '0',
      background: bg.color,
      backgroundImage: bg.image,
      items,
      text,
      notes,
    });
  }
  return { width, height, slides, truncated: order.length > PPTX_MAX_SLIDES };
}

// ---- geometry helpers for the view ----------------------------------------------------

/** Polygon points (0..100 box) for preset shapes drawn as SVG; null = CSS box. */
export function presetPolygon(geom: string): string | null {
  const P: { [k: string]: string } = {
    triangle: '50,0 100,100 0,100',
    rtTriangle: '0,0 100,100 0,100',
    diamond: '50,0 100,50 50,100 0,50',
    parallelogram: '25,0 100,0 75,100 0,100',
    trapezoid: '25,0 75,0 100,100 0,100',
    pentagon: '50,0 100,38 81,100 19,100 0,38',
    hexagon: '25,0 75,0 100,50 75,100 25,100 0,50',
    octagon: '29,0 71,0 100,29 100,71 71,100 29,100 0,71 0,29',
    homePlate: '0,0 80,0 100,50 80,100 0,100',
    chevron: '0,0 80,0 100,50 80,100 0,100 20,50',
    rightArrow: '0,25 70,25 70,0 100,50 70,100 70,75 0,75',
    leftArrow: '100,25 30,25 30,0 0,50 30,100 30,75 100,75',
    upArrow: '25,100 25,30 0,30 50,0 100,30 75,30 75,100',
    downArrow: '25,0 75,0 75,70 100,70 50,100 0,70 25,70',
    leftRightArrow: '0,50 20,0 20,25 80,25 80,0 100,50 80,100 80,75 20,75 20,100',
    star5: '50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35',
    plus: '33,0 67,0 67,33 100,33 100,67 67,67 67,100 33,100 33,67 0,67 0,33 33,33',
    mathPlus: '40,10 60,10 60,40 90,40 90,60 60,60 60,90 40,90 40,60 10,60 10,40 40,40',
    flowChartDecision: '50,0 100,50 50,100 0,50',
    flowChartInputOutput: '20,0 100,0 80,100 0,100',
    wedgeRectCallout: '0,0 100,0 100,75 45,75 20,100 25,75 0,75',
  };
  return P[geom] || null;
}

export function presetRadius(geom: string): string | null {
  if (geom === 'ellipse' || geom === 'flowChartConnector' || geom === 'donut') return '50%';
  if (
    geom === 'roundRect' ||
    geom === 'flowChartAlternateProcess' ||
    geom === 'wedgeRoundRectCallout'
  )
    return 'r';
  if (geom === 'snip1Rect' || geom === 'round1Rect' || geom === 'round2SameRect') return 'r';
  return null;
}

export const EMU_PT = EMU_PER_PT;
