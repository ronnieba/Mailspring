/**
 * Mailspring-specific mail adapter.
 * Production stores are loaded lazily so Node tests can inject fakes and
 * exercise this class without Electron or ThreadListStore.
 */
import {
  MailAdapter,
  ScopeMode,
  ResolvedScope,
  RetrievalMode,
  SearchResult,
  MessageRef,
  FolderRef,
  SearchProgress,
} from './core/types';
import {
  isDemoMode as defaultIsDemoMode,
  getDemoScope,
  searchDemoMessages,
  getDemoSyncProgress,
  getDemoMessageBody,
} from './synthetic-demo';
import { resolveExactSelectedMessage } from './core/real-selected-mail';
import { isRealSelectedSummaryMode as defaultIsRealSelectedSummaryMode } from '../../../src/real-selected-summary';

export interface QueryLike<T> {
  where(condition: unknown): QueryLike<T>;
  order?(order: unknown): QueryLike<T>;
  limit?(n: number): QueryLike<T>;
  offset?(n: number): QueryLike<T>;
  search?(query: string): QueryLike<T>;
  include?(attr: unknown): QueryLike<T> | Promise<T | null>;
  then<TResult>(
    resolve: (value: T[] | T | null) => TResult,
    reject?: (err: unknown) => unknown
  ): Promise<TResult>;
}

export interface MailAdapterStores {
  isDemoMode: () => boolean;
  isRealSelectedSummaryMode?: () => boolean;
  focusedThreadMessages?: () => any[];
  messageExpansion?: () => Record<string, 'explicit' | 'default' | undefined>;
  accountIds: () => string[];
  currentPerspective: () => {
    accountIds?: string[];
    categories: () => Array<{
      id: string;
      accountId: string;
      displayName?: string;
      name?: string;
      role?: string;
    }>;
  };
  selectedThreads: () => Array<{ id: string; accountId: string; subject?: string }>;
  focusedThread: () => { id: string; accountId: string; subject?: string } | null;
  findAllMessages: () => QueryLike<any>;
  findAllThreads: () => QueryLike<any>;
  findMessage: (id: string) => QueryLike<any> | Promise<any>;
  findThread: (id: string) => QueryLike<any> | Promise<any>;
  getSyncState: () => {
    [accountId: string]: { [folderId: string]: { scanProgress: number; bodyProgress: number } };
  };
  setFocus: (args: { collection: string; item: unknown }) => void;
  Message: {
    attributes: {
      id: { in: (val: unknown) => unknown };
      threadId: { in: (val: unknown) => unknown; equal: (val: unknown) => unknown };
      accountId: { in: (val: unknown) => unknown };
      draft: { equal: (val: unknown) => unknown };
      date: { descending: () => unknown };
      body: unknown;
    };
  };
  Thread: {
    attributes: {
      accountId: { in: (val: unknown) => unknown };
      categories: { contains: (val: unknown) => unknown };
      lastMessageReceivedTimestamp: { descending: () => unknown };
    };
  };
}

function messageToRef(msg: any): MessageRef {
  return {
    id: msg.id,
    threadId: msg.threadId,
    accountId: msg.accountId,
    subject: msg.subject || '(No Subject)',
    from: msg.from?.[0]?.toString() || '(Unknown)',
    date: msg.date || new Date(),
    snippet: msg.snippet || '',
  };
}

function folderToRef(cat: any): FolderRef {
  return {
    id: cat.id,
    accountId: cat.accountId,
    name: cat.displayName || cat.name,
    role: cat.role || null,
  };
}

