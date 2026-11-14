/**
 * AI Sidebar component - conversational interface with explicit scope selector.
 * Hebrew RTL layout with mixed content support.
 */
import React from 'react';
import { localized, Rx } from 'mailspring-exports';
import { FluxContainer, Spinner } from 'mailspring-component-kit';
import AISidebarStore from './ai-sidebar-store';
import { ScopeMode, RetrievalMode, ConversationMessage, Citation } from './core/types';
import { DemoMessagePreview, isDemoMode } from './synthetic-demo';
import { clipboard, shell } from 'electron';
import { offlineDraftsStore } from './offline-mail/offline-drafts-store';
import { DRAFT_QUICK_ACTIONS } from './core/offline-draft-assist';
import { subjectToApply } from './core/offline-draft-compose';
import { tr, offlineDir, offlineDateLocale } from './core/offline-i18n';
import {
  GEMINI_BILLING_URL,
  GEMINI_DISPLAY_NAME,
  GeminiDemoStatus,
  GeminiUsageSummary,
  GeminiUsageTotals,
} from '../../../src/browser/gemini-demo-protocol';

/**
 * Dark colors for the panel's own warning/preview boxes follow the ACTIVE
 * Mailspring theme in the offline experiment (body.ai-dark-surface), and the
 * OS setting elsewhere (unchanged behavior).
 */
function isDarkColor(css: string): boolean | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css || '');
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) {
    return null;
  }
  const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
  return lum < 128;
}

