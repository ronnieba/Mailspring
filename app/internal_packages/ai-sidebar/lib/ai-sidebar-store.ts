/**
 * Store managing AI sidebar state and conversation history.
 */
import MailspringStore from 'mailspring-store';
import {
  ScopeMode,
  ResolvedScope,
  RetrievalMode,
  ConversationMessage,
  SearchProgress,
  ProcessingBudget,
  AIProvider,
} from './core/types';
import { mockProvider } from './core/mock-provider';
import {
  hostCoverageFooter,
  isAIBoundaryFailure,
  isAIBoundaryOk,
  mockOnlyProviderGuard,
  validateProviderPayload,
} from './core/ai-boundary';
import { nextQueryGeneration, shouldAcceptAssistantResponse } from './core/query-generation';
import { mailspringAdapter } from './mailspring-adapter';
import { DemoMessagePreview, getDemoMessagePreview, isDemoMode } from './synthetic-demo';

const DEFAULT_BUDGET: ProcessingBudget = {
  maxMessages: 100,
  maxTokens: 10000,
  timeoutMs: 30000,
};

const MAX_MESSAGES_PER_BATCH = 50;

interface AISidebarState {
  scopeMode: ScopeMode;
  resolvedScope: ResolvedScope | null;
  retrievalMode: RetrievalMode;
  conversation: ConversationMessage[];
  isProcessing: boolean;
  progress: SearchProgress | null;
  error: string | null;
  abortController: AbortController | null;
  demoPreview: DemoMessagePreview | null;
}

class AISidebarStore extends MailspringStore {
  private _state: AISidebarState = {
    // Demo has no real thread selection. all-mail still uses synthetic fixtures.
    scopeMode: isDemoMode() ? 'all-mail' : 'selected-messages',
    resolvedScope: null,
    retrievalMode: 'ranked',
    conversation: [],
    isProcessing: false,
    progress: null,
    error: null,
    abortController: null,
    demoPreview: null,
  };

  private _provider: AIProvider = mockProvider;
  private _queryGeneration = 0;

  getState(): Readonly<AISidebarState> {
    return this._state;
  }

  getProvider(): AIProvider {
    return this._provider;
  }

  /**
   * Set provider. Live generation is disabled; only a marked mock is accepted.
   */
  setProvider(provider: AIProvider) {
    const blocked = mockOnlyProviderGuard(provider.isMock);
    if (blocked) {
      throw new Error(blocked.message);
    }
    if (!provider.isConfigured) {
      throw new Error('Provider is not configured');
    }
    this._provider = provider;
  }

  /**
   * Set scope mode and resolve it.
   */
  async setScopeMode(mode: ScopeMode) {
    this._state.scopeMode = mode;
    await this._resolveScope();
    this.trigger();
  }

  /**
   * Set retrieval mode (ranked vs exhaustive).
   */
  setRetrievalMode(mode: RetrievalMode) {
    this._state.retrievalMode = mode;
    this.trigger();
  }

  /**
   * Refresh the resolved scope based on current UI state.
   */
  async refreshScope() {
    await this._resolveScope();
    this.trigger();
  }

  private async _resolveScope() {
    try {
      this._state.resolvedScope = await mailspringAdapter.resolveScope(this._state.scopeMode);
      this._state.error = null;
    } catch (err) {
      this._state.error = `Failed to resolve scope: ${(err as Error).message}`;
      this._state.resolvedScope = null;
    }
  }

  /**
   * Submit a query to the AI provider.
   */
  async submitQuery(query: string) {
    if (this._state.isProcessing) {
      return;
    }

    if (!query.trim()) {
      return;
    }

    // Refresh scope before querying
    await this._resolveScope();

    const scope = this._state.resolvedScope;
    if (!scope) {
      this._state.error = 'No scope available';
      this.trigger();
      return;
    }

    // Add user message to conversation
    const userMessage: ConversationMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: new Date(),
    };
    this._state.conversation.push(userMessage);

    const startedGeneration = nextQueryGeneration(this._queryGeneration);
    this._queryGeneration = startedGeneration;
    this._state.isProcessing = true;
    this._state.error = null;
    this._state.abortController = new AbortController();
    this._state.progress = {
      totalEligible: null,
      processed: 0,
      withBodies: 0,
      missingBodies: 0,
      syncCoverage: null,
      isComplete: false,
      isCancelled: false,
    };
    this.trigger();

    const stillCurrent = () =>
      shouldAcceptAssistantResponse({
        startedGeneration,
        currentGeneration: this._queryGeneration,
        aborted: !!this._state.abortController?.signal.aborted,
      });

