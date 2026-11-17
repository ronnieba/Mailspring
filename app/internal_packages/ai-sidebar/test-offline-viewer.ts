#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t205): built-in attachment viewer.
 * Synthetic files of each type, built in memory: PDF (pdf.js), Word .docx
 * (mammoth), Excel .xlsx / CSV (SheetJS, sheet tabs, Hebrew), PowerPoint
 * .pptx (slide outline + pictures, presentation order), SVG sanitizing,
 * sandboxed HTML, text decoding (UTF-8 / UTF-16 / Windows-1255), nested .eml,
 * the size / type guard (dangerous, legacy .doc/.ppt, HEIC), zoom steps,
 * bundled-library licenses, and the UI wiring ("View" first, reads the
 * profile temp copy only). No network, no real profile, no mail content.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-viewer.ts
 */
import fs from 'fs';
import path from 'path';
import {
  THIRD_PARTY_VIEWER_LIBS,
  VIEWER_SHEET_MAX_ROWS,
  canViewInApp,
  columnName,
  decodeTextBytes,
  docxToHtml,
  emlView,
  pptxSlides,
  prettyJson,
  sanitizeSvg,
  sheetsFromBytes,
  svgDataUrl,
  viewerGuard,
  viewerHtmlDocument,
  viewerKindFor,
  zoomStep,
} from './lib/core/offline-viewer';

/* eslint-disable @typescript-eslint/no-var-requires */
const JSZip = require('jszip');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).stack || err}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) {
    throw new Error(msg);
  }
}
const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** A tiny valid PDF with N pages (text drawn with a standard font). */
function syntheticPdf(pages: number): Buffer {
  const objs: string[] = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pages }, (_x, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    );
    const s = `BT /F1 18 Tf 30 100 Td (Synthetic page ${i + 1}) Tj ET`;
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function syntheticDocx(): Promise<Buffer> {
  const z = new JSZip();
  z.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  z.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const p = (t: string, rtl = false) =>
    `<w:p>${rtl ? '<w:pPr><w:bidi/></w:pPr>' : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`;
  z.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      p('מסמך סינתטי לבדיקה', true) +
      p('Synthetic English paragraph') +
      '<w:tbl><w:tr><w:tc>' +
      p('תא א') +
      '</w:tc><w:tc>' +
      p('Cell B') +
      '</w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>'
  );
  return z.generateAsync({ type: 'nodebuffer' });
}

