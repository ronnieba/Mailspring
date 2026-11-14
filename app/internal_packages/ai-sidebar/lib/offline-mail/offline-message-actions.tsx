/**
 * Offline experiment (t227): Yahoo-style message actions, all LOCAL.
 * Delete / archive / spam / move only change where the app shows a message
 * (local virtual folders, always restorable); star and unread are local
 * flags; block hides a sender; "add to contacts" saves to the local address
 * book. Nothing is written to the mail copy, nothing goes to Yahoo.
 * Every action shows a toast with Undo.
 */
import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tr, offlineDir } from '../core/offline-i18n';
import { offlineMailStore, OfflineUndo } from './offline-mail-store';
import { offlineSearchStore } from './offline-search-store';
import { LocalPlace, LOCAL_PLACE_LABELS, localPlaceOf } from '../core/offline-local-overlay';
import { buildSandboxedHtmlDocument, ParsedOfflineMail } from '../core/offline-mail-mime';
import { loadOfflineMessage } from '../core/offline-mail-index';

type Listener = () => void;

type Toast = { id: number; text: string; undo: OfflineUndo | null };

class OfflineActionsUi {
  toast: Toast | null = null;
  picker: { ids: string[]; query: string } | null = null;
  blockedOpen = false;
  /** Tests: build the print page but do not open the print dialog. */
  printDryRun = false;
  lastPrint: { bytes: number; hasHeader: boolean } | null = null;
  /** Tests can replace the confirmation dialog. */
  confirm: (text: string) => boolean = (text) => window.confirm(text);
  private _seq = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _listeners = new Set<Listener>();

  listen(cb: Listener): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (e) {
        console.error('[Offline actions] listener failed', e);
      }
    }
  }

  showToast(text: string, undo: OfflineUndo | null) {
    this.toast = { id: ++this._seq, text, undo };
    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => {
      this.toast = null;
      this.emit();
    }, 9000);
    this.emit();
  }

  undoToast() {
    const t = this.toast;
    this.toast = null;
    this.emit();
    if (t && t.undo) {
      t.undo();
      refreshSearch();
      this.showToast(tr('בוטל', 'Undone'), null);
    }
  }

  closeToast() {
    this.toast = null;
    this.emit();
  }
}

export const offlineActionsUi = new OfflineActionsUi();

function refreshSearch() {
  if (offlineSearchStore.active) {
    offlineSearchStore.run();
  }
}

function count(n: number): string {
  return n === 1 ? tr('הודעה אחת', '1 message') : tr(`${n} הודעות`, `${n} messages`);
}

function done(text: string, undo: OfflineUndo | null) {
  refreshSearch();
  offlineActionsUi.showToast(text, undo);
}

/** Messages an action applies to (explicit ids, else the selection). */
function targets(ids?: string[]): string[] {
  return ids && ids.length ? ids : offlineMailStore.actionIds();
}

export function placeLabel(place: LocalPlace): string {
  const l = LOCAL_PLACE_LABELS[place];
  return tr(l[0], l[1]);
}

export function actMoveToPlace(place: LocalPlace, ids?: string[]) {
  const list = targets(ids);
  if (!list.length) {
    return;
  }
  const undo = offlineMailStore.moveToPlace(list, place);
  done(
    tr(
      `${count(list.length)} הועברו ל${placeLabel(place)}`,
      `${count(list.length)} moved to ${placeLabel(place)}`
    ),
    undo
  );
}

export const actDelete = (ids?: string[]) => actMoveToPlace('trash', ids);
export const actArchive = (ids?: string[]) => actMoveToPlace('archive', ids);
export const actSpam = (ids?: string[]) => actMoveToPlace('spam', ids);

export function actMoveToFolder(folder: string, ids?: string[]) {
  const list = targets(ids);
  if (!list.length) {
    return;
  }
  const undo = offlineMailStore.moveToFolder(list, folder);
  const name = offlineMailStore.folderLabel(folder);
  done(
    tr(`${count(list.length)} הועברו אל ${name}`, `${count(list.length)} moved to ${name}`),
    undo
  );
}

