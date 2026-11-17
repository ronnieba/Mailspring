/**
 * Local IMAP4rev1 stub for unit tests. Never binds a public interface.
 * Messages are @example.test fixtures only.
 */
import * as net from 'net';
import { imapUtf7 } from '../utils/imap-utf7';

export type FakeMessage = {
  uid: number;
  flags: string[];
  raw: Buffer;
};

export type FakeFolder = {
  raw: string;
  attrs: string[];
  uidvalidity: number;
  uidnext: number;
  messages: FakeMessage[];
};

const CRLF = '\r\n';

export function fixtureRfc822(opts: {
  subject: string;
  from?: string;
  body: string;
  extraHeaders?: string;
}): Buffer {
  const from = opts.from || 'Archive Sender <archive-sender@example.test>';
  const text = [
    `From: ${from}`,
    'To: Archive Reader <archive-reader@example.test>',
    `Subject: ${opts.subject}`,
    'Date: Fri, 01 Nov 2024 10:00:00 +0000',
    `Message-ID: <${Math.random().toString(16).slice(2)}@example.test>`,
    'MIME-Version: 1.0',
    opts.extraHeaders || 'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body,
    '',
  ].join('\r\n');
  return Buffer.from(text, 'utf8');
}

export function defaultFakeFolders(): FakeFolder[] {
  const hebrewName = imapUtf7.encode('תיקייה');
  const hebrewBody = Buffer.from('שלום מארכיון מקומי', 'utf8').toString('base64');
  const hebrewSub = `=?UTF-8?B?${Buffer.from('שלום', 'utf8').toString('base64')}?=`;
  const htmlMixed = [
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><script>alert(1)</script><img src="https://evil.example.test/x.png"><p>html-part</p></body></html>',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Disposition: attachment; filename="note.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('fixture-attachment', 'utf8').toString('base64'),
    '--b1--',
    '',
  ].join('\r\n');
  return [
    {
      raw: 'INBOX',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 100,
      uidnext: 6,
      messages: [
        {
          uid: 1,
          flags: ['\\Seen'],
          raw: fixtureRfc822({ subject: 'Inbox one', body: 'one' }),
        },
        {
          uid: 2,
          flags: [],
          raw: fixtureRfc822({
            subject: 'Inbox unread',
            body: 'unread-body',
          }),
        },
        {
          uid: 5,
          flags: ['\\Seen'],
          raw: fixtureRfc822({
            subject: 'Inbox with attachment',
            extraHeaders: htmlMixed.split('\r\n')[0],
            body: htmlMixed.split('\r\n').slice(1).join('\r\n'),
          }),
        },
      ],
    },
    {
      raw: 'Sent',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 200,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          flags: ['\\Seen'],
          raw: fixtureRfc822({
            subject: 'Sent fixture',
            from: 'Archive Reader <archive-reader@example.test>',
            body: 'sent-body',
          }),
        },
      ],
    },
    {
      raw: 'Draft',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 300,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          flags: ['\\Draft'],
          raw: fixtureRfc822({ subject: 'Draft fixture', body: 'draft-body' }),
        },
      ],
    },
    {
      raw: 'Bulk Mail',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 400,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          flags: ['\\Seen'],
          raw: fixtureRfc822({ subject: 'Bulk fixture', body: 'bulk-body' }),
        },
      ],
    },
    {
      raw: 'Spam',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 500,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          flags: [],
          raw: fixtureRfc822({ subject: 'Spam fixture', body: 'spam-body' }),
        },
      ],
    },
    {
      raw: 'Trash',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 600,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          flags: ['\\Seen'],
          raw: fixtureRfc822({ subject: 'Trash fixture', body: 'trash-body' }),
        },
      ],
    },
    {
      raw: 'Starred',
      attrs: ['\\HasNoChildren'],
      uidvalidity: 700,
      uidnext: 1,
      messages: [],
    },
    {
      raw: hebrewName,
      attrs: ['\\HasNoChildren'],
      uidvalidity: 800,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          flags: ['\\Seen'],
          raw: fixtureRfc822({
            subject: hebrewSub,
            extraHeaders: [
              'Content-Type: text/plain; charset=UTF-8',
              'Content-Transfer-Encoding: base64',
            ].join('\r\n'),
            body: hebrewBody,
          }),
        },
      ],
    },
    {
      raw: 'Noselect',
      attrs: ['\\Noselect', '\\HasChildren'],
      uidvalidity: 0,
      uidnext: 1,
      messages: [],
    },
  ];
}

