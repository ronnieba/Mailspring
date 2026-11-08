/**
 * Node-testable Gemini Developer API host. Network stays in the main process.
 * Inject fetch in tests; never call the live API from cloud agents.
 *
 * Aborting fetch is a local decision. It does not guarantee the provider
 * stopped a billed generation (Interactions API has no documented cancel
 * that this host invokes).
 */
import {
  GEMINI_DEMO_API_REVISION,
  GEMINI_DEMO_ENDPOINT,
  GEMINI_DEMO_ENDPOINT_HOST,
  GEMINI_DEMO_KEY_ENV,
  GEMINI_DEMO_MODEL,
  GEMINI_DEMO_PAID_ENV,
  GEMINI_DISPLAY_NAME,
  GEMINI_RESPONSE_FORMAT,
  GEMINI_SYSTEM_INSTRUCTION,
  GeminiDemoMailRef,
  GeminiDemoQueryInput,
  GeminiDemoStatus,
  GeminiHostResult,
  NON_SYNTHETIC_SOURCE_REASON,
  areSyntheticDemoMailRefs,
  isAllowedGeminiEndpoint,
  unconfiguredGeminiStatus,
} from './gemini-demo-protocol';
import { getCapturedGeminiDemoCredentials } from './gemini-demo-secret';

const DEFAULT_TIMEOUT_MS = 30000;

export type GeminiFetch = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GeminiDemoHostDeps {
  demoMode: boolean;
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
  fetch?: GeminiFetch;
  userSignal?: AbortSignal;
  registerAbort?: (generation: number, controller: AbortController) => void;
  unregisterAbort?: (generation: number) => void;
}

function readKey(env: NodeJS.ProcessEnv): string {
  const raw = env[GEMINI_DEMO_KEY_ENV];
  return typeof raw === 'string' ? raw.trim() : '';
}

function paidAck(env: NodeJS.ProcessEnv): boolean {
  return env[GEMINI_DEMO_PAID_ENV] === '1';
}

function credentialsOf(deps: {
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
}): { key: string; paidAcknowledged: boolean } {
  if (deps.credentials) {
    return {
      key: typeof deps.credentials.key === 'string' ? deps.credentials.key.trim() : '',
      paidAcknowledged: !!deps.credentials.paidAcknowledged,
    };
  }
  if (deps.env) {
    return {
      key: readKey(deps.env),
      paidAcknowledged: paidAck(deps.env),
    };
  }
  return getCapturedGeminiDemoCredentials();
}

export function redactSecret(text: string, secret: string): string {
  if (!secret || !text) {
    return text;
  }
  return text.split(secret).join('[redacted-key]');
}

export function resolveGeminiDemoStatus(opts: {
  demoMode: boolean;
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
}): GeminiDemoStatus {
  const { key, paidAcknowledged } = credentialsOf(opts);
  const keyPresent = key.length > 0;

  if (!opts.demoMode) {
    return unconfiguredGeminiStatus(false, 'Gemini DEMO host is --demo only', {
      keyPresent,
      paidAcknowledged,
    });
  }
  if (!keyPresent) {
    return unconfiguredGeminiStatus(
      true,
      `Missing ${GEMINI_DEMO_KEY_ENV}. Official paid Gemini Developer API key required (not a consumer Gemini subscription).`,
      { keyPresent, paidAcknowledged }
    );
  }
  if (!paidAcknowledged) {
    return unconfiguredGeminiStatus(
      true,
      `Missing ${GEMINI_DEMO_PAID_ENV}=1. Explicit paid-project ack required. A key string does not prove Cloud Billing.`,
      { keyPresent, paidAcknowledged }
    );
  }
  return {
    configured: true,
    reason:
      'Key and paid-project ack present. Billing is not inferred from the key or model id; live calls stay blocked until parent settles prepaid/budget.',
    demoMode: true,
    keyPresent: true,
    paidAcknowledged: true,
    billingProven: false,
    model: GEMINI_DEMO_MODEL,
    endpointHost: GEMINI_DEMO_ENDPOINT_HOST,
  };
}

