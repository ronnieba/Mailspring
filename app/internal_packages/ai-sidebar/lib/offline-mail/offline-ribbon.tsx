/**
 * Offline experiment: Outlook-style top bar above all columns. Tabs reveal a
 * ribbon of buttons (icon + label). It replaces the column toolbar buttons and
 * the hamburger menu (edit, view, window, settings, theme, language, version,
 * exit). Labels collapse to icons when the window is narrow; the ribbon wraps
 * rather than being cut off. The last tab is remembered in the offline profile.
 * Nothing here sends mail or touches the network.
 */
import React from 'react';
import classNames from 'classnames';
import { Actions, FocusedPerspectiveStore, WorkspaceStore } from 'mailspring-exports';
import { offlineDir, offlineLang, tr } from '../core/offline-i18n';
import {
  nextRibbonCompact,
  OfflineRibbonTab,
  OFFLINE_RIBBON_TABS,
  readRibbonPrefs,
  writeRibbonPrefs,
} from '../core/offline-ribbon';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { forwardFiles } from './offline-message-reader';
import { chooseFilesToAttach } from './offline-file-actions';
import { showLanguageMenu, showThemeMenu, offlineThemeChoices } from './offline-pane-toggles';
import { OfflineDraftSource } from '../core/offline-drafts';
import { ParsedOfflineMail } from '../core/offline-mail-mime';
import AISidebarStore from '../ai-sidebar-store';
import { startWriteWithAi } from './write-with-ai';
import { ScopeMode } from '../core/types';
import { offlineVersionLabel } from '../../../../src/offline-menu';
import { OfflineSortKey, SORT_LABELS } from '../core/offline-list-view';
import { OfflineBrand } from './offline-brand';
import { OfflineVoiceHud, offlineVoice } from './offline-voice';
import {
  installEditTargetTracker,
  editTarget,
  focusEditTarget,
  selectAllInField,
  draftSelectTarget,
} from './offline-edit-target';
import {
  OfflineActionsHost,
  actArchive,
  actAddContacts,
  actBlockSenders,
  actDelete,
  actPrint,
  actResetLocalChanges,
  actRestore,
  actSetUnread,
  actSpam,
  actToggleStar,
  openBlockedList,
  openMovePicker,
  selectionStarred,
  selectionUnread,
} from './offline-message-actions';
import { localPlaceOf } from '../core/offline-local-overlay';
import { attachReplyOriginals, replyOriginalsInfo } from './offline-reply-originals';
import { OfflineRulesDialog, newRuleFromMessage, openRules } from './offline-rules-view';
import { OfflineExportDialog, openExport } from './offline-export';
import {
  OFFLINE_RIBBON_TAB_EVENT,
  OfflineTourHost,
  offlineTour,
  startOfflineTour,
} from './offline-tour';

type Btn = {
  id: string;
  icon: string;
  label: string;
  title?: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  pressed?: boolean;
  menu?: boolean;
};
type Group = { id: string; label: string; buttons: Btn[] };

type State = {
  tab: OfflineRibbonTab;
  collapsed: boolean;
  compact: boolean;
};

const PANES: { id: string; label: [string, string]; icon: string }[] = [
  { id: 'RootSidebar', label: ['תיקיות', 'Folders'], icon: '📁' },
  { id: 'MessageList', label: ['קורא', 'Reader'], icon: '📄' },
  { id: 'MessageListSidebar', label: ['עוזר AI', 'AI assistant'], icon: '🤖' },
];

function remote() {
  return require('@electron/remote');
}

function webContents() {
  return remote().getCurrentWebContents();
}

// Edit buttons act on the active / last used text field (focus restored
// first, so keyboard users who Tab onto the ribbon get the same result).
function inField(fn: () => void) {
  focusEditTarget();
  fn();
}

/** Edit group "Select all": all the text in the open draft's last used
 * field (the body by default). */
export function ribbonSelectAllDraftText(): boolean {
  const field = draftSelectTarget();
  if (!field) {
    return false;
  }
  selectAllInField(field);
  return true;
}

/** Home "Select all messages": every message in the list on screen (search
 * results or the folder list), like the list's own "Select all". From the
 * drafts screen it goes back to the mail list (the draft is saved) so the
 * selection can be seen. */
export function ribbonSelectAllMessages(): 'search-results' | 'messages' | 'none' {
  if (offlineDraftsStore.showing) {
    offlineDraftsStore.hide();
  }
  const searchAll = document.querySelector('[data-offline-search-select-all]') as HTMLElement;
  if (searchAll && searchAll.getClientRects().length > 0) {
    searchAll.click();
    return 'search-results';
  }
  if (!offlineMailStore.visibleRows().length) {
    return 'none';
  }
  offlineMailStore.selectAllVisible();
  return 'messages';
}

function sendCommand(command: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('electron').ipcRenderer.send('command', command);
}

/** False while a full-page sheet such as Preferences replaces the mail view. */
function showingMail(): boolean {
  try {
    const top = WorkspaceStore.topSheet();
    if (top && top.id === 'Preferences') {
      return false;
    }
    const fps = FocusedPerspectiveStore as any;
    return typeof fps.isShowingMail === 'function' ? fps.isShowingMail() !== false : true;
  } catch (e) {
    return true;
  }
}

function configDir(): string | null {
  try {
    return AppEnv.getConfigDirPath();
  } catch (e) {
    return null;
  }
}

