/**
 * Store managing AI sidebar state and conversation history.
 */
import MailspringStore from 'mailspring-store';
import {
  Citation,
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
  NON_SYNTHETIC_LIVE_REASON,
  validateProviderPayload,
} from './core/ai-boundary';
import { GeminiDemoProvider } from './core/gemini-demo-provider';
import { nextQueryGeneration, shouldAcceptAssistantResponse } from './core/query-generation';
import { createGeminiIpcTransport } from './gemini-ipc-transport';
import { mailspringAdapter } from './mailspring-adapter';
import {
  areSyntheticDemoSources,
  DemoMessagePreview,
  getDemoMessagePreview,
  isDemoMode,
} from './synthetic-demo';
import {
  formatOfflineArchiveDisclosure,
  formatRealSelectedDisclosure,
  isStaleRealSelectedSnapshot,
  prepareRealSelectedBody,
  REAL_SELECTED_QUERY,
  RealSelectedPreview,
} from './core/real-selected-mail';
import {
  buildOfflineGeminiContext,
  isOfflineArchiveBrowserDriven,
  navigateOfflineArchive,
  setOfflineArchiveSelected,
} from './offline-archive-catalog';
import { isRealSelectedSummaryMode } from '../../../src/real-selected-summary';
import { isOfflineArchiveMode } from '../../../src/offline-archive';
import {
  GEMINI_DISPLAY_NAME,
  GeminiDemoStatus,
  OFFLINE_ARCHIVE_SCOPE_REASON,
  REAL_SELECTED_SCOPE_REASON,
  unconfiguredGeminiStatus,
} from '../../../src/browser/gemini-demo-protocol';

function isExplicitSelectedSurface(): boolean {
  return !isDemoMode() && (isRealSelectedSummaryMode() || isOfflineArchiveMode());
}

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
  realPreview: RealSelectedPreview | null;
  geminiStatus: GeminiDemoStatus;
  /** Offline Gemini Send: 'local' while searching the copy, 'gemini' while waiting. */
  progressPhase: 'local' | 'gemini' | null;
}

const OFFLINE_SEND_TIMEOUT_MS = 60000;

class AISidebarStore extends MailspringStore {
  private _state: AISidebarState = {
    // Demo has no real thread selection. all-mail still uses synthetic fixtures.
    // Real-selected-summary is always selected-messages (exactly one).
    scopeMode: isDemoMode() ? 'all-mail' : 'selected-messages',
    resolvedScope: null,
    retrievalMode: 'ranked',
    conversation: [],
    isProcessing: false,
    progress: null,
    error: null,
    abortController: null,
    demoPreview: null,
    realPreview: null,
    geminiStatus: unconfiguredGeminiStatus(isDemoMode(), 'Gemini status not refreshed yet'),
    progressPhase: null,
  };
  private _realSnapshotEpoch = 0;
  private _inFlightMessageId: string | null = null;
  private _inFlightSnapshotEpoch = 0;

