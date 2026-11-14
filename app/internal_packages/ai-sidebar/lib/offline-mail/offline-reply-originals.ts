/**
 * Offline experiment: "Attach the original files" for a local reply draft.
 * Copies the attachments of the message being answered into the draft
 * (inside the offline profile). Nothing is sent; the mail copy is only read.
 */
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { OfflineDraft } from '../core/offline-drafts';
import { OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES } from '../core/offline-attachments';

type Original = { filename: string; contentType: string; size: number; data: Buffer | null };

let cache: { id: string | null; list: Original[] } = { id: null, list: [] };

function originalsOf(sourceId: string): Original[] {
  if (cache.id !== sourceId) {
    let list: Original[] = [];
    try {
      list = offlineMailStore.attachmentData(sourceId).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        data: (a.data as Buffer) || null,
      }));
    } catch (e) {
      console.warn('[Offline drafts] original files not readable');
    }
    cache = { id: sourceId, list };
  }
  return cache.list;
}

const keyOf = (name: string, size: number) => `${name.toLowerCase()}|${size}`;

export type OriginalsInfo = {
  /** Files in the original message. */
  total: number;
  /** Not in the draft yet and small enough to copy. */
  missing: number;
  /** Too large to copy into a draft. */
  tooLarge: number;
};

/** Only for replies started from a local message. */
export function replyOriginalsInfo(d: OfflineDraft | null | undefined): OriginalsInfo | null {
  if (!d || d.kind !== 'reply' || !d.sourceMessageId) {
    return null;
  }
  const entry = offlineMailStore.getEntry(d.sourceMessageId);
  if (!entry || !entry.hasAttachments) {
    return { total: 0, missing: 0, tooLarge: 0 };
  }
  const list = originalsOf(d.sourceMessageId);
  const have = new Set((d.attachments || []).map((a) => keyOf(a.filename, a.size)));
  let missing = 0;
  let tooLarge = 0;
  for (const a of list) {
    if (!a.data || a.size > OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES) {
      tooLarge++;
    } else if (!have.has(keyOf(a.filename, a.data.length))) {
      missing++;
    }
  }
  return { total: list.length, missing, tooLarge };
}

/** Copy the original message's files into the reply draft (skips ones already there). */
export function attachReplyOriginals(d: OfflineDraft): { added: number; skipped: number } {
  if (!d.sourceMessageId) {
    return { added: 0, skipped: 0 };
  }
  const have = new Set((d.attachments || []).map((a) => keyOf(a.filename, a.size)));
  const files = originalsOf(d.sourceMessageId).filter(
    (a) =>
      a.data &&
      a.data.length <= OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES &&
      !have.has(keyOf(a.filename, a.data.length))
  );
  const skipped = originalsOf(d.sourceMessageId).filter(
    (a) => !a.data || a.size > OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES
  ).length;
  const added = offlineDraftsStore.addAttachmentBytes(
    d.id,
    files.map((a) => ({ filename: a.filename, contentType: a.contentType, data: a.data as Buffer }))
  );
  return { added, skipped };
}
