/**
 * Gemini Live API host (main process, offline experiment). The window sends
 * microphone audio over IPC; this opens the WebSocket to Gemini with the key
 * from the existing secure path (Credential Manager → main-process memory),
 * relays audio / transcripts / tool calls, and records usage. The key never
 * goes to the window, and no socket exists unless the user started a session.
 */
import {
  GEMINI_LIVE_HOST,
  GEMINI_LIVE_MAX_SECONDS,
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_PATH,
  GEMINI_TRANSCRIBE_MODEL,
  GeminiLiveEvent,
  GeminiLiveMode,
  LiveHistoryTurn,
  LiveUsageTotals,
  addLiveUsage,
  buildLiveSetup,
  emptyLiveTotals,
  estimateLiveUsage,
  isAllowedLiveUrl,
} from './gemini-live-protocol';
import { closeLiveGate, isLiveGateOpen, openLiveGate } from './gemini-live-gate';

export interface LiveSocket {
  binaryType?: string;
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}
export type LiveSocketFactory = (url: string) => LiveSocket;

export function defaultLiveSocketFactory(url: string): LiveSocket {
  const WS = (globalThis as any).WebSocket;
  if (typeof WS !== 'function') {
    throw new Error('no-websocket');
  }
  const ws = new WS(url);
  ws.binaryType = 'arraybuffer';
  return ws as LiveSocket;
}

export function redactKey(text: string, key: string): string {
  let t = String(text || '');
  if (key) t = t.split(key).join('[redacted-key]');
  return t.replace(/([?&]key=)[^&\s]+/g, '$1[redacted-key]');
}

async function frameText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  if (data && typeof (data as any).text === 'function') return (data as any).text();
  return String(data || '');
}

export type LiveSessionEnd = {
  model: string;
  mode: GeminiLiveMode;
  totals: LiveUsageTotals;
  seconds: number;
  reason: string;
};

export class GeminiLiveSession {
  readonly id: string;
  readonly mode: GeminiLiveMode;
  readonly model: string;
  private ws: LiveSocket | null = null;
  private ready = false;
  private ended = false;
  private startedAt = 0;
  private endedAt = 0;
  private totals = emptyLiveTotals();
  private maxTimer: any = null;
  private readyWaiters: Array<(r: { ok: boolean; reason?: string; message?: string }) => void> = [];
  /** Seconds of microphone audio sent (for the usage display). */
  audioSeconds = 0;
  private textChars = 0;