export function actRestore(ids?: string[]) {
  const list = targets(ids).filter((id) => offlineMailStore.isRelocated(id));
  if (!list.length) {
    return;
  }
  const undo = offlineMailStore.restore(list);
  done(
    tr(
      `${count(list.length)} שוחזרו לתיקייה המקורית`,
      `${count(list.length)} restored to the original folder`
    ),
    undo
  );
}

export function selectionStarred(ids?: string[]): boolean {
  const list = targets(ids);
  return list.length > 0 && list.every((id) => offlineMailStore.isStarred(id));
}

export function selectionUnread(ids?: string[]): boolean {
  const list = targets(ids);
  return list.length > 0 && list.every((id) => offlineMailStore.isUnread(id));
}

export function actToggleStar(ids?: string[]) {
  const list = targets(ids);
  if (!list.length) {
    return;
  }
  const on = !selectionStarred(list);
  const undo = offlineMailStore.setStarred(list, on);
  done(
    on
      ? tr(`${count(list.length)} סומנו בכוכב`, `${count(list.length)} starred`)
      : tr(`הכוכב הוסר מ${count(list.length)}`, `Star removed from ${count(list.length)}`),
    undo
  );
}

export function actSetUnread(unread: boolean, ids?: string[]) {
  const list = targets(ids);
  if (!list.length) {
    return;
  }
  const undo = offlineMailStore.setUnread(list, unread);
  done(
    unread
      ? tr(`${count(list.length)} סומנו כלא נקראו`, `${count(list.length)} marked unread`)
      : tr(`${count(list.length)} סומנו כנקראו`, `${count(list.length)} marked read`),
    undo
  );
}

export function actBlockSenders(ids?: string[]) {
  const senders = offlineMailStore
    .sendersOf(targets(ids))
    .filter((s) => !offlineMailStore.isBlocked(s.email));
  if (!senders.length) {
    return;
  }
  const undos = senders
    .map((s) => offlineMailStore.blockSender(s.email, s.name))
    .filter(Boolean) as OfflineUndo[];
  done(
    senders.length === 1
      ? tr(
          `השולח ${senders[0].email} נחסם (רק במחשב הזה)`,
          `Blocked ${senders[0].email} (on this computer only)`
        )
      : tr(
          `${senders.length} שולחים נחסמו (רק במחשב הזה)`,
          `${senders.length} senders blocked (on this computer only)`
        ),
    () => undos.forEach((u) => u())
  );
}

export function actUnblock(email: string) {
  offlineMailStore.unblockSender(email);
  done(tr(`החסימה של ${email} בוטלה`, `Unblocked ${email}`), () =>
    offlineMailStore.blockSender(email)
  );
}

export function actAddContacts(ids?: string[]) {
  const senders = offlineMailStore.sendersOf(targets(ids));
  const added = senders.filter((s) => offlineMailStore.addContact(s.email, s.name));
  if (!senders.length) {
    return;
  }
  if (!added.length) {
    offlineActionsUi.showToast(
      tr('כבר באנשי הקשר המקומיים', 'Already in the local contacts'),
      null
    );
    return;
  }
  done(
    added.length === 1
      ? tr(
          `${added[0].email} נוסף לאנשי הקשר המקומיים`,
          `${added[0].email} added to the local contacts`
        )
      : tr(
          `${added.length} נוספו לאנשי הקשר המקומיים`,
          `${added.length} added to the local contacts`
        ),
    () => added.forEach((s) => offlineMailStore.removeContact(s.email))
  );
}

export function openMovePicker(ids?: string[]) {
  const list = targets(ids);
  if (!list.length) {
    return;
  }
  offlineActionsUi.picker = { ids: list, query: '' };
  offlineActionsUi.emit();
}

export function openBlockedList() {
  offlineActionsUi.blockedOpen = true;
  offlineActionsUi.emit();
}

