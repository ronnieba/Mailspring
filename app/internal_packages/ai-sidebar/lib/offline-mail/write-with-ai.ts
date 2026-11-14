/**
 * "✍️ Write with AI" entry point shared by the ribbon (AI tab) and the draft
 * editor toolbar: shows the AI panel, switches it to write mode on the open
 * draft (or a new empty draft) and puts the cursor in the instruction box.
 * Nothing is sent to Gemini here - only the panel's "Write" button sends.
 */
import { Actions, WorkspaceStore } from 'mailspring-exports';
import AISidebarStore from '../ai-sidebar-store';
import { offlineDraftsStore } from './offline-drafts-store';

/** Undo of the last AI change from the draft editor (keeps the AI conversation in sync). */
export function undoAiChange(): boolean {
  if (offlineDraftsStore.undoAi()) {
    AISidebarStore.markDraftTurnUndone();
    return true;
  }
  return false;
}

export function startWriteWithAi(): void {
  const loc = WorkspaceStore.Location.MessageListSidebar;
  if (loc && WorkspaceStore.isLocationHidden(loc)) {
    Actions.toggleWorkspaceLocationHidden(loc);
  }
  void AISidebarStore.startWriteWithAi().then(() => {
    window.setTimeout(() => {
      const ta = document.querySelector('.ai-sidebar textarea') as HTMLElement | null;
      if (ta) {
        ta.focus();
      }
    }, 120);
  });
}
