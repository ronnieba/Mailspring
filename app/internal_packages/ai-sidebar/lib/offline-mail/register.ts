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
import { OfflinePaneToggles } from './offline-pane-toggles';
import { offlineMailStore } from './offline-mail-store';

export function registerOfflineMailBrowser(archivePath: string, sidebar: any) {
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
  // Show/hide buttons for the folders, reader and AI columns. They live in the
  // message list's toolbar, which is the one column that cannot be hidden.
  ComponentRegistry.register(OfflinePaneToggles, {
    location: WorkspaceStore.Location.ThreadList.Toolbar,
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
  (window as any).__offlineMail = {
    summary: () => offlineMailStore.summary(),
    store: offlineMailStore,
  };
  void offlineMailStore.start(archivePath, cachePath);
  maximizeOnceWhenShown();
}

// The experiment shows four columns, so open maximized. Done here, after the
// window is visible, because maximizing the still-hidden window is undone by
// the first show() on Windows.
function maximizeOnceWhenShown() {
  let tries = 0;
  const tick = () => {
    tries++;
    try {
      const win = AppEnv.getCurrentWindow();
      if (win.isVisible()) {
        if (!win.isMaximized()) {
          win.maximize();
        }
        return;
      }
    } catch {
      return;
    }
    if (tries < 40) {
      setTimeout(tick, 250);
    }
  };
  setTimeout(tick, 250);
}

export function unregisterOfflineMailBrowser(sidebar: any) {
  ComponentRegistry.unregister(OfflineFolderSidebar);
  ComponentRegistry.unregister(OfflineMessageList);
  ComponentRegistry.unregister(OfflineMessageReader);
  ComponentRegistry.unregister(OfflinePaneToggles);
  ComponentRegistry.unregister(sidebar);
}
