/**
 * Offline experiment: choose which local messages go to Gemini for a "Send"
 * question over a scope (selected / folder / whole copy), and clean them.
 *
 * Local retrieval first (no network): rank every message in scope by query
 * terms in subject/sender, read bodies only for the best header candidates,
 * then send a bounded set of the most relevant ones. Attachments are never
 * read or sent. Pure functions so they can be unit tested.
 */

/** Hard caps for one Send. The host enforces the same caps again. */
export const GEMINI_SCOPED_MAX_MESSAGES = 30;
export const GEMINI_SCOPED_MAX_TOTAL_CHARS = 60000;
export const GEMINI_SCOPED_MAX_BODY_CHARS = 2500;
/** How many header-ranked candidates get their body read locally. */
export const GEMINI_SCOPED_BODY_SCAN = 150;
/** Rough upper bound per Send, from public list prices (not a bill). */
export const GEMINI_SCOPED_COST_NOTE = '≈ $0.01';

const STOPWORDS = new Set([
  // Hebrew
  'של',
  'את',
  'על',
  'עם',
  'זה',
  'זו',
  'זאת',
  'אני',
  'אתה',
  'הוא',
  'היא',
  'הם',
  'הן',
  'מה',
  'מי',
  'איך',
  'למה',
  'מתי',
  'איפה',
  'כל',
  'גם',
  'או',
  'אם',
  'לא',
  'כן',
  'יש',
  'אין',
  'היה',
  'היו',
  'שלי',
  'שלך',
  'לי',
  'לך',
  'אותי',
  'אותו',
  'הזה',
  'הזאת',
  'האלה',
  'אלה',
  'בין',
  'אחרי',
  'לפני',
  'עוד',
  'רק',
  'כמה',
  'תן',
  'תסכם',
  'סכם',
  'תמצא',
  'מצא',
  'חפש',
  'תחפש',
  'הודעה',
  'הודעות',
  'מייל',
  'מיילים',
  'דואר',
  'ההודעות',
  'המיילים',
  'בבקשה',
  'אפשר',
  'תגיד',
  'תראה',
  'הראה',
  'יותר',
  'פחות',
  'שהוא',
  'שהיא',
  'כדי',
  'אבל',
  'אז',
  // English
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'it',
  'this',
  'that',
  'these',
  'those',
  'what',
  'who',
  'how',
  'why',
  'when',
  'where',
  'which',
  'my',
  'me',
  'i',
  'you',
  'all',
  'any',
  'from',
  'about',
  'please',
  'find',
  'show',
  'summarize',
  'summarise',
  'email',
  'emails',
  'mail',
  'message',
  'messages',
  'do',
  'did',
  'does',
  'have',
  'has',
  'can',
  'there',
]);

const HEBREW_PREFIXES = ['וה', 'שה', 'כשה', 'מה', 'לה', 'בה', 'ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ'];

function isHebrew(word: string): boolean {
  return /[\u0590-\u05FF]/.test(word);
}

/** Query terms (lowercased), with Hebrew one/two-letter prefixes stripped as variants. */
export function geminiQueryTerms(query: string): string[] {
  const words = (query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.]+/u)
    .map((w) => w.replace(/^[.@]+|[.@]+$/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    if (isHebrew(w)) {
      for (const p of HEBREW_PREFIXES) {
        if (w.startsWith(p) && w.length - p.length >= 3) {
          const base = w.slice(p.length);
          if (!STOPWORDS.has(base)) {
            out.add(base);
          }
        }
      }
      // Plural/feminine endings: חשבוניות -> חשבונית, פגישות -> פגישה-ish stem.
      if (w.length >= 5 && /(ות|ים)$/.test(w)) {
        out.add(w.slice(0, -2));
      }
    } else if (w.length >= 5 && w.endsWith('s')) {
      out.add(w.slice(0, -1));
    }
  }
  return [...out];
}

function countHits(hay: string, terms: string[], cap: number): number {
  let n = 0;
  for (const t of terms) {
    let i = hay.indexOf(t);
    let local = 0;
    while (i !== -1 && local < cap) {
      local++;
      i = hay.indexOf(t, i + t.length);
    }
    n += local;
  }
  return n;
}

export function headerScore(subject: string, from: string, terms: string[]): number {
  if (!terms.length) {
    return 0;
  }
  return (
    countHits((subject || '').toLowerCase(), terms, 3) * 3 +
    countHits((from || '').toLowerCase(), terms, 2) * 2
  );
}

