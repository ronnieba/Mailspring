/**
 * Offline experiment helpers (pure, unit tested):
 * - rebuild answer citations from the local metadata of messages that were
 *   actually sent (models often return only an id);
 * - answer pure metadata questions (how many messages, date range, how many
 *   senders) locally and exactly, without sending anything to Gemini.
 */
import { Citation, MessageRef } from './types';
import { tr } from './offline-i18n';
import type { GeminiScopeFacts } from '../../../../src/browser/gemini-demo-protocol';

export const OFFLINE_SUMMARY_LABEL = '✨ סיכום הודעה נבחרת';
export const OFFLINE_SUMMARY_LANGUAGE_HINT = ' Write the summary in Hebrew.';
export const OFFLINE_SUMMARY_LABEL_EN = '✨ Summary of the selected message';
export const OFFLINE_SUMMARY_LANGUAGE_HINT_EN = ' Write the summary in English.';

/** Summarize label / language hint for the current offline UI language. */
export function offlineSummaryLabel(): string {
  return tr(OFFLINE_SUMMARY_LABEL, OFFLINE_SUMMARY_LABEL_EN);
}
export function offlineSummaryLanguageHint(): string {
  return tr(OFFLINE_SUMMARY_LANGUAGE_HINT, OFFLINE_SUMMARY_LANGUAGE_HINT_EN);
}

/**
 * Keep only citations whose id is one of the sent messages, fill every field
 * from the local copy, de-duplicate. Missing fields never reject the answer.
 */
export function rebuildCitationsFromSources(raw: unknown, sources: MessageRef[]): Citation[] {
  const byId = new Map(sources.map((m) => [m.id, m]));
  const out: Citation[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const id =
      c && typeof c === 'object' && typeof (c as any).messageId === 'string'
        ? (c as any).messageId
        : typeof c === 'string'
          ? c
          : '';
    const m = byId.get(id);
    if (!m || out.some((x) => x.messageId === m.id)) {
      continue;
    }
    out.push({
      messageId: m.id,
      threadId: m.threadId || m.id,
      subject: m.subject || '(ללא נושא)',
      from: m.from || '(לא ידוע)',
      date: m.date instanceof Date && !Number.isNaN(m.date.getTime()) ? m.date : new Date(0),
      snippet: m.snippet || '',
    });
  }
  return out;
}

export type ScopeMetadataKind = 'count' | 'senders' | 'oldest' | 'newest' | 'range';

const FILLER = new Set([
  // Hebrew
  'יש',
  'כמה',
  'בתיקייה',
  'בתיקיה',
  'תיקייה',
  'תיקיה',
  'הזו',
  'הזאת',
  'הזה',
  'זו',
  'זאת',
  'כאן',
  'פה',
  'בטווח',
  'הטווח',
  'בסך',
  'הכל',
  'הכול',
  'סהכ',
  'סך',
  'נמצאות',
  'נמצאים',
  'שם',
  'בה',
  'בו',
  'בהן',
  'שנבחרו',
  'הנבחרות',
  'הנבחרים',
  'שבחרתי',
  'בעותק',
  'העותק',
  'המקומי',
  'כל',
  'מה',
  'מתי',
  'היה',
  'היא',
  'הוא',
  'של',
  'את',
  'לי',
  'אצלי',
  'בדואר',
  'שלי',
  'סה',
  'כ',
  'ה',
  'תגיד',
  'תאמר',
  'אמור',
  'ספר',
  'בבקשה',
  'מספר',
  'המספר',
  'הוא',
  'תאריך',
  'התאריך',
  'מאיזה',
  'עד',
  'איזה',
  'ביותר',
  'הכי',
  'נשלח',
  'נשלחה',
  'התקבל',
  'התקבלה',
  'הגיע',
  'הגיעה',
  'בכל',
  'ב',
  // English
  'how',
  'many',
  'are',
  'there',
  'is',
  'in',
  'this',
  'that',
  'the',
  'folder',
  'scope',
  'total',
  'of',
  'my',
  'what',
  'when',
  'was',
  'date',
  'do',
  'i',
  'have',
  'selected',
  'here',
  'all',
  'a',
  'number',
  'count',
  'which',
  'please',
  'tell',
  'me',
  'received',
  'sent',
  'mailbox',
  'copy',
  'local',
]);

const MAIL_WORDS =
  /^(ה?מיילים|ה?מייל|ה?הודעות|ה?הודעה|ה?אימיילים|ה?אימייל|ה?דואל|e?-?mails?|messages?|mails?)$/;

