// Offline experiment (t224): which text field the ribbon's Edit buttons act on.
// Ribbon buttons never take the focus (mousedown is cancelled), but keyboard
// users can Tab onto them and some clicks blur the field, so we remember the
// last focused editable field (draft body, subject, To, search box, AI box)
// and its caret/selection, and put the focus back there before acting.

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
]);

export function isEditableElement(el: any): el is HTMLElement {
  if (!el || el.nodeType !== 1) {
    return false;
  }
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea') {
    return !el.disabled;
  }
  if (tag === 'input') {
    return !el.disabled && TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
  }
  return !!el.isContentEditable;
}

function editableRoot(el: any): HTMLElement | null {
  if (!isEditableElement(el)) {
    return null;
  }
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    return el;
  }
  // Outermost contentEditable host (the whole draft body).
  let cur: HTMLElement = el;
  while (cur.parentElement && (cur.parentElement as HTMLElement).isContentEditable) {
    cur = cur.parentElement as HTMLElement;
  }
  return cur;
}

function isRibbon(el: any): boolean {
  return !!(el && el.closest && el.closest('.offline-ribbon'));
}

let lastField: HTMLElement | null = null;
let lastRange: Range | null = null;
// Last field used inside the open draft (subject, To, body…).
let lastDraftField: HTMLElement | null = null;

const DRAFT_EDITOR = '[data-offline-draft-editor]:not([data-offline-draft-editor="none"])';

function inDraftEditor(el: any): boolean {
  return !!(el && el.closest && el.closest(DRAFT_EDITOR));
}

export function rememberedField(): HTMLElement | null {
  return lastField;
}

export function forgetField() {
  lastField = null;
  lastRange = null;
}

/** Track focus in `doc`; returns an uninstall function. */
export function installEditTargetTracker(doc: Document = document): () => void {
  const win = doc.defaultView;
  const onFocusIn = (e: FocusEvent) => {
    const root = editableRoot(e.target);
    if (root) {
      if (root !== lastField) {
        lastRange = null;
      }
      lastField = root;
      if (inDraftEditor(root)) {
        lastDraftField = root;
      }
    } else if (!isRibbon(e.target)) {
      forgetField();
    }
  };
  const onFocusOut = (e: FocusEvent) => {
    if (!editableRoot(e.target) || e.relatedTarget) {
      return;
    }
    // Focus went nowhere: a click on plain content (a message row, the
    // reader) forgets the field; switching to another window keeps it.
    setTimeout(() => {
      const active = doc.activeElement;
      if (doc.hasFocus() && (!active || active === doc.body)) {
        forgetField();
      }
    }, 0);
  };
  const onSelectionChange = () => {
    const active = doc.activeElement as any;
    if (!lastField || !active || !active.isContentEditable) {
      return;
    }
    const sel = doc.getSelection();
    if (sel && sel.rangeCount && lastField.contains(sel.anchorNode)) {
      lastRange = sel.getRangeAt(0).cloneRange();
    }
  };
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('selectionchange', onSelectionChange);
  if (win && isEditableElement(doc.activeElement)) {
    lastField = editableRoot(doc.activeElement);
  }
  return () => {
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('selectionchange', onSelectionChange);
  };
}

function usable(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && isEditableElement(el) && el.getClientRects().length > 0;
}

/** The field the Edit buttons should act on, or null. */
export function editTarget(doc: Document = document): HTMLElement | null {
  const active = editableRoot(doc.activeElement);
  if (active) {
    return active;
  }
  return usable(lastField) ? lastField : null;
}

/** The draft field "Select all text" acts on: the active / last used field
 * of the open draft, otherwise its body. */
export function draftSelectTarget(doc: Document = document): HTMLElement | null {
  const active = editableRoot(doc.activeElement);
  if (active && inDraftEditor(active)) {
    return active;
  }
  if (usable(lastDraftField) && inDraftEditor(lastDraftField)) {
    return lastDraftField;
  }
  const body = doc.querySelector(
    `${DRAFT_EDITOR} [data-offline-draft-field="body"]`
  ) as HTMLElement;
  return usable(body) ? body : null;
}

/** Put the focus back in the field (with its caret/selection) if needed. */
export function focusEditTarget(doc: Document = document): HTMLElement | null {
  const target = editTarget(doc);
  if (!target) {
    return null;
  }
  if (editableRoot(doc.activeElement) !== target) {
    target.focus({ preventScroll: true });
    if (target.isContentEditable && lastRange && target.contains(lastRange.startContainer)) {
      const sel = doc.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(lastRange);
      }
    }
  }
  return target;
}

/** Select all the text in the field. */
export function selectAllInField(el: HTMLElement, doc: Document = document) {
  el.focus({ preventScroll: true });
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    (el as HTMLInputElement).select();
    return;
  }
  const range = doc.createRange();
  range.selectNodeContents(el);
  const sel = doc.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  lastRange = range.cloneRange();
}
