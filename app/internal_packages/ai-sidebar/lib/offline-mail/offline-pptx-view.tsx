/**
 * Offline experiment: draws a PowerPoint deck (model from
 * core/offline-pptx-render) as real slides. Plain React elements only: text
 * is rendered as text, pictures are data: URLs, colours/fonts were validated
 * by the parser. No scripts, no network.
 */
import React from 'react';
import { tr } from '../core/offline-i18n';
import {
  EMU_PT,
  PptxDeck,
  PptxItem,
  PptxLine,
  PptxPara,
  PptxSlide,
  PptxText,
  presetPolygon,
  presetRadius,
} from '../core/offline-pptx-render';

type CSS = React.CSSProperties;

const FALLBACK_FONTS = '"Segoe UI", Arial, "Noto Sans Hebrew", sans-serif';

function boxStyle(it: PptxItem, s: number): CSS {
  const t: string[] = [];
  if (it.rot) t.push(`rotate(${it.rot}deg)`);
  if (it.flipH || it.flipV) t.push(`scale(${it.flipH ? -1 : 1}, ${it.flipV ? -1 : 1})`);
  return {
    position: 'absolute',
    left: it.x * s,
    top: it.y * s,
    width: Math.max(1, it.w * s),
    height: Math.max(1, it.h * s),
    transform: t.length ? t.join(' ') : undefined,
  };
}

function lineWidth(l: PptxLine | null, s: number): number {
  return l ? Math.max(1, l.width * s) : 0;
}

function renderPara(p: PptxPara, k: number, s: number, scale: number) {
  const px = (pt: number) => pt * EMU_PT * s * scale;
  const style: CSS = {
    margin: 0,
    textAlign: p.align === 'start' ? undefined : p.align,
    paddingInlineStart: Math.max(0, p.marL * s),
    textIndent: p.indent * s,
    paddingTop: px(p.spaceBefore),
    paddingBottom: px(p.spaceAfter),
    lineHeight: (1.2 * p.lineSpacing).toFixed(2),
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  };
  const empty = !p.runs.some((r) => r.text);
  const first = p.runs.find((r) => r.text) || p.runs[0];
  return (
    <p key={k} dir={p.rtl ? 'rtl' : 'auto'} style={style}>
      {p.bullet ? (
        <span
          className="ofl-pptx-bullet"
          style={{
            fontSize: px(first ? first.size : p.emptySize),
            color: p.bulletColor || (first && first.color) || undefined,
            marginInlineEnd: '0.45em',
          }}
        >
          {p.bullet}
        </span>
      ) : null}
      {empty ? (
        <span style={{ fontSize: px(p.emptySize) }}>{'\u00a0'}</span>
      ) : (
        p.runs.map((r, i) =>
          r.br ? (
            <br key={i} />
          ) : (
            <span
              key={i}
              style={{
                fontSize: px(r.baseline ? r.size * 0.7 : r.size),
                fontWeight: r.b ? 700 : undefined,
                fontStyle: r.i ? 'italic' : undefined,
                textDecoration:
                  [r.u ? 'underline' : '', r.strike ? 'line-through' : '']
                    .filter(Boolean)
                    .join(' ') || undefined,
                color: r.color || undefined,
                fontFamily: r.font ? `"${r.font}", ${FALLBACK_FONTS}` : undefined,
                verticalAlign: r.baseline > 0 ? 'super' : r.baseline < 0 ? 'sub' : undefined,
              }}
            >
              {r.text}
            </span>
          )
        )
      )}
    </p>
  );
}

function renderText(t: PptxText, s: number) {
  return (
    <div
      className="ofl-pptx-text"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent:
          t.anchor === 'middle' ? 'center' : t.anchor === 'bottom' ? 'flex-end' : 'flex-start',
        padding: `${t.inset[1] * s}px ${t.inset[2] * s}px ${t.inset[3] * s}px ${t.inset[0] * s}px`,
        writingMode: t.vertical ? 'vertical-rl' : undefined,
        whiteSpace: t.wrap ? undefined : 'nowrap',
        fontFamily: FALLBACK_FONTS,
        color: '#000',
      }}
    >
      {t.paras.map((p, k) => renderPara(p, k, s, t.fontScale))}
    </div>
  );
}

