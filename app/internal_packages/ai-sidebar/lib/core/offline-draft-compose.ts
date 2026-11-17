/**
 * "Write with AI" (כתוב עם AI) for local drafts. Pure helpers: deciding when
 * the mode is on, building the one outgoing request, cleaning the model's
 * answer and deciding whether the subject may change. No IO here.
 *
 * What may leave the app (only on an explicit click): the user's instruction,
 * the draft's own text (never the quoted tail), the subject only when ticked,
 * and for a reply / forward the original message (or the conversation) as
 * plain text with header lines. Never attachments, never recipients of the
 * draft, never HTML.
 */
import {
  DRAFT_ASSIST_MAX_CHARS,
  DRAFT_ASSIST_MAX_REQUEST_CHARS,
  DRAFT_ASSIST_MAX_SUBJECT_CHARS,
  cleanRewrite,
  splitDraftForAssist,
} from './offline-draft-assist';

export type ComposeKind = 'new' | 'reply' | 'forward';

/** A draft whose own text is at most this long opens in write mode. */
export const COMPOSE_NEAR_EMPTY_CHARS = 20;
/** Whole context sent with a reply / forward (matches the main-process limit). */
export const COMPOSE_MAX_CONTEXT_CHARS = 24000;
/** The message being answered. */
export const COMPOSE_MAX_ORIGINAL_CHARS = 12000;
/** Each earlier message of the conversation. */
export const COMPOSE_MAX_THREAD_MESSAGE_CHARS = 4000;
/** Conversation: at most this many messages (the newest ones). */
export const COMPOSE_MAX_THREAD_MESSAGES = 10;
export const COMPOSE_MAX_SUBJECT_CHARS = 200;

export interface ComposeSourceMessage {
  from: string;
  date: string;
  subject: string;
  /** Plain text of the message (attachments are never part of it). */
  text: string;
}

export function draftOwnText(body: string): string {
  return splitDraftForAssist(typeof body === 'string' ? body : '').own;
}

/** Empty or nearly empty (quote not counted): write mode is the natural default. */
export function isNearEmptyDraft(body: string): boolean {
  return draftOwnText(body).replace(/\s+/g, ' ').trim().length <= COMPOSE_NEAR_EMPTY_CHARS;
}

function cap(text: string, max: number): { text: string; cut: boolean } {
  const t = text.replace(/\s+$/, '');
  if (t.length <= max) {
    return { text: t, cut: false };
  }
  // Cut at a line break near the limit when there is one.
  const slice = t.slice(0, max);
  const nl = slice.lastIndexOf('\n');
  return { text: `${nl > max * 0.7 ? slice.slice(0, nl) : slice}\n[…]`, cut: true };
}

/**
 * The message's own words: quoted history ("> …" lines, "On … wrote:",
 * forwarded headers) is dropped so a long conversation stays small. Falls
 * back to the text without "> …" lines when nothing else is left.
 */
