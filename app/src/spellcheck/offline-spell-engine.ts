/**
 * Private offline Hunspell WASM prototype. Separate English/Hebrew instances
 * in a child process. Does not vendor dictionary files. Never silently mutates
 * text. Never writes ~/Library/Spelling. Never constructs nspell.
 *
 * dictionary-he aff/dic: AGPL-3.0 (not an independently verified “or later”).
 * Do not publish those files or combined builds before distribution review.
 */
import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Token, stripNiqqud, tokenize } from './spell-core';
import { FIXTURE_TYPOS } from './word-lists';

export const OFFLINE_SPELL_NOTICE =
  'hunspell-asm MIT · Hunspell MPL/GPL/LGPL · dictionary-en MIT AND BSD · dictionary-he aff/dic AGPL-3.0 · private local prototype · no auto-correct';

export const LOAD_TIMEOUT_MS = 8000;
export const CORRECT_TIMEOUT_MS = 2000;
export const SUGGEST_TIMEOUT_MS = 2000;

const SIDECAR = path.join(__dirname, 'offline-prototype');
const WORKER_JS = path.join(SIDECAR, 'hunspell-worker.js');

export interface AffixCapabilityReport {
  file: string;
  hasComplexPrefixes: boolean;
  hasCircumfix: boolean;
  hasAfAliases: boolean;
  hasFullstrip: boolean;
  hasMap: boolean;
  hasBreak: boolean;
  hasIgnore: boolean;
  pfxClasses: number;
  sfxClasses: number;
  nspellUnsupportedPresent: string[];
}

export type OfflineSpellPhase =
  | 'idle'
  | 'not-installed'
  | 'loading'
  | 'ready'
  | 'timeout'
  | 'error';

export interface OfflineSpellStatus {
  available: boolean;
  english: boolean;
  hebrew: boolean;
  phase: OfflineSpellPhase;
  reason: string;
  engine: 'hunspell-asm';
  hunspellAsmVersion: string | null;
  dictionaryEn: string | null;
  dictionaryHe: string | null;
  loadMs: number;
  licenses: {
    hunspellAsm: 'MIT';
    hunspell: 'MPL-1.1 / GPL-2+ / LGPL-2.1+';
    dictionaryEn: '(MIT AND BSD)';
    dictionaryHeAffDic: 'AGPL-3.0';
  };
}

type RpcResponse = {
  id?: number;
  op?: string;
  ok?: boolean;
  result?: any;
  error?: string;
  ms?: number;
};

