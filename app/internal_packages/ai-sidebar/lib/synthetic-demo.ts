/**
 * Synthetic demo data for AI sidebar.
 * Used when no accounts are configured to demonstrate the sidebar UI.
 * All data is clearly marked as synthetic/demo.
 */
import { MessageRef, ResolvedScope, FolderRef, SearchResult } from './core/types';

export const DEMO_ACCOUNT_ID = 'demo-synthetic-account';
export const DEMO_FOLDER_ID = 'demo-synthetic-inbox';

/**
 * Check if we're in demo mode (no real accounts configured).
 */
export function isDemoMode(): boolean {
  try {
    const { AccountStore } = require('mailspring-exports');
    return !AccountStore.accounts || AccountStore.accounts().length === 0;
  } catch {
    return true;
  }
}

/**
 * Synthetic messages for demo mode.
 * These are clearly marked as synthetic/test data.
 */
export const SYNTHETIC_MESSAGES: MessageRef[] = [
  {
    id: 'demo-msg-1',
    threadId: 'demo-thread-1',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] הזמנה לפגישת צוות - יום ראשון',
    from: 'demo-manager@synthetic.test',
    date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    snippet: 'שלום לכולם, אני מזמין אתכם לפגישת צוות ביום ראשון בשעה 10:00. נא לאשר הגעה.',
  },
  {
    id: 'demo-msg-2',
    threadId: 'demo-thread-1',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] RE: הזמנה לפגישת צוות - יום ראשון',
    from: 'demo-colleague@synthetic.test',
    date: new Date(Date.now() - 20 * 60 * 60 * 1000),
    snippet: 'מאשר הגעה. האם יש סדר יום מוכן?',
  },
  {
    id: 'demo-msg-3',
    threadId: 'demo-thread-2',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] חשבונית #12345 - נובמבר 2024',
    from: 'demo-billing@synthetic.test',
    date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    snippet: 'מצורפת חשבונית עבור שירותים לחודש נובמבר. סכום לתשלום: ₪1,234.56',
  },
  {
    id: 'demo-msg-4',
    threadId: 'demo-thread-3',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] עדכון פרויקט - סטטוס שבועי',
    from: 'demo-pm@synthetic.test',
    date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    snippet: 'להלן סיכום השבוע: השלמנו 80% מהמשימות המתוכננות. נותרו 3 משימות קריטיות.',
  },
  {
    id: 'demo-msg-5',
    threadId: 'demo-thread-4',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] ברוכים הבאים למערכת',
    from: 'demo-system@synthetic.test',
    date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    snippet: 'ברוכים הבאים! זוהי הודעה סינתטית לדמו. אין צורך להוסיף חשבון אמיתי.',
  },
];

export const SYNTHETIC_THREADS = [
  { id: 'demo-thread-1', subject: '🧪 [DEMO] הזמנה לפגישת צוות - יום ראשון', messageCount: 2 },
  { id: 'demo-thread-2', subject: '🧪 [DEMO] חשבונית #12345 - נובמבר 2024', messageCount: 1 },
  { id: 'demo-thread-3', subject: '🧪 [DEMO] עדכון פרויקט - סטטוס שבועי', messageCount: 1 },
  { id: 'demo-thread-4', subject: '🧪 [DEMO] ברוכים הבאים למערכת', messageCount: 1 },
];

export const SYNTHETIC_FOLDER: FolderRef = {
  id: DEMO_FOLDER_ID,
  accountId: DEMO_ACCOUNT_ID,
  name: '📬 Demo Inbox (Synthetic)',
  role: 'inbox',
};

/**
 * Get demo scope based on mode.
 */
export function getDemoScope(
  mode: 'selected-messages' | 'current-folder' | 'all-mail'
): ResolvedScope {
  if (mode === 'selected-messages') {
    // Simulate selecting the first two messages/threads
    return {
      mode,
      accountIds: [DEMO_ACCOUNT_ID],
      threadIds: ['demo-thread-1'],
      messageIds: ['demo-msg-1', 'demo-msg-2'],
      isEmpty: false,
      description: '🧪 DEMO: שרשור פגישת צוות (2 הודעות)',
    };
  }

  if (mode === 'current-folder') {
    return {
      mode,
      accountIds: [DEMO_ACCOUNT_ID],
      folder: SYNTHETIC_FOLDER,
      isEmpty: false,
      description: '🧪 DEMO: תיקיית Inbox סינתטית',
    };
  }

  // all-mail
  return {
    mode,
    accountIds: [DEMO_ACCOUNT_ID],
    isEmpty: false,
    description: '🧪 DEMO: כל הדואר הסינתטי',
  };
}

/**
 * Search synthetic messages.
 */
export function searchDemoMessages(
  scope: ResolvedScope,
  query: string,
  limit: number,
  offset: number
): SearchResult {
  let messages = [...SYNTHETIC_MESSAGES];

  // Filter by scope
  if (scope.mode === 'selected-messages' && scope.messageIds?.length) {
    messages = messages.filter((m) => scope.messageIds!.includes(m.id));
  }

  // Filter by query
  if (query) {
    const q = query.toLowerCase();
    messages = messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q) ||
        m.from.toLowerCase().includes(q)
    );
  }

  // Apply pagination
  const total = messages.length;
  const paginated = messages.slice(offset, offset + limit);

  return {
    messages: paginated,
    progress: {
      totalEligible: total,
      processed: paginated.length,
      withBodies: paginated.length,
      missingBodies: 0,
      syncCoverage: 100,
      isComplete: true,
      isCancelled: false,
    },
    retrievalMode: 'ranked',
  };
}

/**
 * Get demo sync progress.
 */
export function getDemoSyncProgress(): { [accountId: string]: number } {
  return { [DEMO_ACCOUNT_ID]: 100 };
}
