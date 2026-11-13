import React from 'react';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { OfflineDraftEditor } from './offline-drafts-view';
import { OfflineDraftSource } from '../core/offline-drafts';
import { tr } from '../core/offline-i18n';
import { OfflineStoreComponent } from './use-offline-store';
import { buildSandboxedHtmlDocument, containsHebrew } from '../core/offline-mail-mime';

type State = { showText: boolean };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class OfflineMessageReader extends OfflineStoreComponent<Record<string, never>, State> {
  static displayName = 'OfflineMessageReader';
  static containerStyles = { minWidth: 360, maxWidth: 999999 };

  state: State = { showText: false };

  _draftSource(): OfflineDraftSource | null {
    const open = offlineMailStore.openMessage;
    if (!open || !open.parsed) {
      return null;
    }
    const m = open.parsed;
    return {
      id: open.id,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      date: m.date,
      text: m.text,
    };
  }

  render() {
    if (offlineDraftsStore.showing) {
      return <OfflineDraftEditor />;
    }
    const s = offlineMailStore;
    const open = s.openMessage;
    if (s.selectedIds.length > 1) {
      return (
        <div className="offline-reader empty" data-offline-reader="multi">
          <div className="offline-reader-placeholder">
            {tr(
              `${s.selectedIds.length} הודעות נבחרו — בחר "נבחרות" בחלון ה-AI כדי לשאול עליהן.`,
              `${s.selectedIds.length} messages selected — use the AI panel “Selected” range to ask about them.`
            )}
          </div>
        </div>
      );
    }
    if (!open) {
      return (
        <div className="offline-reader empty" data-offline-reader="none">
          <div className="offline-reader-placeholder">
            {tr(
              'בחר הודעה כדי לקרוא אותה (עותק מקומי, קריאה בלבד).',
              'Select a message to read it (local copy, read-only).'
            )}
          </div>
        </div>
      );
    }
    if (open.loading) {
      return (
        <div className="offline-reader empty" data-offline-reader="loading">
          <div className="offline-reader-placeholder">{tr('פותח…', 'Opening…')}</div>
        </div>
      );
    }
    if (open.error || !open.parsed) {
      return (
        <div className="offline-reader empty" data-offline-reader="error">
          <div className="offline-reader-placeholder">
            {tr('לא ניתן לפתוח את ההודעה: ', 'Could not open this message: ')}
            {open.error}
          </div>
        </div>
      );
    }
    const m = open.parsed;
    const useHtml = !!m.html && !this.state.showText;
    const bodyHebrew = containsHebrew(m.text.slice(0, 4000));
    return (
      <div
        className="offline-reader"
        data-offline-reader="message"
        data-offline-reader-id={open.id}
        data-body-kind={useHtml ? 'html' : 'text'}
        data-body-hebrew={bodyHebrew ? 'true' : 'false'}
      >
        <div className="offline-reader-actions">
          <span
            className="offline-readonly-pill"
            title={tr(
              'שליחה, העברה למקום אחר ומחיקה כבויות בניסוי הלא מקוון',
              'Sending, moving and deleting are disabled in the offline experiment'
            )}
          >
            {tr('קריאה בלבד · אין שליחה/העברה/מחיקה', 'Read-only · no send/move/delete')}
          </span>
          <button
            className="btn btn-small offline-reply-btn"
            data-offline-reply="true"
            title={tr(
              'פותח טיוטת תשובה שנשמרת רק במחשב (אין שליחה)',
              'Opens a reply draft saved only on this computer (no sending)'
            )}
            onClick={() => {
              const src = this._draftSource();
              if (src) {
                offlineDraftsStore.createReply(src);
              }
            }}
          >
            ↩️ {tr('השב (טיוטה)', 'Reply (draft)')}
          </button>
          <button
            className="btn btn-small offline-forward-btn"
            data-offline-forward="true"
            title={tr(
              'פותח טיוטת העברה שנשמרת רק במחשב (אין שליחה)',
              'Opens a forward draft saved only on this computer (no sending)'
            )}
            onClick={() => {
              const src = this._draftSource();
              if (src) {
                offlineDraftsStore.createForward(src);
              }
            }}
          >
            ↪️ {tr('העבר (טיוטה)', 'Forward (draft)')}
          </button>
          {m.html ? (
            <button
              className="btn btn-small"
              onClick={() => this.setState({ showText: !this.state.showText })}
            >
              {this.state.showText
                ? tr('הצג מעוצב', 'Show formatted')
                : tr('הצג טקסט פשוט', 'Show plain text')}
            </button>
          ) : null}
        </div>
        <h2 className="offline-reader-subject" dir="auto" data-offline-reader-subject="true">
          {m.subject}
        </h2>
        <dl className="offline-reader-headers">
          <dt>{tr('מאת', 'From')}</dt>
          <dd dir="auto">{m.from}</dd>
          {m.to ? (
            <>
              <dt>{tr('אל', 'To')}</dt>
              <dd dir="auto">{m.to}</dd>
            </>
          ) : null}
          {m.cc ? (
            <>
              <dt>{tr('עותק', 'Cc')}</dt>
              <dd dir="auto">{m.cc}</dd>
            </>
          ) : null}
          <dt>{tr('תאריך', 'Date')}</dt>
          <dd>{m.date}</dd>
        </dl>
        {m.attachments.length ? (
          <div className="offline-reader-attachments" data-attachment-count={m.attachments.length}>
            {m.attachments.map((a, i) => (
              <span key={i} className="offline-attachment" dir="auto" title={a.contentType}>
                📎 {a.filename} <small>({formatSize(a.size)})</small>
              </span>
            ))}
          </div>
        ) : null}
        {useHtml ? (
          <iframe
            key={open.id}
            className="offline-reader-html"
            data-offline-reader-body="html"
            title={tr('גוף ההודעה', 'Message body')}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildSandboxedHtmlDocument(m.html as string)}
          />
        ) : (
          <div className="offline-reader-text" dir="auto" data-offline-reader-body="text">
            {m.text}
          </div>
        )}
      </div>
    );
  }
}
