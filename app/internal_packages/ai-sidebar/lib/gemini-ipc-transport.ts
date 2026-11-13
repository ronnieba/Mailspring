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
