/**
 * Offline experiment: "Ask about my mail" (search + AI).
 * A natural-language question is first turned into a local full-text search
 * (question words removed, the rest OR-ed); only the text of the top results,
 * capped, is sent to Gemini, and only when the user clicks. Pure helpers here.
 */

import { isSearchOperatorKey } from './offline-search';

/** Most messages whose text is sent for one question. */
export const QA_MAX_MESSAGES = 12;
/** Longest text per message sent. */
export const QA_MAX_BODY_CHARS = 2500;
/** Total text sent for one question. */
export const QA_MAX_TOTAL_CHARS = 30000;
/** Most search terms used. */
export const QA_MAX_TERMS = 8;

const STOP = new Set(
  // Hebrew question / function words
  (
    'מה מי מתי איפה היכן איך כיצד למה מדוע האם כמה איזה איזו אילו של על את עם אל מן מ ב ל ה ו ש כי אם או גם רק כל זה זו זאת אלה הם הן הוא היא אני אתה את אנחנו לי לו לה לנו להם יש אין היה היו הייתה יהיה שלי שלך שלו שלה שלנו שלהם אמר אמרה אמרו כתב כתבה כתבו שלח שלחה שלחו בבקשה תגיד תגידי תמצא תמצאי תראה הראה מצא ספר ספרי לגבי בנוגע אודות בעניין עוד כבר מאוד הרבה פעם פעמים ' +
    'מישהו משהו שום דבר דברים אותי אותו אותה אותם לפני אחרי מול בין דרך אצל כמו יותר פחות האחרון האחרונה אחרון אחרונה ' +
    // English
    'what who whom whose when where why how which is are was were be been being do does did done have has had the a an of on in at to for from by with about and or not no my me i you your our we us they them their it its this that these those any some all did can could would should will shall may might please tell told say said wrote write sent send show find give list last latest ever there here than then also just only more most mail mails email emails message messages'
  ).split(/\s+/)
);

function words(s: string): string[] {
  return (
    s
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’@._-]*/gu) || []
  ).map((w) => w.replace(/[._-]+$/, ''));
}

/** Hebrew word without one or two prefix letters (ה ו ב ל מ ש כ), if long enough. */
function hebrewBase(w: string): string | null {
  if (!/^[\u0590-\u05FF]+$/.test(w) || w.length < 4) return null;
  const m = /^[הובלמשכ]{1,2}(.{3,})$/.exec(w);
  return m && !STOP.has(m[1]) ? m[1] : null;
}

export type QaSearch = { query: string; terms: string[] };

/**
 * Question → local search query. Quoted phrases are kept as phrases;
 * explicit search operators (from: has: after: …) are passed through.
 */
export function questionToSearchQuery(question: string): QaSearch {
  const q = String(question || '').slice(0, 500);
  const phrases: string[] = [];
  const ops: string[] = [];
  let rest = q.replace(/"([^"]{2,80})"|“([^”]{2,80})”/g, (_m, a, b) => {
    phrases.push(`"${(a || b).replace(/"/g, '')}"`);
    return ' ';
  });
  rest = rest.replace(/(^|\s)(-?)([^\s:"]+):(\S+)/g, (m, sp, _neg, key) => {
    if (!isSearchOperatorKey(key)) return m;
    ops.push(m.trim());
    return sp + ' ';
  });
  const terms: string[] = [];
  for (const w of words(rest)) {
    if (w.length < 2 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    // Keep the word as written; for Hebrew also try it without prefix letters
    // (מהספק → ספק). The search is OR-ed, so an extra form only widens it.
    for (const t of [w, hebrewBase(w)]) {
      if (t && !STOP.has(t) && !terms.includes(t) && terms.length < QA_MAX_TERMS) terms.push(t);
    }
    if (terms.length >= QA_MAX_TERMS) break;
  }
  const textParts = [...phrases, ...terms];
  const query = [textParts.join(' OR '), ...ops].filter(Boolean).join(' ').trim();
  return { query, terms: [...phrases.map((p) => p.replace(/"/g, '')), ...terms] };
}

/** Keep the search ranking; cap per-message and total text. */
export function capForQa<T extends { body: string }>(
  ranked: T[],
  opts: { maxMessages?: number; maxBodyChars?: number; maxTotalChars?: number } = {}
): Array<T & { cleanBody: string }> {
  const maxMessages = opts.maxMessages ?? QA_MAX_MESSAGES;
  const maxBody = opts.maxBodyChars ?? QA_MAX_BODY_CHARS;
  const maxTotal = opts.maxTotalChars ?? QA_MAX_TOTAL_CHARS;
  const out: Array<T & { cleanBody: string }> = [];
  let total = 0;
  for (const r of ranked) {
    if (out.length >= maxMessages) break;
    const body = r.body.slice(0, maxBody);
    if (total + body.length > maxTotal && out.length) break;
    total += body.length;
    out.push({ ...r, cleanBody: body });
  }
  return out;
}
