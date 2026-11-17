/**
 * Offline experiment: recipient fields with chips and autocomplete from the
 * local address book, plus a searchable address book picker. Local only.
 */
import React from 'react';
import classNames from 'classnames';
import { offlineAddressBook } from './offline-address-book-store';
import {
  OfflineAddress,
  OfflineContact,
  RecipientChip,
  isLikelyEmail,
  joinRecipients,
  parseAddressList,
  splitRecipients,
} from '../core/offline-address-book';
import { tr } from '../core/offline-i18n';
import { OfflineMic } from './offline-voice';

export type RecipientField = 'to' | 'cc' | 'bcc';

export function recipientFieldLabel(f: RecipientField): string {
  return f === 'to' ? tr('אל', 'To') : f === 'cc' ? tr('עותק', 'Cc') : tr('עותק מוסתר', 'Bcc');
}

export function addRecipient(value: string, a: OfflineAddress): string {
  const chips = splitRecipients(value);
  if (chips.some((c) => c.addr && c.addr.email.toLowerCase() === a.email.toLowerCase())) {
    return joinRecipients(chips);
  }
  return joinRecipients([...chips, { raw: a.email, addr: a }]);
}

type FieldProps = {
  field: RecipientField;
  value: string;
  onChange: (value: string) => void;
  onOpenPicker: (field: RecipientField) => void;
};
type FieldState = { text: string; active: number; focused: boolean };

export class OfflineRecipientsField extends React.Component<FieldProps, FieldState> {
  static displayName = 'OfflineRecipientsField';
  state: FieldState = { text: '', active: 0, focused: false };
  private _input = React.createRef<HTMLInputElement>();
  private _unlisten: (() => void) | null = null;

