/**
 * Offline experiment (t233): local voice with Whisper.
 * - A green mic button next to text fields (draft body, subject, To/Cc/Bcc,
 *   search box, AI box): click to record, click again to stop; the words are
 *   typed in at the cursor.
 * - Voice commands (ribbon / AI panel mic, Ctrl+Shift+Space): "פתח טיוטה
 *   חדשה", "חפש …", "עבור לתיקייה …", "מחק", "ארכיון", "סמן בכוכב",
 *   "תענה ש…" (fills the AI box; Gemini still only on the user's click).
 * Audio stays on this PC: it is recorded with the normal Windows microphone
 * permission, written to a temp WAV, transcribed by the local whisper-cli and
 * deleted. Commands are parsed by local rules, never by Gemini.
 */
import React from 'react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tr, offlineLang } from '../core/offline-i18n';
import {
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  VoiceCommand,
  WhisperSetup,
  acceptDetectedLang,
  applySpokenPunctuation,
  decodeWav,
  encodeWav16,
  findWhisper,
  matchFolder,
  parseVoiceCommand,
  parseWhisperJson,
  splitOnSilence,
  whisperArgs,
  whisperJsonPathCandidates,
} from '../core/offline-voice';

type Listener = () => void;
type Target = HTMLElement | 'command';
type SavedSel = { start: number; end: number } | Range | null;

export type VoiceHud = null | {
  kind: 'info' | 'ok' | 'warn';
  text: string;
  detail?: string;
  action?: { label: string; run: () => void };
};

/** Tests can swap the microphone (fake stream) or watch runs. */
export const offlineVoiceHooks: {
  getStream: (() => Promise<MediaStream>) | null;
  lastRun: { ms: number; parts: number; langs: string[]; text: string; audioSec: number } | null;
  runs: number;
} = { getStream: null, lastRun: null, runs: 0 };

let setupCache: WhisperSetup | null | undefined;

export function whisperSetup(refresh = false): WhisperSetup | null {
  if (setupCache === undefined || refresh) {
    try {
      setupCache = findWhisper();
    } catch {
      setupCache = null;
    }
  }
  return setupCache;
}

function threads(): number {
  const n = (os.cpus() || []).length || 4;
  return Math.max(2, Math.min(16, Math.floor(n * 0.66)));
}

function uiLangCode(): string {
  return offlineLang() === 'en' ? 'en' : 'he';
}

