/**
 * Fail-closed IMAP session. Every outbound command is allowlisted.
 * STORE/SELECT/BODY[]/RFC822 never leave this process.
 */
import * as net from 'net';
import * as tls from 'tls';
import { assertReadOnlyImapCommand } from '../../internal_packages/ai-sidebar/lib/core/offline-imap-snapshot-plan';
import {
  FetchSizeRow,
  ListMailbox,
  parseExamineMeta,
  parseFetchSizeLine,
  parseListLine,
  quoteImapMailbox,
  redactImapLog,
} from './imap-protocol';
import { SnapshotConnectTarget, TLS_CONNECT_OPTIONS } from './yahoo-config';

export type SnapshotLog = (line: string) => void;

/**
 * The server refused (NO/BAD) or returned no body for one UID. Message-level:
 * the caller may skip this UID and continue; never a mailbox mutation.
 */
export class SnapshotMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotMessageError';
  }
}

export class SnapshotAuthError extends Error {
  constructor(message = 'LOGIN failed') {
    super(message);
    this.name = 'SnapshotAuthError';
  }
}

type LineWaiter = {
  match: (line: string) => boolean;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
};

export class ReadOnlyImapSession {
  private sock: net.Socket | tls.TLSSocket | null = null;
  private buf = Buffer.alloc(0);
  private tagSeq = 0;
  private waiters: LineWaiter[] = [];
  private lines: string[] = [];
  private log: SnapshotLog;
  private closed = false;

  constructor(log: SnapshotLog = () => undefined) {
    this.log = log;
  }

  get connected(): boolean {
    return !!this.sock && !this.sock.destroyed && !this.closed;
  }

