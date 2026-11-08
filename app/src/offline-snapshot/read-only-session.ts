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

export class ReadOnlyImapSession {
  private sock: net.Socket | tls.TLSSocket | null = null;
  private buf = Buffer.alloc(0);
  private tagSeq = 0;
  private waiters: Array<{
    match: (line: string) => boolean;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = [];
  private lines: string[] = [];
  private log: SnapshotLog;

  constructor(log: SnapshotLog = () => undefined) {
    this.log = log;
  }

  async connect(target: SnapshotConnectTarget, timeoutMs = 10000): Promise<void> {
    // Waiter + data handler must exist before the greeting can arrive.
    const greeting = this.readGreeting();
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error) => reject(err);
        const bind = (sock: net.Socket | tls.TLSSocket) => {
          this.sock = sock;
          sock.setTimeout(timeoutMs);
          sock.on('data', (c) => this.onData(c));
          sock.on('error', (e) => this.failWaiters(e));
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
    if (!lines.some((l) => / OK /i.test(l))) {
      throw new Error('LOGIN failed');
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

  async fetchSizes(): Promise<FetchSizeRow[]> {
    const lines = await this.command('UID FETCH 1:* (RFC822.SIZE FLAGS UID)');
    const rows: FetchSizeRow[] = [];
    for (const line of lines) {
      const row = parseFetchSizeLine(line);
      if (row) {
        rows.push(row);
      }
    }
    return rows;
  }

  async fetchBodyPeek(uid: number): Promise<Buffer> {
    const tag = this.nextTag();
    const cmd = `${tag} UID FETCH ${uid} BODY.PEEK[]`;
    const allowed = assertReadOnlyImapCommand(cmd);
    if (!allowed.ok) {
      throw new Error(allowed.reason);
    }
    this.log(`imap> ${redactImapLog(cmd)}`);
    if (!this.sock) {
      throw new Error('not connected');
    }
    this.lastLiteral = null;
    const pending = this.readBodyLiteral(tag, uid);
    this.sock.write(Buffer.from(cmd + '\r\n'));
    return pending;
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      // ignore
    }
    this.sock?.destroy();
    this.sock = null;
  }

  /** Test helper: attempting a forbidden command must throw before write. */
  assertForbidden(raw: string): { ok: boolean; reason: string } {
    return assertReadOnlyImapCommand(raw);
  }

  private async command(rest: string): Promise<string[]> {
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
    const done = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IMAP timeout')), 15000);
      const check = (line: string) => {
        collected.push(line);
        return line.startsWith(`${tag} `);
      };
      this.waiters.push({
        match: check,
        resolve: () => {
          clearTimeout(timer);
          resolve(collected);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
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

  private readBodyLiteral(tag: string, uid: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IMAP BODY.PEEK timeout')), 20000);
      this.waiters.push({
        match: (line) => line.startsWith(`${tag} `),
        resolve: (line) => {
          clearTimeout(timer);
          if (!/ OK /i.test(line)) {
            reject(new Error(`UID FETCH ${uid} failed`));
            return;
          }
          if (!this.lastLiteral || this.lastLiteral.length === 0) {
            reject(new Error(`UID FETCH ${uid} missing BODY literal`));
            return;
          }
          resolve(this.lastLiteral);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}