function runCli(cli: string, args: string[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = require('child_process');
  return new Promise((resolve, reject) => {
    cp.execFile(
      cli,
      args,
      { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err: any) => (err ? reject(err) : resolve())
    );
  });
}

function readJsonFor(wav: string): { text: string; lang: string } {
  for (const p of whisperJsonPathCandidates(wav)) {
    try {
      return parseWhisperJson(fs.readFileSync(p, 'utf8'));
    } catch {
      // try the next name
    }
  }
  return { text: '', lang: '' };
}

/**
 * Transcribe locally: split at pauses, guess each part's language (Hebrew /
 * English), redo parts guessed as another language in the UI language.
 */
export async function transcribeSamples(
  samples: Float32Array,
  opts: { lang?: string; split?: boolean } = {}
): Promise<{ text: string; langs: string[]; ms: number; parts: number }> {
  const setup = whisperSetup();
  if (!setup) throw new Error('whisper-missing');
  const t0 = Date.now();
  const ranges =
    opts.split === false ? [[0, samples.length] as [number, number]] : splitOnSilence(samples);
  if (!ranges.length) return { text: '', langs: [], ms: Date.now() - t0, parts: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailai-voice-'));
  try {
    const files = ranges.map(([a, b], i) => {
      const f = path.join(dir, `part${i}.wav`);
      fs.writeFileSync(f, encodeWav16(samples.subarray(a, b)));
      return f;
    });
    const longest = Math.max(...ranges.map(([a, b]) => (b - a) / VOICE_SAMPLE_RATE));
    const lang = opts.lang || 'auto';
    await runCli(
      setup.cli,
      whisperArgs({ model: setup.model, files, lang, threads: threads(), longestSec: longest })
    );
    const out = files.map(readJsonFor);
    if (lang === 'auto') {
      const redo = files.filter((_, i) => out[i].text && !acceptDetectedLang(out[i].lang));
      if (redo.length) {
        for (const f of redo)
          for (const p of whisperJsonPathCandidates(f)) fs.rmSync(p, { force: true });
        const fb = uiLangCode();
        await runCli(
          setup.cli,
          whisperArgs({
            model: setup.model,
            files: redo,
            lang: fb,
            threads: threads(),
            longestSec: longest,
          })
        );
        files.forEach((f, i) => {
          if (redo.includes(f)) out[i] = { ...readJsonFor(f), lang: fb };
        });
      }
    }
    const text = out
      .map((o) => o.text)
      .filter(Boolean)
      .join(' ')
      .trim();
    return { text, langs: out.map((o) => o.lang), ms: Date.now() - t0, parts: files.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Tests / benchmarks: transcribe a WAV file the same way as a recording. */
export async function transcribeWavFile(file: string) {
  const s = decodeWav(fs.readFileSync(file));
  const r = await transcribeSamples(s);
  return { ...r, audioSec: Math.round((s.length / VOICE_SAMPLE_RATE) * 10) / 10 };
}

// ---- Typing the words in ---------------------------------------------------

function saveSelection(el: HTMLElement): SavedSel {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const i = el as HTMLInputElement;
    return { start: i.selectionStart ?? i.value.length, end: i.selectionEnd ?? i.value.length };
  }
  const sel = document.getSelection();
  if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    return sel.getRangeAt(0).cloneRange();
  }
  return null;
}

/** Type `text` into the field at the remembered cursor (React sees a normal input). */
export function insertAtCaret(el: HTMLElement, text: string, saved: SavedSel) {
  if (!text) return;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const i = el as HTMLInputElement | HTMLTextAreaElement;
    const v = i.value;
    const pos = saved && !(saved instanceof Range) ? saved : { start: v.length, end: v.length };
    const before = v.slice(0, pos.start);
    const after = v.slice(pos.end);
    const single = tag === 'input';
    let t = single ? text.replace(/\s*\n\s*/g, ' ') : text;
    if (before && !/\s$/.test(before)) t = ` ${t}`;
    if (after && !/^\s/.test(after)) t = `${t} `;
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(i, before + t + after);
    else i.value = before + t + after;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.focus();
    const caret = before.length + t.length;
    try {
      i.setSelectionRange(caret, caret);
    } catch {
      // some input types have no selection
    }
    return;
  }
  // contentEditable (draft body)
  el.focus();
  const sel = document.getSelection();
  if (sel) {
    sel.removeAllRanges();
    if (saved instanceof Range && el.contains(saved.commonAncestorContainer)) {
      sel.addRange(saved);
    } else {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.addRange(r);
    }
  }
  const prev = (() => {
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!r || r.startContainer.nodeType !== 3) return '';
    return (r.startContainer.textContent || '').slice(0, r.startOffset);
  })();
  const t = prev && !/\s$/.test(prev) ? ` ${text}` : text;
  const lines = t.split('\n');
  lines.forEach((line, k) => {
    if (k > 0) document.execCommand('insertLineBreak');
    if (line) document.execCommand('insertText', false, line);
  });
}

// ---- Recorder store --------------------------------------------------------

class OfflineVoice {
  state: 'idle' | 'starting' | 'recording' | 'transcribing' = 'idle';
  mode: 'dictate' | 'command' | null = null;
  target: HTMLElement | null = null;
  partial = '';
  level = 0;
  startedAt = 0;
  hud: VoiceHud = null;
  private _sel: SavedSel = null;
  private _chunks: Float32Array[] = [];
  private _len = 0;
  private _stream: MediaStream | null = null;
  private _ctx: AudioContext | null = null;
  private _node: ScriptProcessorNode | null = null;
  private _partialTimer: any = null;
  private _partialBusy = false;
  private _partialOff = false;
  private _hudTimer: any = null;
  private _maxTimer: any = null;
  private _listeners = new Set<Listener>();
  private _cancelled = false;

  listen(cb: Listener) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit() {
    this._listeners.forEach((l) => l());
  }

  get available(): boolean {
    return !!whisperSetup();
  }

  isActiveFor(t: Target): boolean {
    if (this.state === 'idle') return false;
    return t === 'command' ? this.mode === 'command' : this.target === t;
  }

  showHud(h: VoiceHud, ms = 4500) {
    this.hud = h;
    if (this._hudTimer) clearTimeout(this._hudTimer);
    this._hudTimer = h && ms > 0 ? setTimeout(() => this.showHud(null, 0), ms) : null;
    this._emit();
  }

  toggle(t: Target) {
    if (this.state === 'recording') {
      const same = this.isActiveFor(t);
      void this.stop();
      if (same) return;
      return;
    }
    if (this.state !== 'idle') return;
    void this.start(t);
  }

  async start(t: Target) {
    if (this.state !== 'idle') return;
    if (!this.available) {
      this.showHud({
        kind: 'warn',
        text: tr('Whisper המקומי לא נמצא', 'Local Whisper not found'),
        detail: tr(
          'צריך את whisper-cli ומודל בתיקייה MailAI-Whisper.',
          'whisper-cli and a model are needed in the MailAI-Whisper folder.'
        ),
      });
      return;
    }
    this.mode = t === 'command' ? 'command' : 'dictate';
    this.target = t === 'command' ? null : t;
    this._sel = t === 'command' ? null : saveSelection(t);
    this._chunks = [];
    this._len = 0;
    this.partial = '';
    this._partialOff = false;
    this._cancelled = false;
    this.state = 'starting';
    this.showHud(null, 0);
    try {
      const stream = offlineVoiceHooks.getStream
        ? await offlineVoiceHooks.getStream()
        : await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
      if (this.state !== 'starting') {
        stream.getTracks().forEach((x) => x.stop());
        return;
      }
      this._stream = stream;
      const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      this._ctx = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      this._node = node;
      node.onaudioprocess = (e) => {
        if (this.state !== 'recording') return;
        const d = e.inputBuffer.getChannelData(0);
        this._chunks.push(new Float32Array(d));
        this._len += d.length;
        let peak = 0;
        for (let i = 0; i < d.length; i += 16) peak = Math.max(peak, Math.abs(d[i]));
        this.level = Math.min(1, peak * 1.6);
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      this.state = 'recording';
      this.startedAt = Date.now();
      this._partialTimer = setInterval(() => {
        this._emit();
        void this._partialTick();
      }, 2500);
      this._maxTimer = setTimeout(() => void this.stop(), VOICE_MAX_SECONDS * 1000);
      this._emit();
    } catch (err) {
      this._teardown();
      this.state = 'idle';
      const name = (err as any)?.name || '';
      this.showHud(
        {
          kind: 'warn',
          text:
            name === 'NotAllowedError'
              ? tr('אין גישה למיקרופון', 'No access to the microphone')
              : tr('לא הצלחתי להתחיל להקליט', 'Could not start recording'),
          detail:
            name === 'NotAllowedError'
              ? tr(
                  'אפשר לאשר ב-Windows: הגדרות ← פרטיות ← מיקרופון ← "אפשר לאפליקציות שולחן עבודה".',
                  'Allow it in Windows: Settings → Privacy → Microphone → "Let desktop apps access your microphone".'
                )
              : name === 'NotFoundError'
                ? tr('לא נמצא מיקרופון.', 'No microphone found.')
                : String((err as Error)?.message || name),
        },
        9000
      );
    }
  }

  private _samples(maxSec = 0): Float32Array {
    const out = new Float32Array(this._len);
    let o = 0;
    for (const c of this._chunks) {
      out.set(c, o);
      o += c.length;
    }
    if (maxSec > 0 && out.length > maxSec * VOICE_SAMPLE_RATE)
      return out.subarray(out.length - maxSec * VOICE_SAMPLE_RATE);
    return out;
  }

  /** Live text while recording (whole recording so far, one language). */
  private async _partialTick() {
    if (this.state !== 'recording' || this._partialBusy || this._partialOff) return;
    if (this._len < VOICE_SAMPLE_RATE * 1.2) return;
    this._partialBusy = true;
    const t0 = Date.now();
    try {
      const r = await transcribeSamples(this._samples(25), { lang: uiLangCode(), split: false });
      if (this.state === 'recording') {
        this.partial = r.text;
        this._emit();
      }
    } catch {
      this._partialOff = true;
    } finally {
      this._partialBusy = false;
      // Too slow on this PC for live text: show it only at the end.
      if (Date.now() - t0 > 4500) this._partialOff = true;
    }
  }

  private _teardown() {
    if (this._partialTimer) clearInterval(this._partialTimer);
    if (this._maxTimer) clearTimeout(this._maxTimer);
    this._partialTimer = null;
    this._maxTimer = null;
    if (this._node) {
      this._node.onaudioprocess = null;
      try {
        this._node.disconnect();
      } catch {
        // already gone
      }
    }
    if (this._stream) this._stream.getTracks().forEach((x) => x.stop());
    if (this._ctx) void this._ctx.close().catch(() => undefined);
    this._node = null;
    this._stream = null;
    this._ctx = null;
    this.level = 0;
  }

  cancel() {
    if (this.state === 'idle') return;
    this._cancelled = true;
    this._teardown();
    this.state = 'idle';
    this.mode = null;
    this.target = null;
    this.partial = '';
    this.showHud({ kind: 'info', text: tr('ההקלטה בוטלה', 'Recording cancelled') }, 2500);
  }

  async stop() {
    if (this.state === 'starting') {
      this.cancel();
      return;
    }
    if (this.state !== 'recording') return;
    const samples = this._samples();
    const mode = this.mode;
    const target = this.target;
    const sel = this._sel;
    this._teardown();
    this.state = 'transcribing';
    this._emit();
    const audioSec = samples.length / VOICE_SAMPLE_RATE;
    try {
      // Wait for a live-text run to finish (one whisper at a time).
      for (let i = 0; i < 100 && this._partialBusy; i++)
        await new Promise((r) => setTimeout(r, 50));
      let r: { text: string; langs: string[]; ms: number; parts: number };
      let cmd: VoiceCommand | null = null;
      if (mode === 'command') {
        // Commands are short and in Hebrew or English: the UI language first
        // (no detection pass, ~2x faster), the other one if it isn't a command.
        const first = uiLangCode();
        r = await transcribeSamples(samples, { lang: first, split: false });
        cmd = parseVoiceCommand(r.text);
        if (cmd.kind === 'unknown') {
          const r2 = await transcribeSamples(samples, {
            lang: first === 'he' ? 'en' : 'he',
            split: false,
          });
          const c2 = parseVoiceCommand(r2.text);
          if (c2.kind !== 'unknown') {
            r = { ...r2, ms: r.ms + r2.ms };
            cmd = c2;
          } else {
            r = { ...r, ms: r.ms + r2.ms };
          }
        }
      } else {
        r = await transcribeSamples(samples);
      }
      offlineVoiceHooks.runs++;
      offlineVoiceHooks.lastRun = {
        ms: r.ms,
        parts: r.parts,
        langs: r.langs,
        text: r.text,
        audioSec: Math.round(audioSec * 10) / 10,
      };
      if (this._cancelled) return;
      this.state = 'idle';
      this.mode = null;
      this.target = null;
      this.partial = '';
      if (!r.text) {
        this.showHud({ kind: 'warn', text: tr('לא נשמע דיבור', 'No speech heard') }, 3500);
        return;
      }
      if (mode === 'command') {
        runVoiceCommand(cmd || parseVoiceCommand(r.text), r.text);
      } else if (target && document.contains(target)) {
        insertAtCaret(target, applySpokenPunctuation(r.text), sel);
        this.showHud(
          {
            kind: 'ok',
            text: tr('✓ נוסף', '✓ Added'),
            detail: `${(r.ms / 1000).toFixed(1)}s · ${whisperSetup()?.modelName || ''}`,
          },
          2200
        );
      }
    } catch (err) {
      this.state = 'idle';
      this.mode = null;
      this.target = null;
      this.showHud(
        {
          kind: 'warn',
          text: tr('התמלול המקומי נכשל', 'Local transcription failed'),
          detail: String((err as Error)?.message || err).slice(0, 160),
        },
        8000
      );
    }
  }
}

export const offlineVoice = new OfflineVoice();

// ---- Voice commands ---------------------------------------------------------

function lazy<T = any>(m: string): T {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(m);
}

function currentMessage(): { id: string; parsed: any } | null {
  const s = lazy('./offline-mail-store').offlineMailStore;
  if (s.openMessage && s.openMessage.parsed)
    return { id: s.openMessage.id, parsed: s.openMessage.parsed };
  const t = s.openThread;
  if (t) {
    for (let i = t.ids.length - 1; i >= 0; i--) {
      if (t.parsed[t.ids[i]]) return { id: t.ids[i], parsed: t.parsed[t.ids[i]] };
    }
  }
  return null;
}

function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto =
    el.tagName.toLowerCase() === 'input'
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function folderChoices() {
  const store = lazy('./offline-mail-store').offlineMailStore;
  const roles = lazy('../core/offline-folder-roles');
  const ROLE_WORDS: { [r: string]: string[] } = {
    inbox: ['inbox', 'דואר נכנס', 'נכנס', 'תיבת דואר'],
    sent: ['sent', 'נשלחו', 'דואר יוצא', 'יוצא', 'שנשלחו'],
    drafts: ['drafts', 'טיוטות'],
    archive: ['archive', 'ארכיון'],
    spam: ['spam', 'ספאם', 'דואר זבל', 'זבל'],
    trash: ['trash', 'אשפה', 'פח'],
  };
  return store.allFolderNodes().map((n: any) => {
    const role = roles.offlineFolderRole(n.name, n.depth);
    return {
      path: n.path,
      names: [n.name, n.displayPath, ...(role ? ROLE_WORDS[role] || [] : [])],
    };
  });
}

/** Do what a voice command says, locally. Nothing is sent to Gemini. */
export function runVoiceCommand(cmd: VoiceCommand, heard: string) {
  const v = offlineVoice;
  const said = `«${heard}»`;
  const needMsg = () =>
    v.showHud(
      { kind: 'warn', text: tr('בחרו הודעה קודם', 'Select a message first'), detail: said },
      5000
    );
  const drafts = () => lazy('./offline-drafts-store').offlineDraftsStore;
  switch (cmd.kind) {
    case 'new-draft':
      drafts().createNew();
      v.showHud({
        kind: 'ok',
        text: tr('📝 נפתחה טיוטה חדשה', '📝 New draft opened'),
        detail: said,
      });
      return;
    case 'search':
    case 'ask': {
      const q = cmd.kind === 'search' ? cmd.query : cmd.question;
      if (drafts().showing) drafts().hide();
      lazy('./offline-search-store').offlineSearchStore.setQuery(q);
      setTimeout(() => {
        const i = document.querySelector('[data-offline-search-input]') as HTMLInputElement | null;
        if (i) i.focus();
      }, 50);
      v.showHud(
        {
          kind: 'ok',
          text:
            cmd.kind === 'search'
              ? tr(`🔍 חיפוש: ${q}`, `🔍 Search: ${q}`)
              : tr(`❓ השאלה בתיבת החיפוש`, `❓ The question is in the search box`),
          detail:
            cmd.kind === 'ask'
              ? tr(
                  'לחצו "שאל AI" כדי לקבל תשובה (בתשלום, רק בלחיצה).',
                  'Click "Ask AI" for an answer (paid, only on click).'
                )
              : said,
        },
        6000
      );
      return;
    }
    case 'folder': {
      const p = matchFolder(cmd.name, folderChoices());
      if (!p) {
        v.showHud(
          {
            kind: 'warn',
            text: tr('לא מצאתי תיקייה בשם הזה', 'No folder with that name'),
            detail: said,
          },
          5000
        );
        return;
      }
      if (drafts().showing) drafts().hide();
      const s = lazy('./offline-search-store').offlineSearchStore;
      if (s.query) s.clear();
      const store = lazy('./offline-mail-store').offlineMailStore;
      store.setFolder(p);
      v.showHud({
        kind: 'ok',
        text: tr(`📁 ${store.folderLabel(p)}`, `📁 ${store.folderLabel(p)}`),
        detail: said,
      });
      return;
    }
    case 'delete':
    case 'archive':
    case 'star':
    case 'unread': {
      const store = lazy('./offline-mail-store').offlineMailStore;
      if (!store.selectedIds.length && !currentMessage()) return needMsg();
      const a = lazy('./offline-message-actions');
      if (cmd.kind === 'delete') a.actDelete();
      else if (cmd.kind === 'archive') a.actArchive();
      else if (cmd.kind === 'star') a.actToggleStar();
      else a.actSetUnread(true);
      const label = {
        delete: tr('🗑️ נמחק (מקומית, אפשר לבטל)', '🗑️ Deleted (locally, can be undone)'),
        archive: tr('🗄️ הועבר לארכיון (מקומית)', '🗄️ Archived (locally)'),
        star: tr('⭐ כוכב', '⭐ Star'),
        unread: tr('✉️ סומן כלא נקרא', '✉️ Marked unread'),
      }[cmd.kind];
      v.showHud({ kind: 'ok', text: label, detail: said });
      return;
    }
    case 'reply': {
      const msg = currentMessage();
      if (!msg) return needMsg();
      const p = msg.parsed;
      drafts().createReply({
        id: msg.id,
        subject: p.subject,
        from: p.from,
        to: p.to,
        cc: p.cc,
        date: p.date,
        text: p.text,
      });
      const ai = lazy('./write-with-ai');
      ai.startWriteWithAi();
      const fill = (tries: number) => {
        const ta = document.querySelector('#ai-sidebar-question') as HTMLTextAreaElement | null;
        if (ta && !ta.disabled) {
          setFieldValue(ta, cmd.instruction);
          ta.focus();
        } else if (tries > 0) {
          setTimeout(() => fill(tries - 1), 150);
        }
      };
      setTimeout(() => fill(20), 200);
      v.showHud(
        {
          kind: 'ok',
          text: tr('✍️ ההוראה בתיבת ה-AI', '✍️ The instruction is in the AI box'),
          detail: tr(
            'נפתחה טיוטת תשובה. לחצו "שלח" בחלונית ה-AI כדי ש-Gemini יכתוב (בתשלום, רק בלחיצה).',
            'A reply draft is open. Click "Send" in the AI panel to have Gemini write it (paid, only on click).'
          ),
        },
        8000
      );
      return;
    }
    case 'help':
      lazy('./offline-tour').startOfflineTour();
      return;
    default:
      v.showHud(
        {
          kind: 'warn',
          text: tr('לא זיהיתי פקודה', 'Not a command I know'),
          detail: said,
          action: {
            label: tr('🔍 חפש את זה', '🔍 Search for it'),
            run: () =>
              runVoiceCommand({ kind: 'search', query: heard.replace(/[.!?]+$/, '') }, heard),
          },
        },
        8000
      );
  }
}

/** Ctrl+Shift+Space: voice command; Esc while recording: cancel. */
export function installVoiceShortcuts(win: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      offlineVoice.toggle('command');
    } else if (e.key === 'Escape' && offlineVoice.state === 'recording') {
      e.preventDefault();
      e.stopPropagation();
      offlineVoice.cancel();
    }
  };
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}

