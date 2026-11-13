/**
 * Main-process IPC for the DEMO Gemini Developer API host.
 * Credentials stay in the main-process secret module (stripped from
 * process.env). Renderer receives status booleans and payloads, never the
 * key. handleFromMailspringWindows rejects guest frames.
 */
import path from 'path';
import { IpcMain } from 'electron';
import { handleFromMailspringWindows } from './trusted-ipc';
import {
  sanitizeGeminiScopeFacts,
  GEMINI_IPC_CANCEL,
  GEMINI_IPC_QUERY,
  GEMINI_IPC_STATUS,
  GEMINI_IPC_USAGE,
  GEMINI_IPC_USAGE_BUDGET,
  GEMINI_IPC_USAGE_RESET,
  GeminiDemoMailRef,
  GeminiDemoQueryInput,
} from './gemini-demo-protocol';
import { GeminiFetch, resolveGeminiDemoStatus, runGeminiDemoQuery } from './gemini-demo-host';
import {
  getWindowsGeminiCredentialReason,
  loadGeminiFromWindowsCredentialManager,
} from './gemini-demo-secret';
import { GeminiUsageLedger } from './gemini-usage-ledger';

export function storeGeminiKeyCommand(): string {
  const script = path.resolve(__dirname, '../../../scripts/store-gemini-api-key.ps1');
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
}

/** Hebrew + English reason shown in the AI panel when Gemini is not ready on Windows. */
export function windowsGeminiMissingReason(reason: string, keyPresent: boolean): string {
  if (keyPresent) {
    return (
      'מפתח Gemini נשמר בלי אישור לפרויקט בתשלום (yahoo-agent). הרץ שוב את סקריפט השמירה וענה y. ' +
      `Gemini key stored without paid-project confirmation; re-run: ${storeGeminiKeyCommand()}`
    );
  }
  if (reason === 'denied' || reason === 'failed' || reason === 'format') {
    return (
      'לא הצלחתי לקרוא את מפתח Gemini מ-Credential Manager. הרץ שוב את סקריפט השמירה. ' +
      `Could not read the Gemini key from Credential Manager (${reason}). Re-run: ${storeGeminiKeyCommand()}`
    );
  }
  return (
    'מפתח Gemini לא נמצא במחשב (Credential Manager). כדי להפעיל: הרץ בחלון PowerShell את הפקודה הבאה והקלד את המפתח בעצמך, ואז לחץ "בדוק שוב". ' +
    `Gemini key not found in Windows Credential Manager. Run: ${storeGeminiKeyCommand()}`
  );
}

export interface GeminiDemoIpcOptions {
  isDemoMode: () => boolean;
  isRealSelectedSummary?: () => boolean;
  isOfflineArchive?: () => boolean;
  env?: NodeJS.ProcessEnv;
  credentials?: { key: string; paidAcknowledged: boolean };
  fetch?: GeminiFetch;
  /** Profile config dir: enables the local usage ledger (gemini-usage.json). */
  configDirPath?: string;
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
    r.mode === 'real-selected-single' ||
    r.mode === 'demo-synthetic' ||
    r.mode === 'offline-archive-selected' ||
    r.mode === 'offline-archive-scoped' ||
    r.mode === 'offline-draft-proofread'
      ? r.mode
      : undefined;
  const allowedMessageId = typeof r.allowedMessageId === 'string' ? r.allowedMessageId : undefined;
  const snapshotEpoch =
    typeof r.snapshotEpoch === 'number' && Number.isFinite(r.snapshotEpoch)
      ? r.snapshotEpoch
      : undefined;
  // Proofreading carries draft text only; any mail passed along is dropped.
  const messages = mode === 'offline-draft-proofread' ? [] : asMessages(r.messages);
  return {
    generation,
    query,
    messages,
    timeoutMs,
    mode,
    allowedMessageId,
    snapshotEpoch,
    scopeFacts:
      mode === 'offline-archive-scoped'
        ? sanitizeGeminiScopeFacts(r.scopeFacts, messages.length)
        : undefined,
  };
}

export function registerGeminiDemoIpcHandlers(ipcMain: IpcMain, opts: GeminiDemoIpcOptions) {
  // Windows offline experiment: credentials come from Credential Manager,
  // read lazily on a status check or an explicit Summarize (never on launch).
  const windowsOffline = () =>
    process.platform === 'win32' &&
    !opts.credentials &&
    !opts.env &&
    !!(opts.isOfflineArchive && opts.isOfflineArchive()) &&
    !opts.isDemoMode();

  const fetchImpl =
    opts.fetch ||
    ((typeof globalThis.fetch === 'function'
      ? (globalThis.fetch.bind(globalThis) as GeminiFetch)
      : undefined) as GeminiFetch | undefined);

  // Offline experiment only (keeps other modes and macOS behavior unchanged).
  let ledgerInstance: GeminiUsageLedger | null = null;
  const getLedger = (): GeminiUsageLedger | null => {
    if (!opts.configDirPath || !(opts.isOfflineArchive && opts.isOfflineArchive())) {
      return null;
    }
    if (!ledgerInstance) {
      ledgerInstance = new GeminiUsageLedger(opts.configDirPath);
    }
    return ledgerInstance;
  };

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_STATUS, async () => {
    if (windowsOffline()) {
      await loadGeminiFromWindowsCredentialManager();
    }
    const status = resolveGeminiDemoStatus({
      demoMode: opts.isDemoMode(),
      realSelectedSummary: opts.isRealSelectedSummary ? opts.isRealSelectedSummary() : false,
      offlineArchive: opts.isOfflineArchive ? opts.isOfflineArchive() : false,
      env: opts.env,
      credentials: opts.credentials,
    });
    if (windowsOffline() && !status.configured) {
      return {
        ...status,
        reason: windowsGeminiMissingReason(getWindowsGeminiCredentialReason(), status.keyPresent),
      };
    }
    return status;
  });

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_QUERY, async (_event, raw: unknown) => {
    const req = parseQuery(raw);
    if (windowsOffline()) {
      await loadGeminiFromWindowsCredentialManager();
    }
    const result = await runGeminiDemoQuery(req, {
      demoMode: opts.isDemoMode(),
      realSelectedSummary: opts.isRealSelectedSummary ? opts.isRealSelectedSummary() : false,
      offlineArchive: opts.isOfflineArchive ? opts.isOfflineArchive() : false,
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
    const ledger = getLedger();
    if (ledger && result.ok === true) {
      const u = result.payload.usage;
      ledger.record({
        model: result.payload.model,
        mode: req.mode || 'demo-synthetic',
        input: u ? u.inputTokens : 0,
        output: u ? u.outputTokens : 0,
        total: u ? u.totalTokens : result.payload.tokensUsed || 0,
      });
    }
    return result;
  });

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_USAGE, () => {
    const ledger = getLedger();
    if (!ledger) {
      return null;
    }
    return ledger.summary();
  });

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_USAGE_RESET, () => {
    const ledger = getLedger();
    if (!ledger) {
      return null;
    }
    ledger.reset();
    return ledger.summary();
  });

  handleFromMailspringWindows(ipcMain, GEMINI_IPC_USAGE_BUDGET, (_event, raw: unknown) => {
    const ledger = getLedger();
    if (!ledger) {
      return null;
    }
    ledger.setBudget(typeof raw === 'number' ? raw : Number(raw));
    return ledger.summary();
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
