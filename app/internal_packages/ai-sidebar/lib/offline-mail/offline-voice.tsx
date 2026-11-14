/**
 * Offline experiment (t239): voice with Gemini Live.
 * - "שיחה עם Gemini" (ribbon / AI panel / Ctrl+Shift+Space): a live spoken
 *   conversation in Hebrew. Gemini answers aloud, can be interrupted, and
 *   works the app through tools (search, folders, drafts, reply text,
 *   summarize the selected message, star / archive / unread, delete only
 *   after a yes). There is no send tool.
 * - Green mic next to text fields: dictation with Gemini transcription.
 * Audio goes to Google only while a session the user started is running
 * (explicit click or shortcut), with a "live, listening" card and a Stop
 * button; it stops by itself after silence or a time limit. The key stays in
 * the main process. Mail text goes to Gemini only through the tools, a few
 * messages at a time (like Ask AI). (Replaces the earlier local recognition.)
 */
import React from 'react';
import { ipcRenderer } from 'electron';
import { tr, offlineLang } from '../core/offline-i18n';
import {
  DeleteGate,
  VOICE_CHUNK_SAMPLES,
  VOICE_OUTPUT_RATE,
  VOICE_SAMPLE_RATE,
  clipForGemini,
  floatTo16BitPcm,
  matchFolder,
  pcm16Base64ToFloat,
  peakOf,
  resampleTo16k,
  shouldAutoStop,
} from '../core/offline-voice';
import {
  GEMINI_DICTATE_IDLE_SECONDS,
  GEMINI_LIVE_IDLE_SECONDS,
  GEMINI_LIVE_IPC_AUDIO,
  GEMINI_LIVE_IPC_AUDIO_END,
  GEMINI_LIVE_IPC_EVENT,
  GEMINI_LIVE_IPC_START,
  GEMINI_LIVE_IPC_STOP,
  GEMINI_LIVE_IPC_TOOL_RESULT,
  GeminiLiveEvent,
  LiveUsageTotals,
} from '../../../../src/browser/gemini-live-protocol';

type Listener = () => void;
/** 'command' = the spoken conversation; an element = dictation into it. */
type Target = HTMLElement | 'command';
type SavedSel = { start: number; end: number } | Range | null;

const USD_TO_ILS = 3.19;

export type VoiceHud = null | {
  kind: 'info' | 'ok' | 'warn';
  text: string;
  detail?: string;
  action?: { label: string; run: () => void };
  actions?: Array<{ id: string; label: string; run: () => void }>;
};

export type VoiceLine = { who: 'user' | 'gemini' | 'app'; text: string };

/** Tests can swap the microphone (fake stream) or watch sessions. */
export const offlineVoiceHooks: {
  getStream: (() => Promise<MediaStream>) | null;
  /** Event types seen (no content), newest last; tests only. */
  events: string[];
  tools: Array<{ name: string; ok: boolean }>;
  lastSession: {
    mode: string;
    model: string;
    seconds: number;
    totals: LiveUsageTotals | null;
    reason: string;
    audioChunks: number;
    playedChunks: number;
    interrupted: number;
  } | null;
  /** Tests: do not play Gemini's voice (still counted). */
  mute: boolean;
} = { getStream: null, events: [], tools: [], lastSession: null, mute: false };