export function actResetLocalChanges(): number {
  const c = offlineMailStore.localChangeCounts();
  if (!c.total) {
    offlineActionsUi.showToast(tr('אין שינויים מקומיים', 'No local changes'), null);
    return 0;
  }
  const ok = offlineActionsUi.confirm(
    tr(
      `לאפס את כל השינויים המקומיים?\n\n` +
        `כוכבים: ${c.starred} · לא נקראו: ${c.unread} · הועברו: ${c.moved}\n` +
        `אשפה: ${c.trash} · ארכיון: ${c.archive} · ספאם: ${c.spam}\n` +
        `שולחים חסומים: ${c.blocked} · אנשי קשר שנשמרו: ${c.contacts}\n\n` +
        `כל ההודעות יחזרו לתיקיות המקוריות. עותק הדואר עצמו לא השתנה אף פעם.`,
      `Reset all local changes?\n\n` +
        `Starred: ${c.starred} · Unread: ${c.unread} · Moved: ${c.moved}\n` +
        `Trash: ${c.trash} · Archive: ${c.archive} · Spam: ${c.spam}\n` +
        `Blocked senders: ${c.blocked} · Saved contacts: ${c.contacts}\n\n` +
        `All messages go back to their original folders. The mail copy itself was never changed.`
    )
  );
  if (!ok) {
    return 0;
  }
  const n = offlineMailStore.resetLocalChanges();
  refreshSearch();
  offlineActionsUi.showToast(
    tr('כל השינויים המקומיים אופסו', 'All local changes were reset'),
    null
  );
  return n;
}

// ---- Print -------------------------------------------------------------

function esc(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page that is printed: headers + body (same sanitizing as the reader). */
export function buildPrintDocument(m: ParsedOfflineMail): string {
  const row = (k: string, v: string) =>
    v ? `<tr><th>${esc(k)}</th><td dir="auto">${esc(v)}</td></tr>` : '';
  const header =
    `<div class="ofl-print-head"><h1 dir="auto">${esc(m.subject || '')}</h1><table>` +
    row(tr('מאת', 'From'), m.from || '') +
    row(tr('אל', 'To'), m.to || '') +
    row(tr('עותק', 'Cc'), m.cc || '') +
    row(tr('תאריך', 'Date'), m.date || '') +
    `</table></div><hr>`;
  const body = m.html
    ? m.html
    : `<pre dir="auto" style="white-space:pre-wrap;font-family:inherit">${esc(m.text || '')}</pre>`;
  const style =
    `<style>.ofl-print-head h1{font-size:18px;margin:0 0 8px}.ofl-print-head table{border-collapse:collapse;font-size:13px}` +
    `.ofl-print-head th{text-align:start;padding:1px 10px 1px 0;color:#555;font-weight:600;white-space:nowrap}` +
    `@media print{body{padding:0}}</style>`;
  return buildSandboxedHtmlDocument(`${style}<div dir="${offlineDir()}">${header}</div>${body}`);
}

/**
 * Native print dialog for one message. The page is a temporary file in the
 * offline profile, shown in a hidden window without scripts or network, and
 * removed after printing. Nothing is saved anywhere else.
 */
export async function actPrint(id?: string) {
  const msgId = id || offlineMailStore.openMessage?.id || offlineMailStore.actionIds()[0];
  const entry = msgId ? offlineMailStore.getEntry(msgId) : null;
  if (!msgId || !entry || !offlineMailStore.root) {
    return;
  }
  const parsed =
    (offlineMailStore.openMessage?.id === msgId && offlineMailStore.openMessage.parsed) ||
    (await loadOfflineMessage(offlineMailStore.root, entry.rel));
  const html = buildPrintDocument(parsed);
  offlineActionsUi.lastPrint = { bytes: html.length, hasHeader: html.includes('ofl-print-head') };
  if (offlineActionsUi.printDryRun) {
    offlineActionsUi.emit();
    return;
  }
  const dir = path.join(offlineMailStore.configDir || os.tmpdir(), 'offline-print');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `print-${Date.now()}.html`);
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
  const cleanup = () => {
    try {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    } catch (e) {
      // already gone
    }
    try {
      fs.unlinkSync(file);
    } catch (e) {
      // already removed
    }
  };
  // No network for the printed page (only the local file).
  win.webContents.session.webRequest.onBeforeRequest((details: any, cb: any) =>
    cb({ cancel: !String(details.url).startsWith('file:') })
  );
  win.webContents.once('did-finish-load', () => {
    win.webContents.print({ silent: false, printBackground: true }, () => cleanup());
  });
  win.loadFile(file).catch(() => cleanup());
}

// ---- Native "⋯" menu (reader header) -----------------------------------

