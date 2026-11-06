/**
 * AI Sidebar component - conversational interface with explicit scope selector.
 * Hebrew RTL layout with mixed content support.
 */
import React from 'react';
import { localized, Rx } from 'mailspring-exports';
import { FluxContainer, Spinner } from 'mailspring-component-kit';
import AISidebarStore from './ai-sidebar-store';
import { ScopeMode, RetrievalMode, ConversationMessage, Citation } from './core/types';
import { isDemoMode } from './synthetic-demo';
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
}

class AISidebarInner extends React.Component<Record<string, never>, AISidebarState> {
  static displayName = 'AISidebar';

  private _inputRef = React.createRef<HTMLTextAreaElement>();
  private _messagesEndRef = React.createRef<HTMLDivElement>();
  private _unsubscribe: (() => void) | null = null;

  state: AISidebarState = {
    scopeMode: 'selected-messages',
    resolvedScope: null,
    retrievalMode: 'ranked',
    conversation: [],
    isProcessing: false,
    progress: null,
    error: null,
    inputValue: '',
    providerName: AISidebarStore.getProvider().name,
    isMockProvider: AISidebarStore.getProvider().isMock,
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
        providerName: provider.name,
        isMockProvider: provider.isMock,
      });
    });

    // Initial scope resolution
    AISidebarStore.refreshScope();
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

    return (
      <div className="ai-sidebar-mock-warning">
        <span className="icon">⚠️</span>
        <span className="text">
          {inDemoMode ? (
            <>
              🧪 מצב DEMO - נתונים סינתטיים
              <br />
              <small>Synthetic data - no real account</small>
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
          >
            📧 נבחרות
          </button>
          <button
            className={classNames('scope-btn', { active: scopeMode === 'current-folder' })}
            onClick={() => this._onScopeModeChange('current-folder')}
            title="תיקייה נוכחית"
          >
            📁 תיקייה
          </button>
          <button
            className={classNames('scope-btn', { active: scopeMode === 'all-mail' })}
            onClick={() => this._onScopeModeChange('all-mail')}
            title="כל הדואר"
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

        <div className="retrieval-mode">
          <label>
            <input
              type="radio"
              name="retrieval"
              checked={this.state.retrievalMode === 'ranked'}
              onChange={() => this._onRetrievalModeChange('ranked')}
            />
            <span>דירוג (מהיר)</span>
          </label>
          <label>
            <input
              type="radio"
              name="retrieval"
              checked={this.state.retrievalMode === 'exhaustive'}
              onChange={() => this._onRetrievalModeChange('exhaustive')}
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
                title={`מ: ${citation.from}\n${citation.snippet}`}
              >
                <span className="citation-index">[{i + 1}]</span>
                <span className="citation-subject">{citation.subject}</span>
              </button>
            ))}
          </div>
        )}

        {msg.isMock && <div className="mock-indicator">🔧 Mock Response</div>}
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
    if (!isProcessing || !progress) return null;

    return (
      <div className="ai-sidebar-progress">
        <Spinner visible />
        <span className="progress-text">
          מעבד {progress.processed || 0}
          {progress.totalEligible ? ` מתוך ${progress.totalEligible}` : ''} הודעות...
        </span>
        <button className="cancel-btn" onClick={this._onCancel}>
          ביטול
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
          >
            שלח
          </button>
          {this.state.conversation.length > 0 && (
            <button className="clear-btn" onClick={this._onClear}>
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
    return (
      <div className="ai-sidebar" dir="rtl">
        <div className="ai-sidebar-header">
          <h2>🤖 עוזר AI</h2>
          <span className="provider-badge">{this.state.providerName}</span>
        </div>

        {this._renderMockWarning()}
        {this._renderScopeSelector()}
        {this._renderError()}

        <div className="ai-sidebar-body">
          {this._renderConversation()}
          {this._renderProgress()}
        </div>

        {this._renderInput()}

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

// Container styles for sidebar panel
AISidebar.containerStyles = {
  order: 99,
  minWidth: 280,
  maxWidth: 400,
};

// Mark as sidebar panel for the panel switcher
AISidebar.sidebarPanel = {
  id: 'ai-sidebar',
  title: 'עוזר AI',
};