let child: ChildProcess | null = null;
let seq = 0;
const pending = new Map<
  number,
  {
    resolve: (v: RpcResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
let cachedStatus: OfflineSpellStatus = emptyStatus('idle', 'not started');
let loadPromise: Promise<OfflineSpellStatus> | null = null;
let lastStderr = '';

function licenses() {
  return {
    hunspellAsm: 'MIT' as const,
    hunspell: 'MPL-1.1 / GPL-2+ / LGPL-2.1+' as const,
    dictionaryEn: '(MIT AND BSD)' as const,
    dictionaryHeAffDic: 'AGPL-3.0' as const,
  };
}

function emptyStatus(phase: OfflineSpellPhase, reason: string): OfflineSpellStatus {
  return {
    available: false,
    english: false,
    hebrew: false,
    phase,
    reason,
    engine: 'hunspell-asm',
    hunspellAsmVersion: null,
    dictionaryEn: null,
    dictionaryHe: null,
    loadMs: 0,
    licenses: licenses(),
  };
}

function candidateRoots(): string[] {
  const extra = process.env.MAILSPRING_OFFLINE_SPELL_DIR;
  return [
    extra || '',
    path.join(SIDECAR, 'node_modules'),
    path.join(process.cwd(), 'app/src/spellcheck/offline-prototype/node_modules'),
    path.join(process.cwd(), 'src/spellcheck/offline-prototype/node_modules'),
  ].filter(Boolean);
}

export function resolveDictionaryFiles(pkg: 'dictionary-en' | 'dictionary-he'): {
  aff: string;
  dic: string;
  root: string;
} | null {
  for (const root of candidateRoots()) {
    const aff = path.join(root, pkg, 'index.aff');
    const dic = path.join(root, pkg, 'index.dic');
    if (fs.existsSync(aff) && fs.existsSync(dic)) {
      return { aff, dic, root };
    }
  }
  return null;
}

export function inspectAffixFile(affPath: string): AffixCapabilityReport {
  const text = fs.readFileSync(affPath, 'utf8');
  const has = (re: RegExp) => re.test(text);
  const pfxClasses = (text.match(/^PFX \S+ [YN] \d+/gm) || []).length;
  const sfxClasses = (text.match(/^SFX \S+ [YN] \d+/gm) || []).length;
  const unsupported: string[] = [];
  if (has(/^COMPLEXPREFIXES/m)) unsupported.push('COMPLEXPREFIXES');
  if (has(/^CIRCUMFIX /m)) unsupported.push('CIRCUMFIX');
  if (has(/^AF /m)) unsupported.push('AF');
  if (has(/^FULLSTRIP/m)) unsupported.push('FULLSTRIP');
  if (has(/^MAP /m)) unsupported.push('MAP');
  if (has(/^BREAK /m)) unsupported.push('BREAK');
  if (has(/^IGNORE /m)) unsupported.push('IGNORE');
  return {
    file: affPath,
    hasComplexPrefixes: has(/^COMPLEXPREFIXES/m),
    hasCircumfix: has(/^CIRCUMFIX /m),
    hasAfAliases: has(/^AF /m),
    hasFullstrip: has(/^FULLSTRIP/m),
    hasMap: has(/^MAP /m),
    hasBreak: has(/^BREAK /m),
    hasIgnore: has(/^IGNORE /m),
    pfxClasses,
    sfxClasses,
    nspellUnsupportedPresent: unsupported,
  };
}

export function peekOfflineSpellStatus(): OfflineSpellStatus {
  return cachedStatus;
}

function hunspellAsmVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SIDECAR, 'node_modules', 'hunspell-asm', 'package.json'), 'utf8')
    );
    return pkg.version || null;
  } catch {
    return null;
  }
}

function rejectAll(err: Error) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function killWorker(reason: string) {
  loadPromise = null;
  const proc = child;
  child = null;
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // already gone
      }
    }, 1000);
  }
  rejectAll(Object.assign(new Error(reason), { timedOut: /timeout/i.test(reason) }));
}

function spawnWorker(): ChildProcess {
  lastStderr = '';
  const proc = fork(WORKER_JS, [], {
    cwd: SIDECAR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    silent: true,
  });
  proc.stderr?.on('data', (buf: Buffer) => {
    lastStderr = (lastStderr + buf.toString('utf8')).slice(-4000);
  });
  proc.on('message', (msg: RpcResponse) => {
    if (!msg || msg.id == null) {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) {
      return;
    }
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) {
      child = null;
      loadPromise = null;
      if (cachedStatus.phase === 'ready' || cachedStatus.phase === 'loading') {
        cachedStatus = {
          ...cachedStatus,
          available: false,
          phase: 'error',
          reason: `hunspell worker exited code=${code} signal=${signal}`,
        };
      }
    }
    rejectAll(
      new Error(`hunspell worker exited code=${code} signal=${signal} stderr=${lastStderr}`)
    );
  });
  proc.on('error', (err) => {
    rejectAll(err);
  });
  return proc;
}

