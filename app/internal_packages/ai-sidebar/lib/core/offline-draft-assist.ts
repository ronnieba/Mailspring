/**
 * Offline local drafts: "ask the AI about the open draft".
 * Pure helpers (no IPC, no DOM) so tests can check exactly what is sent.
 */
import { buildProofSegments, proofChanges } from './text-diff';
import { applyProofToHtml, plainToHtml } from './offline-rich-text';
import { ENGLISH_DRAFT_LABELS, HEBREW_DRAFT_LABELS } from './offline-drafts';

export const DRAFT_ASSIST_MAX_CHARS = 20000;
export const DRAFT_ASSIST_MAX_REQUEST_CHARS = 2000;
export const DRAFT_ASSIST_MAX_SUBJECT_CHARS = 500;

export interface DraftQuickAction {
  id: string;
  he: string;
  en: string;
  /** Instruction sent as the request (English; the model answers per rules). */
  request: string;
}

export const DRAFT_QUICK_ACTIONS: DraftQuickAction[] = [
  {
    id: 'shorten',
    he: 'תקצר',
    en: 'Shorten',
    request:
      'Shorten this draft. Keep the key points, names, numbers and the language. Rewrite it.',
  },
  {
    id: 'formal',
    he: 'רשמי יותר',
    en: 'More formal',
    request: 'Rewrite this draft in a more formal, professional tone. Keep the language.',
  },
  {
    id: 'friendly',
    he: 'ידידותי יותר',
    en: 'Friendlier',
    request: 'Rewrite this draft in a warmer, friendlier tone. Keep the language.',
  },
  {
    id: 'to-en',
    he: 'תרגם לאנגלית',
    en: 'Translate to English',
    request: 'Translate this draft to English. Rewrite it fully in English.',
  },
  {
    id: 'to-he',
    he: 'תרגם לעברית',
    en: 'Translate to Hebrew',
    request: 'Translate this draft to Hebrew. Rewrite it fully in Hebrew.',
  },
  {
    id: 'tone',
    he: 'בדוק טון',
    en: 'Check tone',
    request:
      'Do not rewrite. Briefly assess the tone of this draft (how it may be read, anything that sounds harsh or unclear) and suggest up to 3 improvements. Answer in Hebrew unless the draft is entirely in English.',
  },
];

export function quickAction(id: string): DraftQuickAction | null {
  return DRAFT_QUICK_ACTIONS.find((a) => a.id === id) || null;
}

const FORWARD_HEADERS = [HEBREW_DRAFT_LABELS.forwardedHeader, ENGLISH_DRAFT_LABELS.forwardedHeader];
const WROTE_LINE = [/^ב-.+ כתב\/ה:$/, /^On .+ wrote:$/];

/**
 * Split a draft into the user's own text and the quoted/forwarded tail that
 * the app added (reply quote or forwarded message). Only `own` is ever sent
 * to the AI or rewritten; `tail` (archived mail) stays local and untouched.
 */
export function splitDraftForAssist(body: string): { own: string; tail: string } {
  const text = (body || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (FORWARD_HEADERS.includes(l)) {
      cut = i;
      break;
    }
    if (WROTE_LINE.some((re) => re.test(l)) && /^>/.test(lines[i + 1] || '')) {
      cut = i;
      break;
    }
    if (/^>/.test(lines[i]) && lines.slice(i).every((x) => !x || /^>/.test(x))) {
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    return { own: text, tail: '' };
  }
  const own = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  const ownRaw = lines.slice(0, cut).join('\n');
  // Keep the exact separator (blank lines) with the tail so rebuilding is lossless.
  const sep = ownRaw.slice(own.length);
  return { own, tail: `${sep}\n${lines.slice(cut).join('\n')}` };
}

/** What may leave the app: request + draft plain text (+ subject if opted in). */
export interface DraftAssistRequest {
  request: string;
  draftText: string;
  draftSubject?: string;
}

export type DraftAssistBuild =
  | { ok: true; req: DraftAssistRequest }
  | { ok: false; reason: 'empty-request' | 'empty-draft' | 'too-long' | 'request-too-long' };

/**
 * Build the outgoing request from an open draft. Only `body` (plain text)
 * is read, plus `subject` when includeSubject is true. Recipients, HTML,
 * attachments and source-message ids are never copied.
 */
export function buildDraftAssistRequest(
  draft: { body?: string; subject?: string },
  request: string,
  includeSubject = false
): DraftAssistBuild {
  const r = (request || '').trim();
  if (!r) {
    return { ok: false, reason: 'empty-request' };
  }
  if (r.length > DRAFT_ASSIST_MAX_REQUEST_CHARS) {
    return { ok: false, reason: 'request-too-long' };
  }
  // Only the user's own text: never the quoted / forwarded archived mail.
  const text = splitDraftForAssist(typeof draft.body === 'string' ? draft.body : '').own;
  if (!text.trim()) {
    return { ok: false, reason: 'empty-draft' };
  }
  if (text.length > DRAFT_ASSIST_MAX_CHARS) {
    return { ok: false, reason: 'too-long' };
  }
  const req: DraftAssistRequest = { request: r, draftText: text };
  if (includeSubject && typeof draft.subject === 'string' && draft.subject.trim()) {
    req.draftSubject = draft.subject.slice(0, DRAFT_ASSIST_MAX_SUBJECT_CHARS);
  }
  return { ok: true, req };
}

/** Strip a stray code fence / wrapping quotes the model may add. */
export function cleanRewrite(text: string): string {
  let t = (text || '').replace(/\r\n/g, '\n');
  const fence = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(t);
  if (fence) {
    t = fence[1];
  }
  return t.replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * Replace the draft text with a rewrite. Tries to keep the formatting by
 * splicing the change into the existing HTML (same machinery as proofread);
 * if any change crosses a line/paragraph, falls back to plain paragraphs.
 */
export function replaceDraftHtml(
  html: string,
  currentPlain: string,
  rewrite: string
): { html: string; formattingKept: boolean } {
  const { own, tail } = splitDraftForAssist(currentPlain);
  const next = tail ? `${cleanRewrite(rewrite) || own}${tail}` : cleanRewrite(rewrite);
  if (html) {
    const segs = buildProofSegments(currentPlain, next);
    const all = new Set(proofChanges(segs).map((c) => c.id));
    const res = applyProofToHtml(html, segs, all);
    if (res.skipped === 0 && res.applied === all.size) {
      return { html: res.html, formattingKept: true };
    }
  }
  return { html: plainToHtml(next), formattingKept: false };
}

/**
 * Append the text after the user's own text (before any quoted tail).
 * Without a tail the existing HTML is kept as is (formatting kept).
 */
export function appendDraftHtml(
  html: string,
  currentPlain: string,
  text: string
): { html: string; formattingKept: boolean } {
  const add = cleanRewrite(text);
  const { own, tail } = splitDraftForAssist(currentPlain);
  if (!tail) {
    const base = html || '';
    const addHtml = plainToHtml(add);
    return {
      html: base && own.trim() ? `${base}<p dir="auto"><br></p>${addHtml}` : addHtml,
      formattingKept: true,
    };
  }
  const merged = own.trim() ? `${own}\n\n${add}` : add;
  return replaceDraftHtml(html, currentPlain, merged);
}