/** The message the reader shows (newest of an open conversation). */
function currentMessage(): { id: string; parsed: ParsedOfflineMail } | null {
  const s = offlineMailStore;
  if (s.openMessage && s.openMessage.parsed) {
    return { id: s.openMessage.id, parsed: s.openMessage.parsed };
  }
  const t = s.openThread;
  if (t) {
    for (let i = t.ids.length - 1; i >= 0; i--) {
      const p = t.parsed[t.ids[i]];
      if (p) {
        return { id: t.ids[i], parsed: p };
      }
    }
  }
  return null;
}

function draftSource(id: string, m: ParsedOfflineMail): OfflineDraftSource {
  return { id, subject: m.subject, from: m.from, to: m.to, cc: m.cc, date: m.date, text: m.text };
}

export class OfflineRibbon extends React.Component<Record<string, never>, State> {
  static displayName = 'OfflineRibbon';

  private _unsubs: Array<() => void> = [];
  private _ro: ResizeObserver | null = null;
  private _panel = React.createRef<HTMLDivElement>();
  private _fullWidth: { [tab: string]: number | null } = {};
  private _fitScheduled = false;

  constructor(props: Record<string, never>) {
    super(props);
    const prefs = readRibbonPrefs(configDir());
    this.state = { tab: prefs.tab, collapsed: prefs.collapsed, compact: false };
  }

  /**
   * The column toolbar row is hidden only on the main mail view; sheets opened
   * on top (Preferences) keep their toolbar with the Back button.
   */
  _syncBodyClass() {
    const stack = (WorkspaceStore as any).sheetStack?.() || [];
    document.body.classList.toggle('offline-ribbon-on', stack.length <= 1);
  }

