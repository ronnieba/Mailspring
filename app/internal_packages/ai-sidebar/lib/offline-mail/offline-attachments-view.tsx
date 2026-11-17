/**
 * Offline experiment: attachment list for the reader and for local drafts.
 * View = built-in viewer (reader). Open in app = copy into a temp folder
 * inside the offline profile, then open with the default app. Save as = a place the user picks (never the archive copy).
 * Files that can run programs need a second, explicit click.
 */
import React from 'react';
import classNames from 'classnames';
import {
  ATTACHMENT_ICONS,
  attachmentKind,
  formatBytes,
  imageMimeFor,
  isDangerousAttachment,
  isPreviewableImage,
} from '../core/offline-attachments';
import { tr } from '../core/offline-i18n';
import { canViewInApp } from '../core/offline-viewer';
import { OfflineAttachmentViewer } from './offline-attachment-viewer';

export type AttachmentItem = { key: string; filename: string; contentType: string; size: number };

type Props = {
  items: AttachmentItem[];
  /** Open the item (already confirmed if dangerous). Resolves to '' or an error message. */
  onOpen: (index: number) => Promise<string>;
  /** Save a copy elsewhere; resolves to the saved path, or null if cancelled. */
  onSave?: (index: number) => Promise<string | null>;
  onRemove?: (index: number) => void;
  /** Bytes for inline image previews (reader only). */
  loadImage?: (index: number) => Buffer | null;
  /** Bytes for the built-in viewer (from the profile temp copy); enables "View". */
  loadForView?: (index: number) => Promise<Buffer>;
  context: 'reader' | 'draft';
};

type State = {
  confirm: number | null;
  status: { kind: 'ok' | 'error'; text: string } | null;
  previews: { [index: number]: string };
  enlarged: number | null;
  viewing: number | null;
};

export class OfflineAttachmentList extends React.Component<Props, State> {
  static displayName = 'OfflineAttachmentList';
  state: State = { confirm: null, status: null, previews: {}, enlarged: null, viewing: null };
  private _previewKey = '';
  private _timer: ReturnType<typeof setTimeout> | null = null;

  componentDidMount() {
    this._schedulePreviews();
  }
  componentDidUpdate() {
    this._schedulePreviews();
  }
  componentWillUnmount() {
    if (this._timer) {
      clearTimeout(this._timer);
    }
  }