// ---- UI ---------------------------------------------------------------------

function MicIcon(props: { size?: number }) {
  const s = props.size || 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 18v3.5M8.5 21.5h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

type MicProps = {
  /** CSS selector of the field, looked up inside `scope` (or the button's parent). */
  target?: string;
  scope?: string;
  /** Voice command instead of dictation. */
  command?: boolean;
  label?: string;
  size?: 'small' | 'normal';
};

/** Green round mic: click to talk, click again to stop. Hidden when Whisper isn't installed. */
export class OfflineMic extends React.Component<MicProps, { tick: number }> {
  static displayName = 'OfflineMic';
  state = { tick: 0 };
  private _un: (() => void) | null = null;
  private _btn = React.createRef<HTMLButtonElement>();

  componentDidMount() {
    this._un = offlineVoice.listen(() => this.setState({ tick: this.state.tick + 1 }));
  }

  componentWillUnmount() {
    if (this._un) this._un();
  }

  _field(): HTMLElement | null {
    const b = this._btn.current;
    if (!b || !this.props.target) return null;
    const scope =
      (this.props.scope && (b.closest(this.props.scope) as HTMLElement)) || b.parentElement;
    return ((scope && scope.querySelector(this.props.target)) ||
      document.querySelector(this.props.target)) as HTMLElement | null;
  }

  _target(): Target | null {
    return this.props.command ? 'command' : this._field();
  }

  render() {
    if (!offlineVoice.available) return null;
    const v = offlineVoice;
    const t = this._btn.current ? this._target() : null;
    const active = !!t && v.isActiveFor(t);
    const rec = active && v.state === 'recording';
    const busy = active && (v.state === 'transcribing' || v.state === 'starting');
    const title = this.props.command
      ? tr(
          'פקודה קולית (Ctrl+Shift+Space): למשל "פתח טיוטה חדשה", "חפש חשבונית", "עבור לתיקייה דואר נכנס", "מחק", "ארכיון", "סמן בכוכב", "תענה ש…". מזוהה מקומית ב-Whisper; שום הקלטה לא יוצאת מהמחשב.',
          'Voice command (Ctrl+Shift+Space): e.g. "new draft", "search invoice", "go to folder inbox", "delete", "archive", "star", "reply that…". Recognized locally by Whisper; no audio leaves the PC.'
        )
      : tr(
          'הכתבה: לחצו, דברו (עברית או אנגלית), ולחצו שוב — הטקסט נכתב במקום הסמן. מזוהה מקומית ב-Whisper; ההקלטה לא יוצאת מהמחשב. "פסיק", "נקודה", "סימן שאלה", "שורה חדשה" הופכים לסימנים.',
          'Dictation: click, speak (Hebrew or English), click again — the text goes in at the cursor. Recognized locally by Whisper; the audio never leaves the PC. Say "comma", "period", "question mark", "new line" for punctuation.'
        );
    return (
      <button
        type="button"
        ref={this._btn}
        className={`offline-mic${rec ? ' recording' : ''}${busy ? ' busy' : ''}${this.props.size === 'small' ? ' small' : ''}${this.props.command ? ' command' : ''}`}
        data-offline-mic={this.props.command ? 'command' : this.props.target || 'field'}
        data-offline-mic-state={rec ? 'recording' : busy ? 'busy' : 'idle'}
        aria-pressed={rec}
        aria-label={
          this.props.label ||
          (this.props.command ? tr('פקודה קולית', 'Voice command') : tr('הכתבה', 'Dictate'))
        }
        title={
          rec
            ? tr('מקליט… לחצו לעצירה (Esc לביטול)', 'Recording… click to stop (Esc to cancel)')
            : title
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const target = this._target();
          if (target) v.toggle(target);
        }}
      >
        <MicIcon size={this.props.size === 'small' ? 12 : 15} />
      </button>
    );
  }
}