    try {
      const searchResult = await mailspringAdapter.searchMessages(
        scope,
        query,
        this._state.retrievalMode,
        MAX_MESSAGES_PER_BATCH,
        0,
        this._state.abortController.signal
      );

      if (!stillCurrent()) {
        return;
      }

      const syncProgress = await mailspringAdapter.getSyncProgress(scope.accountIds);
      const avgSync =
        Object.values(syncProgress).reduce((a, b) => a + b, 0) /
        Math.max(Object.keys(syncProgress).length, 1);

      this._state.progress = {
        ...searchResult.progress,
        syncCoverage: avgSync,
      };
      this.trigger();

      const result = await this._provider.processQuery(
        query,
        searchResult.messages,
        scope,
        DEFAULT_BUDGET,
        (progress) => {
          if (!stillCurrent()) {
            return;
          }
          this._state.progress = {
            ...progress,
            totalEligible: searchResult.progress.totalEligible,
            processed:
              searchResult.retrievalMode === 'exhaustive'
                ? searchResult.progress.processed
                : progress.processed,
          };
          this.trigger();
        },
        this._state.abortController.signal
      );

      if (!stillCurrent()) {
        return;
      }

      const allowedSourceIds = new Set(searchResult.messages.map((m) => m.id));
      const validated = validateProviderPayload(
        {
          response: result.response,
          citations: result.citations,
          tokensUsed: result.tokensUsed,
          isMock: this._provider.isMock,
          mockLabel: this._provider.name,
        },
        {
          allowedSourceIds,
          startedGeneration,
          currentGeneration: this._queryGeneration,
          aborted: !!this._state.abortController?.signal.aborted,
        }
      );
      if (!isAIBoundaryOk(validated)) {
        if (isAIBoundaryFailure(validated)) {
          this._state.error = validated.message;
          this._state.conversation.push({
            id: `error-${Date.now()}`,
            role: 'system',
            content: `❌ שגיאה: תשובה נדחתה (fail-closed, origin=${validated.origin}). ${validated.message}`,
            timestamp: new Date(),
          });
        }
        return;
      }

      const coverage = hostCoverageFooter(searchResult, avgSync);
      const responseContent = `${validated.result.response}\n\n---\n${coverage}`;

      const assistantMessage: ConversationMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: responseContent,
        citations: validated.result.citations,
        timestamp: new Date(),
        isMock: true,
      };
      this._state.conversation.push(assistantMessage);
    } catch (err) {
      if (!stillCurrent()) {
        return;
      }
      const errorMsg = (err as Error).message;
      if (errorMsg !== 'Operation cancelled') {
        this._state.error = errorMsg;
        const errorMessage: ConversationMessage = {
          id: `error-${Date.now()}`,
          role: 'system',
          content: `❌ שגיאה: ${errorMsg}`,
          timestamp: new Date(),
        };
        this._state.conversation.push(errorMessage);
      }
    } finally {
      if (startedGeneration === this._queryGeneration) {
        this._state.isProcessing = false;
        this._state.abortController = null;
        this.trigger();
      }
    }
  }

  /**
   * Cancel ongoing operation. Increments generation so a late mock response
   * cannot attach after Cancel.
   */
  cancel() {
    this._queryGeneration = nextQueryGeneration(this._queryGeneration);
    if (this._state.abortController) {
      this._state.abortController.abort();
    }
    this._state.isProcessing = false;
    this._state.abortController = null;
    this._state.progress = this._state.progress
      ? { ...this._state.progress, isCancelled: true, isComplete: false }
      : null;
    this.trigger();
  }

  /**
   * Clear conversation history.
   */
  clearConversation() {
    this.cancel();
    this._state.conversation = [];
    this._state.error = null;
    this._state.progress = null;
    this._state.demoPreview = null;
    this.trigger();
  }

  closeDemoPreview() {
    this._state.demoPreview = null;
    this.trigger();
  }

  /**
   * Navigate to a cited message. Demo opens a fixture-only preview in the
   * sidebar — never a production mailbox or account.
   */
  async navigateToCitation(messageId: string): Promise<boolean> {
    if (isDemoMode()) {
      console.log(`[AI Sidebar Demo] Would navigate to message: ${messageId}`);
      const preview = getDemoMessagePreview(messageId);
      this._state.demoPreview = preview;
      this.trigger();
      if (preview) {
        console.log(`[AI Sidebar Demo] Opened DEMO fixture preview: ${messageId}`);
        return true;
      }
      return false;
    }
    return mailspringAdapter.navigateToMessage(messageId, true);
  }
}

export default new AISidebarStore();