function fail(reason: string, message: string): GeminiHostResult {
  return { ok: false, reason, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readTokens(body: Record<string, unknown>): number {
  const usage = isRecord(body.usage) ? body.usage : null;
  if (!usage) {
    return 0;
  }
  if (typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)) {
    return usage.total_tokens;
  }
  const input = typeof usage.total_input_tokens === 'number' ? usage.total_input_tokens : 0;
  const output = typeof usage.total_output_tokens === 'number' ? usage.total_output_tokens : 0;
  return input + output;
}

export function buildUntrustedGeminiInput(query: string, messages: GeminiDemoMailRef[]): string {
  const serialized = messages
    .map(
      (m) =>
        `id=${m.id}\nfrom=${m.from}\nsubject=${m.subject}\ndate=${String(m.date)}\nsnippet=${m.snippet}`
    )
    .join('\n---\n');
  return `<<<QUERY>>>\n${query}\n<<<END_QUERY>>>\n<<<MESSAGES>>>\n${serialized}\n<<<END_MESSAGES>>>`;
}

function combineAbort(controllers: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(controllers);
  }
  const c = new AbortController();
  for (const s of controllers) {
    if (s.aborted) {
      c.abort();
      return c.signal;
    }
    s.addEventListener('abort', () => c.abort(), { once: true });
  }
  return c.signal;
}

export async function runGeminiDemoQuery(
  req: GeminiDemoQueryInput,
  deps: GeminiDemoHostDeps
): Promise<GeminiHostResult> {
  const { key, paidAcknowledged } = credentialsOf(deps);
  const status = resolveGeminiDemoStatus({
    demoMode: deps.demoMode,
    credentials: { key, paidAcknowledged },
  });
  if (!status.configured) {
    return fail('unconfigured', status.reason);
  }
  if (!Array.isArray(req.messages) || !areSyntheticDemoMailRefs(req.messages)) {
    return fail('non-synthetic-source', NON_SYNTHETIC_SOURCE_REASON);
  }
  if (typeof req.query !== 'string' || !req.query.trim()) {
    return fail('empty-query', 'Query is empty');
  }

  const fetchImpl = deps.fetch;
  if (!fetchImpl) {
    return fail('no-fetch', 'No fetch implementation (live Gemini is main-process only)');
  }

  const url = GEMINI_DEMO_ENDPOINT;
  if (!isAllowedGeminiEndpoint(url)) {
    return fail('endpoint-rejected', 'Gemini endpoint is not on the allowlist');
  }

  const timeoutMs =
    typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
      ? Math.min(Math.floor(req.timeoutMs), DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const local = new AbortController();
  deps.registerAbort?.(req.generation, local);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    local.abort();
  }, timeoutMs);

  const signals = [local.signal];
  if (deps.userSignal) {
    signals.push(deps.userSignal);
  }
  const signal = combineAbort(signals);

  try {
    if (deps.userSignal?.aborted) {
      return fail('cancelled', 'Local cancellation — no remote generation completed');
    }

    const body = JSON.stringify({
      model: GEMINI_DEMO_MODEL,
      system_instruction: GEMINI_SYSTEM_INSTRUCTION,
      input: buildUntrustedGeminiInput(req.query, req.messages),
      response_format: GEMINI_RESPONSE_FORMAT,
    });

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'Content-Type': 'application/json',
        'Api-Revision': GEMINI_DEMO_API_REVISION,
      },
      body,
      signal,
    });

    if (!res.ok) {
      return fail(
        `http-${res.status}`,
        `${GEMINI_DISPLAY_NAME} HTTP ${res.status}. No model substitution. Local abort does not guarantee the provider stopped.`
      );
    }

    let rawText = '';
    try {
      rawText = await res.text();
    } catch (err) {
      return fail('read-failed', redactSecret((err as Error).message || 'read failed', key));
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(rawText);
    } catch {
      return fail('invalid-response', 'Gemini response was not JSON');
    }
    if (!isRecord(envelope)) {
      return fail('invalid-response', 'Gemini response was not an object');
    }
    if (typeof envelope.output_text !== 'string' || !envelope.output_text.trim()) {
      return fail('missing-output-text', 'Gemini response missing output_text');
    }

    let modelJson: unknown;
    try {
      modelJson = JSON.parse(envelope.output_text);
    } catch {
      return fail('invalid-output-json', 'Gemini output_text was not JSON');
    }
    if (!isRecord(modelJson) || typeof modelJson.response !== 'string') {
      return fail('invalid-schema', 'Gemini output_text.response must be a string');
    }
    if (!Array.isArray(modelJson.citations)) {
      return fail('invalid-schema', 'Gemini output_text.citations must be an array');
    }

    return {
      ok: true,
      payload: {
        isMock: false,
        response: modelJson.response,
        citations: modelJson.citations,
        tokensUsed: readTokens(envelope),
      },
    };
  } catch (err) {
    if (deps.userSignal?.aborted || (signal.aborted && !timedOut)) {
      return fail('cancelled', 'Local cancellation — no remote generation completed');
    }
    if (timedOut || signal.aborted) {
      return fail('timeout', 'Local timeout — no remote generation completed');
    }
    return fail('fetch-failed', redactSecret((err as Error).message || 'fetch failed', key));
  } finally {
    clearTimeout(timer);
    deps.unregisterAbort?.(req.generation);
  }
}
