/**
 * Renderer IPC transport. The API key never crosses this boundary.
 */
import { ipcRenderer } from 'electron';
import {
  GeminiScopeFacts,
  GEMINI_IPC_CANCEL,
  GEMINI_IPC_QUERY,
  GEMINI_IPC_STATUS,
  GEMINI_IPC_USAGE,
  GEMINI_IPC_USAGE_BUDGET,
  GEMINI_IPC_USAGE_RESET,
  GeminiDemoStatus,
  GeminiUsageSummary,
  GeminiHostResult,
} from '../../../src/browser/gemini-demo-protocol';
import { GeminiDemoTransport } from './core/gemini-demo-provider';
import { MessageRef } from './core/types';

export function createGeminiIpcTransport(): GeminiDemoTransport {
  return {
    status(): Promise<GeminiDemoStatus> {
      return ipcRenderer.invoke(GEMINI_IPC_STATUS);
    },
    query(req: {
      generation: number;
      query: string;
      messages: MessageRef[];
      timeoutMs?: number;
      mode?:
        | 'demo-synthetic'
        | 'real-selected-single'
        | 'offline-archive-selected'
        | 'offline-archive-scoped'
        | 'offline-draft-proofread';
      allowedMessageId?: string;
      snapshotEpoch?: number;
      scopeFacts?: GeminiScopeFacts;
    }): Promise<GeminiHostResult> {
      return ipcRenderer.invoke(GEMINI_IPC_QUERY, req);
    },
    cancel(generation: number): Promise<{ aborted: boolean }> {
      return ipcRenderer.invoke(GEMINI_IPC_CANCEL, generation);
    },
  };
}

/**
 * Local drafts: proofread one draft with Gemini (explicit click only).
 * Sends the draft text and nothing else; the main process records usage.
 */
export function proofreadDraftViaIpc(
  generation: number,
  draftText: string
): Promise<GeminiHostResult> {
  return ipcRenderer.invoke(GEMINI_IPC_QUERY, {
    generation,
    query: draftText,
    messages: [],
    mode: 'offline-draft-proofread',
  });
}

/** The only fields the open-draft assist ever sends (see buildDraftAssistRequest). */
/** One earlier turn of the same draft conversation (sent only on click). */
export interface DraftHistoryIpcTurn {
  instruction: string;
  output: string;
  subject?: string;
  applied?: 'replace' | 'append' | null;
}

export interface DraftAssistIpcRequest {
  request: string;
  draftText: string;
  draftSubject?: string;
  draftHistory?: DraftHistoryIpcTurn[];
}

/**
 * Local drafts: ask Gemini about the open draft (explicit Send only).
 * Sends the user's request + the draft's plain text (+ subject only when
 * ticked). Never recipients, never mail. The main process records usage.
 */
export function draftAssistViaIpc(
  generation: number,
  req: DraftAssistIpcRequest
): Promise<GeminiHostResult> {
  const payload: Record<string, unknown> = {
    generation,
    query: req.request,
    messages: [],
    mode: 'offline-draft-assist',
    draftText: req.draftText,
  };
  if (typeof req.draftSubject === 'string') {
    payload.draftSubject = req.draftSubject;
  }
  if (Array.isArray(req.draftHistory) && req.draftHistory.length) {
    payload.draftHistory = req.draftHistory;
  }
  return ipcRenderer.invoke(GEMINI_IPC_QUERY, payload);
}

/** Write with AI: the only fields ever sent (see buildComposeRequest). */
export interface DraftComposeIpcRequest {
  request: string;
  draftText: string;
  draftSubject?: string;
  composeKind: 'new' | 'reply' | 'forward';
  composeContext?: string;
  draftHistory?: DraftHistoryIpcTurn[];
}

/**
 * Local drafts, "write with AI" (explicit Send only): instruction + the
 * draft's own text (+ subject if ticked) + for a reply/forward the original
 * as plain text. No attachments, no draft recipients. Usage is recorded by
 * the main process like every other mode.
 */
export function draftComposeViaIpc(
  generation: number,
  req: DraftComposeIpcRequest
): Promise<GeminiHostResult> {
  const payload: Record<string, unknown> = {
    generation,
    query: req.request,
    messages: [],
    mode: 'offline-draft-compose',
    draftText: req.draftText,
    composeKind: req.composeKind,
  };
  if (typeof req.draftSubject === 'string') {
    payload.draftSubject = req.draftSubject;
  }
  if (Array.isArray(req.draftHistory) && req.draftHistory.length) {
    payload.draftHistory = req.draftHistory;
  }
  if (typeof req.composeContext === 'string') {
    payload.composeContext = req.composeContext;
  }
  return ipcRenderer.invoke(GEMINI_IPC_QUERY, payload);
}

/** Local usage ledger (main process). Counts and estimates only. */
export const geminiUsageIpc = {
  get(): Promise<GeminiUsageSummary | null> {
    return ipcRenderer.invoke(GEMINI_IPC_USAGE);
  },
  reset(): Promise<GeminiUsageSummary | null> {
    return ipcRenderer.invoke(GEMINI_IPC_USAGE_RESET);
  },
  setBudget(ils: number): Promise<GeminiUsageSummary | null> {
    return ipcRenderer.invoke(GEMINI_IPC_USAGE_BUDGET, ils);
  },
};
