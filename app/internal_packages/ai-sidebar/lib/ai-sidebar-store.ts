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
import {
  answerScopeMetadataLocally,
  offlineSummaryLabel,
  offlineSummaryLanguageHint,
  rebuildCitationsFromSources,
  scopePhrase,
} from './core/scope-answers';
import { tr } from './core/offline-i18n';
import { nextQueryGeneration, shouldAcceptAssistantResponse } from './core/query-generation';
import {
  createGeminiIpcTransport,
  draftAssistViaIpc,
  DraftAssistIpcRequest,
  draftComposeViaIpc,
  DraftComposeIpcRequest,
  geminiUsageIpc,
} from './gemini-ipc-transport';
import { offlineDraftsStore } from './offline-mail/offline-drafts-store';
import { offlineMailStore } from './offline-mail/offline-mail-store';
import {
  buildComposeContext,
  buildComposeRequest,
  cleanComposeResult,
  ComposeSourceMessage,
  isNearEmptyDraft,
} from './core/offline-draft-compose';
import { buildDraftAssistRequest, splitDraftForAssist } from './core/offline-draft-assist';
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
  getOfflineScopeFacts,
  isOfflineArchiveBrowserDriven,
  navigateOfflineArchive,
  setOfflineArchiveSelected,
} from './offline-archive-catalog';
import { isRealSelectedSummaryMode } from '../../../src/real-selected-summary';
import { isOfflineArchiveMode } from '../../../src/offline-archive';
import {
  GeminiUsageSummary,
  GEMINI_DISPLAY_NAME,
  GeminiDemoStatus,
  GeminiHostResult,
  isGeminiHostFailure,
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

/** Open-draft scope: resolved locally from the drafts store (no catalog, no mail). */
export function resolveOpenDraftScope(): ResolvedScope {
  const d = offlineDraftsStore.open;
  const own = d ? splitDraftForAssist(d.body).own : '';
  const chars = own.trim() ? own.length : 0;
  return {
    mode: 'open-draft',
    accountIds: [],
    isEmpty: !d,
    messageCount: 0,
    description: !d
      ? tr('אין טיוטה פתוחה', 'No draft is open')
      : chars
        ? tr(
            `📝 הטיוטה הפתוחה · ${chars.toLocaleString()} תווים · בלחיצה על "שלח" נשלח רק טקסט הטיוטה (בלי נמענים ובלי ציטוט)`,
            `📝 The open draft · ${chars.toLocaleString()} characters · "Send" sends only the draft text (no recipients, no quote)`
          )
        : tr(
            '📝 הטיוטה הפתוחה ריקה - כתוב הוראה ו-AI יכתוב את המייל (✍️ כתוב עם AI)',
            '📝 The open draft is empty - type an instruction and the AI writes the mail (✍️ Write with AI)'
          ),
  };
}

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
  /** Local usage ledger summary (offline experiment). Null when unavailable. */
  geminiUsage: GeminiUsageSummary | null;
  /** Open-draft scope: also send the subject (off unless the user ticks it). */
  draftIncludeSubject: boolean;
  /** Open-draft scope: "✍️ write with AI" (on for an empty / near-empty draft). */
  draftWriteMode: boolean;
  /** Write with AI on a reply/forward: send the whole conversation, not just the original. */
  draftIncludeThread: boolean;
}

/** Sends one write-with-AI request; injectable so tests never touch IPC. */
export type DraftComposeTransport = (
  generation: number,
  req: DraftComposeIpcRequest
) => Promise<GeminiHostResult>;

/** Reads the original message (and its conversation) locally; injectable for tests. */
export interface ComposeSourceLoader {
  message(id: string): Promise<ComposeSourceMessage | null>;
  threadIds(id: string): string[];
}

const defaultComposeSources: ComposeSourceLoader = {
  message: (id) => offlineMailStore.messageTextFor(id),
  threadIds: (id) => offlineMailStore.threadIdsFor(id),
};

