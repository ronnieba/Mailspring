/**
 * Offline experiment (t234): save a message or a whole conversation as PDF
 * or .eml, to a file the user picks in the save dialog. The mail copy is only
 * read (never written; saving into it is refused). The PDF is made from the
 * same sanitized page as Print, in a hidden window without scripts or network.
 */
import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tr, offlineDir } from '../core/offline-i18n';
import { offlineMailStore } from './offline-mail-store';
import {
  offlineActionsUi,
  buildPrintDocument,
  buildPrintDocumentMany,
} from './offline-message-actions';
import { loadOfflineMessage, readOfflineMessageRaw } from '../core/offline-mail-index';
import { OfflineHelpTip } from './offline-tour';

export type ExportFormat = 'pdf' | 'eml';
export type ExportWhat = 'message' | 'conversation';

type Listener = () => void;

export type ExportResult = { file: string; bytes: number; messages: number; format: ExportFormat };

/** Tests replace choosePath / renderPdf (no native dialog, no PDF engine). */
export const offlineExportHooks = {
  choosePath: async (defaultPath: string, format: ExportFormat): Promise<string | null> => {
    const remote = require('@electron/remote');
    const res = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {
      title: tr('שמירה בשם', 'Save as'),
      defaultPath,
      filters:
        format === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : [{ name: tr('הודעת דואר', 'Mail message'), extensions: ['eml'] }],
    });
    return res && !res.canceled && res.filePath ? res.filePath : null;
  },
  renderPdf: (html: string): Promise<Buffer> => renderPdfHidden(html),
  last: null as ExportResult | null,
};

/** A file name from a subject: no path / reserved characters, not too long. */
export function safeFileName(subject: string, fallback = 'message'): string {
  const s = String(subject || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u200e\u200f\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  const base = s || fallback;
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? `${base}_` : base;
}

function encodeHeader(s: string): string {
  const v = String(s || '').replace(/[\r\n]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/**
 * Several messages in ONE .eml: a MIME digest (RFC 2046), each original
 * message unchanged as a message/rfc822 part. Mail apps show it as a
 * message with the conversation's messages attached.
 */
export function buildDigestEml(parts: Buffer[], subject: string, date = new Date()): Buffer {
  let boundary = '';
  do {
    boundary = `ofl-digest-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  } while (parts.some((p) => p.includes(boundary)));
  const head =
    [
      'MIME-Version: 1.0',
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
      'X-Saved-By: Mail AI (offline copy)',
      `Content-Type: multipart/digest; boundary="${boundary}"`,
    ].join('\r\n') + '\r\n\r\n';
  const chunks: Buffer[] = [Buffer.from(head, 'latin1')];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`, 'latin1'));
    chunks.push(p);
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** True when `file` is inside the mail copy (never written to). */
export function isInsideMailCopy(file: string, root: string | null): boolean {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function documentsDir(): string {
  try {
    return require('@electron/remote').app.getPath('documents');
  } catch {
    return os.homedir();
  }
}

/** Messages to save, oldest first. */
export function exportIds(id: string, what: ExportWhat): string[] {
  const s = offlineMailStore;
  if (what === 'message') return [id];
  const ids = s.threadIdsFor(id).filter((x: string) => !!s.getEntry(x));
  return ids
    .slice()
    .sort((a: string, b: string) => (s.getEntry(a)?.ts || 0) - (s.getEntry(b)?.ts || 0));
}

/** Pick a file and save. Returns null when cancelled or refused. */
export async function exportMessages(
  id: string,
  what: ExportWhat,
  format: ExportFormat
): Promise<ExportResult | null> {
  const s = offlineMailStore;
  const root = s.root;
  const entry = s.getEntry(id);
  if (!root || !entry) return null;
  const ids = exportIds(id, what);
  if (!ids.length) return null;
  const name =
    safeFileName(entry.subject, tr('הודעה', 'message')) +
    (what === 'conversation' && ids.length > 1 ? tr(' (שיחה)', ' (conversation)') : '') +
    `.${format}`;
  let file = await offlineExportHooks.choosePath(path.join(documentsDir(), name), format);
  if (!file) return null;
  if (path.extname(file).toLowerCase() !== `.${format}`) file += `.${format}`;
  if (isInsideMailCopy(file, root)) {
    offlineActionsUi.showToast(
      tr(
        'לא שומרים בתוך עותק הדואר. בחרו תיקייה אחרת.',
        'Not saving inside the mail copy. Choose another folder.'
      ),
      null
    );
    return null;
  }
  let data: Buffer;
  if (format === 'eml') {
    const raws: Buffer[] = [];
    for (const x of ids) raws.push(await readOfflineMessageRaw(root, s.getEntry(x)!.rel));
    data = raws.length === 1 ? raws[0] : buildDigestEml(raws, entry.subject);
  } else {
    const parsed = [];
    for (const x of ids) parsed.push(await loadOfflineMessage(root, s.getEntry(x)!.rel));
    const html =
      parsed.length === 1 ? buildPrintDocument(parsed[0]) : buildPrintDocumentMany(parsed);
    data = await offlineExportHooks.renderPdf(html);
  }
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  const res: ExportResult = { file, bytes: data.length, messages: ids.length, format };
  offlineExportHooks.last = res;
  offlineActionsUi.showToast(
    tr(`💾 נשמר: ${path.basename(file)}`, `💾 Saved: ${path.basename(file)}`),
    null
  );
  return res;
}

/** PDF from the sanitized page: hidden window, no scripts, no network, temp file removed. */
async function renderPdfHidden(html: string): Promise<Buffer> {
  const dir = path.join(offlineMailStore.configDir || os.tmpdir(), 'offline-print');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pdf-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  const { BrowserWindow } = require('@electron/remote');
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'offline-print',
    },
  });
  try {
    win.webContents.session.webRequest.onBeforeRequest((details: any, cb: any) =>
      cb({ cancel: !String(details.url).startsWith('file:') })
    );
    await win.loadFile(file);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    return Buffer.from(pdf);
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // already gone
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // already removed
    }
  }
}

