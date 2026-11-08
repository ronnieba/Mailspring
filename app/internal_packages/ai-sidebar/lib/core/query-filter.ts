import { MessageRef } from './types';

const ALL_SELECTED_INTENT =
  /כל הנבחרות|כל ההודעות הנבחרות|כל ההודעות שנבחרו|את כל הנבחרות|summarise?\s+all\s+selected|summarize\s+all\s+selected|all\s+selected\s+messages/i;

const FIRST_SELECTED_INTENT =
  /ההודעה הראשונה|הודעה ראשונה שנבחרה|first\s+selected\s+message|the\s+first\s+selected/i;

/** Explicit "summarize ALL selected" — not a keyword hit on fixture text. */
export function queryRequestsFullSelectedScan(query: string): boolean {
  return typeof query === 'string' && ALL_SELECTED_INTENT.test(query);
}

/** Explicit first-selected-only request. Ranked coverage stays top-k. */
export function queryRequestsFirstSelectedOnly(query: string): boolean {
  return typeof query === 'string' && FIRST_SELECTED_INTENT.test(query);
}

/** Tokenize a user query. "חפש חשבוניות" still hits an invoice fixture. */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/חשבוניות/g, 'חשבונית')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function messageMatchesQuery(msg: MessageRef, query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return true;
  }
  const hay = `${msg.subject} ${msg.snippet} ${msg.from}`
    .toLowerCase()
    .replace(/חשבוניות/g, 'חשבונית');
  return tokens.some((t) => hay.includes(t));
}

export function filterMessagesByQuery(messages: MessageRef[], query: string): MessageRef[] {
  if (!query || !query.trim()) {
    return [...messages];
  }
  return messages.filter((m) => messageMatchesQuery(m, query));
}
