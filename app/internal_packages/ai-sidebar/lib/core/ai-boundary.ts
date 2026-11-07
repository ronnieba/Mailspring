/**
 * Provider-neutral AI boundary. General live providers stay disabled
 * (`LIVE_AI_PROVIDERS_ENABLED`). The official paid Gemini Developer API is a
 * DEMO-synthetic exception via `allowLiveSynthetic` — not consumer Gemini,
 * not a production mailbox. The host validates every payload and calculates
 * coverage; a worker never owns those.
 *
 * Local cancel/timeout/stale-generation are host decisions. They are not a
 * completed remote generation and must not be billed or shown as an answer.
 * Aborting fetch does not guarantee the provider stopped generating.
 */
import { Citation, SearchResult } from './types';
import { buildCoverageDisclosure } from './coverage-disclosure';

export const LIVE_AI_PROVIDERS_ENABLED = false;

export const LIVE_AI_DISABLED_REASON =
  'Live AI providers are disabled. No consumer OAuth wrappers, API billing, or remote generation. Marked mock only.';

export const NON_SYNTHETIC_LIVE_REASON =
  'Live Gemini is DEMO-synthetic only. Real mailbox messages are not admitted.';

export type AIBoundaryReason =
  | 'invalid-schema'
  | 'unknown-source-id'
  | 'not-mock'
  | 'live-disabled'
  | 'non-synthetic-source'
  | 'stale-generation'
  | 'cancelled'
  | 'timeout';

export type AITerminationOrigin = 'local' | 'remote';

export interface AIValidateContext {
  allowedSourceIds: ReadonlySet<string>;
  startedGeneration: number;
  currentGeneration: number;
  aborted: boolean;
  /**
   * DEMO-only exception for the official paid Gemini Developer API host.
   * Still requires synthetic fixtures. Does not enable consumer OAuth or
   * production mailbox generation.
   */
  allowLiveSynthetic?: boolean;
  sourcesAreSynthetic?: boolean;
}

export interface ValidatedAIResult {
  response: string;
  citations: Citation[];
  tokensUsed: number;
  isMock: boolean;
  mockLabel: string;
}

export interface AIBoundaryOk {
  ok: true;
  origin: 'mock' | 'live';
  result: ValidatedAIResult;
}

export interface AIBoundaryFailure {
  ok: false;
  origin: AITerminationOrigin;
  reason: AIBoundaryReason;
  message: string;
}

export type AIBoundaryResult = AIBoundaryOk | AIBoundaryFailure;

/** Boolean `ok` does not narrow this union unless strictNullChecks is on. */
export function isAIBoundaryFailure(r: AIBoundaryResult): r is AIBoundaryFailure {
  return r.ok === false;
}

export function isAIBoundaryOk(r: AIBoundaryResult): r is AIBoundaryOk {
  return r.ok === true;
}

export function hostCoverageFooter(searchResult: SearchResult, syncCoverage: number): string {
  return buildCoverageDisclosure(searchResult, syncCoverage);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return null;
}

function isCitationRejection(v: Citation | AIBoundaryFailure): v is AIBoundaryFailure {
  return 'reason' in v;
}

function parseCitation(raw: unknown, allowed: ReadonlySet<string>): Citation | AIBoundaryFailure {
  if (!isRecord(raw)) {
    return fail('local', 'invalid-schema', 'citation is not an object');
  }
  const c = raw;
  if (!isNonEmptyString(c.messageId)) {
    return fail('local', 'invalid-schema', 'citation.messageId required');
  }
  if (!allowed.has(c.messageId)) {
    return fail(
      'local',
      'unknown-source-id',
      `citation messageId is not in host scope: ${JSON.stringify(c.messageId)}`
    );
  }
  if (!isNonEmptyString(c.threadId) || !isNonEmptyString(c.subject) || !isNonEmptyString(c.from)) {
    return fail('local', 'invalid-schema', 'citation threadId/subject/from required');
  }
  const date = parseDate(c.date);
  if (!date) {
    return fail('local', 'invalid-schema', 'citation.date required');
  }
  const snippet = typeof c.snippet === 'string' ? c.snippet : '';
  return {
    messageId: c.messageId,
    threadId: c.threadId,
    subject: c.subject,
    from: c.from,
    date,
    snippet,
  };
}

function fail(
  origin: AITerminationOrigin,
  reason: AIBoundaryReason,
  message: string
): AIBoundaryFailure {
  return { ok: false, origin, reason, message };
}

/**
 * Fail closed. Never drop a bad citation and keep the rest. Never substitute
 * demo fixtures when the payload is invalid.
 */
export function validateProviderPayload(raw: unknown, ctx: AIValidateContext): AIBoundaryResult {
  if (ctx.aborted) {
    return fail('local', 'cancelled', 'Local cancellation — no remote generation completed');
  }
  if (ctx.startedGeneration !== ctx.currentGeneration) {
    return fail(
      'local',
      'stale-generation',
      'Stale result rejected after a newer query generation'
    );
  }
  if (!isRecord(raw)) {
    return fail('local', 'invalid-schema', 'provider payload is not an object');
  }
  const p = raw;
  const liveSynthetic = p.isMock === false && ctx.allowLiveSynthetic === true;
  if (p.isMock === false && ctx.allowLiveSynthetic !== true) {
    return fail('local', 'live-disabled', LIVE_AI_DISABLED_REASON);
  }
  if (!liveSynthetic && p.isMock !== true) {
    return fail(
      'local',
      p.isMock === false ? 'not-mock' : 'invalid-schema',
      'Payload must be a marked mock (isMock: true). Live providers are disabled.'
    );
  }
  if (liveSynthetic && ctx.sourcesAreSynthetic !== true) {
    return fail('local', 'non-synthetic-source', NON_SYNTHETIC_LIVE_REASON);
  }
  if (typeof p.response !== 'string') {
    return fail('local', 'invalid-schema', 'payload.response must be a string');
  }
  if (!Array.isArray(p.citations)) {
    return fail('local', 'invalid-schema', 'payload.citations must be an array');
  }
  const citations: Citation[] = [];
  for (const item of p.citations) {
    const parsed = parseCitation(item, ctx.allowedSourceIds);
    if (isCitationRejection(parsed)) {
      return parsed;
    }
    citations.push(parsed);
  }
  const mockLabel =
    typeof p.mockLabel === 'string' && p.mockLabel.trim()
      ? p.mockLabel
      : liveSynthetic
        ? 'Gemini Developer API (paid project required)'
        : 'Mock AI (No External Connection)';
  const tokensUsed =
    typeof p.tokensUsed === 'number' && Number.isFinite(p.tokensUsed) ? p.tokensUsed : 0;
  return {
    ok: true,
    origin: liveSynthetic ? 'live' : 'mock',
    result: {
      response: p.response,
      citations,
      tokensUsed,
      isMock: liveSynthetic ? false : true,
      mockLabel,
    },
  };
}

export function mockOnlyProviderGuard(isMock: boolean): AIBoundaryFailure | null {
  if (!LIVE_AI_PROVIDERS_ENABLED && !isMock) {
    return fail('local', 'not-mock', LIVE_AI_DISABLED_REASON);
  }
  return null;
}
