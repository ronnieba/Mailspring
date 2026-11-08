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
  GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION,
  GEMINI_RESPONSE_FORMAT,
  GEMINI_SYSTEM_INSTRUCTION,
  GeminiDemoMailRef,
  GeminiDemoQueryInput,
  GeminiDemoStatus,
  GeminiHostFailure,
  GeminiHostResult,
  NON_SYNTHETIC_SOURCE_REASON,
  REAL_SELECTED_SCOPE_REASON,
  areSyntheticDemoMailRefs,
  isAllowedGeminiEndpoint,
  isSyntheticDemoMailRef,
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
  realSelectedSummary?: boolean;
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
  realSelectedSummary?: boolean;
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
}): GeminiDemoStatus {
  const { key, paidAcknowledged } = credentialsOf(opts);
  const keyPresent = key.length > 0;
  // --demo always wins so the synthetic default cannot become a mailbox path.
  const demoMode = !!opts.demoMode;
  const realSelectedSummary = !demoMode && !!opts.realSelectedSummary;

  if (!demoMode && !realSelectedSummary) {
    return unconfiguredGeminiStatus(false, 'Gemini DEMO host is --demo only', {
      keyPresent,
      paidAcknowledged,
    });
  }
  if (!keyPresent) {
    return unconfiguredGeminiStatus(
      demoMode,
      `Missing ${GEMINI_DEMO_KEY_ENV}. Official paid Gemini Developer API key required (not a consumer Gemini subscription).`,
      { keyPresent, paidAcknowledged, realSelectedSummary }
    );
  }
  if (!paidAcknowledged) {
    return unconfiguredGeminiStatus(
      demoMode,
      `Missing ${GEMINI_DEMO_PAID_ENV}=1. Explicit paid-project ack required. A key string does not prove Cloud Billing.`,
      { keyPresent, paidAcknowledged, realSelectedSummary }
    );
  }
  return {
    configured: true,
    reason: demoMode
      ? 'Key and paid-project ack present. Billing is not inferred from the key or model id; live calls stay blocked until parent settles prepaid/budget.'
      : 'Key and paid-project ack present for opt-in one-selected-message summary. Billing is not inferred from the key or model id.',
    demoMode,
    realSelectedSummary,
    keyPresent: true,
    paidAcknowledged: true,
    billingProven: false,
    model: GEMINI_DEMO_MODEL,
    endpointHost: GEMINI_DEMO_ENDPOINT_HOST,
  };
}

function fail(reason: string, message: string): GeminiHostFailure {
  return { ok: false, reason, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * REST Interaction resource (docs 2026-11-08): `status` plus `steps`.
 * SDK `.output_text` is not serialized on the JSON body.
 *
 * Native 856fbc6d (main 72367, one Send, synthetic thread
 * "שרשור פגישת צוות (2 הודעות)"): UI failed because the parser required the
 * SDK convenience field on the REST JSON. HTTP status, model, body shape,
 * and tokens were not captured — do not infer a native HTTP 200 from that
 * parser string. A separate standalone box HTTP 200 (same model) used
 * `status=completed` and `output: [json]` with no SDK convenience field
 * (109 in / 50 out).
 * https://ai.google.dev/gemini-api/docs/get-started
 * https://aistudio.google.com/api-reference/interactions-api/create-interaction
 */
export type GeminiInteractionExtract = {
  status: string;
  text: string;
  parsedObject: unknown | null;
};

function isTextContentBlock(v: unknown): v is { type: string; text: string } {
  return isRecord(v) && v.type === 'text' && typeof v.text === 'string';
}

function collectOutputItems(items: unknown[]): GeminiInteractionExtract {
  const texts: string[] = [];
  let parsedObject: unknown | null = null;
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) {
        texts.push(item);
      }
      continue;
    }
    if (isTextContentBlock(item) && item.text.trim()) {
      texts.push(item.text);
      continue;
    }
    if (isRecord(item) && typeof item.text === 'string' && item.text.trim() && !item.type) {
      texts.push(item.text);
      continue;
    }
    if (isRecord(item) && item.type !== 'text' && item.type !== 'thought') {
      parsedObject = item;
    }
  }
  if (texts.length > 0) {
    return { status: '', text: texts.join('\n').trim(), parsedObject: null };
  }
  return { status: '', text: '', parsedObject };
}

function textFromModelOutputSteps(steps: unknown): string {
  if (!Array.isArray(steps)) {
    return '';
  }
  const texts: string[] = [];
  for (const step of steps) {
    if (!isRecord(step)) {
      continue;
    }
    if (step.type !== 'model_output' && step.type !== 'model_turn') {
      continue;
    }
    if (!Array.isArray(step.content)) {
      continue;
    }
    for (const block of step.content) {
      if (isTextContentBlock(block) && block.text.trim()) {
        texts.push(block.text);
      }
    }
  }
  return texts.join('\n').trim();
}

export function extractGeminiInteractionOutput(
  envelope: Record<string, unknown>
): GeminiInteractionExtract {
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const fromSteps = textFromModelOutputSteps(envelope.steps);
  if (fromSteps) {
    return { status, text: fromSteps, parsedObject: null };
  }
  if (Array.isArray(envelope.output)) {
    const fromOutput = collectOutputItems(envelope.output);
    if (fromOutput.text || fromOutput.parsedObject) {
      return { status, text: fromOutput.text, parsedObject: fromOutput.parsedObject };
    }
  }
  if (Array.isArray(envelope.outputs)) {
    const fromOutputs = collectOutputItems(envelope.outputs);
    if (fromOutputs.text || fromOutputs.parsedObject) {
      return { status, text: fromOutputs.text, parsedObject: fromOutputs.parsedObject };
    }
  }
  if (typeof envelope.output_text === 'string' && envelope.output_text.trim()) {
    return { status, text: envelope.output_text.trim(), parsedObject: null };
  }
  return { status, text: '', parsedObject: null };
}

