/**
 * Offline experiment (t233): local voice with Whisper (whisper.cpp).
 * Pure helpers: where Whisper lives, WAV encoding, splitting at pauses,
 * whisper-cli arguments, reading its JSON, spoken punctuation, and the
 * rule-based parser for voice commands. Audio never leaves the PC: the
 * recording is written to a temp file, transcribed by the local
 * whisper-cli, and deleted. No network here.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const WHISPER_DIR_NAME = 'MailAI-Whisper';
export const VOICE_SAMPLE_RATE = 16000;
/** Longest recording (seconds); it stops by itself after that. */
export const VOICE_MAX_SECONDS = 120;
/** Model order when voice.json doesn't name one. */
export const WHISPER_MODEL_PREFERENCE = [
  'ggml-medium-q5_0.bin',
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-medium.bin',
  'ggml-small.bin',
  'ggml-small-q5_1.bin',
  'ggml-base.bin',
];

/** Model order for the GPU (CUDA) build: the bigger, more accurate turbo model first. */
export const WHISPER_GPU_MODEL_PREFERENCE = [
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo.bin',
  ...WHISPER_MODEL_PREFERENCE.filter((n) => !n.includes('turbo')),
];

export type WhisperSetup = {
  dir: string;
  cli: string;
  model: string;
  modelName: string;
  modelBytes: number;
  /** CUDA build (bin-cuda); falls back to the CPU build if it fails. */
  gpu: boolean;
};

/** Folders where the local Whisper may be (first existing wins). */
export function whisperDirCandidates(
  env: { [k: string]: string | undefined } = process.env,
  platform: string = process.platform,
  home: string = os.homedir()
): string[] {
  const out: string[] = [];
  if (env.MAILAI_WHISPER_DIR) out.push(env.MAILAI_WHISPER_DIR);
  if (platform === 'win32') {
    out.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), WHISPER_DIR_NAME));
  } else if (platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', WHISPER_DIR_NAME));
  } else {
    out.push(path.join(home, '.local', 'share', WHISPER_DIR_NAME));
  }
  return out;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readVoiceJson(dir: string): any {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * The whisper-cli and model in `dir`, or null. CPU build in bin/, CUDA build
 * in bin-cuda/ (opts.gpu). voice.json {"model": "...", "gpuModel": "...",
 * "gpu": false} picks the models / turns the GPU off.
 */
export function findWhisperIn(
  dir: string,
  platform: string = process.platform,
  opts: { gpu?: boolean } = {}
): WhisperSetup | null {
  const exe = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const bin = opts.gpu ? 'bin-cuda' : 'bin';
  const conf = readVoiceJson(dir);
  if (opts.gpu && conf.gpu === false) return null;
  const cli = [
    path.join(dir, bin, 'Release', exe),
    path.join(dir, bin, exe),
    ...(opts.gpu ? [] : [path.join(dir, exe)]),
  ].find(isFile);
  if (!cli) return null;
  const models = path.join(dir, 'models');
  const key = opts.gpu ? 'gpuModel' : 'model';
  const wanted: string | null =
    typeof conf[key] === 'string' && /^[\w.-]+\.bin$/.test(conf[key]) ? conf[key] : null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(models).filter((n) => /^ggml-[\w.-]+\.bin$/.test(n));
  } catch {
    return null;
  }
  const pick =
    (wanted && names.includes(wanted) && wanted) ||
    (opts.gpu ? WHISPER_GPU_MODEL_PREFERENCE : WHISPER_MODEL_PREFERENCE).find((n) =>
      names.includes(n)
    ) ||
    names.sort()[0];
  if (!pick) return null;
  const model = path.join(models, pick);
  let modelBytes = 0;
  try {
    modelBytes = fs.statSync(model).size;
  } catch {
    return null;
  }
  return {
    dir,
    cli,
    model,
    modelName: pick.replace(/^ggml-|\.bin$/g, ''),
    modelBytes,
    gpu: !!opts.gpu,
  };
}

