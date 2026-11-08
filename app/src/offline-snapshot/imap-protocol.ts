import { imapUtf7 } from '../utils/imap-utf7';

export type ListMailbox = {
  attrs: string[];
  delimiter: string;
  raw: string;
  unicode: string;
  selectable: boolean;
};

export function quoteImapMailbox(raw: string): string {
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function decodeMailboxName(raw: string): string {
  const trimmed = raw.trim();
  let inner = trimmed;
  if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
    inner = inner.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return imapUtf7.decode(inner);
}

export function parseListLine(line: string): ListMailbox | null {
  const m = line.match(/^\* LIST \(([^)]*)\) ("(?:\\.|[^"])*"|NIL|[^ ]+) (.+)$/i);
  if (!m) {
    return null;
  }
  const attrs = m[1]
    .split(/\s+/)
    .map((a) => a.trim())
    .filter(Boolean);
  let delimiter = m[2];
  if (delimiter.toUpperCase() === 'NIL') {
    delimiter = '';
  } else if (delimiter.startsWith('"')) {
    delimiter = delimiter.slice(1, -1).replace(/\\"/g, '"');
  }
  const rawToken = m[3].trim();
  const unicode = decodeMailboxName(rawToken);
  const raw = rawToken.startsWith('"')
    ? rawToken.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : rawToken;
  const selectable = !attrs.some((a) => /^\\(NoSelect|NonExistent)$/i.test(a));
  return { attrs, delimiter, raw, unicode, selectable };
}

export function parseExamineMeta(lines: string[]): {
  exists: number | null;
  uidvalidity: number | null;
  uidnext: number | null;
  readOnly: boolean;
} {
  let exists: number | null = null;
  let uidvalidity: number | null = null;
  let uidnext: number | null = null;
  let readOnly = false;
  for (const line of lines) {
    const ex = line.match(/^\* (\d+) EXISTS\b/i);
    if (ex) {
      exists = parseInt(ex[1], 10);
    }
    const uv = line.match(/\[UIDVALIDITY (\d+)\]/i);
    if (uv) {
      uidvalidity = parseInt(uv[1], 10);
    }
    const un = line.match(/\[UIDNEXT (\d+)\]/i);
    if (un) {
      uidnext = parseInt(un[1], 10);
    }
    if (/\[READ-ONLY\]/i.test(line)) {
      readOnly = true;
    }
  }
  return { exists, uidvalidity, uidnext, readOnly };
}

export type FetchSizeRow = {
  uid: number;
  size: number | null;
  flags: string[];
};

export function parseFetchSizeLine(line: string): FetchSizeRow | null {
  if (!/^\* \d+ FETCH /i.test(line)) {
    return null;
  }
  const uidM = line.match(/\bUID (\d+)\b/i);
  if (!uidM) {
    return null;
  }
  const sizeM = line.match(/\bRFC822\.SIZE (\d+)\b/i);
  const flagsM = line.match(/\bFLAGS \(([^)]*)\)/i);
  const flags = flagsM
    ? flagsM[1]
        .split(/\s+/)
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  return {
    uid: parseInt(uidM[1], 10),
    size: sizeM ? parseInt(sizeM[1], 10) : null,
    flags,
  };
}

export function uidGaps(uids: number[]): number[] {
  if (uids.length === 0) {
    return [];
  }
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let u = sorted[0]; u <= sorted[sorted.length - 1]; u++) {
    if (!sorted.includes(u)) {
      gaps.push(u);
    }
  }
  return gaps;
}

export function redactImapLog(command: string): string {
  const n = command.replace(/^\S+\s+/, '');
  if (/^LOGIN\b/i.test(n) || /^AUTHENTICATE\b/i.test(n)) {
    return 'LOGIN (redacted)';
  }
  return command.replace(/\r/g, '').slice(0, 200);
}