// ---- "Save as" window ----------------------------------------------------

class OfflineExportUi {
  target: { id: string; what: ExportWhat; format: ExportFormat; busy: boolean } | null = null;
  private _listeners = new Set<Listener>();
  listen(cb: Listener) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
  emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (e) {
        console.error('[Offline export] listener failed', e);
      }
    }
  }
}

export const offlineExportUi = new OfflineExportUi();

/** Open "Save as" for a message (default: the open message / selection). */
export function openExport(id?: string) {
  const s = offlineMailStore;
  const msgId =
    id ||
    s.openMessage?.id ||
    (s.openThread ? s.openThread.ids[s.openThread.ids.length - 1] : '') ||
    s.actionIds()[0];
  if (!msgId || !s.getEntry(msgId)) return;
  const inThread = exportIds(msgId, 'conversation').length;
  offlineExportUi.target = {
    id: msgId,
    what: s.openThread && inThread > 1 ? 'conversation' : 'message',
    format: 'pdf',
    busy: false,
  };
  offlineExportUi.emit();
}

function closeExport() {
  offlineExportUi.target = null;
  offlineExportUi.emit();
}

export class OfflineExportDialog extends React.Component<Record<string, never>, { tick: number }> {
  static displayName = 'OfflineExportDialog';
  state = { tick: 0 };
  private _un: (() => void) | null = null;

  componentDidMount() {
    this._un = offlineExportUi.listen(() => this.setState({ tick: this.state.tick + 1 }));
  }

  componentWillUnmount() {
    if (this._un) this._un();
  }