/** GPU (CUDA) and CPU setups from the first folder that has either. */
export function findWhisperSetups(dirs: string[] = whisperDirCandidates()): {
  gpu: WhisperSetup | null;
  cpu: WhisperSetup | null;
} {
  for (const d of dirs) {
    const gpu = process.platform === 'win32' ? findWhisperIn(d, 'win32', { gpu: true }) : null;
    const cpu = findWhisperIn(d);
    if (gpu || cpu) return { gpu, cpu };
  }
  return { gpu: null, cpu: null };
}

/** Preferred setup: the GPU build when present, else the CPU build. */
export function findWhisper(dirs: string[] = whisperDirCandidates()): WhisperSetup | null {
  const s = findWhisperSetups(dirs);
  return s.gpu || s.cpu;
}

/** Did whisper-cli really run on the GPU (its log on stderr)? */
export function whisperUsedGpu(stderr: string): boolean {
  return /using CUDA\d* backend|CUDA\d+ total size/.test(String(stderr || ''));
}

/** 16-bit mono PCM WAV. */
export function encodeWav16(samples: Float32Array, rate: number = VOICE_SAMPLE_RATE): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/** 16-bit PCM WAV (mono or stereo, any rate) → mono float samples at 16 kHz. */
export function decodeWav(buf: Buffer): Float32Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a WAV file');
  let off = 12;
  let ch = 1;
  let rate = VOICE_SAMPLE_RATE;
  let bits = 16;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      ch = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    }
    off += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error('only 16-bit PCM WAV');
  const frames = Math.floor(data.length / (2 * ch));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2);
    mono[i] = s / ch / 0x8000;
  }
  if (rate === VOICE_SAMPLE_RATE) return mono;
  const n = Math.floor((frames * VOICE_SAMPLE_RATE) / rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / VOICE_SAMPLE_RATE;
    const a = Math.floor(x);
    const t = x - a;
    out[i] = (mono[a] || 0) * (1 - t) + (mono[Math.min(frames - 1, a + 1)] || 0) * t;
  }
  return out;
}

/**
 * Split a recording at pauses so each part gets its own language guess
 * (Hebrew and English in one recording). Returns [start, end) sample ranges;
 * silent parts are dropped; short parts join their neighbour.
 */
export function splitOnSilence(
  samples: Float32Array,
  rate: number = VOICE_SAMPLE_RATE,
  opts: { minPause?: number; minPart?: number; maxParts?: number } = {}
): Array<[number, number]> {
  const minPause = opts.minPause ?? 0.9;
  const minPart = opts.minPart ?? 1.6;
  const maxParts = opts.maxParts ?? 8;
  const frame = Math.round(rate * 0.03);
  const n = Math.floor(samples.length / frame);
  if (!n) return [];
  const rms: number[] = [];
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += samples[i] * samples[i];
    rms.push(Math.sqrt(s / frame));
  }
  const sorted = rms.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const peak = sorted[Math.floor(sorted.length * 0.98)] || 0;
  if (peak < 0.01) return [];
  const thr = Math.max(0.008, Math.min(floor * 3, peak * 0.25), peak * 0.06);
  const voiced = rms.map((v) => v >= thr);
  const pauseFrames = Math.round(minPause / 0.03);
  const parts: Array<[number, number]> = [];
  let start = -1;
  let quiet = 0;
  for (let f = 0; f < n; f++) {
    if (voiced[f]) {
      if (start < 0) start = f;
      quiet = 0;
    } else if (start >= 0) {
      quiet++;
      if (quiet >= pauseFrames) {
        parts.push([start, f - quiet + 1]);
        start = -1;
        quiet = 0;
      }
    }
  }
  if (start >= 0) parts.push([start, n - quiet]);
  // Drop clicks, join short parts to the previous one.
  const joined: Array<[number, number]> = [];
  for (const p of parts) {
    if ((p[1] - p[0]) * 0.03 < 0.15) continue;
    const last = joined[joined.length - 1];
    if (last && ((p[1] - p[0]) * 0.03 < minPart || (last[1] - last[0]) * 0.03 < minPart))
      last[1] = p[1];
    else joined.push([p[0], p[1]]);
  }
  while (joined.length > maxParts) {
    // Merge the pair with the shortest gap.
    let best = 0;
    for (let i = 1; i < joined.length - 1; i++) {
      if (joined[i + 1][0] - joined[i][1] < joined[best + 1][0] - joined[best][1]) best = i;
    }
    joined.splice(best, 2, [joined[best][0], joined[best + 1][1]]);
  }
  const pad = Math.round(0.2 / 0.03);
  return joined.map(([a, b]) => [Math.max(0, a - pad) * frame, Math.min(n, b + pad) * frame]);
}

