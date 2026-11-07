/**
 * Synthetic demo data for AI sidebar.
 * Used when no accounts are configured to demonstrate the sidebar UI.
 * All data is clearly marked as synthetic/demo.
 */
import { MessageRef, ResolvedScope, FolderRef, SearchResult, RetrievalMode } from './core/types';
import { isDemoMode as isExplicitDemoMode } from '../../../src/demo-mode';
import { filterMessagesByQuery } from './core/query-filter';

export const DEMO_ACCOUNT_ID = 'demo-synthetic-account';
export const DEMO_FOLDER_ID = 'demo-synthetic-inbox';
export const DEMO_ARCHIVE_FOLDER_ID = 'demo-synthetic-archive';
export const DEMO_OUTSIDE_INBOX_MESSAGE_ID = 'demo-msg-6';
/** Deterministic UI-test query: All includes archive; Inbox/Selected exclude it. */
export const DEMO_OUTSIDE_INBOX_QUERY = 'חפש הודעת ארכיון';
export const DEMO_INVOICE_QUERY = 'חפש חשבוניות';
export const DEMO_INVOICE_MESSAGE_ID = 'demo-msg-3';
export const DEMO_MEETING_MESSAGE_ID = 'demo-msg-1';

/**
 * Explicit --demo route only. Empty AccountStore is onboarding, not demo.
 */
export function isDemoMode(): boolean {
  return isExplicitDemoMode();
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
    folderId: DEMO_FOLDER_ID,
  },
  {
    id: 'demo-msg-2',
    threadId: 'demo-thread-1',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] RE: הזמנה לפגישת צוות - יום ראשון',
    from: 'demo-colleague@synthetic.test',
    date: new Date(Date.now() - 20 * 60 * 60 * 1000),
    snippet: 'מאשר הגעה. האם יש סדר יום מוכן?',
    folderId: DEMO_FOLDER_ID,
  },
  {
    id: 'demo-msg-3',
    threadId: 'demo-thread-2',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] חשבונית #12345 - נובמבר 2024',
    from: 'demo-billing@synthetic.test',
    date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    snippet: 'מצורפת חשבונית עבור שירותים לחודש נובמבר. סכום לתשלום: ₪1,234.56',
    folderId: DEMO_FOLDER_ID,
  },
  {
    id: 'demo-msg-4',
    threadId: 'demo-thread-3',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] עדכון פרויקט - סטטוס שבועי',
    from: 'demo-pm@synthetic.test',
    date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    snippet: 'להלן סיכום השבוע: השלמנו 80% מהמשימות המתוכננות. נותרו 3 משימות קריטיות.',
    folderId: DEMO_FOLDER_ID,
  },
  {
    id: 'demo-msg-5',
    threadId: 'demo-thread-4',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] ברוכים הבאים למערכת',
    from: 'demo-system@synthetic.test',
    date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    snippet: 'ברוכים הבאים! זוהי הודעה סינתטית לדמו. אין צורך להוסיף חשבון אמיתי.',
    folderId: DEMO_FOLDER_ID,
  },
  {
    id: DEMO_OUTSIDE_INBOX_MESSAGE_ID,
    threadId: 'demo-thread-5',
    accountId: DEMO_ACCOUNT_ID,
    subject: '🧪 [DEMO] הודעת ארכיון מחוץ לתיבת הדואר הנכנס',
    from: 'demo-archive@synthetic.test',
    date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    snippet:
      'הודעה סינתטית בארכיון בלבד, לא בתיבת דואר נכנס. OUTSIDE_INBOX_FIXTURE. אין חשבון אמיתי.',
    folderId: DEMO_ARCHIVE_FOLDER_ID,
  },
];

export const SYNTHETIC_THREADS = [
  { id: 'demo-thread-1', subject: '🧪 [DEMO] הזמנה לפגישת צוות - יום ראשון', messageCount: 2 },
  { id: 'demo-thread-2', subject: '🧪 [DEMO] חשבונית #12345 - נובמבר 2024', messageCount: 1 },
  { id: 'demo-thread-3', subject: '🧪 [DEMO] עדכון פרויקט - סטטוס שבועי', messageCount: 1 },
  { id: 'demo-thread-4', subject: '🧪 [DEMO] ברוכים הבאים למערכת', messageCount: 1 },
  {
    id: 'demo-thread-5',
    subject: '🧪 [DEMO] הודעת ארכיון מחוץ לתיבת הדואר הנכנס',
    messageCount: 1,
  },
];

export const SYNTHETIC_FOLDER: FolderRef = {
  id: DEMO_FOLDER_ID,
  accountId: DEMO_ACCOUNT_ID,
  name: '📬 Demo Inbox (Synthetic)',
  role: 'inbox',
};

export const SYNTHETIC_ARCHIVE_FOLDER: FolderRef = {
  id: DEMO_ARCHIVE_FOLDER_ID,
  accountId: DEMO_ACCOUNT_ID,
  name: '📦 Demo Archive (Synthetic)',
  role: 'all',
};

export function filterDemoMessagesByScope(
  messages: MessageRef[],
  scope: ResolvedScope
): MessageRef[] {
  if (scope.mode === 'selected-messages' && scope.messageIds && scope.messageIds.length) {
    const allowed = new Set(scope.messageIds);
    return messages.filter((m) => allowed.has(m.id));
  }
  if (scope.mode === 'current-folder') {
    const folderId = scope.folder?.id || DEMO_FOLDER_ID;
    return messages.filter((m) => (m.folderId || DEMO_FOLDER_ID) === folderId);
  }
  return [...messages];
}

export interface DemoMessagePreview {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: Date;
  snippet: string;
  body: string;
  folderId: string;
  folderName: string;
}

export function getDemoMessagePreview(messageId: string): DemoMessagePreview | null {
  const msg = SYNTHETIC_MESSAGES.find((m) => m.id === messageId);
  if (!msg) {
    return null;
  }
  const folderId = msg.folderId || DEMO_FOLDER_ID;
  const folderName =
    folderId === DEMO_ARCHIVE_FOLDER_ID
      ? 'ארכיון סינתטי (מחוץ לתיבת דואר נכנס)'
      : 'תיבת דואר נכנס סינתטית';
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    subject: msg.subject,
    from: msg.from,
    date: msg.date,
    snippet: msg.snippet,
    body: `${msg.snippet}\n\n[DEMO] Synthetic fixture body. No remote content. Source id: ${msg.id}`,
    folderId,
    folderName,
  };
}

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
 * Ranked returns query matches (top-k). Exhaustive scans every in-scope
 * fixture and reports that count — it does not claim the whole mailbox
 * when scope is Inbox or Selected.
 */
export function searchDemoMessages(
  scope: ResolvedScope,
  query: string,
  limit: number,
  offset: number,
  mode: RetrievalMode = 'ranked'
): SearchResult {
  const inScope = filterDemoMessagesByScope(SYNTHETIC_MESSAGES, scope);
  const matched = filterMessagesByQuery(inScope, query);

  if (mode === 'exhaustive') {
    return {
      messages: inScope,
      progress: {
        totalEligible: inScope.length,
        processed: inScope.length,
        withBodies: inScope.length,
        missingBodies: 0,
        syncCoverage: 100,
        isComplete: true,
        isCancelled: false,
      },
      retrievalMode: 'exhaustive',
    };
  }

  const paginated = matched.slice(offset, offset + limit);
  return {
    messages: paginated,
    progress: {
      totalEligible: matched.length,
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

export function getDemoMessageBody(messageId: string): string | null {
  return getDemoMessagePreview(messageId)?.body || null;
}
