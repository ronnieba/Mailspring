import React from 'react';
import { offlineMailStore } from './offline-mail-store';
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

  render() {
    const s = offlineMailStore;
    const open = s.openMessage;
    if (s.selectedIds.length > 1) {
      return (
        <div className="offline-reader empty" data-offline-reader="multi">
          <div className="offline-reader-placeholder">
            {s.selectedIds.length} messages selected — use the AI panel “Selected” scope to ask
            about them.
          </div>
        </div>
      );
    }
    if (!open) {
      return (
        <div className="offline-reader empty" data-offline-reader="none">
          <div className="offline-reader-placeholder">
            Select a message to read it (local copy, read-only).
          </div>
        </div>
      );
    }
    if (open.loading) {
      return (
        <div className="offline-reader empty" data-offline-reader="loading">
          <div className="offline-reader-placeholder">Opening…</div>
        </div>
      );
    }
    if (open.error || !open.parsed) {
      return (
        <div className="offline-reader empty" data-offline-reader="error">
          <div className="offline-reader-placeholder">
            Could not open this message: {open.error}
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
            title="Reply, forward, move and delete are disabled in the offline experiment"
          >
            קריאה בלבד · Read-only — reply/send/move/delete disabled
          </span>
          {m.html ? (
            <button
              className="btn btn-small"
              onClick={() => this.setState({ showText: !this.state.showText })}
            >
              {this.state.showText ? 'Show formatted' : 'Show plain text'}
            </button>
          ) : null}
        </div>
        <h2 className="offline-reader-subject" dir="auto" data-offline-reader-subject="true">
          {m.subject}
        </h2>
        <dl className="offline-reader-headers">
          <dt>From</dt>
          <dd dir="auto">{m.from}</dd>
          {m.to ? (
            <>
              <dt>To</dt>
              <dd dir="auto">{m.to}</dd>
            </>
          ) : null}
          {m.cc ? (
            <>
              <dt>Cc</dt>
              <dd dir="auto">{m.cc}</dd>
            </>
          ) : null}
          <dt>Date</dt>
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
            title="Message body"
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