/** Arguments for one whisper-cli run over one or more WAV files. */
export function whisperArgs(o: {
  model: string;
  files: string[];
  lang: string;
  threads: number;
  longestSec: number;
  gpu?: boolean;
}): string[] {
  const a = [
    '-m',
    o.model,
    '-l',
    o.lang,
    '-t',
    String(Math.max(1, Math.min(32, o.threads))),
    '-nt',
    '-oj',
  ];
  // GPU runs keep the log on stderr: it is how a silent CPU run is detected (whisperUsedGpu).
  if (!o.gpu) a.splice(a.indexOf('-nt') + 1, 0, '-np');
  // Short audio: a smaller audio context is much faster on CPU (the window is 30 s otherwise).
  // (The GPU is fast with the full context, which is a bit more accurate.)
  if (!o.gpu && o.longestSec > 0 && o.longestSec < 14) a.push('-ac', '768');
  for (const f of o.files) a.push('-f', f);
  return a;
}

/** JSON whisper-cli wrote next to `wav` (x.wav.json, or x.json). */
export function whisperJsonPathCandidates(wav: string): string[] {
  return [`${wav}.json`, wav.replace(/\.wav$/i, '.json')];
}

export function parseWhisperJson(text: string): { text: string; lang: string } {
  const j = JSON.parse(text.replace(/^\uFEFF/, ''));
  const segs = Array.isArray(j.transcription) ? j.transcription : [];
  const t = segs.map((s: any) => String((s && s.text) || '')).join('');
  return { text: cleanTranscript(t), lang: String((j.result && j.result.language) || '') };
}

/** Remove whisper's non-speech tags ([BLANK_AUDIO], (music)…) and extra spaces. */
export function cleanTranscript(t: string): string {
  return String(t || '')
    .replace(
      /\[[^\]]{1,40}\]|\((?:music|applause|laughter|silence|מוזיקה|שקט)[^)]*\)|\*[^*]{1,30}\*/gi,
      ' '
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.?!:;])/g, '$1')
    .trim();
}

const SPOKEN_PUNCT: Array<[RegExp, string]> = [
  [/(^|\s)(?:שורה חדשה|ירידת שורה|new line)[.,]?(?=\s|$)/gi, '\n'],
  [/(^|\s)(?:סימן שאלה|question mark)[.,]?(?=\s|$)/gi, '?'],
  [/(^|\s)(?:סימן קריאה|exclamation mark)[.,]?(?=\s|$)/gi, '!'],
  [/(^|\s)(?:נקודתיים|colon)[.,]?(?=\s|$)/gi, ':'],
  [/(^|\s)(?:פסיק|comma)[.,]?(?=\s|$)/gi, ','],
  [/(^|\s)(?:נקודה|full stop|period)[.,]?(?=\s|$)/gi, '.'],
];

