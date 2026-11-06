/**
 * AI Sidebar package entry point.
 * Registers the sidebar panel in the message list sidebar.
 */
import { ComponentRegistry, WorkspaceStore } from 'mailspring-exports';
import AISidebar from './ai-sidebar';

export function activate() {
  // Register as a sidebar panel (appears in the panel switcher)
  ComponentRegistry.register(AISidebar, {
    role: 'MessageListSidebar:Panel',
  });
}

export function deactivate() {
  ComponentRegistry.unregister(AISidebar);
}

export function serialize() {
  return {};
}
