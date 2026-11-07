#!/usr/bin/env npx ts-node
/**
 * RUNTIME tests of the PRODUCTION MailspringAdapter class with injected fake stores.
 * This file imports ./lib/mailspring-adapter and calls its methods.
 * Category: production-import (not a duplicated FakeAdapter).
 *
 * Run with: npx ts-node app/internal_packages/ai-sidebar/test-real-adapter.ts
 */
import { MailspringAdapter, MailAdapterStores, QueryLike } from './lib/mailspring-adapter';

const data = {
  accounts: [] as string[],
  threads: new Map<string, any>(),
  messages: new Map<string, any>(),
  focusedThread: null as any,
  selectedThreads: [] as any[],
  categories: [] as any[],
  syncState: {} as MailAdapterStores['getSyncState'] extends () => infer R ? R : never,
  setFocusCalled: false,
  lastFocus: null as any,
  demo: false,
};

function reset() {
  data.accounts = [];
  data.threads.clear();
  data.messages.clear();
  data.focusedThread = null;
  data.selectedThreads = [];
  data.categories = [];
  data.syncState = {};
  data.setFocusCalled = false;
  data.lastFocus = null;
  data.demo = false;
}

function matches(row: any, cond: any): boolean {
  if (!cond || !cond.attr) return true;
  const val = row[cond.attr];
  if (cond.op === 'in') return Array.isArray(cond.val) && cond.val.includes(val);
  if (cond.op === 'equal') return val === cond.val;
  if (cond.op === 'contains') return Array.isArray(val) && val.includes(cond.val);
  return true;
}

function queryFor(collection: () => Map<string, any>): QueryLike<any> {
  const q: any = {
    _filters: [] as any[],
    _limit: 10000,
    _offset: 0,
    _search: null as string | null,
    where(condition: any) {
      this._filters.push(condition);
      return this;
    },
    order() {
      return this;
    },
    limit(n: number) {
      this._limit = n;
      return this;
    },
    offset(n: number) {
      this._offset = n;
      return this;
    },
    search(term: string) {
      this._search = term;
      return this;
    },
    include() {
      return this;
    },
    then(resolve: (rows: any[]) => unknown, reject?: (err: unknown) => unknown) {
      try {
        let rows = Array.from(collection().values());
        for (const f of this._filters) {
          rows = rows.filter((r) => matches(r, f));
        }
        if (this._search) {
          const t = this._search.toLowerCase();
          rows = rows.filter(
            (r) =>
              (r.subject || '').toLowerCase().includes(t) ||
              (r.snippet || '').toLowerCase().includes(t) ||
              (r.body || '').toLowerCase().includes(t)
          );
        }
        rows = rows.slice(this._offset, this._offset + this._limit);
        return Promise.resolve(resolve(rows));
      } catch (err) {
        if (reject) return Promise.resolve(reject(err));
        return Promise.reject(err);
      }
    },
  };
  return q;
}

function findOne(map: Map<string, any>, id: string): QueryLike<any> {
  const q: any = {
    include() {
      return this;
    },
    then(resolve: (row: any) => unknown) {
      return Promise.resolve(resolve(map.get(id) || null));
    },
  };
  return q;
}

const attr = {
  in: (attrName: string) => (val: unknown) => ({ attr: attrName, op: 'in', val }),
  equal: (attrName: string) => (val: unknown) => ({ attr: attrName, op: 'equal', val }),
  contains: (attrName: string) => (val: unknown) => ({ attr: attrName, op: 'contains', val }),
};

function fakeStores(): MailAdapterStores {
  return {
    isDemoMode: () => data.demo,
    accountIds: () => data.accounts,
    currentPerspective: () => ({
      accountIds: data.accounts,
      categories: () => data.categories,
    }),
    selectedThreads: () => data.selectedThreads,
    focusedThread: () => data.focusedThread,
    findAllMessages: () => queryFor(() => data.messages),
    findAllThreads: () => queryFor(() => data.threads),
    findMessage: (id) => findOne(data.messages, id),
    findThread: (id) => findOne(data.threads, id),
    getSyncState: () => data.syncState,
    setFocus: (args) => {
      data.setFocusCalled = true;
      data.lastFocus = args;
    },
    Message: {
      attributes: {
        id: { in: attr.in('id') },
        threadId: { in: attr.in('threadId'), equal: attr.equal('threadId') },
        accountId: { in: attr.in('accountId') },
        draft: { equal: attr.equal('draft') },
        date: { descending: () => 'desc' },
        body: {},
      },
    },
    Thread: {
      attributes: {
        accountId: { in: attr.in('accountId') },
        categories: { contains: attr.contains('categories') },
        lastMessageReceivedTimestamp: { descending: () => 'desc' },
      },
    },
  };
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) throw new Error(msg || `Expected ${expected}, got ${actual}`);
}
function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg || 'Expected true');
}
function assertFalse(v: boolean, msg?: string) {
  if (v) throw new Error(msg || 'Expected false');
}

