/**
 * Main-process IPC for the DEMO Gemini Developer API host.
 * Credentials stay in the main-process secret module (stripped from
 * process.env). Renderer receives status booleans and payloads, never the
 * key. handleFromMailspringWindows rejects guest frames.
 */
import { IpcMain } from 'electron';
import { handleFromMailspringWindows } from './trusted-ipc';
import {
  GEMINI_IPC_CANCEL,
  GEMINI_IPC_QUERY,
  GEMINI_IPC_STATUS,
  GeminiDemoMailRef,
  GeminiDemoQueryInput,
} from './gemini-demo-protocol';
import { GeminiFetch, resolveGeminiDemoStatus, runGeminiDemoQuery } from './gemini-demo-host';

export interface GeminiDemoIpcOptions {
  isDemoMode: () => boolean;
  isRealSelectedSummary?: () => boolean;
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
  fetch?: GeminiFetch;
}

const inflight = new Map<number, AbortController>();

function asMessages(raw: unknown): GeminiDemoMailRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: GeminiDemoMailRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string') {
      continue;
    }
    const ref: GeminiDemoMailRef = {
      id: m.id,
      threadId: typeof m.threadId === 'string' ? m.threadId : '',
      accountId: typeof m.accountId === 'string' ? m.accountId : '',
      subject: typeof m.subject === 'string' ? m.subject : '',
      from: typeof m.from === 'string' ? m.from : '',
      date: (m.date as GeminiDemoMailRef['date']) || '',
      snippet: typeof m.snippet === 'string' ? m.snippet : '',
    };
    if (typeof m.bodyText === 'string') {
      ref.bodyText = m.bodyText;
    }
    out.push(ref);
  }
  return out;
}

function parseQuery(raw: unknown): GeminiDemoQueryInput {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const generation =
    typeof r.generation === 'number' && Number.isFinite(r.generation) ? r.generation : 0;
  const query = typeof r.query === 'string' ? r.query : '';
  const timeoutMs = typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined;
  const mode =
    r.mode === 'real-selected-single' || r.mode === 'demo-synthetic' ? r.mode : undefined;
  const allowedMessageId = typeof r.allowedMessageId === 'string' ? r.allowedMessageId : undefined;
  const snapshotEpoch =
    typeof r.snapshotEpoch === 'number' && Number.isFinite(r.snapshotEpoch)
      ? r.snapshotEpoch
      : undefined;
  return {
    generation,
    query,
    messages: asMessages(r.messages),
    timeoutMs,
    mode,
    allowedMessageId,
    snapshotEpoch,
  };
}

export function registerGeminiDemoIpcHandlers(ipcMain: IpcMain, opts: GeminiDemoIpcOptions) {
  const fetchImpl =
    opts.fetch ||
    ((typeof globalThis.fetch === 'function'
      ? (globalThis.fetch.bind(globalThis) as GeminiFetch)
      : undefined) as GeminiFetch | undefined);

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_STATUS, () => {
    return resolveGeminiDemoStatus({
      demoMode: opts.isDemoMode(),
      realSelectedSummary: opts.isRealSelectedSummary ? opts.isRealSelectedSummary() : false,
      env: opts.env,
      credentials: opts.credentials,
    });
  });

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_QUERY, async (_event, raw: unknown) => {
    const req = parseQuery(raw);
    return runGeminiDemoQuery(req, {
      demoMode: opts.isDemoMode(),
      realSelectedSummary: opts.isRealSelectedSummary ? opts.isRealSelectedSummary() : false,
      env: opts.env,
      credentials: opts.credentials,
      fetch: fetchImpl,
      registerAbort: (generation, controller) => {
        inflight.set(generation, controller);
      },
      unregisterAbort: (generation) => {
        inflight.delete(generation);
      },
    });
  });

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_CANCEL, (_event, generationRaw: unknown) => {
    const generation = typeof generationRaw === 'number' ? generationRaw : Number(generationRaw);
    const controller = inflight.get(generation);
    if (controller) {
      controller.abort();
    }
    return { aborted: !!controller };
  });
}