/** Sends one open-draft request; injectable so tests never touch IPC. */
export type DraftAssistTransport = (
  generation: number,
  req: DraftAssistIpcRequest
) => Promise<GeminiHostResult>;

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
    geminiUsage: null,
    draftIncludeSubject: false,
    draftWriteMode: false,
    draftIncludeThread: false,
  };
  private _draftAssistTransport: DraftAssistTransport = draftAssistViaIpc;
  private _draftComposeTransport: DraftComposeTransport = draftComposeViaIpc;
  private _composeSources: ComposeSourceLoader = defaultComposeSources;
  /** Scope to go back to when the open draft closes (auto-selected scope). */
  private _scopeBeforeDraft: ScopeMode | null = null;
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

  /** Tests only: replace the IPC transport for the open-draft scope. */
  setDraftAssistTransportForTests(t: DraftAssistTransport) {
    this._draftAssistTransport = t;
  }

  setDraftIncludeSubject(on: boolean) {
    this._state.draftIncludeSubject = !!on;
    this.trigger();
  }

  /** Tests only: replace the write-with-AI transport and the local mail reader. */
  setDraftComposeForTests(t: DraftComposeTransport, sources?: ComposeSourceLoader) {
    this._draftComposeTransport = t;
    if (sources) {
      this._composeSources = sources;
    }
  }

  setDraftWriteMode(on: boolean) {
    this._state.draftWriteMode = !!on;
    this.trigger();
  }

  setDraftIncludeThread(on: boolean) {
    this._state.draftIncludeThread = !!on;
    this.trigger();
  }

  /**
   * Ribbon / draft toolbar "✍️ Write with AI": uses the open draft, or opens
   * a new empty one, and switches the panel to write mode. Sends nothing.
   */
  async startWriteWithAi() {
    if (!offlineDraftsStore.showing || !offlineDraftsStore.open) {
      offlineDraftsStore.createNew();
    }
    this._state.draftWriteMode = true;
    if (this._state.scopeMode !== 'open-draft') {
      this._scopeBeforeDraft = this._scopeBeforeDraft || this._state.scopeMode;
      await this.setScopeMode('open-draft');
    }
    this._state.draftWriteMode = true;
    this.trigger();
  }

  /**
   * Called when the open local draft changes: a newly opened draft selects
   * the 'open-draft' scope; closing it restores the previous scope. Picking
   * another scope by hand while a draft is open is respected.
   */
  async onOpenDraftChanged(openDraftId: string | null, previousOpenId: string | null) {
    if (openDraftId && openDraftId !== previousOpenId) {
      // An empty (or nearly empty) draft starts in "write with AI" mode.
      const open = offlineDraftsStore.open;
      this._state.draftWriteMode = !!open && isNearEmptyDraft(open.body);
      this._state.draftIncludeThread = false;
      if (this._state.scopeMode !== 'open-draft') {
        this._scopeBeforeDraft = this._state.scopeMode;
        await this.setScopeMode('open-draft');
        return;
      }
    } else if (!openDraftId && this._state.scopeMode === 'open-draft') {
      const back = this._scopeBeforeDraft || 'selected-messages';
      this._scopeBeforeDraft = null;
      await this.setScopeMode(back);
      return;
    }
    if (this._state.scopeMode === 'open-draft') {
      await this._resolveScope();
      this.trigger();
    }
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
      if (isOfflineArchiveMode()) {
        await this.refreshGeminiUsage(false);
      }
      return;
    }
    this._state.geminiStatus = unconfiguredGeminiStatus(false, 'Gemini DEMO host is --demo only');
  }

  async refreshGeminiUsage(trigger = true) {
    if (!isOfflineArchiveMode()) {
      return;
    }
    try {
      this._state.geminiUsage = await geminiUsageIpc.get();
    } catch {
      this._state.geminiUsage = null;
    }
    if (trigger) {
      this.trigger();
    }
  }

  async resetGeminiUsage() {
    try {
      this._state.geminiUsage = await geminiUsageIpc.reset();
    } catch {
      // keep previous summary
    }
    this.trigger();
  }

  async setGeminiBudget(ils: number) {
    try {
      this._state.geminiUsage = await geminiUsageIpc.setBudget(ils);
    } catch {
      // keep previous summary
    }
    this.trigger();
  }

  private async _resolveScope() {
    if (this._state.scopeMode === 'open-draft') {
      this._state.resolvedScope = resolveOpenDraftScope();
      this._state.error = null;
      return;
    }
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
      /** What the user bubble shows instead of the internal prompt. */
      displayLabel?: string;
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
      content: opts?.displayLabel || query,
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
      if (scope.mode === 'open-draft') {
        if (this._state.draftWriteMode) {
          await this._runDraftCompose(query, startedGeneration, stillCurrent);
        } else {
          await this._runDraftAssist(query, startedGeneration, stillCurrent);
        }
        return;
      }
      // Offline: pure metadata questions (how many messages, date range, how
      // many senders) are answered exactly from the local scope, for free.
      if (
        isOfflineArchiveMode() &&
        !isDemoMode() &&
        !opts?.allowRealSelected &&
        isOfflineArchiveBrowserDriven()
      ) {
        const local = answerScopeMetadataLocally(query, getOfflineScopeFacts(scope));
        if (local) {
          this._state.conversation.push({
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: local,
            citations: [],
            timestamp: new Date(),
          });
          return;
        }
      }
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
            content: `❌ ${tr('שגיאה', 'Error')}: ${REAL_SELECTED_SCOPE_REASON}`,
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
          content: `❌ ${tr('שגיאה', 'Error')}: ${NON_SYNTHETIC_LIVE_REASON}`,
          timestamp: new Date(),
        });
        return;
      }
      if (useGeminiReal && (sourcesAreSynthetic || searchResult.messages.length !== 1)) {
        this._state.error = selectedScopeReason;
        this._state.conversation.push({
          id: `error-${Date.now()}`,
          role: 'system',
          content: `❌ ${tr('שגיאה', 'Error')}: ${selectedScopeReason}`,
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
          // Gemini often returns only ids: rebuild citations from the local
          // metadata of the messages that were sent; unknown ids are dropped.
          citations: useGemini
            ? rebuildCitationsFromSources(result.citations, searchResult.messages)
            : result.citations,
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
            content: `❌ ${tr('שגיאה', 'Error')}: תשובה נדחתה (fail-closed, origin=${validated.origin}). ${validated.message}`,
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
      const geminiReason = (err as Error & { geminiReason?: string }).geminiReason;
      if (errorMsg !== 'Operation cancelled') {
        this._state.error = errorMsg;
        const icon =
          geminiReason === 'billing-exhausted'
            ? '💳'
            : geminiReason === 'rate-limited'
              ? '⏳'
              : geminiReason === 'invalid-key'
                ? '🔑'
                : '❌';
        const errorMessage: ConversationMessage = {
          id: `error-${Date.now()}`,
          role: 'system',
          content: `${icon} ${icon === '❌' ? tr('שגיאה: ', 'Error: ') : ''}${errorMsg}`,
          timestamp: new Date(),
          geminiErrorKind: geminiReason,
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
      void this.refreshGeminiUsage();
    }
  }

  /**
   * Open-draft scope: ONE request with the user's request + the open draft's
   * own plain text (subject only if ticked). No recipients, no quoted or
   * forwarded mail, no archive messages, no citations needed.
   */
  private async _runDraftAssist(
    query: string,
    startedGeneration: number,
    stillCurrent: () => boolean
  ) {
    const d = offlineDraftsStore.open;
    const sys = (content: string) =>
      this._state.conversation.push({
        id: `system-${Date.now()}`,
        role: 'system',
        content,
        timestamp: new Date(),
      });
    if (!d) {
      sys(tr('אין טיוטה פתוחה. לא נשלח דבר.', 'No draft is open. Nothing was sent.'));
      return;
    }
    const built = buildDraftAssistRequest(d, query, this._state.draftIncludeSubject);
    if (built.ok === false) {
      sys(
        built.reason === 'empty-draft'
          ? tr(
              'הטיוטה ריקה (בלי הטקסט המצוטט). כתוב משהו קודם. לא נשלח דבר.',
              'The draft is empty (quoted text not counted). Write something first. Nothing was sent.'
            )
          : built.reason === 'too-long'
            ? tr(
                'הטיוטה ארוכה מדי (עד 20,000 תווים). לא נשלח דבר.',
                'The draft is too long (max 20,000 characters). Nothing was sent.'
              )
            : tr('הבקשה ריקה או ארוכה מדי.', 'The request is empty or too long.')
      );
      return;
    }
    await this.refreshGeminiStatus();
    if (!this._state.geminiStatus.configured) {
      sys(
        tr(
          'Gemini לא מחובר, ולכן אי אפשר לעזור בטיוטה. לא נשלח דבר.',
          'Gemini is not connected, so draft help is unavailable. Nothing was sent.'
        )
      );
      return;
    }
    this._state.progressPhase = 'gemini';
    this.trigger();
    const result = await this._draftAssistTransport(startedGeneration, built.req);
    if (!stillCurrent()) {
      return;
    }
    if (isGeminiHostFailure(result)) {
      const failure = new Error(result.message) as Error & { geminiReason?: string };
      failure.geminiReason = result.reason;
      throw failure;
    }
    const payload = result.payload;
    const kind = payload.draftKind === 'rewrite' ? 'rewrite' : 'answer';
    const text = String(payload.response || '');
    const sentChars = built.req.draftText.length;
    const quoted = splitDraftForAssist(d.body).tail ? 1 : 0;
    const tokens = payload.tokensUsed
      ? tr(` · ${payload.tokensUsed} טוקנים`, ` · ${payload.tokensUsed} tokens`)
      : '';
    const note =
      tr(
        `📝 נשלח ל-Gemini רק טקסט הטיוטה (${sentChars.toLocaleString()} תווים)` +
          (built.req.draftSubject ? ' והנושא' : '') +
          (quoted ? ', בלי הציטוט' : '') +
          ', בלי נמענים.',
        `📝 Sent to Gemini: only the draft text (${sentChars.toLocaleString()} characters)` +
          (built.req.draftSubject ? ' and the subject' : '') +
          (quoted ? ', without the quote' : '') +
          ', no recipients.'
      ) + tokens;
    this._state.conversation.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: `${text}\n\n---\n${note}`,
      citations: [],
      timestamp: new Date(),
      isMock: false,
      draftAssist: { draftId: d.id, kind, text },
    });
  }

  /**
   * Write with AI: ONE request with the instruction + the draft's own text
   * (subject only if ticked) and, for a reply/forward, the original message
   * (or the conversation when ticked) as plain text without attachments.
   * The answer is only a preview; the draft changes on "Apply".
   */
  private async _runDraftCompose(
    query: string,
    startedGeneration: number,
    stillCurrent: () => boolean
  ) {
    const d = offlineDraftsStore.open;
    const sys = (content: string) =>
      this._state.conversation.push({
        id: `system-${Date.now()}`,
        role: 'system',
        content,
        timestamp: new Date(),
      });
    if (!d) {
      sys(tr('אין טיוטה פתוחה. לא נשלח דבר.', 'No draft is open. Nothing was sent.'));
      return;
    }
    const kind = d.kind === 'reply' ? 'reply' : d.kind === 'forward' ? 'forward' : 'new';
    await this.refreshGeminiStatus();
    if (!this._state.geminiStatus.configured) {
      sys(
        tr(
          'Gemini לא מחובר, ולכן אי אפשר לכתוב עם AI. לא נשלח דבר.',
          'Gemini is not connected, so Write with AI is unavailable. Nothing was sent.'
        )
      );
      return;
    }
    // Original message / conversation: read locally, text only.
    let context: ReturnType<typeof buildComposeContext> | null = null;
    let sourceMissing = false;
    if (kind !== 'new') {
      const srcId = d.sourceMessageId;
      const target = srcId ? await this._composeSources.message(srcId) : null;
      if (!target) {
        sourceMissing = true;
      } else {
        let thread: ComposeSourceMessage[] | null = null;
        if (this._state.draftIncludeThread) {
          const ids = this._composeSources.threadIds(srcId);
          const upTo = ids.indexOf(srcId);
          const wanted = (upTo >= 0 ? ids.slice(0, upTo) : ids.filter((x) => x !== srcId)).slice(
            -9
          );
          thread = [];
          for (const id of wanted) {
            const m = await this._composeSources.message(id);
            if (m) {
              thread.push(m);
            }
          }
          thread.push(target);
        }
        context = buildComposeContext(target, thread);
      }
      if (!stillCurrent()) {
        return;
      }
    }
    const built = buildComposeRequest(d, query, {
      includeSubject: this._state.draftIncludeSubject,
      context: context ? context.text : null,
    });
    if (built.ok === false) {
      sys(
        built.reason === 'too-long'
          ? tr(
              'הטיוטה ארוכה מדי (עד 20,000 תווים). לא נשלח דבר.',
              'The draft is too long (max 20,000 characters). Nothing was sent.'
            )
          : tr('ההוראה ריקה או ארוכה מדי.', 'The instruction is empty or too long.')
      );
      return;
    }
    this._state.progressPhase = 'gemini';
    this.trigger();
    const result = await this._draftComposeTransport(startedGeneration, built.req);
    if (!stillCurrent()) {
      return;
    }
    if (isGeminiHostFailure(result)) {
      const failure = new Error(result.message) as Error & { geminiReason?: string };
      failure.geminiReason = result.reason;
      throw failure;
    }
    const payload = result.payload;
    const clean = cleanComposeResult(
      { subject: payload.composeSubject || '', body: String(payload.response || '') },
      kind
    );
    if (!clean.body.trim()) {
      sys(
        tr(
          'Gemini החזיר טקסט ריק. הטיוטה לא שונתה.',
          'Gemini returned empty text. The draft was not changed.'
        )
      );
      return;
    }
    const tokens = payload.tokensUsed
      ? tr(` · ${payload.tokensUsed} טוקנים`, ` · ${payload.tokensUsed} tokens`)
      : '';
    const ownChars = built.req.draftText.length;
    const parts: string[] = [tr('ההוראה', 'the instruction')];
    if (ownChars) {
      parts.push(
        tr(
          `טקסט הטיוטה (${ownChars.toLocaleString()} תווים)`,
          `the draft text (${ownChars.toLocaleString()} characters)`
        )
      );
    }
    if (built.req.draftSubject) {
      parts.push(tr('הנושא', 'the subject'));
    }
    if (context) {
      parts.push(
        context.messages > 1
          ? tr(
              `${context.messages} הודעות מהשיחה (טקסט בלבד)`,
              `${context.messages} messages of the conversation (text only)`
            )
          : tr('ההודעה המקורית (טקסט בלבד)', 'the original message (text only)')
      );
    }
    const note =
      tr(
        `✍️ נשלחו ל-Gemini: ${parts.join(', ')}. בלי קבצים מצורפים ובלי נמעני הטיוטה.`,
        `✍️ Sent to Gemini: ${parts.join(', ')}. No attachments, no draft recipients.`
      ) +
      (context && context.truncated
        ? tr(
            ' (חלק מהטקסט קוצר כדי לשמור על גודל סביר.)',
            ' (Some text was shortened to keep it small.)'
          )
        : '') +
      (sourceMissing
        ? tr(
            ' ⚠️ ההודעה המקורית לא נמצאה בעותק, ולכן נכתב בלי ההקשר שלה.',
            ' ⚠️ The original message was not found in the copy, so this was written without it.'
          )
        : '') +
      tokens;
    this._state.conversation.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: note,
      citations: [],
      timestamp: new Date(),
      isMock: false,
      draftCompose: { draftId: d.id, kind, subject: clean.subject, body: clean.body },
    });
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
        content: tr(
          'לא נמצאו הודעות בטווח הזה. לא נשלח דבר ל-Gemini.',
          'No messages found in this range. Nothing was sent to Gemini.'
        ),
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
    this._gemini.setQueryExtras({ mode: 'offline-archive-scoped', scopeFacts: ctx.facts });
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
    const citations: Citation[] = rebuildCitationsFromSources(result.citations, ctx.messages);
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
          content: `❌ ${tr('שגיאה', 'Error')}: תשובת Gemini נדחתה (${validated.reason}). ${validated.message}`,
          timestamp: new Date(),
        });
      }
      return;
    }
    const inScope = ctx.facts.totalInScope;
    const sentAll = ctx.sent === inScope;
    const coverage =
      scope.mode === 'selected-messages'
        ? tr(
            `🔎 נשלחו ל-Gemini ${ctx.sent} מתוך ${inScope} ההודעות שנבחרו (טקסט בלבד, בלי קבצים מצורפים).`,
            `🔎 Sent to Gemini: ${ctx.sent} of the ${inScope} selected messages (text only, no attachments).`
          )
        : tr(
            `🔎 ${scopePhrase(ctx.facts)}: ${inScope.toLocaleString()} הודעות. ` +
              `נקראו מקומית ${ctx.scanned}, התאימו לשאלה ${ctx.matched}, ` +
              `נשלחו ל-Gemini ${ctx.sent}${sentAll ? ' (כולן)' : ` מתוך ${inScope.toLocaleString()}`} ` +
              `(טקסט בלבד, בלי קבצים מצורפים).` +
              (ctx.matched === 0 && !sentAll
                ? ' לא נמצאה התאמה למילים בשאלה, לכן נשלחו ההודעות החדשות ביותר.'
                : ''),
            `🔎 ${scopePhrase(ctx.facts)}: ${inScope.toLocaleString()} messages. ` +
              `Read locally ${ctx.scanned}, matched the question ${ctx.matched}, ` +
              `sent to Gemini ${ctx.sent}${sentAll ? ' (all)' : ` of ${inScope.toLocaleString()}`} ` +
              `(text only, no attachments).` +
              (ctx.matched === 0 && !sentAll
                ? ' No match for the words in the question, so the newest messages were sent.'
                : '')
          );
    const tokens = validated.result.tokensUsed
      ? tr(` · ${validated.result.tokensUsed} טוקנים`, ` · ${validated.result.tokensUsed} tokens`)
      : '';
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
    const offline = isOfflineArchiveMode();
    await this.submitQuery(
      offline ? `${REAL_SELECTED_QUERY}${offlineSummaryLanguageHint()}` : REAL_SELECTED_QUERY,
      {
        allowRealSelected: true,
        sentSnapshot: { messageId: preview.messageId, snapshotEpoch: preview.snapshotEpoch },
        displayLabel: offline ? offlineSummaryLabel() : undefined,
      }
    );
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
