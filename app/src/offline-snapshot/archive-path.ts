/**
 * Deterministic, reversible Windows-safe relative paths for snapshot folders.
 * IMAP folder paths use `/` as the logical separator. Mapping is recorded in
 * the manifest; original folder names are not rewritten on the server.
 */
import * as path from 'path';

export type FolderPathMapping = {
  original: string;
  stored: string;
};

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_BASE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function percentEncodeChar(ch: string): string {
  return Buffer.from(ch, 'utf8')
    .reduce((acc, b) => acc + '%' + b.toString(16).toUpperCase().padStart(2, '0'), '');
}

function isTrailingSpaceOrDot(chars: string[], index: number): boolean {
  return chars.slice(index).every((c) => c === ' ' || c === '.');
}

export function encodeArchiveSegment(segment: string): string {
  if (segment === '' || segment === '.' || segment === '..') {
    return [...segment].map((c) => percentEncodeChar(c)).join('') || percentEncodeChar('_');
  }
  const chars = [...segment];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '%' || ILLEGAL.test(ch) || ((ch === ' ' || ch === '.') && isTrailingSpaceOrDot(chars, i))) {
      out += percentEncodeChar(ch);
    } else {
      out += ch;
    }
  }
  const base = out.split('.')[0];
  if (RESERVED_BASE.test(out) || RESERVED_BASE.test(base)) {
    const first = [...out][0];
    out = percentEncodeChar(first) + out.slice(first.length);
  }
  return out;
}

export function encodeArchiveRelPath(original: string): string {
  const normalized = String(original || '').replace(/\\/g, '/');
  return normalized.split('/').map(encodeArchiveSegment).join('/');
}

export function folderPathMapping(original: string): FolderPathMapping {
  return { original, stored: encodeArchiveRelPath(original) };
}

export function mappingsForFolderPaths(paths: string[]): FolderPathMapping[] {
  return paths.map(folderPathMapping);
}

/**
 * Join dest + stored relative path. On Windows, uses the \\?\ prefix when the
 * resolved path would be long, without changing the system LongPaths policy.
 */
export function toFsPath(dest: string, storedRel: string): string {
  const joined = path.join(dest, storedRel.split('/').join(path.sep));
  return maybeWindowsLongPath(joined);
}

export function maybeWindowsLongPath(absPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return absPath;
  }
  const resolved = path.resolve(absPath);
  if (resolved.startsWith('\\\\?\\')) {
    return resolved;
  }
  if (resolved.length < 240) {
    return resolved;
  }
  if (resolved.startsWith('\\\\')) {
    return '\\\\?\\UNC\\' + resolved.slice(2);
  }
  return '\\\\?\\' + resolved;
}
