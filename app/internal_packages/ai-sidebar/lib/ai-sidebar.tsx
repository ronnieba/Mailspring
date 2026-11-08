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
import { GEMINI_DISPLAY_NAME, GeminiDemoStatus } from '../../../src/browser/gemini-demo-protocol';
import DemoComposer from './demo-composer';
import classNames from 'classnames';

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
  demoTab: 'ai' | 'composer';
  geminiStatus: GeminiDemoStatus | null;
}

class AISidebarInner extends React.Component<Record<string, never>, AISidebarState> {
  static displayName = 'AISidebar';

  private _inputRef = React.createRef<HTMLTextAreaElement>();
  private _messagesEndRef = React.createRef<HTMLDivElement>();
  private _unsubscribe: (() => void) | null = null;

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
    demoTab: 'ai',
    geminiStatus: AISidebarStore.getState().geminiStatus,
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
        geminiStatus: storeState.geminiStatus,
      });
    });

    // Initial scope resolution
    AISidebarStore.refreshScope();

    if (isDemoMode()) {
      (window as any).__mailspringDemoSidebar = {
        setScopeMode: (mode: ScopeMode) => AISidebarStore.setScopeMode(mode),
        submitQuery: (query: string) => AISidebarStore.submitQuery(query),
        getState: () => AISidebarStore.getState(),
      };
    }
  }

  componentDidUpdate(_prevProps: Record<string, never>, prevState: AISidebarState) {
    // Auto-scroll to bottom on new messages
    if (this.state.conversation.length !== prevState.conversation.length) {
      this._scrollToBottom();
    }
  }

  componentWillUnmount() {
    if (this._unsubscribe) {
      this._unsubscribe();
    }
    if ((window as any).__mailspringDemoSidebar) {
      delete (window as any).__mailspringDemoSidebar;
    }
  }

  _scrollToBottom = () => {
    this._messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

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
    const query = this.state.inputValue.trim();
    if (!query || this.state.isProcessing) return;

    this.setState({ inputValue: '' });
    AISidebarStore.submitQuery(query);
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

  _renderMockWarning() {
    const inDemoMode = isDemoMode();
    const geminiConfigured = !!this.state.geminiStatus?.configured;
    const geminiStatus = geminiConfigured ? 'configured' : 'unconfigured';

    return (
      <div className="ai-sidebar-mock-warning" data-gemini-status={geminiStatus}>
        <span className="icon">⚠️</span>
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
    const { scopeMode, resolvedScope } = this.state;

    return (
      <div className="ai-sidebar-scope">
        <span className="scope-label" id="scope-label">
          טווח חיפוש:
        </span>
        <div className="scope-buttons" role="group" aria-labelledby="scope-label">
          <button
            className={classNames('scope-btn', { active: scopeMode === 'selected-messages' })}
            onClick={() => this._onScopeModeChange('selected-messages')}
            title="הודעות נבחרות"
            aria-label="הודעות נבחרות"
            data-scope-mode="selected-messages"
          >
            📧 נבחרות
          </button>
          <button
            className={classNames('scope-btn', { active: scopeMode === 'current-folder' })}
            onClick={() => this._onScopeModeChange('current-folder')}
            title="תיקייה נוכחית (תיבת דואר נכנס בדמו)"
            aria-label="תיקייה"
            data-scope-mode="current-folder"
          >
            📁 תיקייה
          </button>
          <button
            className={classNames('scope-btn', { active: scopeMode === 'all-mail' })}
            onClick={() => this._onScopeModeChange('all-mail')}
            title="כל הדואר"
            aria-label="כל הדואר"
            data-scope-mode="all-mail"
          >
            📬 הכל
          </button>
        </div>

        {resolvedScope && (
          <div className={classNames('scope-status', { empty: resolvedScope.isEmpty })}>
            {resolvedScope.isEmpty ? (
              <span className="empty-scope">
                {scopeMode === 'selected-messages'
                  ? '❌ לא נבחרו הודעות - בחר הודעות מהרשימה'
                  : '❌ אין הודעות בטווח'}
              </span>
            ) : (
              <span className="scope-description">{resolvedScope.description}</span>
            )}
          </div>
        )}

        <div className="retrieval-mode" data-retrieval-mode={this.state.retrievalMode}>
          <label>
            <input
              type="radio"
              name="retrieval"
              checked={this.state.retrievalMode === 'ranked'}
              onChange={() => this._onRetrievalModeChange('ranked')}
              aria-label="דירוג (מהיר)"
            />
            <span>דירוג (מהיר)</span>
          </label>
          <label>
            <input
              type="radio"
              name="retrieval"
              checked={this.state.retrievalMode === 'exhaustive'}
              onChange={() => this._onRetrievalModeChange('exhaustive')}
              aria-label="סריקה מלאה"
            />
            <span>סריקה מלאה</span>
          </label>
        </div>
      </div>
    );
  }

  _renderConversation() {
    const { conversation } = this.state;

    if (conversation.length === 0) {
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
          'message-error': isError,
          'message-mock': msg.isMock,
        })}
      >
        <div className="message-content">{this._renderMessageContent(msg.content)}</div>

        {msg.citations && msg.citations.length > 0 && (
          <div className="message-citations">
            <div className="citations-header">📎 מקורות:</div>
            {msg.citations.map((citation, i) => (
              <button
                key={`${citation.messageId}-${i}`}
                className="citation-btn"
                onClick={() => this._onCitationClick(citation)}
                title={`DEMO ${citation.messageId}\nמ: ${citation.from}\n${citation.snippet}`}
                aria-label={`מקור DEMO ${citation.messageId}: ${citation.subject}`}
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

        {msg.isMock && <div className="mock-indicator">🔧 Mock Response</div>}
        {msg.role === 'assistant' && msg.isMock === false && (
          <div className="live-indicator">
            Gemini Developer API · DEMO synthetic · paid project required
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

    return <div className="message-text" dangerouslySetInnerHTML={{ __html: formatted }} />;
  }

  _renderProgress() {
    const { progress, isProcessing } = this.state;
    if (!isProcessing) return null;

    return (
      <div className="ai-sidebar-progress">
        <Spinner visible />
        <span className="progress-text">
          {progress
            ? `מעבד ${progress.processed || 0}${
                progress.totalEligible ? ` מתוך ${progress.totalEligible}` : ''
              } הודעות...`
            : 'מעבד...'}
        </span>
        <button className="cancel-btn" onClick={this._onCancel} aria-label="ביטול">
          ביטול
        </button>
      </div>
    );
  }

  _renderDemoPreview() {
    const preview = this.state.demoPreview;
    if (!preview) return null;

    return (
      <div
        className="ai-sidebar-demo-preview"
        role="region"
        aria-label="DEMO source preview"
        data-demo-preview={preview.messageId}
      >
        <div className="demo-preview-banner">🧪 DEMO מקור סינתטי — לא תיבת דואר אמיתית</div>
        <dl className="demo-preview-meta">
          <dt>מזהה</dt>
          <dd>{preview.messageId}</dd>
          <dt>נושא</dt>
          <dd>{preview.subject}</dd>
          <dt>מאת</dt>
          <dd>{preview.from}</dd>
          <dt>תיקייה</dt>
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
          סגור תצוגת מקור
        </button>
      </div>
    );
  }

  _renderInput() {
    const { isProcessing, resolvedScope } = this.state;
    const isDisabled = isProcessing || (resolvedScope && resolvedScope.isEmpty);

    return (
      <div className="ai-sidebar-input">
        <textarea
          ref={this._inputRef}
          className="input-textarea"
          placeholder={
            resolvedScope?.isEmpty ? 'בחר הודעות או תיקייה תחילה...' : 'שאל שאלה... (Enter לשליחה)'
          }
          value={this.state.inputValue}
          onChange={this._onInputChange}
          onKeyDown={this._onInputKeyDown}
          disabled={isDisabled}
          dir="auto"
        />
        <div className="input-actions">
          <button
            className="submit-btn"
            onClick={this._onSubmit}
            disabled={isDisabled || !this.state.inputValue.trim()}
            aria-label="שלח"
          >
            שלח
          </button>
          {this.state.conversation.length > 0 && (
            <button className="clear-btn" onClick={this._onClear} aria-label="נקה">
              נקה
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
    const composerTab = demo && this.state.demoTab === 'composer';
    return (
      <div className="ai-sidebar" dir="rtl" data-demo-ready={demo ? 'true' : undefined}>
        <div className="ai-sidebar-header">
          <h2>🤖 עוזר AI</h2>
          <span className="provider-badge">{this.state.providerName}</span>
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
        {!composerTab && this._renderScopeSelector()}
        {this._renderError()}

        {composerTab ? (
          <DemoComposer />
        ) : (
          <>
            <div className="ai-sidebar-body" data-ai-scrollport="true">
              {this._renderDemoPreview()}
              {this._renderConversation()}
              {this._renderProgress()}
            </div>
            {this._renderInput()}
          </>
        )}

        <div className="ai-sidebar-footer">
          <small>
            ⚠️ אב-טיפוס - קריאה בלבד, ללא שינויים לדואר
            <br />
            Read-only prototype - no mail modifications
          </small>
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
  maxWidth: 560,
};

// Mark as sidebar panel for the panel switcher
AISidebar.sidebarPanel = {
  id: 'ai-sidebar',
  title: 'עוזר AI',
};
