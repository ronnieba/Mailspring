/**
 * Renderer-side Gemini DEMO provider. Network is IPC to the main-process host.
 * isMock is false only after the host returns a live payload; errors throw
 * and must not be replaced with mock fixtures.
 */
import {
  AIProvider,
  Citation,
  MessageRef,
  ProcessingBudget,
  ResolvedScope,
  SearchProgress,
} from './types';
import {
  GEMINI_DISPLAY_NAME,
  GeminiDemoStatus,
  GeminiHostResult,
  isGeminiHostFailure,
  isGeminiHostOk,
  unconfiguredGeminiStatus,
} from '../../../../src/browser/gemini-demo-protocol';

export interface GeminiDemoTransport {
  status(): Promise<GeminiDemoStatus>;
  query(req: {
    generation: number;
    query: string;
    messages: MessageRef[];
    timeoutMs?: number;
    mode?: 'demo-synthetic' | 'real-selected-single' | 'offline-archive-selected';
    allowedMessageId?: string;
    snapshotEpoch?: number;
  }): Promise<GeminiHostResult>;
  cancel(generation: number): Promise<{ aborted: boolean }>;
}

export class GeminiDemoProvider implements AIProvider {
  readonly name = GEMINI_DISPLAY_NAME;
  readonly isMock = false;
  private _configured = false;
  private _generation = 0;
  private _queryExtras: {
    mode?: 'demo-synthetic' | 'real-selected-single' | 'offline-archive-selected';
    allowedMessageId?: string;
    snapshotEpoch?: number;
  } = {};

  constructor(private readonly transport: GeminiDemoTransport) {}

  get isConfigured(): boolean {
    return this._configured;
  }

  async refreshStatus(): Promise<GeminiDemoStatus> {
    try {
      const status = await this.transport.status();
      this._configured = !!status.configured;
      return status;
    } catch {
      this._configured = false;
      return unconfiguredGeminiStatus(false, 'Gemini status IPC unavailable');
    }
  }

  setGeneration(generation: number) {
    this._generation = generation;
  }

  setQueryExtras(extras: {
    mode?: 'demo-synthetic' | 'real-selected-single' | 'offline-archive-selected';
    allowedMessageId?: string;
    snapshotEpoch?: number;
  }) {
    this._queryExtras = extras;
  }

  async cancel(generation: number = this._generation): Promise<void> {
    try {
      await this.transport.cancel(generation);
    } catch {
      // Local cancel is best-effort; the provider may still bill.
    }
  }

  async processQuery(
    query: string,
    messages: MessageRef[],
    _scope: ResolvedScope,
    budget: ProcessingBudget,
    onProgress?: (progress: SearchProgress) => void,
    signal?: AbortSignal
  ): Promise<{ response: string; citations: Citation[]; tokensUsed: number }> {
    if (signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    const generation = this._generation;
    const onAbort = () => {
      void this.cancel(generation);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (onProgress) {
      onProgress({
        totalEligible: messages.length,
        processed: 0,
        withBodies: messages.length,
        missingBodies: 0,
        syncCoverage: null,
        isComplete: false,
        isCancelled: false,
      });
    }

    try {
      const result = await this.transport.query({
        generation,
        query,
        messages,
        timeoutMs: budget.timeoutMs,
        ...this._queryExtras,
      });
      if (signal?.aborted) {
        throw new Error('Operation cancelled');
      }
      if (isGeminiHostFailure(result)) {
        if (result.reason === 'cancelled' || signal?.aborted) {
          throw new Error('Operation cancelled');
        }
        throw new Error(result.message);
      }
      if (!isGeminiHostOk(result) || result.payload.isMock !== false) {
        throw new Error('Live Gemini payload was not marked isMock: false');
      }
      if (onProgress) {
        onProgress({
          totalEligible: messages.length,
          processed: messages.length,
          withBodies: messages.length,
          missingBodies: 0,
          syncCoverage: 100,
          isComplete: true,
          isCancelled: false,
        });
      }
      return {
        response: result.payload.response,
        citations: result.payload.citations as Citation[],
        tokensUsed: result.payload.tokensUsed,
      };
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }
}
