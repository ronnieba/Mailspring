import { MessageRef } from './types';

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
