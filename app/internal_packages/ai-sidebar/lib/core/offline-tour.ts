/**
 * Offline experiment (t235): the interactive guide ("מדריך אינטראקטיבי") with
 * the Mail AI mascot. Pure parts: tour steps, contextual tips, the remembered
 * prefs (offline profile only) and where a bubble goes next to its target.
 * No network; nothing here reads mail.
 */
import fs from 'fs';
import path from 'path';

export const OFFLINE_TOUR_FILE = 'offline-tour.json';
export const MASCOT_NAME: [string, string] = ['מיילי', 'Maily'];

export type TourRibbonTab = 'home' | 'view' | 'drafts' | 'ai' | 'settings';

export type TourStep = {
  id: string;
  /** First visible match is spotlighted; none = centered bubble. */
  targets: string[];
  /** Ribbon tab to show first. */
  tab?: TourRibbonTab;
  title: [string, string];
  body: [string, string];
  /** Shown when no target is on screen. */
  missing?: [string, string];
  mood?: MascotMood;
};

export type MascotMood = 'wave' | 'happy' | 'think' | 'wink';

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    targets: [],
    mood: 'wave',
    title: ['היי, אני מיילי! ✨', "Hi, I'm Maily! ✨"],
    body: [
      'אני אראה לכם בקצרה איך עובדים עם Mail AI. הכל כאן עובד על עותק מקומי של הדואר: שום דבר לא נשלח ו-Yahoo לא משתנה. אפשר לדלג בכל רגע.',
      'A quick look at how Mail AI works. Everything here works on a local copy of your mail: nothing is sent and Yahoo never changes. You can skip any time.',
    ],
  },
  {
    id: 'ribbon',
    targets: ['[data-offline-ribbon]'],
    tab: 'home',
    title: ['הסרגל העליון', 'The ribbon'],
    body: [
      'כמו ב-Outlook: לשוניות (בית, תצוגה, טיוטות, AI, עזרה והגדרות) ובכל אחת כפתורים. לחיצה כפולה על לשונית מסתירה את הסרגל.',
      'Like Outlook: tabs (Home, View, Drafts, AI, Help & settings), each with its buttons. Double-click a tab to hide the ribbon.',
    ],
  },
  {
    id: 'folders',
    targets: ['[data-offline-folder-sidebar]'],
    title: ['התיקיות', 'Folders'],
    body: [
      'כל התיקיות מהעותק המקומי, עם מספר ההודעות. למטה גם התיקיות המקומיות: אשפה, ארכיון וספאם (רק במחשב הזה).',
      'All folders of the local copy with their counts. Below them the local folders: Trash, Archive and Spam (this computer only).',
    ],
  },
  {
    id: 'list',
    targets: ['[data-offline-message-list]'],
    title: ['רשימת ההודעות', 'The message list'],
    body: [
      'לחיצה פותחת הודעה; Ctrl/Shift לבחירה של כמה. בלשונית "תצוגה" אפשר לקבץ לשיחות, למיין ולשנות צפיפות.',
      'Click to open a message; Ctrl/Shift to pick several. The View tab groups conversations, sorts and changes density.',
    ],
  },
  {
    id: 'search',
    targets: ['[data-offline-search-bar]'],
    title: ['חיפוש', 'Search'],
    body: [
      'הקלידו מילים — חיפוש מקומי מהיר בנושא, שולח, תוכן ושמות קבצים, ושום דבר לא נשלח. כתבו שאלה — הכפתור "🤖 שאל AI" יידלק, ולחיצה עליו מביאה תשובה בחלונית ה-AI עם מקורות. נשלח רק בלחיצה.',
      'Type words — a fast local search in subject, sender, text and file names; nothing is sent. Type a question — the "🤖 Ask AI" button lights up, and clicking it brings an answer in the AI panel with sources. Sent only on click.',
    ],
  },
  {
    id: 'ai-panel',
    targets: ['.ai-sidebar', '[data-offline-ribbon-tab="ai"]'],
    tab: 'ai',
    mood: 'think',
    title: ['עוזר ה-AI', 'The AI assistant'],
    body: [
      'שאלו על הודעות שנבחרו, על תיקייה או על כל העותק. נשלח ל-Gemini רק טקסט, ורק כשלוחצים "שלח". הלוגו בפינה פותח וסוגר את החלונית.',
      'Ask about selected messages, a folder or the whole copy. Only text goes to Gemini, and only when you click "Send". The logo in the corner opens and closes the panel.',
    ],
  },
  {
    id: 'write-ai',
    targets: ['[data-offline-ribbon-btn="ai-write"]'],
    tab: 'ai',
    title: ['כתוב עם AI', 'Write with AI'],
    body: [
      'כתבו הוראה ("תשובה מנומסת שאני מסכים") וה-AI יכתוב את הטיוטה. אפשר לבקש תיקונים, וכל שינוי ניתן לביטול.',
      'Type an instruction ("a polite reply saying I agree") and the AI writes the draft. Ask for changes; every change can be undone.',
    ],
  },
  {
    id: 'drafts',
    targets: ['[data-offline-ribbon="drafts"]', '[data-offline-ribbon-tab="drafts"]'],
    tab: 'drafts',
    title: ['טיוטות', 'Drafts'],
    body: [
      'טיוטה חדשה, תשובה או העברה נשמרות רק במחשב (אין שליחה). יש עיצוב טקסט, בדיקת איות, קבצים מצורפים ו"צרף את הקבצים המקוריים" בתשובה.',
      'New drafts, replies and forwards stay on this computer (no sending). Text formatting, spell check, attachments and "Attach the original files" in a reply.',
    ],
  },
  {
    id: 'actions',
    targets: ['[data-offline-ribbon-group="actions"]', '[data-offline-ribbon-group="select"]'],
    tab: 'home',
    title: ['פעולות מקומיות', 'Local actions'],
    body: [
      'מחק, ארכיון, העבר, ספאם, כוכב, לא נקרא, חסום שולח, הדפס ו"שמור בשם" (PDF או eml). הכל מקומי, עם "בטל" מיד אחרי.',
      'Delete, archive, move, spam, star, unread, block sender, print and "Save as" (PDF or .eml). All local, with Undo right after.',
    ],
    missing: ['(בחרו הודעה כדי לראות את הכפתורים)', '(select a message to see these buttons)'],
  },
  {
    id: 'viewer',
    targets: ['[data-offline-attachments]', '.offline-reader'],
    title: ['צפייה בקבצים מצורפים', 'Attachment viewer'],
    body: [
      'PDF, תמונות, Word, Excel, מצגות PowerPoint, טקסט והודעות eml נפתחים כאן בתוך האפליקציה, בלי אינטרנט. אפשר גם לשמור או לפתוח בתוכנה אחרת.',
      'PDF, pictures, Word, Excel, PowerPoint slides, text and .eml files open right here, offline. You can also save them or open them in another app.',
    ],
  },
  {
    id: 'rules',
    targets: ['[data-offline-ribbon-btn="rules"]'],
    tab: 'home',
    title: ['כללים', 'Rules'],
    body: [
      'כמו ב-Outlook: "כל מה שמגיע מ... — העבר לתיקייה / כוכב / מחק / חסום". פועל על הדואר הקיים בלחיצה ועל דואר חדש כשהוא נטען. אפשר לבטל.',
      'Like Outlook: "everything from ... — move / star / delete / block". Runs on existing mail when you click and on new mail as it loads. Undoable.',
    ],
  },
  {
    id: 'reset',
    targets: ['[data-offline-ribbon-btn="reset-local"]'],
    tab: 'settings',
    title: ['איפוס', 'Reset'],
    body: [
      'כל השינויים המקומיים (העברות, כוכבים, חסימות, כללים) נשמרים רק כאן. "אפס את כל השינויים המקומיים" מחזיר הכל למצב המקורי.',
      'All local changes (moves, stars, blocks, rules) live only here. "Reset all local changes" puts everything back as it was.',
    ],
  },
  {
    id: 'done',
    targets: ['[data-offline-ribbon-btn="interactive-tour"]'],
    tab: 'settings',
    mood: 'happy',
    title: ['זהו! 🎉', "That's it! 🎉"],
    body: [
      'אפשר לחזור לסיור בכל זמן מ"עזרה והגדרות" ← "מדריך אינטראקטיבי". ובמקומות רבים יש "?" קטן עם טיפ.',
      'Replay the tour any time from "Help & settings" → "Interactive guide". Many places also have a small "?" with a tip.',
    ],
  },
];

