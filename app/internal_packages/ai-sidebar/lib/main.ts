/**
 * AI Sidebar package entry point.
 * Registers the sidebar panel in the message list sidebar.
 */
import { ComponentRegistry, WorkspaceStore } from 'mailspring-exports';
import AISidebar from './ai-sidebar';

export function activate() {
  ComponentRegistry.register(AISidebar, {
    role: 'MessageListSidebar:Panel',
  });
  try {
    if (AppEnv.getWindowProps && AppEnv.getWindowProps().demoMode) {
      AppEnv.config.set('core.workspace.mode', 'split');
      AppEnv.config.set('core.messageListSidebar.panel', 'ai-sidebar');
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
