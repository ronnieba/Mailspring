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
import { mailspringAdapter } from './mailspring-adapter';

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
}

class AISidebarStore extends MailspringStore {
  private _state: AISidebarState = {
    scopeMode: 'selected-messages',
    resolvedScope: null,
    retrievalMode: 'ranked',
    conversation: [],
    isProcessing: false,
    progress: null,
    error: null,
    abortController: null,
  };

  private _provider: AIProvider = mockProvider;

  getState(): Readonly<AISidebarState> {
    return this._state;
  }

  getProvider(): AIProvider {
    return this._provider;
  }

  /**
   * Set provider. In this prototype, only mock is available.
   */
  setProvider(provider: AIProvider) {
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

    // Start processing
    this._state.isProcessing = true;
    this._state.error = null;
    this._state.abortController = new AbortController();
    this.trigger();

    try {
      // Search for messages in scope
      const searchResult = await mailspringAdapter.searchMessages(
        scope,
        query,
        this._state.retrievalMode,
        MAX_MESSAGES_PER_BATCH,
        0,
        this._state.abortController.signal
      );

      if (this._state.abortController.signal.aborted) {
        throw new Error('Operation cancelled');
      }

      // Get sync progress
      const syncProgress = await mailspringAdapter.getSyncProgress(scope.accountIds);
      const avgSync =
        Object.values(syncProgress).reduce((a, b) => a + b, 0) /
        Math.max(Object.keys(syncProgress).length, 1);

      // Update progress with sync info
      this._state.progress = {
        ...searchResult.progress,
        syncCoverage: avgSync,
      };
      this.trigger();

      // Process with AI provider
      const result = await this._provider.processQuery(
        query,
        searchResult.messages,
        scope,
        DEFAULT_BUDGET,
        (progress) => {
          this._state.progress = progress;
          this.trigger();
        },
        this._state.abortController.signal
      );

      // Build assistant response with coverage disclosure
      let responseContent = result.response;

      // Add coverage disclosure
      const coverage = this._buildCoverageDisclosure(searchResult, avgSync);
      responseContent += `\n\n---\n${coverage}`;

      // Add assistant message
      const assistantMessage: ConversationMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: responseContent,
        citations: result.citations,
        timestamp: new Date(),
        isMock: this._provider.isMock,
      };
      this._state.conversation.push(assistantMessage);
    } catch (err) {
      const errorMsg = (err as Error).message;
      if (errorMsg !== 'Operation cancelled') {
        this._state.error = errorMsg;

        // Add error message to conversation
        const errorMessage: ConversationMessage = {
          id: `error-${Date.now()}`,
          role: 'system',
          content: `❌ שגיאה: ${errorMsg}`,
          timestamp: new Date(),
        };
        this._state.conversation.push(errorMessage);
      }
    } finally {
      this._state.isProcessing = false;
      this._state.abortController = null;
      this.trigger();
    }
  }

  private _buildCoverageDisclosure(searchResult: any, syncCoverage: number): string {
    const { progress, retrievalMode } = searchResult;
    const lines: string[] = [];

    lines.push('**📊 כיסוי ומצב:**');

    if (retrievalMode === 'ranked') {
      lines.push(`• מצב: דירוג (top-k) - לא סריקה מלאה`);
      if (progress.processed !== null) {
        lines.push(`• הודעות שעובדו: ${progress.processed}`);
      }
      lines.push(`⚠️ לא כל ההודעות נסרקו - תוצאות מדורגות בלבד`);
    } else {
      if (progress.totalEligible !== null) {
        lines.push(`• סה"כ בטווח: ${progress.totalEligible}`);
      } else {
        lines.push(`• סה"כ בטווח: לא ידוע`);
      }
      lines.push(`• עובדו: ${progress.processed}`);

      if (!progress.isComplete) {
        lines.push(`⚠️ סריקה לא הושלמה`);
      }
    }

    if (progress.missingBodies > 0) {
      lines.push(`⚠️ ${progress.missingBodies} הודעות ללא גוף (לא סונכרנו)`);
    }

    if (syncCoverage < 100) {
      lines.push(`• סנכרון: ${syncCoverage.toFixed(0)}%`);
    }

    return lines.join('\n');
  }

  /**
   * Cancel ongoing operation.
   */
  cancel() {
    if (this._state.abortController) {
      this._state.abortController.abort();
    }
  }

  /**
   * Clear conversation history.
   */
  clearConversation() {
    this._state.conversation = [];
    this._state.error = null;
    this._state.progress = null;
    this.trigger();
  }

  /**
   * Navigate to a cited message.
   * Returns whether navigation preserves read state.
   */
  async navigateToCitation(messageId: string): Promise<boolean> {
    return mailspringAdapter.navigateToMessage(messageId, true);
  }
}

export default new AISidebarStore();
