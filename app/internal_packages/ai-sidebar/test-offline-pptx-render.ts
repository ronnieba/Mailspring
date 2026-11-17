#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t230): PowerPoint slides drawn for real in the viewer.
 * Synthetic .pptx built in memory: theme colours, master/layout placeholder
 * inheritance, text styles, bullets, Hebrew, shapes, picture with crop,
 * table, group transform, connector, background, notes. Safety: external
 * links ignored, unsafe font names dropped, text stays text. No network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-pptx-render.ts
 */
import fs from 'fs';
import path from 'path';
import { parseXml, kid, renderPptx, presetPolygon } from './lib/core/offline-pptx-render';

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
  if (!cond) throw new Error(msg);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JSZip = require('jszip');

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (list: [string, string, string, string?][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      ([id, type, target, mode]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`
    )
    .join('')}</Relationships>`;
const xf = (x: number, y: number, w: number, h: number, extra = '') =>
  `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function deck(): Promise<Buffer> {
  const z = new JSZip();
  z.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
  );
  z.file(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide2.xml'],
      ['rId3', 'slide', 'slides/slide1.xml'],
    ])
  );
  z.file(
    'ppt/theme/theme1.xml',
    `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`
  );
  z.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill></p:bgPr></p:bg><p:spTree>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xf(100, 200, 9000, 1000)}</p:spPr><p:txBody><a:bodyPr anchor="b"/><a:p><a:r><a:t>Master prompt</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xf(100, 1500, 9000, 4000)}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Body prompt</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Logo bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(0, 6500000, 12192000, 358000)}<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr></p:sp>` +
      `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent1" accent4="accent1" accent5="accent1" accent6="accent1" hlink="accent1" folHlink="accent1"/>` +
      `<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
      `<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>` +
      `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`
  );
  z.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([['rId1', 'theme', '../theme/theme1.xml']])
  );
  z.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xf(500000, 300000, 11000000, 1200000)}</p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`
  );
  z.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])
  );
  // Slide 1 (shown first): title + bullets inherited, Hebrew RTL, notes.
  z.file(
    'ppt/slides/slide1.xml',
    `<p:sld ${NS}><p:cSld><p:spTree>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Quarterly &amp; plan &lt;script&gt;</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:pPr rtl="1" algn="r"/><a:r><a:rPr lang="he-IL" b="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>נקודה ראשונה</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr><a:latin typeface="x&quot;;background:url(http://evil.test/a)"/></a:rPr><a:t>Second level</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>No bullet</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="9" name="hidden" hidden="1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(0, 0, 10, 10)}<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr></p:sp>` +
      `</p:spTree></p:cSld></p:sld>`
  );
  z.file(
    'ppt/slides/_rels/slide1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml'],
    ])
  );
  z.file(
    'ppt/notesSlides/notesSlide1.xml',
    `<p:notes ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>הערת דובר</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
  );
  // Slide 2: shapes, picture (cropped), external picture (ignored), table, group, connector, own background.
  z.file(
    'ppt/slides/slide2.xml',
    `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF7E6"/></a:solidFill></p:bgPr></p:bg><p:spTree>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="o"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(1000, 1000, 2000000, 1000000, ' rot="5400000"')}<a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:t>Oval</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="arrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(3000000, 1000, 2000000, 800000)}<a:prstGeom prst="rightArrow"/><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></p:spPr></p:sp>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" r="10000"/></p:blipFill><p:spPr>${xf(100000, 2000000, 3000000, 2000000)}</p:spPr></p:pic>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="5" name="ext"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rId3" r:embed="rId3"/></p:blipFill><p:spPr>${xf(100000, 4500000, 1000000, 1000000)}</p:spPr></p:pic>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="5000000" y="2000000"/><a:ext cx="4000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid><a:tr h="500000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></a:tcPr></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr><a:tr h="500000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="9500000" y="2000000"/><a:ext cx="2000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>` +
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="8" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6000000" y="4000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="500000"/></a:xfrm></p:grpSpPr>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="10" name="gs"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(500000, 250000, 500000, 250000)}<a:prstGeom prst="star5"/><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></p:spPr></p:sp></p:grpSp>` +
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="11" name="c"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xf(100000, 6000000, 11000000, 0)}<a:prstGeom prst="line"/><a:ln w="38100"><a:solidFill><a:srgbClr val="555555"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>` +
      `</p:spTree></p:cSld></p:sld>`
  );
  z.file(
    'ppt/slides/_rels/slide2.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'image', '../media/image1.png'],
      ['rId3', 'image', 'http://evil.test/x.png', 'External'],
    ])
  );
  z.file('ppt/media/image1.png', PNG);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  console.log('offline PowerPoint slides (t230)');

  await test('XML reader: entities, attributes, self-closing, namespaces', () => {
    const x = parseXml(
      '<?xml version="1.0"?><a:p x="1&amp;2"><a:r><a:t>A &lt;b&gt; &#1488;</a:t></a:r><a:br/></a:p>'
    );
    const p = kid(x, 'p')!;
    assert(p.a.x === '1&2', 'attr');
    assert(kid(kid(p, 'r'), 't')!.t === 'A <b> א', 'text');
    assert(kid(p, 'br') && p.c.length === 2, 'self-closing');
  });

  const d = await renderPptx(JSZip, await deck());
  const [s1, s2] = d.slides;

  await test('size, presentation order, notes, master background', () => {
    assert(d.width === 12192000 && d.height === 6858000, 'size');
    assert(d.slides.length === 2, 'two slides');
    assert(s1.text[0].startsWith('Quarterly & plan'), `order ${s1.text[0]}`);
    assert(s1.notes.join() === 'הערת דובר', 'notes');
    assert(s1.background === 'rgb(238,238,238)', `bg via clrMap bg2→lt2: ${s1.background}`);
    assert(s2.background === 'rgb(255,247,230)', 'own background');
  });

  await test('placeholders inherit position from the layout and styles from the master', () => {
    const title = s1.items.find(
      (i) => i.kind === 'shape' && i.text && i.text.paras[0].runs[0].text.startsWith('Quarterly')
    ) as any;
    assert(title && title.x === 500000 && title.w === 11000000, 'layout xfrm');
    assert(title.text.anchor === 'bottom', 'master bodyPr anchor');
    const r = title.text.paras[0].runs[0];
    assert(
      r.size === 44 && r.color === 'rgb(31,41,55)' && r.font === 'Aptos Display',
      `title style ${JSON.stringify(r)}`
    );
    assert(title.text.paras[0].align === 'center', 'title centred');
    const body = s1.items.find(
      (i) => i.kind === 'shape' && i.text && i.text.paras.length === 3
    ) as any;
    assert(body && body.y === 1500, 'body from master by idx');
    const [p1, p2, p3] = body.text.paras;
    assert(
      p1.rtl &&
        p1.align === 'right' &&
        p1.bullet === '•' &&
        p1.runs[0].b &&
        p1.runs[0].color === 'rgb(192,0,0)',
      'Hebrew bold red bullet'
    );
    assert(p2.bullet === '–' && p2.runs[0].size === 24, 'level 2');
    assert(p3.bullet === null, 'buNone');
  });

  await test('master decorations drawn; hidden shapes and empty placeholders skipped', () => {
    const bar = s1.items.find((i) => i.kind === 'shape' && i.y === 6500000) as any;
    assert(
      bar && /^rgb\(/.test(bar.fill) && bar.fill !== 'rgb(68,114,196)',
      `lumMod applied ${bar && bar.fill}`
    );
    assert(!s1.items.some((i: any) => i.fill === 'rgb(0,255,0)'), 'hidden shape skipped');
    assert(
      !s1.items.some((i: any) => i.text && /prompt/.test(JSON.stringify(i.text))),
      'master prompts not shown'
    );
  });

  await test('shapes: ellipse with rotation, line, style font colour; gradient arrow', () => {
    const oval = s2.items.find((i: any) => i.geom === 'ellipse') as any;
    assert(
      oval.rot === 90 && oval.fill === 'rgb(237,125,49)' && oval.line.color === 'rgb(51,51,51)',
      'oval'
    );
    assert(oval.text.paras[0].runs[0].color === 'rgb(255,255,255)', 'fontRef lt1 colour');
    const arrow = s2.items.find((i: any) => i.geom === 'rightArrow') as any;
    assert(
      /^linear-gradient\(90\.0deg, rgb\(255,0,0\) 0\.0%, rgb\(0,0,255\) 100\.0%\)$/.test(
        arrow.fill
      ),
      arrow.fill
    );
    assert(
      presetPolygon('rightArrow') && presetPolygon('star5') && !presetPolygon('rect'),
      'polygons'
    );
  });

  await test('pictures: embedded with crop; external links never loaded', () => {
    const pics = s2.items.filter((i) => i.kind === 'pic') as any[];
    assert(pics.length === 2, 'two pics');
    assert(
      pics[0].src.startsWith('data:image/png;base64,') && Math.abs(pics[0].crop[0] - 0.1) < 1e-9,
      'crop'
    );
    assert(pics[1].src === null, 'external ignored');
    assert(!JSON.stringify(d).includes('evil.test'), 'no external URL anywhere in the model');
  });

  await test('table with merged header, chart placeholder, group transform, connector', () => {
    const t = s2.items.find((i) => i.kind === 'table') as any;
    assert(
      t && t.rows.length === 2 && t.rows[0].cells[0].colSpan === 2 && t.rows[0].cells[1].hidden,
      'table merge'
    );
    assert(t.rows[0].cells[0].fill === 'rgb(221,238,255)', 'cell fill');
    assert(
      s2.items.some((i: any) => i.kind === 'unsupported' && i.label === '📊'),
      'chart box'
    );
    const star = s2.items.find((i: any) => i.geom === 'star5') as any;
    assert(
      star.x === 7000000 && star.y === 4500000 && star.w === 1000000 && star.h === 500000,
      `group tf ${JSON.stringify(star)}`
    );
    const ln = s2.items.find((i) => i.kind === 'line') as any;
    assert(ln && ln.line.width === 38100 && ln.tailEnd, 'connector');
  });

  await test('unsafe font names are dropped; text stays plain text', () => {
    const json = JSON.stringify(s1);
    assert(!json.includes('background:url'), 'font rejected');
    assert(s1.text[0] === 'Quarterly & plan <script>', 'script text kept as text');
  });

  await test('view renders slides as plain elements (no scripts, no remote URLs)', () => {
    let server: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      server = require('react-dom/server');
    } catch (e) {
      console.log('    (react-dom not installed here; view render skipped)');
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const React = require('react');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PptxDeckView } = require('./lib/offline-mail/offline-pptx-view');
    const html: string = server.renderToStaticMarkup(
      React.createElement(PptxDeckView, { deck: d, zoom: 1, mode: 'slides' })
    );
    assert((html.match(/data-offline-pptx-slide=/g) || []).length === 2, 'two slides');
    assert(!/<script/i.test(html) && html.includes('&lt;script&gt;'), 'escaped');
    assert(
      !/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')),
      'no remote URL'
    );
    assert(
      /<polygon/.test(html) && /<table/.test(html) && /<img/.test(html),
      'shapes, table, picture'
    );
  });

  await test('viewer uses the real slides with a text-only toggle and outline fallback', () => {
    const v = fs.readFileSync(
      path.join(__dirname, 'lib/offline-mail/offline-attachment-viewer.tsx'),
      'utf8'
    );
    assert(
      /renderPptx\(require\('jszip'\), buf\)/.test(v) &&
        /pptxSlides\(require\('jszip'\), buf\)/.test(v),
      'fallback'
    );
    assert(/data-offline-viewer-slide-mode/.test(v), 'toggle');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