export function messageOwnText(text: string): string {
  const t = (text || '').replace(/\r\n/g, '\n');
  const own = splitDraftForAssist(t).own;
  if (own.trim()) {
    return own.replace(/\n{3,}/g, '\n\n').trim();
  }
  return t
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function block(m: ComposeSourceMessage, label: string, max: number) {
  const body = cap(messageOwnText(m.text), max);
  const head = [
    label,
    `From: ${oneLine(m.from)}`,
    `Date: ${oneLine(m.date)}`,
    `Subject: ${oneLine(m.subject)}`,
  ].join('\n');
  return { text: `${head}\n\n${body.text}`, cut: body.cut };
}

function oneLine(s: string): string {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
}

export interface ComposeContext {
  text: string;
  /** Messages included. */
  messages: number;
  /** Something was shortened or older messages were left out. */
  truncated: boolean;
}

/**
 * Context for a reply / forward. `thread` (oldest first, including the
 * target) is used only when the user ticked "include the whole conversation".
 */
export function buildComposeContext(
  target: ComposeSourceMessage,
  thread?: ComposeSourceMessage[] | null
): ComposeContext {
  const main = block(target, '[THE MESSAGE BEING ANSWERED]', COMPOSE_MAX_ORIGINAL_CHARS);
  if (!thread || thread.length < 2) {
    return { text: main.text, messages: 1, truncated: main.cut };
  }
  const idx = thread.indexOf(target);
  const before = (idx >= 0 ? thread.slice(0, idx) : thread.filter((m) => m !== target)).slice(
    -(COMPOSE_MAX_THREAD_MESSAGES - 1)
  );
  let truncated = main.cut || before.length < (idx >= 0 ? idx : thread.length - 1);
  // Newest earlier messages first until the budget is used.
  let budget = COMPOSE_MAX_CONTEXT_CHARS - main.text.length - 200;
  const kept: string[] = [];
  for (let i = before.length - 1; i >= 0; i--) {
    const b = block(
      before[i],
      '[EARLIER MESSAGE IN THE CONVERSATION]',
      COMPOSE_MAX_THREAD_MESSAGE_CHARS
    );
    if (b.text.length + 2 > budget) {
      truncated = true;
      break;
    }
    budget -= b.text.length + 2;
    truncated = truncated || b.cut;
    kept.unshift(b.text);
  }
  const text = [...kept, main.text].join('\n\n');
  return { text, messages: kept.length + 1, truncated };
}

/** Exactly what the IPC request carries. */
export interface DraftComposeRequest {
  request: string;
  draftText: string;
  draftSubject?: string;
  composeKind: ComposeKind;
  composeContext?: string;
}

export type DraftComposeBuild =
  | { ok: true; req: DraftComposeRequest }
  | { ok: false; reason: 'empty-request' | 'request-too-long' | 'too-long' };

export function buildComposeRequest(
  draft: { body?: string; subject?: string; kind?: string },
  instruction: string,
  opts: { includeSubject?: boolean; context?: string | null } = {}
): DraftComposeBuild {
  const r = (instruction || '').trim();
  if (!r) {
    return { ok: false, reason: 'empty-request' };
  }
  if (r.length > DRAFT_ASSIST_MAX_REQUEST_CHARS) {
    return { ok: false, reason: 'request-too-long' };
  }
  const own = draftOwnText(draft.body || '');
  if (own.length > DRAFT_ASSIST_MAX_CHARS) {
    return { ok: false, reason: 'too-long' };
  }
  const kind: ComposeKind =
    draft.kind === 'reply' ? 'reply' : draft.kind === 'forward' ? 'forward' : 'new';
  const req: DraftComposeRequest = {
    request: r,
    draftText: own.trim() ? own : '',
    composeKind: kind,
  };
  if (opts.includeSubject && typeof draft.subject === 'string' && draft.subject.trim()) {
    req.draftSubject = draft.subject.slice(0, DRAFT_ASSIST_MAX_SUBJECT_CHARS);
  }
  if (kind !== 'new' && opts.context && opts.context.trim()) {
    req.composeContext = opts.context.slice(0, COMPOSE_MAX_CONTEXT_CHARS);
  }
  return { ok: true, req };
}

const SUBJECT_LINE = /^\s*(subject|נושא)\s*:\s*(.*)$/i;

/** Tidy the model's answer: one-line subject, plain body, no quote echo. */
export function cleanComposeResult(
  raw: { subject?: string; body?: string },
  kind: ComposeKind
): { subject: string; body: string } {
  let body = cleanRewrite(raw.body || '');
  let subject = oneLine(raw.subject || '').replace(/^(subject|נושא)\s*:\s*/i, '');
  // Some answers repeat "Subject: …" as the first body line.
  const first = body.split('\n', 1)[0];
  const m = SUBJECT_LINE.exec(first);
  if (m) {
    if (!subject) {
      subject = oneLine(m[2]);
    }
    body = body.slice(first.length).replace(/^\n+/, '');
  }
  if (kind !== 'new') {
    // Never paste a second copy of the quote: keep only the new text.
    body = splitDraftForAssist(body).own;
  }
  return { subject: subject.slice(0, COMPOSE_MAX_SUBJECT_CHARS), body: body.replace(/\s+$/, '') };
}

/**
 * The subject changes only when it is empty, or when the user ticked
 * "replace the subject too". Returns the new subject, or null to keep it.
 */
export function subjectToApply(
  current: string,
  suggested: string,
  userTicked: boolean
): string | null {
  const s = (suggested || '').trim();
  if (!s) {
    return null;
  }
  if (!(current || '').trim() || userTicked) {
    return s === (current || '').trim() ? null : s;
  }
  return null;
}
