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
  GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION,
  GEMINI_OFFLINE_SCOPED_SYSTEM_INSTRUCTION,
  GEMINI_OFFLINE_PROOFREAD_SYSTEM_INSTRUCTION,
  OFFLINE_PROOFREAD_MAX_CHARS,
  OFFLINE_PROOFREAD_REASON,
  buildProofreadInput,
  GEMINI_DRAFT_ASSIST_RESPONSE_FORMAT,
  GEMINI_OFFLINE_DRAFT_ASSIST_SYSTEM_INSTRUCTION,
  GEMINI_DRAFT_COMPOSE_RESPONSE_FORMAT,
  DRAFT_HISTORY_MAX_TURNS,
  DRAFT_HISTORY_MAX_OUTPUT_CHARS,
  DRAFT_HISTORY_MAX_CHARS,
  draftHistoryChars,
  GEMINI_OFFLINE_DRAFT_COMPOSE_SYSTEM_INSTRUCTION,
  OFFLINE_DRAFT_COMPOSE_MAX_CONTEXT_CHARS,
  OFFLINE_DRAFT_COMPOSE_REASON,
  buildDraftComposeInput,
  OFFLINE_DRAFT_ASSIST_MAX_CHARS,
  OFFLINE_DRAFT_ASSIST_MAX_REQUEST_CHARS,
  OFFLINE_DRAFT_ASSIST_MAX_SUBJECT_CHARS,
  OFFLINE_DRAFT_ASSIST_REASON,
  buildDraftAssistInput,
  geminiUiLangFromLocale,
  localizeOfflineInstruction,
  GeminiUiLang,
  GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION,
  GEMINI_RESPONSE_FORMAT,
  GEMINI_SYSTEM_INSTRUCTION,
  GeminiDemoMailRef,
  GeminiDemoQueryInput,
  GeminiDemoStatus,
  GeminiHostFailure,
  GeminiHostResult,
  GeminiScopeFacts,
  NON_SYNTHETIC_SOURCE_REASON,
  OFFLINE_ARCHIVE_SCOPE_REASON,
  OFFLINE_SCOPED_MAX_MESSAGES,
  OFFLINE_SCOPED_MAX_TOTAL_CHARS,
  OFFLINE_SCOPED_REASON,
  REAL_SELECTED_SCOPE_REASON,
  areSyntheticDemoMailRefs,
  isAllowedGeminiEndpoint,
  isOfflineArchiveMailRef,
  isSyntheticDemoMailRef,
  sanitizeGeminiScopeFacts,
  unconfiguredGeminiStatus,
} from './gemini-demo-protocol';
import { getCapturedGeminiDemoCredentials } from './gemini-demo-secret';

/** UI language of the offline window (main process locale); Hebrew if unknown. */
function currentUiLang(): GeminiUiLang {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return geminiUiLangFromLocale(require('../intl').getCurrentLocale());
  } catch {
    return 'he';
  }
}