  async connect(target: SnapshotConnectTarget, timeoutMs = 10000): Promise<void> {
    // Waiter + data handler must exist before the greeting can arrive.
    const greeting = this.readGreeting();
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error) => reject(err);
        const bind = (sock: net.Socket | tls.TLSSocket) => {
          this.sock = sock;
          this.closed = false;
          sock.setTimeout(timeoutMs);
          sock.on('data', (c) => this.onData(c));
          sock.on('error', (e) => this.failWaiters(e));
          sock.on('timeout', () => {
            this.failWaiters(new Error('IMAP socket timeout'));
            sock.destroy();
          });
          sock.on('close', () => this.failWaiters(new Error('IMAP socket closed')));
        };
        if (target.tls) {
          const sock = tls.connect({
            host: target.host,
            port: target.port,
            servername: target.servername || target.host,
            ...TLS_CONNECT_OPTIONS,
          });
          bind(sock);
          sock.once('error', onErr);
          sock.once('secureConnect', () => {
            sock.off('error', onErr);
            resolve();
          });
        } else {
          const sock = net.connect({ host: target.host, port: target.port });
          bind(sock);
          sock.once('error', onErr);
          sock.once('connect', () => {
            sock.off('error', onErr);
            resolve();
          });
        }
      });
    } catch (err) {
      this.failWaiters(err as Error);
      throw err;
    }
    await greeting;
  }

  async login(username: string, password: string): Promise<void> {
    const u = quoteImapMailbox(username);
    const p = quoteImapMailbox(password);
    const lines = await this.command(`LOGIN ${u} ${p}`);
    const tagged = lines.filter((l) => !/^\*/.test(l));
    if (tagged.some((l) => / AUTHENTICATIONFAILED/i.test(l) || / NO /i.test(l))) {
      throw new SnapshotAuthError('LOGIN failed');
    }
    if (!lines.some((l) => / OK /i.test(l) && !/^\*/.test(l))) {
      throw new SnapshotAuthError('LOGIN failed');
    }
  }

  async capability(): Promise<string[]> {
    const lines = await this.command('CAPABILITY');
    const cap = lines.find((l) => /^\* CAPABILITY /i.test(l));
    return cap ? cap.replace(/^\* CAPABILITY /i, '').split(/\s+/) : [];
  }

  async listAll(): Promise<ListMailbox[]> {
    const lines = await this.command('LIST "" "*"');
    const out: ListMailbox[] = [];
    for (const line of lines) {
      const parsed = parseListLine(line);
      if (parsed) {
        out.push(parsed);
      }
    }
    return out;
  }

  async examine(rawMailbox: string): Promise<{
    exists: number | null;
    uidvalidity: number | null;
    uidnext: number | null;
    readOnly: boolean;
    ok: boolean;
    lines: string[];
  }> {
    const lines = await this.command(`EXAMINE ${quoteImapMailbox(rawMailbox)}`);
    const ok = lines.some((l) => / OK /i.test(l) && !/^\*/.test(l));
    return { ...parseExamineMeta(lines), ok, lines };
  }

  async fetchSizes(timeoutMs = 60000): Promise<FetchSizeRow[]> {
    const lines = await this.command('UID FETCH 1:* (RFC822.SIZE FLAGS UID)', timeoutMs);
    const rows: FetchSizeRow[] = [];
    for (const line of lines) {
      const row = parseFetchSizeLine(line);
      if (row) {
        rows.push(row);
      }
    }
    return rows;
  }

  /** Diagnostic: RFC822.SIZE for one UID (read-only, no body). */
  async fetchUidSize(uid: number, timeoutMs = 30000): Promise<number | null> {
    const lines = await this.command(`UID FETCH ${uid} (RFC822.SIZE)`, timeoutMs);
    const tagged = lines[lines.length - 1] || '';
    if (!/ OK /i.test(tagged)) {
      return null;
    }
    for (const line of lines) {
      const m = line.match(/RFC822\.SIZE (\d+)/i);
      if (m && new RegExp(`UID ${uid}\\b`).test(line)) {
        return parseInt(m[1], 10);
      }
    }
    return null;
  }

  /**
   * UID FETCH n BODY.PEEK[section]. section '' is the whole RFC822 message;
   * 'HEADER' / 'TEXT' are used only to reassemble a message the server refuses
   * to return whole. PEEK never sets \Seen.
   */
  async fetchBodyPeek(
    uid: number,
    timeoutMs = 20000,
    section: '' | 'HEADER' | 'TEXT' = ''
  ): Promise<Buffer> {
    const tag = this.nextTag();
    const cmd = `${tag} UID FETCH ${uid} BODY.PEEK[${section}]`;
    const allowed = assertReadOnlyImapCommand(cmd);
    if (!allowed.ok) {
      throw new Error(allowed.reason);
    }
    this.log(`imap> ${redactImapLog(cmd)}`);
    if (!this.sock) {
      throw new Error('not connected');
    }
    this.sock.setTimeout(Math.max(timeoutMs + 5000, 15000));
    this.lastLiteral = null;
    const pending = this.readBodyLiteral(tag, uid, timeoutMs, section === 'TEXT');
    this.sock.write(Buffer.from(cmd + '\r\n'));
    return pending;
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT', 5000);
    } catch {
      // ignore
    }
    this.destroy();
  }

  /** Drop the socket without LOGOUT. Pending waiters fail; used before reconnect. */
  destroy() {
    this.closed = true;
    const sock = this.sock;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.lastLiteral = null;
    if (sock) {
      sock.removeAllListeners('data');
      sock.removeAllListeners('timeout');
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this.failWaiters(new Error('IMAP socket closed'));
  }

  /** Test helper: attempting a forbidden command must throw before write. */
  assertForbidden(raw: string): { ok: boolean; reason: string } {
    return assertReadOnlyImapCommand(raw);
  }

  private async command(rest: string, timeoutMs = 30000): Promise<string[]> {
    const tag = this.nextTag();
    const cmd = `${tag} ${rest}`;
    const allowed = assertReadOnlyImapCommand(cmd);
    if (!allowed.ok) {
      throw new Error(allowed.reason);
    }
    this.log(`imap> ${redactImapLog(cmd)}`);
    if (!this.sock) {
      throw new Error('not connected');
    }
    const collected: string[] = [];
    let waiter: LineWaiter;
    const done = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('IMAP timeout'));
      }, timeoutMs);
      const check = (line: string) => {
        collected.push(line);
        return line.startsWith(`${tag} `);
      };
      waiter = {
        match: check,
        resolve: () => {
          clearTimeout(timer);
          resolve(collected);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(waiter);
    });
    this.sock.write(Buffer.from(cmd + '\r\n'));
    return done;
  }

  private async readGreeting(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IMAP greeting timeout')), 10000);
      this.waiters.push({
        match: (line) => /^\* OK /i.test(line),
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private nextTag(): string {
    this.tagSeq += 1;
    return `A${this.tagSeq}`;
  }

  private failWaiters(err: Error) {
    const w = this.waiters.splice(0);
    for (const x of w) {
      x.reject(err);
    }
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.consumeLines();
  }

  lastLiteral: Buffer | null = null;

  private notify(line: string) {
    const waiters = this.waiters.slice();
    for (const w of waiters) {
      if (w.match(line)) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(line);
      }
    }
  }

  private consumeLines() {
    for (let idx = this.buf.indexOf('\n'); idx !== -1; idx = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, idx).toString('utf8').replace(/\r$/, '');
      if (/^\* BYE\b/i.test(line)) {
        this.buf = this.buf.slice(idx + 1);
        this.lines.push(line);
        this.notify(line);
        this.failWaiters(new Error('IMAP BYE'));
        return;
      }
      const lit = line.match(/\{(\d+)\}\s*$/);
      if (lit) {
        const size = parseInt(lit[1], 10);
        const after = this.buf.slice(idx + 1);
        if (after.length < size) {
          return;
        }
        this.lastLiteral = Buffer.from(after.slice(0, size));
        this.buf = after.slice(size);
        this.lines.push(line);
        this.notify(line);
        continue;
      }
      this.buf = this.buf.slice(idx + 1);
      this.lines.push(line);
      this.notify(line);
    }
  }

  private readBodyLiteral(
    tag: string,
    uid: number,
    timeoutMs: number,
    allowEmpty = false
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const waiter: LineWaiter = {
        match: (line) => line.startsWith(`${tag} `),
        resolve: (line) => {
          clearTimeout(timer);
          if (!/ OK /i.test(line)) {
            const status = / BAD /i.test(line) ? 'BAD' : / NO /i.test(line) ? 'NO' : 'other';
            reject(new SnapshotMessageError(`UID FETCH ${uid} failed status=${status}`));
            return;
          }
          if (allowEmpty && (!this.lastLiteral || this.lastLiteral.length === 0)) {
            resolve(Buffer.alloc(0));
            return;
          }
          if (!this.lastLiteral || this.lastLiteral.length === 0) {
            reject(new SnapshotMessageError(`UID FETCH ${uid} missing BODY literal`));
            return;
          }
          resolve(this.lastLiteral);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('IMAP BODY.PEEK timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}
