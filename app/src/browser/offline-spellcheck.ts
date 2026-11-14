/**
 * Offline experiment: local spell check for Hebrew and English, no network.
 *
 * Chromium's spellchecker (Hunspell, plus the Windows spell checker where it
 * applies) reads .bdic dictionaries from <profile>/Dictionaries. Normally it
 * downloads missing ones from Google; the offline experiment never does:
 * the download URL points at a closed local port, and the offline network
 * guard blocks remote hosts anyway. Instead, dictionaries already on this
 * computer (installed by Microsoft Edge / Google Chrome / CEF apps) are copied
 * once into the offline profile. Nothing is downloaded or uploaded.
 */
import fs from 'fs';
import path from 'path';

export const OFFLINE_SPELL_LANGUAGES = ['he', 'en-US'];
/** Never reachable: dictionary downloads stay off. */
export const OFFLINE_SPELL_DOWNLOAD_URL = 'http://127.0.0.1:9/';
/** Chromium dictionary file name prefixes for the two languages. */
export const OFFLINE_DICTIONARY_PREFIXES = ['he-IL-', 'en-US-'];

export function localDictionarySourceDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  if (env.MAILSPRING_OFFLINE_DICTIONARIES_DIR) {
    dirs.push(env.MAILSPRING_OFFLINE_DICTIONARIES_DIR);
  }
  const local = env.LOCALAPPDATA;
  if (local) {
    for (const rel of [
      'Microsoft/Edge/User Data/Dictionaries',
      'Microsoft/Edge/User Data',
      'Google/Chrome/User Data/Dictionaries',
      'Google/Chrome/User Data',
      'BraveSoftware/Brave-Browser/User Data/Dictionaries',
      'CEF/User Data/Dictionaries',
    ]) {
      dirs.push(path.join(local, rel));
    }
  }
  return dirs;
}

export type DictionaryCopy = { from: string; to: string };

/**
 * For each language with no dictionary in `targetDir`, pick the newest-named
 * matching .bdic from the source listings.
 */
export function planDictionaryCopies(
  targetDir: string,
  targetFiles: string[],
  sources: { dir: string; files: string[] }[]
): DictionaryCopy[] {
  const out: DictionaryCopy[] = [];
  for (const prefix of OFFLINE_DICTIONARY_PREFIXES) {
    if (targetFiles.some((f) => f.startsWith(prefix) && f.endsWith('.bdic'))) {
      continue;
    }
    const candidates: { dir: string; file: string }[] = [];
    for (const s of sources) {
      for (const f of s.files) {
        if (f.startsWith(prefix) && /^[\w-]+\.bdic$/.test(f)) {
          candidates.push({ dir: s.dir, file: f });
        }
      }
    }
    candidates.sort((a, b) => b.file.localeCompare(a.file, 'en', { numeric: true }));
    if (candidates[0]) {
      out.push({
        from: path.join(candidates[0].dir, candidates[0].file),
        to: path.join(targetDir, candidates[0].file),
      });
    }
  }
  return out;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Copy missing dictionaries into <profile>/Dictionaries. Local files only. */
export function ensureOfflineSpellDictionaries(
  profileDir: string,
  env: NodeJS.ProcessEnv = process.env
): { copied: string[]; present: string[] } {
  const target = path.join(profileDir, 'Dictionaries');
  const plan = planDictionaryCopies(
    target,
    listDir(target),
    localDictionarySourceDirs(env).map((dir) => ({ dir, files: listDir(dir) }))
  );
  const copied: string[] = [];
  for (const c of plan) {
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(c.from, c.to);
      copied.push(path.basename(c.to));
    } catch {
      // Unreadable source: spell check for that language stays off.
    }
  }
  return { copied, present: listDir(target).filter((f) => f.endsWith('.bdic')) };
}

type SpellSession = {
  setSpellCheckerDictionaryDownloadURL?: (url: string) => void;
  setSpellCheckerEnabled?: (on: boolean) => void;
  setSpellCheckerLanguages?: (langs: string[]) => void;
  availableSpellCheckerLanguages?: string[];
};

export function configureOfflineSpellcheck(ses: SpellSession): string[] {
  try {
    ses.setSpellCheckerDictionaryDownloadURL?.(OFFLINE_SPELL_DOWNLOAD_URL);
  } catch {
    // Older Electron: the network guard still blocks downloads.
  }
  try {
    ses.setSpellCheckerEnabled?.(true);
  } catch {
    // ignore
  }
  const available = ses.availableSpellCheckerLanguages || OFFLINE_SPELL_LANGUAGES;
  const langs = OFFLINE_SPELL_LANGUAGES.filter((l) => available.includes(l));
  try {
    if (langs.length) {
      ses.setSpellCheckerLanguages?.(langs);
    }
  } catch {
    // Unknown codes throw on some platforms.
  }
  return langs;
}