async function run() {
  console.log('\n=== Production MailspringAdapter (injected stores) ===\n');
  console.log('Category: production-import runtime\n');

  const adapter = new MailspringAdapter(fakeStores());

  console.log('Demo path on production class:');
  await test('explicit demo resolveScope uses synthetic fixtures', async () => {
    reset();
    data.demo = true;
    const scope = await adapter.resolveScope('selected-messages');
    assertTrue(scope.description.includes('DEMO'));
    assertFalse(scope.isEmpty);
  });

  await test('explicit demo search returns [DEMO] messages', async () => {
    reset();
    data.demo = true;
    const scope = await adapter.resolveScope('all-mail');
    const result = await adapter.searchMessages(scope, '', 'ranked', 10, 0);
    assertTrue(result.messages.length > 0);
    assertTrue(result.messages[0].subject.includes('[DEMO]'));
    assertEqual(result.retrievalMode, 'ranked');
  });

  await test('explicit demo exhaustive search reports exhaustive in-scope count', async () => {
    reset();
    data.demo = true;
    const scope = await adapter.resolveScope('all-mail');
    const result = await adapter.searchMessages(scope, 'חשבונית', 'exhaustive', 10, 0);
    assertEqual(result.retrievalMode, 'exhaustive');
    assertTrue(result.progress.processed > 1);
    assertEqual(result.progress.processed, result.progress.totalEligible);
    assertTrue(result.progress.isComplete);
  });

  await test('explicit demo does not call setFocus on navigate', async () => {
    reset();
    data.demo = true;
    await adapter.navigateToMessage('demo-msg-1', true);
    assertFalse(data.setFocusCalled);
  });

  console.log('\nSelected / folder / all-mail on production class:');
  await test('empty selection is empty scope', async () => {
    reset();
    data.accounts = ['acc-1'];
    const scope = await adapter.resolveScope('selected-messages');
    assertTrue(scope.isEmpty);
    assertEqual(scope.mode, 'selected-messages');
  });

  await test('focused thread becomes selected-messages scope', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.focusedThread = { id: 't-focus', accountId: 'acc-1', subject: 'Hello' };
    data.messages.set('m1', { id: 'm1', threadId: 't-focus', accountId: 'acc-1', draft: false });
    const scope = await adapter.resolveScope('selected-messages');
    assertFalse(scope.isEmpty);
    assertEqual(scope.threadIds?.[0], 't-focus');
    assertEqual(scope.messageIds?.length, 1);
  });

  await test('multi-selection wins over focused thread', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.focusedThread = { id: 't-focus', accountId: 'acc-1' };
    data.selectedThreads = [
      { id: 't-a', accountId: 'acc-1' },
      { id: 't-b', accountId: 'acc-1' },
    ];
    data.messages.set('m-a', { id: 'm-a', threadId: 't-a', accountId: 'acc-1', draft: false });
    data.messages.set('m-b', { id: 'm-b', threadId: 't-b', accountId: 'acc-1', draft: false });
    const scope = await adapter.resolveScope('selected-messages');
    assertEqual(scope.threadIds?.length, 2);
    assertFalse((scope.threadIds || []).includes('t-focus'));
  });

  await test('folder scope uses perspective category', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.categories = [{ id: 'inbox-1', accountId: 'acc-1', displayName: 'Inbox', role: 'inbox' }];
    const scope = await adapter.resolveScope('current-folder');
    assertEqual(scope.folder?.name, 'Inbox');
    assertFalse(scope.isEmpty);
  });

  await test('all-mail includes granted account ids only', async () => {
    reset();
    data.accounts = ['acc-1', 'acc-2'];
    const scope = await adapter.resolveScope('all-mail');
    assertEqual(scope.accountIds.length, 2);
  });

  console.log('\nSearch, pagination, missing bodies, cancellation:');
  await test('excludes drafts', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.messages.set('m1', {
      id: 'm1',
      threadId: 't',
      accountId: 'acc-1',
      draft: false,
      subject: 'Real',
    });
    data.messages.set('d1', {
      id: 'd1',
      threadId: 't',
      accountId: 'acc-1',
      draft: true,
      subject: 'Draft',
    });
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);
    assertTrue(result.messages.every((m) => m.subject !== 'Draft'));
    assertEqual(result.messages.length, 1);
  });

  await test('query filters subjects', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.messages.set('m1', {
      id: 'm1',
      threadId: 't',
      accountId: 'acc-1',
      draft: false,
      subject: 'Meeting',
    });
    data.messages.set('m2', {
      id: 'm2',
      threadId: 't',
      accountId: 'acc-1',
      draft: false,
      subject: 'Vacation',
    });
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const result = await adapter.searchMessages(scope, 'meeting', 'ranked', 100, 0);
    assertEqual(result.messages.length, 1);
  });

  await test('ranked limit/offset pages do not overlap', async () => {
    reset();
    data.accounts = ['acc-1'];
    for (let i = 0; i < 8; i++) {
      data.messages.set(`m${i}`, {
        id: `m${i}`,
        threadId: 't',
        accountId: 'acc-1',
        draft: false,
        subject: `S${i}`,
      });
    }
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const p1 = await adapter.searchMessages(scope, '', 'ranked', 3, 0);
    const p2 = await adapter.searchMessages(scope, '', 'ranked', 3, 3);
    assertEqual(p1.messages.length, 3);
    const ids = new Set(p1.messages.map((m) => m.id));
    for (const m of p2.messages) {
      assertFalse(ids.has(m.id));
    }
  });

  await test('exhaustive reports totalEligible and slices page', async () => {
    reset();
    data.accounts = ['acc-1'];
    for (let i = 0; i < 5; i++) {
      data.messages.set(`m${i}`, {
        id: `m${i}`,
        threadId: 't',
        accountId: 'acc-1',
        draft: false,
        subject: `S${i}`,
      });
    }
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const result = await adapter.searchMessages(scope, '', 'exhaustive', 2, 0);
    assertEqual(result.progress.totalEligible, 5);
    assertEqual(result.messages.length, 2);
    assertEqual(result.retrievalMode, 'exhaustive');
  });

  await test('missing bodies counted', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.messages.set('m1', {
      id: 'm1',
      threadId: 't',
      accountId: 'acc-1',
      draft: false,
      body: 'x',
    });
    data.messages.set('m2', {
      id: 'm2',
      threadId: 't',
      accountId: 'acc-1',
      draft: false,
      body: null,
    });
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const result = await adapter.searchMessages(scope, '', 'ranked', 10, 0);
    assertEqual(result.progress.withBodies, 1);
    assertEqual(result.progress.missingBodies, 1);
  });

  await test('aborted signal returns cancelled empty result', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.messages.set('m1', { id: 'm1', threadId: 't', accountId: 'acc-1', draft: false });
    const c = new AbortController();
    c.abort();
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const result = await adapter.searchMessages(scope, '', 'ranked', 10, 0, c.signal);
    assertTrue(result.progress.isCancelled);
    assertEqual(result.messages.length, 0);
  });

  await test('account grant: all-mail does not return other account', async () => {
    reset();
    data.accounts = ['acc-1'];
    data.messages.set('mine', {
      id: 'mine',
      threadId: 't',
      accountId: 'acc-1',
      draft: false,
      subject: 'Mine',
    });
    data.messages.set('other', {
      id: 'other',
      threadId: 't',
      accountId: 'acc-2',
      draft: false,
      subject: 'Other',
    });
    const scope = {
      mode: 'all-mail' as const,
      accountIds: ['acc-1'],
      isEmpty: false,
      description: 't',
    };
    const result = await adapter.searchMessages(scope, '', 'ranked', 100, 0);
    assertTrue(result.messages.every((m) => m.accountId === 'acc-1'));
  });

  console.log('\nRead-only:');
  await test('navigateToMessage calls setFocus only (no write APIs)', async () => {
    reset();
    data.messages.set('m1', { id: 'm1', threadId: 't1', accountId: 'acc-1' });
    data.threads.set('t1', { id: 't1', accountId: 'acc-1' });
    await adapter.navigateToMessage('m1', true);
    assertTrue(data.setFocusCalled);
    assertEqual(data.lastFocus.collection, 'thread');
  });

  await test('adapter prototype has no mutation method names', () => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
    for (const banned of ['send', 'delete', 'move', 'trash', 'archive', 'star']) {
      assertFalse(names.includes(banned), `must not implement ${banned}`);
    }
  });

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40) + '\n');
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
