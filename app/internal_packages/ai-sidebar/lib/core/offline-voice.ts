/**
 * Offline experiment: voice with Gemini Live (conversation + dictation).
 * Pure helpers for the window: microphone PCM, playback decoding, the local
 * delete confirmation, silence auto-stop, and folder-name matching for the
 * go_to_folder tool. (t239).
 * No network and no key here: audio goes to the main process over IPC, and
 * only while a session the user started is running.
 */

export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_OUTPUT_RATE = 24000;
/** ~100 ms microphone chunks, as the Live API recommends. */
export const VOICE_CHUNK_SAMPLES = 1600;

/** Float samples (-1..1) → 16-bit little-endian PCM. */
export function floatTo16BitPcm(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Base64 16-bit PCM (Gemini's 24 kHz answer) → float samples. */
export function pcm16Base64ToFloat(b64: string): Float32Array {
  const bin =
    typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const n = Math.floor(bin.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (s >= 0x8000) s -= 0x10000;
    out[i] = s / 0x8000;
  }
  return out;
}

export function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i += 4) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** Linear resampling (with averaging when going down) to 16 kHz. */
export function resampleTo16k(x: Float32Array, from: number): Float32Array {
  const to = VOICE_SAMPLE_RATE;
  if (!from || Math.abs(from - to) < 1 || !x.length) return x;
  const r = from / to;
  const n = Math.max(1, Math.floor(x.length / r));
  const out = new Float32Array(n);
  const half = Math.max(0.5, r / 2);
  for (let i = 0; i < n; i++) {
    const c = i * r;
    if (r > 1) {
      const a = Math.max(0, Math.floor(c - half + 0.5));
      const b = Math.min(x.length, Math.floor(c + half + 0.5));
      let s = 0;
      for (let k = a; k < b; k++) s += x[k];
      out[i] = b > a ? s / (b - a) : 0;
    } else {
      const k = Math.floor(c);
      const fr = c - k;
      out[i] = x[k] * (1 - fr) + (k + 1 < x.length ? x[k + 1] : x[k]) * fr;
    }
  }
  return out;
}

/**
 * Delete needs a yes: the first request only arms a confirmation (shown on
 * screen; Gemini asks out loud). A confirmed call deletes only the same
 * message, and only within `ttlMs`.
 */
export class DeleteGate {
  private pending: { messageId: string; at: number } | null = null;
  constructor(private ttlMs = 60000) {}
  request(messageId: string, now = Date.now()) {
    this.pending = { messageId, at: now };
  }
  get pendingId(): string | null {
    return this.pending ? this.pending.messageId : null;
  }
  /** True when this message may be deleted now (and clears the request). */
  confirm(messageId: string, now = Date.now()): boolean {
    const p = this.pending;
    if (!p || p.messageId !== messageId || now - p.at > this.ttlMs) return false;
    this.pending = null;
    return true;
  }
  clear() {
    this.pending = null;
  }
}

/**
 * Auto-stop: true once nobody has spoken (and Gemini has not answered) for
 * `idleSec`. `lastActivity` is bumped by speech in either direction.
 */
export function shouldAutoStop(o: {
  now: number;
  lastActivity: number;
  idleSec: number;
  speaking: boolean;
}): boolean {
  return !o.speaking && o.now - o.lastActivity > o.idleSec * 1000;
}

/** Short, plain text for tool results (no markup, capped). */
export function clipForGemini(t: string, max: number): string {
  const s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- Folder names spoken loosely (go_to_folder) -------------------------------

/** Lowercase, no niqqud, no punctuation (and final letters → regular when `finals`). */
export function normalizeSpoken(t: string, finals = false): string {
  let s = String(t || '')
    .normalize('NFC')
    .replace(/[\u0591-\u05C7]/g, '');
  if (finals)
    s = s.replace(/[ךםןףץ]/g, (c) => (({ ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }) as any)[c]);
  return s
    .toLowerCase()
    .replace(/["'״׳`.,!?;:()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n];
}

export type FolderChoice = { path: string; names: string[] };

/** Best folder for a spoken name (display names, role names; loose spelling). */
export function matchFolder(spoken: string, folders: FolderChoice[]): string | null {
  const s = normalizeSpoken(spoken, true).replace(/^(ה|ל)(?=[\u05d0-\u05ea]{3})/, '');
  if (!s) return null;
  let best: { path: string; score: number } | null = null;
  for (const f of folders) {
    for (const nm of f.names) {
      const x = normalizeSpoken(nm, true);
      if (!x) continue;
      let score: number;
      if (x === s) score = 0;
      else if (x.replace(/^ה/, '') === s || s.replace(/^ה/, '') === x) score = 0.1;
      else if (x.startsWith(s) || s.startsWith(x)) score = 0.3;
      else {
        const d = editDistance(x, s);
        score = d <= Math.max(1, Math.floor(Math.max(x.length, s.length) / 4)) ? 0.5 + d / 10 : 99;
      }
      if (score < 99 && (!best || score < best.score)) best = { path: f.path, score };
    }
  }
  return best ? best.path : null;
}