  componentDidMount() {
    this._unlisten = offlineAddressBook.listen(() => this.forceUpdate());
  }
  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
  }

  _chips(): RecipientChip[] {
    return splitRecipients(this.props.value);
  }

  _suggestions(): OfflineContact[] {
    const q = this.state.text.trim();
    if (!q || !this.state.focused) {
      return [];
    }
    const exclude = this._chips()
      .filter((c) => c.addr)
      .map((c) => (c.addr as OfflineAddress).email);
    return offlineAddressBook.search(q, 8, exclude);
  }

  _add(addrs: OfflineAddress[]) {
    let v = this.props.value;
    for (const a of addrs) {
      v = addRecipient(v, a);
    }
    this.props.onChange(v);
    this.setState({ text: '', active: 0 });
  }

  /** Turn the typed text into chips. Returns false when nothing valid was typed. */
  _commitText(pick: OfflineContact | null): boolean {
    if (pick) {
      this._add([{ name: pick.name, email: pick.email }]);
      return true;
    }
    const parsed = parseAddressList(this.state.text);
    if (parsed.length) {
      this._add(parsed);
      return true;
    }
    return false;
  }

  _removeAt(i: number) {
    const chips = this._chips();
    chips.splice(i, 1);
    this.props.onChange(joinRecipients(chips));
  }

  _onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const sugg = this._suggestions();
    const active = Math.min(this.state.active, Math.max(0, sugg.length - 1));
    if (e.key === 'ArrowDown' && sugg.length) {
      e.preventDefault();
      this.setState({ active: (active + 1) % sugg.length });
    } else if (e.key === 'ArrowUp' && sugg.length) {
      e.preventDefault();
      this.setState({ active: (active - 1 + sugg.length) % sugg.length });
    } else if (e.key === 'Enter' || (e.key === 'Tab' && this.state.text.trim())) {
      const typed = this.state.text.trim();
      const pick = isLikelyEmail(typed) && !sugg.length ? null : sugg[active] || null;
      if (this._commitText(pick)) {
        e.preventDefault();
      }
    } else if (e.key === ',' || e.key === ';') {
      e.preventDefault();
      this._commitText(
        isLikelyEmail(this.state.text.trim()) ? null : this._suggestions()[active] || null
      );
    } else if (e.key === 'Backspace' && !this.state.text) {
      const chips = this._chips();
      if (chips.length) {
        e.preventDefault();
        this._removeAt(chips.length - 1);
      }
    } else if (e.key === 'Escape' && this.state.text) {
      e.preventDefault();
      this.setState({ text: '' });
    }
  };

  _onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain') || '';
    const parsed = parseAddressList(text);
    if (parsed.length > 1 || (parsed.length === 1 && /[,;<]/.test(text))) {
      e.preventDefault();
      this._add(parsed);
    }
  };

  render() {
    const { field } = this.props;
    const chips = this._chips();
    const sugg = this._suggestions();
    const active = Math.min(this.state.active, Math.max(0, sugg.length - 1));
    const label = recipientFieldLabel(field);
    return (
      <div className="offline-recipients" data-offline-recipients={field}>
        <span className="offline-recipients-label">{label}</span>
        <div
          className={classNames('offline-recipients-box', { focused: this.state.focused })}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              if (this._input.current) {
                this._input.current.focus();
              }
            }
          }}
        >
          {chips.map((c, i) => (
            <span
              key={`${i}-${c.raw}`}
              className={classNames('offline-chip', { invalid: !c.addr })}
              data-offline-chip={field}
              title={c.addr ? c.addr.email : tr('כתובת לא תקינה', 'Not a valid address')}
              dir="auto"
            >
              <span className="offline-chip-text">
                {c.addr ? c.addr.name || c.addr.email : c.raw}
              </span>
              <button
                type="button"
                className="offline-chip-remove"
                aria-label={tr('הסר נמען', 'Remove recipient')}
                title={tr('הסר', 'Remove')}
                onClick={() => this._removeAt(i)}
              >
                ×
              </button>
            </span>
          ))}
          <input
            ref={this._input}
            type="text"
            dir="auto"
            spellCheck={false}
            data-offline-draft-field={field}
            value={this.state.text}
            placeholder={chips.length ? '' : tr('שם או כתובת…', 'Name or address…')}
            aria-label={label}
            onChange={(e) => this.setState({ text: e.target.value, active: 0 })}
            onKeyDown={this._onKeyDown}
            onPaste={this._onPaste}
            onFocus={() => this.setState({ focused: true })}
            onBlur={() => {
              if (isLikelyEmail(this.state.text.trim())) {
                this._commitText(null);
              }
              this.setState({ focused: false });
            }}
          />
          <OfflineMic target={`input[data-offline-draft-field="${field}"]`} size="small" />
          {sugg.length ? (
            <div className="offline-suggest" role="listbox" data-offline-suggest={field}>
              {sugg.map((c, i) => (
                <div
                  key={c.email}
                  role="option"
                  aria-selected={i === active}
                  className={classNames('offline-suggest-row', { active: i === active })}
                  data-offline-suggest-row={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    this._commitText(c);
                  }}
                  onMouseEnter={() => this.setState({ active: i })}
                >
                  <span className="offline-suggest-name" dir="auto">
                    {c.name || c.email}
                  </span>
                  {c.name ? (
                    <span className="offline-suggest-email" dir="ltr">
                      {c.email}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn-small offline-addressbook-btn"
          data-offline-addressbook-open={field}
          title={tr('פנקס כתובות', 'Address book')}
          aria-label={tr('פנקס כתובות', 'Address book')}
          onClick={() => this.props.onOpenPicker(field)}
        >
          📒
        </button>
      </div>
    );
  }
}

type PickerProps = {
  field: RecipientField;
  onAdd: (field: RecipientField, a: OfflineAddress) => void;
  onClose: () => void;
  chosen: (field: RecipientField) => string[];
};
type PickerState = { q: string };

export class OfflineAddressPicker extends React.Component<PickerProps, PickerState> {
  static displayName = 'OfflineAddressPicker';
  state: PickerState = { q: '' };
  private _unlisten: (() => void) | null = null;

  componentDidMount() {
    this._unlisten = offlineAddressBook.listen(() => this.forceUpdate());
  }
  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
  }

  render() {
    const total = offlineAddressBook.contacts.length;
    const results = offlineAddressBook.search(this.state.q, 200);
    const fields: RecipientField[] = ['to', 'cc', 'bcc'];
    const chosen: { [f: string]: Set<string> } = {};
    for (const f of fields) {
      chosen[f] = new Set(this.props.chosen(f).map((e) => e.toLowerCase()));
    }
    return (
      <div
        className="offline-picker-overlay"
        data-offline-addressbook="open"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            this.props.onClose();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            this.props.onClose();
          }
        }}
      >
        <div
          className="offline-picker"
          role="dialog"
          aria-label={tr('פנקס כתובות', 'Address book')}
        >
          <div className="offline-picker-head">
            <span className="offline-picker-title">
              📒 {tr('פנקס כתובות מקומי', 'Local address book')}
              <span className="offline-list-count">{total.toLocaleString()}</span>
            </span>
            <button className="btn btn-small" onClick={() => this.props.onClose()}>
              {tr('סגור', 'Close')}
            </button>
          </div>
          <input
            type="search"
            dir="auto"
            autoFocus
            spellCheck={false}
            className="offline-picker-search"
            data-offline-addressbook-search="true"
            placeholder={tr('חיפוש לפי שם או כתובת…', 'Search by name or address…')}
            value={this.state.q}
            onChange={(e) => this.setState({ q: e.target.value })}
          />
          <div className="offline-picker-note">
            {tr(
              'נבנה מכותרות המיילים בארכיון שבמחשב הזה. לא נשלח לשום מקום.',
              'Built from the headers of the mail archive on this computer. Never sent anywhere.'
            )}
          </div>
          <div className="offline-picker-list" data-offline-addressbook-list="true">
            {total === 0 ? (
              <div className="offline-picker-empty">
                {tr('הפנקס עדיין נבנה מהארכיון…', 'The address book is still being built…')}
              </div>
            ) : results.length === 0 ? (
              <div className="offline-picker-empty">{tr('לא נמצא.', 'No matches.')}</div>
            ) : (
              results.map((c) => (
                <div
                  key={c.email}
                  className="offline-picker-row"
                  data-offline-addressbook-row="true"
                >
                  <div className="offline-picker-who">
                    <span className="offline-suggest-name" dir="auto">
                      {c.name || c.email}
                    </span>
                    {c.name ? (
                      <span className="offline-suggest-email" dir="ltr">
                        {c.email}
                      </span>
                    ) : null}
                  </div>
                  <span className="offline-picker-count" title={tr('מספר הודעות', 'Messages')}>
                    {c.count.toLocaleString()}
                  </span>
                  {fields.map((f) => {
                    const on = chosen[f].has(c.email.toLowerCase());
                    return (
                      <button
                        key={f}
                        className={classNames('btn btn-small offline-picker-add', { on })}
                        data-offline-addressbook-add={f}
                        disabled={on}
                        onClick={() => this.props.onAdd(f, { name: c.name, email: c.email })}
                      >
                        {on ? '✓ ' : '+ '}
                        {recipientFieldLabel(f)}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }
}
