import React from 'react';
import classNames from 'classnames';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { OfflineDraftEditor } from './offline-drafts-view';
import { OfflineDraftSource } from '../core/offline-drafts';
import { tr } from '../core/offline-i18n';
import { OfflineStoreComponent } from './use-offline-store';
import {
  OfflineMailAttachment,
  ParsedOfflineMail,
  buildSandboxedHtmlDocument,
  containsHebrew,
} from '../core/offline-mail-mime';
import { OfflineAttachmentList } from './offline-attachments-view';
import {
  OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES,
  extractAttachmentToProfile,
} from '../core/offline-attachments';
import { openWithDefaultApp, saveBytesAs } from './offline-file-actions';
import fs from 'fs';

type State = { showText: boolean; textIds: string[] };

/** Attachment bytes of one message, read on demand from the local copy. */
const attachmentCache: { id: string | null; list: OfflineMailAttachment[] } = {
  id: null,
  list: [],
};
export function offlineAttachmentBytes(id: string): OfflineMailAttachment[] {
  if (attachmentCache.id !== id) {
    attachmentCache.list = offlineMailStore.attachmentData(id);
    attachmentCache.id = id;
  }
  return attachmentCache.list;
}

export function renderMessageAttachments(id: string, list: OfflineMailAttachment[]) {
  if (!list.length) {
    return null;
  }
  const dataAt = (i: number): OfflineMailAttachment => {
    const a = offlineAttachmentBytes(id)[i];
    if (!a || !a.data) {
      throw new Error(tr('הקובץ לא נמצא בהודעה', 'File not found in the message'));
    }
    return a;
  };
  return (
    <OfflineAttachmentList
      context="reader"
      items={list.map((a, i) => ({
        key: `${id}#${i}`,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      }))}
      loadImage={(i) => dataAt(i).data || null}
      loadForView={async (i) => {
        // The viewer reads the copy in the offline profile's temp folder only.
        const dir = offlineMailStore.configDir;
        if (!dir) {
          throw new Error(tr('אין תיקיית פרופיל', 'No profile folder'));
        }
        const a = dataAt(i);
        const file = extractAttachmentToProfile(dir, id, i, a.filename, a.data as Buffer);
        return fs.promises.readFile(file);
      }}
      onOpen={async (i) => {
        const dir = offlineMailStore.configDir;
        if (!dir) {
          return tr('אין תיקיית פרופיל', 'No profile folder');
        }
        try {
          const a = dataAt(i);
          const file = extractAttachmentToProfile(dir, id, i, a.filename, a.data as Buffer);
          return openWithDefaultApp(file);
        } catch (err) {
          return String((err as Error).message || err);
        }
      }}
      onSave={(i) => {
        const a = dataAt(i);
        return saveBytesAs(a.filename, a.data as Buffer, offlineMailStore.root);
      }}
    />
  );
}

/** Original attachments carried into a forward draft (copied into the profile). */
export function forwardFiles(id: string) {
  try {
    return offlineAttachmentBytes(id)
      .filter((a) => a.data && a.data.length <= OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES)
      .map((a) => ({ filename: a.filename, contentType: a.contentType, data: a.data as Buffer }));
  } catch (err) {
    console.warn('[Offline mail] attachments not carried into the forward');
    return [];
  }
}

export class OfflineMessageReader extends OfflineStoreComponent<Record<string, never>, State> {
  static displayName = 'OfflineMessageReader';
  static containerStyles = { minWidth: 360, maxWidth: 999999 };

  state: State = { showText: false, textIds: [] };

  _draftSource(): OfflineDraftSource | null {
    const open = offlineMailStore.openMessage;
    if (!open || !open.parsed) {
      return null;
    }
    return this._sourceFor(open.id, open.parsed);
  }

  _sourceFor(id: string, m: ParsedOfflineMail): OfflineDraftSource {
    return {
      id,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      date: m.date,
      text: m.text,
    };
  }

  _toggleText(id: string) {
    const has = this.state.textIds.includes(id);
    this.setState({
      textIds: has ? this.state.textIds.filter((x) => x !== id) : [...this.state.textIds, id],
    });
  }