  private _provider: AIProvider = mockProvider;
  private _gemini = new GeminiDemoProvider(createGeminiIpcTransport());
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
    // Offline experiment: all three scopes run locally against the mock
    // provider. Live real-selected-summary stays one-selected-message only.
    if (isRealSelectedSummaryMode() && !isOfflineArchiveMode() && mode !== 'selected-messages') {
      this._state.error = 'Folder and all-mail are disabled for one-selected-message summary';
      this._state.scopeMode = 'selected-messages';
      await this._resolveScope();
      this.trigger();
      return;
    }
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
    await this._refreshRealPreview();
    await this.refreshGeminiStatus();
    this.trigger();
  }

  async refreshGeminiStatus() {
    if (isDemoMode()) {
      this._state.geminiStatus = await this._gemini.refreshStatus();
      return;
    }
    if (isRealSelectedSummaryMode() || isOfflineArchiveMode()) {
      this._state.geminiStatus = await this._gemini.refreshStatus();
      return;
    }
    this._state.geminiStatus = unconfiguredGeminiStatus(false, 'Gemini DEMO host is --demo only');
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

  private async _refreshRealPreview() {
    if (!isExplicitSelectedSurface()) {
      this._state.realPreview = null;
      return;
    }
    const scope = this._state.resolvedScope;
    const messageId =
      scope && !scope.isEmpty && scope.messageIds?.length === 1 ? scope.messageIds[0] : null;
    if (
      this._state.isProcessing &&
      this._inFlightMessageId &&
      this._inFlightMessageId !== messageId
    ) {
      this.cancel();
    }
    if (!messageId || !scope) {
      this._state.realPreview = null;
      return;
    }
    const html = (await mailspringAdapter.getMessageBody(messageId)) || '';
    const attachmentCount = await mailspringAdapter.getMessageAttachmentCount(messageId);
    const prepared = prepareRealSelectedBody(html, attachmentCount);
    const search = await mailspringAdapter.searchMessages(scope, '', 'ranked', 1, 0);
    const ref = search.messages[0];
    if (!ref || ref.id !== messageId) {
      this._state.realPreview = null;
      return;
    }
    if (this._state.realPreview?.messageId !== messageId) {
      this._realSnapshotEpoch += 1;
    }
    this._state.realPreview = {
      snapshotEpoch: this._realSnapshotEpoch,
      messageId,
      threadId: ref.threadId,
      subject: ref.subject,
      from: ref.from,
      date: String(ref.date),
      snippet: ref.snippet,
      bodyPreview: prepared.bodyText,
      disclosure: isOfflineArchiveMode()
        ? formatOfflineArchiveDisclosure(prepared)
        : formatRealSelectedDisclosure(prepared),
      quotedStripped: prepared.quotedStripped,
      truncated: prepared.truncated,
      attachmentCount: prepared.attachmentCount,
    };
  }

  /**
   * Submit a query to the AI provider.
   * Real-selected-summary refuses free-form search; use summarizeSelectedMessage.
   */
  async submitQuery(
    query: string,
    opts?: {
      allowRealSelected?: boolean;
      sentSnapshot?: { messageId: string; snapshotEpoch: number };
    }
  ) {
    if (isExplicitSelectedSurface() && !isOfflineArchiveMode() && !opts?.allowRealSelected) {
      this._state.error =
        'Use Summarize for the one selected message. Free-form mailbox search is disabled.';
      this.trigger();
      return;
    }
    if (this._state.isProcessing) {
      return;
    }

    if (!query.trim()) {
      return;
    }

    // Refresh scope before querying. Real path also rebuilds the preview; this
    // does not generate. A changed selection after Summarize is fail-closed.
    await this._resolveScope();
    if (opts?.allowRealSelected) {
      await this._refreshRealPreview();
      const current = this._state.realPreview;
      if (
        !opts.sentSnapshot ||
        isStaleRealSelectedSnapshot(opts.sentSnapshot, {
          messageId: current?.messageId ?? null,
          snapshotEpoch: current?.snapshotEpoch ?? -1,
        })
      ) {
        this._state.error = REAL_SELECTED_SCOPE_REASON;
        this.trigger();
        return;
      }
    }

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
    if (opts?.sentSnapshot) {
      this._inFlightMessageId = opts.sentSnapshot.messageId;
      this._inFlightSnapshotEpoch = opts.sentSnapshot.snapshotEpoch;
    } else {
      this._inFlightMessageId = null;
      this._inFlightSnapshotEpoch = 0;
    }
    this.trigger();

    const stillCurrent = () =>
      shouldAcceptAssistantResponse({
        startedGeneration,
        currentGeneration: this._queryGeneration,
        aborted: !!this._state.abortController?.signal.aborted,
      });

    try {
      await this.refreshGeminiStatus();
      // Offline experiment: when Gemini is connected, Send asks Gemini about the
      // chosen scope (local retrieval first, bounded set). Mock only when off.
      if (
        isOfflineArchiveMode() &&
        !isDemoMode() &&
        !opts?.allowRealSelected &&
        isOfflineArchiveBrowserDriven() &&
        this._state.geminiStatus.configured
      ) {
        await this._runOfflineGeminiSend(query, scope, startedGeneration, stillCurrent);
        return;
      }
      const searchResult = await mailspringAdapter.searchMessages(
        scope,
        query,
        this._state.retrievalMode,
        MAX_MESSAGES_PER_BATCH,
        0,
        this._state.abortController.signal
      );
      if (opts?.allowRealSelected) {
        if (
          searchResult.messages.length !== 1 ||
          searchResult.messages[0].id !== this._inFlightMessageId
        ) {
          this._state.error = REAL_SELECTED_SCOPE_REASON;
          this._state.conversation.push({
            id: `error-${Date.now()}`,
            role: 'system',
            content: `❌ שגיאה: ${REAL_SELECTED_SCOPE_REASON}`,
            timestamp: new Date(),
          });
          return;
        }
        const html = (await mailspringAdapter.getMessageBody(searchResult.messages[0].id)) || '';
        const attachmentCount = await mailspringAdapter.getMessageAttachmentCount(
          searchResult.messages[0].id
        );
        const prepared = prepareRealSelectedBody(html, attachmentCount);
        searchResult.messages[0] = {
          ...searchResult.messages[0],
          snippet: searchResult.messages[0].snippet,
          bodyText: prepared.bodyText,
        };
      }

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

      const sourcesAreSynthetic = areSyntheticDemoSources(searchResult.messages);
      const useGeminiDemo = isDemoMode() && this._state.geminiStatus.configured;
      // Gemini is reached only through the explicit Summarize action. Free-form
      // offline questions always use the local mock provider (no network).
      const useGeminiReal =
        isExplicitSelectedSurface() &&
        this._state.geminiStatus.configured &&
        !!opts?.allowRealSelected;
      const useGemini = useGeminiDemo || useGeminiReal;
      const selectedScopeReason = isOfflineArchiveMode()
        ? OFFLINE_ARCHIVE_SCOPE_REASON
        : REAL_SELECTED_SCOPE_REASON;
      if (useGeminiDemo && !sourcesAreSynthetic) {
        this._state.error = NON_SYNTHETIC_LIVE_REASON;
        this._state.conversation.push({
          id: `error-${Date.now()}`,
          role: 'system',
          content: `❌ שגיאה: ${NON_SYNTHETIC_LIVE_REASON}`,
          timestamp: new Date(),
        });
        return;
      }
      if (useGeminiReal && (sourcesAreSynthetic || searchResult.messages.length !== 1)) {
        this._state.error = selectedScopeReason;
        this._state.conversation.push({
          id: `error-${Date.now()}`,
          role: 'system',
          content: `❌ שגיאה: ${selectedScopeReason}`,
          timestamp: new Date(),
        });
        return;
      }

      const provider = useGemini ? this._gemini : this._provider;
      if (useGemini) {
        this._gemini.setGeneration(startedGeneration);
        if (useGeminiReal) {
          this._gemini.setQueryExtras({
            mode: isOfflineArchiveMode() ? 'offline-archive-selected' : 'real-selected-single',
            allowedMessageId: this._inFlightMessageId || searchResult.messages[0].id,
            snapshotEpoch: this._inFlightSnapshotEpoch,
          });
        } else {
          this._gemini.setQueryExtras({});
        }
      }
      const result = await provider.processQuery(
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
          isMock: useGemini ? false : true,
          mockLabel: useGemini ? GEMINI_DISPLAY_NAME : this._provider.name,
        },
        {
          allowedSourceIds,
          startedGeneration,
          currentGeneration: this._queryGeneration,
          aborted: !!this._state.abortController?.signal.aborted,
          allowLiveSynthetic: useGeminiDemo,
          allowLiveRealSelectedSingle: useGeminiReal,
          sourcesAreSynthetic,
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
        isMock: validated.result.isMock,
      };
      this._state.conversation.push(assistantMessage);
    } catch (err) {
      // Live Gemini failures stay errors. Never substitute mock fixtures.
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
        this._state.progressPhase = null;
        this.trigger();
      }
    }
  }

  /**
   * Offline Send with Gemini over the resolved scope. Local search first (no
   * network), then ONE request with at most 30 cleaned plain-text messages.
   * Throws on failure; never substitutes mock answers for Gemini errors.
   */
  private async _runOfflineGeminiSend(
    query: string,
    scope: ResolvedScope,
    startedGeneration: number,
    stillCurrent: () => boolean
  ) {
    const signal = this._state.abortController.signal;
    this._state.progressPhase = 'local';
    this.trigger();
    const ctx = await buildOfflineGeminiContext(scope, query, {
      signal,
      onProgress: (scanned, toScan) => {
        if (!stillCurrent()) {
          return;
        }
        this._state.progress = {
          totalEligible: toScan,
          processed: scanned,
          withBodies: scanned,
          missingBodies: 0,
          syncCoverage: 100,
          isComplete: false,
          isCancelled: false,
        };
        this.trigger();
      },
    });
    if (!stillCurrent()) {
      return;
    }
    if (ctx.messages.length === 0) {
      this._state.conversation.push({
        id: `system-${Date.now()}`,
        role: 'system',
        content: 'לא נמצאו הודעות בטווח הזה. לא נשלח דבר ל-Gemini.',
        timestamp: new Date(),
      });
      return;
    }
    this._state.progressPhase = 'gemini';
    this._state.progress = {
      totalEligible: ctx.sent,
      processed: ctx.sent,
      withBodies: ctx.sent,
      missingBodies: 0,
      syncCoverage: 100,
      isComplete: false,
      isCancelled: false,
    };
    this.trigger();

    this._gemini.setGeneration(startedGeneration);
    this._gemini.setQueryExtras({ mode: 'offline-archive-scoped' });
    const result = await this._gemini.processQuery(
      query,
      ctx.messages,
      scope,
      { ...DEFAULT_BUDGET, timeoutMs: OFFLINE_SEND_TIMEOUT_MS },
      undefined,
      signal
    );
    if (!stillCurrent()) {
      return;
    }
    // Rebuild citations from the local copy: the model often returns only the
    // id. Ids that were not sent are dropped (never shown, never opened).
    const sentById = new Map(ctx.messages.map((m) => [m.id, m]));
    const citations: Citation[] = [];
    for (const c of Array.isArray(result.citations) ? result.citations : []) {
      const m = c ? sentById.get(c.messageId) : undefined;
      if (!m || citations.some((x) => x.messageId === m.id)) {
        continue;
      }
      citations.push({
        messageId: m.id,
        threadId: m.threadId || m.id,
        subject: m.subject || '(ללא נושא)',
        from: m.from || '(לא ידוע)',
        date: m.date,
        snippet: m.snippet || '',
      });
    }
    const validated = validateProviderPayload(
      {
        response: result.response,
        citations,
        tokensUsed: result.tokensUsed,
        isMock: false,
        mockLabel: GEMINI_DISPLAY_NAME,
      },
      {
        allowedSourceIds: new Set(ctx.messages.map((m) => m.id)),
        startedGeneration,
        currentGeneration: this._queryGeneration,
        aborted: !!this._state.abortController?.signal.aborted,
        allowLiveOfflineScoped: true,
        sourcesAreSynthetic: false,
      }
    );
    if (!isAIBoundaryOk(validated)) {
      if (isAIBoundaryFailure(validated)) {
        this._state.error = validated.message;
        this._state.conversation.push({
          id: `error-${Date.now()}`,
          role: 'system',
          content: `❌ שגיאה: תשובת Gemini נדחתה (${validated.reason}). ${validated.message}`,
          timestamp: new Date(),
        });
      }
      return;
    }
    const scopeWord =
      scope.mode === 'selected-messages'
        ? 'בהודעות שנבחרו'
        : scope.mode === 'current-folder'
          ? 'בתיקייה'
          : 'בכל העותק המקומי';
    const coverage =
      scope.mode === 'selected-messages'
        ? `🔎 נשלחו ל-Gemini ${ctx.sent} מתוך ${ctx.inScope} ההודעות שנבחרו (טקסט בלבד, בלי קבצים מצורפים).`
        : `🔎 חיפוש מקומי ${scopeWord}: ${ctx.inScope.toLocaleString()} הודעות, נקראו ${ctx.scanned}, ` +
          `התאימו לשאלה ${ctx.matched}. נשלחו ל-Gemini ${ctx.sent} הרלוונטיות ביותר ` +
          `(טקסט בלבד, בלי קבצים מצורפים).` +
          (ctx.matched === 0
            ? ' לא נמצאה התאמה למילים בשאלה, לכן נשלחו ההודעות החדשות ביותר.'
            : '');
    const tokens = validated.result.tokensUsed ? ` · ${validated.result.tokensUsed} טוקנים` : '';
    this._state.conversation.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: `${validated.result.response}\n\n---\n${coverage}${tokens}`,
      citations: validated.result.citations,
      timestamp: new Date(),
      isMock: false,
    });
  }

  /**
   * Opt-in one-message summarize. Does not run on load or select. No auto-retry.
   */
  async summarizeSelectedMessage() {
    if (!isExplicitSelectedSurface()) {
      return;
    }
    if (this._state.isProcessing) {
      return;
    }
    if (isOfflineArchiveMode() && this._state.scopeMode !== 'selected-messages') {
      // Summarize is always exactly one selected local message.
      this._state.scopeMode = 'selected-messages';
    }
    await this.refreshScope();
    const preview = this._state.realPreview;
    if (!preview) {
      this._state.error = 'Select exactly one message, then Summarize. Nothing was sent.';
      this.trigger();
      return;
    }
    if (!this._state.geminiStatus.configured) {
      this._state.error = this._state.geminiStatus.reason;
      this.trigger();
      return;
    }
    await this.submitQuery(REAL_SELECTED_QUERY, {
      allowRealSelected: true,
      sentSnapshot: { messageId: preview.messageId, snapshotEpoch: preview.snapshotEpoch },
    });
  }

  selectOfflineArchiveMessage(messageId: string) {
    if (!isOfflineArchiveMode() || isDemoMode()) {
      return;
    }
    if (!setOfflineArchiveSelected(messageId)) {
      this._state.error = OFFLINE_ARCHIVE_SCOPE_REASON;
      this.trigger();
      return;
    }
    void this.refreshScope();
  }

  /**
   * Cancel ongoing operation. Increments generation so a late mock response
   * cannot attach after Cancel.
   */
  cancel() {
    const inFlight = this._queryGeneration;
    this._queryGeneration = nextQueryGeneration(this._queryGeneration);
    if (this._state.abortController) {
      this._state.abortController.abort();
    }
    if (this._state.geminiStatus.configured) {
      void this._gemini.cancel(inFlight);
    }
    this._state.isProcessing = false;
    this._state.abortController = null;
    this._inFlightMessageId = null;
    this._inFlightSnapshotEpoch = 0;
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
    if (isOfflineArchiveMode() && isOfflineArchiveBrowserDriven()) {
      // Offline browser: open the cited local message in the main window (read-only).
      const opened = navigateOfflineArchive(messageId);
      if (!opened) {
        this._state.error = OFFLINE_ARCHIVE_SCOPE_REASON;
        this.trigger();
      }
      return opened;
    }
    if (isRealSelectedSummaryMode() || isOfflineArchiveMode()) {
      const allowed =
        this._state.realPreview?.messageId ||
        this._inFlightMessageId ||
        (this._state.resolvedScope?.messageIds?.length === 1
          ? this._state.resolvedScope.messageIds[0]
          : null);
      if (!allowed || messageId !== allowed) {
        this._state.error = isOfflineArchiveMode()
          ? OFFLINE_ARCHIVE_SCOPE_REASON
          : REAL_SELECTED_SCOPE_REASON;
        this.trigger();
        return false;
      }
      const html = (await mailspringAdapter.getMessageBody(messageId)) || '';
      const prepared = prepareRealSelectedBody(html, 0);
      const preview = this._state.realPreview;
      this._state.demoPreview = {
        messageId,
        threadId: preview?.threadId || '',
        subject: preview?.subject || '(selected message)',
        from: preview?.from || '',
        date: preview?.date ? new Date(preview.date) : new Date(0),
        snippet: preview?.snippet || '',
        body: prepared.bodyText,
        folderId: '',
        folderName: 'Selected message (in-sidebar preview, not marked read)',
      };
      this.trigger();
      return true;
    }
    return mailspringAdapter.navigateToMessage(messageId, true);
  }
}

export default new AISidebarStore();
