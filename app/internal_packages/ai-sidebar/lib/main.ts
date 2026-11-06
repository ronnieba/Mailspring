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
    const demo =
      (AppEnv.getWindowProps && AppEnv.getWindowProps().demoMode) ||
      process.env.MAILSPRING_DEMO === '1';
    if (demo) {
      AppEnv.config.set('core.workspace.mode', 'split');
      AppEnv.config.set('core.messageListSidebar.panel', 'ai-sidebar');
      console.log('[Demo Mode] AISidebar registered (MessageListSidebar:Panel, syncInit)');
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