  componentDidMount() {
    this._syncBodyClass();
    const update = () => {
      this._syncBodyClass();
      this.forceUpdate();
    };
    this._unsubs.push(installEditTargetTracker(document));
    this._unsubs.push(WorkspaceStore.listen(update));
    this._unsubs.push(offlineMailStore.listen(update));
    this._unsubs.push(offlineDraftsStore.listen(update));
    this._unsubs.push(AISidebarStore.listen(update));
    this._unsubs.push(offlineTour.listen(update));
    this._unsubs.push(offlineVoice.listen(update));
    // The interactive guide shows the tab of each step.
    const onShowTab = (e: Event) => {
      const tab = (e as CustomEvent).detail;
      if (
        OFFLINE_RIBBON_TABS.some((t) => t.id === tab) &&
        (tab !== this.state.tab || this.state.collapsed)
      ) {
        this._setTab(tab);
      }
    };
    window.addEventListener(OFFLINE_RIBBON_TAB_EVENT, onShowTab);
    this._unsubs.push(() => window.removeEventListener(OFFLINE_RIBBON_TAB_EVENT, onShowTab));
    const themeSub = AppEnv.themes.onDidChangeActiveThemes(update);
    this._unsubs.push(() => themeSub.dispose());
    const el = this._panel.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._scheduleFit());
      this._ro.observe(el);
    }
    this._scheduleFit();
  }

  componentDidUpdate() {
    this._syncBodyClass();
    this._scheduleFit();
  }

  componentWillUnmount() {
    document.body.classList.remove('offline-ribbon-on');
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
    if (this._ro) {
      this._ro.disconnect();
    }
  }

  _scheduleFit() {
    if (this._fitScheduled) {
      return;
    }
    this._fitScheduled = true;
    window.requestAnimationFrame(() => {
      this._fitScheduled = false;
      this._fit();
    });
  }

  _fit() {
    const el = this._panel.current;
    if (!el) {
      return;
    }
    const tab = this.state.tab;
    const inner = el.firstElementChild as HTMLElement | null;
    const content = inner ? inner.scrollWidth : el.scrollWidth;
    const next = nextRibbonCompact(
      this.state.compact,
      el.clientWidth,
      content,
      this._fullWidth[tab] ?? null
    );
    this._fullWidth[tab] = next.fullWidthNeeded;
    if (next.compact !== this.state.compact) {
      this.setState({ compact: next.compact });
    }
  }

  _setTab(tab: OfflineRibbonTab) {
    // A click always shows the ribbon; double-click on a tab hides it (like Outlook).
    const collapsed = false;
    this.setState({ tab, collapsed, compact: tab === this.state.tab ? this.state.compact : false });
    writeRibbonPrefs(configDir(), { tab, collapsed });
  }

  // Ribbon logo: open/close the AI panel; when opening, put the cursor in
  // the AI instruction box. Never sends anything to Gemini.
  _aiPanelOpen(): boolean {
    const loc = WorkspaceStore.Location.MessageListSidebar;
    return !!loc && !WorkspaceStore.isLocationHidden(loc);
  }

  _toggleAiPanel = () => {
    const loc = WorkspaceStore.Location.MessageListSidebar;
    if (!loc) {
      return;
    }
    const opening = WorkspaceStore.isLocationHidden(loc);
    Actions.toggleWorkspaceLocationHidden(loc);
    if (opening) {
      window.setTimeout(() => {
        const ta = document.querySelector('.ai-sidebar textarea') as HTMLElement;
        if (ta) {
          ta.focus();
        }
      }, 80);
    }
    this.forceUpdate();
  };

  _toggleCollapsed() {
    const collapsed = !this.state.collapsed;
    this.setState({ collapsed });
    writeRibbonPrefs(configDir(), { tab: this.state.tab, collapsed });
  }

  // ---- tab contents ----

  _paneButton(id: string): Btn | null {
    const p = PANES.find((x) => x.id === id);
    const loc = p && WorkspaceStore.Location[p.id];
    if (!p || !loc) {
      return null;
    }
    const hidden = WorkspaceStore.isLocationHidden(loc);
    const label = tr(p.label[0], p.label[1]);
    return {
      id: `pane-${p.id}`,
      icon: p.icon,
      label,
      pressed: !hidden,
      title: hidden ? tr(`הצג ${label}`, `Show ${label}`) : tr(`הסתר ${label}`, `Hide ${label}`),
      onClick: () => Actions.toggleWorkspaceLocationHidden(loc),
    };
  }

  // Contextual (like Yahoo/Outlook): only while messages are selected.
  // Everything is local to this computer and can be restored / undone.
  _actionsGroup(): Group | null {
    const s = offlineMailStore;
    if (offlineDraftsStore.showing) {
      return null;
    }
    const ids = s.actionIds();
    if (!ids.length) {
      return null;
    }
    const n = ids.length;
    const many = n > 1 ? tr(` (${n})`, ` (${n})`) : '';
    const place = localPlaceOf(s.currentFolder);
    const relocated = ids.some((id) => s.isRelocated(id));
    const starred = selectionStarred(ids);
    const unread = selectionUnread(ids);
    const local = tr('רק במחשב הזה — אפשר לשחזר', 'On this computer only — can be restored');
    const buttons: Btn[] = [];
    if (relocated) {
      buttons.push({
        id: 'act-restore',
        icon: '♻️',
        label: tr('שחזר', 'Restore') + many,
        title: tr('החזר לתיקייה המקורית', 'Back to the original folder'),
        onClick: () => actRestore(ids),
      });
    }
    if (place !== 'trash') {
      buttons.push({
        id: 'act-delete',
        icon: '🗑️',
        label: tr('מחק', 'Delete') + many,
        title: tr(`העבר לאשפה המקומית (${local})`, `Move to the local Trash (${local})`),
        onClick: () => actDelete(ids),
      });
    }
    if (place !== 'archive') {
      buttons.push({
        id: 'act-archive',
        icon: '🗄️',
        label: tr('ארכיון', 'Archive') + many,
        title: tr(`העבר לארכיון המקומי (${local})`, `Move to the local Archive (${local})`),
        onClick: () => actArchive(ids),
      });
    }
    buttons.push({
      id: 'act-move',
      icon: '📁',
      label: tr('העבר', 'Move') + many,
      menu: true,
      title: tr(`העבר לתיקייה אחרת (${local})`, `Move to another folder (${local})`),
      onClick: () => openMovePicker(ids),
    });
    if (place !== 'spam') {
      buttons.push({
        id: 'act-spam',
        icon: '🚫',
        label: tr('ספאם', 'Spam') + many,
        title: tr(
          `סמן כספאם — לספאם המקומי (${local})`,
          `Mark as spam — to the local Spam (${local})`
        ),
        onClick: () => actSpam(ids),
      });
    }
    buttons.push(
      {
        id: 'act-star',
        icon: starred ? '★' : '☆',
        label: starred ? tr('הסר כוכב', 'Unstar') : tr('כוכב', 'Star'),
        pressed: starred,
        title: tr('סימון בכוכב (מקומי)', 'Star (local)'),
        onClick: () => actToggleStar(ids),
      },
      {
        id: 'act-unread',
        icon: unread ? '📭' : '✉️',
        label: unread ? tr('סמן כנקרא', 'Mark read') : tr('סמן כלא נקרא', 'Mark unread'),
        title: tr('סימון נקרא / לא נקרא (מקומי)', 'Read / unread mark (local)'),
        onClick: () => actSetUnread(!unread, ids),
      },
      {
        id: 'act-block',
        icon: '⛔',
        label: tr('חסום שולח', 'Block sender'),
        title: tr(
          'הסתר את כל ההודעות מהשולח (רק במחשב הזה; ניהול ב"שולחים חסומים")',
          'Hide all messages from the sender (this computer only; manage in "Blocked senders")'
        ),
        onClick: () => actBlockSenders(ids),
      },
      {
        id: 'act-contact',
        icon: '👤',
        label: tr('הוסף לאנשי קשר', 'Add to contacts'),
        title: tr(
          'שמור את השולח בפנקס הכתובות המקומי',
          'Save the sender in the local address book'
        ),
        onClick: () => actAddContacts(ids),
      },
      {
        id: 'act-print',
        icon: '🖨️',
        label: tr('הדפס', 'Print'),
        disabled: n !== 1,
        title:
          n === 1
            ? tr('פותח את חלון ההדפסה של Windows', 'Opens the Windows print dialog')
            : tr('בחר הודעה אחת להדפסה', 'Select one message to print'),
        onClick: () => void actPrint(ids[0]),
      },
      {
        id: 'act-export',
        icon: '💾',
        label: tr('שמור בשם', 'Save as'),
        disabled: n !== 1,
        title:
          n === 1
            ? tr(
                'שמירת ההודעה או כל השיחה כקובץ PDF או eml, במקום שתבחרו',
                'Save the message or the whole conversation as PDF or .eml, where you choose'
              )
            : tr('בחר הודעה אחת', 'Select one message'),
        onClick: () => openExport(ids[0]),
      }
    );
    return {
      id: 'actions',
      label: n > 1 ? tr(`פעולות (${n} נבחרו)`, `Actions (${n} selected)`) : tr('פעולות', 'Actions'),
      buttons,
    };
  }

  // Contextual (Outlook-like): only while a draft is open for editing.
  _editGroup(): Group {
    const wc = () => webContents();
    return {
      id: 'edit',
      label: tr('עריכת טיוטה', 'Edit draft'),
      buttons: [
        {
          id: 'undo',
          icon: '↶',
          label: tr('ביטול', 'Undo'),
          onClick: () => inField(() => wc().undo()),
        },
        {
          id: 'redo',
          icon: '↷',
          label: tr('ביצוע חוזר', 'Redo'),
          onClick: () => inField(() => wc().redo()),
        },
        {
          id: 'cut',
          icon: '✂️',
          label: tr('גזירה', 'Cut'),
          onClick: () => inField(() => wc().cut()),
        },
        {
          id: 'copy',
          icon: '📋',
          label: tr('העתקה', 'Copy'),
          // Copy also works on text marked in the message reader, so only
          // move the focus back when no text is marked on the page.
          onClick: () => {
            const sel = document.getSelection();
            const field = editTarget();
            const markedElsewhere =
              !!sel && !sel.isCollapsed && !!field && !field.contains(sel.anchorNode);
            if (!markedElsewhere) {
              focusEditTarget();
            }
            wc().copy();
          },
        },
        {
          id: 'paste',
          icon: '📥',
          label: tr('הדבקה', 'Paste'),
          onClick: () => inField(() => wc().paste()),
        },
        {
          id: 'paste-plain',
          icon: '🔤',
          label: tr('הדבקה כטקסט', 'Paste as text'),
          onClick: () => inField(() => wc().pasteAndMatchStyle()),
        },
        {
          id: 'select-all-text',
          icon: '⬚',
          label: tr('בחר הכל', 'Select all text'),
          title: tr(
            'בוחר את כל הטקסט בשדה הטיוטה שבו ערכת לאחרונה (ברירת מחדל: גוף ההודעה)',
            'Selects all the text in the draft field you last edited (the message body by default)'
          ),
          onClick: () => void ribbonSelectAllDraftText(),
        },
      ],
    };
  }

  _groups(tab: OfflineRibbonTab): Group[] {
    const s = offlineMailStore;
    const d = offlineDraftsStore;
    const msg = currentMessage();
    const draft = d.showing ? d.open : null;
    const ai = AISidebarStore.getState();
    const panes = (ids: string[]) => ids.map((id) => this._paneButton(id)).filter(Boolean) as Btn[];
    const noMsg = tr('בחר הודעה קודם', 'Select a message first');
    const noDraft = tr('פתח טיוטה קודם', 'Open a draft first');
    switch (tab) {
      case 'home':
        return [
          {
            id: 'new',
            label: tr('חדש', 'New'),
            buttons: [
              {
                id: 'new-draft',
                icon: '✉️',
                label: tr('טיוטה חדשה', 'New draft'),
                title: tr(
                  'טיוטה חדשה — נשמרת רק במחשב, אין שליחה',
                  'New draft — saved only on this computer, no sending'
                ),
                onClick: () => d.createNew(),
              },
            ],
          },
          {
            id: 'respond',
            label: tr('תגובה', 'Respond'),
            buttons: [
              {
                id: 'reply',
                icon: '↩️',
                label: tr('השב', 'Reply'),
                disabled: !msg,
                title: msg
                  ? tr('טיוטת תשובה מקומית (אין שליחה)', 'Local reply draft (no sending)')
                  : noMsg,
                onClick: () => msg && d.createReply(draftSource(msg.id, msg.parsed)),
              },
              {
                id: 'forward',
                icon: '↪️',
                label: tr('העבר', 'Forward'),
                disabled: !msg,
                title: msg
                  ? tr(
                      'טיוטת העברה מקומית עם הקבצים המצורפים (אין שליחה)',
                      'Local forward draft with the attachments (no sending)'
                    )
                  : noMsg,
                onClick: () =>
                  msg && d.createForward(draftSource(msg.id, msg.parsed), forwardFiles(msg.id)),
              },
            ],
          },
          {
            id: 'find',
            label: tr('חיפוש', 'Find'),
            buttons: [
              {
                id: 'search',
                icon: '🔎',
                label: tr('חיפוש בדואר', 'Search mail'),
                title: tr(
                  'חיפוש מקומי בכל התיקיות: נושא, שולח, נמענים, תוכן ושמות קבצים (Ctrl+F)',
                  'Local search in all folders: subject, sender, recipients, text and file names (Ctrl+F)'
                ),
                onClick: () => {
                  d.hide();
                  window.setTimeout(() => {
                    const input = document.querySelector(
                      '.offline-search-input'
                    ) as HTMLInputElement;
                    if (input) {
                      input.focus();
                      input.select();
                    }
                  }, 50);
                },
              },
              {
                id: 'threads',
                icon: '🧵',
                label: tr('שיחות', 'Conversations'),
                pressed: s.threaded,
                title: tr(
                  'הצג הודעות מקובצות לשיחות (ההגדרה נשמרת)',
                  'Group messages into conversations (remembered)'
                ),
                onClick: () => s.setThreaded(!s.threaded),
              },
            ],
          },
          {
            id: 'select',
            label: tr('בחירה', 'Select'),
            buttons: [
              {
                id: 'select-messages',
                icon: '☑️',
                label: tr('בחר את כל ההודעות', 'Select all messages'),
                title: tr(
                  'בוחר את כל ההודעות ברשימה המוצגת (כמו "בחר הכל" מעל הרשימה)',
                  'Selects all the messages in the list on screen (like "Select all" above the list)'
                ),
                onClick: () => void ribbonSelectAllMessages(),
              },
            ],
          },
          {
            id: 'rules-group',
            label: tr('כללים', 'Rules'),
            buttons: [
              {
                id: 'rules',
                icon: '📋',
                label: tr(`כללים (${s.rules.length})`, `Rules (${s.rules.length})`),
                title: tr(
                  'כללים מקומיים: העבר / כוכב / לא נקרא / מחק / חסום אוטומטית לפי שולח, נמען, נושא, קבצים או תיקייה',
                  'Local rules: move / star / unread / delete / block automatically by sender, recipient, subject, files or folder'
                ),
                onClick: () => openRules(),
              },
              {
                id: 'rule-from-message',
                icon: '➕',
                label: tr('כלל מההודעה', 'Rule from message'),
                disabled: !s.actionIds().length,
                title: s.actionIds().length
                  ? tr(
                      'כלל חדש עם השולח של ההודעה שנבחרה',
                      'New rule with the sender of the selected message'
                    )
                  : noMsg,
                onClick: () => newRuleFromMessage(),
              },
            ],
          },
          ...(offlineVoice.available
            ? [
                {
                  id: 'voice',
                  label: tr('קול', 'Voice'),
                  buttons: [
                    {
                      id: 'voice-command',
                      icon: '🎙️',
                      label: tr('פקודה קולית', 'Voice command'),
                      pressed: offlineVoice.mode === 'command' && offlineVoice.state !== 'idle',
                      title: tr(
                        'פקודה קולית (Ctrl+Shift+Space): "פתח טיוטה חדשה", "חפש …", "עבור לתיקייה …", "מחק", "ארכיון", "סמן בכוכב", "תענה ש…". Whisper מקומי — ההקלטה לא יוצאת מהמחשב, ו-Gemini רק בלחיצה.',
                        'Voice command (Ctrl+Shift+Space): "new draft", "search …", "go to folder …", "delete", "archive", "star", "reply that …". Local Whisper — no audio leaves the PC; Gemini only on click.'
                      ),
                      onClick: () => offlineVoice.toggle('command'),
                    },
                  ],
                },
              ]
            : []),
          ...(draft ? [this._editGroup()] : []),
        ].concat(((g) => (g ? [g] : []))(this._actionsGroup()));
      case 'view':
        return [
          {
            id: 'areas',
            label: tr('אזורים', 'Areas'),
            buttons: panes(['RootSidebar', 'MessageList', 'MessageListSidebar']),
          },
          {
            id: 'list',
            label: tr('רשימה', 'List'),
            buttons: [
              {
                id: 'threads-view',
                icon: '🧵',
                label: tr('שיחות', 'Conversations'),
                pressed: s.threaded,
                onClick: () => s.setThreaded(!s.threaded),
              },
              {
                id: 'density-compact',
                icon: '☰',
                label: tr('מצומצם', 'Compact'),
                title: tr('שורה אחת להודעה (נשמר)', 'One line per message (remembered)'),
                pressed: s.density === 'compact',
                onClick: () => s.setDensity('compact'),
              },
              {
                id: 'density-expanded',
                icon: '▤',
                label: tr('מורחב', 'Expanded'),
                title: tr(
                  'שלוש שורות: שולח ותאריך / נושא / תחילת ההודעה (נשמר)',
                  'Three lines: sender and date / subject / preview (remembered)'
                ),
                pressed: s.density === 'expanded',
                onClick: () => s.setDensity('expanded'),
              },
            ],
          },
          {
            id: 'sort',
            label: tr('מיון (לכל תיקייה)', 'Sort (per folder)'),
            buttons: [
              ...(['date', 'subject', 'from', 'attachments'] as OfflineSortKey[]).map((k) => ({
                id: `sort-${k}`,
                icon: { date: '📅', subject: '🔤', from: '👤', attachments: '📎' }[k],
                label: tr(SORT_LABELS[k][0], SORT_LABELS[k][1]),
                title: tr(
                  'מיין לפי זה (לחיצה נוספת הופכת כיוון)',
                  'Sort by this (click again to reverse)'
                ),
                pressed: s.sort.key === k,
                onClick: () => s.setSortKey(k),
              })),
              {
                id: 'sort-dir',
                icon: s.sort.dir === 'asc' ? '↑' : '↓',
                label: s.sort.dir === 'asc' ? tr('עולה', 'Ascending') : tr('יורד', 'Descending'),
                title: tr('הפוך את כיוון המיון', 'Reverse the sort direction'),
                onClick: () => s.toggleSortDir(),
              },
              {
                id: 'attach-only',
                icon: '📎',
                label: tr('רק עם צרופות', 'Attachments only'),
                pressed: s.attachmentsOnly,
                onClick: () => s.setAttachmentsOnly(!s.attachmentsOnly),
              },
            ],
          },
          {
            id: 'zoom',
            label: tr('גודל תצוגה', 'Zoom'),
            buttons: [
              {
                id: 'zoom-in',
                icon: '➕',
                label: tr('הגדל', 'Zoom in'),
                onClick: () => webContents().setZoomLevel(webContents().getZoomLevel() + 0.5),
              },
              {
                id: 'zoom-out',
                icon: '➖',
                label: tr('הקטן', 'Zoom out'),
                onClick: () => webContents().setZoomLevel(webContents().getZoomLevel() - 0.5),
              },
              {
                id: 'zoom-reset',
                icon: '💯',
                label: tr('גודל רגיל', 'Actual size'),
                onClick: () => webContents().setZoomLevel(0),
              },
            ],
          },
          {
            id: 'window',
            label: tr('חלון', 'Window'),
            buttons: [
              {
                id: 'fullscreen',
                icon: '⛶',
                label: tr('מסך מלא', 'Full screen'),
                pressed: AppEnv.isFullScreen(),
                onClick: () => AppEnv.setFullScreen(!AppEnv.isFullScreen()),
              },
              {
                id: 'minimize',
                icon: '🗕',
                label: tr('מזעור', 'Minimize'),
                onClick: () => AppEnv.minimize(),
              },
              {
                id: 'maximize',
                icon: '🗖',
                label: tr('הגדלה / שחזור', 'Maximize / restore'),
                onClick: () => {
                  const w = remote().getCurrentWindow();
                  if (w.isMaximized()) {
                    w.unmaximize();
                  } else {
                    w.maximize();
                  }
                },
              },
            ],
          },
          {
            id: 'look',
            label: tr('מראה', 'Look'),
            buttons: [
              {
                id: 'theme',
                icon: '🎨',
                label: tr('ערכת צבעים', 'Theme'),
                menu: true,
                title: tr(
                  `בחר ערכת צבעים (${offlineThemeChoices().length} אפשרויות)`,
                  `Choose a color theme (${offlineThemeChoices().length} choices)`
                ),
                onClick: (e) => showThemeMenu(e.currentTarget),
              },
            ],
          },
        ];
      case 'drafts':
        return [
          {
            id: 'drafts-main',
            label: tr('טיוטות מקומיות', 'Local drafts'),
            buttons: [
              {
                id: 'drafts-new',
                icon: '✉️',
                label: tr('טיוטה חדשה', 'New draft'),
                onClick: () => d.createNew(),
              },
              {
                id: 'drafts-list',
                icon: '🗂️',
                label: tr(`כל הטיוטות (${d.count})`, `All drafts (${d.count})`),
                pressed: d.showing,
                onClick: () => (d.showing ? d.hide() : d.showList()),
              },
            ],
          },
          {
            id: 'draft-open',
            label: tr('הטיוטה הפתוחה', 'Open draft'),
            buttons: [
              {
                id: 'draft-attach',
                icon: '📎',
                label: tr('צרף קבצים', 'Attach files'),
                disabled: !draft,
                title: draft
                  ? tr('הוסף קבצים לטיוטה (נשמרים רק במחשב)', 'Add files (kept on this computer)')
                  : noDraft,
                onClick: () => {
                  if (draft) {
                    const id = draft.id;
                    void chooseFilesToAttach().then((paths) => {
                      if (paths.length) {
                        d.addAttachmentFiles(id, paths);
                      }
                    });
                  }
                },
              },
              ...((info) =>
                info && info.total
                  ? [
                      {
                        id: 'draft-attach-originals',
                        icon: '📎',
                        label: tr('צרף את הקבצים המקוריים', 'Attach the original files'),
                        disabled: !info.missing,
                        title: info.missing
                          ? tr(
                              `מעתיק ${info.missing} קבצים מההודעה המקורית לטיוטה (אין שליחה)`,
                              `Copies ${info.missing} file(s) from the original message into the draft (no sending)`
                            )
                          : tr(
                              'כל הקבצים המקוריים כבר מצורפים',
                              'All the original files are already attached'
                            ),
                        onClick: () => draft && attachReplyOriginals(draft),
                      } as Btn,
                    ]
                  : [])(replyOriginalsInfo(draft)),
              {
                id: 'draft-proofread',
                icon: '✨',
                label: tr('הגהה עם Gemini', 'Proofread with Gemini'),
                disabled: !draft || !draft.body.trim(),
                title: draft
                  ? tr(
                      'שולח ל-Gemini (בתשלום) רק את טקסט הטיוטה',
                      'Sends only the draft text to Gemini (paid)'
                    )
                  : noDraft,
                onClick: () => draft && void d.proofread(draft.id),
              },
              {
                id: 'draft-close',
                icon: '✖️',
                label: tr('סגור טיוטה', 'Close draft'),
                disabled: !draft,
                title: draft ? undefined : noDraft,
                onClick: () => d.closeDraft(),
              },
            ],
          },
          ...(draft ? [this._editGroup()] : []),
        ];
      case 'ai': {
        const scope = (mode: ScopeMode, icon: string, he: string, en: string): Btn => ({
          id: `scope-${mode}`,
          icon,
          label: tr(he, en),
          pressed: ai.scopeMode === mode,
          onClick: () => void AISidebarStore.setScopeMode(mode),
        });
        return [
          { id: 'ai-panel', label: tr('חלונית', 'Panel'), buttons: panes(['MessageListSidebar']) },
          {
            id: 'ai-write',
            label: tr('כתיבה', 'Write'),
            buttons: [
              {
                id: 'ai-write',
                icon: '✍️',
                label: tr('כתוב עם AI', 'Write with AI'),
                pressed: ai.scopeMode === 'open-draft' && ai.draftWriteMode,
                title: draft
                  ? tr(
                      'AI יכתוב את המייל או את התשובה לפי הוראה שלך (נשלח ל-Gemini רק בלחיצה על "כתוב")',
                      'The AI writes the mail or the reply from your instruction (sent to Gemini only when you click "Write")'
                    )
                  : tr(
                      'פותח טיוטה חדשה ו-AI יכתוב אותה לפי הוראה שלך (נשלח רק בלחיצה על "כתוב")',
                      'Opens a new draft that the AI writes from your instruction (sent only when you click "Write")'
                    ),
                onClick: () => startWriteWithAi(),
              },
            ],
          },
          {
            id: 'ai-scope',
            label: tr('על מה לשאול', 'Ask about'),
            buttons: [
              scope('selected-messages', '☑️', 'נבחרות', 'Selected'),
              scope('current-folder', '📁', 'התיקייה', 'This folder'),
              scope('all-mail', '🗄️', 'כל העותק', 'Whole copy'),
              {
                ...scope('open-draft', '📝', 'טיוטה פתוחה', 'Open draft'),
                title: draft
                  ? tr(
                      'לשאול את ה-AI על הטיוטה הפתוחה (נשלח רק טקסט הטיוטה)',
                      'Ask the AI about the open draft (only the draft text is sent)'
                    )
                  : tr('פתח טיוטה קודם (כרטיסיית טיוטות)', 'Open a draft first (Drafts tab)'),
              },
            ],
          },
          {
            id: 'ai-ask',
            label: tr('שיחה', 'Chat'),
            buttons: [
              {
                id: 'ai-focus',
                icon: '💬',
                label: tr('כתוב שאלה', 'Ask a question'),
                onClick: () => {
                  const loc = WorkspaceStore.Location.MessageListSidebar;
                  if (loc && WorkspaceStore.isLocationHidden(loc)) {
                    Actions.toggleWorkspaceLocationHidden(loc);
                  }
                  window.setTimeout(() => {
                    const ta = document.querySelector('.ai-sidebar textarea') as HTMLElement;
                    if (ta) {
                      ta.focus();
                    }
                  }, 80);
                },
              },
              {
                id: 'ai-clear',
                icon: '🧹',
                label: tr('נקה שיחה', 'Clear chat'),
                onClick: () => AISidebarStore.clearConversation(),
              },
            ],
          },
        ];
      }
      case 'settings':
      default: {
        let commit = '';
        try {
          commit = (AppEnv as any).menu?.offlineShortCommit?.() || '';
        } catch (e) {
          commit = '';
        }
        return [
          {
            id: 'help',
            label: tr('עזרה', 'Help'),
            buttons: [
              {
                id: 'interactive-tour',
                icon: '✨',
                label: tr('מדריך אינטראקטיבי', 'Interactive guide'),
                title: tr(
                  'סיור קצר עם מיילי על כל חלקי האפליקציה (אפשר לדלג בכל רגע)',
                  'A short tour with Maily over every part of the app (skip any time)'
                ),
                onClick: () => startOfflineTour(),
              },
              {
                id: 'tips',
                icon: '❔',
                label: tr('טיפים "?"', '"?" tips'),
                pressed: offlineTour.tipsOn,
                title: tr(
                  'הצג/הסתר את סימני ה-"?" הקטנים עם טיפים ליד החיפוש, ה-AI, הכללים והשמירה',
                  'Show/hide the small "?" tips next to search, the AI, rules and Save as'
                ),
                onClick: () => offlineTour.setTips(!offlineTour.tipsOn),
              },
            ],
          },
          {
            id: 'prefs',
            label: tr('הגדרות', 'Settings'),
            buttons: [
              showingMail()
                ? {
                    id: 'preferences',
                    icon: '⚙️',
                    label: tr('הגדרות', 'Preferences'),
                    onClick: () => sendCommand('application:open-preferences'),
                  }
                : {
                    id: 'back-to-mail',
                    icon: '📬',
                    label: tr('חזרה לדואר', 'Back to mail'),
                    onClick: () => sendCommand('application:show-mail'),
                  },
              {
                id: 'theme-s',
                icon: '🎨',
                label: tr('ערכת צבעים', 'Theme'),
                menu: true,
                onClick: (e) => showThemeMenu(e.currentTarget),
              },
              {
                id: 'language',
                icon: '🌐',
                label: tr('שפה: עברית', 'Language: English'),
                menu: true,
                title: tr(
                  'שפת הממשק (עברית / English) — האפליקציה תיפתח מחדש',
                  'Interface language (עברית / English) — the app restarts'
                ),
                onClick: (e) => showLanguageMenu(e.currentTarget),
              },
            ],
          },
          {
            id: 'local-changes',
            label: tr('שינויים מקומיים', 'Local changes'),
            buttons: [
              {
                id: 'blocked-senders',
                icon: '⛔',
                label: tr(
                  `שולחים חסומים (${s.overlay.blocked.length})`,
                  `Blocked senders (${s.overlay.blocked.length})`
                ),
                title: tr('צפייה וביטול חסימה', 'View and unblock'),
                onClick: () => openBlockedList(),
              },
              {
                id: 'reset-local',
                icon: '↺',
                label: tr('אפס את כל השינויים המקומיים', 'Reset all local changes'),
                disabled: !s.localChangeCounts().total,
                title: tr(
                  'מחזיר את כל ההודעות לתיקיות המקוריות, מוחק כוכבים/סימוני קריאה, חסימות, אנשי קשר שנשמרו וכללים (עם אישור)',
                  'Puts every message back in its original folder and clears stars, read marks, blocks, saved contacts and rules (asks first)'
                ),
                onClick: () => void actResetLocalChanges(),
              },
            ],
          },
          {
            id: 'about',
            label: tr('אודות', 'About'),
            buttons: [
              {
                id: 'version',
                icon: 'ℹ️',
                label: offlineVersionLabel(offlineLang(), commit),
                title: tr(
                  'גרסת הניסוי הלא מקוון (קריאה מעותק מקומי, בלי שליחה)',
                  'Offline experiment build (reads a local copy, no sending)'
                ),
                onClick: () => undefined,
              },
            ],
          },
          {
            id: 'app',
            label: tr('יישום', 'App'),
            buttons: [
              {
                id: 'quit',
                icon: '⏻',
                label: tr('יציאה', 'Exit'),
                onClick: () => sendCommand('application:quit'),
              },
            ],
          },
        ];
      }
    }
  }

  _renderButton(b: Btn) {
    const compact = this.state.compact;
    return (
      <button
        key={b.id}
        type="button"
        className={classNames('offline-ribbon-btn', {
          pressed: b.pressed,
          'is-info': b.id === 'version',
        })}
        data-offline-ribbon-btn={b.id}
        disabled={b.disabled}
        aria-pressed={b.pressed === undefined ? undefined : b.pressed}
        aria-haspopup={b.menu ? 'menu' : undefined}
        aria-label={b.label}
        title={b.title || (compact ? b.label : undefined)}
        // Keep the focus where it was (Copy / Paste act on the focused field).
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          try {
            b.onClick(e);
          } catch (err) {
            console.warn('[Offline ribbon] action failed', b.id);
          }
        }}
      >
        <span className="offline-ribbon-icon" aria-hidden="true">
          {b.icon}
        </span>
        {compact ? null : (
          <span className="offline-ribbon-label" dir="auto">
            {b.label}
            {b.menu ? ' ▾' : ''}
          </span>
        )}
      </button>
    );
  }

  render() {
    const { tab, collapsed, compact } = this.state;
    const groups = this._groups(tab);
    return (
      <div
        className={classNames('offline-ribbon', { compact, collapsed })}
        dir={offlineDir()}
        data-offline-ribbon={tab}
        data-offline-ribbon-compact={compact ? 'true' : 'false'}
      >
        <div className="offline-ribbon-tabs" role="tablist" aria-label={tr('תפריט', 'Menu')}>
          <OfflineBrand
            compact={compact}
            onActivate={this._toggleAiPanel}
            aiOpen={this._aiPanelOpen()}
          />
          {showingMail() ? null : (
            <button
              type="button"
              className="offline-ribbon-backmail"
              data-offline-ribbon-backmail="true"
              title={tr('סגור את ההגדרות וחזור לדואר', 'Close settings and go back to mail')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendCommand('application:show-mail')}
            >
              {tr('📬 חזרה לדואר', '📬 Back to mail')}
            </button>
          )}
          {OFFLINE_RIBBON_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              className={classNames('offline-ribbon-tab', { active: t.id === tab })}
              data-offline-ribbon-tab={t.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => this._setTab(t.id)}
              onDoubleClick={() => this._toggleCollapsed()}
            >
              {tr(t.label[0], t.label[1])}
            </button>
          ))}
          <span className="offline-ribbon-spacer" />
          <span
            className="offline-ribbon-brand"
            title={tr('עותק מקומי, קריאה בלבד', 'Local copy, read-only')}
          >
            {tr('📬 דואר לא מקוון', '📬 Offline mail')}
          </span>
          <button
            type="button"
            className="offline-ribbon-collapse"
            data-offline-ribbon-collapse="true"
            title={
              collapsed
                ? tr('הצג את סרגל הכלים', 'Show the ribbon')
                : tr('הסתר את סרגל הכלים', 'Hide the ribbon')
            }
            aria-label={
              collapsed
                ? tr('הצג את סרגל הכלים', 'Show the ribbon')
                : tr('הסתר את סרגל הכלים', 'Hide the ribbon')
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => this._toggleCollapsed()}
          >
            {collapsed ? '⌄' : '⌃'}
          </button>
        </div>
        <div
          className="offline-ribbon-panel"
          ref={this._panel}
          role="tabpanel"
          hidden={collapsed}
          aria-label={tr(
            OFFLINE_RIBBON_TABS.find((t) => t.id === tab)!.label[0],
            OFFLINE_RIBBON_TABS.find((t) => t.id === tab)!.label[1]
          )}
        >
          <div className="offline-ribbon-groups">
            {groups.map((g) => (
              <div
                key={g.id}
                className="offline-ribbon-group"
                role="group"
                aria-label={g.label}
                data-offline-ribbon-group={g.id}
              >
                <div className="offline-ribbon-group-buttons">
                  {g.buttons.map((b) => this._renderButton(b))}
                </div>
                {compact ? null : <div className="offline-ribbon-group-label">{g.label}</div>}
              </div>
            ))}
          </div>
        </div>
        <OfflineActionsHost />
        <OfflineRulesDialog />
        <OfflineExportDialog />
        <OfflineTourHost />
        <OfflineVoiceHud />
      </div>
    );
  }
}
