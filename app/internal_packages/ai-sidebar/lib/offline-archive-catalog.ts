/**
 * In-memory catalog of a local offline archive. Original files stay on disk;
 * this index is a disposable working view. Tests inject fixtures.
 */
import { MessageRef, ResolvedScope, RetrievalMode, SearchResult } from './core/types';
import {
  isForbiddenArchiveRoot,
  OFFLINE_ARCHIVE_ACCOUNT_ID,
  OfflineArchiveManifest,
  OfflineArchiveMessage,
  readOfflineArchive,
} from './core/offline-archive-format';

let catalog: OfflineArchiveMessage[] = [];
let selectedId: string | null = null;
let manifest: OfflineArchiveManifest | null = null;

export function setOfflineArchiveCatalog(
  messages: OfflineArchiveMessage[],
  nextManifest?: OfflineArchiveManifest | null
): void {
  catalog = Array.isArray(messages) ? messages.slice() : [];
  manifest = nextManifest || null;
  if (!selectedId || !catalog.some((m) => m.id === selectedId)) {
    selectedId = catalog[0] ? catalog[0].id : null;
  }
}

export function setOfflineArchiveSelected(id: string | null): boolean {
  if (!id) {
    selectedId = catalog[0] ? catalog[0].id : null;
    return !!selectedId;
  }
  if (!catalog.some((m) => m.id === id)) {
    return false;
  }
  selectedId = id;
  return true;
}

export function getOfflineArchiveSelected(): string | null {
  return selectedId;
}

export function getOfflineArchiveManifest(): OfflineArchiveManifest | null {
  return manifest;
}

export function loadOfflineArchiveCatalog(originalRoot: string): {
  ok: boolean;
  reason: string;
  manifest: OfflineArchiveManifest | null;
} {
  const forbidden = isForbiddenArchiveRoot(originalRoot);
  if (forbidden.forbidden) {
    setOfflineArchiveCatalog([], null);
    return { ok: false, reason: forbidden.reason, manifest: null };
  }
  try {
    const loaded = readOfflineArchive(originalRoot);
    setOfflineArchiveCatalog(loaded.messages, loaded.manifest);
    return { ok: true, reason: '', manifest: loaded.manifest };
  } catch (err) {
    setOfflineArchiveCatalog([], null);
    return {
      ok: false,
      reason: (err as Error).message || 'failed to read archive',
      manifest: null,
    };
  }
}

export function getOfflineArchiveCatalog(): OfflineArchiveMessage[] {
  return catalog.slice();
}

export function offlineMessageToRef(m: OfflineArchiveMessage): MessageRef {
  return {
    id: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    subject: m.subject,
    from: m.from,
    date: m.date ? new Date(m.date) : new Date(0),
    snippet: m.snippet,
    folderId: m.folderId,
    bodyText: m.bodyText,
  };
}

export function getOfflineArchiveScope(mode: ResolvedScope['mode']): ResolvedScope {
  const messages = catalog;
  if (mode === 'selected-messages') {
    const selected = messages.find((m) => m.id === selectedId) || messages[0];
    return {
      mode,
      threadIds: selected ? [selected.threadId] : [],
      messageIds: selected ? [selected.id] : [],
      accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
      description: selected
        ? `הודעה אחת מהארכיון המקומי (${selected.id})`
        : 'ארכיון מקומי ריק — לא נבחרה הודעה',
      isEmpty: !selected,
    };
  }
  if (mode === 'current-folder') {
    const folder = messages[0]?.folderPath || 'INBOX';
    const inFolder = messages.filter((m) => m.folderPath === folder);
    return {
      mode,
      folder: {
        id: inFolder[0]?.folderId || 'INBOX',
        accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
        name: folder,
        role: null,
      },
      accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
      description: `תיקיית ארכיון: ${folder} (${inFolder.length})`,
      isEmpty: inFolder.length === 0,
    };
  }
  return {
    mode,
    accountIds: [OFFLINE_ARCHIVE_ACCOUNT_ID],
    description: `ארכיון מקומי מנותק (${messages.length} הודעות)`,
    isEmpty: messages.length === 0,
  };
}

export function searchOfflineArchive(
  scope: ResolvedScope,
  _query: string,
  retrieval: RetrievalMode,
  limit: number,
  offset: number
): SearchResult {
  let rows = catalog;
  if (scope.mode === 'selected-messages' && scope.messageIds?.length) {
    const allowed = new Set(scope.messageIds);
    rows = rows.filter((m) => allowed.has(m.id));
  } else if (scope.mode === 'current-folder' && scope.folder) {
    rows = rows.filter((m) => m.folderId === scope.folder.id || m.folderPath === scope.folder.name);
  }
  const refs = rows.map(offlineMessageToRef);
  const page = refs.slice(offset, offset + limit);
  return {
    messages: page,
    progress: {
      totalEligible: refs.length,
      processed: page.length,
      withBodies: page.length,
      missingBodies: 0,
      syncCoverage: 100,
      isComplete: true,
      isCancelled: false,
    },
    retrievalMode: retrieval,
  };
}

export function getOfflineArchiveBody(messageId: string): string | null {
  const found = catalog.find((m) => m.id === messageId);
  return found ? found.bodyText : null;
}

export function getOfflineArchiveAttachmentCount(messageId: string): number {
  const found = catalog.find((m) => m.id === messageId);
  return found ? found.attachmentCount : 0;
}
