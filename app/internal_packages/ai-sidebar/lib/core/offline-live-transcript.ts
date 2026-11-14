/**
 * Offline experiment (t240): transcript of voice conversations with Gemini.
 * What he said (input transcription), what Gemini said (output
 * transcription) and short app lines ("חיפשתי: …"). Saved only in the
 * offline profile (gemini-live-transcripts.json), last 30 conversations.
 * Nothing here talks to the network.
 */
import fs from 'fs';
import path from 'path';

export const LIVE_TRANSCRIPT_FILE = 'gemini-live-transcripts.json';
export const LIVE_TRANSCRIPT_MAX_CONVERSATIONS = 30;
export const LIVE_TRANSCRIPT_MAX_ITEMS = 500;
/** "Continue": at most this much of the earlier conversation goes back to Gemini. */
export const LIVE_CONTINUE_MAX_CHARS = 3000;
export const LIVE_CONTINUE_MAX_TURNS = 16;

export type LiveWho = 'user' | 'gemini' | 'app';
export type LiveItem = { who: LiveWho; text: string; ts: number; open?: boolean };
export type LiveConversation = {
  id: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  usd: number;
  sessions: number;
  items: LiveItem[];
};
type FileShape = { version: 1; conversations: LiveConversation[] };

export function newConversation(now = Date.now()): LiveConversation {
  return {
    id: `c${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    startedAt: now,
    endedAt: now,
    seconds: 0,
    usd: 0,
    sessions: 0,
    items: [],
  };
}

/**
 * Add a transcription piece. Pieces of the same turn join one bubble; Gemini's
 * pieces sometimes arrive without the space between words, so a space is put
 * between two letters / digits. A bubble closes at turn end or when the other
 * side speaks.
 */
export function addPiece(
  items: LiveItem[],
  who: LiveWho,
  text: string,
  now = Date.now()
): LiveItem[] {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (!t.trim()) return items;
  const last = items[items.length - 1];
  if (who !== 'app' && last && last.who === who && last.open) {
    const glue = /[\p{L}\p{N}]$/u.test(last.text) && /^[\p{L}\p{N}]/u.test(t) ? ' ' : '';
    last.text = (last.text + glue + t).replace(/\s+/g, ' ');
    last.ts = now;
  } else {
    for (const it of items) delete it.open;
    items.push({ who, text: t.trim(), ts: now, ...(who === 'app' ? {} : { open: true }) });
  }
  if (items.length > LIVE_TRANSCRIPT_MAX_ITEMS)
    items.splice(0, items.length - LIVE_TRANSCRIPT_MAX_ITEMS);
  return items;
}

/** Turn finished: the next piece starts a new bubble. */
export function closeTurn(items: LiveItem[]) {
  for (const it of items) delete it.open;
}

export function conversationTitle(c: LiveConversation): string {
  const first = c.items.find((i) => i.who === 'user') || c.items.find((i) => i.who === 'gemini');
  const t = first ? first.text : '';
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/** Plain text for the clipboard (he: "אני" / "Gemini"). */
export function conversationText(
  c: LiveConversation,
  names = { user: 'אני', gemini: 'Gemini' }
): string {
  return c.items
    .filter((i) => !(i.who === 'app' && i.text.startsWith('🔴')))
    .map((i) =>
      i.who === 'app'
        ? `   · ${i.text}`
        : `${i.who === 'user' ? names.user : names.gemini}: ${i.text}`
    )
    .join('\n');
}

/** Recent turns (newest kept) to give Gemini when continuing a conversation. */
export function continueHistory(
  c: LiveConversation
): Array<{ role: 'user' | 'model'; text: string }> {
  const turns = c.items
    .filter((i) => i.who !== 'app' && i.text.trim())
    .map((i) => ({
      role: i.who === 'user' ? ('user' as const) : ('model' as const),
      text: i.text.trim(),
    }));
  const out: Array<{ role: 'user' | 'model'; text: string }> = [];
  let chars = 0;
  for (let k = turns.length - 1; k >= 0 && out.length < LIVE_CONTINUE_MAX_TURNS; k--) {
    const t = turns[k];
    const room = LIVE_CONTINUE_MAX_CHARS - chars;
    if (room <= 40) break;
    const text = t.text.length > room ? `…${t.text.slice(-room)}` : t.text;
    out.unshift({ role: t.role, text });
    chars += text.length;
  }
  // History should start with the user.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function assertInside(file: string, dir: string) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Transcripts must stay inside the offline profile');
  }
}

function clean(c: any): LiveConversation | null {
  if (!c || typeof c.id !== 'string' || !Array.isArray(c.items)) return null;
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const items: LiveItem[] = c.items
    .filter(
      (i: any) => i && ['user', 'gemini', 'app'].includes(i.who) && typeof i.text === 'string'
    )
    .slice(-LIVE_TRANSCRIPT_MAX_ITEMS)
    .map((i: any) => ({ who: i.who, text: i.text, ts: num(i.ts) }));
  return {
    id: c.id,
    startedAt: num(c.startedAt),
    endedAt: num(c.endedAt),
    seconds: num(c.seconds),
    usd: num(c.usd),
    sessions: num(c.sessions),
    items,
  };
}

export function readTranscripts(configDir: string): LiveConversation[] {
  const file = path.join(configDir, LIVE_TRANSCRIPT_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as FileShape;
    const list = Array.isArray(raw && raw.conversations) ? raw.conversations : [];
    return list.map(clean).filter((c): c is LiveConversation => !!c);
  } catch {
    return [];
  }
}

/** Newest first; empty conversations are not kept. */
export function writeTranscripts(configDir: string, list: LiveConversation[]) {
  const file = path.join(configDir, LIVE_TRANSCRIPT_FILE);
  assertInside(file, configDir);
  const keep = list
    .filter((c) => c.items.some((i) => i.who !== 'app'))
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, LIVE_TRANSCRIPT_MAX_CONVERSATIONS)
    .map((c) => ({ ...c, items: c.items.map(({ who, text, ts }) => ({ who, text, ts })) }));
  const data: FileShape = { version: 1, conversations: keep };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}
