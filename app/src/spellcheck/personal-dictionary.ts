import * as fs from 'fs';
import * as path from 'path';

export const PERSONAL_DICTIONARY_FILENAME = 'spell-personal-dictionary.json';

export function personalDictionaryPath(configDirPath: string): string {
  return path.join(configDirPath, PERSONAL_DICTIONARY_FILENAME);
}

export function isUnsafeDictionaryPath(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  if (normalized.includes(`${path.sep}Library${path.sep}Spelling`)) {
    return true;
  }
  if (normalized.includes(`${path.sep}Mailspring${path.sep}${PERSONAL_DICTIONARY_FILENAME}`)) {
    const demo = normalized.includes(`${path.sep}Mailspring-demo${path.sep}`);
    const dev = normalized.includes(`${path.sep}Mailspring-dev${path.sep}`);
    if (!demo && !dev) {
      return true;
    }
  }
  return false;
}

export class PersonalDictionary {
  private words = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    public readonly filePath: string,
    private io: {
      readFileSync: typeof fs.readFileSync;
      writeFileSync: typeof fs.writeFileSync;
    } = fs
  ) {
    this.load();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  load(): Set<string> {
    this.words = new Set();
    try {
      const raw = this.io.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.words)) {
        for (const w of parsed.words) {
          if (typeof w === 'string' && w.trim()) this.words.add(w.trim());
        }
      }
    } catch (err: any) {
      if (!err || err.code !== 'ENOENT') {
        // Missing file is empty dict. Other errors leave empty rather than throw in UI.
      }
    }
    return this.words;
  }

  has(word: string): boolean {
    return this.words.has(word) || this.words.has(word.toLowerCase());
  }

  list(): string[] {
    return [...this.words];
  }

  add(word: string): void {
    const w = word.trim();
    if (!w) return;
    this.words.add(w);
    this.save();
    this.notify();
  }

  remove(word: string): void {
    this.words.delete(word);
    this.words.delete(word.toLowerCase());
    this.save();
    this.notify();
  }

  private save() {
    if (isUnsafeDictionaryPath(this.filePath)) {
      throw new Error('Refusing to write personal dictionary outside the app config dir');
    }
    this.io.writeFileSync(this.filePath, JSON.stringify({ words: this.list() }, null, 2), 'utf8');
  }
}

// Module holder for the demo/renderer dictionary. Must be `let`: install/ensure rebind it.
let active: PersonalDictionary | null = null;

export function installPersonalDictionary(dict: PersonalDictionary | null) {
  active = dict;
}

export function getActivePersonalDictionary(): PersonalDictionary | null {
  return active;
}

export function ensurePersonalDictionary(configDirPath: string): PersonalDictionary {
  const filePath = personalDictionaryPath(configDirPath);
  if (isUnsafeDictionaryPath(filePath)) {
    throw new Error('Refusing to open personal dictionary outside an isolated config dir');
  }
  if (active && active.filePath === filePath) {
    return active;
  }
  active = new PersonalDictionary(filePath);
  return active;
}
