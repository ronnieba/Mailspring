/**
 * Offline experiment (t243): look & feel helpers. Pure functions only:
 * sender avatars (initials + a stable color, made locally — never fetched),
 * friendly dates, tag colors, text size steps, and "answered" marks worked
 * out from the local copy (a message in Sent that replies to / forwards it).
 */

// ---- Avatars --------------------------------------------------------------

/** 12 colors that read well with white text in light and dark themes. */
export const AVATAR_COLORS = [
  '#1e88e5',
  '#43a047',
  '#e53935',
  '#8e24aa',
  '#fb8c00',
  '#00897b',
  '#3949ab',
  '#d81b60',
  '#6d4c41',
  '#00acc1',
  '#7cb342',
  '#5e35b1',
];

/** FNV-1a: the same sender always gets the same color. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function parseSender(from: string): { name: string; email: string } {
  const f = String(from || '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(f);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  if (/@/.test(f)) return { name: '', email: f.toLowerCase() };
  return { name: f, email: '' };
}

/** Up to two letters: first letters of the first and last words (Hebrew or Latin). */
export function initialsOf(name: string, email = ''): string {
  const words = String(name || '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const first = (w: string) => (w.match(/[\p{L}\p{N}]/u) || [''])[0];
  if (words.length >= 2) return (first(words[0]) + first(words[words.length - 1])).toUpperCase();
  if (words.length === 1) {
    const w = words[0].replace(/[^\p{L}\p{N}]/gu, '');
    return (
      /^[A-Za-z]/.test(w) && w.length > 1 ? w[0] + w[1].toLowerCase() : w[0] || ''
    ).toUpperCase();
  }
  const local = String(email || '')
    .split('@')[0]
    .replace(/[^\p{L}\p{N}]/gu, '');
  return (local[0] || '?').toUpperCase();
}

export function avatarFor(from: string): { initials: string; color: string; key: string } {
  const s = parseSender(from);
  const key = s.email || s.name.toLowerCase() || '?';
  return {
    initials: initialsOf(s.name, s.email),
    color: AVATAR_COLORS[stableHash(key) % AVATAR_COLORS.length],
    key,
  };
}

// ---- Friendly dates ----------------------------------------------------------

const DAY_HE = ['יום א׳', 'יום ב׳', 'יום ג׳', 'יום ד׳', 'יום ה׳', 'יום ו׳', 'שבת'];
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_HE = [
  'ינו׳',
  'פבר׳',
  'מרץ',
  'אפר׳',
  'מאי',
  'יוני',
  'יולי',
  'אוג׳',
  'ספט׳',
  'אוק׳',
  'נוב׳',
  'דצמ׳',
];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * List date: today → "היום 14:05", yesterday → "אתמול", this week → weekday,
 * this year → "12 בנוב׳", older → "12.11.24". Uses local time.
 */
export function friendlyDate(
  ts: number,
  now: number = Date.now(),
  lang: 'he' | 'en' = 'he'
): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const n = new Date(now);
  const days = Math.round((startOfDay(n) - startOfDay(d)) / 86400000);
  const he = lang === 'he';
  if (days === 0) return he ? `היום ${hhmm(d)}` : `Today ${hhmm(d)}`;
  if (days === 1) return he ? 'אתמול' : 'Yesterday';
  if (days > 1 && days < 7) return he ? DAY_HE[d.getDay()] : DAY_EN[d.getDay()];
  if (d.getFullYear() === n.getFullYear() && days >= 0) {
    return he
      ? `${d.getDate()} ב${MON_HE[d.getMonth()]}`
      : `${MON_EN[d.getMonth()]} ${d.getDate()}`;
  }
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  return he
    ? `${d.getDate()}.${d.getMonth() + 1}.${yy}`
    : `${d.getMonth() + 1}/${d.getDate()}/${yy}`;
}

/** Full date for tooltips and the reader: "יום ג׳, 17.11.2026, 14:05". */
export function fullDate(ts: number, lang: 'he' | 'en' = 'he'): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const day = lang === 'he' ? DAY_HE[d.getDay()] : DAY_EN[d.getDay()];
  return lang === 'he'
    ? `${day}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}, ${hhmm(d)}`
    : `${day}, ${MON_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hhmm(d)}`;
}

// ---- Tags ------------------------------------------------------------------

export const TAG_COLORS = [
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#43a047',
  '#00897b',
  '#1e88e5',
  '#5e35b1',
  '#d81b60',
  '#6d4c41',
  '#757575',
];

// ---- Text size -------------------------------------------------------------

export const TEXT_SCALES = [0.9, 1, 1.1, 1.2, 1.35];
export const TEXT_SCALE_CONFIG_KEY = 'offline.textScale';

