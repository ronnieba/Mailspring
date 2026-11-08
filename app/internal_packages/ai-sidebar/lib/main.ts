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
    const props = AppEnv.getWindowProps && AppEnv.getWindowProps();
    const demo = (props && props.demoMode) || process.env.MAILSPRING_DEMO === '1';
    const realSelected =
      (props && props.realSelectedSummary) || process.env.MAILSPRING_REAL_SELECTED_SUMMARY === '1';
    if (demo || realSelected) {
      AppEnv.config.set('core.workspace.mode', 'split');
      AppEnv.config.set('core.messageListSidebar.panel', 'ai-sidebar');
      console.log(
        demo
          ? '[Demo Mode] AISidebar registered (MessageListSidebar:Panel, syncInit)'
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