  constructor(
    private opts: {
      id: string;
      mode: GeminiLiveMode;
      key: string;
      uiLang?: 'he' | 'en';
      socketFactory?: LiveSocketFactory;
      emit: (ev: GeminiLiveEvent) => void;
      onEnd?: (end: LiveSessionEnd) => void;
      now?: () => number;
      maxSeconds?: number;
      setupTimeoutMs?: number;
      /** Continue: earlier turns sent once after setup (text). */
      history?: LiveHistoryTurn[];
    }
  ) {
    this.id = opts.id;
    this.mode = opts.mode;
    this.model = opts.mode === 'dictate' ? GEMINI_TRANSCRIBE_MODEL : GEMINI_LIVE_MODEL;
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get seconds(): number {
    if (!this.startedAt) return 0;
    return Math.round(((this.endedAt || this.now()) - this.startedAt) / 100) / 10;
  }

  get isReady() {
    return this.ready && !this.ended;
  }

  /** Open the socket and send the setup; resolves when Gemini is ready (or failed). */
  start(): Promise<{ ok: boolean; reason?: string; message?: string }> {
    const done = new Promise<{ ok: boolean; reason?: string; message?: string }>((res) =>
      this.readyWaiters.push(res)
    );
    if (!this.opts.key) {
      this.fail('unconfigured', 'Gemini key is not available');
      return done;
    }
    const url = `wss://${GEMINI_LIVE_HOST}${GEMINI_LIVE_PATH}?key=${encodeURIComponent(this.opts.key)}`;
    if (!isAllowedLiveUrl(url)) {
      this.fail('endpoint-rejected', 'Live endpoint is not on the allowlist');
      return done;
    }
    openLiveGate();
    this.startedAt = this.now();
    try {
      this.ws = (this.opts.socketFactory || defaultLiveSocketFactory)(url);
    } catch (err) {
      this.fail('connect-failed', redactKey((err as Error).message, this.opts.key));
      return done;
    }
    const ws = this.ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          buildLiveSetup(this.mode, {
            uiLang: this.opts.uiLang,
            withHistory: this.mode === 'talk' && !!(this.opts.history && this.opts.history.length),
          })
        )
      );
    };
    ws.onmessage = (ev) => {
      void frameText(ev.data).then((t) => this.onMessage(t));
    };
    ws.onerror = () => {
      if (!this.ready) this.fail('connect-failed', 'Could not connect to Gemini Live');
    };
    ws.onclose = (ev) => {
      const reason = redactKey(String((ev && ev.reason) || ''), this.opts.key).slice(0, 200);
      if (!this.ready) this.fail('closed', reason || `closed (${ev && ev.code})`);
      else this.finish(reason ? `server: ${reason}` : 'server-closed');
    };
    const max = this.opts.maxSeconds || GEMINI_LIVE_MAX_SECONDS[this.mode];
    this.maxTimer = setTimeout(() => this.stop('time-limit'), max * 1000);
    setTimeout(() => {
      if (!this.ready && !this.ended) this.fail('timeout', 'Gemini Live did not answer in time');
    }, this.opts.setupTimeoutMs || 15000);
    return done;
  }

  private resolveReady(r: { ok: boolean; reason?: string; message?: string }) {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    w.forEach((f) => f(r));
  }

  private fail(reason: string, message: string) {
    this.opts.emit({ type: 'error', reason, message });
    this.resolveReady({ ok: false, reason, message });
    this.finish(reason);
  }

  private onMessage(text: string) {
    if (this.ended) return;
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.setupComplete) {
      this.ready = true;
      const h = this.mode === 'talk' ? this.opts.history || [] : [];
      if (h.length) {
        this.send({
          clientContent: {
            turns: h.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
            turnComplete: false,
          },
        });
      }
      this.opts.emit({ type: 'ready', model: this.model });
      this.resolveReady({ ok: true });
    }
    if (m.usageMetadata) {
      this.totals = addLiveUsage(this.totals, this.model, m.usageMetadata);
      const u = m.usageMetadata;
      this.opts.emit({
        type: 'usage',
        totals: this.totals,
        seconds: this.seconds,
        last: {
          prompt: Number(u.promptTokenCount) || 0,
          response: Number(u.responseTokenCount) || 0,
          total: Number(u.totalTokenCount) || 0,
        },
      });
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interimInputTranscription && sc.interimInputTranscription.text)
        this.opts.emit({
          type: 'input-text',
          text: String(sc.interimInputTranscription.text),
          final: false,
        });
      if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
        this.textChars += sc.inputTranscription.text.length;
        this.opts.emit({ type: 'input-text', text: sc.inputTranscription.text, final: true });
      }
      if (sc.outputTranscription && sc.outputTranscription.text)
        this.opts.emit({ type: 'output-text', text: String(sc.outputTranscription.text) });
      if (sc.interrupted) this.opts.emit({ type: 'interrupted' });
      const parts = (sc.modelTurn && Array.isArray(sc.modelTurn.parts) && sc.modelTurn.parts) || [];
      for (const p of parts) {
        if (p && p.inlineData && typeof p.inlineData.data === 'string')
          this.opts.emit({ type: 'audio', data: p.inlineData.data });
        else if (p && typeof p.text === 'string' && this.mode === 'dictate' && !p.thought)
          this.opts.emit({ type: 'output-text', text: p.text });
      }
      if (sc.turnComplete) this.opts.emit({ type: 'turn-complete' });
    }
    if (m.toolCall && Array.isArray(m.toolCall.functionCalls)) {
      this.opts.emit({
        type: 'tool-call',
        calls: m.toolCall.functionCalls.map((c: any) => ({
          id: String(c.id || ''),
          name: String(c.name || ''),
          args: c.args && typeof c.args === 'object' ? c.args : {},
        })),
      });
    }
    if (m.toolCallCancellation && Array.isArray(m.toolCallCancellation.ids)) {
      this.opts.emit({ type: 'tool-cancel', ids: m.toolCallCancellation.ids.map(String) });
    }
    if (m.goAway) {
      // The server ends long sessions; we stop cleanly rather than reconnect.
      this.stop('server-go-away');
    }
  }

  private send(obj: unknown): boolean {
    if (!this.ws || !this.ready || this.ended || !isLiveGateOpen()) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** 16 kHz mono 16-bit PCM from the microphone. */
  audio(chunk: Uint8Array | ArrayBuffer): boolean {
    const b = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
    if (!b || !b.byteLength || b.byteLength > 64000) return false;
    const ok = this.send({
      realtimeInput: {
        audio: {
          data: Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    });
    if (ok) this.audioSeconds += b.byteLength / 32000;
    return ok;
  }

  /** A typed message (from the conversation panel) as a user turn. */
  sendText(text: string): boolean {
    const t = String(text || '')
      .trim()
      .slice(0, 2000);
    if (!t || this.mode !== 'talk') return false;
    return this.send({
      clientContent: { turns: [{ role: 'user', parts: [{ text: t }] }], turnComplete: true },
    });
  }

  audioEnd(): boolean {
    return this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  toolResult(id: string, name: string, response: Record<string, unknown>): boolean {
    return this.send({ toolResponse: { functionResponses: [{ id, name, response }] } });
  }

  stop(reason = 'user-stopped'): { totals: LiveUsageTotals; seconds: number } {
    if (this.ws && !this.ended) {
      try {
        this.ws.close(1000, 'done');
      } catch {
        // already closed
      }
    }
    this.finish(reason);
    return { totals: this.totals, seconds: this.seconds };
  }

  private finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = this.now();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.startedAt) closeLiveGate();
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    this.resolveReady({ ok: false, reason, message: reason });
    if (!this.totals.messages && this.audioSeconds > 0) {
      this.totals = estimateLiveUsage(this.model, this.audioSeconds, this.textChars);
    }
    const seconds = this.seconds;
    this.opts.emit({ type: 'closed', reason, totals: this.totals, seconds });
    if (this.opts.onEnd && this.startedAt)
      this.opts.onEnd({ model: this.model, mode: this.mode, totals: this.totals, seconds, reason });
  }
}