function findFolder(folders: FakeFolder[], name: string): FakeFolder | undefined {
  const n = name.replace(/^"/, '').replace(/"$/, '').replace(/\\"/g, '"');
  return folders.find((f) => f.raw === n || f.raw.toLowerCase() === n.toLowerCase());
}

export type FakeImapServer = {
  port: number;
  host: string;
  storeCommands: string[];
  successfulBodyPeeks: number;
  hangNextBodyPeeks: number;
  destroyNextBodyPeeks: number;
  /** After this many successful BODY.PEEKs, destroy every later BODY.PEEK. */
  destroyEveryBodyPeekAfter: number | null;
  rejectLogin: boolean;
  onBodyPeekDestroy: (() => void) | null;
  /** UIDs whose BODY.PEEK[] is answered with a tagged NO (like Yahoo did). */
  refuseBodyPeekUids: Set<number>;
  /** UIDs whose BODY.PEEK[HEADER]/[TEXT] are refused as well. */
  refuseSectionUids: Set<number>;
  /** UID -> delta added to the advertised RFC822.SIZE (Yahoo-style approximate sizes). */
  sizeSkew: Map<number, number>;
  inject(folderRaw: string, message: FakeMessage): void;
  messagesOf(folderRaw: string): FakeMessage[];
  setUidvalidity(folderRaw: string, uidvalidity: number): void;
  close(): Promise<void>;
};

export function startFakeImapServer(opts?: {
  user?: string;
  password?: string;
  folders?: FakeFolder[];
}): Promise<FakeImapServer> {
  const user = opts?.user || 'archive-user@example.test';
  const password = opts?.password || 'test-password-not-yahoo';
  const folders = opts?.folders || defaultFakeFolders();
  const storeCommands: string[] = [];
  const sockets = new Set<net.Socket>();
  const ctrl = {
    successfulBodyPeeks: 0,
    hangNextBodyPeeks: 0,
    destroyNextBodyPeeks: 0,
    destroyEveryBodyPeekAfter: null as number | null,
    rejectLogin: false,
    onBodyPeekDestroy: null as (() => void) | null,
    refuseBodyPeekUids: new Set<number>(),
    refuseSectionUids: new Set<number>(),
    sizeSkew: new Map<number, number>(),
  };

  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = Buffer.alloc(0);
      let authed = false;
      let selected: FakeFolder | null = null;
      sock.write(Buffer.from('* OK IMAP4rev1 fake ready' + CRLF));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (let idx = buf.indexOf('\n'); idx !== -1; idx = buf.indexOf('\n')) {
          let line = buf.slice(0, idx + 1).toString('utf8');
          buf = buf.slice(idx + 1);
          line = line.replace(/\r?\n$/, '');
          const sp = line.indexOf(' ');
          const tag = sp === -1 ? line : line.slice(0, sp);
          const rest = sp === -1 ? '' : line.slice(sp + 1);
          const upper = rest.toUpperCase();
          const reply = (s: string) => sock.write(Buffer.from(s + CRLF));
          if (
            /^(STORE|UID STORE|EXPUNGE|UID EXPUNGE|MOVE|UID MOVE|APPEND|COPY|UID COPY|SELECT)\b/.test(
              upper
            )
          ) {
            storeCommands.push(rest);
            reply(`${tag} NO read-only fake server refuses mutation`);
            continue;
          }
          if (upper === 'CAPABILITY') {
            reply('* CAPABILITY IMAP4rev1 AUTH=PLAIN');
            reply(`${tag} OK CAPABILITY`);
            continue;
          }
          if (upper.startsWith('LOGIN ')) {
            const m = rest.match(/^LOGIN\s+(\S+)\s+(.+)$/i);
            const u = m ? unquote(m[1]) : '';
            const p = m ? unquote(m[2]) : '';
            if (ctrl.rejectLogin || u !== user || p !== password) {
              reply(`${tag} NO [AUTHENTICATIONFAILED] LOGIN failed`);
            } else {
              authed = true;
              reply(`${tag} OK LOGIN`);
            }
            continue;
          }
          if (upper === 'LOGOUT') {
            reply('* BYE');
            reply(`${tag} OK LOGOUT`);
            sock.end();
            continue;
          }
          if (!authed) {
            reply(`${tag} NO not authenticated`);
            continue;
          }
          if (upper.startsWith('LIST ')) {
            for (const f of folders) {
              const attrs = f.attrs.join(' ');
              const name = /[ "]/.test(f.raw) ? `"${f.raw.replace(/"/g, '\\"')}"` : f.raw;
              reply(`* LIST (${attrs}) "/" ${name}`);
            }
            reply(`${tag} OK LIST`);
            continue;
          }
          if (upper.startsWith('EXAMINE ')) {
            const name = unquote(rest.slice('EXAMINE '.length).trim());
            const f = findFolder(folders, name);
            if (!f || f.attrs.some((a) => /^\\Noselect$/i.test(a))) {
              reply(`${tag} NO EXAMINE failed`);
              selected = null;
              continue;
            }
            selected = f;
            reply(`* ${f.messages.length} EXISTS`);
            reply('* 0 RECENT');
            reply(`* OK [UIDVALIDITY ${f.uidvalidity}]`);
            reply(`* OK [UIDNEXT ${f.uidnext}]`);
            reply('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
            reply('* OK [PERMANENTFLAGS ()]');
            reply(`${tag} OK [READ-ONLY] EXAMINE`);
            continue;
          }
          if (upper.startsWith('UID FETCH ')) {
            if (!selected) {
              reply(`${tag} NO no mailbox`);
              continue;
            }
            handleUidFetch(selected, rest, tag, sock, ctrl);
            continue;
          }
          if (upper === 'NOOP') {
            reply(`${tag} OK NOOP`);
            continue;
          }
          reply(`${tag} BAD unknown`);
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('fake IMAP listen failed'));
        return;
      }
      resolve({
        port: addr.port,
        host: '127.0.0.1',
        storeCommands,
        refuseBodyPeekUids: ctrl.refuseBodyPeekUids,
        refuseSectionUids: ctrl.refuseSectionUids,
        sizeSkew: ctrl.sizeSkew,
        get successfulBodyPeeks() {
          return ctrl.successfulBodyPeeks;
        },
        get hangNextBodyPeeks() {
          return ctrl.hangNextBodyPeeks;
        },
        set hangNextBodyPeeks(n: number) {
          ctrl.hangNextBodyPeeks = n;
        },
        get destroyNextBodyPeeks() {
          return ctrl.destroyNextBodyPeeks;
        },
        set destroyNextBodyPeeks(n: number) {
          ctrl.destroyNextBodyPeeks = n;
        },
        get destroyEveryBodyPeekAfter() {
          return ctrl.destroyEveryBodyPeekAfter;
        },
        set destroyEveryBodyPeekAfter(n: number | null) {
          ctrl.destroyEveryBodyPeekAfter = n;
        },
        get rejectLogin() {
          return ctrl.rejectLogin;
        },
        set rejectLogin(v: boolean) {
          ctrl.rejectLogin = v;
        },
        get onBodyPeekDestroy() {
          return ctrl.onBodyPeekDestroy;
        },
        set onBodyPeekDestroy(fn: (() => void) | null) {
          ctrl.onBodyPeekDestroy = fn;
        },
        inject(folderRaw: string, message: FakeMessage) {
          const f = findFolder(folders, folderRaw);
          if (!f) {
            throw new Error(`inject: no folder ${folderRaw}`);
          }
          f.messages.push(message);
          f.uidnext = Math.max(f.uidnext, message.uid + 1);
        },
        messagesOf(folderRaw: string) {
          const f = findFolder(folders, folderRaw);
          return f ? f.messages.slice() : [];
        },
        setUidvalidity(folderRaw: string, uidvalidity: number) {
          const f = findFolder(folders, folderRaw);
          if (!f) {
            throw new Error(`setUidvalidity: no folder ${folderRaw}`);
          }
          f.uidvalidity = uidvalidity;
        },
        close: () =>
          new Promise((res, rej) => {
            for (const s of sockets) {
              s.destroy();
            }
            sockets.clear();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

function handleUidFetch(
  folder: FakeFolder,
  rest: string,
  tag: string,
  sock: net.Socket,
  ctrl: {
    successfulBodyPeeks: number;
    hangNextBodyPeeks: number;
    destroyNextBodyPeeks: number;
    destroyEveryBodyPeekAfter: number | null;
    onBodyPeekDestroy: (() => void) | null;
    refuseBodyPeekUids: Set<number>;
    refuseSectionUids: Set<number>;
    sizeSkew: Map<number, number>;
  }
) {
  const writeLine = (s: string) => sock.write(Buffer.from(s + CRLF));
  const m = rest.match(/^UID FETCH\s+(\S+)\s+(.+)$/i);
  if (!m) {
    writeLine(`${tag} BAD FETCH`);
    return;
  }
  const set = m[1];
  const items = m[2].toUpperCase();
  const uids = expandUidSet(
    set,
    folder.messages.map((x) => x.uid)
  );
  const wantBody = /BODY\.PEEK\s*\[/.test(items) || /BODY\.PEEK\[\]/.test(items);
  const wantSize = /RFC822\.SIZE/.test(items);
  const wantFlags = /FLAGS/.test(items);
  for (const uid of uids) {
    const msg = folder.messages.find((x) => x.uid === uid);
    if (!msg) {
      continue;
    }
    const seq = folder.messages.indexOf(msg) + 1;
    if (wantBody) {
      if (ctrl.hangNextBodyPeeks > 0) {
        ctrl.hangNextBodyPeeks -= 1;
        return;
      }
      const alwaysDrop =
        ctrl.destroyEveryBodyPeekAfter != null &&
        ctrl.successfulBodyPeeks >= ctrl.destroyEveryBodyPeekAfter;
      if (ctrl.destroyNextBodyPeeks > 0 || alwaysDrop) {
        if (ctrl.destroyNextBodyPeeks > 0) {
          ctrl.destroyNextBodyPeeks -= 1;
        }
        if (ctrl.onBodyPeekDestroy) {
          ctrl.onBodyPeekDestroy();
        }
        sock.destroy();
        return;
      }
      const sectionMatch = items.match(/BODY\.PEEK\[(HEADER|TEXT)\]/);
      const section = sectionMatch ? sectionMatch[1] : '';
      if (
        (section === '' && ctrl.refuseBodyPeekUids.has(uid)) ||
        (section !== '' && ctrl.refuseSectionUids.has(uid))
      ) {
        writeLine(`${tag} NO [UNAVAILABLE] fake server refuses this message`);
        return;
      }
      let part = msg.raw;
      if (section) {
        const sep = msg.raw.indexOf('\r\n\r\n');
        const cut = sep === -1 ? msg.raw.length : sep + 4;
        part = section === 'HEADER' ? msg.raw.slice(0, cut) : msg.raw.slice(cut);
      }
      sock.write(
        Buffer.from(
          `* ${seq} FETCH (UID ${uid} RFC822.SIZE ${msg.raw.length} BODY[${section}] {${part.length}}${CRLF}`
        )
      );
      sock.write(part);
      sock.write(Buffer.from(`)${CRLF}`));
      ctrl.successfulBodyPeeks += 1;
    } else {
      const parts = [`UID ${uid}`];
      if (wantFlags) {
        parts.push(`FLAGS (${msg.flags.join(' ')})`);
      }
      if (wantSize) {
        parts.push(`RFC822.SIZE ${msg.raw.length + (ctrl.sizeSkew.get(uid) || 0)}`);
      }
      writeLine(`* ${seq} FETCH (${parts.join(' ')})`);
    }
  }
  writeLine(`${tag} OK FETCH`);
}

function expandUidSet(set: string, known: number[]): number[] {
  if (set === '1:*') {
    return known.slice().sort((a, b) => a - b);
  }
  if (/^\d+$/.test(set)) {
    return [parseInt(set, 10)];
  }
  if (/^\d+:\d+$/.test(set)) {
    const [a, b] = set.split(':').map((n) => parseInt(n, 10));
    const out: number[] = [];
    for (let u = a; u <= b; u++) {
      if (known.includes(u)) {
        out.push(u);
      }
    }
    return out;
  }
  return known.filter((u) => set.split(',').includes(String(u)));
}