export function showMessageMoreMenu(anchor: HTMLElement, ids: string[]) {
  const { Menu, MenuItem } = require('@electron/remote');
  const s = offlineMailStore;
  const menu = new Menu();
  const item = (label: string, click: () => void, enabled = true) =>
    menu.append(new MenuItem({ label, click, enabled }));
  const here = s.currentFolder;
  const place = localPlaceOf(here);
  if (ids.some((id) => s.isRelocated(id))) {
    item(tr('♻️ שחזר לתיקייה המקורית', '♻️ Restore to the original folder'), () => actRestore(ids));
  }
  if (place !== 'trash')
    item(tr('🗑️ מחק (לאשפה המקומית)', '🗑️ Delete (to local Trash)'), () => actDelete(ids));
  if (place !== 'archive') item(tr('🗄️ העבר לארכיון', '🗄️ Archive'), () => actArchive(ids));
  item(tr('📁 העבר לתיקייה…', '📁 Move to folder…'), () => openMovePicker(ids));
  if (place !== 'spam') item(tr('🚫 סמן כספאם', '🚫 Mark as spam'), () => actSpam(ids));
  menu.append(new MenuItem({ type: 'separator' }));
  item(
    selectionStarred(ids) ? tr('☆ הסר כוכב', '☆ Remove star') : tr('⭐ סמן בכוכב', '⭐ Star'),
    () => actToggleStar(ids)
  );
  item(
    selectionUnread(ids)
      ? tr('📭 סמן כנקרא', '📭 Mark as read')
      : tr('✉️ סמן כלא נקרא', '✉️ Mark as unread'),
    () => actSetUnread(!selectionUnread(ids), ids)
  );
  menu.append(new MenuItem({ type: 'separator' }));
  item(tr('👤 הוסף שולח לאנשי הקשר', '👤 Add sender to contacts'), () => actAddContacts(ids));
  item(tr('⛔ חסום שולח', '⛔ Block sender'), () => actBlockSenders(ids));
  menu.append(new MenuItem({ type: 'separator' }));
  item(tr('🖨️ הדפס', '🖨️ Print'), () => void actPrint(ids[0]), ids.length === 1);
  const r = anchor.getBoundingClientRect();
  menu.popup({ x: Math.round(r.left), y: Math.round(r.bottom) });
}

// ---- Host: toast, folder picker, blocked senders ------------------------

type HostState = { tick: number };

export class OfflineActionsHost extends React.Component<Record<string, never>, HostState> {
  static displayName = 'OfflineActionsHost';
  state: HostState = { tick: 0 };
  private _unsubs: (() => void)[] = [];
  private _input: HTMLInputElement | null = null;

  componentDidMount() {
    const update = () => this.setState({ tick: this.state.tick + 1 });
    this._unsubs.push(offlineActionsUi.listen(update));
    this._unsubs.push(offlineMailStore.listen(update));
  }

  componentWillUnmount() {
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
  }

  componentDidUpdate() {
    if (offlineActionsUi.picker && this._input && document.activeElement !== this._input) {
      this._input.focus();
    }
  }

  _pickerFolders() {
    const p = offlineActionsUi.picker;
    const q = (p?.query || '').trim().toLowerCase();
    const s = offlineMailStore;
    return s
      .allFolderNodes()
      .filter((n) => n.path !== s.currentFolder)
      .filter(
        (n) => !q || n.displayPath.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
      )
      .slice(0, 300);
  }

  _closePicker = () => {
    offlineActionsUi.picker = null;
    offlineActionsUi.emit();
  };

  _pick(folder: string) {
    const p = offlineActionsUi.picker;
    this._closePicker();
    if (p) {
      actMoveToFolder(folder, p.ids);
    }
  }