function lazy<T = any>(m: string): T {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(m);
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

// ---- Live session store ------------------------------------------------------

class OfflineVoice {
  state: 'idle' | 'connecting' | 'live' | 'stopping' = 'idle';
  mode: 'talk' | 'dictate' | null = null;
  target: HTMLElement | null = null;
  level = 0;
  startedAt = 0;
  /** Gemini's voice is playing. */
  speaking = false;
  /** Dictation: words heard so far but not final yet. */
  partial = '';
  lines: VoiceLine[] = [];
  totals: LiveUsageTotals | null = null;
  model = '';
  hud: VoiceHud = null;
  readonly deleteGate = new DeleteGate();
  confirmDelete: { messageId: string; subject: string } | null = null;
  private _id: string | null = null;
  private _sel: SavedSel = null;
  private _stream: MediaStream | null = null;
  private _ctx: AudioContext | null = null;
  private _node: ScriptProcessorNode | null = null;
  private _rate = VOICE_SAMPLE_RATE;
  private _pending: Float32Array[] = [];
  private _pendingLen = 0;
  private _out: AudioContext | null = null;
  private _outNext = 0;
  private _sources = new Set<AudioBufferSourceNode>();
  private _lastActivity = 0;
  private _idleTimer: any = null;
  private _hudTimer: any = null;
  private _listeners = new Set<Listener>();
  private _ipcOn = false;
  private _dictFinals = 0;
  private _dictOutput = '';
  private _finalWaiters: Array<() => void> = [];
  private _endAfterSpeech = false;
  private _stats = { audioChunks: 0, playedChunks: 0, interrupted: 0 };

  listen(cb: Listener) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit() {
    this._listeners.forEach((l) => l());
  }

  /** Windows offline app only (Mac unchanged). Gemini is checked on start. */
  get available(): boolean {
    return process.platform === 'win32';
  }

  get active(): boolean {
    return this.state !== 'idle';
  }

  isActiveFor(t: Target): boolean {
    if (this.state === 'idle') return false;
    return t === 'command' ? this.mode === 'talk' : this.target === t;
  }

  showHud(h: VoiceHud, ms = 4500) {
    this.hud = h;
    if (this._hudTimer) clearTimeout(this._hudTimer);
    this._hudTimer = h && ms > 0 ? setTimeout(() => this.showHud(null, 0), ms) : null;
    this._emit();
  }

  addLine(who: VoiceLine['who'], text: string, append = false) {
    const t = String(text || '');
    if (!t.trim()) return;
    const last = this.lines[this.lines.length - 1];
    if (append && last && last.who === who) {
      // Gemini's spoken-text pieces sometimes come without the space between words.
      const glue =
        who === 'gemini' && /[\p{L}\p{N}]$/u.test(last.text) && /^[\p{L}\p{N}]/u.test(t) ? ' ' : '';
      last.text = (last.text + glue + t).replace(/\s+/g, ' ');
    } else this.lines.push({ who, text: t.trim() });
    if (this.lines.length > 30) this.lines.splice(0, this.lines.length - 30);
    this._emit();
  }

  toggle(t: Target) {
    if (this.state === 'connecting' || this.state === 'stopping') return;
    if (this.state === 'live') {
      const same = this.isActiveFor(t);
      void this.stop();
      if (same) return;
      return;
    }
    void this.start(t);
  }

  private _bindIpc() {
    if (this._ipcOn) return;
    this._ipcOn = true;
    ipcRenderer.on(GEMINI_LIVE_IPC_EVENT, (_e: unknown, id: string, ev: GeminiLiveEvent) => {
      if (id !== this._id) return;
      this._onEvent(ev);
    });
  }

  async start(t: Target) {
    if (this.state !== 'idle') return;
    this._bindIpc();
    this.mode = t === 'command' ? 'talk' : 'dictate';
    this.target = t === 'command' ? null : t;
    this._sel = t === 'command' ? null : saveSelection(t);
    this.lines = [];
    this.partial = '';
    this.totals = null;
    this.model = '';
    this.speaking = false;
    this._dictFinals = 0;
    this._dictOutput = '';
    this._endAfterSpeech = false;
    this._stats = { audioChunks: 0, playedChunks: 0, interrupted: 0 };
    this.confirmDelete = null;
    this.deleteGate.clear();
    this.state = 'connecting';
    this.showHud(null, 0);
    try {
      // Microphone first (normal Windows permission), then the paid session.
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
      if (this.state !== 'connecting') {
        stream.getTracks().forEach((x) => x.stop());
        return;
      }
      this._stream = stream;
      const res = await ipcRenderer.invoke(GEMINI_LIVE_IPC_START, {
        mode: this.mode,
        uiLang: offlineLang() === 'en' ? 'en' : 'he',
      });
      if (!res || !res.ok) {
        this._teardown();
        this._reset();
        this.showHud(
          {
            kind: 'warn',
            text: tr('לא הצלחתי להתחבר ל-Gemini', 'Could not connect to Gemini'),
            detail: String((res && res.message) || '').slice(0, 400),
          },
          12000
        );
        return;
      }
      if (this.state !== 'connecting') {
        void ipcRenderer.invoke(GEMINI_LIVE_IPC_STOP, res.id);
        return;
      }
      this._id = res.id;
      this.model = res.model || '';
      this._startMic(stream);
      this.state = 'live';
      this.startedAt = Date.now();
      this._lastActivity = Date.now();
      this._idleTimer = setInterval(() => this._tick(), 1000);
      if (this.mode === 'talk')
        this.addLine('app', tr('🔴 מחובר — אפשר לדבר', '🔴 Connected — go ahead and talk'));
      this._emit();
    } catch (err) {
      this._teardown();
      this._reset();
      const name = (err as any)?.name || '';
      this.showHud(
        {
          kind: 'warn',
          text:
            name === 'NotAllowedError'
              ? tr('אין גישה למיקרופון', 'No access to the microphone')
              : tr('לא הצלחתי להתחיל', 'Could not start'),
          detail:
            name === 'NotAllowedError'
              ? tr(
                  'אפשר לאשר ב-Windows: הגדרות ← פרטיות ← מיקרופון ← "אפשר לאפליקציות שולחן עבודה".',
                  'Allow it in Windows: Settings → Privacy → Microphone → "Let desktop apps access your microphone".'
                )
              : String((err as Error)?.message || name).slice(0, 200),
        },
        9000
      );
    }
  }

  private _startMic(stream: MediaStream) {
    const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    this._ctx = ctx;
    this._rate = ctx.sampleRate || VOICE_SAMPLE_RATE;
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    this._node = node;
    this._pending = [];
    this._pendingLen = 0;
    node.onaudioprocess = (e) => {
      if (this.state !== 'live' || !this._id) return;
      const raw = e.inputBuffer.getChannelData(0);
      const d = resampleTo16k(new Float32Array(raw), this._rate);
      const p = peakOf(d);
      this.level = Math.min(1, p * 1.6);
      if (p > 0.12) this._lastActivity = Date.now();
      this._pending.push(d);
      this._pendingLen += d.length;
      if (this._pendingLen >= VOICE_CHUNK_SAMPLES) {
        const all = new Float32Array(this._pendingLen);
        let o = 0;
        for (const c of this._pending) {
          all.set(c, o);
          o += c.length;
        }
        this._pending = [];
        this._pendingLen = 0;
        ipcRenderer.send(GEMINI_LIVE_IPC_AUDIO, this._id, floatTo16BitPcm(all));
        this._stats.audioChunks++;
      }
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  private _play(b64: string) {
    this._stats.playedChunks++;
    if (offlineVoiceHooks.mute) return;
    if (!this._out) {
      this._out = new AudioContext({ sampleRate: VOICE_OUTPUT_RATE });
      this._outNext = 0;
    }
    const ctx = this._out;
    const f = pcm16Base64ToFloat(b64);
    if (!f.length) return;
    const buf = ctx.createBuffer(1, f.length, VOICE_OUTPUT_RATE);
    buf.copyToChannel(f, 0);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this._outNext);
    s.start(at);
    this._outNext = at + buf.duration;
    this._sources.add(s);
    this.speaking = true;
    s.onended = () => {
      this._sources.delete(s);
      if (!this._sources.size) {
        this.speaking = false;
        this._lastActivity = Date.now();
        this._emit();
        if (this._endAfterSpeech) void this.stop('gemini-ended');
      }
    };
  }

  /** Barge-in: the user started talking — drop what Gemini was saying. */
  private _stopPlayback() {
    for (const s of Array.from(this._sources)) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        // already stopped
      }
    }
    this._sources.clear();
    this._outNext = 0;
    this.speaking = false;
  }

  private _onEvent(ev: GeminiLiveEvent) {
    offlineVoiceHooks.events.push(ev.type);
    if (offlineVoiceHooks.events.length > 400) offlineVoiceHooks.events.splice(0, 100);
    switch (ev.type) {
      case 'audio':
        this._lastActivity = Date.now();
        this._play(ev.data);
        break;
      case 'input-text':
        this._lastActivity = Date.now();
        if (this.mode === 'dictate') {
          if (ev.final) {
            this._insertDictation(ev.text);
            this.partial = '';
          } else {
            this.partial = ev.text;
          }
          this._emit();
        } else {
          this.addLine('user', ev.text, true);
        }
        break;
      case 'output-text':
        this._lastActivity = Date.now();
        if (this.mode === 'dictate') this._dictOutput += ev.text;
        else this.addLine('gemini', ev.text, true);
        break;
      case 'interrupted':
        this._stats.interrupted++;
        this._stopPlayback();
        this.addLine('app', tr('⏸ נקטע — מקשיב', '⏸ Interrupted — listening'));
        break;
      case 'turn-complete':
        this._finalWaiters.splice(0).forEach((f) => f());
        // Next answer starts on a new line.
        this.lines.push({ who: 'app', text: '' });
        this.lines = this.lines.filter((l) => l.text || l === this.lines[this.lines.length - 1]);
        this._emit();
        break;
      case 'tool-call':
        this._lastActivity = Date.now();
        for (const c of ev.calls) void this._runTool(c.id, c.name, c.args);
        break;
      case 'usage':
        this.totals = ev.totals;
        this._emit();
        break;
      case 'error':
        this.showHud(
          {
            kind: 'warn',
            text: tr('שגיאה ב-Gemini Live', 'Gemini Live error'),
            detail: ev.message.slice(0, 300),
          },
          9000
        );
        break;
      case 'closed':
        this.totals = ev.totals;
        if (this.state === 'live') void this.stop(ev.reason, true);
        break;
      default:
        break;
    }
  }

  private _insertDictation(text: string) {
    const t = String(text || '').trim();
    const el = this.target;
    if (!t || !el || !document.contains(el)) return;
    insertAtCaret(el, t, this._sel);
    this._sel = saveSelection(el);
    this._dictFinals++;
  }

  private _tick() {
    if (this.state !== 'live') return;
    const idle = this.mode === 'dictate' ? GEMINI_DICTATE_IDLE_SECONDS : GEMINI_LIVE_IDLE_SECONDS;
    if (
      shouldAutoStop({
        now: Date.now(),
        lastActivity: this._lastActivity,
        idleSec: idle,
        speaking: this.speaking || !!this.confirmDelete,
      })
    ) {
      void this.stop('silence');
      return;
    }
    this._emit();
  }

  private async _runTool(callId: string, name: string, args: Record<string, unknown>) {
    let result: Record<string, unknown>;
    try {
      result = await runLiveTool(name, args || {});
    } catch (err) {
      result = { ok: false, error: String((err as Error)?.message || err).slice(0, 200) };
    }
    offlineVoiceHooks.tools.push({ name, ok: result.ok !== false });
    if (this._id && this.state === 'live')
      ipcRenderer.send(GEMINI_LIVE_IPC_TOOL_RESULT, this._id, callId, name, result);
    if (name === 'end_conversation') {
      this._endAfterSpeech = true;
      setTimeout(() => {
        if (this.state === 'live' && !this.speaking) void this.stop('gemini-ended');
      }, 4000);
    }
  }

  /** Stop listening and close the session (also: auto-stop, server end). */
  async stop(reason = 'user-stopped', serverClosed = false) {
    if (this.state === 'idle' || this.state === 'stopping') return;
    if (this.state === 'connecting') {
      this._teardown();
      this._reset();
      return;
    }
    const id = this._id;
    const mode = this.mode;
    this.state = 'stopping';
    this._emit();
    if (this._node) this._node.onaudioprocess = null;
    if (mode === 'dictate' && id && !serverClosed) {
      // Let Gemini finish the last words (up to ~2.5 s).
      ipcRenderer.send(GEMINI_LIVE_IPC_AUDIO_END, id);
      await new Promise<void>((res) => {
        const t = setTimeout(res, 2500);
        this._finalWaiters.push(() => {
          clearTimeout(t);
          setTimeout(res, 300);
        });
      });
      if (!this._dictFinals && this._dictOutput.trim()) this._insertDictation(this._dictOutput);
      else if (this.partial.trim() && !this._dictFinals) this._insertDictation(this.partial);
    }
    let summary: { totals: LiveUsageTotals; seconds: number } | null = null;
    if (id && !serverClosed) {
      try {
        summary = await ipcRenderer.invoke(GEMINI_LIVE_IPC_STOP, id);
      } catch {
        summary = null;
      }
    }
    const totals = (summary && summary.totals) || this.totals;
    const seconds = summary ? summary.seconds : Math.round((Date.now() - this.startedAt) / 1000);
    offlineVoiceHooks.lastSession = {
      mode: mode || '',
      model: this.model,
      seconds,
      totals: totals || null,
      reason,
      ...this._stats,
    };
    const inserted = this._dictFinals;
    const target = this.target;
    this._teardown();
    this._reset();
    try {
      void lazy('../ai-sidebar-store').default.refreshGeminiUsage();
    } catch {
      // usage meter not loaded
    }
    const cost = totals ? `≈ ₪${(totals.usd * USD_TO_ILS).toFixed(3)}` : '';
    const mm = `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
    const why =
      reason === 'silence'
        ? tr(' (נעצר אחרי שקט)', ' (stopped after silence)')
        : reason === 'time-limit'
          ? tr(' (הגיע לזמן המקסימלי)', ' (time limit reached)')
          : '';
    if (mode === 'dictate') {
      this.showHud(
        inserted
          ? { kind: 'ok', text: tr('✓ נוסף', '✓ Added'), detail: `${mm} · ${cost}${why}` }
          : {
              kind: 'warn',
              text: tr('לא שמעתי, נסה שוב', "Didn't catch that, try again"),
              detail: `${mm} · ${cost}${why}`,
              actions:
                target && document.contains(target)
                  ? [
                      {
                        id: 'retry',
                        label: tr('🎤 נסה שוב', '🎤 Try again'),
                        run: () => void this.start(target),
                      },
                    ]
                  : undefined,
            },
        5000
      );
    } else {
      this.showHud(
        {
          kind: 'info',
          text: tr('השיחה עם Gemini הסתיימה', 'The Gemini conversation ended') + why,
          detail: tr(`משך ${mm} · עלות משוערת ${cost}`, `Length ${mm} · estimated cost ${cost}`),
          actions: [
            {
              id: 'retry',
              label: tr('🎙️ שיחה חדשה', '🎙️ New conversation'),
              run: () => void this.start('command'),
            },
          ],
        },
        7000
      );
    }
  }

  /** Esc: stop at once (dictation: nothing more is typed). */
  cancel() {
    if (this.state === 'idle') return;
    if (this.mode === 'dictate') {
      this._dictFinals = 1; // nothing more is inserted
      this.target = null;
    }
    void this.stop('cancelled');
  }

  private _teardown() {
    if (this._idleTimer) clearInterval(this._idleTimer);
    this._idleTimer = null;
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
    this._stopPlayback();
    if (this._out) void this._out.close().catch(() => undefined);
    this._out = null;
    this._node = null;
    this._stream = null;
    this._ctx = null;
    this.level = 0;
  }

  private _reset() {
    this.state = 'idle';
    this.mode = null;
    this.target = null;
    this.partial = '';
    this._id = null;
    this.confirmDelete = null;
    this.deleteGate.clear();
    this._emit();
  }
}

export const offlineVoice = new OfflineVoice();

// ---- Tools: what Gemini can do in the app -----------------------------------

const MAX_QA_MESSAGES = 6;
const MAX_QA_BODY = 1500;
const MAX_SELECTED_BODY = 4000;

function needMessage() {
  return { ok: false, error: 'No message is selected in the app. Ask the user to select one.' };
}

function dateOnly(d: unknown): string {
  const t = d instanceof Date ? d : new Date(String(d || ''));
  return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 10) : '';
}

function selectedMessageId(): string | null {
  const m = currentMessage();
  if (m) return m.id;
  const s = lazy('./offline-mail-store').offlineMailStore;
  return s.selectedIds.length ? s.selectedIds[0] : null;
}

async function waitFor(cond: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
}

/** Run one tool call locally. Results are short and contain no keys or paths. */
export async function runLiveTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const v = offlineVoice;
  const drafts = () => lazy('./offline-drafts-store').offlineDraftsStore;
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
  switch (name) {
    case 'search_mail': {
      const q = s('query');
      if (!q) return { ok: false, error: 'empty query' };
      if (drafts().showing) drafts().hide();
      const st = lazy('./offline-search-store').offlineSearchStore;
      st.setQuery(q);
      await waitFor(() => st.query === q && st.active && !(st as any)._timer, 3000);
      await new Promise((r) => setTimeout(r, 150));
      const results = (st.results || []).slice(0, 8).map((r: any, i: number) => ({
        n: i + 1,
        from: clipForGemini(r.entry.from, 60),
        date: r.entry.ts ? new Date(r.entry.ts).toISOString().slice(0, 10) : '',
        subject: clipForGemini(r.entry.subject, 100),
      }));
      v.addLine(
        'app',
        tr(`🔍 חיפוש: ${q} (${st.total || 0})`, `🔍 Search: ${q} (${st.total || 0})`)
      );
      return { ok: true, total: st.total || 0, results };
    }
    case 'ask_about_mail': {
      const q = s('question');
      if (!q) return { ok: false, error: 'empty question' };
      const cat = lazy('../offline-archive-catalog');
      const ctx = await cat.buildOfflineQuestionContext(q);
      const msgs = (ctx.messages || []).slice(0, MAX_QA_MESSAGES).map((m: any, i: number) => ({
        n: i + 1,
        from: clipForGemini(m.from, 60),
        date: dateOnly(m.date),
        subject: clipForGemini(m.subject, 120),
        text: clipForGemini(m.bodyText || m.snippet || '', MAX_QA_BODY),
      }));
      v.addLine(
        'app',
        tr(
          `📨 נשלחו ל-Gemini ${msgs.length} הודעות (טקסט בלבד)`,
          `📨 Sent ${msgs.length} messages to Gemini (text only)`
        )
      );
      return { ok: true, found: ctx.found || 0, sent: msgs.length, messages: msgs };
    }
    case 'read_selected_message': {
      const m = currentMessage();
      if (!m) return needMessage();
      const p = m.parsed || {};
      v.addLine(
        'app',
        tr(
          '📨 נשלחה ל-Gemini ההודעה הנבחרת (טקסט בלבד)',
          '📨 Sent the selected message to Gemini (text only)'
        )
      );
      return {
        ok: true,
        from: clipForGemini(String(p.from || ''), 80),
        date: dateOnly(p.date),
        subject: clipForGemini(String(p.subject || ''), 160),
        text: clipForGemini(String(p.text || ''), MAX_SELECTED_BODY),
      };
    }
    case 'go_to_folder': {
      const p = matchFolder(s('name'), folderChoices());
      if (!p) return { ok: false, error: 'No folder with that name' };
      if (drafts().showing) drafts().hide();
      const st = lazy('./offline-search-store').offlineSearchStore;
      if (st.query) st.clear();
      const store = lazy('./offline-mail-store').offlineMailStore;
      store.setFolder(p);
      v.addLine('app', `📁 ${store.folderLabel(p)}`);
      return { ok: true };
    }
    case 'new_draft':
      drafts().createNew();
      v.addLine('app', tr('📝 נפתחה טיוטה חדשה', '📝 New draft opened'));
      return { ok: true };
    case 'open_draft': {
      const q = s('query').toLowerCase();
      const list = (drafts().drafts || [])
        .slice()
        .sort((a: any, b: any) => b.updatedAt - a.updatedAt);
      const words = q.split(/\s+/).filter(Boolean);
      const hit = words.length
        ? list.find((d: any) =>
            words.every((w) => `${d.subject} ${d.body}`.toLowerCase().includes(w))
          )
        : list[0];
      if (!hit) return { ok: false, error: 'No matching draft', drafts: list.length };
      drafts().openDraft(hit.id);
      v.addLine('app', tr('📝 נפתחה טיוטה', '📝 Draft opened'));
      return { ok: true, subject: clipForGemini(hit.subject, 120) };
    }
    case 'reply_to_selected': {
      const msg = currentMessage();
      if (!msg) return needMessage();
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
      v.addLine(
        'app',
        tr('↩️ נפתחה טיוטת תשובה (לא נשלח כלום)', '↩️ Reply draft opened (nothing is sent)')
      );
      return { ok: true, note: 'Local draft only. The app cannot send.' };
    }
    case 'fill_draft': {
      const text = typeof args.text === 'string' ? args.text : '';
      const d = drafts().open;
      if (!d)
        return {
          ok: false,
          error: 'No draft is open. Use new_draft, open_draft or reply_to_selected first.',
        };
      if (!text.trim()) return { ok: false, error: 'empty text' };
      const how = args.how === 'append' ? 'append' : 'replace';
      const subject =
        typeof args.subject === 'string' && args.subject.trim() ? args.subject.trim() : null;
      const ok = drafts().applyAiText(d.id, text.slice(0, 8000), how, { subject });
      v.addLine(
        'app',
        tr('✍️ הטקסט נכתב בטיוטה (אפשר לבטל)', '✍️ Text written into the draft (can be undone)')
      );
      return { ok, note: 'The user reviews the draft. Nothing is sent.' };
    }
    case 'message_action': {
      const id = selectedMessageId();
      if (!id) return needMessage();
      const a = lazy('./offline-message-actions');
      const store = lazy('./offline-mail-store').offlineMailStore;
      const act = s('action');
      if (act === 'star' || act === 'unstar') {
        if (store.isStarred(id) !== (act === 'star')) a.actToggleStar([id]);
      } else if (act === 'archive') a.actArchive([id]);
      else if (act === 'mark_unread') a.actSetUnread(true, [id]);
      else return { ok: false, error: 'unknown action' };
      const label: { [k: string]: string } = {
        star: tr('⭐ סומן בכוכב', '⭐ Starred'),
        unstar: tr('☆ הכוכב הוסר', '☆ Star removed'),
        archive: tr('🗄️ הועבר לארכיון (מקומית)', '🗄️ Archived (locally)'),
        mark_unread: tr('✉️ סומן כלא נקרא', '✉️ Marked unread'),
      };
      v.addLine('app', label[act]);
      return { ok: true };
    }
    case 'delete_selected_message': {
      const id = selectedMessageId();
      if (!id) return needMessage();
      if (args.confirmed !== true) {
        v.deleteGate.request(id);
        const m = currentMessage();
        v.confirmDelete = {
          messageId: id,
          subject: String((m && m.parsed && m.parsed.subject) || ''),
        };
        v._emit();
        return {
          ok: true,
          status: 'needs_confirmation',
          instruction:
            'Ask the user out loud to confirm. The app also shows Delete / Cancel buttons.',
        };
      }
      if (!v.deleteGate.confirm(id)) {
        return {
          ok: false,
          error: 'Not confirmed. Call with confirmed=false first and ask the user.',
        };
      }
      v.confirmDelete = null;
      lazy('./offline-message-actions').actDelete([id]);
      v.addLine('app', tr('🗑️ נמחק (מקומית, אפשר לבטל)', '🗑️ Deleted (locally, can be undone)'));
      return { ok: true, deleted: true, note: 'Moved to the local Trash; can be undone.' };
    }
    case 'end_conversation':
      return { ok: true };
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

/** On-screen answer to the delete confirmation. */
export function answerDeleteConfirmation(yes: boolean) {
  const v = offlineVoice;
  const c = v.confirmDelete;
  if (!c) return;
  v.confirmDelete = null;
  if (yes && v.deleteGate.confirm(c.messageId)) {
    lazy('./offline-message-actions').actDelete([c.messageId]);
    v.addLine('app', tr('🗑️ נמחק (מקומית, אפשר לבטל)', '🗑️ Deleted (locally, can be undone)'));
  } else {
    v.deleteGate.clear();
    v.addLine('app', tr('המחיקה בוטלה', 'Delete cancelled'));
  }
  v._emit();
}

/** Ctrl+Shift+Space: talk to Gemini; Esc: stop. */
export function installVoiceShortcuts(win: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      offlineVoice.toggle('command');
    } else if (e.key === 'Escape' && offlineVoice.active) {
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
  /** Talk with Gemini instead of dictation. */
  command?: boolean;
  label?: string;
  size?: 'small' | 'normal';
};

/** Green round mic: click to dictate with Gemini (or talk), click again to stop. */
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
    const v = offlineVoice;
    if (!v.available) return null;
    const t = this._btn.current ? this._target() : null;
    const active = !!t && v.isActiveFor(t);
    const rec = active && v.state === 'live';
    const busy = active && (v.state === 'connecting' || v.state === 'stopping');
    const title = this.props.command
      ? tr(
          'שיחה עם Gemini (Ctrl+Shift+Space): מדברים, Gemini עונה בקול ויכול לחפש, לעבור תיקייה, לפתוח טיוטה, לכתוב תשובה, לסכם הודעה, לסמן ולמחוק (רק אחרי אישור). אין שליחת מייל. הקול נשלח ל-Google רק בזמן השיחה, בתשלום.',
          'Talk with Gemini (Ctrl+Shift+Space): speak, Gemini answers aloud and can search, open folders and drafts, write a reply, summarize a message, star/archive and delete (only after a yes). It cannot send mail. Audio goes to Google only during the conversation (paid).'
        )
      : tr(
          'הכתבה עם Gemini: לחצו, דברו (עברית או אנגלית), ולחצו שוב — הטקסט נכתב במקום הסמן. הקול נשלח ל-Google רק בזמן ההכתבה (בתשלום, זול).',
          'Dictation with Gemini: click, speak (Hebrew or English), click again — the text goes in at the cursor. Audio goes to Google only while dictating (paid, cheap).'
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
          (this.props.command ? tr('שיחה עם Gemini', 'Talk with Gemini') : tr('הכתבה', 'Dictate'))
        }
        title={
          rec ? tr('חי — מקשיב… לחצו לעצירה (Esc)', 'Live — listening… click to stop (Esc)') : title
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

function fmtIls(totals: LiveUsageTotals | null): string {
  return totals ? `≈ ₪${(totals.usd * USD_TO_ILS).toFixed(3)}` : '≈ ₪0';
}

/** Card at the bottom of the window: live / listening, transcript, Stop. */
export class OfflineVoiceHud extends React.Component<Record<string, never>, { tick: number }> {
  static displayName = 'OfflineVoiceHud';
  state = { tick: 0 };
  private _un: (() => void) | null = null;
  private _unKeys: (() => void) | null = null;
  private _raf: any = null;
  private _log = React.createRef<HTMLDivElement>();

  componentDidMount() {
    this._un = offlineVoice.listen(() => this.setState({ tick: this.state.tick + 1 }));
    this._unKeys = installVoiceShortcuts();
    this._raf = setInterval(
      () => offlineVoice.state === 'live' && this.setState({ tick: this.state.tick + 1 }),
      250
    );
  }

  componentDidUpdate() {
    const l = this._log.current;
    if (l) l.scrollTop = l.scrollHeight;
  }

  componentWillUnmount() {
    if (this._un) this._un();
    if (this._unKeys) this._unKeys();
    clearInterval(this._raf);
  }

  _renderHud() {
    const v = offlineVoice;
    const h = v.hud;
    if (!h) return null;
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
        {(h.actions || []).map((a) => (
          <button
            key={a.id}
            type="button"
            className="btn btn-small"
            data-offline-voice-hud-action={a.id}
            onClick={() => {
              v.showHud(null, 0);
              a.run();
            }}
          >
            {a.label}
          </button>
        ))}
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

  render() {
    const v = offlineVoice;
    if (v.state === 'idle') return this._renderHud();
    const sec = v.state === 'live' ? Math.floor((Date.now() - v.startedAt) / 1000) : 0;
    const mm = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const talk = v.mode === 'talk';
    const status =
      v.state === 'connecting'
        ? tr('⏳ מתחבר ל-Gemini…', '⏳ Connecting to Gemini…')
        : v.state === 'stopping'
          ? tr('⏳ מסיים…', '⏳ Finishing…')
          : talk
            ? v.speaking
              ? tr(
                  `🔊 Gemini מדבר — אפשר לקטוע · ${mm}`,
                  `🔊 Gemini is speaking — you can interrupt · ${mm}`
                )
              : tr(`חי — מקשיב · ${mm}`, `Live — listening · ${mm}`)
            : tr(`חי — מקשיב להכתבה · ${mm}`, `Live — listening for dictation · ${mm}`);
    const lines = v.lines.filter((l) => l.text).slice(-8);
    return (
      <div
        className={`offline-voice-hud live ${v.state}${talk ? ' talk' : ' dictate'}`}
        data-offline-voice-hud={v.state === 'live' ? 'recording' : v.state}
        data-offline-voice-live={v.state === 'live' ? 'true' : 'false'}
        role="status"
      >
        <div className="offline-voice-hud-row">
          <span className="offline-voice-dot" />
          <span className="offline-voice-live-badge">{tr('LIVE', 'LIVE')}</span>
          <span className="offline-voice-hud-text">{status}</span>
          {v.state === 'live' ? (
            <span className="offline-voice-level" aria-hidden="true">
              <span style={{ width: `${Math.round(v.level * 100)}%` }} />
            </span>
          ) : null}
          <span className="offline-voice-cost" dir="ltr" data-offline-voice-cost="true">
            {fmtIls(v.totals)}
          </span>
          <button
            type="button"
            className="btn btn-small offline-voice-stop"
            data-offline-voice-stop="true"
            disabled={v.state === 'stopping'}
            onClick={() => void v.stop()}
          >
            {tr('⏹ עצור', '⏹ Stop')}
          </button>
        </div>
        {v.confirmDelete ? (
          <div className="offline-voice-confirm" data-offline-voice-confirm="delete">
            <span>
              {tr(
                'למחוק את ההודעה הנבחרת? (מקומית, אפשר לבטל)',
                'Delete the selected message? (locally, can be undone)'
              )}
            </span>
            <button
              type="button"
              className="btn btn-small"
              data-offline-voice-confirm-yes="true"
              onClick={() => answerDeleteConfirmation(true)}
            >
              {tr('🗑️ מחק', '🗑️ Delete')}
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-offline-voice-confirm-no="true"
              onClick={() => answerDeleteConfirmation(false)}
            >
              {tr('ביטול', 'Cancel')}
            </button>
          </div>
        ) : null}
        {talk && lines.length ? (
          <div
            className="offline-voice-log"
            ref={this._log}
            dir="auto"
            data-offline-voice-log="true"
          >
            {lines.map((l, i) => (
              <div key={i} className={`offline-voice-line ${l.who}`} dir="auto">
                {l.who === 'user' ? '🗣️ ' : l.who === 'gemini' ? '✨ ' : ''}
                {l.text}
              </div>
            ))}
          </div>
        ) : null}
        {!talk && v.partial ? (
          <div className="offline-voice-partial" dir="auto" data-offline-voice-partial="true">
            {v.partial}
          </div>
        ) : null}
        <div className="offline-voice-hud-detail">
          {talk
            ? tr(
                `הקול נשלח ל-Google רק בזמן השיחה · נעצר לבד אחרי ${GEMINI_LIVE_IDLE_SECONDS} שניות שקט · אין שליחת מייל`,
                `Audio goes to Google only during the conversation · stops after ${GEMINI_LIVE_IDLE_SECONDS}s of silence · no mail sending`
              )
            : tr(
                `הקול נשלח ל-Google רק בזמן ההכתבה · נעצר לבד אחרי ${GEMINI_DICTATE_IDLE_SECONDS} שניות שקט`,
                `Audio goes to Google only while dictating · stops after ${GEMINI_DICTATE_IDLE_SECONDS}s of silence`
              )}
        </div>
      </div>
    );
  }
}
