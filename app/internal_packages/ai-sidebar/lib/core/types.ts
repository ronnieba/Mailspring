/**
 * Core types for AI mail assistant - reusable across platforms.
 * No Mailspring-specific imports allowed in this file.
 */

/** Message identity usable for citations */
export interface MessageRef {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  date: Date;
  snippet: string;
  /** Demo fixture folder. Production mail omits this. */
  folderId?: string;
  /** Sanitized body of one selected real message. Demo synthetic path omits this. */
  bodyText?: string;
}

/** Thread identity */
export interface ThreadRef {
  id: string;
  accountId: string;
  subject: string;
  participantCount: number;
  messageCount: number;
  lastMessageDate: Date;
}

/** Folder/category identity */
export interface FolderRef {
  id: string;
  accountId: string;
  name: string;
  role: string | null;
}

/** User's explicit scope choice */
/** 'open-draft' (offline experiment): the local draft that is open right now. */
export type ScopeMode = 'selected-messages' | 'current-folder' | 'all-mail' | 'open-draft';

/** Resolved scope with actual IDs */
export interface ResolvedScope {
  mode: ScopeMode;
  /** Specific message IDs when mode is 'selected-messages' */
  messageIds?: string[];
  /** Specific thread IDs when mode is 'selected-messages' */
  threadIds?: string[];
  /** Folder info when mode is 'current-folder' */
  folder?: FolderRef;
  /** Account IDs in scope */
  accountIds: string[];
  /** Human-readable description */
  description: string;
  /** Whether scope is empty (nothing selected) */
  isEmpty: boolean;
  /** Offline experiment: number of local messages in scope (for estimates). */
  messageCount?: number;
}

/** Search/retrieval mode */
export type RetrievalMode = 'ranked' | 'exhaustive';

/** Progress state for long operations */
export interface SearchProgress {
  /** Total eligible in scope (null if unknown) */
  totalEligible: number | null;
  /** Messages processed so far */
  processed: number;
  /** Messages with bodies available */
  withBodies: number;
  /** Messages with missing bodies */
  missingBodies: number;
  /** Sync coverage percentage (0-100, null if unknown) */
  syncCoverage: number | null;
  /** Whether operation is complete */
  isComplete: boolean;
  /** Whether operation was cancelled */
  isCancelled: boolean;
  /** Error message if failed */
  error?: string;
}

/** Citation pointing to a source message */
export interface Citation {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: Date;
  /** Relevant snippet from the message */
  snippet: string;
}

/** A single message in the conversation */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Citations backing this message (assistant only) */
  citations?: Citation[];
  /** Timestamp */
  timestamp: Date;
  /** Whether this is from mock provider */
  isMock?: boolean;
  /** Gemini failure class (billing-exhausted, rate-limited, invalid-key...). */
  geminiErrorKind?: string;
  /** Open-draft scope: the answer can be applied to this draft. */
  draftAssist?: { draftId: string; kind: 'rewrite' | 'answer'; text: string };
}

/** Processing budget/limits */
export interface ProcessingBudget {
  maxMessages: number;
  maxTokens: number;
  timeoutMs: number;
}

/** Result of a search operation */
export interface SearchResult {
  messages: MessageRef[];
  progress: SearchProgress;
  retrievalMode: RetrievalMode;
}

/** AI provider interface - implemented by mock and real providers */
export interface AIProvider {
  readonly name: string;
  readonly isMock: boolean;
  readonly isConfigured: boolean;

  /** Process a query against the given messages */
  processQuery(
    query: string,
    messages: MessageRef[],
    scope: ResolvedScope,
    budget: ProcessingBudget,
    onProgress?: (progress: SearchProgress) => void,
    signal?: AbortSignal
  ): Promise<{
    response: string;
    citations: Citation[];
    tokensUsed: number;
  }>;
}

/** Mail adapter interface - implemented per platform (Mailspring, Android, etc.) */
export interface MailAdapter {
  /** Get current scope based on UI state */
  resolveScope(mode: ScopeMode): Promise<ResolvedScope>;

  /** Search messages within scope */
  searchMessages(
    scope: ResolvedScope,
    query: string,
    mode: RetrievalMode,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<SearchResult>;

  /** Get full message body by ID */
  getMessageBody(messageId: string): Promise<string | null>;

  /** Navigate to a message (returns true if navigation preserves read state) */
  navigateToMessage(messageId: string, preserveReadState: boolean): Promise<boolean>;

  /** Get sync progress for accounts in scope */
  getSyncProgress(accountIds: string[]): Promise<{ [accountId: string]: number }>;
}