/** Status card at the bottom of the window: recording, live text, results. */
export class OfflineVoiceHud extends React.Component<Record<string, never>, { tick: number }> {
  static displayName = 'OfflineVoiceHud';
  state = { tick: 0 };
  private _un: (() => void) | null = null;
  private _unKeys: (() => void) | null = null;
  private _raf: any = null;

  componentDidMount() {
    this._un = offlineVoice.listen(() => this.setState({ tick: this.state.tick + 1 }));
    this._unKeys = installVoiceShortcuts();
    this._raf = setInterval(
      () => offlineVoice.state === 'recording' && this.setState({ tick: this.state.tick + 1 }),
      200
    );
  }

  componentWillUnmount() {
    if (this._un) this._un();
    if (this._unKeys) this._unKeys();
    clearInterval(this._raf);
  }

  render() {
    const v = offlineVoice;
    if (v.state === 'idle' && !v.hud) return null;
    if (v.state === 'idle' && v.hud) {
      const h = v.hud;
      return (
        <div
          className={`offline-voice-hud ${h.kind}`}
          data-offline-voice-hud={h.kind}
          role="status"
          dir="auto"
        >
          <div className="offline-voice-hud-text">{h.text}</div>
          {h.detail ? (
            <div className="offline-voice-hud-detail" dir="auto">
              {h.detail}
            </div>
          ) : null}
          {h.action ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                v.showHud(null, 0);
                h.action!.run();
              }}
            >
              {h.action.label}
            </button>
          ) : null}
        </div>
      );
    }
    const sec = v.state === 'recording' ? Math.floor((Date.now() - v.startedAt) / 1000) : 0;
    const mm = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    return (
      <div
        className={`offline-voice-hud ${v.state}`}
        data-offline-voice-hud={v.state}
        role="status"
      >
        <div className="offline-voice-hud-row">
          <span className="offline-voice-dot" />
          <span className="offline-voice-hud-text">
            {v.state === 'transcribing'
              ? tr('⏳ מתמלל במחשב…', '⏳ Transcribing on this PC…')
              : v.state === 'starting'
                ? tr('🎙️ פותח מיקרופון…', '🎙️ Opening the microphone…')
                : v.mode === 'command'
                  ? tr(`🎙️ אמרו פקודה… ${mm}`, `🎙️ Say a command… ${mm}`)
                  : tr(`🎙️ מקליט… ${mm}`, `🎙️ Recording… ${mm}`)}
          </span>
          {v.state === 'recording' ? (
            <span className="offline-voice-level" aria-hidden="true">
              <span style={{ width: `${Math.round(v.level * 100)}%` }} />
            </span>
          ) : null}
          {v.state === 'recording' ? (
            <button
              type="button"
              className="btn btn-small"
              data-offline-voice-stop="true"
              onClick={() => void v.stop()}
            >
              {tr('עצור', 'Stop')}
            </button>
          ) : null}
          {v.state !== 'transcribing' ? (
            <button
              type="button"
              className="btn btn-small"
              data-offline-voice-cancel="true"
              onClick={() => v.cancel()}
            >
              {tr('בטל', 'Cancel')}
            </button>
          ) : null}
        </div>
        {v.partial ? (
          <div className="offline-voice-partial" dir="auto" data-offline-voice-partial="true">
            {v.partial}
          </div>
        ) : null}
        <div className="offline-voice-hud-detail">
          {tr('ההקלטה נשארת במחשב (Whisper מקומי)', 'The audio stays on this PC (local Whisper)')}
          {whisperSetup() ? ` · ${whisperSetup()!.modelName}` : ''}
        </div>
      </div>
    );
  }
}