async function syntheticPptx(): Promise<Buffer> {
  const z = new JSZip();
  const ns =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const slide = (lines: string[]) =>
    `<p:sld ${ns}><p:cSld><p:spTree>${lines
      .map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join('')}</p:spTree></p:cSld></p:sld>`;
  // slide2.xml is shown FIRST (presentation order differs from file names).
  z.file(
    'ppt/presentation.xml',
    `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId8"/></p:sldIdLst></p:presentation>`
  );
  z.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'
  );
  z.file('ppt/slides/slide1.xml', slide(['Second slide title', 'Point &amp; detail']));
  z.file('ppt/slides/slide2.xml', slide(['כותרת השקופית הראשונה', 'שורה בעברית']));
  z.file(
    'ppt/slides/_rels/slide2.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'
  );
  z.file('ppt/media/image1.png', PNG_1PX);
  z.file(
    'ppt/notesSlides/notesSlide1.xml',
    `<p:notes ${ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>הערת דובר</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
  );
  return z.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  console.log('offline attachment viewer (t205)');

  await test('type detection and guard: viewable types, dangerous, legacy Office, HEIC, too large', () => {
    const k = (n: string, ct = '') => viewerKindFor(n, ct);
    assert(k('a.pdf') === 'pdf' && k('x', 'application/pdf') === 'pdf', 'pdf');
    for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
      assert(k(`a.${e}`) === 'image', e);
    assert(
      k('a.svg') === 'svg' &&
        k('a.docx') === 'docx' &&
        k('a.xlsx') === 'sheet' &&
        k('a.xls') === 'sheet',
      'svg/docx/xlsx/xls'
    );
    assert(
      k('a.csv') === 'csv' &&
        k('a.pptx') === 'pptx' &&
        k('a.html') === 'html' &&
        k('a.eml') === 'eml',
      'csv/pptx/html/eml'
    );
    assert(k('a.txt') === 'text' && k('a.json') === 'json' && k('a.xml') === 'xml', 'text');
    assert(k('a.doc') === 'legacy-office' && k('a.ppt') === 'legacy-office', 'legacy');
    assert(k('IMG_1.HEIC') === 'heic', 'heic');
    assert(k('invoice.pdf.exe') === 'danger' && k('run.bat') === 'danger', 'danger');
    assert(viewerGuard('setup.exe', '', 10).blocked === 'danger', 'exe blocked');
    assert(viewerGuard('old.doc', '', 10).blocked === 'legacy', 'doc blocked');
    assert(viewerGuard('big.pdf', '', 200 * 1024 * 1024).blocked === 'too-large', 'large guard');
    assert(viewerGuard('ok.pdf', '', 1000).blocked === null, 'pdf ok');
    assert(!canViewInApp('a.zip') && canViewInApp('a.xlsx'), 'canView');
  });

  await test('PDF: pdf.js reads page count of a synthetic 3-page PDF (no network, no eval)', async () => {
    let pdfjs: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pdfjs = require('pdfjs-dist/build/pdf.mjs');
    }
    const task = pdfjs.getDocument({
      data: new Uint8Array(syntheticPdf(3)),
      isEvalSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    assert(doc.numPages === 3, `pages ${doc.numPages}`);
    const page = await doc.getPage(2);
    const tc = await page.getTextContent();
    assert(
      tc.items
        .map((i: any) => i.str)
        .join('')
        .includes('Synthetic page 2'),
      'text of page 2'
    );
    await task.destroy();
  });

  await test('Word .docx: Hebrew + English paragraphs and a table become HTML', async () => {
    const { html } = await docxToHtml(mammoth, await syntheticDocx());
    assert(
      html.includes('מסמך סינתטי לבדיקה') && html.includes('Synthetic English paragraph'),
      'text'
    );
    assert(/<table>/.test(html) && html.includes('תא א'), 'table');
    const doc = viewerHtmlDocument(html, 1.25);
    assert(
      doc.includes("default-src 'none'") &&
        doc.includes('zoom:1.25') &&
        doc.includes('unicode-bidi:plaintext'),
      'sandboxed doc'
    );
  });

  await test('Excel .xlsx: sheet tabs (Hebrew names), values, row cap; CSV in Windows-1255', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['שם', 'סכום'],
        ['אבי', 12.5],
        ['Dana', 7],
      ]),
      'גיליון א'
    );
    const big = Array.from({ length: VIEWER_SHEET_MAX_ROWS + 500 }, (_x, i) => [i, `r${i}`]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(big), 'Data');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const sheets = sheetsFromBytes(XLSX, buf);
    assert(sheets.map((s) => s.name).join('|') === 'גיליון א|Data', 'tabs');
    assert(sheets[0].rows[1][0] === 'אבי' && sheets[0].rows[1][1] === '12.5', 'values');
    assert(sheets[1].rows.length === VIEWER_SHEET_MAX_ROWS && sheets[1].truncatedRows, 'row cap');
    assert(columnName(0) === 'A' && columnName(26) === 'AA', 'column names');
    const xls = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
    assert(sheetsFromBytes(XLSX, xls)[0].rows[1][0] === 'אבי', 'legacy .xls read too');
    // Windows-1255 Hebrew CSV
    const cp1255 = Buffer.from([0xf9, 0xed, 0x2c, 0x31, 0x0a, 0xe0, 0xe1, 0xe9, 0x2c, 0x32]); // "שם,1\nאבי,2"
    const text = decodeTextBytes(cp1255);
    const csv = sheetsFromBytes(XLSX, cp1255, text);
    assert(
      csv[0].rows[0][0] === 'שם' && csv[0].rows[1][0] === 'אבי',
      `csv ${JSON.stringify(csv[0].rows)}`
    );
  });

  await test('PowerPoint .pptx: slides in presentation order, text, picture and notes', async () => {
    const slides = await pptxSlides(JSZip, await syntheticPptx());
    assert(slides.length === 2, `slides ${slides.length}`);
    assert(slides[0].lines[0] === 'כותרת השקופית הראשונה', 'presentation order');
    assert(slides[1].lines.join('|') === 'Second slide title|Point & detail', 'entities decoded');
    assert(slides[0].images.length === 1 && slides[0].images[0].mime === 'image/png', 'picture');
    assert(slides[0].notes.join() === 'הערת דובר', 'notes');
  });

  await test('SVG is cleaned (scripts, handlers, foreign HTML, external links) and shown as an image', () => {
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>' +
      '<foreignObject><iframe src="https://x.test"></iframe></foreignObject>' +
      '<image href="https://tracker.test/p.png"/><a xlink:href="javascript:alert(3)"><rect style="fill:url(https://x.test/a)" width="5" height="5"/></a>' +
      '<use href="#ok"/></svg>';
    const s = sanitizeSvg(evil);
    assert(!/script|onload|foreignObject|https:|javascript:/i.test(s), s);
    assert(s.includes('href="#ok"'), 'local refs kept');
    assert(svgDataUrl(evil).startsWith('data:image/svg+xml;base64,'), 'data url');
  });

  await test('HTML attachment: scripts removed, CSP blocks network, remote images hidden', () => {
    const doc = viewerHtmlDocument(
      '<p>שלום</p><script>alert(1)</script><img src="https://t.test/x.png"><base href="https://t.test/">'
    );
    assert(!/<script/i.test(doc) && !/<base/i.test(doc), 'stripped');
    assert(
      doc.includes("default-src 'none'") && doc.includes('img:not([src^="data:"]){display:none'),
      'csp + remote images hidden'
    );
    const ui = read('lib/offline-mail/offline-attachment-viewer.tsx');
    assert(
      ui.includes('sandbox=""') && ui.includes('referrerPolicy="no-referrer"'),
      'sandboxed frame without scripts'
    );
  });

  await test('text: UTF-8, UTF-16 (BOM), Windows-1255 Hebrew; JSON pretty-printed', () => {
    assert(decodeTextBytes(Buffer.from('שלום hi', 'utf8')) === 'שלום hi', 'utf8');
    assert(
      decodeTextBytes(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('שלום', 'utf16le')])
      ) === 'שלום',
      'utf16le'
    );
    const be = Buffer.from('שלום', 'utf16le');
    be.swap16();
    assert(decodeTextBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])) === 'שלום', 'utf16be');
    assert(decodeTextBytes(Buffer.from([0xf9, 0xec, 0xe5, 0xed])) === 'שלום', 'cp1255');
    assert(prettyJson('{"a":[1,2]}') === '{\n  "a": [\n    1,\n    2\n  ]\n}', 'json');
  });

  await test('nested e-mail (.eml): headers, body and its own attachment list', () => {
    const eml =
      'From: Synthetic Sender <s@example.test>\r\nTo: Me <me@example.test>\r\nSubject: =?UTF-8?B?' +
      Buffer.from('הודעה מצורפת').toString('base64') +
      '?=\r\nDate: Mon, 02 Nov 2026 09:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B1"\r\n\r\n' +
      '--B1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nגוף ההודעה המצורפת\r\n' +
      '--B1\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="inner.txt"\r\n\r\ninner\r\n--B1--\r\n';
    const v = emlView(Buffer.from(eml));
    assert(v.subject === 'הודעה מצורפת' && v.text.includes('גוף ההודעה המצורפת'), 'subject/body');
    assert(
      v.attachments.length === 1 && v.attachments[0].filename === 'inner.txt',
      'inner attachment'
    );
  });

  await test('no network code in the viewer files', () => {
    for (const f of [
      'lib/core/offline-viewer.ts',
      'lib/offline-mail/offline-attachment-viewer.tsx',
      'lib/offline-mail/offline-attachments-view.tsx',
    ]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert(!/fetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|openExternal|gemini/i.test(src), f);
    }
  });

  await test('zoom steps', () => {
    assert(
      zoomStep(1, 1) === 1.1 &&
        zoomStep(1, -1) === 0.9 &&
        zoomStep(3, 1) === 3 &&
        zoomStep(0.5, -1) === 0.5,
      'steps'
    );
  });

  await test('bundled viewer libraries: pinned, licenses compatible (no copyleft-only)', () => {
    const allowed =
      /^(Apache-2\.0|MIT|BSD-2-Clause|BSD-3-Clause|ISC|\(MPL-2\.0 OR Apache-2\.0\)|\(MIT OR GPL-3\.0-or-later\))$/;
    const pkgJson = (name: string) => {
      let dir = path.dirname(require.resolve(name));
      for (let i = 0; i < 6; i++) {
        const f = path.join(dir, 'package.json');
        if (fs.existsSync(f)) {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (j.name === name) return j;
        }
        dir = path.dirname(dir);
      }
      throw new Error(`no package.json for ${name}`);
    };
    for (const name of ['pdfjs-dist', 'xlsx', 'mammoth', 'jszip', 'dompurify']) {
      const pkg = pkgJson(name);
      assert(allowed.test(pkg.license), `${name} license ${pkg.license}`);
    }
    assert(THIRD_PARTY_VIEWER_LIBS.length === 5, 'listed');
    const app = JSON.parse(read('../../package.json'));
    assert(app.dependencies['pdfjs-dist'] === '6.5.438', 'pdfjs pinned');
    assert(/xlsx-0\.20\.3\.tgz$/.test(app.dependencies.xlsx), 'xlsx pinned (SheetJS CE tarball)');
    assert(app.dependencies.jszip === '3.10.1', 'jszip pinned');
  });

  await test('UI: "View" is the primary button; open in app / save as kept; dangerous files not previewed', () => {
    const v = read('lib/offline-mail/offline-attachments-view.tsx');
    assert(
      v.includes('className="btn btn-small btn-emphasis offline-attachment-view"') &&
        v.includes("tr('צפה', 'View')"),
      'view button'
    );
    assert(v.includes('canView && !danger ?'), 'no view for dangerous files');
    assert(
      v.includes("tr('פתח בתוכנה', 'Open in app')") && v.includes("tr('שמור בשם…', 'Save as…')"),
      'other buttons'
    );
    const viewer = read('lib/offline-mail/offline-attachment-viewer.tsx');
    for (const k of [
      'data-offline-viewer-prev',
      'data-offline-viewer-next',
      'data-offline-viewer-zoom-in',
      'data-offline-viewer-zoom-out',
      'data-offline-viewer-open',
      'data-offline-viewer-save',
      "e.key === 'Escape'",
      'dir={offlineDir()}',
      'isEvalSupported: false',
    ]) {
      assert(viewer.includes(k), k);
    }
    const reader = read('lib/offline-mail/offline-message-reader.tsx');
    assert(
      /loadForView=\{async \(i\) => \{[\s\S]*extractAttachmentToProfile\(dir, id, i[\s\S]*fs\.promises\.readFile\(file\)/.test(
        reader
      ),
      'reads the profile temp copy'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