export function classifyGeminiInteractionStatus(status: string): GeminiHostFailure | null {
  if (!status || status === 'completed') {
    return null;
  }
  if (status === 'failed') {
    return fail('provider-failed', 'Gemini interaction status=failed. No model substitution.');
  }
  if (status === 'cancelled') {
    return fail(
      'provider-cancelled',
      'Gemini interaction status=cancelled. No model substitution.'
    );
  }
  if (
    status === 'incomplete' ||
    status === 'in_progress' ||
    status === 'requires_action' ||
    status === 'requires_continuation'
  ) {
    return fail('incomplete', `Gemini interaction status=${status}. No model substitution.`);
  }
  return fail('unexpected-status', `Gemini interaction status=${status}. No model substitution.`);
}

function parseModelJson(
  extracted: GeminiInteractionExtract
): { kind: 'ok'; value: unknown } | { kind: 'fail'; failure: GeminiHostFailure } {
  if (extracted.parsedObject !== null && extracted.parsedObject !== undefined) {
    return { kind: 'ok', value: extracted.parsedObject };
  }
  if (!extracted.text) {
    return {
      kind: 'fail',
      failure: fail('empty-output', 'Gemini interaction completed with empty model output'),
    };
  }
  try {
    return { kind: 'ok', value: JSON.parse(extracted.text) };
  } catch {
    return {
      kind: 'fail',
      failure: fail('invalid-output-json', 'Gemini model output was not JSON'),
    };
  }
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

export function buildUntrustedGeminiInput(
  query: string,
  messages: GeminiDemoMailRef[],
  opts?: { includeBody?: boolean }
): string {
  const includeBody = opts?.includeBody === true;
  const serialized = messages
    .map((m) => {
      const lines = [
        `id=${m.id}`,
        `from=${m.from}`,
        `subject=${m.subject}`,
        `date=${String(m.date)}`,
        `snippet=${m.snippet}`,
      ];
      if (includeBody && typeof m.bodyText === 'string') {
        lines.push(`body=${m.bodyText}`);
      }
      return lines.join('\n');
    })
    .join('\n---\n');
  return `<<<QUERY>>>\n${query}\n<<<END_QUERY>>>\n<<<MESSAGES>>>\n${serialized}\n<<<END_MESSAGES>>>`;
}

function admitRealSelectedQuery(req: GeminiDemoQueryInput): GeminiHostFailure | null {
  if (req.mode !== 'real-selected-single') {
    return fail('real-selected-scope', REAL_SELECTED_SCOPE_REASON);
  }
  if (!Array.isArray(req.messages) || req.messages.length !== 1) {
    return fail('real-selected-scope', REAL_SELECTED_SCOPE_REASON);
  }
  const message = req.messages[0];
  if (typeof req.allowedMessageId !== 'string' || req.allowedMessageId !== message.id) {
    return fail('real-selected-scope', REAL_SELECTED_SCOPE_REASON);
  }
  if (typeof req.snapshotEpoch !== 'number' || !Number.isFinite(req.snapshotEpoch)) {
    return fail('stale-selection', REAL_SELECTED_SCOPE_REASON);
  }
  if (isSyntheticDemoMailRef(message)) {
    return fail('real-selected-scope', REAL_SELECTED_SCOPE_REASON);
  }
  if (typeof message.bodyText !== 'string' || !message.bodyText.trim()) {
    return fail('real-selected-scope', REAL_SELECTED_SCOPE_REASON);
  }
  return null;
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
  const demoMode = !!deps.demoMode;
  const realSelectedSummary = !demoMode && !!deps.realSelectedSummary;
  const status = resolveGeminiDemoStatus({
    demoMode,
    realSelectedSummary,
    credentials: { key, paidAcknowledged },
  });
  if (!status.configured) {
    return fail('unconfigured', status.reason);
  }
  if (realSelectedSummary) {
    const scoped = admitRealSelectedQuery(req);
    if (scoped) {
      return scoped;
    }
  } else if (!Array.isArray(req.messages) || !areSyntheticDemoMailRefs(req.messages)) {
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
      system_instruction: realSelectedSummary
        ? GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION
        : GEMINI_SYSTEM_INSTRUCTION,
      input: buildUntrustedGeminiInput(req.query, req.messages, {
        includeBody: realSelectedSummary,
      }),
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

    const extracted = extractGeminiInteractionOutput(envelope);
    const statusFail = classifyGeminiInteractionStatus(extracted.status);
    if (statusFail) {
      return statusFail;
    }

    const parsed = parseModelJson(extracted);
    if (parsed.kind === 'fail') {
      return parsed.failure;
    }
    const modelJson = parsed.value;
    if (!isRecord(modelJson) || typeof modelJson.response !== 'string') {
      return fail('invalid-schema', 'Gemini model JSON response must be a string');
    }
    if (!Array.isArray(modelJson.citations)) {
      return fail('invalid-schema', 'Gemini model JSON citations must be an array');
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