function loadProductionStores(): MailAdapterStores {
  const {
    DatabaseStore,
    FocusedContentStore,
    FocusedPerspectiveStore,
    FolderSyncProgressStore,
    AccountStore,
    Thread,
    Message,
    Actions,
  } = require('mailspring-exports');
  const ThreadListStore = require('../../thread-list/lib/thread-list-store').default;

  return {
    isDemoMode: defaultIsDemoMode,
    isRealSelectedSummaryMode: defaultIsRealSelectedSummaryMode,
    focusedThreadMessages: () => {
      const { MessageStore } = require('mailspring-exports');
      return MessageStore.items() || [];
    },
    messageExpansion: () => {
      const { MessageStore } = require('mailspring-exports');
      return MessageStore.itemsExpandedState() || {};
    },
    accountIds: () => AccountStore.accountIds(),
    currentPerspective: () => FocusedPerspectiveStore.current(),
    selectedThreads: () => {
      const dataSource = ThreadListStore.dataSource && ThreadListStore.dataSource();
      return (dataSource?.selection?.items() || []) as Array<{
        id: string;
        accountId: string;
        subject?: string;
      }>;
    },
    focusedThread: () => FocusedContentStore.focused('thread'),
    findAllMessages: () => DatabaseStore.findAll(Message),
    findAllThreads: () => DatabaseStore.findAll(Thread),
    findMessage: (id: string) => DatabaseStore.find(Message, id),
    findThread: (id: string) => DatabaseStore.find(Thread, id),
    getSyncState: () => FolderSyncProgressStore.getSyncState(),
    setFocus: (args) => Actions.setFocus(args),
    Message,
    Thread,
  };
}

export class MailspringAdapter implements MailAdapter {
  private _stores: MailAdapterStores | null;

  constructor(stores?: MailAdapterStores) {
    this._stores = stores || null;
  }

  private stores(): MailAdapterStores {
    if (!this._stores) {
      this._stores = loadProductionStores();
    }
    return this._stores;
  }

  private _resolveExactSelectedMessage(s: MailAdapterStores, accountIds: string[]): ResolvedScope {
    const selectedThreads = s.selectedThreads();
    const focusedThread = s.focusedThread();
    const threadIds =
      selectedThreads.length > 0
        ? selectedThreads.map((t) => t.id)
        : focusedThread
          ? [focusedThread.id]
          : [];
    const storeMessages = (s.focusedThreadMessages ? s.focusedThreadMessages() : []).filter(
      (m) => m && typeof m.id === 'string' && !m.draft
    );
    const inSelectedThread =
      threadIds.length === 1
        ? storeMessages.filter((m) => m.threadId === threadIds[0])
        : storeMessages;
    const expansion = s.messageExpansion ? s.messageExpansion() : {};
    const eligibility = resolveExactSelectedMessage({
      threadIds,
      messages: inSelectedThread,
      expansion,
    });
    if (!eligibility.ok || !eligibility.messageId || !eligibility.threadId) {
      return {
        mode: 'selected-messages',
        threadIds,
        messageIds: [],
        accountIds,
        description: `Cannot summarize: ${eligibility.reason || 'ineligible'}`,
        isEmpty: true,
      };
    }
    return {
      mode: 'selected-messages',
      threadIds: [eligibility.threadId],
      messageIds: [eligibility.messageId],
      accountIds,
      description: `הודעה אחת נבחרת (${eligibility.messageId})`,
      isEmpty: false,
    };
  }

  async resolveScope(mode: ScopeMode): Promise<ResolvedScope> {
    const s = this.stores();
    if (s.isDemoMode()) {
      return getDemoScope(mode);
    }

    const perspective = s.currentPerspective();
    const accountIds = perspective.accountIds || s.accountIds();
    const realSelected = s.isRealSelectedSummaryMode ? s.isRealSelectedSummaryMode() : false;

    if (realSelected && mode !== 'selected-messages') {
      return {
        mode,
        accountIds,
        description: 'Folder and all-mail are disabled for one-selected-message summary',
        isEmpty: true,
      };
    }

    switch (mode) {
      case 'selected-messages': {
        if (realSelected) {
          return this._resolveExactSelectedMessage(s, accountIds);
        }
        const selectedThreads = s.selectedThreads();
        const focusedThread = s.focusedThread();

        if (selectedThreads.length > 0) {
          const threadIds = selectedThreads.map((t) => t.id);
          const messages = (await s
            .findAllMessages()
            .where(s.Message.attributes.threadId.in(threadIds))
            .where(s.Message.attributes.draft.equal(false))) as any[];

          return {
            mode,
            threadIds,
            messageIds: messages.map((m) => m.id),
            accountIds: [...new Set(selectedThreads.map((t) => t.accountId))],
            description: `${selectedThreads.length} שרשורים נבחרים (${messages.length} הודעות)`,
            isEmpty: messages.length === 0,
          };
        } else if (focusedThread) {
          const messages = (await s
            .findAllMessages()
            .where(s.Message.attributes.threadId.equal(focusedThread.id))
            .where(s.Message.attributes.draft.equal(false))) as any[];

          return {
            mode,
            threadIds: [focusedThread.id],
            messageIds: messages.map((m) => m.id),
            accountIds: [focusedThread.accountId],
            description: `שרשור: "${focusedThread.subject}"`,
            isEmpty: messages.length === 0,
          };
        }
        return {
          mode,
          threadIds: [],
          messageIds: [],
          accountIds,
          description: 'לא נבחרו הודעות',
          isEmpty: true,
        };
      }

      case 'current-folder': {
        const categories = perspective.categories();
        if (!categories || categories.length === 0) {
          return {
            mode,
            accountIds,
            description: 'לא נבחרה תיקייה',
            isEmpty: true,
          };
        }
        const folder = folderToRef(categories[0]);
        return {
          mode,
          folder,
          accountIds: perspective.accountIds || [folder.accountId],
          description: `תיקייה: ${folder.name}`,
          isEmpty: false,
        };
      }

      case 'all-mail': {
        return {
          mode,
          accountIds,
          description: `כל הדואר (${accountIds.length} חשבונות)`,
          isEmpty: false,
        };
      }
    }
  }

