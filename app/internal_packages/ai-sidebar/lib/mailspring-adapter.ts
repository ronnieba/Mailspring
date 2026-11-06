/**
 * Mailspring-specific mail adapter implementation.
 * Connects core types to Mailspring's stores and APIs.
 */
import {
  DatabaseStore,
  FocusedContentStore,
  FocusedPerspectiveStore,
  FolderSyncProgressStore,
  AccountStore,
  Thread,
  Message,
  Actions,
} from 'mailspring-exports';
import ThreadListStore from '../../thread-list/lib/thread-list-store';
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

function messageToRef(msg: Message): MessageRef {
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

export class MailspringAdapter implements MailAdapter {
  /**
   * Resolves the current UI state into a concrete scope.
   * IMPORTANT: This uses actual multi-selection, not just focused thread.
   */
  async resolveScope(mode: ScopeMode): Promise<ResolvedScope> {
    const perspective = FocusedPerspectiveStore.current();
    const accountIds = perspective.accountIds || AccountStore.accountIds();

    switch (mode) {
      case 'selected-messages': {
        // Check for multi-selection first
        const dataSource = ThreadListStore.dataSource();
        const selection = dataSource?.selection;
        const selectedThreads = (selection?.items() || []) as Thread[];

        // Fall back to focused thread only if no multi-selection
        const focusedThread = FocusedContentStore.focused('thread') as Thread | null;

        if (selectedThreads.length > 0) {
          // Multi-selection: get messages from all selected threads
          const threadIds = selectedThreads.map((t) => t.id);
          const messages = await DatabaseStore.findAll<Message>(Message)
            .where(Message.attributes.threadId.in(threadIds))
            .where(Message.attributes.draft.equal(false));

          return {
            mode,
            threadIds,
            messageIds: messages.map((m) => m.id),
            accountIds: [...new Set(selectedThreads.map((t) => t.accountId))],
            description: `${selectedThreads.length} שרשורים נבחרים (${messages.length} הודעות)`,
            isEmpty: messages.length === 0,
          };
        } else if (focusedThread) {
          // Single focused thread
          const messages = await DatabaseStore.findAll<Message>(Message)
            .where(Message.attributes.threadId.equal(focusedThread.id))
            .where(Message.attributes.draft.equal(false));

          return {
            mode,
            threadIds: [focusedThread.id],
            messageIds: messages.map((m) => m.id),
            accountIds: [focusedThread.accountId],
            description: `שרשור: "${focusedThread.subject}"`,
            isEmpty: messages.length === 0,
          };
        } else {
          // Nothing selected
          return {
            mode,
            threadIds: [],
            messageIds: [],
            accountIds,
            description: 'לא נבחרו הודעות',
            isEmpty: true,
          };
        }
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

  /**
   * Search messages within the resolved scope.
   * Respects pagination and retrieval mode.
   */
  async searchMessages(
    scope: ResolvedScope,
    query: string,
    mode: RetrievalMode,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<SearchResult> {
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

    let messages: Message[] = [];

    if (scope.mode === 'selected-messages' && scope.messageIds?.length) {
      // Direct message ID query for selected messages
      const dbQuery = DatabaseStore.findAll<Message>(Message)
        .where(Message.attributes.id.in(scope.messageIds))
        .where(Message.attributes.draft.equal(false))
        .order(Message.attributes.date.descending());
      messages = await dbQuery;
    } else if (scope.mode === 'current-folder' && scope.folder) {
      // For folder scope, first get threads in the folder, then their messages
      const threadQuery = DatabaseStore.findAll<Thread>(Thread)
        .where(Thread.attributes.accountId.in(scope.accountIds))
        .where(Thread.attributes.categories.contains(scope.folder.id))
        .order(Thread.attributes.lastMessageReceivedTimestamp.descending())
        .limit(mode === 'ranked' ? limit : 1000);

      const threads = await threadQuery;

      if (threads.length > 0) {
        const threadIds = threads.map((t) => t.id);
        let msgQuery = DatabaseStore.findAll<Message>(Message)
          .where(Message.attributes.threadId.in(threadIds))
          .where(Message.attributes.draft.equal(false))
          .order(Message.attributes.date.descending());

        if (query.trim()) {
          msgQuery = msgQuery.search(query);
        }

        messages = await msgQuery;
      }
    } else {
      // All mail - direct query with search
      let dbQuery = DatabaseStore.findAll<Message>(Message)
        .where(Message.attributes.accountId.in(scope.accountIds))
        .where(Message.attributes.draft.equal(false))
        .order(Message.attributes.date.descending());

      if (query.trim()) {
        dbQuery = dbQuery.search(query);
      }

      if (mode === 'ranked') {
        dbQuery = dbQuery.limit(limit).offset(offset);
      } else {
        dbQuery = dbQuery.limit(1000); // Safety cap for exhaustive
      }

      messages = await dbQuery;
    }

    if (signal?.aborted) {
      return {
        messages: [],
        progress: { ...progress, isCancelled: true },
        retrievalMode: mode,
      };
    }

    // Count messages with/without bodies
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

    // For exhaustive mode, return subset but report full count
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

  /**
   * Get full message body by ID.
   */
  async getMessageBody(messageId: string): Promise<string | null> {
    const msg = await DatabaseStore.find<Message>(Message, messageId).include(
      Message.attributes.body
    );
    return msg?.body || null;
  }

  /**
   * Navigate to a message.
   * NOTE: Standard navigation marks messages as read. This is a known limitation.
   * For read-only preview, a future enhancement could show a popover instead.
   */
  async navigateToMessage(messageId: string, preserveReadState: boolean): Promise<boolean> {
    const msg = await DatabaseStore.find<Message>(Message, messageId);
    if (!msg) return false;

    const thread = await DatabaseStore.find<Thread>(Thread, msg.threadId);
    if (!thread) return false;

    // WARNING: This will mark the thread as read after markAsReadDelay.
    // We cannot prevent this without deeper changes to MessageStore.
    // For this prototype, we document this limitation.
    Actions.setFocus({ collection: 'thread', item: thread });

    // Return false to indicate read-state may change
    return !preserveReadState;
  }

  /**
   * Get sync progress for accounts.
   */
  async getSyncProgress(accountIds: string[]): Promise<{ [accountId: string]: number }> {
    const result: { [accountId: string]: number } = {};
    const syncState = FolderSyncProgressStore.getSyncState();

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