  _renderThreadMessage(id: string, isNewest: boolean) {
    const s = offlineMailStore;
    const t = s.openThread;
    const entry = s.getEntry(id);
    if (!t || !entry) {
      return null;
    }
    const m = t.parsed[id];
    const err = t.errors[id];
    const expanded = t.expanded.has(id);
    const otherFolder = entry.folder !== s.currentFolder ? s.findFolder(entry.folder) : null;
    const snippet = m ? m.text.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    const useHtml = !!m && !!m.html && !this.state.textIds.includes(id);
    return (
      <div
        key={id}
        className={classNames('offline-thread-msg', { expanded, newest: isNewest })}
        data-offline-thread-msg={id}
        data-expanded={expanded ? 'true' : 'false'}
      >
        <div
          className="offline-thread-msg-head"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          title={
            expanded ? tr('כווץ הודעה', 'Collapse message') : tr('הרחב הודעה', 'Expand message')
          }
          onClick={() => s.toggleThreadMessage(id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              s.toggleThreadMessage(id);
            }
          }}
        >
          <span className="offline-thread-caret">{expanded ? '▾' : '▸'}</span>
          <span className="offline-thread-from" dir="auto">
            {m ? m.from : entry.from}
          </span>
          {otherFolder ? (
            <span className="offline-thread-folder" dir="auto" title={tr('תיקייה', 'Folder')}>
              {otherFolder.name}
            </span>
          ) : null}
          {entry.hasAttachments ? <span className="offline-thread-attach">📎</span> : null}
          <span className="offline-thread-date" dir="auto">
            {m ? m.date : entry.date}
          </span>
          {!expanded ? (
            <div className="offline-thread-snippet" dir="auto">
              {err ? tr('לא ניתן לפתוח', 'Could not open') : snippet || '…'}
            </div>
          ) : null}
        </div>
        {expanded ? (
          <div className="offline-thread-msg-body">
            {!m ? (
              <div className="offline-reader-placeholder">
                {err
                  ? `${tr('לא ניתן לפתוח את ההודעה: ', 'Could not open this message: ')}${err}`
                  : tr('פותח…', 'Opening…')}
              </div>
            ) : (
              <>
                <div className="offline-reader-actions offline-thread-msg-actions">
                  <button
                    className="btn btn-small offline-reply-btn"
                    data-offline-reply="true"
                    title={tr(
                      'פותח טיוטת תשובה שנשמרת רק במחשב (אין שליחה)',
                      'Opens a reply draft saved only on this computer (no sending)'
                    )}
                    onClick={() => offlineDraftsStore.createReply(this._sourceFor(id, m))}
                  >
                    ↩️ {tr('השב', 'Reply')}
                  </button>
                  <button
                    className="btn btn-small offline-forward-btn"
                    data-offline-forward="true"
                    title={tr(
                      'פותח טיוטת העברה שנשמרת רק במחשב (אין שליחה)',
                      'Opens a forward draft saved only on this computer (no sending)'
                    )}
                    onClick={() =>
                      offlineDraftsStore.createForward(this._sourceFor(id, m), forwardFiles(id))
                    }
                  >
                    ↪️ {tr('העבר', 'Forward')}
                  </button>
                  {m.html ? (
                    <button className="btn btn-small" onClick={() => this._toggleText(id)}>
                      {useHtml
                        ? tr('הצג טקסט פשוט', 'Show plain text')
                        : tr('הצג מעוצב', 'Show formatted')}
                    </button>
                  ) : null}
                </div>
                <dl className="offline-reader-headers">
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
                </dl>
                {renderMessageAttachments(id, m.attachments)}
                {useHtml ? (
                  <iframe
                    key={id}
                    className="offline-reader-html offline-thread-html"
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
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  _renderThread() {
    const s = offlineMailStore;
    const t = s.openThread;
    if (!t) {
      return null;
    }
    const newest = t.ids[t.ids.length - 1];
    // Conversation title: the first message's subject (no Re:/Fwd: chain).
    const first = t.ids[0];
    const subject =
      t.parsed[first]?.subject || s.getEntry(first)?.subject || s.getEntry(newest)?.subject || '';
    const allExpanded = t.ids.every((id) => t.expanded.has(id));
    return (
      <div
        className="offline-reader offline-thread"
        data-offline-reader="thread"
        data-offline-thread-key={t.key}
        data-offline-thread-count={t.ids.length}
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
            className="btn btn-small"
            data-offline-thread-expand-all={allExpanded ? 'collapse' : 'expand'}
            onClick={() => s.setThreadExpandedAll(!allExpanded)}
          >
            {allExpanded ? tr('כווץ הכל', 'Collapse all') : tr('הרחב הכל', 'Expand all')}
          </button>
          {t.loading ? (
            <span className="offline-thread-loading">{tr('טוען…', 'Loading…')}</span>
          ) : null}
        </div>
        <h2 className="offline-reader-subject" dir="auto" data-offline-reader-subject="true">
          {subject}
        </h2>
        <div className="offline-thread-meta">
          {tr(`${t.ids.length} הודעות בשיחה`, `${t.ids.length} messages in this conversation`)}
        </div>
        <div className="offline-thread-list">
          {t.ids.map((id) => this._renderThreadMessage(id, id === newest))}
        </div>
      </div>
    );
  }

  render() {
    if (offlineDraftsStore.showing) {
      return <OfflineDraftEditor />;
    }
    const s = offlineMailStore;
    const open = s.openMessage;
    if (s.selectedKeys.length > 1) {
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
    if (s.openThread) {
      return this._renderThread();
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
            ↩️ {tr('השב', 'Reply')}
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
                offlineDraftsStore.createForward(src, forwardFiles(src.id));
              }
            }}
          >
            ↪️ {tr('העבר', 'Forward')}
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
        {renderMessageAttachments(open.id, m.attachments)}
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
