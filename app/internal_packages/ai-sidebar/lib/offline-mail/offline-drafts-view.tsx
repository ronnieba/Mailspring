/**
 * Offline experiment: local drafts list and editor.
 * Everything is saved only in the offline profile. There is no send path:
 * the send button below is permanently disabled and has no click handler.
 */
import React from 'react';
import classNames from 'classnames';
import { offlineDraftsStore } from './offline-drafts-store';
import { OFFLINE_DRAFTS_NO_SEND_NOTE, OfflineDraft, draftSnippet } from '../core/offline-drafts';
import { ProofSegment } from '../core/text-diff';
import { offlineDateLocale, offlineDir, tr } from '../core/offline-i18n';

class DraftsComponent<P = Record<string, never>, S = Record<string, never>> extends React.Component<
  P,
  S
> {
  private _unlisten: (() => void) | null = null;
  componentDidMount() {
    this._unlisten = offlineDraftsStore.listen(() => this.forceUpdate());
  }
  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
  }
}

function kindLabel(d: OfflineDraft): string {
  return d.kind === 'reply'
    ? tr('תשובה', 'Reply')
    : d.kind === 'forward'
      ? tr('העברה', 'Forward')
      : tr('חדשה', 'New');
}

function fmtTime(ts: number): string {
  if (!ts) {
    return '';
  }
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(offlineDateLocale(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(offlineDateLocale(), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

type ListState = { armedDelete: string | null };

export class OfflineDraftsList extends DraftsComponent<Record<string, never>, ListState> {
  static displayName = 'OfflineDraftsList';
  state: ListState = { armedDelete: null };

  _onDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (this.state.armedDelete !== id) {
      this.setState({ armedDelete: id });
      return;
    }
    this.setState({ armedDelete: null });
    offlineDraftsStore.delete(id);
  }

  render() {
    const s = offlineDraftsStore;
    return (
      <div className="offline-message-list offline-drafts-list" data-offline-drafts-list="true">
        <div className="offline-list-header">
          <div className="offline-list-title">
            📝 {tr('טיוטות מקומיות', 'Local drafts')}
            <span className="offline-list-count">{s.count.toLocaleString()}</span>
          </div>
          <div className="offline-drafts-actions" dir={offlineDir()}>
            <button
              className="btn btn-small offline-draft-new"
              data-offline-draft-new="true"
              onClick={() => s.createNew()}
            >
              ✉️ {tr('טיוטה חדשה', 'New draft')}
            </button>
            <span className="offline-drafts-note">
              {tr(
                'נשמר רק במחשב הזה, בפרופיל הניסוי. אין שליחה.',
                'Saved only on this computer, in the experiment profile. No sending.'
              )}
            </span>
          </div>
        </div>
        <div className="offline-list-scroll" role="listbox">
          {s.drafts.length === 0 ? (
            <div className="offline-drafts-empty">
              {tr(
                'אין טיוטות עדיין. לחץ "טיוטה חדשה", או "השב" / "העבר" בהודעה.',
                'No drafts yet. Click "New draft", or "Reply" / "Forward" on a message.'
              )}
            </div>
          ) : (
            s.drafts.map((d) => (
              <div
                key={d.id}
                className={classNames('offline-draft-row', { selected: d.id === s.openId })}
                data-offline-draft-id={d.id}
                role="option"
                aria-selected={d.id === s.openId}
                onClick={() => s.openDraft(d.id)}
              >
                <div className="offline-row-main">
                  <div className="offline-row-line1">
                    <span className="offline-draft-kind">{kindLabel(d)}</span>
                    <span className="offline-row-from" dir="auto">
                      {d.to || tr('(ללא נמען)', '(no recipient)')}
                    </span>
                    <span className="offline-row-date">{fmtTime(d.updatedAt)}</span>
                  </div>
                  <div className="offline-row-subject" dir="auto">
                    {d.subject || tr('(ללא נושא)', '(no subject)')}
                  </div>
                  <div className="offline-draft-snippet" dir="auto">
                    {draftSnippet(d)}
                  </div>
                </div>
                <button
                  className={classNames('btn btn-small offline-draft-delete', {
                    armed: this.state.armedDelete === d.id,
                  })}
                  data-offline-draft-delete={d.id}
                  title={tr('מחק טיוטה', 'Delete draft')}
                  aria-label={tr('מחק טיוטה', 'Delete draft')}
                  onClick={(e) => this._onDelete(e, d.id)}
                >
                  {this.state.armedDelete === d.id ? tr('למחוק?', 'Delete?') : '🗑'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
}

function renderSegments(segs: ProofSegment[], decisions: Map<number, boolean>) {
  return segs.map((seg, i) => {
    if (seg.kind === 'same') {
      return <span key={i}>{seg.text}</span>;
    }
    const c = seg.change;
    const d = decisions.get(c.id);
    return (
      <span
        key={i}
        className={classNames('offline-proof-change', {
          accepted: d === true,
          rejected: d === false,
        })}
        data-proof-change={c.id}
      >
        {c.before ? <del>{c.before}</del> : null}
        {c.after ? <ins>{c.after}</ins> : null}
        <sup>{c.id}</sup>
      </span>
    );
  });
}

type EditorState = { armedDelete: boolean };

export class OfflineDraftEditor extends DraftsComponent<Record<string, never>, EditorState> {
  static displayName = 'OfflineDraftEditor';
  state: EditorState = { armedDelete: false };

  _renderProof(d: OfflineDraft) {
    const p = offlineDraftsStore.proof;
    if (p.draftId !== d.id || p.status === 'idle') {
      return null;
    }
    if (p.status === 'running') {
      return (
        <div className="offline-proof" data-offline-proof="running">
          {tr(
            '✨ שולח ל-Gemini רק את טקסט הטיוטה וממתין להצעות…',
            '✨ Sending only the draft text to Gemini and waiting for suggestions…'
          )}
        </div>
      );
    }
    if (p.status === 'error') {
      return (
        <div className="offline-proof error" data-offline-proof="error">
          ❌ {p.error}
          <button className="btn btn-small" onClick={() => offlineDraftsStore.discardProof()}>
            {tr('סגור', 'Close')}
          </button>
        </div>
      );
    }
    const n = offlineDraftsStore.proofChangeCount();
    if (n === 0) {
      return (
        <div className="offline-proof" data-offline-proof="review" data-proof-count="0">
          ✅ {tr('Gemini לא מצא מה לתקן.', 'Gemini found nothing to fix.')}
          <button className="btn btn-small" onClick={() => offlineDraftsStore.discardProof()}>
            {tr('סגור', 'Close')}
          </button>
        </div>
      );
    }
    const changes = p.segments.filter((s) => s.kind === 'change') as Array<
      Extract<ProofSegment, { kind: 'change' }>
    >;
    return (
      <div className="offline-proof" data-offline-proof="review" data-proof-count={n}>
        <div className="offline-proof-title">
          {tr(
            `✨ הצעות תיקון (${n}) — אשר או דחה כל שינוי`,
            `✨ Suggestions (${n}) — accept or reject each change`
          )}
        </div>
        {p.error ? <div className="offline-proof-warning">⚠️ {p.error}</div> : null}
        <div className="offline-proof-preview" dir="auto">
          {renderSegments(p.segments, p.decisions)}
        </div>
        <ol className="offline-proof-list">
          {changes.map(({ change: c }) => {
            const dec = p.decisions.get(c.id);
            return (
              <li key={c.id} data-proof-item={c.id}>
                <span className="offline-proof-pair" dir="auto">
                  <del>{c.before || tr('(כלום)', '(nothing)')}</del> →{' '}
                  <ins>{c.after || tr('(מחיקה)', '(remove)')}</ins>
                </span>
                <button
                  className={classNames('btn btn-small offline-proof-accept', { on: dec === true })}
                  data-proof-accept={c.id}
                  onClick={() => offlineDraftsStore.decide(c.id, dec === true ? null : true)}
                >
                  ✓ {tr('קבל', 'Accept')}
                </button>
                <button
                  className={classNames('btn btn-small offline-proof-reject', {
                    on: dec === false,
                  })}
                  data-proof-reject={c.id}
                  onClick={() => offlineDraftsStore.decide(c.id, dec === false ? null : false)}
                >
                  ✗ {tr('דחה', 'Reject')}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="offline-proof-actions">
          <button
            className="btn btn-small btn-emphasis"
            data-proof-apply="true"
            onClick={() => offlineDraftsStore.applyProof()}
          >
            {tr('החל את מה שאישרתי', 'Apply accepted changes')}
          </button>
          <button className="btn btn-small" onClick={() => offlineDraftsStore.decideAll(true)}>
            {tr('קבל הכל', 'Accept all')}
          </button>
          <button className="btn btn-small" onClick={() => offlineDraftsStore.decideAll(false)}>
            {tr('דחה הכל', 'Reject all')}
          </button>
          <button className="btn btn-small" onClick={() => offlineDraftsStore.discardProof()}>
            {tr('בטל', 'Cancel')}
          </button>
        </div>
        <div className="offline-proof-note">
          {tr(
            'שינוי שלא אושר נשאר כמו שכתבת.',
            'Changes you do not accept stay as you wrote them.'
          )}
        </div>
      </div>
    );
  }

  render() {
    const s = offlineDraftsStore;
    const d = s.open;
    if (!d) {
      return (
        <div className="offline-reader empty" data-offline-draft-editor="none">
          <div className="offline-reader-placeholder">
            {tr(
              'בחר טיוטה מהרשימה, או צור טיוטה חדשה.',
              'Pick a draft from the list, or create a new one.'
            )}
          </div>
        </div>
      );
    }
    const running = s.proof.status === 'running' && s.proof.draftId === d.id;
    return (
      <div
        className="offline-reader offline-draft-editor"
        data-offline-draft-editor={d.id}
        dir={offlineDir()}
      >
        <div className="offline-reader-actions">
          <span className="offline-draft-kind">{kindLabel(d)}</span>
          <span
            className="offline-draft-saved"
            data-offline-draft-saved={s.savedAt ? 'true' : 'false'}
          >
            {s.saveError
              ? `⚠️ ${tr('לא נשמר', 'Not saved')}: ${s.saveError}`
              : s.savedAt
                ? tr(
                    `💾 נשמר מקומית ${fmtTime(s.savedAt)}`,
                    `💾 Saved locally ${fmtTime(s.savedAt)}`
                  )
                : tr('💾 נשמר אוטומטית במחשב', '💾 Saved automatically on this computer')}
          </span>
          <button
            className="btn btn-small offline-draft-proofread"
            data-offline-draft-proofread="true"
            disabled={running || !d.body.trim()}
            title={tr(
              'שולח ל-Gemini (בתשלום) רק את טקסט הטיוטה — בלי נמענים, בלי נושא ובלי מיילים',
              'Sends only the draft text to Gemini (paid) — no recipients, no subject, no mail'
            )}
            onClick={() => void s.proofread(d.id)}
          >
            {tr('✨ הגהה עם Gemini', '✨ Proofread with Gemini')}
          </button>
          <button
            className={classNames('btn btn-small offline-draft-delete', {
              armed: this.state.armedDelete,
            })}
            data-offline-draft-editor-delete="true"
            onClick={() => {
              if (!this.state.armedDelete) {
                this.setState({ armedDelete: true });
                return;
              }
              this.setState({ armedDelete: false });
              s.delete(d.id);
            }}
          >
            {this.state.armedDelete
              ? tr('לחץ שוב למחיקה', 'Click again to delete')
              : tr('🗑 מחק', '🗑 Delete')}
          </button>
          <button className="btn btn-small" onClick={() => s.closeDraft()}>
            {tr('סגור', 'Close')}
          </button>
          <span className="offline-draft-nosend">
            <button
              className="btn btn-small offline-draft-send"
              data-offline-draft-send="disabled"
              disabled
              aria-disabled="true"
              title={OFFLINE_DRAFTS_NO_SEND_NOTE}
            >
              ✉️ {tr('שליחה', 'Send')}
            </button>
            <span className="offline-draft-nosend-note" lang="he" dir="rtl">
              {OFFLINE_DRAFTS_NO_SEND_NOTE}
            </span>
          </span>
        </div>
        <div className="offline-draft-fields">
          <label>
            <span>{tr('אל', 'To')}</span>
            <input
              type="text"
              dir="auto"
              spellCheck={false}
              data-offline-draft-field="to"
              value={d.to}
              onChange={(e) => s.update(d.id, { to: e.target.value })}
            />
          </label>
          <label>
            <span>{tr('עותק', 'Cc')}</span>
            <input
              type="text"
              dir="auto"
              spellCheck={false}
              data-offline-draft-field="cc"
              value={d.cc}
              onChange={(e) => s.update(d.id, { cc: e.target.value })}
            />
          </label>
          <label>
            <span>{tr('נושא', 'Subject')}</span>
            <input
              type="text"
              dir="auto"
              spellCheck
              data-offline-draft-field="subject"
              value={d.subject}
              onChange={(e) => s.update(d.id, { subject: e.target.value })}
            />
          </label>
        </div>
        {this._renderProof(d)}
        <textarea
          className="offline-draft-body"
          data-offline-draft-field="body"
          dir="auto"
          spellCheck
          placeholder={tr(
            'כתוב כאן. כל פסקה מקבלת כיוון לפי השפה שלה (עברית מימין, English משמאל).',
            'Write here. Each paragraph gets its own direction (Hebrew right-to-left, English left-to-right).'
          )}
          value={d.body}
          readOnly={running}
          onChange={(e) => s.update(d.id, { body: e.target.value })}
        />
        <div className="offline-draft-footer">
          {tr(
            'בדיקת איות מקומית (עברית ואנגלית) — בלי אינטרנט. מילה עם קו אדום: קליק ימני להצעות.',
            'Local spell check (Hebrew and English) — no internet. Underlined word: right-click for suggestions.'
          )}
        </div>
      </div>
    );
  }
}
