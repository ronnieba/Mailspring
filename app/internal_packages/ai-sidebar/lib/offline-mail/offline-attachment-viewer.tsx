/**
 * Offline experiment: built-in attachment viewer (modal over the window).
 * Prev / next across the message's attachments, zoom, Hebrew right-to-left.
 * Bytes come from the copy in the offline profile's temp folder; libraries
 * are bundled and run locally; previews never run scripts or load anything
 * from the network (sandboxed frames with a no-network CSP; the app's
 * offline guard blocks remote requests as well).
 */
import React from 'react';
import ReactDOM from 'react-dom';
import classNames from 'classnames';
import { offlineDir, tr } from '../core/offline-i18n';
import {
  ATTACHMENT_ICONS,
  attachmentKind,
  formatBytes,
  imageMimeFor,
} from '../core/offline-attachments';
import {
  EmlView,
  SheetView,
  SlideView,
  VIEWER_PDF_MAX_PAGES,
  ViewerGuard,
  columnName,
  decodeTextBytes,
  docxToHtml,
  emlView,
  limitText,
  pptxSlides,
  prettyJson,
  sheetsFromBytes,
  svgDataUrl,
  viewerGuard,
  viewerHtmlDocument,
  zoomStep,
} from '../core/offline-viewer';
import type { AttachmentItem } from './offline-attachments-view';

type Content =
  | { type: 'pdf'; doc: any; task: any; pages: number }
  | { type: 'image'; url: string; revoke: boolean }
  | { type: 'html'; html: string }
  | { type: 'sheets'; sheets: SheetView[] }
  | { type: 'slides'; slides: SlideView[] }
  | { type: 'text'; text: string; truncated: boolean; mono: boolean }
  | { type: 'eml'; eml: EmlView };

type Props = {
  items: AttachmentItem[];
  index: number;
  /** Bytes of item i, read from the profile temp copy. */
  load: (index: number) => Promise<Buffer>;
  onIndex: (index: number) => void;
  onOpenInApp: (index: number) => void;
  onSave?: (index: number) => void;
  onClose: () => void;
};

type State = {
  zoom: number;
  loading: boolean;
  error: string | null;
  content: Content | null;
  guard: ViewerGuard | null;
  sheet: number;
  pdfRendered: number;
};

/* eslint-disable @typescript-eslint/no-var-requires */
let pdfjsLib: any = null;
function pdfjs(): any {
  if (!pdfjsLib) {
    // ES module, loaded with Node's require(esm); the worker is a local file.
    pdfjsLib = require('pdfjs-dist/build/pdf.min.mjs');
    const { pathToFileURL } = require('url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
    ).href;
  }
  return pdfjsLib;
}
/* eslint-enable @typescript-eslint/no-var-requires */

export class OfflineAttachmentViewer extends React.Component<Props, State> {
  static displayName = 'OfflineAttachmentViewer';
  state: State = {
    zoom: 1,
    loading: true,
    error: null,
    content: null,
    guard: null,
    sheet: 0,
    pdfRendered: 0,
  };
  private _gen = 0;
  private _pdfGen = 0;
  private _pagesRef = React.createRef<HTMLDivElement>();
  private _rootRef = React.createRef<HTMLDivElement>();
  /** Rendered at the top of <body> so it covers the whole window, not just the reader pane. */
  private _host: HTMLDivElement = (() => {
    const el = document.createElement('div');
    el.className = 'offline-viewer-host';
    document.body.appendChild(el);
    return el;
  })();

  componentDidMount() {
    void this._load();
    window.addEventListener('keydown', this._onKey, true);
    if (this._rootRef.current) this._rootRef.current.focus();
  }