  _save = async () => {
    const t = offlineExportUi.target;
    if (!t || t.busy) return;
    offlineExportUi.target = { ...t, busy: true };
    offlineExportUi.emit();
    try {
      const res = await exportMessages(t.id, t.what, t.format);
      if (res) {
        closeExport();
        return;
      }
    } catch (err) {
      offlineActionsUi.showToast(
        tr(`השמירה נכשלה: ${(err as Error).message}`, `Saving failed: ${(err as Error).message}`),
        null
      );
    }
    if (offlineExportUi.target) {
      offlineExportUi.target = { ...offlineExportUi.target, busy: false };
      offlineExportUi.emit();
    }
  };

  render() {
    const t = offlineExportUi.target;
    if (!t) return null;
    const n = exportIds(t.id, 'conversation').length;
    const set = (p: Partial<NonNullable<typeof offlineExportUi.target>>) => {
      offlineExportUi.target = { ...t, ...p };
      offlineExportUi.emit();
    };
    const radio = (
      group: string,
      checked: boolean,
      onChange: () => void,
      label: string,
      attr: string,
      disabled = false
    ) => (
      <label className={`offline-rule-check${disabled ? ' is-disabled' : ''}`}>
        <input
          type="radio"
          name={group}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          data-offline-export-opt={attr}
        />
        {label}
      </label>
    );
    return (
      <div className="offline-modal-backdrop" onMouseDown={closeExport}>
        <div
          className="offline-modal offline-export"
          dir={offlineDir()}
          role="dialog"
          aria-label={tr('שמירה בשם', 'Save as')}
          data-offline-export="true"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.key === 'Escape' && closeExport()}
        >
          <div className="offline-modal-title">
            {tr('💾 שמירה בשם', '💾 Save as')}
            <OfflineHelpTip tip="export" />
          </div>
          <div className="offline-rule-section">{tr('מה לשמור', 'What to save')}</div>
          {radio(
            'ofl-export-what',
            t.what === 'message',
            () => set({ what: 'message' }),
            tr('ההודעה הזו', 'This message'),
            'message'
          )}
          {radio(
            'ofl-export-what',
            t.what === 'conversation',
            () => set({ what: 'conversation' }),
            n > 1
              ? tr(`כל השיחה (${n} הודעות)`, `The whole conversation (${n} messages)`)
              : tr('כל השיחה (הודעה אחת)', 'The whole conversation (1 message)'),
            'conversation',
            n < 2
          )}
          <div className="offline-rule-section">{tr('פורמט', 'Format')}</div>
          {radio(
            'ofl-export-format',
            t.format === 'pdf',
            () => set({ format: 'pdf' }),
            tr('PDF — לקריאה ולהדפסה', 'PDF — to read and print'),
            'pdf'
          )}
          {radio(
            'ofl-export-format',
            t.format === 'eml',
            () => set({ format: 'eml' }),
            tr(
              'eml — הודעת הדואר המקורית (נפתחת בכל תוכנת דואר)',
              'eml — the original mail message (opens in any mail app)'
            ),
            'eml'
          )}
          <div className="offline-modal-note">
            {t.what === 'conversation' && t.format === 'eml' && n > 1
              ? tr(
                  'שיחה נשמרת כקובץ eml אחד שבו כל ההודעות המקוריות מצורפות.',
                  'A conversation is saved as one .eml with every original message attached.'
                )
              : tr(
                  'תבחרו איפה לשמור בחלון הבא. עותק הדואר לא משתנה.',
                  'You choose where to save in the next window. The mail copy does not change.'
                )}
          </div>
          <div className="offline-modal-actions">
            <button type="button" className="btn" onClick={closeExport}>
              {tr('ביטול', 'Cancel')}
            </button>
            <button
              type="button"
              className="btn btn-emphasis"
              data-offline-export-save="true"
              disabled={t.busy}
              onClick={() => void this._save()}
            >
              {t.busy ? tr('שומר…', 'Saving…') : tr('שמור…', 'Save…')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