export function updateAIDarkSurface(root?: Element | null) {
  let dark = false;
  if (isOfflineArchiveMode()) {
    const el = root || document.querySelector('.ai-sidebar') || document.body;
    let node: Element | null = el;
    let found: boolean | null = null;
    while (node && found === null) {
      found = isDarkColor(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    dark = !!found;
  } else {
    dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  document.body.classList.toggle('ai-dark-surface', dark);
}

const GEMINI_API_KEYS_URL = 'https://aistudio.google.com/apikey';

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function fmtIls(n: number): string {
  return n < 0.1 ? `₪${n.toFixed(3)}` : `₪${n.toFixed(2)}`;
}
import { isRealSelectedSummaryMode } from '../../../src/real-selected-summary';
import { isOfflineArchiveMode } from '../../../src/offline-archive';
import { OfflineBrandLogo, OFFLINE_BRAND_NAME } from './offline-mail/offline-brand';
import { RealSelectedPreview } from './core/real-selected-mail';
import {
  getOfflineArchiveCatalog,
  getOfflineArchiveManifest,
  isOfflineArchiveBrowserDriven,
} from './offline-archive-catalog';
import DemoComposer from './demo-composer';
import { OfflineHelpTip } from './offline-mail/offline-tour';
import classNames from 'classnames';
import {
  estimateGeminiSendCount,
  GEMINI_SCOPED_COST_NOTE,
  GEMINI_SCOPED_MAX_MESSAGES,
} from './core/gemini-context';

function isSelectedSummarySurface(): boolean {
  return isRealSelectedSummaryMode() || isOfflineArchiveMode();
}

interface AISidebarState {
  scopeMode: ScopeMode;
  resolvedScope: any;
  retrievalMode: RetrievalMode;
  conversation: ConversationMessage[];
  isProcessing: boolean;
  progress: any;
  error: string | null;
  inputValue: string;
  providerName: string;
  isMockProvider: boolean;
  demoPreview: DemoMessagePreview | null;
  realPreview: RealSelectedPreview | null;
  demoTab: 'ai' | 'composer';
  geminiStatus: GeminiDemoStatus | null;
  progressPhase: 'local' | 'gemini' | null;
  /** Selected-message disclosure: collapsed to one line by default. */
  previewExpanded: boolean;
  geminiUsage: GeminiUsageSummary | null;
  usageExpanded: boolean;
  usageResetArmed: boolean;
  budgetDraft: string;
  draftIncludeSubject: boolean;
  /** Open-draft scope: "✍️ write with AI" mode and its conversation opt-in. */
  draftWriteMode: boolean;
  draftIncludeThread: boolean;
  /** Earlier turns the next click sends as context (conversation memory). */
  draftHistoryTurns: number;
  /** Write-with-AI previews: "replace the subject too" ticks, by message id. */
  composeSubjectTicks: { [msgId: string]: boolean };
  /** Bumped on local-drafts changes (apply/undo buttons). */
  draftsRev: number;
  /** Message id whose answer was just copied (brief "copied" label). */
  copiedId: string | null;
}

/** Within this many px of the bottom counts as "following" the conversation. */
const STICK_THRESHOLD_PX = 80;

class AISidebarInner extends React.Component<Record<string, never>, AISidebarState> {
  static displayName = 'AISidebar';

  private _inputRef = React.createRef<HTMLTextAreaElement>();
  private _messagesEndRef = React.createRef<HTMLDivElement>();
  private _scrollRef = React.createRef<HTMLDivElement>();
  private _rootRef = React.createRef<HTMLDivElement>();
  private _themeSub: { dispose: () => void } | null = null;
  private _darkMql: MediaQueryList | null = null;

  _updateDarkSurface = () => {
    updateAIDarkSurface(this._rootRef.current);
  };
  /** False once the user scrolls up while an answer is loading. */
  private _stickToBottom = true;
  private _programmaticScrollAt = 0;
  private _unsubscribe: (() => void) | null = null;
  private _unsubFocus: (() => void) | null = null;
  private _unsubMsg: (() => void) | null = null;
  private _unsubDrafts: (() => void) | null = null;

  state: AISidebarState = {
    scopeMode: isDemoMode() ? 'all-mail' : 'selected-messages',
    resolvedScope: null,
    retrievalMode: 'ranked',
    conversation: [],
    isProcessing: false,
    progress: null,
    error: null,
    inputValue: '',
    providerName: AISidebarStore.getProvider().name,
    isMockProvider: AISidebarStore.getProvider().isMock,
    demoPreview: null,
    realPreview: AISidebarStore.getState().realPreview,
    demoTab: 'ai',
    geminiStatus: AISidebarStore.getState().geminiStatus,
    progressPhase: null,
    previewExpanded: false,
    geminiUsage: null,
    usageExpanded: false,
    usageResetArmed: false,
    budgetDraft: '',
    draftIncludeSubject: false,
    draftWriteMode: false,
    draftIncludeThread: false,
    draftHistoryTurns: 0,
    composeSubjectTicks: {},
    draftsRev: 0,
    copiedId: null,
  };

  componentDidMount() {
    this._unsubscribe = AISidebarStore.listen(() => {
      const storeState = AISidebarStore.getState();
      const provider = AISidebarStore.getProvider();
      this.setState({
        scopeMode: storeState.scopeMode,
        resolvedScope: storeState.resolvedScope,
        retrievalMode: storeState.retrievalMode,
        conversation: storeState.conversation,
        isProcessing: storeState.isProcessing,
        progress: storeState.progress,
        error: storeState.error,
        providerName: storeState.geminiStatus.configured ? GEMINI_DISPLAY_NAME : provider.name,
        isMockProvider: storeState.geminiStatus.configured ? false : provider.isMock,
        demoPreview: storeState.demoPreview,
        realPreview: storeState.realPreview,
        geminiStatus: storeState.geminiStatus,
        progressPhase: storeState.progressPhase,
        geminiUsage: storeState.geminiUsage,
        draftIncludeSubject: storeState.draftIncludeSubject,
        draftWriteMode: storeState.draftWriteMode,
        draftIncludeThread: storeState.draftIncludeThread,
        draftHistoryTurns: storeState.draftHistoryTurns,
      });
    });

    this._updateDarkSurface();
    this._themeSub = AppEnv.themes.onDidChangeActiveThemes(() => {
      // Styles recompute asynchronously after a theme switch.
      window.setTimeout(this._updateDarkSurface, 300);
      window.setTimeout(this._updateDarkSurface, 1200);
    });
    if (window.matchMedia) {
      this._darkMql = window.matchMedia('(prefers-color-scheme: dark)');
      this._darkMql.addEventListener('change', this._updateDarkSurface);
    }

    // Initial scope resolution — preview only, never generates.
    AISidebarStore.refreshScope();
    // The panel just opened: put the cursor in the question box.
    window.setTimeout(this._focusInput, 400);

    if (isRealSelectedSummaryMode()) {
      try {
        const { FocusedContentStore, MessageStore } = require('mailspring-exports');
        const refresh = () => {
          void AISidebarStore.refreshScope();
        };
        this._unsubFocus = FocusedContentStore.listen(refresh);
        this._unsubMsg = MessageStore.listen(refresh);
      } catch {
        // Node tests / no Flux
      }
    }
    if (isOfflineArchiveMode()) {
      void AISidebarStore.refreshScope();
      this._unsubDrafts = offlineDraftsStore.listen(() =>
        this.setState((s) => ({ draftsRev: s.draftsRev + 1 }))
      );
    }

    if (isDemoMode()) {
      (window as any).__mailspringDemoSidebar = {
        setScopeMode: (mode: ScopeMode) => AISidebarStore.setScopeMode(mode),
        submitQuery: (query: string) => AISidebarStore.submitQuery(query),
        getState: () => AISidebarStore.getState(),
      };
    }
  }

  componentDidUpdate(_prevProps: Record<string, never>, prevState: AISidebarState) {
    if (prevState.isProcessing && !this.state.isProcessing) {
      // Answer finished: ready for the next question.
      window.setTimeout(this._focusInput, 50);
    }
    const conv = this.state.conversation;
    const grew = conv.length > prevState.conversation.length;
    const last = conv[conv.length - 1];
    if (grew && last && last.role === 'user') {
      // A new question always brings the conversation back into focus.
      this._stickToBottom = true;
    }
    if (!this._stickToBottom) {
      return;
    }
    if (grew && last && last.role !== 'user') {
      // Answer arrived: show the question and the start of the answer.
      this._scrollToLatestQuestion();
    } else if (
      grew ||
      this.state.isProcessing !== prevState.isProcessing ||
      this.state.progress !== prevState.progress ||
      this.state.progressPhase !== prevState.progressPhase
    ) {
      this._scrollToBottom();
    }
  }

  componentWillUnmount() {
    if (this._unsubDrafts) {
      this._unsubDrafts();
    }
    if (this._themeSub) {
      this._themeSub.dispose();
    }
    if (this._darkMql) {
      this._darkMql.removeEventListener('change', this._updateDarkSurface);
    }
    if (this._unsubscribe) {
      this._unsubscribe();
    }
    if (this._unsubFocus) {
      this._unsubFocus();
    }
    if (this._unsubMsg) {
      this._unsubMsg();
    }
    if ((window as any).__mailspringDemoSidebar) {
      delete (window as any).__mailspringDemoSidebar;
    }
  }

  _focusInput = () => {
    // Offline experiment only, so the regular app keeps its keyboard focus.
    if (!isOfflineArchiveMode()) {
      return;
    }
    const el = this._inputRef.current;
    if (el && !el.disabled && document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
  };

  _setScrollTop(top: number) {
    const el = this._scrollRef.current;
    if (!el) {
      return;
    }
    this._programmaticScrollAt = Date.now();
    el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
  }

  _scrollToBottom = () => {
    const el = this._scrollRef.current;
    if (!el) {
      this._messagesEndRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    this._setScrollTop(el.scrollHeight);
  };

  /** Bottom, unless the answer is taller than the view: then the question's top. */
  _scrollToLatestQuestion = () => {
    const el = this._scrollRef.current;
    if (!el) {
      this._scrollToBottom();
      return;
    }
    const users = el.querySelectorAll('.message.message-user');
    const q = users[users.length - 1] as HTMLElement | undefined;
    if (!q) {
      this._scrollToBottom();
      return;
    }
    const qTop = q.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    this._setScrollTop(Math.min(qTop - 8, el.scrollHeight));
  };

  _onBodyScroll = () => {
    const el = this._scrollRef.current;
    if (!el || Date.now() - this._programmaticScrollAt < 150) {
      return;
    }
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this._stickToBottom = fromBottom <= STICK_THRESHOLD_PX;
  };

  _onTogglePreview = () => {
    this.setState({ previewExpanded: !this.state.previewExpanded });
  };

  _renderPreviewToggle(label: string) {
    const expanded = this.state.previewExpanded;
    return (
      <button
        type="button"
        className="preview-toggle"
        data-preview-toggle="true"
        aria-expanded={expanded}
        onClick={this._onTogglePreview}
      >
        <span className="preview-toggle-label">{label}</span>
        <span className="preview-toggle-action">
          {expanded ? tr('הסתר ▴', 'Hide ▴') : tr('הצג ▾', 'Show ▾')}
        </span>
      </button>
    );
  }

  _onScopeModeChange = (mode: ScopeMode) => {
    AISidebarStore.setScopeMode(mode);
  };

  _onRetrievalModeChange = (mode: RetrievalMode) => {
    AISidebarStore.setRetrievalMode(mode);
  };

  _onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    this.setState({ inputValue: e.target.value });
  };

  _onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._onSubmit();
    }
  };

  _onSubmit = () => {
    // Offline experiment allows free-form questions (local mock provider only).
    if (isSelectedSummarySurface() && !isOfflineArchiveMode()) {
      return;
    }
    const query = this.state.inputValue.trim();
    if (!query || this.state.isProcessing) return;

    this.setState({ inputValue: '' });
    AISidebarStore.submitQuery(query);
  };

  /** "🔎 Search & ask": local search over all mail first, then Gemini on the top results. */
  _onAskAboutMail = () => {
    const query = this.state.inputValue.trim();
    if (!query || this.state.isProcessing) return;
    this.setState({ inputValue: '' });
    void AISidebarStore.askAboutMail(query);
  };

  _onSummarizeSelected = () => {
    if (this.state.isProcessing) return;
    void AISidebarStore.summarizeSelectedMessage();
  };

  _onCancel = () => {
    AISidebarStore.cancel();
  };

  _onClear = () => {
    AISidebarStore.clearConversation();
  };

  _onCitationClick = (citation: Citation) => {
    AISidebarStore.navigateToCitation(citation.messageId);
  };

  _renderGeminiHowto() {
    const reason = this.state.geminiStatus?.reason || '';
    const cmd = (reason.match(/powershell [^\n]*?\.ps1"/) || [])[0];
    const hebrew = reason.split(/ (?=Gemini key|Could not read)/)[0];
    return (
      <>
        <div className="gemini-howto-text" dir="rtl">
          {hebrew}
        </div>
        {cmd && (
          <code className="gemini-howto-cmd" dir="ltr" data-gemini-store-command="true">
            {cmd}
          </code>
        )}
      </>
    );
  }

  _onRecheckGemini = () => {
    void AISidebarStore.refreshScope();
  };

  _renderMockWarning() {
    const inDemoMode = isDemoMode();
    const realSelected = isRealSelectedSummaryMode();
    const offlineArchive = isOfflineArchiveMode();
    const geminiConfigured = !!this.state.geminiStatus?.configured;
    const geminiStatus = geminiConfigured ? 'configured' : 'unconfigured';

    return (
      <div
        className={classNames('ai-sidebar-mock-warning', {
          'gemini-on': offlineArchive && geminiConfigured,
        })}
        data-gemini-status={geminiStatus}
      >
        <span className="icon">{offlineArchive && geminiConfigured ? '✨' : '⚠️'}</span>
        <span className="text">
          {inDemoMode && geminiConfigured ? (
            <>
              🧪 מצב DEMO — Gemini Developer API (מסלול משולם)
              <br />
              <small>
                Official paid Developer API · not consumer Gemini · synthetic only · billing not
                proven from key
              </small>
            </>
          ) : inDemoMode ? (
            <>
              🧪 מצב DEMO - נתונים סינתטיים
              <br />
              <small>MOCK AI · synthetic fixtures · no account · no Keychain</small>
            </>
          ) : offlineArchive && geminiConfigured ? (
            <>
              <b>{tr('🟢 Gemini מחובר', '🟢 Gemini connected')}</b>{' '}
              {tr(
                `(בתשלום, פרויקט yahoo-agent). "שלח" שואל את Gemini על הטווח שבחרת: קודם חיפוש מקומי, ואז נשלחות עד ${GEMINI_SCOPED_MAX_MESSAGES} ההודעות הרלוונטיות (טקסט בלבד, בלי קבצים מצורפים). רק בלחיצה.`,
                `(paid, project yahoo-agent). "Send" asks Gemini about the range you chose: first a local search, then up to ${GEMINI_SCOPED_MAX_MESSAGES} of the most relevant messages are sent (text only, no attachments). Only when you click.`
              )}
              <br />
              <small>
                Gemini on · paid · sent only on click · max {GEMINI_SCOPED_MAX_MESSAGES} messages ·
                no attachments · no Yahoo · no sync
              </small>
            </>
          ) : offlineArchive ? (
            <>
              <b>{tr('⚪ Mock AI בלבד', '⚪ Mock AI only')}</b>{' '}
              {tr(
                '— Gemini לא מחובר. התשובות מקומיות (הדגמה), בלי חיבור חיצוני.',
                '— Gemini is not connected. Answers are local (demo), with no outside connection.'
              )}
              <button
                type="button"
                className="gemini-recheck-btn"
                data-gemini-recheck="true"
                onClick={this._onRecheckGemini}
              >
                {tr('בדוק שוב', 'Check again')}
              </button>
              <details className="gemini-howto">
                <summary>{tr('איך מפעילים Gemini?', 'How do I turn on Gemini?')}</summary>
                {this._renderGeminiHowto()}
              </details>
            </>
          ) : realSelected && geminiConfigured ? (
            <>
              הודעה אחת נבחרת — Gemini Developer API
              <br />
              <small>
                Opt-in one selected message · Mailspring-dev · not the official app · no mailbox
                mutation
              </small>
            </>
          ) : realSelected ? (
            <>
              הודעה אחת נבחרת — מפתח Gemini לא מוכן
              <br />
              <small>Select one message, then Summarize. Nothing is sent on load.</small>
            </>
          ) : this.state.isMockProvider ? (
            <>
              מצב Mock - אין חיבור ל-AI
              <br />
              <small>No external AI connected</small>
            </>
          ) : null}
        </span>
      </div>
    );
  }

  _renderScopeSelector() {
    if (isOfflineArchiveMode() && !isOfflineArchiveBrowserDriven()) {
      return (
        <div className="ai-sidebar-scope" data-offline-archive-scope="true">
          <span className="scope-label">
            {tr(
              'טווח: הודעה אחת מהארכיון המקומי (מנותק)',
              'Range: one message from the local archive (offline)'
            )}
          </span>
        </div>
      );
    }
    if (isRealSelectedSummaryMode()) {
      return (
        <div className="ai-sidebar-scope" data-real-selected-scope="true">
          <span className="scope-label">טווח: הודעה אחת נבחרת בלבד</span>
        </div>
      );
    }
    const { scopeMode, resolvedScope } = this.state;

    return (
      <div className="ai-sidebar-scope">
        <span className="scope-label" id="scope-label">
          {tr('טווח חיפוש:', 'Search range:')}
        </span>
        <div className="scope-buttons" role="group" aria-labelledby="scope-label">
          <button
            className={classNames('scope-btn', { active: scopeMode === 'selected-messages' })}
            onClick={() => this._onScopeModeChange('selected-messages')}
            title={tr('הודעות נבחרות', 'Selected messages')}
            aria-label={tr('הודעות נבחרות', 'Selected messages')}
            data-scope-mode="selected-messages"
          >
            {tr('📧 נבחרות', '📧 Selected')}
          </button>
          <button
            className={classNames('scope-btn', { active: scopeMode === 'current-folder' })}
            onClick={() => this._onScopeModeChange('current-folder')}
            title={tr('תיקייה נוכחית (תיבת דואר נכנס בדמו)', 'Current folder')}
            aria-label={tr('תיקייה', 'Folder')}
            data-scope-mode="current-folder"
          >
            {tr('📁 תיקייה', '📁 Folder')}
          </button>
          <button
            className={classNames('scope-btn', { active: scopeMode === 'all-mail' })}
            onClick={() => this._onScopeModeChange('all-mail')}
            title={tr('כל הדואר', 'All mail')}
            aria-label={tr('כל הדואר', 'All mail')}
            data-scope-mode="all-mail"
          >
            {tr('📬 הכל', '📬 All')}
          </button>
          {isOfflineArchiveMode() && (
            <button
              className={classNames('scope-btn', { active: scopeMode === 'open-draft' })}
              onClick={() => this._onScopeModeChange('open-draft')}
              title={tr(
                'הטיוטה הפתוחה - נשלח רק טקסט הטיוטה',
                'The open draft - only the draft text is sent'
              )}
              aria-label={tr('טיוטה פתוחה', 'Open draft')}
              data-scope-mode="open-draft"
            >
              {tr('📝 טיוטה פתוחה', '📝 Open draft')}
            </button>
          )}
        </div>

        {resolvedScope && (
          <div
            className={classNames('scope-status', {
              empty: resolvedScope.isEmpty,
              hint:
                resolvedScope.isEmpty &&
                isOfflineArchiveMode() &&
                scopeMode === 'selected-messages',
            })}
          >
            {resolvedScope.isEmpty ? (
              <span className="empty-scope">
                {scopeMode === 'open-draft'
                  ? tr(
                      'ℹ️ אין טיוטה פתוחה. פתח טיוטה (כרטיסיית "טיוטות" > חדשה / השב / העבר), והטווח יעבור אליה לבד.',
                      'ℹ️ No draft is open. Open a draft (Drafts tab > New / Reply / Forward) and the range switches to it.'
                    )
                  : scopeMode === 'selected-messages'
                    ? isOfflineArchiveMode()
                      ? tr(
                          'ℹ️ עוד לא סימנת הודעות. סמן הודעות ברשימה, או בחר "תיקייה" / "הכל". כשטיוטה פתוחה אפשר לבחור "📝 טיוטה פתוחה".',
                          'ℹ️ No messages marked yet. Mark messages in the list, or choose "Folder" / "All". With a draft open you can choose "📝 Open draft".'
                        )
                      : '❌ לא נבחרו הודעות - בחר הודעות מהרשימה'
                    : tr('❌ אין הודעות בטווח', '❌ No messages in this range')}
              </span>
            ) : (
              <span className="scope-description">{resolvedScope.description}</span>
            )}
          </div>
        )}
        {scopeMode === 'open-draft' ? (
          this._renderDraftTools()
        ) : (
          <>
            {this._renderGeminiEstimate()}

            <div className="retrieval-mode" data-retrieval-mode={this.state.retrievalMode}>
              <label>
                <input
                  type="radio"
                  name="retrieval"
                  checked={this.state.retrievalMode === 'ranked'}
                  onChange={() => this._onRetrievalModeChange('ranked')}
                  aria-label={tr('דירוג (מהיר)', 'Ranked (fast)')}
                />
                <span>{tr('דירוג (מהיר)', 'Ranked (fast)')}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="retrieval"
                  checked={this.state.retrievalMode === 'exhaustive'}
                  onChange={() => this._onRetrievalModeChange('exhaustive')}
                  aria-label={tr('סריקה מלאה', 'Full scan')}
                />
                <span>{tr('סריקה מלאה', 'Full scan')}</span>
              </label>
            </div>
          </>
        )}
      </div>
    );
  }

  /** Open-draft scope: subject opt-in + quick action chips. */
  _renderDraftTools() {
    const { resolvedScope, isProcessing, draftIncludeSubject, draftWriteMode } = this.state;
    const ready = !!resolvedScope && !resolvedScope.isEmpty && !isProcessing;
    const writeChip = (
      <button
        type="button"
        className={classNames('ai-draft-chip ai-draft-write-chip', { active: draftWriteMode })}
        data-ai-draft-write="true"
        aria-pressed={draftWriteMode}
        disabled={!resolvedScope || resolvedScope.isEmpty || isProcessing}
        title={tr(
          'כתוב הוראה, ו-AI יכתוב את המייל (או את התשובה). קודם תצוגה מקדימה - הטיוטה משתנה רק כשלוחצים "החל".',
          'Type an instruction and the AI writes the mail (or the reply). You get a preview first - the draft changes only on "Apply".'
        )}
        onClick={() => AISidebarStore.setDraftWriteMode(!draftWriteMode)}
      >
        {tr('✍️ כתוב עם AI', '✍️ Write with AI')}
      </button>
    );
    if (draftWriteMode) {
      return this._renderWriteTools(writeChip);
    }
    return (
      <div className="ai-draft-tools" dir={offlineDir()} data-ai-draft-tools="true">
        <div className="ai-draft-chips ai-draft-mode-row">{writeChip}</div>
        {this._renderDraftConversationBar()}
        <div
          className="ai-draft-chips"
          role="group"
          aria-label={tr('פעולות מהירות', 'Quick actions')}
        >
          {DRAFT_QUICK_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="ai-draft-chip"
              data-ai-draft-chip={a.id}
              disabled={!ready}
              onClick={() =>
                void AISidebarStore.submitQuery(a.request, { displayLabel: `📝 ${tr(a.he, a.en)}` })
              }
            >
              {tr(a.he, a.en)}
            </button>
          ))}
        </div>
        <label className="ai-draft-subject">
          <input
            type="checkbox"
            checked={draftIncludeSubject}
            data-ai-draft-include-subject="true"
            onChange={(e) => AISidebarStore.setDraftIncludeSubject(e.target.checked)}
          />
          <span>{tr('לשלוח גם את הנושא', 'Also send the subject')}</span>
        </label>
        <div className="gemini-estimate">
          {tr(
            '✨ נשלח רק בלחיצה: הבקשה וטקסט הטיוטה שלך. בלי נמענים, בלי הטקסט המצוטט/המועבר ובלי קבצים מצורפים.',
            '✨ Sent only on click: the request and your draft text. No recipients, no quoted/forwarded text and no attachments.'
          )}
        </div>
      </div>
    );
  }

  /** Apply an AI answer and remember it in the draft conversation as "applied". */
  _applyAi(
    msgId: string,
    draftId: string,
    text: string,
    how: 'replace' | 'append',
    subject: string | null
  ) {
    if (offlineDraftsStore.applyAiText(draftId, text, how, { subject })) {
      AISidebarStore.markDraftTurnApplied(msgId, how);
    }
  }

  _undoAi() {
    if (offlineDraftsStore.undoAi()) {
      AISidebarStore.markDraftTurnUndone();
    }
  }

  /** "Continues the conversation" indicator + 🆕 New conversation. */
  _renderDraftConversationBar() {
    const n = this.state.draftHistoryTurns;
    return (
      <div
        className={classNames('ai-draft-conv', { active: n > 0 })}
        data-ai-draft-conv={n}
        role="status"
      >
        <span className="ai-draft-conv-text">
          {n > 0
            ? tr(
                `🔗 ממשיך את השיחה: ${n} ${n === 1 ? 'בקשה קודמת ותשובה נשלחות' : 'בקשות ותשובות קודמות נשלחות'} כהקשר (עד 6 האחרונות). אפשר לבקש "קצר יותר", "בעברית" וכו׳.`,
                `🔗 Continuing the conversation: ${n} earlier ${n === 1 ? 'request and answer are' : 'requests and answers are'} sent as context (last 6 at most). You can ask "shorter", "in Hebrew", etc.`
              )
            : tr(
                'שיחה חדשה: הבקשה הבאה תתחיל בלי הקשר קודם.',
                'New conversation: the next request starts without earlier context.'
              )}
        </span>
        <button
          type="button"
          className="btn btn-small ai-draft-new-conv"
          data-ai-draft-new-conv="true"
          disabled={n === 0 || this.state.isProcessing}
          title={tr(
            'שוכח את הבקשות והתשובות הקודמות על הטיוטה הזו',
            'Forgets the earlier requests and answers about this draft'
          )}
          onClick={() => AISidebarStore.resetDraftConversation()}
        >
          {tr('🆕 שיחה חדשה', '🆕 New conversation')}
        </button>
      </div>
    );
  }

  /** Write-with-AI panel: what will be sent, with the reply/forward disclosure. */
  _renderWriteTools(writeChip: React.ReactNode) {
    const { draftIncludeSubject, draftIncludeThread } = this.state;
    const d = offlineDraftsStore.showing ? offlineDraftsStore.open : null;
    const kind = d ? d.kind : 'new';
    const answering = kind === 'reply' || kind === 'forward';
    return (
      <div
        className="ai-draft-tools ai-write-tools"
        dir={offlineDir()}
        data-ai-draft-tools="true"
        data-ai-write-tools={kind}
      >
        <div className="ai-draft-chips ai-draft-mode-row">{writeChip}</div>
        {this._renderDraftConversationBar()}
        <div className="ai-write-hint">
          {kind === 'reply'
            ? tr(
                'כתוב מה לענות (למשל: "תענה שאני מסכים אבל רק ביום שלישי"). ה-AI יכתוב רק את התשובה, מעל הציטוט - הציטוט נשאר כמו שהוא.',
                'Type what to answer (e.g. "Say I agree, but only on Tuesday"). The AI writes only the reply, above the quote - the quote stays as is.'
              )
            : kind === 'forward'
              ? tr(
                  'כתוב מה לכתוב מעל ההודעה המועברת. ההודעה המועברת נשארת כמו שהיא.',
                  'Type what to write above the forwarded message. The forwarded message stays as is.'
                )
              : tr(
                  'כתוב מה המייל צריך להגיד (למשל: "כתוב לי מייל לרואה החשבון שמבקש את הדוח השנתי"). תקבל נושא וגוף לתצוגה מקדימה לפני שמשהו משתנה.',
                  'Type what the mail should say (e.g. "Write to my accountant asking for the annual report"). You get a subject and body to preview before anything changes.'
                )}
        </div>
        {answering && (
          <div className="ai-write-disclosure" data-ai-write-disclosure="true" role="note">
            {tr(
              '⚠️ בלחיצה על "כתוב" נשלח ל-Gemini גם טקסט ההודעה המקורית (בלי קבצים מצורפים, מקוצר אם הוא ארוך).',
              '⚠️ On "Write", the text of the original message is also sent to Gemini (no attachments, shortened if long).'
            )}
          </div>
        )}
        {answering && (
          <label className="ai-draft-subject">
            <input
              type="checkbox"
              checked={draftIncludeThread}
              data-ai-write-include-thread="true"
              onChange={(e) => AISidebarStore.setDraftIncludeThread(e.target.checked)}
            />
            <span>
              {tr(
                'כלול את כל השיחה (עד 10 הודעות, טקסט בלבד)',
                'Include the whole conversation (up to 10 messages, text only)'
              )}
            </span>
          </label>
        )}
        <label className="ai-draft-subject">
          <input
            type="checkbox"
            checked={draftIncludeSubject}
            data-ai-draft-include-subject="true"
            onChange={(e) => AISidebarStore.setDraftIncludeSubject(e.target.checked)}
          />
          <span>{tr('לשלוח גם את הנושא', 'Also send the subject')}</span>
        </label>
        <div className="gemini-estimate">
          {answering
            ? tr(
                '✨ נשלח רק בלחיצה: ההוראה, הטקסט שכבר כתבת, וטקסט ההודעה המקורית. בלי נמעני הטיוטה ובלי קבצים מצורפים.',
                '✨ Sent only on click: the instruction, any text you already wrote, and the original message text. No draft recipients, no attachments.'
              )
            : tr(
                '✨ נשלח רק בלחיצה: ההוראה והטקסט שכבר כתבת (אם יש). בלי נמענים ובלי קבצים מצורפים.',
                '✨ Sent only on click: the instruction and any text you already wrote. No recipients, no attachments.'
              )}
        </div>
      </div>
    );
  }

  /** Write-with-AI answer: subject + body preview with Apply / Add at end / Copy / Undo. */
  _renderDraftComposePreview(msg: ConversationMessage) {
    const dc = msg.draftCompose;
    if (!dc) {
      return null;
    }
    const draft = offlineDraftsStore.drafts.find((x) => x.id === dc.draftId) || null;
    const exists = !!draft;
    const draftOpen =
      offlineDraftsStore.showing &&
      !!offlineDraftsStore.open &&
      offlineDraftsStore.open.id === dc.draftId;
    const subjectEmpty = !!draft && !draft.subject.trim();
    const ticked = !!this.state.composeSubjectTicks[msg.id];
    const subjectArg = (): string | null =>
      draft ? subjectToApply(draft.subject, dc.subject, ticked) : null;
    const copied = this.state.copiedId === msg.id;
    const copyText = dc.subject && dc.kind === 'new' ? `${dc.subject}\n\n${dc.body}` : dc.body;
    return (
      <div className="ai-compose-preview" data-ai-compose-preview={dc.kind}>
        {dc.subject && (
          <div className="ai-compose-subject">
            <span className="ai-compose-label">{tr('נושא:', 'Subject:')}</span>{' '}
            <span dir="auto" data-ai-compose-subject="true">
              {dc.subject}
            </span>
          </div>
        )}
        <div className="ai-compose-body" dir="auto" data-ai-compose-body="true">
          {dc.body}
        </div>
        {dc.subject && exists && (
          <label className="ai-draft-subject ai-compose-subject-tick">
            <input
              type="checkbox"
              checked={subjectEmpty || ticked}
              disabled={subjectEmpty}
              data-ai-compose-replace-subject="true"
              onChange={(e) =>
                this.setState({
                  composeSubjectTicks: {
                    ...this.state.composeSubjectTicks,
                    [msg.id]: e.target.checked,
                  },
                })
              }
            />
            <span>
              {subjectEmpty
                ? tr(
                    'הנושא בטיוטה ריק - הוא יתמלא',
                    'The draft subject is empty - it will be filled'
                  )
                : tr('גם להחליף את הנושא', 'Also replace the subject')}
            </span>
          </label>
        )}
        <div className="ai-draft-actions" data-ai-draft-actions="compose">
          <button
            type="button"
            className="btn btn-small ai-draft-apply"
            data-ai-compose-apply="replace"
            disabled={!exists || this.state.isProcessing}
            title={
              dc.kind === 'new'
                ? tr(
                    'מחליף את הטקסט בטיוטה בטקסט הזה. אפשר לבטל.',
                    'Replaces the draft text with this text. Can be undone.'
                  )
                : tr(
                    'כותב את התשובה מעל הציטוט (הציטוט נשמר). אפשר לבטל.',
                    'Writes the reply above the quote (the quote is kept). Can be undone.'
                  )
            }
            onClick={() => this._applyAi(msg.id, dc.draftId, dc.body, 'replace', subjectArg())}
          >
            {tr('✅ החל על הטיוטה', '✅ Apply to draft')}
          </button>
          <button
            type="button"
            className="btn btn-small"
            data-ai-compose-apply="append"
            disabled={!exists || this.state.isProcessing}
            onClick={() => this._applyAi(msg.id, dc.draftId, dc.body, 'append', subjectArg())}
          >
            {tr('➕ הוסף בסוף', '➕ Add at the end')}
          </button>
          <button
            type="button"
            className="btn btn-small"
            data-ai-compose-copy="true"
            onClick={() => {
              clipboard.writeText(copyText);
              this.setState({ copiedId: msg.id });
              window.setTimeout(() => {
                if (this.state.copiedId === msg.id) {
                  this.setState({ copiedId: null });
                }
              }, 1500);
            }}
          >
            {copied ? tr('✔️ הועתק', '✔️ Copied') : tr('📋 העתק', '📋 Copy')}
          </button>
          {offlineDraftsStore.canUndoAi && draftOpen && (
            <button
              type="button"
              className="btn btn-small"
              data-ai-draft-undo="true"
              onClick={() => this._undoAi()}
            >
              {tr('↩️ בטל שינוי', '↩️ Undo change')}
            </button>
          )}
          {!exists && (
            <span className="ai-draft-gone">{tr('הטיוטה נמחקה', 'The draft was deleted')}</span>
          )}
        </div>
      </div>
    );
  }

  _renderDraftAssistActions(msg: ConversationMessage) {
    const da = msg.draftAssist;
    if (!da) {
      return null;
    }
    const draftOpen =
      offlineDraftsStore.showing &&
      !!offlineDraftsStore.open &&
      offlineDraftsStore.open.id === da.draftId;
    const exists = offlineDraftsStore.drafts.some((x) => x.id === da.draftId);
    const copied = this.state.copiedId === msg.id;
    return (
      <div className="ai-draft-actions" data-ai-draft-actions={da.kind}>
        {da.kind === 'rewrite' && (
          <button
            type="button"
            className="btn btn-small ai-draft-apply"
            data-ai-draft-apply="replace"
            disabled={!exists || this.state.isProcessing}
            title={tr(
              'מחליף את הטקסט שלך בטיוטה (הציטוט נשמר). אפשר לבטל.',
              'Replaces your text in the draft (the quote is kept). Can be undone.'
            )}
            onClick={() => this._applyAi(msg.id, da.draftId, da.text, 'replace', null)}
          >
            {tr('✅ החל על הטיוטה', '✅ Apply to draft')}
          </button>
        )}
        {da.kind === 'rewrite' && (
          <button
            type="button"
            className="btn btn-small"
            data-ai-draft-apply="append"
            disabled={!exists || this.state.isProcessing}
            onClick={() => this._applyAi(msg.id, da.draftId, da.text, 'append', null)}
          >
            {tr('➕ הוסף בסוף', '➕ Add at the end')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-small"
          data-ai-draft-copy="true"
          onClick={() => {
            clipboard.writeText(da.text);
            this.setState({ copiedId: msg.id });
            window.setTimeout(() => {
              if (this.state.copiedId === msg.id) {
                this.setState({ copiedId: null });
              }
            }, 1500);
          }}
        >
          {copied ? tr('✔️ הועתק', '✔️ Copied') : tr('📋 העתק', '📋 Copy')}
        </button>
        {offlineDraftsStore.canUndoAi && draftOpen && (
          <button
            type="button"
            className="btn btn-small"
            data-ai-draft-undo="true"
            onClick={() => this._undoAi()}
          >
            {tr('↩️ בטל שינוי', '↩️ Undo change')}
          </button>
        )}
        {!exists && (
          <span className="ai-draft-gone">{tr('הטיוטה נמחקה', 'The draft was deleted')}</span>
        )}
      </div>
    );
  }

  _writePlaceholder(): string {
    const d = offlineDraftsStore.showing ? offlineDraftsStore.open : null;
    if (this.state.draftHistoryTurns > 0) {
      return tr(
        '🔗 המשך לשפר את התשובה האחרונה, למשל: "קצר יותר", "תתייחס לתוכן המייל", "בעברית" (Enter לכתיבה)',
        '🔗 Keep refining the last answer, e.g. "shorter", "refer to the mail content", "in Hebrew" (Enter to write)'
      );
    }
    if (d && d.kind === 'reply') {
      return tr(
        '✍️ מה לענות? למשל: "תענה שאני מסכים אבל רק ביום שלישי" (Enter לכתיבה)',
        '✍️ What should the reply say? e.g. "Say I agree, but only on Tuesday" (Enter to write)'
      );
    }
    if (d && d.kind === 'forward') {
      return tr(
        '✍️ מה לכתוב מעל ההודעה המועברת? (Enter לכתיבה)',
        '✍️ What should go above the forwarded message? (Enter to write)'
      );
    }
    return tr(
      '✍️ מה לכתוב? למשל: "כתוב לי מייל לרואה החשבון שמבקש את הדוח השנתי" (Enter לכתיבה)',
      '✍️ What should I write? e.g. "Write to my accountant asking for the annual report" (Enter to write)'
    );
  }

  _openExternal(url: string) {
    if (url === GEMINI_BILLING_URL || url === GEMINI_API_KEYS_URL) {
      void shell.openExternal(url);
    }
  }

  _usageRow(label: string, t: GeminiUsageTotals) {
    return (
      <tr key={label}>
        <th scope="row">{label}</th>
        <td>{t.calls}</td>
        <td>{fmtTokens(t.totalTokens)}</td>
        <td dir="ltr">{fmtUsd(t.usd)}</td>
        <td dir="ltr">{fmtIls(t.ils)}</td>
      </tr>
    );
  }

  _onSaveBudget = () => {
    const n = Number(String(this.state.budgetDraft).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n > 0) {
      void AISidebarStore.setGeminiBudget(n);
      this.setState({ budgetDraft: '' });
    }
  };

  _onResetUsage = () => {
    if (!this.state.usageResetArmed) {
      this.setState({ usageResetArmed: true });
      return;
    }
    this.setState({ usageResetArmed: false });
    void AISidebarStore.resetGeminiUsage();
  };

  _renderGeminiUsage() {
    const u = this.state.geminiUsage;
    if (!isOfflineArchiveMode() || !u || !u.available) {
      return null;
    }
    const pct = Math.round(u.budgetUsedRatio * 100);
    const since = u.since ? new Date(u.since).toLocaleString(offlineDateLocale()) : null;
    return (
      <div
        className={classNames('gemini-usage', { warn: u.warn })}
        dir={offlineDir()}
        data-gemini-usage="true"
        data-gemini-usage-warn={u.warn ? 'true' : 'false'}
      >
        <button
          type="button"
          className="gemini-usage-line"
          data-gemini-usage-toggle="true"
          aria-expanded={this.state.usageExpanded}
          onClick={() => this.setState({ usageExpanded: !this.state.usageExpanded })}
        >
          <span>
            {tr(
              `📊 Gemini היום: ${u.today.calls} קריאות · ${fmtTokens(u.today.totalTokens)} טוקנים · ≈`,
              `📊 Gemini today: ${u.today.calls} calls · ${fmtTokens(u.today.totalTokens)} tokens · ≈`
            )}
            {fmtIls(u.today.ils)}
            {u.warn ? tr(` · ⚠️ ${pct}% מהתקציב`, ` · ⚠️ ${pct}% of budget`) : ''}
          </span>
          <span className="gemini-usage-more">
            {this.state.usageExpanded ? tr('הסתר ▴', 'Hide ▴') : tr('פרטים ▾', 'Details ▾')}
          </span>
        </button>
        {u.warn && (
          <div className="gemini-usage-warning" data-gemini-budget-warning="true">
            {tr(
              `⚠️ לפי הספירה המקומית נוצלו כ-${pct}% מהתקציב (${fmtIls(u.total.ils)} מתוך ₪${u.budgetIls}). זו הערכה בלבד — היתרה המדויקת מוצגת בדף החיוב של Google.`,
              `⚠️ By the local count about ${pct}% of the budget is used (${fmtIls(u.total.ils)} of ₪${u.budgetIls}). This is an estimate only — the exact balance is on Google's billing page.`
            )}
          </div>
        )}
        {this.state.usageExpanded && (
          <div className="gemini-usage-details" data-gemini-usage-details="true">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>{tr('קריאות', 'Calls')}</th>
                  <th>{tr('טוקנים', 'Tokens')}</th>
                  <th>{tr('$ משוער', 'Est. $')}</th>
                  <th>{tr('₪ משוער', 'Est. ₪')}</th>
                </tr>
              </thead>
              <tbody>
                {this._usageRow(tr('היום', 'Today'), u.today)}
                {this._usageRow(tr('בהפעלה הזו', 'This session'), u.session)}
                {this._usageRow(
                  since
                    ? tr(`מאז ${since}`, `Since ${since}`)
                    : tr('מאז החיבור', 'Since connecting'),
                  u.total
                )}
              </tbody>
            </table>
            <div className="gemini-usage-budget">
              <span>
                {tr(
                  `תקציב: ₪${u.budgetIls} · נוצל כ-${pct}% (הערכה)`,
                  `Budget: ₪${u.budgetIls} · about ${pct}% used (estimate)`
                )}
              </span>
              <input
                type="number"
                min={1}
                step={1}
                dir="ltr"
                placeholder={String(u.budgetIls)}
                aria-label={tr('תקציב בשקלים', 'Budget in shekels')}
                data-gemini-budget-input="true"
                value={this.state.budgetDraft}
                onChange={(e) => this.setState({ budgetDraft: e.target.value })}
              />
              <button type="button" onClick={this._onSaveBudget} data-gemini-budget-save="true">
                {tr('שמור', 'Save')}
              </button>
            </div>
            <div className="gemini-usage-actions">
              <button
                type="button"
                className="gemini-billing-btn"
                data-gemini-open-billing="true"
                onClick={() => this._openExternal(GEMINI_BILLING_URL)}
              >
                {tr('💳 פתח יתרה ב-Google', '💳 Open balance at Google')}
              </button>
              <button
                type="button"
                className={classNames('gemini-usage-reset', { armed: this.state.usageResetArmed })}
                data-gemini-usage-reset="true"
                onClick={this._onResetUsage}
              >
                {this.state.usageResetArmed
                  ? tr('לחץ שוב לאישור איפוס', 'Click again to confirm reset')
                  : tr('אפס מונה', 'Reset meter')}
              </button>
            </div>
            <p className="gemini-usage-note">
              {tr(
                `הערכה בלבד: ${u.model} לפי $${u.pricing.input} / $${u.pricing.output} למיליון טוקנים (קלט/פלט, מחירון Google מ-${u.pricingChecked}), ₪ לפי שער ${u.usdToIls}. אין API רשמי ליתרת הקרדיט — היתרה המדויקת (יעד הטענה ₪60 ל-yahoo-agent) מוצגת רק בדף החיוב של Google. שימוש לפני ${since || 'החיבור'} לא נרשם כאן.`,
                `Estimate only: ${u.model} at $${u.pricing.input} / $${u.pricing.output} per million tokens (input/output, Google price list from ${u.pricingChecked}), ₪ at rate ${u.usdToIls}. There is no official API for the credit balance — the exact balance (₪60 top-up target for yahoo-agent) is only on Google's billing page. Usage before ${since || 'connecting'} is not counted here.`
              )}
            </p>
          </div>
        )}
      </div>
    );
  }

  _renderGeminiEstimate() {
    const { resolvedScope, geminiStatus } = this.state;
    if (!isOfflineArchiveMode() || !geminiStatus?.configured || !resolvedScope) {
      return null;
    }
    const count = resolvedScope.messageCount || 0;
    if (!count) {
      return null;
    }
    const n = estimateGeminiSendCount(count);
    const text =
      resolvedScope.mode === 'selected-messages'
        ? tr(
            `בלחיצה על "שלח" יישלחו ל-Gemini ${n} הודעות נבחרות` +
              (count > n ? ` (מתוך ${count}, החדשות ביותר)` : ''),
            `Clicking "Send" sends ${n} selected messages to Gemini` +
              (count > n ? ` (of ${count}, newest first)` : '')
          )
        : tr(
            `בלחיצה על "שלח": חיפוש מקומי ב-${count.toLocaleString()} הודעות, ` +
              `ואז יישלחו ל-Gemini עד ${n} הרלוונטיות ביותר`,
            `Clicking "Send": local search in ${count.toLocaleString()} messages, ` +
              `then up to ${n} of the most relevant are sent to Gemini`
          );
    return (
      <div className="gemini-estimate" dir={offlineDir()} data-gemini-estimate={n}>
        ✨ {text}
        {tr(
          `. עלות משוערת: ${GEMINI_SCOPED_COST_NOTE} לשאלה לכל היותר. בלי קבצים מצורפים.`,
          `. Estimated cost: at most ${GEMINI_SCOPED_COST_NOTE} per question. No attachments.`
        )}
      </div>
    );
  }

  _renderOfflineGuide() {
    return (
      <div className="ai-sidebar-guide" dir={offlineDir()} data-offline-guide="true">
        <div className="guide-title">
          {tr(
            'מה זה? עוזר שעונה על שאלות על הדואר שלך',
            'What is this? An assistant that answers questions about your mail'
          )}
        </div>
        <div>
          {tr(
            'הוא עובד רק על העותק המקומי (קריאה בלבד), בלי חיבור ל-Yahoo.',
            'It works only on the local copy (read-only), with no connection to Yahoo.'
          )}
        </div>
        <ol>
          <li>
            {tr('בחר טווח למעלה: ', 'Choose a range above: ')}
            <b>{tr('נבחרות', 'Selected')}</b>
            {tr(' = ההודעות שסימנת ברשימה, ', ' = the messages you marked in the list, ')}
            <b>{tr('תיקייה', 'Folder')}</b>
            {tr(' = התיקייה הפתוחה, ', ' = the open folder, ')}
            <b>{tr('הכל', 'All')}</b>
            {tr(' = כל תיבת הדואר, ', ' = the whole mailbox, ')}
            <b>{tr('📝 טיוטה פתוחה', '📝 Open draft')}</b>
            {tr(
              ' = הטיוטה שאתה כותב (נבחר לבד כשטיוטה פתוחה).',
              ' = the draft you are writing (chosen automatically when a draft is open).'
            )}
          </li>
          <li>
            {tr(
              'כתוב שאלה בתיבה למטה, למשל: "חפש חשבוניות מהחודש האחרון".',
              'Type a question in the box below, for example: "Find invoices from last month".'
            )}
          </li>
          <li>
            {tr('לחץ ', 'Click ')}
            <b>{tr('שלח', 'Send')}</b>
            {tr(
              '. לחיצה על מקור בתשובה פותחת את ההודעה.',
              '. Clicking a source in the answer opens the message.'
            )}
          </li>
          <li>
            {tr(
              'בטיוטה: לחץ על פעולה מהירה (תקצר, רשמי יותר, תרגם…) או כתוב בקשה. כשמתקבל נוסח חדש: "החל על הטיוטה" (אפשר לבטל), "הוסף בסוף" או "העתק".',
              'In a draft: click a quick action (Shorten, More formal, Translate…) or type a request. When a new version comes back: "Apply to draft" (can be undone), "Add at the end" or "Copy".'
            )}
          </li>
        </ol>
        {this.state.geminiStatus?.configured ? (
          <div className="guide-note">
            {tr(
              `Gemini מחובר: "שלח" עונה עם Gemini (בתשלום). בתיקייה או בכל הדואר מתבצע קודם חיפוש מקומי, ונשלחות רק ההודעות הרלוונטיות (עד ${GEMINI_SCOPED_MAX_MESSAGES}). "סכם עם Gemini" מסכם הודעה אחת שנבחרה.`,
              `Gemini connected: "Send" answers with Gemini (paid). For a folder or all mail a local search runs first, and only the relevant messages are sent (up to ${GEMINI_SCOPED_MAX_MESSAGES}). "Summarize with Gemini" summarizes one selected message.`
            )}
          </div>
        ) : (
          <div className="guide-note">
            {tr(
              'כרגע התשובות הן הדגמה בלבד (Mock) - חיפוש מקומי פשוט, לא AI אמיתי. Gemini כבוי.',
              'Right now answers are a demo only (Mock) - a simple local search, not real AI. Gemini is off.'
            )}
          </div>
        )}
      </div>
    );
  }

  _renderConversation() {
    const { conversation } = this.state;

    if (conversation.length === 0) {
      if (isOfflineArchiveMode()) {
        return <div className="ai-sidebar-empty">{this._renderOfflineGuide()}</div>;
      }
      return (
        <div className="ai-sidebar-empty">
          <div className="empty-icon">💬</div>
          <div className="empty-text">
            שאל שאלה על ההודעות שלך
            <br />
            <small>Ask a question about your emails</small>
          </div>
          <div className="empty-examples">
            <strong>דוגמאות:</strong>
            <ul>
              <li>חפש חשבוניות מהחודש האחרון</li>
              <li>חפש הודעת ארכיון</li>
              <li>Find invoices from last month</li>
              <li>סכם את השרשור הזה</li>
            </ul>
          </div>
        </div>
      );
    }

    return (
      <div className="ai-sidebar-messages">
        {conversation.map((msg) => this._renderMessage(msg))}
        <div ref={this._messagesEndRef} />
      </div>
    );
  }

  _renderMessage(msg: ConversationMessage) {
    const isUser = msg.role === 'user';
    const isError = msg.role === 'system';

    return (
      <div
        key={msg.id}
        className={classNames('message', {
          'message-user': isUser,
          'message-assistant': msg.role === 'assistant',
          'message-error': isError && !msg.notice,
          'message-notice': isError && !!msg.notice,
          'message-mock': msg.isMock,
        })}
      >
        {this._renderDraftComposePreview(msg)}
        <div className={classNames('message-content', { 'ai-compose-note': !!msg.draftCompose })}>
          {this._renderMessageContent(msg.content)}
        </div>
        {(msg.geminiErrorKind === 'billing-exhausted' || msg.geminiErrorKind === 'invalid-key') && (
          <button
            type="button"
            className="gemini-billing-btn"
            data-gemini-error-action={msg.geminiErrorKind}
            onClick={() =>
              this._openExternal(
                msg.geminiErrorKind === 'invalid-key' ? GEMINI_API_KEYS_URL : GEMINI_BILLING_URL
              )
            }
          >
            {msg.geminiErrorKind === 'invalid-key'
              ? tr('🔑 פתח את מפתחות ה-API ב-Google', '🔑 Open API keys at Google')
              : tr('💳 פתח יתרה וחיוב ב-Google', '💳 Open balance and billing at Google')}
          </button>
        )}

        {this._renderDraftAssistActions(msg)}

        {msg.citations && msg.citations.length > 0 && (
          <div className="message-citations">
            <div className="citations-header">{tr('📎 מקורות:', '📎 Sources:')}</div>
            {msg.citations.map((citation, i) => (
              <button
                key={`${citation.messageId}-${i}`}
                className="citation-btn"
                onClick={() => this._onCitationClick(citation)}
                title={`${isSelectedSummarySurface() ? 'Selected' : 'DEMO'} ${citation.messageId}\n${tr('מ:', 'From:')} ${citation.from}\n${citation.snippet}`}
                aria-label={`${isSelectedSummarySurface() ? tr('מקור', 'Source') : 'מקור DEMO'} ${citation.messageId}: ${citation.subject}`}
                data-message-id={citation.messageId}
              >
                <span className="citation-index">[{i + 1}]</span>
                <span className="citation-subject" data-citation-wrap="true">
                  {citation.subject}
                </span>
                <span className="citation-id">{citation.messageId}</span>
              </button>
            ))}
          </div>
        )}

        {msg.isMock && (
          <div className="mock-indicator">
            {isOfflineArchiveMode()
              ? tr(
                  '🔧 תשובת הדגמה (Mock) — Gemini לא מחובר',
                  '🔧 Demo answer (Mock) — Gemini not connected'
                )
              : '🔧 Mock Response'}
          </div>
        )}
        {msg.role === 'assistant' && msg.isMock === false && (
          <div className="live-indicator">
            {isOfflineArchiveMode()
              ? tr('✨ Gemini (בתשלום · yahoo-agent)', '✨ Gemini (paid · yahoo-agent)')
              : isRealSelectedSummaryMode()
                ? 'Gemini Developer API · one selected message · paid project required'
                : 'Gemini Developer API · DEMO synthetic · paid project required'}
          </div>
        )}
      </div>
    );
  }

  _renderMessageContent(content: string) {
    // Safe rendering - escape HTML to prevent injection
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Convert markdown-like formatting
    const formatted = escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br />');

    return (
      <div className="message-text" dir="auto" dangerouslySetInnerHTML={{ __html: formatted }} />
    );
  }

  _renderProgress() {
    const { progress, isProcessing } = this.state;
    if (!isProcessing) return null;

    return (
      <div className="ai-sidebar-progress">
        <Spinner visible />
        <span className="progress-text">
          {this.state.progressPhase === 'local'
            ? tr('מחפש בעותק המקומי... ', 'Searching the local copy... ') +
              `${progress?.processed || 0}${progress?.totalEligible ? ` / ${progress.totalEligible}` : ''}`
            : this.state.progressPhase === 'gemini'
              ? tr(
                  `שולח ${progress?.totalEligible || 0} הודעות ל-Gemini וממתין לתשובה...`,
                  `Sending ${progress?.totalEligible || 0} messages to Gemini and waiting for the answer...`
                )
              : progress
                ? tr(
                    `מעבד ${progress.processed || 0}${
                      progress.totalEligible ? ` מתוך ${progress.totalEligible}` : ''
                    } הודעות...`,
                    `Processing ${progress.processed || 0}${
                      progress.totalEligible ? ` of ${progress.totalEligible}` : ''
                    } messages...`
                  )
                : tr('מעבד...', 'Processing...')}
        </span>
        <button className="cancel-btn" onClick={this._onCancel} aria-label={tr('ביטול', 'Cancel')}>
          {tr('ביטול', 'Cancel')}
        </button>
      </div>
    );
  }

  _renderOfflineArchivePicker() {
    if (!isOfflineArchiveMode()) return null;
    // The main window's folder tree and message list replace this picker.
    if (isOfflineArchiveBrowserDriven()) return null;
    const catalog = getOfflineArchiveCatalog();
    const manifest = getOfflineArchiveManifest();
    const selected = this.state.realPreview?.messageId;
    const folderSummary = manifest
      ? Object.entries(manifest.folderCounts)
          .map(([name, n]) => `${name}: ${n}`)
          .join(' · ')
      : catalog.length
        ? `${catalog.length} messages`
        : 'empty archive';
    const missing =
      manifest && manifest.emptyFolders.length ? manifest.emptyFolders.join(', ') : '';
    const unreadable =
      manifest && manifest.unreadable.length
        ? manifest.unreadable.map((u) => u.path).join(', ')
        : '';
    return (
      <div className="ai-sidebar-real-preview" data-offline-archive-list="true">
        <div className="demo-preview-banner">ארכיון מקומי מנותק — Yahoo לא בשימוש</div>
        <p className="real-disclosure">{folderSummary}</p>
        {missing ? <p className="real-disclosure">Empty folders: {missing}</p> : null}
        {unreadable ? <p className="real-disclosure">Unreadable: {unreadable}</p> : null}
        {catalog.length === 0 ? (
          <p>No local archive loaded. Pass --offline-archive-path to an .eml/maildir/mbox tree.</p>
        ) : (
          <div role="list" aria-label="Local archive messages">
            {catalog.map((m) => (
              <button
                key={m.id}
                type="button"
                className={classNames('citation-btn', { active: m.id === selected })}
                data-offline-archive-pick={m.id}
                aria-label={`Select local archive message ${m.subject}`}
                onClick={() => AISidebarStore.selectOfflineArchiveMessage(m.id)}
              >
                <span className="citation-subject">{m.folderPath}</span>
                <span className="citation-id">{m.subject}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  _renderRealSelectionPreview() {
    const preview = this.state.realPreview;
    if (!isSelectedSummarySurface()) return null;
    const offline = isOfflineArchiveMode();
    // Offline browser: the reader shows the message. The pre-send disclosure
    // only matters when Gemini is configured for an explicit Summarize.
    if (offline && isOfflineArchiveBrowserDriven() && !this.state.geminiStatus?.configured) {
      return null;
    }
    if (!preview) {
      return (
        <div
          className="ai-sidebar-real-preview"
          data-real-selected-empty="true"
          data-offline-archive-empty={offline ? 'true' : undefined}
        >
          <p>
            {offline && this.state.scopeMode === 'open-draft' && this.state.draftWriteMode
              ? tr(
                  'כתיבה עם AI: כתוב הוראה ולחץ "כתוב". תקבל תצוגה מקדימה, והטיוטה משתנה רק כשתלחץ "החל" (ואפשר לבטל).',
                  'Write with AI: type an instruction and click "Write". You get a preview; the draft changes only when you click "Apply" (and it can be undone).'
                )
              : offline && this.state.scopeMode === 'open-draft'
                ? tr(
                    'עזרה בטיוטה: לחץ על פעולה מהירה או כתוב בקשה ולחץ "שלח". נשלח רק טקסט הטיוטה שלך, ורק בלחיצה.',
                    'Draft help: click a quick action or type a request and click "Send". Only your draft text is sent, and only on click.'
                  )
                : offline
                  ? tr(
                      'שאל שאלה ולחץ "שלח" (לפי הטווח שנבחר), בחר הודעה אחת ולחץ "סכם", או פתח טיוטה כדי לקבל עזרה בכתיבה. שום דבר לא נשלח בלי לחיצה.',
                      'Ask a question and click "Send" (for the chosen range), select one message and click "Summarize", or open a draft to get writing help. Nothing is sent without a click.'
                    )
                  : 'בחר הודעה אחת בשרשור. סיכום נשלח רק אחרי לחיצה על Summarize.'}
          </p>
          <p>
            {offline
              ? 'Disconnected local archive. Yahoo is not contacted. Attachments stay local.'
              : 'Select exactly one message. Nothing is sent until you click Summarize. Attachments and other mail stay local.'}
          </p>
        </div>
      );
    }
    return (
      <div
        className={classNames('ai-sidebar-real-preview', {
          collapsed: !this.state.previewExpanded,
        })}
        role="region"
        aria-label="Selected message disclosure"
        data-real-selected-id={preview.messageId}
        data-real-selected-epoch={String(preview.snapshotEpoch)}
        data-offline-archive-id={offline ? preview.messageId : undefined}
        data-preview-collapsed={this.state.previewExpanded ? 'false' : 'true'}
      >
        {this._renderPreviewToggle(
          tr(
            `📄 ההודעה שתישלח: ${this._selectedSendCount()} · נשלחת רק בלחיצה`,
            `📄 Message to send: ${this._selectedSendCount()} · sent only on click`
          )
        )}
        {this.state.previewExpanded && this._renderRealPreviewDetails(preview, offline)}
      </div>
    );
  }

  _selectedSendCount(): number {
    const { resolvedScope } = this.state;
    if (resolvedScope && resolvedScope.mode === 'selected-messages' && resolvedScope.messageCount) {
      return estimateGeminiSendCount(resolvedScope.messageCount);
    }
    return 1;
  }

  _renderRealPreviewDetails(preview: RealSelectedPreview, offline: boolean) {
    return (
      <>
        <div className="demo-preview-banner">
          {offline
            ? tr(
                'הודעה מארכיון מקומי — תישלח ל-Gemini רק אחרי Summarize',
                'Message from the local archive — sent to Gemini only after Summarize'
              )
            : 'הודעה נבחרת — תישלח ל-Gemini רק אחרי Summarize'}
        </div>
        <dl className="demo-preview-meta">
          <dt>{tr('מזהה', 'ID')}</dt>
          <dd>{preview.messageId}</dd>
          <dt>{tr('נושא', 'Subject')}</dt>
          <dd>{preview.subject}</dd>
          <dt>{tr('מאת', 'From')}</dt>
          <dd>{preview.from}</dd>
          <dt>{tr('תאריך', 'Date')}</dt>
          <dd>{preview.date}</dd>
        </dl>
        <pre className="demo-preview-body" data-preview-wrap="true">
          {preview.bodyPreview}
        </pre>
        <p className="real-disclosure">{preview.disclosure}</p>
      </>
    );
  }

  _renderDemoPreview() {
    const preview = this.state.demoPreview;
    if (!preview) return null;
    const realSelected = isRealSelectedSummaryMode();
    const offline = isOfflineArchiveMode();

    return (
      <div
        className={classNames('ai-sidebar-demo-preview', {
          collapsed: !this.state.previewExpanded,
        })}
        role="region"
        aria-label={realSelected || offline ? 'Selected message preview' : 'DEMO source preview'}
        data-demo-preview={preview.messageId}
        data-preview-collapsed={this.state.previewExpanded ? 'false' : 'true'}
      >
        {this._renderPreviewToggle(tr('📄 תצוגת מקור · 1', '📄 Source view · 1'))}
        {this.state.previewExpanded && (
          <>
            <div className="demo-preview-banner">
              {offline
                ? tr(
                    'תצוגת אותה הודעה מארכיון מקומי — Yahoo לא בשימוש',
                    'Same message from the local archive — Yahoo not used'
                  )
                : realSelected
                  ? 'תצוגת אותה הודעה נבחרת — לא סומן כנקרא'
                  : '🧪 DEMO מקור סינתטי — לא תיבת דואר אמיתית'}
            </div>
            <dl className="demo-preview-meta">
              <dt>{tr('מזהה', 'ID')}</dt>
              <dd>{preview.messageId}</dd>
              <dt>{tr('נושא', 'Subject')}</dt>
              <dd>{preview.subject}</dd>
              <dt>{tr('מאת', 'From')}</dt>
              <dd>{preview.from}</dd>
              <dt>{tr('תיקייה', 'Folder')}</dt>
              <dd>{preview.folderName}</dd>
            </dl>
            <pre className="demo-preview-body" data-preview-wrap="true">
              {preview.body}
            </pre>
            <button
              className="demo-preview-close"
              onClick={() => AISidebarStore.closeDemoPreview()}
              aria-label="סגור תצוגת מקור DEMO"
            >
              {tr('סגור תצוגת מקור', 'Close source view')}
            </button>
          </>
        )}
      </div>
    );
  }

  _renderInput() {
    if (
      isSelectedSummarySurface() &&
      !(isOfflineArchiveMode() && isOfflineArchiveBrowserDriven())
    ) {
      const { isProcessing, realPreview, geminiStatus } = this.state;
      const ready = !!realPreview && !!geminiStatus?.configured;
      const offline = isOfflineArchiveMode();
      return (
        <div
          className="ai-sidebar-input"
          data-real-selected-actions="true"
          data-offline-archive-actions={offline ? 'true' : undefined}
        >
          <button
            className="submit-btn"
            onClick={this._onSummarizeSelected}
            disabled={isProcessing || !ready}
            aria-label="Summarize selected message"
            data-real-selected-summarize="true"
            data-offline-archive-summarize={offline ? 'true' : undefined}
          >
            Summarize
          </button>
          {this.state.conversation.length > 0 && (
            <button className="clear-btn" onClick={this._onClear} aria-label={tr('נקה', 'Clear')}>
              {tr('נקה', 'Clear')}
            </button>
          )}
        </div>
      );
    }
    const { isProcessing, resolvedScope } = this.state;
    const isDisabled = isProcessing || (resolvedScope && resolvedScope.isEmpty);
    const hasText = !!this.state.inputValue.trim();
    const canSend = !isDisabled && hasText;

    return (
      <div className="ai-sidebar-input">
        <label className="input-label" htmlFor="ai-sidebar-question">
          {this.state.scopeMode === 'open-draft' && this.state.draftWriteMode
            ? tr('✍️ הוראה ל-AI (מה לכתוב)', '✍️ Instruction for the AI (what to write)')
            : tr('✍️ שאלה ל-AI', '✍️ Question for the AI')}
        </label>
        {isOfflineArchiveMode() ? <OfflineHelpTip tip="ai" /> : null}
        <textarea
          id="ai-sidebar-question"
          ref={this._inputRef}
          className={classNames('input-textarea', { 'has-text': hasText })}
          placeholder={
            resolvedScope?.isEmpty
              ? this.state.scopeMode === 'open-draft'
                ? tr('פתח טיוטה קודם…', 'Open a draft first…')
                : tr(
                    'סמן הודעות, בחר תיקייה, או פתח טיוטה…',
                    'Mark messages, choose a folder, or open a draft…'
                  )
              : this.state.scopeMode === 'open-draft' && this.state.draftWriteMode
                ? this._writePlaceholder()
                : this.state.scopeMode === 'open-draft'
                  ? tr(
                      '📝 מה לעשות עם הטיוטה? למשל: "תקצר לשלוש שורות" (Enter לשליחה)',
                      '📝 What should I do with the draft? e.g. "Shorten to three lines" (Enter to send)'
                    )
                  : tr(
                      '✍️ כתוב כאן שאלה ל-AI… (Enter לשליחה)',
                      '✍️ Type a question for the AI… (Enter to send)'
                    )
          }
          value={this.state.inputValue}
          onChange={this._onInputChange}
          onKeyDown={this._onInputKeyDown}
          disabled={isDisabled}
          dir="auto"
        />
        <div className="input-actions">
          <button
            className={classNames('submit-btn', { ready: canSend })}
            onClick={this._onSubmit}
            disabled={!canSend}
            aria-label={tr('שלח', 'Send')}
            title={
              canSend
                ? tr('שלח את השאלה (Enter)', 'Send the question (Enter)')
                : isProcessing
                  ? tr('ממתין לתשובה…', 'Waiting for the answer…')
                  : tr('כתוב שאלה כדי לשלוח', 'Type a question to send')
            }
          >
            {this.state.scopeMode === 'open-draft' && this.state.draftWriteMode
              ? canSend
                ? tr('✍️ כתוב ➤', '✍️ Write ➤')
                : tr('✍️ כתוב', '✍️ Write')
              : canSend
                ? tr('שלח ➤', 'Send ➤')
                : tr('שלח', 'Send')}
          </button>
          {isOfflineArchiveMode() && this.state.scopeMode !== 'open-draft' && (
            <button
              className={classNames('clear-btn', 'ai-ask-mail-btn', {
                ready: hasText && !isProcessing,
              })}
              onClick={this._onAskAboutMail}
              disabled={isProcessing || !hasText}
              data-ai-ask-mail="true"
              aria-label={tr('חפש בכל הדואר ושאל', 'Search all mail and ask')}
              title={tr(
                'חיפוש מקומי בכל הדואר לפי מילות השאלה, ואז Gemini עונה רק מ-12 ההודעות המתאימות ביותר (טקסט בלבד, עם קישורים להודעות). בלי Gemini מחובר: רק רשימת ההודעות שנמצאו, שום דבר לא נשלח.',
                'Local search over all mail using the words in the question, then Gemini answers only from the top 12 matches (text only, with links to the messages). Without Gemini connected: just the list of matches; nothing is sent.'
              )}
            >
              {tr('🔎 חפש ושאל', '🔎 Search & ask')}
            </button>
          )}
          {isOfflineArchiveMode() && this.state.scopeMode !== 'open-draft' && (
            <button
              className="clear-btn"
              onClick={this._onSummarizeSelected}
              // Enabled even when Gemini is off: the click re-reads the key and,
              // if it is still missing, explains how to store it.
              disabled={isProcessing}
              aria-label="Summarize selected message with Gemini"
              title={
                this.state.geminiStatus?.configured
                  ? tr(
                      'שולח ל-Gemini (בתשלום) רק את ההודעה האחת שנבחרה',
                      'Sends only the one selected message to Gemini (paid)'
                    )
                  : tr(
                      'Gemini לא מחובר - לחיצה תסביר איך להפעיל',
                      'Gemini not connected - click to see how to turn it on'
                    )
              }
              data-offline-archive-summarize="true"
              data-gemini-configured={this.state.geminiStatus?.configured ? 'true' : 'false'}
            >
              {tr('✨ סכם עם Gemini', '✨ Summarize with Gemini')}
            </button>
          )}
          {this.state.conversation.length > 0 && (
            <button className="clear-btn" onClick={this._onClear} aria-label={tr('נקה', 'Clear')}>
              {tr('נקה', 'Clear')}
            </button>
          )}
        </div>
      </div>
    );
  }

  _renderError() {
    const { error } = this.state;
    if (!error) return null;

    return <div className="ai-sidebar-error">❌ {error}</div>;
  }

  render() {
    const demo = isDemoMode();
    const realSelected = isRealSelectedSummaryMode();
    const offline = isOfflineArchiveMode();
    const composerTab = demo && this.state.demoTab === 'composer';
    return (
      <div
        className="ai-sidebar"
        ref={this._rootRef}
        dir={offline ? offlineDir() : 'rtl'}
        data-demo-ready={demo ? 'true' : undefined}
        data-real-selected-summary={realSelected ? 'true' : undefined}
        data-offline-archive={offline ? 'true' : undefined}
      >
        <div className="ai-sidebar-header">
          {offline ? (
            <h2 className="ai-brand-title" data-ai-brand-title="true">
              <OfflineBrandLogo size={24} className="ai-brand-logo" />
              <span>{tr(`עוזר ${OFFLINE_BRAND_NAME}`, `${OFFLINE_BRAND_NAME} assistant`)}</span>
            </h2>
          ) : (
            <h2>{tr('🤖 עוזר AI', '🤖 AI assistant')}</h2>
          )}
          <span
            className={classNames('provider-badge', {
              'gemini-on': offline && !!this.state.geminiStatus?.configured,
            })}
            data-provider-badge="true"
            dir={offline ? offlineDir() : 'rtl'}
          >
            {offline
              ? this.state.geminiStatus?.configured
                ? tr('מצב: Gemini מחובר', 'Status: Gemini connected')
                : tr('מצב: Mock (Gemini כבוי)', 'Status: Mock (Gemini off)')
              : this.state.providerName}
          </span>
        </div>

        {demo && (
          <div className="demo-surface-tabs" role="tablist" aria-label="לוחות DEMO">
            <button
              type="button"
              role="tab"
              aria-label="עוזר AI"
              aria-selected={this.state.demoTab === 'ai'}
              className={classNames({ active: this.state.demoTab === 'ai' })}
              onClick={() => this.setState({ demoTab: 'ai' })}
            >
              עוזר AI
            </button>
            <button
              type="button"
              role="tab"
              aria-label="עורך DEMO"
              aria-selected={this.state.demoTab === 'composer'}
              className={classNames({ active: this.state.demoTab === 'composer' })}
              onClick={() => this.setState({ demoTab: 'composer' })}
            >
              עורך
            </button>
          </div>
        )}

        {this._renderMockWarning()}
        {this._renderGeminiUsage()}
        {!composerTab && this._renderScopeSelector()}
        {this._renderError()}

        {composerTab ? (
          <DemoComposer />
        ) : (
          <>
            <div
              className="ai-sidebar-body"
              data-ai-scrollport="true"
              ref={this._scrollRef}
              onScroll={this._onBodyScroll}
            >
              {this._renderOfflineArchivePicker()}
              {this._renderRealSelectionPreview()}
              {this._renderDemoPreview()}
              {this._renderConversation()}
              {this._renderProgress()}
            </div>
            {this._renderInput()}
          </>
        )}

        <div className="ai-sidebar-footer">
          {offline ? (
            <small>
              {tr(
                '⚠️ אב-טיפוס - קריאה בלבד, ללא שינויים לדואר',
                '⚠️ Prototype - read-only, no mail modifications'
              )}
            </small>
          ) : (
            <small>
              ⚠️ אב-טיפוס - קריאה בלבד, ללא שינויים לדואר
              <br />
              Read-only prototype - no mail modifications
            </small>
          )}
        </div>
      </div>
    );
  }
}

// Wrap with FluxContainer for store binding
export default function AISidebar() {
  return <AISidebarInner />;
}

// Export display name for registration
AISidebar.displayName = 'AISidebar';

// Container styles for this panel only. The MessageListSidebar column also
// hosts contact cards (maxWidth 300), so the measured column is often ~300pt
// regardless of this minWidth. Demo composer layout must work at that width.
AISidebar.containerStyles = {
  order: 99,
  minWidth: 360,
  maxWidth: 900,
};

// Mark as sidebar panel for the panel switcher
AISidebar.sidebarPanel = {
  id: 'ai-sidebar',
  title: tr('עוזר AI', 'AI assistant'),
};
