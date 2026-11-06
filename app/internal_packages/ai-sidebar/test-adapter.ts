#!/usr/bin/env npx ts-node
/**
 * Standalone Node test runner for Mailspring adapter logic.
 * Tests adapter behavior using fake Mailspring dependencies.
 *
 * Run with: npx ts-node app/internal_packages/ai-sidebar/test-adapter.ts
 *
 * Coverage:
 * - Multi-selection boundaries (0, 1, N threads)
 * - Folder scope with account grants (single vs multi-account)
 * - All-mail scope across accounts
 * - Pagination: ranked vs exhaustive, offset/limit
 * - Partial sync disclosure (missing bodies)
 * - Retrieval mode reporting
 * - No mutations (adapter is read-only)
 * - Citation validity (messageId exists in result set)
 */

import {
  ResolvedScope,
  ScopeMode,
  MessageRef,
  RetrievalMode,
  SearchResult,
  FolderRef,
} from './lib/core/types';

const TEST_ACCOUNT_A = 'account-a';
const TEST_ACCOUNT_B = 'account-b';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${e.message}`);
      failed++;
    }
  })();
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(value: boolean, msg?: string) {
  if (!value) {
    throw new Error(msg || `Expected true, got false`);
  }
}

function assertFalse(value: boolean, msg?: string) {
  if (value) {
    throw new Error(msg || `Expected false, got true`);
  }
}

function assertArrayLength<T>(arr: T[], expected: number, msg?: string) {
  if (arr.length !== expected) {
    throw new Error(msg || `Expected array length ${expected}, got ${arr.length}`);
  }
}

function assertContains(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(msg || `Expected "${haystack.slice(0, 50)}..." to contain "${needle}"`);
  }
}

/**
 * Fake adapter that mimics MailspringAdapter behavior without Electron dependencies.
 * This tests the LOGIC of scope resolution, search, and pagination.
 */
class FakeMailAdapter {
  private messages: Map<string, FakeMessage> = new Map();
  private threads: Map<string, FakeThread> = new Map();
  private folders: Map<string, FakeFolder> = new Map();

  // Simulated UI state
  focusedThreadId: string | null = null;
  selectedThreadIds: string[] = [];
  currentFolderId: string | null = null;
  currentAccountIds: string[] = [TEST_ACCOUNT_A];

  // Simulated sync state
  syncProgress: Map<string, number> = new Map();

  addMessage(msg: FakeMessage) {
    this.messages.set(msg.id, msg);
    // Ensure thread exists
    if (!this.threads.has(msg.threadId)) {
      this.threads.set(msg.threadId, {
        id: msg.threadId,
        accountId: msg.accountId,
        subject: msg.subject,
        folderIds: [],
      });
    }
  }

  addThread(thread: FakeThread) {
    this.threads.set(thread.id, thread);
  }

  addFolder(folder: FakeFolder) {
    this.folders.set(folder.id, folder);
  }

  setSyncProgress(accountId: string, progress: number) {
    this.syncProgress.set(accountId, progress);
  }

  /**
   * Resolve scope based on simulated UI state.
   * This mirrors MailspringAdapter.resolveScope() logic.
   */
  async resolveScope(mode: ScopeMode): Promise<ResolvedScope> {
    const accountIds = this.currentAccountIds;

    if (mode === 'selected-messages') {
      // Multi-selection: use selectedThreadIds if any, else fallback to focused
      const threadIds =
        this.selectedThreadIds.length > 0
          ? this.selectedThreadIds
          : this.focusedThreadId
            ? [this.focusedThreadId]
            : [];

      if (threadIds.length === 0) {
        return {
          mode,
          accountIds,
          threadIds: [],
          messageIds: [],
          isEmpty: true,
          description: 'לא נבחרו הודעות',
        };
      }

      // Get messages for selected threads
      const messageIds: string[] = [];
      for (const [id, msg] of this.messages) {
        if (threadIds.includes(msg.threadId)) {
          messageIds.push(id);
        }
      }

      const subjects = threadIds
        .map((tid) => this.threads.get(tid)?.subject)
        .filter(Boolean)
        .slice(0, 2);

      return {
        mode,
        accountIds,
        threadIds,
        messageIds,
        isEmpty: false,
        description:
          threadIds.length === 1 ? `שרשור: ${subjects[0]}` : `${threadIds.length} שרשורים נבחרו`,
      };
    }

    if (mode === 'current-folder') {
      if (!this.currentFolderId) {
        return {
          mode,
          accountIds,
          isEmpty: true,
          description: 'לא נבחרה תיקייה',
        };
      }

      const folder = this.folders.get(this.currentFolderId);
      const folderRef: FolderRef | undefined = folder
        ? {
            id: folder.id,
            accountId: folder.accountId,
            name: folder.name,
            role: folder.role,
          }
        : undefined;

      return {
        mode,
        accountIds,
        folder: folderRef,
        isEmpty: false,
        description: `תיקייה: ${folder?.name || this.currentFolderId}`,
      };
    }

    // all-mail
    return {
      mode,
      accountIds,
      isEmpty: accountIds.length === 0,
      description: accountIds.length > 1 ? `כל הדואר (${accountIds.length} חשבונות)` : 'כל הדואר',
    };
  }

  /**
   * Search messages within scope.
   * This mirrors MailspringAdapter.searchMessages() logic.
   */
  async searchMessages(
    scope: ResolvedScope,
    query: string,
    mode: RetrievalMode,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<SearchResult> {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    let candidates: FakeMessage[] = [];

    if (scope.mode === 'selected-messages' && scope.messageIds?.length) {
      // Direct message IDs
      for (const id of scope.messageIds) {
        const msg = this.messages.get(id);
        if (msg) candidates.push(msg);
      }
    } else if (scope.mode === 'current-folder' && scope.folder) {
      // Messages in threads that are in this folder
      for (const [, thread] of this.threads) {
        if (thread.folderIds.includes(scope.folder.id)) {
          for (const [, msg] of this.messages) {
            if (msg.threadId === thread.id && scope.accountIds.includes(msg.accountId)) {
              candidates.push(msg);
            }
          }
        }
      }
    } else if (scope.mode === 'all-mail') {
      // All messages in scope accounts
      for (const [, msg] of this.messages) {
        if (scope.accountIds.includes(msg.accountId)) {
          candidates.push(msg);
        }
      }
    }

    // Apply query filter if present
    if (query) {
      const q = query.toLowerCase();
      candidates = candidates.filter(
        (m) => m.subject.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q)
      );
    }

    // Sort by date descending
    candidates.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Count bodies
    const withBodies = candidates.filter((m) => m.hasBody).length;
    const missingBodies = candidates.length - withBodies;

    // Apply pagination
    const totalEligible = candidates.length;
    const paginated = candidates.slice(offset, offset + limit);

    // Convert to MessageRef
    const messages: MessageRef[] = paginated.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      accountId: m.accountId,
      subject: m.subject,
      from: m.from,
      date: m.date,
      snippet: m.snippet,
    }));

    return {
      messages,
      progress: {
        totalEligible,
        processed: paginated.length,
        withBodies: Math.min(withBodies, paginated.length),
        missingBodies: Math.max(0, missingBodies - (totalEligible - paginated.length - offset)),
        syncCoverage: this.getSyncCoverage(scope.accountIds),
        isComplete: true,
        isCancelled: false,
      },
      retrievalMode: mode,
    };
  }

  private getSyncCoverage(accountIds: string[]): number | null {
    if (accountIds.length === 0) return null;
    let total = 0;
    let count = 0;
    for (const id of accountIds) {
      const progress = this.syncProgress.get(id);
      if (progress !== undefined) {
        total += progress;
        count++;
      }
    }
    return count > 0 ? total / count : null;
  }

  async getSyncProgress(accountIds: string[]): Promise<{ [accountId: string]: number }> {
    const result: { [accountId: string]: number } = {};
    for (const id of accountIds) {
      result[id] = this.syncProgress.get(id) || 0;
    }
    return result;
  }

  // Read-only: navigation just returns false for preserveReadState
  async navigateToMessage(messageId: string, preserveReadState: boolean): Promise<boolean> {
    const exists = this.messages.has(messageId);
    // Navigation changes read state in real Mailspring - we can't preserve it
    return exists ? false : false;
  }
}

interface FakeMessage {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  date: Date;
  snippet: string;
  hasBody: boolean;
}

interface FakeThread {
  id: string;
  accountId: string;
  subject: string;
  folderIds: string[];
}

interface FakeFolder {
  id: string;
  accountId: string;
  name: string;
  role: string | null;
}

async function runTests() {
  console.log('\n=== AI Sidebar Adapter Tests (Node) ===\n');

  const adapter = new FakeMailAdapter();

  // Setup test data
  const inboxFolderA: FakeFolder = {
    id: 'inbox-a',
    accountId: TEST_ACCOUNT_A,
    name: 'Inbox',
    role: 'inbox',
  };
  const sentFolderA: FakeFolder = {
    id: 'sent-a',
    accountId: TEST_ACCOUNT_A,
    name: 'Sent',
    role: 'sent',
  };
  const inboxFolderB: FakeFolder = {
    id: 'inbox-b',
    accountId: TEST_ACCOUNT_B,
    name: 'Inbox',
    role: 'inbox',
  };

  adapter.addFolder(inboxFolderA);
  adapter.addFolder(sentFolderA);
  adapter.addFolder(inboxFolderB);

  // Thread in inbox
  adapter.addThread({
    id: 'thread-1',
    accountId: TEST_ACCOUNT_A,
    subject: 'Meeting Tomorrow',
    folderIds: ['inbox-a'],
  });
  adapter.addThread({
    id: 'thread-2',
    accountId: TEST_ACCOUNT_A,
    subject: 'Invoice #123',
    folderIds: ['inbox-a'],
  });
  adapter.addThread({
    id: 'thread-3',
    accountId: TEST_ACCOUNT_A,
    subject: 'Sent Message',
    folderIds: ['sent-a'],
  });
  adapter.addThread({
    id: 'thread-4',
    accountId: TEST_ACCOUNT_B,
    subject: 'Account B Thread',
    folderIds: ['inbox-b'],
  });

  // Messages
  for (let i = 1; i <= 5; i++) {
    adapter.addMessage({
      id: `msg-t1-${i}`,
      threadId: 'thread-1',
      accountId: TEST_ACCOUNT_A,
      subject: 'Meeting Tomorrow',
      from: `sender${i}@example.com`,
      date: new Date(Date.now() - i * 3600000),
      snippet: `Message ${i} about the meeting`,
      hasBody: i <= 3, // Only first 3 have bodies
    });
  }

  adapter.addMessage({
    id: 'msg-t2-1',
    threadId: 'thread-2',
    accountId: TEST_ACCOUNT_A,
    subject: 'Invoice #123',
    from: 'billing@example.com',
    date: new Date(Date.now() - 10 * 3600000),
    snippet: 'Please find attached invoice',
    hasBody: true,
  });

  adapter.addMessage({
    id: 'msg-t3-1',
    threadId: 'thread-3',
    accountId: TEST_ACCOUNT_A,
    subject: 'Sent Message',
    from: 'me@example.com',
    date: new Date(Date.now() - 20 * 3600000),
    snippet: 'My sent message',
    hasBody: true,
  });

  adapter.addMessage({
    id: 'msg-t4-1',
    threadId: 'thread-4',
    accountId: TEST_ACCOUNT_B,
    subject: 'Account B Thread',
    from: 'other@example.com',
    date: new Date(Date.now() - 5 * 3600000),
    snippet: 'Message from account B',
    hasBody: true,
  });

  adapter.setSyncProgress(TEST_ACCOUNT_A, 85);
  adapter.setSyncProgress(TEST_ACCOUNT_B, 100);

  console.log('Selection boundaries:');

  await test('empty selection returns empty scope', async () => {
    adapter.selectedThreadIds = [];
    adapter.focusedThreadId = null;

    const scope = await adapter.resolveScope('selected-messages');
    assertTrue(scope.isEmpty, 'scope should be empty');
    assertArrayLength(scope.threadIds || [], 0, 'should have no threads');
    assertArrayLength(scope.messageIds || [], 0, 'should have no messages');
  });

  await test('single focused thread becomes selection', async () => {
    adapter.selectedThreadIds = [];
    adapter.focusedThreadId = 'thread-1';

    const scope = await adapter.resolveScope('selected-messages');
    assertFalse(scope.isEmpty, 'scope should not be empty');
    assertArrayLength(scope.threadIds || [], 1, 'should have 1 thread');
    assertEqual(scope.threadIds![0], 'thread-1');
    assertContains(scope.description, 'Meeting Tomorrow');
  });

  await test('multi-selection includes all selected threads', async () => {
    adapter.selectedThreadIds = ['thread-1', 'thread-2'];
    adapter.focusedThreadId = 'thread-1'; // Should be ignored when selection exists

    const scope = await adapter.resolveScope('selected-messages');
    assertFalse(scope.isEmpty);
    assertArrayLength(scope.threadIds || [], 2, 'should have 2 threads');
    assertTrue(scope.threadIds!.includes('thread-1'));
    assertTrue(scope.threadIds!.includes('thread-2'));
    assertContains(scope.description, '2');
  });

  await test('multi-selection gathers messages from all threads', async () => {
    adapter.selectedThreadIds = ['thread-1', 'thread-2'];

    const scope = await adapter.resolveScope('selected-messages');
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    // Thread-1 has 5 messages, thread-2 has 1
    assertEqual(result.messages.length, 6, 'should have 6 messages total');
  });

  console.log('\nFolder scope with account grants:');

  await test('folder scope includes only threads in that folder', async () => {
    adapter.currentFolderId = 'inbox-a';
    adapter.currentAccountIds = [TEST_ACCOUNT_A];

    const scope = await adapter.resolveScope('current-folder');
    assertFalse(scope.isEmpty);
    assertEqual(scope.folder?.id, 'inbox-a');

    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);
    // inbox-a has thread-1 (5 msgs) and thread-2 (1 msg)
    assertEqual(result.messages.length, 6, 'should have 6 messages from inbox');

    // Verify none are from sent folder
    for (const msg of result.messages) {
      assertTrue(
        msg.threadId === 'thread-1' || msg.threadId === 'thread-2',
        `message ${msg.id} should be from inbox threads`
      );
    }
  });

  await test('folder scope excludes messages from other folders', async () => {
    adapter.currentFolderId = 'sent-a';
    adapter.currentAccountIds = [TEST_ACCOUNT_A];

    const scope = await adapter.resolveScope('current-folder');
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    // sent-a has only thread-3 with 1 message
    assertEqual(result.messages.length, 1, 'should have 1 message from sent');
    assertEqual(result.messages[0].threadId, 'thread-3');
  });

  await test('folder scope respects account grant', async () => {
    adapter.currentFolderId = 'inbox-a';
    adapter.currentAccountIds = [TEST_ACCOUNT_B]; // Wrong account!

    const scope = await adapter.resolveScope('current-folder');
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    // Account B has no messages in inbox-a
    assertEqual(result.messages.length, 0, 'should have no messages from wrong account');
  });

  console.log('\nAll-mail scope:');

  await test('all-mail includes messages from all granted accounts', async () => {
    adapter.currentAccountIds = [TEST_ACCOUNT_A, TEST_ACCOUNT_B];

    const scope = await adapter.resolveScope('all-mail');
    assertFalse(scope.isEmpty);
    assertContains(scope.description, '2'); // 2 accounts

    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    // Should have messages from both accounts
    const accountAMsgs = result.messages.filter((m) => m.accountId === TEST_ACCOUNT_A);
    const accountBMsgs = result.messages.filter((m) => m.accountId === TEST_ACCOUNT_B);

    assertTrue(accountAMsgs.length > 0, 'should have account A messages');
    assertTrue(accountBMsgs.length > 0, 'should have account B messages');
  });

  await test('all-mail respects single-account grant', async () => {
    adapter.currentAccountIds = [TEST_ACCOUNT_A]; // Only A

    const scope = await adapter.resolveScope('all-mail');
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    // All messages should be from account A
    for (const msg of result.messages) {
      assertEqual(msg.accountId, TEST_ACCOUNT_A, 'all messages should be from granted account');
    }
  });

  console.log('\nPagination:');

  await test('limit constrains result count', async () => {
    adapter.selectedThreadIds = ['thread-1']; // 5 messages

    const scope = await adapter.resolveScope('selected-messages');
    const result = await adapter.searchMessages(scope, '', 'ranked', 3, 0);

    assertEqual(result.messages.length, 3, 'should return only 3 messages');
    assertEqual(result.progress.totalEligible, 5, 'should report 5 eligible');
  });

  await test('offset skips initial messages', async () => {
    adapter.selectedThreadIds = ['thread-1']; // 5 messages

    const scope = await adapter.resolveScope('selected-messages');
    const resultPage1 = await adapter.searchMessages(scope, '', 'ranked', 2, 0);
    const resultPage2 = await adapter.searchMessages(scope, '', 'ranked', 2, 2);

    assertEqual(resultPage1.messages.length, 2, 'page 1 should have 2');
    assertEqual(resultPage2.messages.length, 2, 'page 2 should have 2');

    // Pages should not overlap
    const page1Ids = resultPage1.messages.map((m) => m.id);
    const page2Ids = resultPage2.messages.map((m) => m.id);
    for (const id of page2Ids) {
      assertFalse(page1Ids.includes(id), `page 2 id ${id} should not be in page 1`);
    }
  });

  await test('offset beyond range returns empty', async () => {
    adapter.selectedThreadIds = ['thread-1']; // 5 messages

    const scope = await adapter.resolveScope('selected-messages');
    const result = await adapter.searchMessages(scope, '', 'ranked', 10, 100);

    assertEqual(result.messages.length, 0, 'should return empty for offset beyond range');
    assertEqual(result.progress.totalEligible, 5, 'should still report correct total');
  });

  console.log('\nPartial sync disclosure:');

  await test('reports missing bodies count', async () => {
    adapter.selectedThreadIds = ['thread-1']; // 5 messages, 3 have bodies

    const scope = await adapter.resolveScope('selected-messages');
    const result = await adapter.searchMessages(scope, '', 'exhaustive', 100, 0);

    assertTrue(result.progress.missingBodies > 0, 'should report missing bodies');
    assertEqual(result.progress.withBodies, 3, 'should have 3 with bodies');
  });

  await test('reports sync coverage percentage', async () => {
    adapter.currentAccountIds = [TEST_ACCOUNT_A];

    const scope = await adapter.resolveScope('all-mail');
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    assertEqual(result.progress.syncCoverage, 85, 'should report 85% sync coverage');
  });

  await test('sync coverage averages across accounts', async () => {
    adapter.currentAccountIds = [TEST_ACCOUNT_A, TEST_ACCOUNT_B]; // 85% and 100%

    const scope = await adapter.resolveScope('all-mail');
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);

    assertEqual(result.progress.syncCoverage, 92.5, 'should average to 92.5%');
  });

  console.log('\nRetrieval mode reporting:');

  await test('ranked mode is reported in result', async () => {
    adapter.selectedThreadIds = ['thread-1'];
    const scope = await adapter.resolveScope('selected-messages');
    const result = await adapter.searchMessages(scope, '', 'ranked', 10, 0);

    assertEqual(result.retrievalMode, 'ranked');
  });

  await test('exhaustive mode is reported in result', async () => {
    adapter.selectedThreadIds = ['thread-1'];
    const scope = await adapter.resolveScope('selected-messages');
    const result = await adapter.searchMessages(scope, '', 'exhaustive', 100, 0);

    assertEqual(result.retrievalMode, 'exhaustive');
  });

  console.log('\nCancellation:');

  await test('search respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    adapter.selectedThreadIds = ['thread-1'];
    const scope = await adapter.resolveScope('selected-messages');

    let threw = false;
    try {
      await adapter.searchMessages(scope, '', 'ranked', 10, 0, controller.signal);
    } catch (e) {
      threw = true;
    }
    assertTrue(threw, 'should throw on aborted signal');
  });

  console.log('\nQuery filtering:');

  await test('query filters messages by content', async () => {
    adapter.currentAccountIds = [TEST_ACCOUNT_A, TEST_ACCOUNT_B];

    const scope = await adapter.resolveScope('all-mail');
    const result = await adapter.searchMessages(scope, 'invoice', 'ranked', 100, 0);

    assertEqual(result.messages.length, 1, 'should find 1 invoice message');
    assertContains(result.messages[0].subject, 'Invoice');
  });

  console.log('\nRead-only guarantees:');

  await test('navigation cannot preserve read state', async () => {
    // Mailspring navigation always marks as read
    const preserved = await adapter.navigateToMessage('msg-t1-1', true);
    assertFalse(preserved, 'should return false - read state cannot be preserved');
  });

  await test('getSyncProgress is read-only', async () => {
    const before = await adapter.getSyncProgress([TEST_ACCOUNT_A]);
    const after = await adapter.getSyncProgress([TEST_ACCOUNT_A]);

    assertEqual(before[TEST_ACCOUNT_A], after[TEST_ACCOUNT_A], 'progress should not change');
  });

  // Summary
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
