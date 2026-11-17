/**
 * Offline experiment: the application menu (Windows "hamburger" / menu bar).
 *
 * In offline mode the menu is rewritten before it reaches the main process:
 * - every label follows the offline UI language (Hebrew / English), using our
 *   own table because Mailspring's Hebrew table misses many menu strings;
 * - items that cannot work offline are hidden (sync, accounts, plugins and
 *   themes from the web, help pages, calendar / contacts, anything whose
 *   command has no handler in this window); the Developer menu is hidden
 *   unless MAILSPRING_OFFLINE_DEVELOPER_MENU=1;
 * - shortcuts with punctuation (Ctrl+,) are shown as typed: Chromium would
 *   spell the key name ("Ctrl+Comma" / "Ctrl+פסיק"). The keys themselves are
 *   still handled by Mailspring's keymap in the window;
 * - the version line reads "גרסת ניסוי offline <commit>".
 * Outside offline mode nothing changes.
 */
import fs from 'fs';
import path from 'path';

export type OfflineMenuLang = 'he' | 'en';

export interface OfflineMenuItem {
  id?: string;
  label?: string;
  type?: string;
  command?: string;
  enabled?: boolean;
  visible?: boolean;
  submenu?: OfflineMenuItem[];
  [k: string]: any;
}

/** Commands that make no sense in the disconnected experiment. */
export const OFFLINE_MENU_HIDDEN_COMMANDS = [
  'window:sync-mail-now',
  'application:add-account',
  'window:install-package',
  'window:create-package',
  'application:view-getting-started',
  'application:view-community',
  'application:view-help',
  'window:open-mailsync-logs',
  'application:show-calendar',
  'application:show-contacts',
  'application:check-for-update',
  'application:install-update',
  // Mailspring's own mailbox views; the offline folder tree replaces them.
  'navigation:go-to-inbox',
  'navigation:go-to-unread',
  'navigation:go-to-starred',
  'navigation:go-to-sent',
  'navigation:go-to-drafts',
  'navigation:go-to-all',
];

/** Top-level menus by id. 'Window' keeps Mailspring's label (the main process looks it up). */
const MENU_LABELS: { [id: string]: [string, string] } = {
  Edit: ['עריכה', 'Edit'],
  View: ['תצוגה', 'View'],
  Thread: ['שרשור', 'Thread'],
  Developer: ['מפתחים', 'Developer'],
};

/**
 * Labels by command. Commands whose labels the main process matches on
 * (full screen, updates) are deliberately absent.
 */