export const TOUR_TIPS: { [id: string]: [string, string] } = {
  search: [
    'מילים = חיפוש מקומי בלבד. שאלה (למשל "מתי הפגישה עם דנה?") + לחיצה על "🤖 שאל AI" = התשובה מגיעה בחלונית ה-AI עם מקורות; נשלחים רק השאלה ועד 12 הודעות מתאימות (טקסט), ורק בלחיצה. מסננים: מאת:, אל:, נושא:, קובץ:, יש:צרופות, אחרי:2024-01-01, לפני:, תיקייה:, "ביטוי מדויק", -מילה.',
    'Words = local search only. A question (e.g. "When is the meeting with Dana?") + clicking "🤖 Ask AI" = the answer appears in the AI panel with sources; only the question and up to 12 matching messages (text) are sent, and only on click. Filters: from:, to:, subject:, file:, has:attachment, after:2024-01-01, before:, folder:, "exact phrase", -word.',
  ],
  ai: [
    'בחרו על מה לשאול (נבחרות / תיקייה / כל העותק / טיוטה), כתבו שאלה ולחצו "שלח". "🔎 חפש ושאל" מחפש קודם בכל הדואר. רק טקסט נשלח, ורק בלחיצה.',
    'Choose what to ask about (selected / folder / whole copy / draft), type and click "Send". "🔎 Search & ask" searches all mail first. Only text is sent, only on click.',
  ],
  rules: [
    'כלל = תנאים + פעולה. "הפעל עכשיו" על הדואר הקיים; כללים פעילים פועלים גם על דואר חדש. "בטל הפעלה אחרונה" מחזיר.',
    'A rule = conditions + one action. "Run now" for mail already here; enabled rules also act on new mail. "Undo last run" puts it back.',
  ],
  export: [
    'PDF לקריאה והדפסה; eml שומר את ההודעה המקורית (שיחה = קובץ אחד עם כל ההודעות). אתם בוחרים איפה לשמור.',
    'PDF to read and print; .eml keeps the original message (a conversation = one file with every message). You choose where to save.',
  ],
};