export function bodyScore(body: string, terms: string[]): number {
  if (!terms.length || !body) {
    return 0;
  }
  return countHits(body.toLowerCase(), terms, 5);
}

const QUOTE_CUTS: RegExp[] = [
  /^-{2,}\s*original message\s*-{2,}/im,
  /^-{2,}\s*הודעה מקורית\s*-{2,}/im,
  /^on .{3,200}wrote:\s*$/im,
  /^ב[-־]?.{3,200}כתב(?:\/ה|ה)?:\s*$/im,
  /^from:\s.+\n(?:sent|date):\s/im,
  /^מאת:\s.+\n(?:נשלח|תאריך):\s/im,
];

/** Plain text fit for the model: no quoted history, no long links, no markup, trimmed. */
export function cleanBodyForGemini(text: string, maxChars = GEMINI_SCOPED_MAX_BODY_CHARS): string {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  for (const re of QUOTE_CUTS) {
    const m = re.exec(s);
    if (m && m.index > 40) {
      s = s.slice(0, m.index);
    }
  }
  s = s
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]{1,400}>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/https?:\/\/\S{30,}/gi, '[link]')
    .replace(/\S{120,}/g, '[…]')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  if (s.length > maxChars) {
    s = `${s.slice(0, maxChars).trimEnd()} …`;
  }
  return s;
}

export interface ScopedCandidate {
  id: string;
  subject: string;
  from: string;
  ts: number;
}

export interface ScopedPlan<T extends ScopedCandidate> {
  /** Header-ranked candidates whose bodies should be read locally. */
  toScan: T[];
  terms: string[];
}

/** Step 1: rank by headers (cheap, whole scope); pick which bodies to read. */
export function planScopedRetrieval<T extends ScopedCandidate>(
  rows: T[],
  query: string,
  scanLimit = GEMINI_SCOPED_BODY_SCAN
): ScopedPlan<T> {
  const terms = geminiQueryTerms(query);
  const ranked = rows
    .map((r) => ({ r, s: headerScore(r.subject, r.from, terms) }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : b.r.ts - a.r.ts));
  return { toScan: ranked.slice(0, scanLimit).map((x) => x.r), terms };
}

export interface ScannedCandidate extends ScopedCandidate {
  body: string;
}

export interface ScopedSelection<T extends ScannedCandidate> {
  chosen: Array<T & { cleanBody: string; score: number }>;
  matched: number;
  totalChars: number;
}

/** Step 2: score with bodies, then fill the message/char budget by relevance. */
export function selectScopedForGemini<T extends ScannedCandidate>(
  scanned: T[],
  terms: string[],
  opts: { maxMessages?: number; maxTotalChars?: number; maxBodyChars?: number } = {}
): ScopedSelection<T> {
  const maxMessages = opts.maxMessages ?? GEMINI_SCOPED_MAX_MESSAGES;
  const maxTotal = opts.maxTotalChars ?? GEMINI_SCOPED_MAX_TOTAL_CHARS;
  const maxBody = opts.maxBodyChars ?? GEMINI_SCOPED_MAX_BODY_CHARS;
  const scored = scanned.map((m) => ({
    m,
    score: headerScore(m.subject, m.from, terms) * 2 + bodyScore(m.body, terms),
  }));
  const matched = scored.filter((x) => x.score > 0).length;
  // With keyword hits, send only hits. Without any (e.g. "summarize this
  // folder"), send the newest messages instead.
  const pool = matched > 0 ? scored.filter((x) => x.score > 0) : scored;
  pool.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.m.ts - a.m.ts));
  const chosen: Array<T & { cleanBody: string; score: number }> = [];
  let total = 0;
  for (const { m, score } of pool) {
    if (chosen.length >= maxMessages) {
      break;
    }
    const cleanBody = cleanBodyForGemini(m.body, maxBody);
    const cost = cleanBody.length + (m.subject || '').length + (m.from || '').length + 80;
    if (total + cost > maxTotal) {
      if (chosen.length === 0) {
        const fit = Math.max(200, maxTotal - 400);
        chosen.push({ ...m, cleanBody: cleanBodyForGemini(m.body, fit), score });
        total += fit;
      }
      break;
    }
    chosen.push({ ...m, cleanBody, score });
    total += cost;
  }
  return { chosen, matched, totalChars: total };
}

/** Upper bound shown before sending. */
export function estimateGeminiSendCount(scopeCount: number): number {
  return Math.max(0, Math.min(scopeCount, GEMINI_SCOPED_MAX_MESSAGES));
}
