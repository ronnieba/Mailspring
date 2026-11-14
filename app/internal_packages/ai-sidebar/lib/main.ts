/**
 * AI Sidebar package entry point.
 * Registers the sidebar panel in the message list sidebar.
 *
 * With --offline-archive this package also provides the offline experiment
 * mail browser (folder tree, message list, reader) over a local read-only
 * copy. No account, no mailsync, no Yahoo.
 */
import { ComponentRegistry } from 'mailspring-exports';
import AISidebar from './ai-sidebar';
import { loadOfflineArchiveCatalog } from './offline-archive-catalog';
import { isOfflineArchiveMode } from '../../../src/offline-archive';
import { registerOfflineMailBrowser, unregisterOfflineMailBrowser } from './offline-mail/register';
import AISidebarStore from './ai-sidebar-store';
import { offlineMailStore } from './offline-mail/offline-mail-store';

let offlineBrowser = false;
let unlistenOffline: (() => void) | null = null;

/**
 * Legacy synchronous catalog (small fixture trees). Large snapshot copies use
 * the async header index instead so the window never blocks on 7 GB of mail.
 */
function shouldUseBrowser(archivePath: string): boolean {
  if (process.env.MAILSPRING_OFFLINE_LEGACY_CATALOG === '1') {
    return false;
  }
  return !!archivePath;
}

export function activate() {
  let props: any = null;
  try {
    props = AppEnv.getWindowProps && AppEnv.getWindowProps();
  } catch {
    props = null;
  }
  const demo = (props && props.demoMode) || process.env.MAILSPRING_DEMO === '1';
  const realSelected =
    (props && props.realSelectedSummary) || process.env.MAILSPRING_REAL_SELECTED_SUMMARY === '1';
  const offline =
    !demo &&
    ((props && props.offlineArchive) ||
      process.env.MAILSPRING_OFFLINE_ARCHIVE === '1' ||
      isOfflineArchiveMode());
  const archivePath = offline
    ? String(
        (props && props.offlineArchivePath) || process.env.MAILSPRING_OFFLINE_ARCHIVE_PATH || ''
      )
    : '';

  if (offline && shouldUseBrowser(archivePath)) {
    offlineBrowser = true;
    registerOfflineMailBrowser(archivePath, AISidebar);
    let lastKey = '';
    unlistenOffline = offlineMailStore.listen(() => {
      const key = `${offlineMailStore.status}|${offlineMailStore.currentFolder}|${offlineMailStore.selectedIds.join(',')}`;
      if (key !== lastKey) {
        lastKey = key;
        void AISidebarStore.refreshScope();
      }
    });
  } else {
    ComponentRegistry.register(AISidebar, {
      role: 'MessageListSidebar:Panel',
    });
  }

  try {
    if (offline && !offlineBrowser) {
      const loaded = loadOfflineArchiveCatalog(archivePath);
      if (!loaded.ok) {
        console.error('[Offline archive] catalog not loaded:', loaded.reason);
      } else {
        const counts = loaded.manifest ? JSON.stringify(loaded.manifest.folderCounts) : '{}';
        console.log(
          `[Offline archive] loaded ${loaded.manifest ? loaded.manifest.messageCount : 0} messages ${counts}`
        );
        if (loaded.manifest && loaded.manifest.unreadable.length) {
          console.warn('[Offline archive] unreadable:', loaded.manifest.unreadable);
        }
        if (loaded.manifest && loaded.manifest.emptyFolders.length) {
          console.warn('[Offline archive] empty folders:', loaded.manifest.emptyFolders);
        }
      }
    }
    if (demo || realSelected || offline) {
      AppEnv.config.set('core.workspace.mode', 'split');
      AppEnv.config.set('core.messageListSidebar.panel', 'ai-sidebar');
      console.log(
        demo
          ? '[Demo Mode] AISidebar registered (MessageListSidebar:Panel, syncInit)'
          : offline
            ? `[Offline archive] AISidebar registered (disconnected local copy, ${
                offlineBrowser ? 'browser' : 'legacy catalog'
              })`
            : '[Real selected summary] AISidebar registered (MessageListSidebar:Panel, syncInit)'
      );
    }
  } catch {
    // Config may be unavailable in specs
  }
}

export function deactivate() {
  if (offlineBrowser) {
    if (unlistenOffline) {
      unlistenOffline();
    }
    unregisterOfflineMailBrowser(AISidebar);
    return;
  }
  ComponentRegistry.unregister(AISidebar);
}

export function serialize() {
  return {};
}