function renderItem(it: PptxItem, k: number, s: number): React.ReactNode {
  const base = boxStyle(it, s);
  switch (it.kind) {
    case 'shape': {
      const poly = presetPolygon(it.geom);
      const radius = presetRadius(it.geom);
      const lw = lineWidth(it.line, s);
      const shapeCss: CSS = poly
        ? {}
        : {
            position: 'absolute',
            inset: 0,
            background: it.fill || undefined,
            border: it.line
              ? `${lw}px ${it.line.dash ? 'dashed' : 'solid'} ${it.line.color}`
              : undefined,
            borderRadius:
              radius === '50%'
                ? '50%'
                : radius === 'r'
                  ? Math.min(it.w, it.h) * s * 0.1667
                  : undefined,
            boxSizing: 'border-box',
            overflow: it.image ? 'hidden' : undefined,
          };
      return (
        <div
          key={k}
          className="ofl-pptx-item"
          data-offline-pptx-item="shape"
          data-geom={it.geom}
          style={base}
        >
          {poly ? (
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              width="100%"
              height="100%"
              style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
            >
              <polygon
                points={poly}
                fill={it.fill && !/gradient/.test(it.fill) ? it.fill : it.fill ? '#888' : 'none'}
                stroke={it.line ? it.line.color : 'none'}
                strokeWidth={lw}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : (
            <div style={shapeCss}>
              {it.image ? (
                <img
                  src={it.image}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : null}
            </div>
          )}
          {it.text ? renderText(it.text, s) : null}
        </div>
      );
    }
    case 'pic': {
      const [l, t, r, b] = it.crop;
      const fw = (it.w * s) / Math.max(0.05, 1 - l - r);
      const fh = (it.h * s) / Math.max(0.05, 1 - t - b);
      return (
        <div
          key={k}
          className="ofl-pptx-item"
          data-offline-pptx-item="pic"
          style={{
            ...base,
            overflow: 'hidden',
            border: it.line ? `${lineWidth(it.line, s)}px solid ${it.line.color}` : undefined,
            boxSizing: 'border-box',
          }}
        >
          {it.src ? (
            <img
              src={it.src}
              alt=""
              style={{
                position: 'absolute',
                left: -l * fw,
                top: -t * fh,
                width: fw,
                height: fh,
                maxWidth: 'none',
              }}
            />
          ) : (
            <div className="ofl-pptx-missing">
              {it.label} {tr('(תמונה בפורמט שלא מוצג)', '(picture format not shown)')}
            </div>
          )}
        </div>
      );
    }
    case 'line': {
      const w = Math.max(1, it.w * s);
      const h = Math.max(1, it.h * s);
      const lw = lineWidth(it.line, s);
      const x1 = it.flipH ? w : 0;
      const x2 = it.flipH ? 0 : w;
      const y1 = it.flipV ? h : 0;
      const y2 = it.flipV ? 0 : h;
      return (
        <svg
          key={k}
          className="ofl-pptx-item"
          data-offline-pptx-item="line"
          style={{
            ...base,
            transform: it.rot ? `rotate(${it.rot}deg)` : undefined,
            overflow: 'visible',
          }}
          width={w}
          height={h}
        >
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={it.line.color}
            strokeWidth={lw}
            strokeDasharray={it.line.dash ? `${lw * 3} ${lw * 2}` : undefined}
          />
          {it.tailEnd ? <circle cx={x2} cy={y2} r={lw * 1.6} fill={it.line.color} /> : null}
          {it.headEnd ? <circle cx={x1} cy={y1} r={lw * 1.6} fill={it.line.color} /> : null}
        </svg>
      );
    }
    case 'table': {
      const total = it.cols.reduce((a, b) => a + b, 0) || 1;
      return (
        <table
          key={k}
          className="ofl-pptx-table"
          data-offline-pptx-item="table"
          style={{ ...base, height: undefined, tableLayout: 'fixed', borderCollapse: 'collapse' }}
        >
          <colgroup>
            {it.cols.map((c, i) => (
              <col key={i} style={{ width: `${((c / total) * 100).toFixed(2)}%` }} />
            ))}
          </colgroup>
          <tbody>
            {it.rows.map((row, ri) => (
              <tr key={ri} style={{ height: row.h * s }}>
                {row.cells.map((c, ci) =>
                  c.hidden ? null : (
                    <td
                      key={ci}
                      colSpan={c.colSpan > 1 ? c.colSpan : undefined}
                      rowSpan={c.rowSpan > 1 ? c.rowSpan : undefined}
                      style={{
                        background:
                          c.fill || (ri === 0 ? '#dbe5f1' : ri % 2 ? '#ffffff' : '#f2f5fa'),
                        border: '1px solid #9aa8b8',
                        position: 'relative',
                        verticalAlign:
                          c.text.anchor === 'middle'
                            ? 'middle'
                            : c.text.anchor === 'bottom'
                              ? 'bottom'
                              : 'top',
                        padding: `${c.text.inset[1] * s}px ${c.text.inset[2] * s}px ${c.text.inset[3] * s}px ${c.text.inset[0] * s}px`,
                        fontFamily: FALLBACK_FONTS,
                      }}
                    >
                      {c.text.paras.map((p, pk) => renderPara(p, pk, s, 1))}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'unsupported':
      return (
        <div
          key={k}
          className="ofl-pptx-item ofl-pptx-unsupported"
          data-offline-pptx-item="unsupported"
          style={base}
        >
          <span>
            {it.label}{' '}
            {it.label === '📊'
              ? tr('תרשים (לא מוצג)', 'Chart (not shown)')
              : it.label === '🔷'
                ? tr('SmartArt (לא מוצג)', 'SmartArt (not shown)')
                : tr('אובייקט (לא מוצג)', 'Object (not shown)')}
          </span>
        </div>
      );
  }
  return null;
}

export function PptxSlideView({
  deck,
  slide,
  width,
}: {
  deck: PptxDeck;
  slide: PptxSlide;
  width: number;
}) {
  const s = width / deck.width;
  const height = deck.height * s;
  return (
    <div
      className="ofl-pptx-slide"
      data-offline-pptx-slide={slide.index}
      style={{
        position: 'relative',
        width,
        height,
        overflow: 'hidden',
        background: slide.background || '#ffffff',
        backgroundImage: slide.backgroundImage ? `url("${slide.backgroundImage}")` : undefined,
        backgroundSize: 'cover',
        direction: 'ltr',
      }}
    >
      {slide.items.map((it, k) => renderItem(it, k, s))}
    </div>
  );
}

type Props = { deck: PptxDeck; zoom: number; mode: 'slides' | 'outline'; baseWidth?: number };

export function PptxDeckView({ deck, zoom, mode, baseWidth = 880 }: Props) {
  if (!deck.slides.length) {
    return <div className="offline-viewer-note">{tr('לא נמצאו שקופיות', 'No slides found')}</div>;
  }
  const width = Math.round(baseWidth * zoom);
  return (
    <div
      className="ofl-pptx-deck"
      data-offline-pptx-mode={mode}
      data-offline-pptx-slides={deck.slides.length}
    >
      {deck.slides.map((sl) => (
        <div className="ofl-pptx-slide-wrap" key={sl.index} data-offline-viewer-slide={sl.index}>
          <div className="ofl-pptx-slide-num">
            {tr(`שקופית ${sl.index}`, `Slide ${sl.index}`)}
            {sl.hidden ? tr(' (מוסתרת)', ' (hidden)') : ''}
          </div>
          {mode === 'slides' ? (
            <PptxSlideView deck={deck} slide={sl} width={width} />
          ) : (
            <div className="ofl-pptx-outline" style={{ zoom } as any}>
              {sl.text.length ? (
                sl.text.map((t, k) => (
                  <div
                    key={k}
                    dir="auto"
                    className={k === 0 ? 'offline-viewer-slide-title' : 'offline-viewer-slide-line'}
                  >
                    {t}
                  </div>
                ))
              ) : (
                <div className="offline-viewer-note">
                  {tr('(אין טקסט בשקופית)', '(no text on this slide)')}
                </div>
              )}
            </div>
          )}
          {sl.notes.length ? (
            <div className="offline-viewer-slide-notes" dir="auto">
              {tr('הערות דובר: ', 'Speaker notes: ')}
              {sl.notes.join(' · ')}
            </div>
          ) : null}
        </div>
      ))}
      {deck.truncated ? (
        <div className="offline-viewer-note">
          {tr('מוצגות 300 השקופיות הראשונות.', 'Showing the first 300 slides.')}
        </div>
      ) : null}
    </div>
  );
}
