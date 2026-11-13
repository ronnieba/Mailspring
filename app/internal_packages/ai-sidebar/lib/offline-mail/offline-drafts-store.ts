/**
 * Offline experiment: local drafts state (renderer).
 *
 * Drafts are saved only in the offline profile (offline-drafts.json in the
 * config dir). There is deliberately no send method here or anywhere in the
 * drafts code. "Proofread with Gemini" sends only the open draft's text, and
 * only when the user clicks it.
 */
import {
  ENGLISH_DRAFT_LABELS,
  HEBREW_DRAFT_LABELS,
  OFFLINE_PROOFREAD_MAX_CHARS,
  OfflineDraft,
  OfflineDraftSource,
  makeForwardDraft,
  makeNewDraft,
  makeReplyDraft,
  readDrafts,
  removeDraft,
  upsertDraft,
  writeDrafts,
} from '../core/offline-drafts';
import {
  ProofSegment,
  applyProofDecisions,
  buildProofSegments,
  proofChanges,
} from '../core/text-diff';
import { offlineLang, tr } from '../core/offline-i18n';
import {
  applyProofToHtml,
  htmlToPlain,
  plainToHtml,
  sanitizeDraftHtml,
} from '../core/offline-rich-text';

type Listener = () => void;

export type ProofStatus = 'idle' | 'running' | 'review' | 'error';

export interface ProofState {
  status: ProofStatus;
  draftId: string | null;
  /** Draft text that was sent, to detect edits made while reviewing. */
  original: string;
  segments: ProofSegment[];
  /** change id → true (accept) / false (reject). Undecided = keep original. */
  decisions: Map<number, boolean>;
  error: string | null;
}

/** Sends one draft text to Gemini; injected so tests never touch IPC. */
export type ProofreadTransport = (
  generation: number,
  text: string
) => Promise<{ ok: boolean; payload?: { response: string }; message?: string }>;

const IDLE_PROOF = (): ProofState => ({
  status: 'idle',
  draftId: null,
  original: '',
  segments: [],
  decisions: new Map(),
  error: null,
});

export class OfflineDraftsStore {
  drafts: OfflineDraft[] = [];
  /** Drafts list shown in the message-list column instead of a folder. */
  showing = false;
  openId: string | null = null;
  savedAt: number | null = null;
  saveError: string | null = null;
  proof: ProofState = IDLE_PROOF();
  /** Bumped when the body changes from outside the editor (proof applied). */
  contentRev = 0;
  /** Shown after applying proofreading when some changes could not be applied safely. */
  proofNotice: string | null = null;

  private _dir: string | null = null;
  private _listeners = new Set<Listener>();
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _generation = 0;
  private _transport: ProofreadTransport | null = null;
  private _afterProofread: (() => void) | null = null;
  private _now: () => number = () => Date.now();

  configure(opts: {
    configDir: string;
    transport?: ProofreadTransport;
    afterProofread?: () => void;
    now?: () => number;
  }) {
    this._dir = opts.configDir;
    this._transport = opts.transport || null;
    this._afterProofread = opts.afterProofread || null;
    if (opts.now) {
      this._now = opts.now;
    }
    this.drafts = readDrafts(opts.configDir);
    this._emit();
  }

