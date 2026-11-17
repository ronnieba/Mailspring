/**
 * Offline experiment: attachments of local archive messages and of local drafts.
 *
 * - Attachment bytes are decoded from the local .eml (read-only).
 * - "Open" extracts one file into a temp folder INSIDE the offline profile;
 *   nothing is ever written to the archive work copy or the baseline.
 * - Files that can run code (.exe, .js, .bat, …) are flagged so the UI warns first.
 * No network.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const OFFLINE_ATTACHMENTS_TEMP_DIR = 'offline-attachments-open';
export const OFFLINE_DRAFT_FILES_DIR = 'offline-draft-files';
/** Largest single file that can be added to a local draft. */
export const OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
/** Largest image shown inline in the reader. */
export const OFFLINE_IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

const DANGEROUS_EXT = new Set([
  'exe',
  'com',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msp',
  'mst',
  'msc',
  'bat',
  'cmd',
  'js',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'wsc',
  'ps1',
  'psm1',
  'psd1',
  'ps1xml',
  'hta',
  'jar',
  'lnk',
  'url',
  'reg',
  'inf',
  'dll',
  'sys',
  'ocx',
  'scf',
  'chm',
  'application',
  'appx',
  'appxbundle',
  'msix',
  'msixbundle',
  'appref-ms',
  'gadget',
  'iso',
  'img',
  'vhd',
  'vhdx',
  'docm',
  'dotm',
  'xlsm',
  'xltm',
  'xlam',
  'pptm',
  'potm',
  'ppam',
  'sldm',
  'one',
  'library-ms',
  'settingcontent-ms',
  'search-ms',
  'diagcab',
  'xll',
  'sh',
  'command',
  'app',
  'pkg',
  'dmg',
]);

const DANGEROUS_TYPES = [
  /^application\/(x-)?(msdownload|msdos-program|ms-installer|x-msi|hta|javascript|ecmascript|java-archive|vbscript|x-sh|x-bat)/i,
  /^text\/(javascript|vbscript|x-sh)/i,
];

export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'audio'
  | 'video'
  | 'text'
  | 'mail'
  | 'danger'
  | 'other';

export function extensionOf(name: string): string {
  const base = (name || '').trim().replace(/[.\s]+$/, '');
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** True when opening the file could run a program or macro. */
export function isDangerousAttachment(name: string, contentType = ''): boolean {
  const ext = extensionOf(name);
  if (DANGEROUS_EXT.has(ext)) {
    return true;
  }
  // Double extensions hiding behind spaces ("invoice.pdf      .exe") are caught above;
  // a name with no extension but an executable type is dangerous too.
  return DANGEROUS_TYPES.some((re) => re.test(contentType || ''));
}

export function attachmentKind(name: string, contentType = ''): AttachmentKind {
  if (isDangerousAttachment(name, contentType)) {
    return 'danger';
  }
  const ext = extensionOf(name);
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('image/') || /^(png|jpe?g|gif|webp|bmp|heic|tiff?|svg|ico)$/.test(ext))
    return 'image';
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^(docx?|odt|rtf|pages)$/.test(ext) || /word/.test(ct)) return 'doc';
  if (/^(xlsx?|ods|csv|numbers)$/.test(ext) || /sheet|excel/.test(ct)) return 'sheet';
  if (/^(pptx?|odp|key)$/.test(ext) || /presentation|powerpoint/.test(ct)) return 'slides';
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(ext) || /zip|compressed|x-tar|x-rar/.test(ct))
    return 'archive';
  if (ct.startsWith('audio/') || /^(mp3|wav|m4a|ogg|flac|aac|wma)$/.test(ext)) return 'audio';
  if (ct.startsWith('video/') || /^(mp4|mov|avi|mkv|wmv|webm|m4v)$/.test(ext)) return 'video';
  if (ct === 'message/rfc822' || ext === 'eml' || ext === 'msg') return 'mail';
  if (ct.startsWith('text/') || /^(txt|log|md|json|xml|html?)$/.test(ext)) return 'text';
  return 'other';
}

export const ATTACHMENT_ICONS: { [k in AttachmentKind]: string } = {
  image: '🖼️',
  pdf: '📕',
  doc: '📘',
  sheet: '📗',
  slides: '📙',
  archive: '🗜️',
  audio: '🎵',
  video: '🎬',
  text: '📄',
  mail: '✉️',
  danger: '⚠️',
  other: '📎',
};

/** Images shown inline in the reader (no SVG: it can carry scripts). */
export function isPreviewableImage(name: string, contentType = '', size = 0): boolean {
  if (size > OFFLINE_IMAGE_PREVIEW_MAX_BYTES) {
    return false;
  }
  const ct = (contentType || '').toLowerCase();
  const ext = extensionOf(name);
  return (
    /^image\/(png|jpe?g|pjpeg|gif|webp|bmp)$/.test(ct) ||
    (ct === 'application/octet-stream' && /^(png|jpe?g|gif|webp|bmp)$/.test(ext))
  );
}

export function imageMimeFor(name: string, contentType = ''): string {
  const ct = (contentType || '').toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(ct)) return ct;
  const ext = extensionOf(name);
  return ext === 'jpg' || ext === 'jpeg' || ct === 'image/pjpeg'
    ? 'image/jpeg'
    : ext
      ? `image/${ext}`
      : 'image/png';
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A file name that is safe on Windows and cannot escape its folder. */
export function safeFileName(name: string, fallback = 'attachment'): string {
  let n = (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n || /^[._ ]+$/.test(n)) {
    n = fallback;
  }
  if (RESERVED.test(n)) {
    n = `_${n}`;
  }
  if (n.length > 120) {
    const ext = extensionOf(n);
    n = ext && ext.length < 12 ? `${n.slice(0, 110 - ext.length)}.${ext}` : n.slice(0, 120);
  }
  return n;
}

