/**
 * AI Sidebar package entry point.
 * Registers the sidebar panel in the message list sidebar.
 */
import { ComponentRegistry } from 'mailspring-exports';
import AISidebar from './ai-sidebar';
import { loadOfflineArchiveCatalog } from './offline-archive-catalog';
import { isOfflineArchiveMode } from '../../../src/offline-archive';

export function activate() {
  ComponentRegistry.register(AISidebar, {
    role: 'MessageListSidebar:Panel',
  });
  try {
    const props = AppEnv.getWindowProps && AppEnv.getWindowProps();
    const demo = (props && props.demoMode) || process.env.MAILSPRING_DEMO === '1';
    const realSelected =
      (props && props.realSelectedSummary) || process.env.MAILSPRING_REAL_SELECTED_SUMMARY === '1';
    const offline =
      (props && props.offlineArchive) ||
      process.env.MAILSPRING_OFFLINE_ARCHIVE === '1' ||
      isOfflineArchiveMode();
    if (offline && !demo) {
      const archivePath =
        (props && props.offlineArchivePath) || process.env.MAILSPRING_OFFLINE_ARCHIVE_PATH || '';
      const loaded = loadOfflineArchiveCatalog(String(archivePath || ''));
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
    if (demo || realSelected || (offline && !demo)) {
      AppEnv.config.set('core.workspace.mode', 'split');
      AppEnv.config.set('core.messageListSidebar.panel', 'ai-sidebar');
      console.log(
        demo
          ? '[Demo Mode] AISidebar registered (MessageListSidebar:Panel, syncInit)'
          : offline && !demo
            ? '[Offline archive] AISidebar registered (disconnected local archive)'
            : '[Real selected summary] AISidebar registered (MessageListSidebar:Panel, syncInit)'
      );
    }
  } catch {
    // Config may be unavailable in specs
  }
}

export function deactivate() {
  ComponentRegistry.unregister(AISidebar);
}

export function serialize() {
  return {};
}