  _renderPicker() {
    const p = offlineActionsUi.picker;
    if (!p) {
      return null;
    }
    const folders = this._pickerFolders();
    return (
      <div className="offline-modal-backdrop" onMouseDown={this._closePicker}>
        <div
          className="offline-modal offline-move-picker"
          dir={offlineDir()}
          role="dialog"
          aria-label={tr('העבר לתיקייה', 'Move to folder')}
          data-offline-move-picker="true"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="offline-modal-title">
            {tr(`העבר ${count(p.ids.length)} לתיקייה`, `Move ${count(p.ids.length)} to a folder`)}
          </div>
          <input
            ref={(el) => (this._input = el)}
            type="search"
            dir="auto"
            className="offline-move-search"
            data-offline-move-search="true"
            placeholder={tr('חפש תיקייה…', 'Search folders…')}
            value={p.query}
            onChange={(e) => {
              offlineActionsUi.picker = { ...p, query: e.target.value };
              offlineActionsUi.emit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                this._closePicker();
              } else if (e.key === 'Enter' && folders.length) {
                this._pick(folders[0].path);
              }
            }}
          />
          <div className="offline-move-list" role="listbox">
            {folders.length ? (
              folders.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  className="offline-move-item"
                  data-offline-move-folder={n.path}
                  style={{ paddingInlineStart: 10 + n.depth * 14 }}
                  onClick={() => this._pick(n.path)}
                >
                  <bdi>{n.name}</bdi>
                  {n.depth > 0 ? <span className="offline-move-path">{n.displayPath}</span> : null}
                </button>
              ))
            ) : (
              <div className="offline-move-empty">{tr('אין תיקייה כזו', 'No such folder')}</div>
            )}
          </div>
          <div className="offline-modal-note">
            {tr(
              'ההעברה נשמרת רק במחשב הזה (העותק המקומי ו-Yahoo לא משתנים). אפשר תמיד לשחזר.',
              'The move is kept on this computer only (the mail copy and Yahoo do not change). You can always restore.'
            )}
          </div>
          <div className="offline-modal-actions">
            <button type="button" className="btn" onClick={this._closePicker}>
              {tr('ביטול', 'Cancel')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  _renderBlocked() {
    if (!offlineActionsUi.blockedOpen) {
      return null;
    }
    const close = () => {
      offlineActionsUi.blockedOpen = false;
      offlineActionsUi.emit();
    };
    const list = offlineMailStore.overlay.blocked;
    return (
      <div className="offline-modal-backdrop" onMouseDown={close}>
        <div
          className="offline-modal offline-blocked-list"
          dir={offlineDir()}
          role="dialog"
          aria-label={tr('שולחים חסומים', 'Blocked senders')}
          data-offline-blocked-list={list.length}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.key === 'Escape' && close()}
        >
          <div className="offline-modal-title">{tr('⛔ שולחים חסומים', '⛔ Blocked senders')}</div>
          <div className="offline-modal-note">
            {tr(
              'ההודעות שלהם מוסתרות רק במחשב הזה. ביטול חסימה מחזיר אותן.',
              'Their messages are hidden on this computer only. Unblocking brings them back.'
            )}
          </div>
          {list.length ? (
            <div className="offline-blocked-rows">
              {list.map((b) => (
                <div
                  key={b.email}
                  className="offline-blocked-row"
                  data-offline-blocked-email={b.email}
                >
                  <bdi className="offline-blocked-email">
                    {b.name ? `${b.name} <${b.email}>` : b.email}
                  </bdi>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => actUnblock(b.email)}
                  >
                    {tr('בטל חסימה', 'Unblock')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="offline-move-empty">
              {tr('אין שולחים חסומים', 'No blocked senders')}
            </div>
          )}
          <div className="offline-modal-actions">
            <button type="button" className="btn" autoFocus onClick={close}>
              {tr('סגור', 'Close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const t = offlineActionsUi.toast;
    return (
      <>
        {this._renderPicker()}
        {this._renderBlocked()}
        {t ? (
          <div className="offline-toast" dir={offlineDir()} role="status" data-offline-toast={t.id}>
            <span className="offline-toast-text" dir="auto">
              {t.text}
            </span>
            {t.undo ? (
              <button
                type="button"
                className="offline-toast-undo"
                data-offline-toast-undo="true"
                onClick={() => offlineActionsUi.undoToast()}
              >
                {tr('בטל', 'Undo')}
              </button>
            ) : null}
            <button
              type="button"
              className="offline-toast-close"
              aria-label={tr('סגור', 'Close')}
              onClick={() => offlineActionsUi.closeToast()}
            >
              ✕
            </button>
          </div>
        ) : null}
      </>
    );
  }
}