export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertInside(dir: string, p: string) {
  if (!isInside(dir, p)) {
    throw new Error('Attachment path must stay inside the offline profile');
  }
}

/** Windows "downloaded from the internet" mark, so Office / SmartScreen stay careful. */
export function markFromInternet(file: string, platform = process.platform): boolean {
  if (platform !== 'win32') {
    return false;
  }
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    return true;
  } catch (e) {
    return false;
  }
}

/** Write one attachment into <profile>/offline-attachments-open/<key>/<name> and return its path. */
export function extractAttachmentToProfile(
  configDir: string,
  messageKey: string,
  index: number,
  filename: string,
  data: Buffer
): string {
  const root = path.join(configDir, OFFLINE_ATTACHMENTS_TEMP_DIR);
  const key = crypto.createHash('sha1').update(`${messageKey}#${index}`).digest('hex').slice(0, 12);
  const dir = path.join(root, key);
  const file = path.join(dir, safeFileName(filename));
  assertInside(configDir, file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, data);
  markFromInternet(file);
  return file;
}

/** Remove opened copies left from earlier runs (best effort). */
export function cleanAttachmentTemp(configDir: string): void {
  const root = path.join(configDir, OFFLINE_ATTACHMENTS_TEMP_DIR);
  assertInside(configDir, root);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    // a file may still be open in another program; try again next start
  }
}

// ---- Files added to local drafts (kept in the profile) ----

export interface OfflineDraftAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Path relative to the profile, under offline-draft-files/<draftId>/. */
  file: string;
}

export function sanitizeDraftAttachment(
  raw: unknown,
  draftId: string
): OfflineDraftAttachment | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[\w-]{4,40}$/.test(r.id) || typeof r.file !== 'string') {
    return null;
  }
  const file = r.file.replace(/\\/g, '/');
  const prefix = `${OFFLINE_DRAFT_FILES_DIR}/${draftId}/`;
  if (!file.startsWith(prefix) || file.includes('..') || file.slice(prefix.length).includes('/')) {
    return null;
  }
  return {
    id: r.id,
    filename: typeof r.filename === 'string' ? r.filename.slice(0, 255) : 'attachment',
    contentType: typeof r.contentType === 'string' ? r.contentType.slice(0, 120) : '',
    size: typeof r.size === 'number' && isFinite(r.size) ? r.size : 0,
    file,
  };
}

export function draftFilesDir(configDir: string, draftId: string): string {
  const dir = path.join(configDir, OFFLINE_DRAFT_FILES_DIR, draftId);
  assertInside(configDir, dir);
  return dir;
}

export function draftAttachmentPath(configDir: string, a: OfflineDraftAttachment): string {
  const p = path.join(configDir, a.file);
  assertInside(path.join(configDir, OFFLINE_DRAFT_FILES_DIR), p);
  return p;
}

let attSeq = 0;
/** Store bytes as a new draft attachment inside the profile. */
export function addDraftAttachmentBytes(
  configDir: string,
  draftId: string,
  filename: string,
  contentType: string,
  data: Buffer
): OfflineDraftAttachment {
  if (data.length > OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES) {
    throw new Error('too-large');
  }
  attSeq = (attSeq + 1) % 100000;
  const id = `a${Date.now().toString(36)}${attSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = safeFileName(filename);
  const dir = draftFilesDir(configDir, draftId);
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${id}-${name}`;
  const abs = path.join(dir, stored);
  assertInside(configDir, abs);
  fs.writeFileSync(abs, data);
  return {
    id,
    filename: name,
    contentType: contentType || '',
    size: data.length,
    file: `${OFFLINE_DRAFT_FILES_DIR}/${draftId}/${stored}`,
  };
}

/** Copy a file the user picked into the draft's folder in the profile. */
export function addDraftAttachmentFromFile(
  configDir: string,
  draftId: string,
  sourcePath: string
): OfflineDraftAttachment {
  const st = fs.statSync(sourcePath);
  if (!st.isFile()) {
    throw new Error('not-a-file');
  }
  if (st.size > OFFLINE_DRAFT_ATTACHMENT_MAX_BYTES) {
    throw new Error('too-large');
  }
  return addDraftAttachmentBytes(
    configDir,
    draftId,
    path.basename(sourcePath),
    '',
    fs.readFileSync(sourcePath)
  );
}

export function removeDraftAttachmentFile(configDir: string, a: OfflineDraftAttachment): void {
  try {
    fs.rmSync(draftAttachmentPath(configDir, a), { force: true });
  } catch (e) {
    // already gone
  }
}

export function removeDraftFiles(configDir: string, draftId: string): void {
  try {
    fs.rmSync(draftFilesDir(configDir, draftId), { recursive: true, force: true });
  } catch (e) {
    // already gone
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Save-as must never land inside the archive work copy or the baseline next to it.
 */
export function isProtectedArchivePath(dest: string, archiveRoot: string | null): boolean {
  if (!archiveRoot) {
    return false;
  }
  const root = path.resolve(archiveRoot);
  const inside = (dir: string) => {
    const rel = path.relative(dir, path.resolve(dest));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(root)) {
    return true;
  }
  const parent = path.dirname(root);
  return inside(path.join(parent, 'baseline'));
}