  async searchMessages(
    scope: ResolvedScope,
    query: string,
    mode: RetrievalMode,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<SearchResult> {
    const s = this.stores();
    if (s.isDemoMode()) {
      if (signal?.aborted) {
        return {
          messages: [],
          progress: {
            totalEligible: 0,
            processed: 0,
            withBodies: 0,
            missingBodies: 0,
            syncCoverage: 100,
            isComplete: false,
            isCancelled: true,
          },
          retrievalMode: mode,
        };
      }
      return searchDemoMessages(scope, query, limit, offset, mode);
    }

    const progress: SearchProgress = {
      totalEligible: null,
      processed: 0,
      withBodies: 0,
      missingBodies: 0,
      syncCoverage: null,
      isComplete: false,
      isCancelled: false,
    };

    if (scope.isEmpty) {
      return {
        messages: [],
        progress: { ...progress, isComplete: true, totalEligible: 0 },
        retrievalMode: mode,
      };
    }

    const realSelected = s.isRealSelectedSummaryMode ? s.isRealSelectedSummaryMode() : false;
    if (realSelected) {
      if (
        scope.mode !== 'selected-messages' ||
        !scope.messageIds ||
        scope.messageIds.length !== 1
      ) {
        return {
          messages: [],
          progress: { ...progress, isComplete: true, totalEligible: 0 },
          retrievalMode: mode,
        };
      }
      const dbQuery = s
        .findAllMessages()
        .where(s.Message.attributes.id.in(scope.messageIds))
        .where(s.Message.attributes.draft.equal(false));
      const exact = (await dbQuery) as any[];
      const only = exact.filter((m) => m && m.id === scope.messageIds[0]);
      const refs = only.map(messageToRef);
      return {
        messages: refs,
        progress: {
          totalEligible: refs.length,
          processed: refs.length,
          withBodies: only.filter((m) => m.body !== null && m.body !== undefined).length,
          missingBodies: only.filter((m) => m.body === null || m.body === undefined).length,
          syncCoverage: null,
          isComplete: true,
          isCancelled: false,
        },
        retrievalMode: mode,
      };
    }

    let messages: any[] = [];

    if (scope.mode === 'selected-messages' && scope.messageIds?.length) {
      const dbQuery = s
        .findAllMessages()
        .where(s.Message.attributes.id.in(scope.messageIds))
        .where(s.Message.attributes.draft.equal(false));
      if (dbQuery.order) {
        dbQuery.order(s.Message.attributes.date.descending());
      }
      messages = (await dbQuery) as any[];
    } else if (scope.mode === 'current-folder' && scope.folder) {
      let threadQuery = s
        .findAllThreads()
        .where(s.Thread.attributes.accountId.in(scope.accountIds))
        .where(s.Thread.attributes.categories.contains(scope.folder.id));
      if (threadQuery.order) {
        threadQuery = threadQuery.order(
          s.Thread.attributes.lastMessageReceivedTimestamp.descending()
        );
      }
      if (threadQuery.limit) {
        threadQuery = threadQuery.limit(mode === 'ranked' ? limit : 1000);
      }
      const threads = (await threadQuery) as any[];

      if (threads.length > 0) {
        const threadIds = threads.map((t) => t.id);
        let msgQuery = s
          .findAllMessages()
          .where(s.Message.attributes.threadId.in(threadIds))
          .where(s.Message.attributes.draft.equal(false));
        if (msgQuery.order) {
          msgQuery = msgQuery.order(s.Message.attributes.date.descending());
        }
        if (query.trim() && msgQuery.search) {
          msgQuery = msgQuery.search(query);
        }
        messages = (await msgQuery) as any[];
      }
    } else {
      let dbQuery = s
        .findAllMessages()
        .where(s.Message.attributes.accountId.in(scope.accountIds))
        .where(s.Message.attributes.draft.equal(false));
      if (dbQuery.order) {
        dbQuery = dbQuery.order(s.Message.attributes.date.descending());
      }
      if (query.trim() && dbQuery.search) {
        dbQuery = dbQuery.search(query);
      }
      if (mode === 'ranked') {
        if (dbQuery.limit) dbQuery = dbQuery.limit(limit);
        if (dbQuery.offset) dbQuery = dbQuery.offset(offset);
      } else if (dbQuery.limit) {
        dbQuery = dbQuery.limit(1000);
      }
      messages = (await dbQuery) as any[];
    }

    if (signal?.aborted) {
      return {
        messages: [],
        progress: { ...progress, isCancelled: true },
        retrievalMode: mode,
      };
    }

    let withBodies = 0;
    let missingBodies = 0;
    for (const msg of messages) {
      if (msg.body !== null && msg.body !== undefined) {
        withBodies++;
      } else {
        missingBodies++;
      }
    }

    const messageRefs = messages.map(messageToRef);
    const resultMessages =
      mode === 'exhaustive' ? messageRefs.slice(offset, offset + limit) : messageRefs;

    return {
      messages: resultMessages,
      progress: {
        totalEligible: mode === 'exhaustive' ? messageRefs.length : null,
        processed: resultMessages.length,
        withBodies,
        missingBodies,
        syncCoverage: null,
        isComplete: mode === 'ranked' || offset + limit >= messageRefs.length,
        isCancelled: false,
      },
      retrievalMode: mode,
    };
  }

  async getMessageAttachmentCount(messageId: string): Promise<number> {
    const s = this.stores();
    if (s.isDemoMode()) {
      return 0;
    }
    const found = s.findMessage(messageId);
    const msg = (await found) as any;
    const files = msg?.files;
    return Array.isArray(files) ? files.length : 0;
  }

  async getMessageBody(messageId: string): Promise<string | null> {
    const s = this.stores();
    if (s.isDemoMode()) {
      return getDemoMessageBody(messageId);
    }
    const found = s.findMessage(messageId);
    const msg = (await (typeof (found as QueryLike<any>).include === 'function'
      ? (found as QueryLike<any>).include(s.Message.attributes.body)
      : found)) as any;
    return msg?.body || null;
  }

  async navigateToMessage(messageId: string, preserveReadState: boolean): Promise<boolean> {
    const s = this.stores();
    if (s.isDemoMode()) {
      console.log(`[AI Sidebar Demo] Would navigate to message: ${messageId}`);
      return false;
    }
    if (s.isRealSelectedSummaryMode && s.isRealSelectedSummaryMode()) {
      // Citation preview stays in the sidebar. setFocus on a thread can mark it read.
      return false;
    }

    const msg = (await s.findMessage(messageId)) as any;
    if (!msg) return false;

    const thread = (await s.findThread(msg.threadId)) as any;
    if (!thread) return false;

    s.setFocus({ collection: 'thread', item: thread });
    return !preserveReadState;
  }

  async getSyncProgress(accountIds: string[]): Promise<{ [accountId: string]: number }> {
    const s = this.stores();
    if (s.isDemoMode()) {
      return getDemoSyncProgress();
    }

    const result: { [accountId: string]: number } = {};
    const syncState = s.getSyncState();

    for (const accountId of accountIds) {
      const accountState = syncState[accountId];
      if (!accountState) {
        result[accountId] = 0;
        continue;
      }

      let totalProgress = 0;
      let folderCount = 0;
      for (const folderState of Object.values(accountState)) {
        totalProgress += folderState.scanProgress * 0.4 + folderState.bodyProgress * 0.6;
        folderCount++;
      }
      result[accountId] = folderCount > 0 ? (totalProgress / folderCount) * 100 : 0;
    }

    return result;
  }
}

export const mailspringAdapter = new MailspringAdapter();
