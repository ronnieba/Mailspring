/**
 * Display-only MIME decode for a local archive working copy.
 * Raw .eml bytes on disk remain the source of truth. This is not a complete
 * MIME implementation: nested message/rfc822, uuencode, and exotic charsets
 * are not fully parsed and are disclosed in `notes`.
 */

export function stripRemoteHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(
      /(<(?:img|iframe|video|audio|source|link)\b[^>]*\s(?:src|href|poster|srcset)\s*=\s*)(['"])\s*https?:\/\/[^'"]*\2/gi,
      '$1$2#$2'
    )
    .replace(/url\(\s*['"]?https?:\/\/[^)]+\)/gi, 'url(#)');
}

export type MimeDisplay = {
  subject: string;
  from: string;
  date: string;
  bodyText: string;
  attachmentCount: number;
  notes: string[];
};

export function decodeRfc2047(raw: string): string {
  return raw.replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_m, charset, enc, data) => {
    try {
      const buf =
        String(enc).toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : decodeQuotedPrintable(data.replace(/_/g, ' '));
      return buf.toString(charsetName(charset));
    } catch {
      return raw;
    }
  });
}

export function decodeQuotedPrintable(raw: string): Buffer {
  const soft = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function charsetName(cs: string): BufferEncoding {
  const n = String(cs || 'utf-8').toLowerCase();
  if (n === 'utf-8' || n === 'utf8') {
    return 'utf8';
  }
  if (n === 'us-ascii' || n === 'ascii') {
    return 'ascii';
  }
  return 'latin1';
}

function headerValue(headers: string, name: string): string {
  const folded = headers.replace(/\n[ \t]+/g, ' ');
  const match = folded.match(new RegExp(`^${name}:(.*)$`, 'im'));
  return match ? match[1].trim() : '';
}

function splitParts(raw: string, boundary: string): string[] {
  const token = `--${boundary}`;
  const chunks = raw.split(token);
  return chunks
    .map((c) => c.replace(/^\r?\n/, '').replace(/--\s*$/, ''))
    .filter((c) => c.trim() && c.trim() !== '--');
}

export function displayFromRfc822(raw: string): MimeDisplay {
  const notes: string[] = ['display-parse-partial'];
  const normalized = raw.replace(/\r\n/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  const headerText = headerEnd === -1 ? normalized : normalized.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : normalized.slice(headerEnd + 2);
  const subject = decodeRfc2047(headerValue(headerText, 'subject') || '(No Subject)');
  const from = decodeRfc2047(headerValue(headerText, 'from') || '(Unknown)');
  const date = headerValue(headerText, 'date');
  const ct = headerValue(headerText, 'content-type');
  const cte = headerValue(headerText, 'content-transfer-encoding').toLowerCase();
  const attachmentCount = countAttachments(normalized);
  let bodyText = '';

  const boundaryM = ct.match(/boundary="?([^";\s]+)"?/i);
  if (boundaryM) {
    notes.push('multipart');
    const parts = splitParts(body, boundaryM[1]);
    let plain = '';
    let html = '';
    for (const part of parts) {
      const pEnd = part.indexOf('\n\n');
      const pHead = pEnd === -1 ? part : part.slice(0, pEnd);
      const pBody = pEnd === -1 ? '' : part.slice(pEnd + 2);
      const pct = headerValue(pHead, 'content-type').toLowerCase();
      const pdis = headerValue(pHead, 'content-disposition').toLowerCase();
      const pcte = headerValue(pHead, 'content-transfer-encoding').toLowerCase();
      if (pdis.includes('attachment') || /name=/i.test(pct)) {
        if (!pdis.includes('attachment') && /name=/i.test(pct) && !pct.startsWith('text/')) {
          notes.push('name-param-attachment');
        }
      }
      if (pct.startsWith('text/plain') && !pdis.includes('attachment')) {
        plain = decodePartBody(pBody, pcte, pct);
      } else if (pct.startsWith('text/html') && !pdis.includes('attachment')) {
        html = decodePartBody(pBody, pcte, pct);
      }
      if (pct.startsWith('message/rfc822')) {
        notes.push('nested-message-rfc822-not-expanded');
      }
    }
    bodyText = plain || stripRemoteHtml(html);
  } else {
    bodyText = decodePartBody(body, cte, ct);
    if (/html/i.test(ct)) {
      bodyText = stripRemoteHtml(bodyText);
    }
  }

  bodyText = stripRemoteHtml(bodyText).replace(/\s+/g, ' ').trim();
  return { subject, from, date, bodyText, attachmentCount, notes };
}

function decodePartBody(body: string, cte: string, ct: string): string {
  const cs = (ct.match(/charset="?([^";\s]+)"?/i) || [])[1] || 'utf-8';
  let buf: Buffer;
  if (cte === 'base64') {
    buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  } else if (cte === 'quoted-printable') {
    buf = decodeQuotedPrintable(body);
  } else {
    buf = Buffer.from(body, 'latin1');
  }
  try {
    return buf.toString(charsetName(cs));
  } catch {
    return buf.toString('utf8');
  }
}

function countAttachments(raw: string): number {
  const disp = raw.match(/Content-Disposition:\s*attachment/gi);
  return disp ? disp.length : 0;
}
