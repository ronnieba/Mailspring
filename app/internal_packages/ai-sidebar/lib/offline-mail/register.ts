/**
 * Offline experiment main-window surfaces. Registered only with
 * --offline-archive. Thread list, account sidebar, message list, composer
 * and sync-dependent packages are not activated in that mode (see
 * OFFLINE_ARCHIVE_DISABLED_PACKAGES).
 */
import * as path from 'path';
import { ComponentRegistry, WorkspaceStore } from 'mailspring-exports';
import { OfflineFolderSidebar } from './offline-folder-sidebar';
import { OfflineMessageList } from './offline-message-list';
import { OfflineMessageReader } from './offline-message-reader';
import { OfflineRibbon } from './offline-ribbon';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { offlineAddressBook } from './offline-address-book-store';
import { proofreadDraftViaIpc } from '../gemini-ipc-transport';
import AISidebarStore from '../ai-sidebar-store';
import { offlineLang, offlineLangBodyClass, offlineDir } from '../core/offline-i18n';

/** Mark <body> with the offline UI language so styles can follow it. */
export function applyOfflineLanguageToDocument(doc: Document = document): void {
  const lang = offlineLang();
  doc.body.classList.remove(offlineLangBodyClass('he'), offlineLangBodyClass('en'));
  doc.body.classList.add(offlineLangBodyClass(lang));
  doc.documentElement.setAttribute('lang', lang);
  doc.body.setAttribute('data-offline-dir', offlineDir());
}

export function registerOfflineMailBrowser(archivePath: string, sidebar: any) {
  applyOfflineLanguageToDocument();
  ComponentRegistry.register(OfflineFolderSidebar, {
    location: WorkspaceStore.Location.RootSidebar,
  });
  ComponentRegistry.register(OfflineMessageList, {
    location: WorkspaceStore.Location.ThreadList,
    modes: ['split', 'list', 'splitVertical'],
  });
  ComponentRegistry.register(OfflineMessageReader, {
    location: WorkspaceStore.Location.MessageList,
    modes: ['split'],
  });
  // Outlook-style top bar (tabs + ribbon) above all columns. It holds the
  // show/hide buttons for the columns and everything from the app menu.
  ComponentRegistry.register(OfflineRibbon, {
    location: WorkspaceStore.Sheet.Global.Header,
  });
  // The message-list package (which hosts sidebar panels) is disabled offline,
  // so the AI panel is registered straight into the sidebar column.
  ComponentRegistry.register(sidebar, { location: WorkspaceStore.Location.MessageListSidebar });

  let cachePath: string | undefined;
  try {
    cachePath = path.join(AppEnv.getConfigDirPath(), 'offline-mail-index.json');
  } catch {
    cachePath = undefined;
  }
  // Local drafts: saved only in the offline profile. Proofreading sends the
  // draft text alone, on click; the main process logs usage to the meter.
  try {
    offlineDraftsStore.configure({
      configDir: AppEnv.getConfigDirPath(),
      transport: (generation, text) => proofreadDraftViaIpc(generation, text),
      afterProofread: () => void AISidebarStore.refreshGeminiUsage(),
    });
  } catch (err) {
    console.error('[Offline drafts] not available:', (err as Error).message);
  }
  // Local address book from archive headers; saved only in the offline profile.
  try {
    offlineAddressBook.configure(AppEnv.getConfigDirPath());
  } catch (err) {
    console.error('[Offline address book] not available:', (err as Error).message);
  }
  offlineMailStore.listen(() => {
    if (offlineMailStore.status === 'ready' && offlineMailStore.index) {
      // Let the folder tree paint first.
      const index = offlineMailStore.index;
      setTimeout(() => offlineAddressBook.rebuild(index), 50);
    }
  });
  window.addEventListener('beforeunload', () => offlineDraftsStore.flush());
  (window as any).__offlineMail = {
    summary: () => offlineMailStore.summary(),
    store: offlineMailStore,
    drafts: offlineDraftsStore,
    addressBook: offlineAddressBook,
  };
  void offlineMailStore.start(archivePath, cachePath);
  // Window size/position/maximized state is restored by the main process
  // (offline-window-state.ts); only the first launch opens maximized.
}

export function unregisterOfflineMailBrowser(sidebar: any) {
  ComponentRegistry.unregister(OfflineFolderSidebar);
  ComponentRegistry.unregister(OfflineMessageList);
  ComponentRegistry.unregister(OfflineMessageReader);
  ComponentRegistry.unregister(OfflineRibbon);
  ComponentRegistry.unregister(sidebar);
}