export const OFFLINE_MENU_LABELS: { [command: string]: [string, string] } = {
  'core:undo': ['ביטול פעולה', 'Undo'],
  'core:redo': ['ביצוע חוזר', 'Redo'],
  'core:cut': ['גזירה', 'Cut'],
  'core:copy': ['העתקה', 'Copy'],
  'core:paste': ['הדבקה', 'Paste'],
  'core:paste-and-match-style': ['הדבקה כטקסט פשוט', 'Paste and Match Style'],
  'core:select-all': ['בחירת הכול', 'Select All'],
  'thread-list:select-read': ['בחירת כל הנקראות', 'Select All Read'],
  'thread-list:select-unread': ['בחירת כל שלא נקראו', 'Select All Unread'],
  'thread-list:select-starred': ['בחירת כל המסומנות בכוכב', 'Select All Starred'],
  'thread-list:select-unstarred': ['בחירת כל שאינן מסומנות', 'Select All Unstarred'],
  'thread-list:mark-all-as-read': ['סימון הכול כנקרא', 'Mark All as Read'],
  'core:focus-search': ['חיפוש בתיבה…', 'Find in Mailbox…'],
  'core:find-in-thread': ['חיפוש בשרשור…', 'Find in Thread…'],
  'core:find-in-thread-next': ['חיפוש הבא', 'Find Next'],
  'core:find-in-thread-previous': ['חיפוש הקודם', 'Find Previous'],
  'navigation:list-mode-off': ['ללא חלונית קריאה', 'Reading Pane Off'],
  'navigation:list-mode-on': ['ללא חלונית קריאה', 'Reading Pane Off'],
  'navigation:split-mode-off': ['חלונית קריאה אופקית', 'Horizontal Reading Pane'],
  'navigation:split-mode-on': ['חלונית קריאה אופקית', 'Horizontal Reading Pane'],
  'navigation:splitVertical-mode-off': ['חלונית קריאה אנכית', 'Vertical Reading Pane'],
  'navigation:splitVertical-mode-on': ['חלונית קריאה אנכית', 'Vertical Reading Pane'],
  'navigation:go-to-inbox': ['מעבר לדואר הנכנס', 'Go to Inbox'],
  'navigation:go-to-unread': ['מעבר ללא נקראו', 'Go to Unread'],
  'navigation:go-to-starred': ['מעבר למסומנות בכוכב', 'Go to Starred'],
  'navigation:go-to-sent': ['מעבר לדואר שנשלח', 'Go to Sent Mail'],
  'navigation:go-to-drafts': ['מעבר לטיוטות', 'Go to Drafts'],
  'navigation:go-to-all': ['מעבר לכל הדואר', 'Go to All Mail'],
  'core:reply': ['תשובה', 'Reply'],
  'core:reply-all': ['תשובה לכולם', 'Reply All'],
  'core:forward': ['העברה', 'Forward'],
  'core:forward-as-attachment': ['העברה כקובץ מצורף', 'Forward as Attachment'],
  'core:mark-as-unread': ['סימון כלא נקרא', 'Mark as Unread'],
  'core:mark-as-read': ['סימון כנקרא', 'Mark as Read'],
  'core:report-as-spam': ['סימון כדואר זבל', 'Mark as Spam'],
  'core:report-not-spam': ['סימון כלא זבל', 'Mark as Not Spam'],
  'core:mark-important': ['סימון כחשוב', 'Mark as Important'],
  'core:mark-unimportant': ['סימון כלא חשוב', 'Mark as Not Important'],
  'core:star-item': ['סימון בכוכב', 'Star'],
  'core:snooze-item': ['נודניק…', 'Snooze…'],
  'core:share-item-link': ['שיתוף השרשור…', 'Share this thread…'],
  'core:copy-mailbox-link': ['העתקת קישור לתיבה', 'Copy mailbox permalink'],
  'core:save-as-eml': ['שמירה כקובץ ‎.eml…', 'Save as .eml…'],
  'core:remove-from-view': ['הסרה מהתצוגה', 'Remove from view'],
  'core:remove-and-next': ['הסרה ומעבר לבא', 'Remove and show next'],
  'core:remove-and-previous': ['הסרה ומעבר לקודם', 'Remove and show previous'],
  'core:delete-item': ['העברה לאשפה', 'Move to Trash'],
  'core:archive-item': ['העברה לארכיון', 'Move to Archive'],
  'core:change-folders': ['העברה לתיקייה…', 'Move to Folder…'],
  'core:change-labels': ['החלת תווית…', 'Apply Label…'],
  'message-list:toggle-expanded': ['הרחבה / כיווץ שיחה', 'Expand / collapse conversation'],
  'application:toggle-dev': ['הרצה עם דגלי ניפוי', 'Run with Debug Flags'],
  'window:reload': ['טעינה מחדש', 'Reload'],
  'window:toggle-dev-tools': ['כלי מפתחים', 'Toggle Developer Tools'],
  'window:toggle-component-regions': ['הצגת אזורי רכיבים', 'Toggle Component Regions'],
  'window:toggle-screenshot-mode': ['מצב צילום מסך', 'Toggle Screenshot Mode'],
  'application:view-license': ['רישיון', 'View License'],
  'application:minimize': ['מזעור', 'Minimize'],
  'application:zoom': ['הגדלה / הקטנה', 'Zoom'],
  'application:show-mail': ['דואר', 'Mail'],
  'application:open-preferences': ['הגדרות', 'Preferences'],
  'window:launch-theme-picker': ['החלפת ערכת נושא…', 'Change Theme…'],
  'core:print-thread': ['הדפסת השרשור', 'Print Current Thread'],
  'application:quit': ['יציאה', 'Exit'],
};

export function offlineVersionLabel(lang: OfflineMenuLang, shortCommit: string): string {
  const c = shortCommit || '';
  return lang === 'he' ? `גרסת ניסוי offline ${c}`.trim() : `Offline experiment ${c}`.trim();
}

/** Short commit of the source checkout, read from .git (no git process). */
export function readShortCommit(repoRoot: string): string {
  try {
    let gitDir = path.join(repoRoot, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return '';
      gitDir = path.resolve(repoRoot, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) {
      return head.slice(0, 9);
    }
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return '';
    let common = gitDir;
    try {
      common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // not a worktree
    }
    for (const dir of [gitDir, common]) {
      try {
        const h = fs.readFileSync(path.join(dir, ref[1]), 'utf8').trim();
        if (/^[0-9a-f]{7,40}$/i.test(h)) return h.slice(0, 9);
      } catch {
        // try next
      }
    }
    const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      const [hash, name] = line.split(' ');
      if (name === ref[1] && /^[0-9a-f]{7,40}$/i.test(hash)) return hash.slice(0, 9);
    }
  } catch {
    // no checkout
  }
  return '';
}