  componentDidUpdate(prev: Props, prevState: State) {
    if (prev.index !== this.props.index || prev.items !== this.props.items) {
      void this._load();
      return;
    }
    const c = this.state.content;
    if (c && c.type === 'pdf' && (prevState.content !== c || prevState.zoom !== this.state.zoom)) {
      void this._renderPdf(c);
    }
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this._onKey, true);
    this._gen++;
    this._pdfGen++;
    this._dispose(this.state.content);
    this._host.remove();
  }

  _dispose(c: Content | null) {
    if (!c) return;
    if (c.type === 'pdf') {
      try {
        c.task.destroy();
      } catch (e) {
        // already closed
      }
    } else if (c.type === 'image' && c.revoke) {
      URL.revokeObjectURL(c.url);
    }
  }

  _onKey = (e: KeyboardEvent) => {
    const rtl = offlineDir() === 'rtl';
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.props.onClose();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      e.stopPropagation();
      const forward = (e.key === 'ArrowLeft') === rtl;
      this._go(forward ? 1 : -1);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      e.stopPropagation();
      this._zoom(1);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      e.stopPropagation();
      this._zoom(-1);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      e.stopPropagation();
      this.setState({ zoom: 1 });
    }
  };

  _go(d: 1 | -1) {
    const n = this.props.items.length;
    const next = this.props.index + d;
    if (next >= 0 && next < n) this.props.onIndex(next);
  }

  _zoom(d: 1 | -1) {
    this.setState({ zoom: zoomStep(this.state.zoom, d) });
  }

  async _load() {
    const gen = ++this._gen;
    this._pdfGen++;
    const it = this.props.items[this.props.index];
    this._dispose(this.state.content);
    const guard = it ? viewerGuard(it.filename, it.contentType, it.size) : null;
    this.setState({
      loading: !!guard && !guard.blocked,
      error: null,
      content: null,
      guard,
      sheet: 0,
      pdfRendered: 0,
    });
    if (!it || !guard || guard.blocked) return;
    try {
      const buf = await this.props.load(this.props.index);
      if (gen !== this._gen) return;
      const content = await this._build(guard, it, buf);
      if (gen !== this._gen) {
        this._dispose(content);
        return;
      }
      this.setState({ content, loading: false });
    } catch (err) {
      if (gen === this._gen) {
        console.warn('[Offline mail] attachment preview failed');
        this.setState({
          loading: false,
          error: String((err as Error)?.message || err).slice(0, 300),
        });
      }
    }
  }

  async _build(guard: ViewerGuard, it: AttachmentItem, buf: Buffer): Promise<Content> {
    switch (guard.kind) {
      case 'pdf': {
        const task = pdfjs().getDocument({
          data: new Uint8Array(buf),
          isEvalSupported: false,
          enableXfa: false,
          disableAutoFetch: true,
          stopAtErrors: false,
        });
        const doc = await task.promise;
        return { type: 'pdf', doc, task, pages: doc.numPages };
      }
      case 'image': {
        // data: URL (the window's CSP allows data: images, not blob:).
        const url = `data:${imageMimeFor(it.filename, it.contentType)};base64,${buf.toString('base64')}`;
        return { type: 'image', url, revoke: false };
      }
      case 'svg':
        return { type: 'image', url: svgDataUrl(decodeTextBytes(buf)), revoke: false };
      case 'docx': {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { html } = await docxToHtml(require('mammoth'), buf);
        return { type: 'html', html: purify(html) };
      }
      case 'html':
        return { type: 'html', html: purify(limitText(decodeTextBytes(buf)).text) };
      case 'sheet':
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return { type: 'sheets', sheets: sheetsFromBytes(require('xlsx'), buf) };
      case 'csv':
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return {
          type: 'sheets',
          sheets: sheetsFromBytes(require('xlsx'), buf, decodeTextBytes(buf)),
        };
      case 'pptx':
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return { type: 'slides', slides: await pptxSlides(require('jszip'), buf) };
      case 'eml':
        return { type: 'eml', eml: emlView(buf) };
      case 'json': {
        const t = limitText(prettyJson(decodeTextBytes(buf)));
        return { type: 'text', text: t.text, truncated: t.truncated, mono: true };
      }
      case 'xml': {
        const t = limitText(decodeTextBytes(buf));
        return { type: 'text', text: t.text, truncated: t.truncated, mono: true };
      }
      default: {
        const t = limitText(decodeTextBytes(buf));
        return { type: 'text', text: t.text, truncated: t.truncated, mono: false };
      }
    }
  }

  async _renderPdf(c: Extract<Content, { type: 'pdf' }>) {
    const gen = ++this._pdfGen;
    const host = this._pagesRef.current;
    if (!host) return;
    host.textContent = '';
    const dpr = window.devicePixelRatio || 1;
    const scale = this.state.zoom * (4 / 3);
    const pages = Math.min(c.pages, VIEWER_PDF_MAX_PAGES);
    for (let n = 1; n <= pages; n++) {
      if (gen !== this._pdfGen) return;
      try {
        const page = await c.doc.getPage(n);
        if (gen !== this._pdfGen) return;
        const vp = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
        canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
        canvas.className = 'offline-viewer-pdf-page';
        canvas.setAttribute('data-offline-viewer-page', String(n));
        host.appendChild(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        page.cleanup();
        if (gen === this._pdfGen) this.setState({ pdfRendered: n });
      } catch (e) {
        if (gen !== this._pdfGen) return;
        const err = document.createElement('div');
        err.className = 'offline-viewer-note';
        err.textContent = tr(`לא ניתן להציג את עמוד ${n}`, `Could not show page ${n}`);
        host.appendChild(err);
      }
    }
  }

  _renderBlocked(g: ViewerGuard, it: AttachmentItem) {
    const msg =
      g.blocked === 'danger'
        ? tr(
            'סוג הקובץ הזה יכול להריץ תוכנה במחשב, ולכן אין לו תצוגה מקדימה. אפשר לשמור אותו, או לפתוח בתוכנה (תופיע אזהרה).',
            'This kind of file can run a program on your computer, so it is not previewed. You can save it, or open it with a program (you will be warned).'
          )
        : g.blocked === 'too-large'
          ? tr(
              `הקובץ גדול מדי לתצוגה בתוך התוכנה (${formatBytes(it.size)}). פתח אותו בתוכנה המתאימה.`,
              `This file is too large to show inside the app (${formatBytes(it.size)}). Open it with its program.`
            )
          : g.blocked === 'legacy'
            ? tr(
                'זה פורמט Office ישן (‎.doc / .ppt‎ וכדומה) שאין לו תצוגה מקדימה כאן. פתח אותו בתוכנה המתאימה.',
                'This is an older Office format (.doc / .ppt etc.) with no preview here. Open it with its program.'
              )
            : g.blocked === 'heic'
              ? tr(
                  'תמונות HEIC (אייפון) לא נתמכות בתצוגה הפנימית. פתח אותן בתוכנה המתאימה.',
                  'HEIC (iPhone) photos are not supported by the built-in viewer. Open them with their program.'
                )
              : tr(
                  'אין תצוגה מקדימה לסוג הקובץ הזה. אפשר לפתוח בתוכנה או לשמור.',
                  'No preview for this kind of file. You can open it with a program or save it.'
                );
    return (
      <div
        className={classNames('offline-viewer-blocked', { danger: g.blocked === 'danger' })}
        data-offline-viewer-blocked={g.blocked || ''}
      >
        <div className="offline-viewer-blocked-icon">
          {g.blocked === 'danger'
            ? '⚠️'
            : ATTACHMENT_ICONS[attachmentKind(it.filename, it.contentType)]}
        </div>
        <div>{msg}</div>
      </div>
    );
  }

  _renderSheets(sheets: SheetView[]) {
    if (!sheets.length) {
      return (
        <div className="offline-viewer-note">
          {tr('אין גיליונות בקובץ', 'No sheets in this file')}
        </div>
      );
    }
    const i = Math.min(this.state.sheet, sheets.length - 1);
    const s = sheets[i];
    const cols = s.rows.reduce((n, r) => Math.max(n, r.length), 0);
    return (
      <div className="offline-viewer-sheets">
        <div className="offline-viewer-sheet-grid" style={{ zoom: this.state.zoom } as any}>
          <table data-offline-viewer-sheet={i}>
            <thead>
              <tr>
                <th />
                {Array.from({ length: cols }, (_x, c) => (
                  <th key={c}>{columnName(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r, ri) => (
                <tr key={ri}>
                  <th>{ri + 1}</th>
                  {Array.from({ length: cols }, (_x, c) => (
                    <td key={c} dir="auto">
                      {r[c] || ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {s.truncatedRows || s.truncatedCols ? (
            <div className="offline-viewer-note">
              {tr(
                `מוצגות ${s.rows.length.toLocaleString()} שורות ראשונות (מתוך ${s.totalRows.toLocaleString()}). לגיליון המלא פתח בתוכנה.`,
                `Showing the first ${s.rows.length.toLocaleString()} rows (of ${s.totalRows.toLocaleString()}). Open with the program for the full sheet.`
              )}
            </div>
          ) : null}
        </div>
        <div className="offline-viewer-sheet-tabs" role="tablist">
          {sheets.map((sh, k) => (
            <button
              type="button"
              key={k}
              role="tab"
              aria-selected={k === i}
              className={classNames('offline-viewer-sheet-tab', { active: k === i })}
              data-offline-viewer-sheet-tab={k}
              dir="auto"
              onClick={() => this.setState({ sheet: k })}
            >
              {sh.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  _renderSlides(slides: SlideView[]) {
    if (!slides.length) {
      return <div className="offline-viewer-note">{tr('לא נמצאו שקופיות', 'No slides found')}</div>;
    }
    return (
      <div className="offline-viewer-slides" style={{ zoom: this.state.zoom } as any}>
        <div className="offline-viewer-note">
          {tr(
            'תצוגת מתאר: הטקסט והתמונות של כל שקופית (לא עיצוב מלא). לעיצוב המלא פתח בתוכנה.',
            'Outline view: the text and pictures of each slide (not the full design). Open with the program for the full design.'
          )}
        </div>
        {slides.map((s) => (
          <div className="offline-viewer-slide" key={s.index} data-offline-viewer-slide={s.index}>
            <div className="offline-viewer-slide-num">
              {tr(`שקופית ${s.index}`, `Slide ${s.index}`)}
            </div>
            {s.lines.length ? (
              <>
                <div className="offline-viewer-slide-title" dir="auto">
                  {s.lines[0]}
                </div>
                {s.lines.slice(1).map((l, k) => (
                  <div className="offline-viewer-slide-line" dir="auto" key={k}>
                    {l}
                  </div>
                ))}
              </>
            ) : (
              <div className="offline-viewer-note">
                {tr('(אין טקסט בשקופית)', '(no text on this slide)')}
              </div>
            )}
            {s.images.length ? (
              <div className="offline-viewer-slide-images">
                {s.images.map((im, k) => (
                  <img
                    key={k}
                    alt=""
                    src={`data:${im.mime};base64,${im.data.toString('base64')}`}
                  />
                ))}
              </div>
            ) : null}
            {s.notes.length ? (
              <div className="offline-viewer-slide-notes" dir="auto">
                {tr('הערות: ', 'Notes: ')}
                {s.notes.join(' · ')}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  _renderEml(e: EmlView) {
    return (
      <div className="offline-viewer-eml">
        <div className="offline-viewer-eml-head" style={{ zoom: this.state.zoom } as any}>
          <div className="offline-viewer-eml-subject" dir="auto">
            {e.subject}
          </div>
          <div dir="auto">
            <b>{tr('מאת: ', 'From: ')}</b>
            {e.from}
          </div>
          {e.to ? (
            <div dir="auto">
              <b>{tr('אל: ', 'To: ')}</b>
              {e.to}
            </div>
          ) : null}
          {e.cc ? (
            <div dir="auto">
              <b>{tr('עותק: ', 'Cc: ')}</b>
              {e.cc}
            </div>
          ) : null}
          {e.date ? (
            <div dir="auto">
              <b>{tr('תאריך: ', 'Date: ')}</b>
              {e.date}
            </div>
          ) : null}
          {e.attachments.length ? (
            <div className="offline-viewer-eml-att" dir="auto">
              📎 {e.attachments.map((a) => `${a.filename} (${formatBytes(a.size)})`).join(' · ')}
            </div>
          ) : null}
        </div>
        {e.html ? (
          this._frame(e.html)
        ) : (
          <pre className="offline-viewer-text" dir="auto" style={{ zoom: this.state.zoom } as any}>
            {e.text}
          </pre>
        )}
      </div>
    );
  }

  _frame(html: string) {
    return (
      <iframe
        className="offline-viewer-frame"
        title={tr('תצוגה מקדימה', 'Preview')}
        // No scripts, no same-origin access, no forms, no popups.
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={viewerHtmlDocument(html, this.state.zoom)}
        data-offline-viewer-frame="true"
      />
    );
  }

  _renderBody() {
    const { content, loading, error, guard } = this.state;
    const it = this.props.items[this.props.index];
    if (!it) return null;
    if (guard && guard.blocked) return this._renderBlocked(guard, it);
    if (loading)
      return (
        <div className="offline-viewer-note">{tr('טוען תצוגה מקדימה…', 'Loading preview…')}</div>
      );
    if (error) {
      return (
        <div className="offline-viewer-blocked" data-offline-viewer-error="true">
          <div className="offline-viewer-blocked-icon">⚠️</div>
          <div>
            {tr(
              'לא ניתן להציג את הקובץ בתוך התוכנה. אפשר לפתוח אותו בתוכנה המתאימה.',
              'This file could not be shown inside the app. You can open it with its program.'
            )}
          </div>
          <div className="offline-viewer-error-detail" dir="ltr">
            {error}
          </div>
        </div>
      );
    }
    if (!content) return null;
    switch (content.type) {
      case 'pdf':
        return (
          <div className="offline-viewer-pdf" data-offline-viewer-pdf-pages={content.pages}>
            <div ref={this._pagesRef} className="offline-viewer-pdf-pages" />
            {content.pages > VIEWER_PDF_MAX_PAGES ? (
              <div className="offline-viewer-note">
                {tr(
                  `מוצגים ${VIEWER_PDF_MAX_PAGES} עמודים ראשונים מתוך ${content.pages}.`,
                  `Showing the first ${VIEWER_PDF_MAX_PAGES} of ${content.pages} pages.`
                )}
              </div>
            ) : null}
          </div>
        );
      case 'image':
        return (
          <div className="offline-viewer-image">
            <img
              src={content.url}
              alt={it.filename}
              data-offline-viewer-image="true"
              style={{ transform: `scale(${this.state.zoom})`, transformOrigin: 'top center' }}
            />
          </div>
        );
      case 'html':
        return this._frame(content.html);
      case 'sheets':
        return this._renderSheets(content.sheets);
      case 'slides':
        return this._renderSlides(content.slides);
      case 'eml':
        return this._renderEml(content.eml);
      case 'text':
        return (
          <div className="offline-viewer-textwrap">
            <pre
              className={classNames('offline-viewer-text', { mono: content.mono })}
              dir="auto"
              style={{ zoom: this.state.zoom } as any}
              data-offline-viewer-text="true"
            >
              {content.text}
            </pre>
            {content.truncated ? (
              <div className="offline-viewer-note">
                {tr('הקובץ ארוך; מוצג רק ההתחלה.', 'Long file; only the beginning is shown.')}
              </div>
            ) : null}
          </div>
        );
    }
    return null;
  }

  render() {
    const { items, index } = this.props;
    const it = items[index];
    if (!it) return null;
    const rtl = offlineDir() === 'rtl';
    const { zoom, content, pdfRendered, guard } = this.state;
    const kindClass = guard ? `kind-${guard.kind}` : '';
    return ReactDOM.createPortal(
      <div
        className="offline-viewer-backdrop"
        data-offline-viewer="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) this.props.onClose();
        }}
      >
        <div
          className={classNames('offline-viewer', kindClass)}
          dir={offlineDir()}
          role="dialog"
          aria-modal="true"
          aria-label={tr('צפייה בקובץ מצורף', 'Attachment viewer')}
          ref={this._rootRef}
          tabIndex={-1}
          data-offline-viewer-kind={guard ? guard.kind : ''}
          data-offline-viewer-index={index}
        >
          <div className="offline-viewer-bar">
            <div className="offline-viewer-nav">
              <button
                type="button"
                className="offline-viewer-btn"
                data-offline-viewer-prev="true"
                disabled={index <= 0}
                title={tr('הקובץ הקודם', 'Previous file')}
                onClick={() => this._go(-1)}
              >
                {rtl ? '›' : '‹'} {tr('הקודם', 'Previous')}
              </button>
              <span className="offline-viewer-count" data-offline-viewer-count="true">
                {tr(`${index + 1} מתוך ${items.length}`, `${index + 1} of ${items.length}`)}
              </span>
              <button
                type="button"
                className="offline-viewer-btn"
                data-offline-viewer-next="true"
                disabled={index >= items.length - 1}
                title={tr('הקובץ הבא', 'Next file')}
                onClick={() => this._go(1)}
              >
                {tr('הבא', 'Next')} {rtl ? '‹' : '›'}
              </button>
            </div>
            <div className="offline-viewer-title" title={it.filename}>
              <span aria-hidden="true">
                {ATTACHMENT_ICONS[attachmentKind(it.filename, it.contentType)]}
              </span>{' '}
              <span className="offline-viewer-name" dir="auto">
                {it.filename}
              </span>{' '}
              <span className="offline-viewer-size" dir="ltr">
                {formatBytes(it.size)}
              </span>
              {content && content.type === 'pdf' ? (
                <span className="offline-viewer-pages">
                  {' · '}
                  {tr(`${content.pages} עמודים`, `${content.pages} pages`)}
                  {pdfRendered < Math.min(content.pages, VIEWER_PDF_MAX_PAGES) ? '…' : ''}
                </span>
              ) : null}
            </div>
            <div className="offline-viewer-tools">
              <button
                type="button"
                className="offline-viewer-btn"
                data-offline-viewer-zoom-out="true"
                title={tr('הקטן (Ctrl −)', 'Zoom out (Ctrl −)')}
                onClick={() => this._zoom(-1)}
              >
                −
              </button>
              <button
                type="button"
                className="offline-viewer-btn offline-viewer-zoom"
                data-offline-viewer-zoom={zoom}
                title={tr('גודל רגיל (Ctrl 0)', 'Actual size (Ctrl 0)')}
                onClick={() => this.setState({ zoom: 1 })}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="offline-viewer-btn"
                data-offline-viewer-zoom-in="true"
                title={tr('הגדל (Ctrl +)', 'Zoom in (Ctrl +)')}
                onClick={() => this._zoom(1)}
              >
                +
              </button>
              <button
                type="button"
                className="offline-viewer-btn"
                data-offline-viewer-open="true"
                title={tr('פתח בתוכנה המתאימה במחשב', 'Open with the default app')}
                onClick={() => this.props.onOpenInApp(index)}
              >
                {tr('פתח בתוכנה', 'Open in app')}
              </button>
              {this.props.onSave ? (
                <button
                  type="button"
                  className="offline-viewer-btn"
                  data-offline-viewer-save="true"
                  onClick={() => this.props.onSave && this.props.onSave(index)}
                >
                  {tr('שמור בשם…', 'Save as…')}
                </button>
              ) : null}
              <button
                type="button"
                className="offline-viewer-btn offline-viewer-close"
                data-offline-viewer-close="true"
                title={tr('סגור (Esc)', 'Close (Esc)')}
                onClick={() => this.props.onClose()}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="offline-viewer-body" data-offline-viewer-body="true">
            {this._renderBody()}
          </div>
        </div>
      </div>,
      this._host
    );
  }
}

/** DOMPurify in the window (bundled), on top of the sandbox + CSP. */
function purify(html: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('dompurify');
    const DOMPurify = mod.sanitize
      ? mod
      : mod.default && mod.default.sanitize
        ? mod.default
        : mod(window);
    return DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: false,
      FORCE_BODY: true,
      FORBID_TAGS: [
        'script',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'button',
        'link',
        'meta',
        'base',
      ],
      FORBID_ATTR: ['srcset', 'ping', 'formaction', 'action'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
  } catch (e) {
    return html;
  }
}