  listen(cb: Listener): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (err) {
        console.error('[Offline drafts] listener failed', err);
      }
    }
  }

  get count(): number {
    return this.drafts.length;
  }

  get open(): OfflineDraft | null {
    return this.openId ? this.drafts.find((d) => d.id === this.openId) || null : null;
  }

  showList() {
    this.showing = true;
    this._emit();
  }

  /** Back to the mail folders (a folder was clicked). */
  hide() {
    this.flush();
    if (!this.showing && !this.openId) {
      return;
    }
    this.showing = false;
    this.openId = null;
    this.proof = IDLE_PROOF();
    this._emit();
  }

  openDraft(id: string) {
    this.flush();
    this.showing = true;
    this.openId = id;
    this.proofNotice = null;
    if (this.proof.draftId !== id) {
      this.proof = IDLE_PROOF();
    }
    this._emit();
  }

  closeDraft() {
    this.flush();
    this.openId = null;
    this.proof = IDLE_PROOF();
    this._emit();
  }

  private _labels() {
    return offlineLang() === 'en' ? ENGLISH_DRAFT_LABELS : HEBREW_DRAFT_LABELS;
  }

  private _add(d: OfflineDraft): OfflineDraft {
    this.drafts = upsertDraft(this.drafts, d);
    this._persist();
    this.openDraft(d.id);
    return d;
  }

  createNew(): OfflineDraft {
    return this._add(makeNewDraft(this._now()));
  }

  createReply(src: OfflineDraftSource): OfflineDraft {
    return this._add(makeReplyDraft(src, this._now(), this._labels()));
  }

  createForward(src: OfflineDraftSource): OfflineDraft {
    return this._add(makeForwardDraft(src, this._now(), this._labels()));
  }

  update(
    id: string,
    patch: Partial<Pick<OfflineDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'html'>>
  ) {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) {
      return;
    }
    const next: OfflineDraft = { ...d, ...patch, updatedAt: this._now() };
    if (typeof patch.html === 'string') {
      // Formatted editor: keep sanitized HTML, derive the plain copy from it.
      next.html = sanitizeDraftHtml(patch.html);
      next.body = htmlToPlain(next.html);
    } else if (typeof patch.body === 'string') {
      next.html = plainToHtml(patch.body);
    }
    // Keep the list order stable while typing; it is re-sorted on save.
    this.drafts = this.drafts.map((x) => (x.id === id ? next : x));
    this._scheduleSave();
    this._emit();
  }

  delete(id: string) {
    this.drafts = removeDraft(this.drafts, id);
    if (this.openId === id) {
      this.openId = null;
      this.proof = IDLE_PROOF();
    }
    this._persist();
    this._emit();
  }

  private _scheduleSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._persist();
      this._emit();
    }, 500);
  }

  /** Write pending edits now (closing, switching drafts, quitting). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._persist();
    }
  }

  private _persist() {
    if (!this._dir) {
      this.saveError = tr('אין תיקיית פרופיל', 'No profile folder');
      return;
    }
    try {
      writeDrafts(this._dir, this.drafts);
      this.savedAt = this._now();
      this.saveError = null;
    } catch (err) {
      this.saveError = String((err as Error).message || err);
    }
  }

  // ---- Proofreading with Gemini (explicit click only) ----

  async proofread(id: string): Promise<void> {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) {
      return;
    }
    const text = d.body;
    if (!text.trim()) {
      this.proof = {
        ...IDLE_PROOF(),
        status: 'error',
        draftId: id,
        error: tr('אין טקסט להגהה.', 'There is no text to proofread.'),
      };
      this._emit();
      return;
    }
    if (text.length > OFFLINE_PROOFREAD_MAX_CHARS) {
      this.proof = {
        ...IDLE_PROOF(),
        status: 'error',
        draftId: id,
        error: tr(
          `הטיוטה ארוכה מדי להגהה (עד ${OFFLINE_PROOFREAD_MAX_CHARS.toLocaleString()} תווים).`,
          `The draft is too long to proofread (max ${OFFLINE_PROOFREAD_MAX_CHARS.toLocaleString()} characters).`
        ),
      };
      this._emit();
      return;
    }
    if (!this._transport) {
      this.proof = {
        ...IDLE_PROOF(),
        status: 'error',
        draftId: id,
        error: tr('Gemini לא זמין כאן.', 'Gemini is not available here.'),
      };
      this._emit();
      return;
    }
    this.proofNotice = null;
    const generation = ++this._generation;
    this.proof = { ...IDLE_PROOF(), status: 'running', draftId: id, original: text };
    this._emit();
    let res: Awaited<ReturnType<ProofreadTransport>>;
    try {
      res = await this._transport(generation, text);
    } catch (err) {
      res = { ok: false, message: String((err as Error).message || err) };
    }
    if (generation !== this._generation || this.proof.draftId !== id) {
      return; // superseded or closed
    }
    if (this._afterProofread) {
      this._afterProofread();
    }
    if (!res.ok || !res.payload || typeof res.payload.response !== 'string') {
      this.proof = {
        ...IDLE_PROOF(),
        status: 'error',
        draftId: id,
        error: res.message || tr('ההגהה נכשלה.', 'Proofreading failed.'),
      };
      this._emit();
      return;
    }
    const corrected = res.payload.response.replace(/\r\n/g, '\n');
    const segments = buildProofSegments(text, corrected);
    this.proof = {
      status: 'review',
      draftId: id,
      original: text,
      segments,
      decisions: new Map(),
      error: null,
    };
    this._emit();
  }

  proofChangeCount(): number {
    return proofChanges(this.proof.segments).length;
  }

  decide(changeId: number, accept: boolean | null) {
    const decisions = new Map(this.proof.decisions);
    if (accept === null) {
      decisions.delete(changeId);
    } else {
      decisions.set(changeId, accept);
    }
    this.proof = { ...this.proof, decisions };
    this._emit();
  }

  decideAll(accept: boolean) {
    const decisions = new Map<number, boolean>();
    for (const c of proofChanges(this.proof.segments)) {
      decisions.set(c.id, accept);
    }
    this.proof = { ...this.proof, decisions };
    this._emit();
  }

  /** Apply accepted changes; rejected and undecided ones keep the original. */
  applyProof(): boolean {
    const d = this.proof.draftId ? this.drafts.find((x) => x.id === this.proof.draftId) : null;
    if (!d || this.proof.status !== 'review') {
      return false;
    }
    if (d.body !== this.proof.original) {
      this.proof = {
        ...this.proof,
        error: tr(
          'הטיוטה השתנתה מאז ההגהה. הרץ הגהה שוב.',
          'The draft changed since proofreading. Run proofreading again.'
        ),
      };
      this._emit();
      return false;
    }
    const accepted = new Set<number>();
    this.proof.decisions.forEach((v, k) => {
      if (v) {
        accepted.add(k);
      }
    });
    let notice: string | null = null;
    if (d.html) {
      // Keep formatting: splice accepted changes into the HTML text.
      const res = applyProofToHtml(d.html, this.proof.segments, accepted);
      this.proof = IDLE_PROOF();
      this.update(d.id, { html: res.html });
      if (res.skipped > 0) {
        notice = tr(
          `${res.skipped} תיקונים לא הוחלו כי הם חוצים שורות או פסקאות. העיצוב נשמר.`,
          `${res.skipped} changes were not applied because they cross lines or paragraphs. Formatting was kept.`
        );
      }
    } else {
      const body = applyProofDecisions(this.proof.segments, accepted);
      this.proof = IDLE_PROOF();
      this.update(d.id, { body });
    }
    this.proofNotice = notice;
    this.contentRev++;
    this.flush();
    this._emit();
    return true;
  }

  dismissProofNotice() {
    this.proofNotice = null;
    this._emit();
  }

  discardProof() {
    this._generation++;
    this.proof = IDLE_PROOF();
    this._emit();
  }
}

export const offlineDraftsStore = new OfflineDraftsStore();