const NAMED_KEYS: { [k: string]: string } = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Esc',
  esc: 'Esc',
  delete: 'Del',
  backspace: 'Backspace',
  space: 'Space',
  tab: 'Tab',
  plus: '+',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

/** True when Chromium would print the key by name (punctuation, arrows…). */
export function needsTypedShortcut(keystroke: string): boolean {
  const parts = keystroke.split('+');
  const key = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
  return !/^([a-z0-9]|f\d{1,2})$/i.test(key);
}

/** "mod+," → "Ctrl+," (Windows / Linux spelling). */
export function typedShortcut(keystroke: string): string {
  let parts = keystroke.split('+');
  if (parts[parts.length - 1] === '') {
    parts = parts.slice(0, -2).concat(['+']);
  }
  const key = parts.pop() || '';
  const mods = parts.map((m) => {
    const l = m.toLowerCase();
    if (l === 'mod' || l === 'ctrl' || l === 'control' || l === 'cmdorctrl') return 'Ctrl';
    if (l === 'shift') return 'Shift';
    if (l === 'alt' || l === 'option') return 'Alt';
    return m;
  });
  const k = NAMED_KEYS[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
  return mods.concat([k]).join('+');
}

function firstNativeKeystroke(keys: string[] | undefined): string | null {
  const list = (keys || []).filter((k) => !/\b(command|meta|cmd)\b/i.test(k));
  return list[0] || null;
}

function cleanSeparators(items: OfflineMenuItem[]): OfflineMenuItem[] {
  const out: OfflineMenuItem[] = [];
  for (const it of items) {
    if (it.visible === false && it.type !== 'separator') {
      // keep hidden items: the main process toggles some (full screen, updates)
      out.push(it);
      continue;
    }
    if (it.type === 'separator') {
      const lastShown = [...out].reverse().find((x) => x.visible !== false);
      if (!lastShown || lastShown.type === 'separator') continue;
    }
    out.push(it);
  }
  while (out.length) {
    const lastShownIdx = out.map((x) => x.visible !== false).lastIndexOf(true);
    if (lastShownIdx >= 0 && out[lastShownIdx].type === 'separator') {
      out.splice(lastShownIdx, 1);
    } else {
      break;
    }
  }
  return out;
}

export interface OfflineMenuOptions {
  lang: OfflineMenuLang;
  platform: string;
  shortCommit: string;
  developerMenu: boolean;
}

/**
 * Rewrite a (deep-cloned) menu template and keystroke map for offline mode.
 * Returns new objects; inputs are not modified.
 */
export function offlineMenuTemplate(
  template: OfflineMenuItem[],
  keystrokesByCommand: { [command: string]: string[] },
  opts: OfflineMenuOptions
): { template: OfflineMenuItem[]; keystrokes: { [command: string]: string[] } } {
  const keystrokes: { [command: string]: string[] } = { ...(keystrokesByCommand || {}) };
  const L = (pair: [string, string]) => (opts.lang === 'he' ? pair[0] : pair[1]);
  const hidden = new Set(OFFLINE_MENU_HIDDEN_COMMANDS);

  const walk = (items: OfflineMenuItem[]): OfflineMenuItem[] => {
    const out: OfflineMenuItem[] = [];
    for (const src of items) {
      const it: OfflineMenuItem = { ...src };
      if (it.id === 'Developer' && !opts.developerMenu) continue;
      if (it.command && hidden.has(it.command)) continue;
      if (it.label === 'VERSION') {
        it.label = offlineVersionLabel(opts.lang, opts.shortCommit);
        out.push(it);
        continue;
      }
      // Commands with no handler in this window cannot do anything offline.
      if (it.command && it.enabled === false && !/^application:/.test(it.command)) continue;
      if (it.id && MENU_LABELS[it.id]) {
        it.label = L(MENU_LABELS[it.id]);
      }
      if (it.command && OFFLINE_MENU_LABELS[it.command]) {
        it.label = L(OFFLINE_MENU_LABELS[it.command]);
      }
      if (it.command && opts.platform !== 'darwin') {
        const ks = firstNativeKeystroke(keystrokes[it.command]);
        if (ks && needsTypedShortcut(ks)) {
          // Show "Ctrl+," ourselves (isolated so it reads left-to-right in Hebrew).
          it.label = `${it.label}\u2003\u2066${typedShortcut(ks)}\u2069`;
          delete keystrokes[it.command];
        }
      }
      if (it.submenu) {
        it.submenu = cleanSeparators(walk(it.submenu));
        if (!it.submenu.some((x) => x.type !== 'separator' && x.visible !== false)) {
          continue; // nothing left to show
        }
        it.enabled = true;
      }
      out.push(it);
    }
    return out;
  };
  return { template: cleanSeparators(walk(template)), keystrokes };
}