const KIND_PATTERNS: Array<{ kind: ScopeMetadataKind; re: RegExp; words: RegExp }> = [
  {
    kind: 'senders',
    re: /(כמה\s+(שולחים|אנשים|כתובות|שולחים\s+שונים))|how many (different |distinct )?(senders|people|addresses)/,
    words:
      /^(שולחים|אנשים|כתובות|שונים|שונות|senders|people|addresses|different|distinct|from|שלחו|מ)$/,
  },
  {
    kind: 'count',
    re: /(כמה\s+(ה?מיילים|ה?הודעות|ה?אימיילים|ה?דואל))|(מספר\s+ה?(מיילים|הודעות))|how many (e-?mails|messages|mails)|number of (e-?mails|messages)|count (the )?(e-?mails|messages)/,
    words: /^$/,
  },
  {
    kind: 'oldest',
    re: /ה?ישן|ה?ישנה|ה?ראשון|ה?ראשונה|ה?מוקדם|ה?מוקדמת|oldest|earliest|first/,
    words: /^(ה?ישן|ה?ישנה|ה?ראשון|ה?ראשונה|ה?מוקדם|ה?מוקדמת|oldest|earliest|first)$/,
  },
  {
    kind: 'newest',
    re: /ה?חדש|ה?חדשה|ה?אחרון|ה?אחרונה|newest|latest|most recent|last/,
    words: /^(ה?חדש|ה?חדשה|ה?אחרון|ה?אחרונה|newest|latest|most|recent|last)$/,
  },
  {
    kind: 'range',
    re: /טווח\s+(ה)?תאריכים|date range|from which date/,
    words: /^(טווח|תאריכים|התאריכים|range|dates|from)$/,
  },
];

function normalize(q: string): string {
  return String(q || '')
    .toLowerCase()
    .replace(/[״"׳'`?!.,:;()[\]{}\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A question that is ONLY about scope metadata; anything else returns null. */
export function classifyScopeMetadataQuestion(query: string): ScopeMetadataKind | null {
  const q = normalize(query);
  if (!q || q.length > 120) {
    return null;
  }
  for (const p of KIND_PATTERNS) {
    if (!p.re.test(q)) {
      continue;
    }
    const rest = q
      .split(' ')
      .filter((w) => w && !FILLER.has(w) && !MAIL_WORDS.test(w) && !p.words.test(w));
    // "Oldest/newest" is metadata only when the question asks WHEN / which
    // date; "what is the latest email" is about content and goes to Gemini.
    const asksDate = /(^| )(מתי|תאריך|התאריך|when|date)( |$)/.test(q);
    if (rest.length === 0 && ((p.kind !== 'oldest' && p.kind !== 'newest') || asksDate)) {
      return p.kind;
    }
    return null;
  }
  return null;
}

function fmtDate(iso: string | null): string {
  if (!iso) {
    return tr('לא ידוע', 'unknown');
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return tr('לא ידוע', 'unknown');
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function scopePhrase(f: GeminiScopeFacts): string {
  return f.scopeKind === 'selected'
    ? tr('בהודעות שנבחרו', 'In the selected messages')
    : f.scopeKind === 'folder'
      ? tr(
          `בתיקייה הזו${f.includesSubfolders ? ' (כולל תת-תיקיות)' : ' (בלי תת-תיקיות)'}`,
          `In this folder${f.includesSubfolders ? ' (including subfolders)' : ' (without subfolders)'}`
        )
      : f.scopeKind === 'search'
        ? tr('בתוצאות החיפוש המקומי', 'In the local search results')
        : tr('בכל העותק המקומי', 'In the whole local copy');
}

export const LOCAL_ANSWER_FOOTER =
  '📊 נענה מקומית מנתוני הטווח, בלי Gemini - לא נשלח דבר ולא עלה כסף.';
export const LOCAL_ANSWER_FOOTER_EN =
  '📊 Answered locally from the range data, without Gemini - nothing was sent and it cost nothing.';

/** Exact local answer for a pure metadata question, or null. */
export function answerScopeMetadataLocally(query: string, f: GeminiScopeFacts): string | null {
  const kind = classifyScopeMetadataQuestion(query);
  if (!kind) {
    return null;
  }
  const where = scopePhrase(f);
  const range =
    f.totalInScope > 0
      ? tr(
          `טווח תאריכים: ${fmtDate(f.oldest)} – ${fmtDate(f.newest)}.`,
          `Date range: ${fmtDate(f.oldest)} – ${fmtDate(f.newest)}.`
        )
      : '';
  const total = f.totalInScope.toLocaleString();
  const none = tr(`${where} אין הודעות.`, `${where} there are no messages.`);
  let text: string;
  switch (kind) {
    case 'count':
      text = tr(
        `${where} יש ${total} הודעות. ${range}`,
        `${where} there are ${total} messages. ${range}`
      );
      break;
    case 'senders':
      text = tr(
        `${where} יש ${f.distinctSenders.toLocaleString()} שולחים שונים, ב-${total} הודעות.`,
        `${where} there are ${f.distinctSenders.toLocaleString()} different senders, in ${total} messages.`
      );
      break;
    case 'oldest':
      text = f.totalInScope
        ? tr(
            `ההודעה הישנה ביותר ${where} היא מתאריך ${fmtDate(f.oldest)}.`,
            `${where}, the oldest message is from ${fmtDate(f.oldest)}.`
          )
        : none;
      break;
    case 'newest':
      text = f.totalInScope
        ? tr(
            `ההודעה החדשה ביותר ${where} היא מתאריך ${fmtDate(f.newest)}.`,
            `${where}, the newest message is from ${fmtDate(f.newest)}.`
          )
        : none;
      break;
    default:
      text = f.totalInScope
        ? tr(`${where}: ${total} הודעות. ${range}`, `${where}: ${total} messages. ${range}`)
        : none;
  }
  return `${text.trim()}\n\n---\n${tr(LOCAL_ANSWER_FOOTER, LOCAL_ANSWER_FOOTER_EN)}`;
}