  _schedulePreviews() {
    const key = this.props.items.map((i) => i.key).join('|');
    if (key === this._previewKey || !this.props.loadImage) {
      return;
    }
    this._previewKey = key;
    if (
      this.state.confirm !== null ||
      this.state.status ||
      Object.keys(this.state.previews).length
    ) {
      this.setState({ confirm: null, status: null, previews: {}, enlarged: null, viewing: null });
    }
    const wanted = this.props.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => isPreviewableImage(it.filename, it.contentType, it.size));
    if (!wanted.length) {
      return;
    }
    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => {
      const previews: { [index: number]: string } = {};
      for (const { it, i } of wanted) {
        try {
          const data = this.props.loadImage ? this.props.loadImage(i) : null;
          if (data) {
            previews[i] = `data:${imageMimeFor(it.filename, it.contentType)};base64,${data.toString(
              'base64'
            )}`;
          }
        } catch (e) {
          // no preview for this one
        }
      }
      if (key === this._previewKey) {
        this.setState({ previews });
      }
    }, 30);
  }

  async _open(i: number, confirmed = false) {
    const it = this.props.items[i];
    if (!confirmed && isDangerousAttachment(it.filename, it.contentType)) {
      this.setState({ confirm: i, status: null });
      return;
    }
    this.setState({ confirm: null, status: null });
    const err = await this.props.onOpen(i);
    this.setState({
      status: err
        ? { kind: 'error', text: tr(`לא ניתן לפתוח: ${err}`, `Could not open: ${err}`) }
        : null,
    });
  }

  async _save(i: number) {
    if (!this.props.onSave) {
      return;
    }
    try {
      const saved = await this.props.onSave(i);
      if (saved) {
        this.setState({ status: { kind: 'ok', text: tr(`נשמר: ${saved}`, `Saved: ${saved}`) } });
      }
    } catch (err) {
      const msg = String((err as Error).message || err);
      this.setState({
        status: {
          kind: 'error',
          text:
            msg === 'protected-archive'
              ? tr(
                  'אי אפשר לשמור בתוך עותק הארכיון. בחר תיקייה אחרת.',
                  'You cannot save inside the archive copy. Pick another folder.'
                )
              : tr(`השמירה נכשלה: ${msg}`, `Saving failed: ${msg}`),
        },
      });
    }
  }

  render() {
    const { items, context } = this.props;
    if (!items.length) {
      return null;
    }
    const { confirm, status, previews, enlarged, viewing } = this.state;
    const canView = !!this.props.loadForView;
    const total = items.reduce((n, it) => n + (it.size || 0), 0);
    return (
      <div
        className={classNames('offline-attachments', `offline-attachments-${context}`)}
        data-offline-attachments={context}
        data-attachment-count={items.length}
      >
        <div className="offline-attachments-title">
          📎 {tr(`${items.length} קבצים מצורפים`, `${items.length} attachments`)}
          <span className="offline-attachments-total" dir="ltr">
            {formatBytes(total)}
          </span>
        </div>
        <div className="offline-attachments-items">
          {items.map((it, i) => {
            const kind = attachmentKind(it.filename, it.contentType);
            const danger = kind === 'danger';
            return (
              <div
                key={it.key}
                className={classNames('offline-attachment-card', { danger })}
                data-offline-attachment={i}
                data-attachment-kind={kind}
              >
                {previews[i] ? (
                  <button
                    type="button"
                    className="offline-attachment-preview"
                    title={canView ? tr('צפה', 'View') : tr('הגדל', 'Enlarge')}
                    onClick={() =>
                      canView
                        ? this.setState({ viewing: i })
                        : this.setState({ enlarged: enlarged === i ? null : i })
                    }
                  >
                    <img src={previews[i]} alt={it.filename} data-offline-attachment-preview={i} />
                  </button>
                ) : null}
                <div className="offline-attachment-row">
                  <span className="offline-attachment-icon" aria-hidden="true">
                    {ATTACHMENT_ICONS[kind]}
                  </span>
                  <span className="offline-attachment-name" dir="auto" title={it.filename}>
                    {it.filename}
                  </span>
                  <span className="offline-attachment-size" dir="ltr">
                    {formatBytes(it.size)}
                  </span>
                </div>
                <div className="offline-attachment-actions">
                  {canView && !danger ? (
                    <button
                      type="button"
                      className="btn btn-small btn-emphasis offline-attachment-view"
                      data-offline-attachment-view={i}
                      title={
                        canViewInApp(it.filename, it.contentType)
                          ? tr('הצג את הקובץ בתוך התוכנה', 'Show the file inside the app')
                          : tr(
                              'אין תצוגה מקדימה לסוג הזה; ייפתח חלון עם אפשרויות',
                              'No preview for this type; shows the options'
                            )
                      }
                      onClick={() => this.setState({ viewing: i, confirm: null, status: null })}
                    >
                      {tr('צפה', 'View')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-small"
                    data-offline-attachment-open={i}
                    title={tr('פתח בתוכנה המתאימה במחשב', 'Open with the default app')}
                    onClick={() => void this._open(i)}
                  >
                    {canView ? tr('פתח בתוכנה', 'Open in app') : tr('פתח', 'Open')}
                  </button>
                  {this.props.onSave ? (
                    <button
                      type="button"
                      className="btn btn-small"
                      data-offline-attachment-save={i}
                      onClick={() => void this._save(i)}
                    >
                      {tr('שמור בשם…', 'Save as…')}
                    </button>
                  ) : null}
                  {this.props.onRemove ? (
                    <button
                      type="button"
                      className="btn btn-small offline-attachment-remove"
                      data-offline-attachment-remove={i}
                      title={tr('הסר מהטיוטה', 'Remove from the draft')}
                      onClick={() => this.props.onRemove && this.props.onRemove(i)}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {confirm !== null && items[confirm] ? (
          <div
            className="offline-attachment-warning"
            role="alert"
            data-offline-attachment-warning="true"
          >
            <div>
              ⚠️{' '}
              {tr(
                'סוג הקובץ הזה יכול להריץ תוכנה במחשב. פתח אותו רק אם אתה סומך על השולח וציפית לקובץ.',
                'This kind of file can run a program on your computer. Open it only if you trust the sender and expected this file.'
              )}
            </div>
            <div className="offline-attachment-warning-name" dir="auto">
              {items[confirm].filename}
            </div>
            <div className="offline-attachment-warning-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => this.setState({ confirm: null })}
              >
                {tr('ביטול', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn btn-small offline-attachment-danger-open"
                data-offline-attachment-confirm="true"
                onClick={() => void this._open(confirm, true)}
              >
                {tr('פתח בכל זאת', 'Open anyway')}
              </button>
            </div>
          </div>
        ) : null}
        {status ? (
          <div
            className={classNames('offline-attachment-status', status.kind)}
            data-offline-attachment-status={status.kind}
            dir="auto"
          >
            {status.text}
          </div>
        ) : null}
        {viewing !== null && this.props.loadForView && items[viewing] ? (
          <OfflineAttachmentViewer
            items={items}
            index={viewing}
            load={this.props.loadForView}
            onIndex={(i) => this.setState({ viewing: i })}
            onClose={() => this.setState({ viewing: null })}
            onOpenInApp={(i) => {
              this.setState({ viewing: null });
              void this._open(i);
            }}
            onSave={this.props.onSave ? (i) => void this._save(i) : undefined}
          />
        ) : null}
        {enlarged !== null && previews[enlarged] ? (
          <div
            className="offline-attachment-lightbox"
            data-offline-attachment-lightbox="true"
            onClick={() => this.setState({ enlarged: null })}
          >
            <img src={previews[enlarged]} alt={items[enlarged].filename} />
          </div>
        ) : null}
      </div>
    );
  }
}