/** Spoken punctuation ("פסיק", "נקודה", "סימן שאלה", "שורה חדשה", "comma"…) → marks. */
export function applySpokenPunctuation(t: string): string {
  let s = ` ${t} `;
  for (const [re, mark] of SPOKEN_PUNCT) s = s.replace(re, mark === '\n' ? '\n' : mark);
  return s
    .replace(/[ \t]+([,.?!:])/g, '$1')
    .replace(/([,.?!:])(?=[^\s\d,.?!:\n])/g, '$1 ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/g, '');
}

/** Languages kept from auto-detection; anything else is re-done in the UI language. */
export function acceptDetectedLang(lang: string): boolean {
  return lang === 'he' || lang === 'iw' || lang === 'en';
}

// ---- Voice commands ---------------------------------------------------

export type VoiceCommand =
  | { kind: 'new-draft' }
  | { kind: 'search'; query: string }
  | { kind: 'ask'; question: string }
  | { kind: 'folder'; name: string }
  | { kind: 'delete' }
  | { kind: 'archive' }
  | { kind: 'star' }
  | { kind: 'unread' }
  | { kind: 'reply'; instruction: string }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

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

const near = (w: string, target: string, max = 1) => editDistance(w, target) <= max;

/** "תיקייה" heard loosely (לתיקייה, התיקייה, תיקיית, לתקיעה…). */
function isFolderWord(w: string): boolean {
  const x = w.replace(/^(ל|ה|לה|אל)(?=ת)/, '');
  return (
    (x.length >= 4 &&
      /^ת/.test(x) &&
      ['תיקיה', 'תיקייה', 'תיקית', 'תיקיית', 'תקיה', 'תקייה'].some((t) => near(x, t, 2))) ||
    w === 'folder' ||
    w === 'the folder'
  );
}

const STAR_WORD = /^(ב|ל)?(כו|קו)[כחק]ב(ים)?$/;

/**
 * Rule-based voice command parser (Hebrew + English). Nothing is sent
 * anywhere: the result only drives local actions in the app.
 */
export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = cleanTranscript(raw)
    .replace(/[.!]+$/, '')
    .trim();
  const n = normalizeSpoken(text);
  const w = n.split(' ').filter(Boolean);
  if (!w.length) return { kind: 'unknown', text };
  const rest = (k: number) => {
    // Keep the original wording (with final letters) for the argument.
    const orig = text
      .replace(/["'״׳`]/g, '')
      .split(/\s+/)
      .filter((x) => /[\p{L}\p{N}]/u.test(x));
    return orig
      .slice(k)
      .join(' ')
      .replace(/[.,!?]+$/, '')
      .trim();
  };

  // New draft
  if (
    /^(פתח|תפתח|צור|תיצור|כתוב|תכתוב|התחל|פתחתי)( את)? (טיוטה|טיוטא|מייל|מכתב|הודעה|אותה)( חדשה| חדש)?$/.test(
      n
    ) ||
    /^(טיוטה|מייל|הודעה) (חדשה|חדש)$/.test(n) ||
    /^(new|start a new|create a new|write a new|open a new|compose a new) (draft|email|mail|message)$/.test(
      n
    ) ||
    /^(compose|new draft)$/.test(n)
  ) {
    return { kind: 'new-draft' };
  }
  // Help / guide
  if (/^(עזרה|מדריך|הצג מדריך|help|show the guide|guide)$/.test(n)) return { kind: 'help' };
  // Search
  if (/^(חפש|תחפש|חיפוש|תמצא|מצא)$/.test(w[0]) && w.length > 1) {
    const k = w[1] === 'את' || w[1] === 'אחרי' ? 2 : 1;
    const q = rest(k);
    if (q) return { kind: 'search', query: q };
  }
  if (/^(search|find)$/.test(w[0]) && w.length > 1) {
    const k = w[1] === 'for' ? 2 : 1;
    const q = rest(k);
    if (q) return { kind: 'search', query: q };
  }
  if (w[0] === 'look' && w[1] === 'for' && w.length > 2) return { kind: 'search', query: rest(2) };
  // Ask (fills the search box; the user clicks Ask AI)
  if (/^(שאל|תשאל|שאלה)$/.test(w[0]) && w.length > 1) return { kind: 'ask', question: rest(1) };
  if (w[0] === 'ask' && w.length > 1) return { kind: 'ask', question: rest(1) };
  // Reply with AI ("תענה ש…": fills the AI write box; never sends)
  if (/^(תענה|ענה|תנה|תנא|תענא|תעני|עני|תשיב|השב|תגיב|הגב)$/.test(w[0]) && w.length > 1) {
    let k = 1;
    if (w[k] === 'לו' || w[k] === 'לה' || w[k] === 'להם') k++;
    let ins = rest(k).replace(/^(ש|כי)\s+/, '');
    if (/^ש[\u05d0-\u05ea]{2,}/.test(ins) && !/^(שלום|שבוע|שנה|שעה|שאלה|שבת)/.test(ins))
      ins = ins.slice(1);
    if (ins) return { kind: 'reply', instruction: ins };
  }
  if (/^(reply|answer|respond)$/.test(w[0]) && w.length > 1) {
    let k = 1;
    if (/^(to|him|her|them)$/.test(w[k])) k++;
    if (/^(that|saying|with)$/.test(w[k])) k++;
    const ins = rest(k);
    if (ins) return { kind: 'reply', instruction: ins };
  }
  // Folder
  {
    let k = -1;
    if (/^(עבור|תעבור|עבול|עבו|עבר|לך|תלך|פתח|תפתח|הצג|תציג|היכנס|כנס|תיכנס)$/.test(w[0])) {
      k = 1;
      if (w[k] === 'ל' || w[k] === 'אל') k++;
      if (w[k] && isFolderWord(w[k])) k++;
      else if (w[0] === 'פתח' || w[0] === 'תפתח' || w[0] === 'הצג' || w[0] === 'תציג') k = -1;
    } else if (/^(go|switch|open|show)$/.test(w[0])) {
      k = 1;
      if (w[k] === 'to') k++;
      if (w[k] === 'the') k++;
      if (w[k] === 'folder') k++;
      else if (w[0] === 'open' || w[0] === 'show') k = -1;
    } else if (isFolderWord(w[0]) && w.length > 1) {
      k = 1;
    }
    if (k > 0 && k < w.length) {
      const name = rest(k)
        .replace(/\s+(folder|תיקייה|תיקיה)$/i, '')
        .trim();
      if (name) return { kind: 'folder', name };
    }
  }
  // Actions on the selected message
  if (
    /^(מחק|תמחק|מחקי|תמחקי|מחיקה|זרוק|לפח)( את)?( ההודעה| המייל| זה| זאת| אותו| אותה)?$/.test(n) ||
    /^(delete|trash|remove)( it| this| this message| the message)?$/.test(n)
  ) {
    return { kind: 'delete' };
  }
  if (
    /^((ה|ת)?עבר|תעביר|העבר|שלח)? ?(ל|אל )?ארכיון$/.test(n) ||
    /^(ארכב|תארכב)( את)?( ההודעה| זה)?$/.test(n) ||
    /^(archive)( it| this| this message)?$/.test(n)
  ) {
    return { kind: 'archive' };
  }
  if (
    (w.length <= 3 &&
      w.some((x) => STAR_WORD.test(x)) &&
      (w.length === 1 || /^(סמן|תסמן|הוסף|תוסיף|שים)$/.test(w[0]))) ||
    /^(star|add star|star it|star this|star this message)$/.test(n)
  ) {
    return { kind: 'star' };
  }
  if (
    /^(סמן|תסמן) (כ|כ )?(לא נקרא|לא נקראה|שלא נקרא)$/.test(n) ||
    /^mark (it |this )?(as )?unread$/.test(n)
  ) {
    return { kind: 'unread' };
  }
  return { kind: 'unknown', text };
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