const DEFAULT_TIMEOUT_MS = 60000;

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
  offlineArchive?: boolean;
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
  offlineArchive?: boolean;
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
}): GeminiDemoStatus {
  const { key, paidAcknowledged } = credentialsOf(opts);
  const keyPresent = key.length > 0;
  // --demo always wins so the synthetic default cannot become a mailbox path.
  const demoMode = !!opts.demoMode;
  const offlineArchive = !demoMode && !!opts.offlineArchive;
  const realSelectedSummary = !demoMode && !offlineArchive && !!opts.realSelectedSummary;

  if (!demoMode && !realSelectedSummary && !offlineArchive) {
    return unconfiguredGeminiStatus(false, 'Gemini DEMO host is --demo only', {
      keyPresent,
      paidAcknowledged,
    });
  }
  if (!keyPresent) {
    return unconfiguredGeminiStatus(
      demoMode,
      `Missing ${GEMINI_DEMO_KEY_ENV}. Official paid Gemini Developer API key required (not a consumer Gemini subscription).`,
      { keyPresent, paidAcknowledged, realSelectedSummary, offlineArchive }
    );
  }
  if (!paidAcknowledged) {
    return unconfiguredGeminiStatus(
      demoMode,
      `Missing ${GEMINI_DEMO_PAID_ENV}=1. Explicit paid-project ack required. A key string does not prove Cloud Billing.`,
      { keyPresent, paidAcknowledged, realSelectedSummary, offlineArchive }
    );
  }
  return {
    configured: true,
    reason: demoMode
      ? 'Key and paid-project ack present. Billing is not inferred from the key or model id; live calls stay blocked until parent settles prepaid/budget.'
      : offlineArchive
        ? 'Key and paid-project ack present for explicit one-message analysis of a local archive. Not bulk upload. Yahoo IMAP is not used.'
        : 'Key and paid-project ack present for opt-in one-selected-message summary. Billing is not inferred from the key or model id.',
    demoMode,
    realSelectedSummary,
    offlineArchive,
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

export function readUsage(body: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const usage = isRecord(body.usage)
    ? body.usage
    : isRecord(body.usageMetadata)
      ? body.usageMetadata
      : null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const inputTokens = num(usage.total_input_tokens) || num(usage.promptTokenCount);
  const outputTokens =
    num(usage.total_output_tokens) +
      num(usage.total_thought_tokens) +
      num(usage.total_reasoning_tokens) ||
    num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount);
  const totalTokens =
    num(usage.total_tokens) || num(usage.totalTokenCount) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Maps a non-2xx Gemini response to a reason the panel can explain:
 * billing-exhausted (credit ran out / billing off), rate-limited, invalid-key.
 * Only the HTTP code and Google's status enum are surfaced, never the body.
 */
export function classifyGeminiHttpError(
  status: number,
  bodyText: string
): { reason: string; message: string } {
  let gStatus = '';
  let gMessage = '';
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed && (Array.isArray(parsed) ? parsed[0]?.error : parsed.error);
    if (err && typeof err === 'object') {
      gStatus = typeof err.status === 'string' ? err.status : '';
      gMessage = typeof err.message === 'string' ? err.message : '';
      const details = Array.isArray(err.details) ? JSON.stringify(err.details) : '';
      gMessage = `${gMessage} ${details}`;
    }
  } catch {
    gMessage = bodyText || '';
  }
  const tag = `HTTP ${status}${gStatus ? ` ${gStatus}` : ''}`;
  const billingWords =
    /billing|credit|prepa|balance|spend(ing)? cap|payment|plan and billing|insufficient funds|top.?up/i;
  const keyWords = /API_KEY_INVALID|API key not valid|API key expired|invalid api key|API_KEY_/i;
  if (keyWords.test(gMessage) || status === 401) {
    return {
      reason: 'invalid-key',
      message: `מפתח Gemini לא תקין או בוטל. צור מפתח חדש ב-AI Studio ושמור אותו שוב. (${tag})`,
    };
  }
  if (
    status === 402 ||
    ((status === 429 || status === 403 || status === 400) && billingWords.test(gMessage)) ||
    (status === 400 && gStatus === 'FAILED_PRECONDITION')
  ) {
    return {
      reason: 'billing-exhausted',
      message: `נגמר הקרדיט או שהחיוב ב-Google כבוי — Gemini לא יענה עד שתטעין יתרה בדף החיוב של AI Studio. (${tag})`,
    };
  }
  if (status === 429) {
    return {
      reason: 'rate-limited',
      message: `יותר מדי בקשות ל-Gemini בזמן קצר (מגבלת קצב). נסה שוב בעוד דקה. (${tag})`,
    };
  }
  if (status === 403) {
    return {
      reason: 'invalid-key',
      message: `אין הרשאה למפתח Gemini (ייתכן שהוגבל או בוטל). בדוק את המפתח ב-AI Studio. (${tag})`,
    };
  }
  return {
    reason: `http-${status}`,
    message: `${GEMINI_DISPLAY_NAME} ${tag}. No model substitution. Local abort does not guarantee the provider stopped.`,
  };
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

export function formatScopeFacts(f: GeminiScopeFacts): string {
  const scope =
    f.scopeKind === 'selected'
      ? 'messages the user selected'
      : f.scopeKind === 'folder'
        ? `one folder the user selected (${f.includesSubfolders ? 'including' : 'NOT including'} subfolders)`
        : 'the whole local mail copy';
  return [
    `scope=${scope}`,
    `total_messages_in_scope=${f.totalInScope}`,
    `messages_sent_to_you=${f.sent}`,
    `oldest_message_date=${f.oldest || 'unknown'}`,
    `newest_message_date=${f.newest || 'unknown'}`,
    `distinct_senders=${f.distinctSenders}`,
  ].join('\n');
}

export function buildUntrustedGeminiInput(
  query: string,
  messages: GeminiDemoMailRef[],
  opts?: { includeBody?: boolean; scopeFacts?: GeminiScopeFacts }
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
  const facts = opts?.scopeFacts
    ? `<<<SCOPE_FACTS>>>\n${formatScopeFacts(opts.scopeFacts)}\n<<<END_SCOPE_FACTS>>>\n`
    : '';
  return `${facts}<<<QUERY>>>\n${query}\n<<<END_QUERY>>>\n<<<MESSAGES>>>\n${serialized}\n<<<END_MESSAGES>>>`;
}

function admitOfflineArchiveQuery(req: GeminiDemoQueryInput): GeminiHostFailure | null {
  if (req.mode !== 'offline-archive-selected') {
    return fail('offline-archive-scope', OFFLINE_ARCHIVE_SCOPE_REASON);
  }
  if (!Array.isArray(req.messages) || req.messages.length !== 1) {
    return fail('offline-archive-scope', OFFLINE_ARCHIVE_SCOPE_REASON);
  }
  const message = req.messages[0];
  if (typeof req.allowedMessageId !== 'string' || req.allowedMessageId !== message.id) {
    return fail('offline-archive-scope', OFFLINE_ARCHIVE_SCOPE_REASON);
  }
  if (typeof req.snapshotEpoch !== 'number' || !Number.isFinite(req.snapshotEpoch)) {
    return fail('stale-selection', OFFLINE_ARCHIVE_SCOPE_REASON);
  }
  if (isSyntheticDemoMailRef(message) || !isOfflineArchiveMailRef(message)) {
    return fail('offline-archive-scope', OFFLINE_ARCHIVE_SCOPE_REASON);
  }
  if (typeof message.bodyText !== 'string' || !message.bodyText.trim()) {
    return fail('offline-archive-scope', OFFLINE_ARCHIVE_SCOPE_REASON);
  }
  return null;
}

function admitOfflineScopedQuery(req: GeminiDemoQueryInput): GeminiHostFailure | null {
  const msgs = req.messages;
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > OFFLINE_SCOPED_MAX_MESSAGES) {
    return fail('offline-archive-scope', OFFLINE_SCOPED_REASON);
  }
  let total = 0;
  const seen = new Set<string>();
  for (const m of msgs) {
    if (isSyntheticDemoMailRef(m) || !isOfflineArchiveMailRef(m) || seen.has(m.id)) {
      return fail('offline-archive-scope', OFFLINE_SCOPED_REASON);
    }
    seen.add(m.id);
    if (typeof m.bodyText !== 'string') {
      return fail('offline-archive-scope', OFFLINE_SCOPED_REASON);
    }
    total += m.bodyText.length + (m.subject || '').length + (m.from || '').length;
  }
  if (total > OFFLINE_SCOPED_MAX_TOTAL_CHARS) {
    return fail('offline-archive-scope', OFFLINE_SCOPED_REASON);
  }
  return null;
}

/** Proofread: one draft text, no mail at all. */
export function admitOfflineProofreadQuery(req: GeminiDemoQueryInput): GeminiHostFailure | null {
  if (req.mode !== 'offline-draft-proofread') {
    return fail('offline-archive-scope', OFFLINE_PROOFREAD_REASON);
  }
  if (!Array.isArray(req.messages) || req.messages.length !== 0) {
    return fail('offline-archive-scope', OFFLINE_PROOFREAD_REASON);
  }
  if (
    typeof req.query !== 'string' ||
    !req.query.trim() ||
    req.query.length > OFFLINE_PROOFREAD_MAX_CHARS
  ) {
    return fail('offline-archive-scope', OFFLINE_PROOFREAD_REASON);
  }
  if (req.allowedMessageId !== undefined || req.scopeFacts !== undefined) {
    return fail('offline-archive-scope', OFFLINE_PROOFREAD_REASON);
  }
  return null;
}

/** Open-draft assist: the user's request + one draft text, no mail at all. */
/** Earlier turns: optional, bounded, plain strings only. */
export function draftHistoryAdmissible(h: unknown): boolean {
  if (h === undefined) {
    return true;
  }
  if (!Array.isArray(h) || h.length === 0 || h.length > DRAFT_HISTORY_MAX_TURNS) {
    return false;
  }
  for (const t of h) {
    if (
      !t ||
      typeof t !== 'object' ||
      typeof t.instruction !== 'string' ||
      typeof t.output !== 'string' ||
      t.instruction.length > OFFLINE_DRAFT_ASSIST_MAX_REQUEST_CHARS ||
      t.output.length > DRAFT_HISTORY_MAX_OUTPUT_CHARS ||
      (t.subject !== undefined &&
        (typeof t.subject !== 'string' ||
          t.subject.length > OFFLINE_DRAFT_ASSIST_MAX_SUBJECT_CHARS)) ||
      (t.applied !== undefined &&
        t.applied !== null &&
        t.applied !== 'replace' &&
        t.applied !== 'append')
    ) {
      return false;
    }
  }
  return draftHistoryChars(h) <= DRAFT_HISTORY_MAX_CHARS;
}

export function admitOfflineDraftAssistQuery(req: GeminiDemoQueryInput): GeminiHostFailure | null {
  const no = () => fail('offline-archive-scope', OFFLINE_DRAFT_ASSIST_REASON);
  if (req.mode !== 'offline-draft-assist') {
    return no();
  }
  if (!draftHistoryAdmissible(req.draftHistory)) {
    return no();
  }
  if (!Array.isArray(req.messages) || req.messages.length !== 0) {
    return no();
  }
  if (
    typeof req.query !== 'string' ||
    !req.query.trim() ||
    req.query.length > OFFLINE_DRAFT_ASSIST_MAX_REQUEST_CHARS
  ) {
    return no();
  }
  if (
    typeof req.draftText !== 'string' ||
    !req.draftText.trim() ||
    req.draftText.length > OFFLINE_DRAFT_ASSIST_MAX_CHARS
  ) {
    return no();
  }
  if (
    req.draftSubject !== undefined &&
    (typeof req.draftSubject !== 'string' ||
      req.draftSubject.length > OFFLINE_DRAFT_ASSIST_MAX_SUBJECT_CHARS)
  ) {
    return no();
  }
  if (req.allowedMessageId !== undefined || req.scopeFacts !== undefined) {
    return no();
  }
  return null;
}

/**
 * Write with AI: instruction + the draft's own text (may be empty) + subject
 * (optional) + for reply/forward the original as plain text. No mail refs.
 */
export function admitOfflineDraftComposeQuery(req: GeminiDemoQueryInput): GeminiHostFailure | null {
  const no = () => fail('offline-archive-scope', OFFLINE_DRAFT_COMPOSE_REASON);
  if (req.mode !== 'offline-draft-compose') {
    return no();
  }
  if (!draftHistoryAdmissible(req.draftHistory)) {
    return no();
  }
  if (!Array.isArray(req.messages) || req.messages.length !== 0) {
    return no();
  }
  if (
    typeof req.query !== 'string' ||
    !req.query.trim() ||
    req.query.length > OFFLINE_DRAFT_ASSIST_MAX_REQUEST_CHARS
  ) {
    return no();
  }
  if (typeof req.draftText !== 'string' || req.draftText.length > OFFLINE_DRAFT_ASSIST_MAX_CHARS) {
    return no();
  }
  if (
    req.draftSubject !== undefined &&
    (typeof req.draftSubject !== 'string' ||
      req.draftSubject.length > OFFLINE_DRAFT_ASSIST_MAX_SUBJECT_CHARS)
  ) {
    return no();
  }
  const kind = req.composeKind;
  if (kind !== 'new' && kind !== 'reply' && kind !== 'forward') {
    return no();
  }
  if (req.composeContext !== undefined) {
    if (
      kind === 'new' ||
      typeof req.composeContext !== 'string' ||
      req.composeContext.length > OFFLINE_DRAFT_COMPOSE_MAX_CONTEXT_CHARS
    ) {
      return no();
    }
  }
  if (req.allowedMessageId !== undefined || req.scopeFacts !== undefined) {
    return no();
  }
  return null;
}

/** System instruction for every mode except open-draft assist. */
function offlineInstruction(
  offlineProofread: boolean,
  offlineScoped: boolean,
  offlineArchive: boolean,
  realSelectedSummary: boolean
): string {
  if (offlineProofread) {
    return GEMINI_OFFLINE_PROOFREAD_SYSTEM_INSTRUCTION;
  }
  if (offlineScoped) {
    return localizeOfflineInstruction(GEMINI_OFFLINE_SCOPED_SYSTEM_INSTRUCTION, currentUiLang());
  }
  if (offlineArchive) {
    return localizeOfflineInstruction(GEMINI_OFFLINE_ARCHIVE_SYSTEM_INSTRUCTION, currentUiLang());
  }
  return realSelectedSummary ? GEMINI_REAL_SELECTED_SYSTEM_INSTRUCTION : GEMINI_SYSTEM_INSTRUCTION;
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
  const offlineArchive = !demoMode && !!deps.offlineArchive;
  const realSelectedSummary = !demoMode && !offlineArchive && !!deps.realSelectedSummary;
  const status = resolveGeminiDemoStatus({
    demoMode,
    realSelectedSummary,
    offlineArchive,
    credentials: { key, paidAcknowledged },
  });
  if (!status.configured) {
    return fail('unconfigured', status.reason);
  }
  const offlineScoped = offlineArchive && req.mode === 'offline-archive-scoped';
  const offlineProofread = offlineArchive && req.mode === 'offline-draft-proofread';
  const offlineDraftAssist = offlineArchive && req.mode === 'offline-draft-assist';
  const offlineDraftCompose = offlineArchive && req.mode === 'offline-draft-compose';
  if (offlineDraftCompose) {
    const scoped = admitOfflineDraftComposeQuery(req);
    if (scoped) {
      return scoped;
    }
  } else if (offlineDraftAssist) {
    const scoped = admitOfflineDraftAssistQuery(req);
    if (scoped) {
      return scoped;
    }
  } else if (offlineProofread) {
    const scoped = admitOfflineProofreadQuery(req);
    if (scoped) {
      return scoped;
    }
  } else if (offlineScoped) {
    const scoped = admitOfflineScopedQuery(req);
    if (scoped) {
      return scoped;
    }
  } else if (offlineArchive) {
    const scoped = admitOfflineArchiveQuery(req);
    if (scoped) {
      return scoped;
    }
  } else if (realSelectedSummary) {
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
      system_instruction: offlineDraftCompose
        ? GEMINI_OFFLINE_DRAFT_COMPOSE_SYSTEM_INSTRUCTION
        : offlineDraftAssist
          ? GEMINI_OFFLINE_DRAFT_ASSIST_SYSTEM_INSTRUCTION
          : offlineInstruction(
              offlineProofread,
              offlineScoped,
              offlineArchive,
              realSelectedSummary
            ),
      input: offlineDraftCompose
        ? buildDraftComposeInput(
            req.query,
            req.composeKind || 'new',
            req.draftText || '',
            req.draftSubject,
            req.composeContext,
            req.draftHistory
          )
        : offlineDraftAssist
          ? buildDraftAssistInput(
              req.query,
              req.draftText || '',
              req.draftSubject,
              req.draftHistory
            )
          : offlineProofread
            ? buildProofreadInput(req.query)
            : buildUntrustedGeminiInput(req.query, req.messages, {
                includeBody: realSelectedSummary || offlineArchive,
                scopeFacts: offlineScoped
                  ? sanitizeGeminiScopeFacts(req.scopeFacts, req.messages.length)
                  : undefined,
              }),
      response_format: offlineDraftCompose
        ? GEMINI_DRAFT_COMPOSE_RESPONSE_FORMAT
        : offlineDraftAssist
          ? GEMINI_DRAFT_ASSIST_RESPONSE_FORMAT
          : GEMINI_RESPONSE_FORMAT,
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
      let errText = '';
      try {
        errText = await res.text();
      } catch {
        errText = '';
      }
      const classified = classifyGeminiHttpError(res.status, redactSecret(errText || '', key));
      return fail(classified.reason, classified.message);
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
    if (offlineDraftCompose) {
      // Written text only; citations ignored.
      return {
        ok: true,
        payload: {
          isMock: false,
          response: modelJson.response,
          citations: [],
          tokensUsed: readTokens(envelope),
          usage: readUsage(envelope),
          model: GEMINI_DEMO_MODEL,
          draftKind: 'rewrite',
          composeSubject: typeof modelJson.subject === 'string' ? modelJson.subject : '',
        },
      };
    }
    if (offlineDraftAssist) {
      // Draft help never cites mail: citations are ignored, not fail-closed.
      return {
        ok: true,
        payload: {
          isMock: false,
          response: modelJson.response,
          citations: [],
          tokensUsed: readTokens(envelope),
          usage: readUsage(envelope),
          model: GEMINI_DEMO_MODEL,
          draftKind: modelJson.kind === 'rewrite' ? 'rewrite' : 'answer',
        },
      };
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
        usage: readUsage(envelope),
        model: GEMINI_DEMO_MODEL,
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