export function clampTextScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  let best = 1;
  for (const s of TEXT_SCALES) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

export function stepTextScale(cur: number, dir: 1 | -1): number {
  const i = TEXT_SCALES.indexOf(clampTextScale(cur));
  return TEXT_SCALES[Math.max(0, Math.min(TEXT_SCALES.length - 1, i + dir))];
}

// ---- Appearance ------------------------------------------------------------

export type OfflineAppearance = 'light' | 'dark' | 'auto';
export const APPEARANCE_THEMES: { [k in OfflineAppearance]: string } = {
  light: 'ui-light',
  dark: 'ui-dark',
  auto: 'ui-automatic',
};

export function appearanceOfTheme(name: string | null | undefined): OfflineAppearance | null {
  if (name === 'ui-light') return 'light';
  if (name === 'ui-dark') return 'dark';
  if (name === 'ui-automatic') return 'auto';
  return null;
}

// ---- Answered (replied / forwarded) ------------------------------------------

export type AnsweredMark = { replied?: boolean; forwarded?: boolean };

function normId(s: string): string {
  return String(s || '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

/**
 * Messages answered from this mailbox: a message in Sent whose In-Reply-To
 * (reply) or References (forward, subject "Fwd:/FW:/הועבר") points at it.
 * Returns message-id → mark.
 */
export function answeredMarks(
  entries: Array<{
    folder: string;
    subject: string;
    msgId?: string;
    inReplyTo?: string;
    refs?: string;
  }>,
  isSent: (folder: string) => boolean
): Map<string, AnsweredMark> {
  const out = new Map<string, AnsweredMark>();
  for (const e of entries) {
    if (!isSent(e.folder)) continue;
    const fwd = /^\s*(fwd?|fw|הועבר|העבר)\s*:/i.test(e.subject || '');
    const set = (id: string, k: keyof AnsweredMark) => {
      if (!id) return;
      const m = out.get(id) || {};
      m[k] = true;
      out.set(id, m);
    };
    if (fwd) {
      const refs = String(e.refs || '').match(/<[^>]+>/g) || [];
      set(normId(refs.length ? refs[refs.length - 1] : e.inReplyTo || ''), 'forwarded');
    } else if (e.inReplyTo) {
      set(normId(e.inReplyTo), 'replied');
    }
  }
  return out;
}

export function markFor(
  map: Map<string, AnsweredMark>,
  msgId: string | undefined
): AnsweredMark | null {
  return msgId ? map.get(normId(msgId)) || null : null;
}

// ---- Welcome screen ----------------------------------------------------------

export type WelcomeStats = {
  total: number;
  unread: number;
  starred: number;
  withAttachments: number;
  last7: number;
  /** Messages per day, oldest first (last 14 days). */
  perDay: Array<{ day: number; count: number }>;
  topSenders: Array<{ name: string; email: string; count: number }>;
};

export function welcomeStats(
  entries: Array<{ id: string; from: string; ts: number; hasAttachments: boolean }>,
  flags: { unread: (id: string) => boolean; starred: (id: string) => boolean },
  now: number = Date.now(),
  days = 14,
  topN = 5
): WelcomeStats {
  const today = startOfDay(new Date(now));
  const per = new Map<number, number>();
  for (let i = days - 1; i >= 0; i--) per.set(today - i * 86400000, 0);
  const senders = new Map<string, { name: string; email: string; count: number }>();
  let unread = 0;
  let starred = 0;
  let att = 0;
  let last7 = 0;
  const cutoff = today - 6 * 86400000;
  const senderCutoff = today - 365 * 86400000;
  for (const e of entries) {
    if (flags.unread(e.id)) unread++;
    if (flags.starred(e.id)) starred++;
    if (e.hasAttachments) att++;
    if (e.ts) {
      const d = startOfDay(new Date(e.ts));
      if (per.has(d)) per.set(d, (per.get(d) || 0) + 1);
      if (d >= cutoff && d <= today) last7++;
    }
    if (!e.ts || e.ts >= senderCutoff) {
      const s = parseSender(e.from);
      const key = s.email || s.name.toLowerCase();
      if (!key) continue;
      const cur = senders.get(key) || { name: s.name || s.email, email: s.email, count: 0 };
      if (!cur.name && s.name) cur.name = s.name;
      cur.count++;
      senders.set(key, cur);
    }
  }
  return {
    total: entries.length,
    unread,
    starred,
    withAttachments: att,
    last7,
    perDay: Array.from(per.entries()).map(([day, count]) => ({ day, count })),
    topSenders: Array.from(senders.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, topN),
  };
}
