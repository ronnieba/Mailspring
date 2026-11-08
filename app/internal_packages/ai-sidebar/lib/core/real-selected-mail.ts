/**
 * Exact-one-message eligibility and disclosure for the opt-in real summary path.
 *
 * Selection is the native MessageStore expansion of the focused thread, not a
 * mailbox scan. Neighboring messages, folders, and attachments are out of
 * scope. Quoted HTML is stripped and disclosed when present.
 */

export const REAL_SELECTED_MAX_BODY_CHARS = 8000;

export const REAL_SELECTED_QUERY =
  'Summarize this one selected email. Use only the provided message. Do not invent other mail.';

export type RealSelectedEligibility = {
  ok: boolean;
  messageId?: string;
  threadId?: string;
  reason?: string;
};

export type RealSelectedExpansion = Record<string, 'explicit' | 'default' | undefined>;

export type RealSelectedMessageLite = {
  id?: unknown;
  threadId?: unknown;
};

export type RealSelectedDisclosure = {
  quotedStripped: boolean;
  truncated: boolean;
  attachmentCount: number;
};

export type PreparedRealSelectedBody = RealSelectedDisclosure & {
  bodyText: string;
};

export type RealSelectedPreview = {
  snapshotEpoch: number;
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyPreview: string;
  disclosure: string;
  quotedStripped: boolean;
  truncated: boolean;
  attachmentCount: number;
};

export function resolveExactSelectedMessage(opts: {
  threadIds: string[];
  messages: RealSelectedMessageLite[];
  expansion: RealSelectedExpansion;
}): RealSelectedEligibility {
  if (opts.threadIds.length === 0) {
    return { ok: false, reason: 'empty-selection' };
  }
  if (opts.threadIds.length > 1) {
    return { ok: false, reason: 'multi-thread' };
  }
  const threadId = opts.threadIds[0];
  const inThread = opts.messages.filter((m) => typeof m.id === 'string' && m.id.length > 0);
  if (inThread.length === 0) {
    return { ok: false, reason: 'empty-thread' };
  }
  if (inThread.length === 1) {
    return { ok: true, messageId: inThread[0].id as string, threadId };
  }
  const explicit = inThread.filter((m) => opts.expansion[m.id as string] === 'explicit');
  if (explicit.length === 1) {
    return { ok: true, messageId: explicit[0].id as string, threadId };
  }
  if (explicit.length > 1) {
    return { ok: false, reason: 'multi-message' };
  }
  return { ok: false, reason: 'ambiguous-thread' };
}

export function htmlToPlainText(html: string): string {
  const withoutQuoted = html
    .replace(
      /<(blockquote|div)[^>]*(class|id)\s*=\s*["'][^"']*(gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|blockquote)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
      ' '
    )
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, ' ');
  const withoutTags = withoutQuoted
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function quotedRegionsPresent(html: string): boolean {
  return (
    /<(blockquote|div)[^>]*(class|id)\s*=\s*["'][^"']*(gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|blockquote)[^"']*["'][^>]*>/i.test(
      html
    ) || /<blockquote\b/i.test(html)
  );
}

export function prepareRealSelectedBody(
  html: string,
  attachmentCount: number
): PreparedRealSelectedBody {
  const quotedStripped = quotedRegionsPresent(html);
  let bodyText = htmlToPlainText(html);
  let truncated = false;
  if (bodyText.length > REAL_SELECTED_MAX_BODY_CHARS) {
    bodyText = bodyText.slice(0, REAL_SELECTED_MAX_BODY_CHARS);
    truncated = true;
  }
  return {
    bodyText,
    quotedStripped,
    truncated,
    attachmentCount: Number.isFinite(attachmentCount)
      ? Math.max(0, Math.floor(attachmentCount))
      : 0,
  };
}

export function isStaleRealSelectedSnapshot(
  sent: { messageId: string; snapshotEpoch: number },
  current: { messageId: string | null; snapshotEpoch: number }
): boolean {
  if (!current.messageId) {
    return true;
  }
  return sent.messageId !== current.messageId || sent.snapshotEpoch !== current.snapshotEpoch;
}

export function formatRealSelectedDisclosure(d: RealSelectedDisclosure): string {
  const parts = ['Only this one selected message will be sent.'];
  if (d.attachmentCount > 0) {
    parts.push(`${d.attachmentCount} attachment(s) will not be sent.`);
  } else {
    parts.push('No attachments will be sent.');
  }
  if (d.quotedStripped) {
    parts.push('Quoted previous-message HTML was stripped from the body.');
  }
  if (d.truncated) {
    parts.push(`Body truncated to ${REAL_SELECTED_MAX_BODY_CHARS} characters.`);
  }
  return parts.join(' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}