export type TourPrefs = {
  /** The tour was finished or skipped at least once. */
  done: boolean;
  /** First-run prompt: never show again. */
  promptNever: boolean;
  /** Small "?" tips on screen. */
  tips: boolean;
};

export const DEFAULT_TOUR_PREFS: TourPrefs = { done: false, promptNever: false, tips: true };

export function readTourPrefs(configDir: string | null): TourPrefs {
  if (!configDir) return { ...DEFAULT_TOUR_PREFS };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, OFFLINE_TOUR_FILE), 'utf8'));
    return {
      done: raw?.done === true,
      promptNever: raw?.promptNever === true,
      tips: raw?.tips !== false,
    };
  } catch {
    return { ...DEFAULT_TOUR_PREFS };
  }
}

export function writeTourPrefs(configDir: string | null, prefs: TourPrefs): void {
  if (!configDir) return;
  const file = path.join(configDir, OFFLINE_TOUR_FILE);
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        done: !!prefs.done,
        promptNever: !!prefs.promptNever,
        tips: prefs.tips !== false,
      })
    );
    fs.renameSync(tmp, file);
  } catch {
    console.warn('[Offline tour] could not save');
  }
}

/** Show the first-run invitation? */
export function shouldOfferTour(p: TourPrefs): boolean {
  return !p.done && !p.promptNever;
}

export type Rect = { left: number; top: number; width: number; height: number };
export type BubblePlace = {
  left: number;
  top: number;
  side: 'below' | 'above' | 'start' | 'end' | 'center';
};

/**
 * Where the bubble goes: below the target if it fits, else above, else
 * beside it, else centered; always inside the window.
 */
export function placeBubble(
  target: Rect | null,
  bubble: { width: number; height: number },
  view: { width: number; height: number },
  gap = 14,
  margin = 10
): BubblePlace {
  const clampX = (x: number) => Math.max(margin, Math.min(view.width - bubble.width - margin, x));
  const clampY = (y: number) => Math.max(margin, Math.min(view.height - bubble.height - margin, y));
  if (!target) {
    return {
      left: clampX((view.width - bubble.width) / 2),
      top: clampY((view.height - bubble.height) / 2),
      side: 'center',
    };
  }
  const cx = target.left + target.width / 2 - bubble.width / 2;
  const below = target.top + target.height + gap;
  if (below + bubble.height + margin <= view.height) {
    return { left: clampX(cx), top: below, side: 'below' };
  }
  const above = target.top - gap - bubble.height;
  if (above >= margin) {
    return { left: clampX(cx), top: above, side: 'above' };
  }
  const cy = clampY(target.top + target.height / 2 - bubble.height / 2);
  const end = target.left + target.width + gap;
  if (end + bubble.width + margin <= view.width) {
    return { left: end, top: cy, side: 'end' };
  }
  const start = target.left - gap - bubble.width;
  if (start >= margin) {
    return { left: start, top: cy, side: 'start' };
  }
  // Target fills the window: float the bubble inside it, near the bottom.
  return {
    left: clampX(cx),
    top: clampY(view.height - bubble.height - margin * 3),
    side: 'center',
  };
}