function rpc(payload: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
  if (!child || child.killed) {
    child = spawnWorker();
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      cachedStatus = {
        ...cachedStatus,
        available: false,
        phase: 'timeout',
        reason: `TIMEOUT ${timeoutMs}ms op=${payload.op}`,
      };
      killWorker(`TIMEOUT ${timeoutMs}ms op=${payload.op}`);
      reject(
        Object.assign(new Error(`TIMEOUT ${timeoutMs}ms op=${payload.op}`), {
          timedOut: true,
          op: payload.op,
        })
      );
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child!.send({ ...payload, id });
    } catch (err: any) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function disposeOfflineSpellEngine(): Promise<void> {
  loadPromise = null;
  if (!child) {
    cachedStatus = emptyStatus('idle', 'disposed');
    return;
  }
  try {
    await rpc({ op: 'dispose' }, 1000);
  } catch {
    // kill below
  }
  killWorker('dispose');
  cachedStatus = emptyStatus('idle', 'disposed');
}

export function peekOfflineFilesInstalled(): boolean {
  return !!(resolveDictionaryFiles('dictionary-en') && resolveDictionaryFiles('dictionary-he'));
}

/**
 * Sync peek of files + last worker status. Does not construct nspell or Hunspell.
 */
export function loadOfflineSpellEngineSync(): OfflineSpellStatus {
  if (!peekOfflineFilesInstalled()) {
    cachedStatus = emptyStatus(
      'not-installed',
      'Local dictionaries not installed. Run app/src/spellcheck/offline-prototype/install.sh (does not touch app/package-lock.json). dictionary-he aff/dic are AGPL-3.0 — do not commit node_modules.'
    );
  }
  return cachedStatus;
}

export async function loadOfflineSpellEngine(force = false): Promise<OfflineSpellStatus> {
  if (cachedStatus.available && !force) {
    return cachedStatus;
  }
  if (
    !force &&
    (cachedStatus.phase === 'timeout' || cachedStatus.phase === 'error') &&
    !loadPromise
  ) {
    return cachedStatus;
  }
  if (loadPromise && !force) {
    return loadPromise;
  }
  loadPromise = (async () => {
    const t0 = Date.now();
    const enFiles = resolveDictionaryFiles('dictionary-en');
    const heFiles = resolveDictionaryFiles('dictionary-he');
    if (!enFiles && !heFiles) {
      cachedStatus = emptyStatus(
        'not-installed',
        'Local dictionaries not installed. Run app/src/spellcheck/offline-prototype/install.sh (does not touch app/package-lock.json). dictionary-he aff/dic are AGPL-3.0 — do not commit node_modules.'
      );
      return cachedStatus;
    }
    if (!fs.existsSync(WORKER_JS)) {
      cachedStatus = emptyStatus('error', 'hunspell-worker.js missing');
      return cachedStatus;
    }
    cachedStatus = {
      ...emptyStatus('loading', 'loading Hunspell WASM in child process'),
      dictionaryEn: enFiles ? enFiles.root : null,
      dictionaryHe: heFiles ? heFiles.root : null,
      hunspellAsmVersion: hunspellAsmVersion(),
    };
    try {
      const res = await rpc(
        {
          op: 'load',
          enAff: enFiles ? enFiles.aff : null,
          enDic: enFiles ? enFiles.dic : null,
          heAff: heFiles ? heFiles.aff : null,
          heDic: heFiles ? heFiles.dic : null,
        },
        LOAD_TIMEOUT_MS
      );
      if (!res.ok) {
        cachedStatus = {
          ...emptyStatus('error', res.error || 'hunspell load failed'),
          dictionaryEn: enFiles ? enFiles.root : null,
          dictionaryHe: heFiles ? heFiles.root : null,
          hunspellAsmVersion: hunspellAsmVersion(),
          loadMs: Date.now() - t0,
        };
        return cachedStatus;
      }
      cachedStatus = {
        available: !!(res.result && (res.result.english || res.result.hebrew)),
        english: !!(res.result && res.result.english),
        hebrew: !!(res.result && res.result.hebrew),
        phase: 'ready',
        reason: OFFLINE_SPELL_NOTICE,
        engine: 'hunspell-asm',
        hunspellAsmVersion: hunspellAsmVersion(),
        dictionaryEn: enFiles ? enFiles.root : null,
        dictionaryHe: heFiles ? heFiles.root : null,
        loadMs: typeof res.ms === 'number' ? res.ms : Date.now() - t0,
        licenses: licenses(),
      };
      return cachedStatus;
    } catch (err: any) {
      const timedOut = !!(err && err.timedOut);
      cachedStatus = {
        ...emptyStatus(
          timedOut ? 'timeout' : 'error',
          String(err && err.message ? err.message : err) +
            (lastStderr ? ` stderr=${lastStderr}` : '')
        ),
        dictionaryEn: enFiles ? enFiles.root : null,
        dictionaryHe: heFiles ? heFiles.root : null,
        hunspellAsmVersion: hunspellAsmVersion(),
        loadMs: Date.now() - t0,
      };
      return cachedStatus;
    }
  })();
  return loadPromise;
}

export function offlineAffixReports(): {
  en: AffixCapabilityReport | null;
  he: AffixCapabilityReport | null;
} {
  const enFiles = resolveDictionaryFiles('dictionary-en');
  const heFiles = resolveDictionaryFiles('dictionary-he');
  return {
    en: enFiles ? inspectAffixFile(enFiles.aff) : null,
    he: heFiles ? inspectAffixFile(heFiles.aff) : null,
  };
}

function lookupWord(word: string, script: Token['script']): string {
  if (script === 'he') return stripNiqqud(word);
  return word;
}

export async function offlineCorrect(
  word: string,
  script: Token['script']
): Promise<boolean | null> {
  const status = await loadOfflineSpellEngine();
  if (!status.available) return null;
  const key = lookupWord(word, script);
  try {
    const res = await rpc({ op: 'correct', lang: script, word: key }, CORRECT_TIMEOUT_MS);
    if (!res.ok) return null;
    return !!res.result;
  } catch {
    return null;
  }
}

export async function offlineSuggest(
  word: string,
  script: Token['script'],
  limit = 5
): Promise<string[]> {
  const status = await loadOfflineSpellEngine();
  if (!status.available) return [];
  const key = lookupWord(word, script);
  const res = await rpc({ op: 'suggest', lang: script, word: key, limit }, SUGGEST_TIMEOUT_MS);
  if (!res.ok) {
    throw Object.assign(new Error(res.error || 'suggest failed'), { op: 'suggest' });
  }
  const raw: string[] = Array.isArray(res.result) ? res.result : [];
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !s || s === word || s === key) continue;
    if (script === 'he' && !/[\u05D0-\u05EA]/.test(s)) continue;
    if (script === 'en' && !/[A-Za-z]/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export interface OfflineTypo extends Token {
  suggestions: string[];
  backend: 'hunspell';
}

export async function findOfflineTypos(
  text: string,
  personal: Iterable<string> = [],
  opts: { includeSuggestions?: boolean } = {}
): Promise<OfflineTypo[]> {
  const status = await loadOfflineSpellEngine();
  if (!status.available) return [];
  const skip = new Set(Array.from(personal).map((w) => w.toLowerCase()));
  const tokens = tokenize(text).filter((t) => {
    if (FIXTURE_TYPOS[t.word]) return false;
    if (skip.has(t.word.toLowerCase()) || skip.has(t.word)) return false;
    return true;
  });
  if (!tokens.length) return [];
  const res = await rpc(
    {
      op: 'correctMany',
      items: tokens.map((t) => ({ word: lookupWord(t.word, t.script), lang: t.script })),
    },
    CORRECT_TIMEOUT_MS
  );
  if (!res.ok || !Array.isArray(res.result)) {
    throw new Error(res.error || 'correctMany failed');
  }
  const out: OfflineTypo[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const row = res.result[i];
    if (!row || row.correct === null || row.correct) continue;
    out.push({
      ...t,
      backend: 'hunspell',
      suggestions: opts.includeSuggestions ? await offlineSuggest(t.word, t.script) : [],
    });
  }
  return out;
}
