#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t239): voice with Gemini Live.
 * Setup (models, Hebrew, barge-in), tools (no send, BLOCKING), cost math,
 * the endpoint allowlist and session gate, the main-process session with a
 * fake socket (setup, audio, tool calls, usage, timeouts, key redaction), the
 * delete confirmation, PCM helpers, folder matching, where the mic buttons
 * are, and that local Whisper is gone. No network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-voice.ts
 */
import fs from 'fs';
import path from 'path';
import {
  DeleteGate,
  clipForGemini,
  floatTo16BitPcm,
  matchFolder,
  pcm16Base64ToFloat,
  resampleTo16k,
  shouldAutoStop,
} from './lib/core/offline-voice';
import {
  GEMINI_LIVE_HOST,
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_PATH,
  GEMINI_LIVE_SYSTEM_INSTRUCTION,
  GEMINI_LIVE_TOOL_NAMES,
  GEMINI_TRANSCRIBE_MODEL,
  addLiveUsage,
  buildLiveSetup,
  emptyLiveTotals,
  geminiLiveToolDeclarations,
  isAllowedLiveUrl,
  liveUsageUsd,
} from '../../src/browser/gemini-live-protocol';
import { GeminiLiveSession, LiveSocket, redactKey } from '../../src/browser/gemini-live-host';
import { isLiveGateOpen, resetLiveGateForTests } from '../../src/browser/gemini-live-gate';
import { offlineRequestDecision } from '../../src/browser/offline-network-guard';
import os from 'os';
import {
  LIVE_CONTINUE_MAX_CHARS,
  LiveItem,
  addPiece,
  closeTurn,
  continueHistory,
  conversationText,
  newConversation,
  readTranscripts,
  writeTranscripts,
} from './lib/core/offline-live-transcript';
import { sanitizeLiveHistory } from '../../src/browser/gemini-live-protocol';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).stack || err}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
const tick = () => new Promise((r) => setTimeout(r, 5));

const FAKE_KEY = 'AIzaFAKE-test-key-123';

class FakeSocket implements LiveSocket {
  sent: any[] = [];
  closed = false;
  binaryType = 'arraybuffer';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  constructor(public url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  serve(obj: unknown, binary = false) {
    const s = JSON.stringify(obj);
    this.onmessage && this.onmessage({ data: binary ? new TextEncoder().encode(s).buffer : s });
  }
}

function mkSession(mode: 'talk' | 'dictate' = 'talk', extra: Record<string, unknown> = {}) {
  const events: any[] = [];
  const ends: any[] = [];
  let sock: FakeSocket | null = null;
  let t = 1000;
  const s = new GeminiLiveSession({
    id: 'live-1',
    mode,
    key: FAKE_KEY,
    socketFactory: (url) => (sock = new FakeSocket(url)),
    emit: (e) => events.push(e),
    onEnd: (e) => ends.push(e),
    now: () => t,
    ...extra,
  } as any);
  return {
    s,
    events,
    ends,
    sock: () => sock as unknown as FakeSocket,
    advance: (ms: number) => (t += ms),
  };
}

async function main() {
  console.log('offline voice with Gemini Live (t239)');

  await test('talk setup: native-audio live model, Hebrew instructions, tools, barge-in, transcripts', () => {
    const s = buildLiveSetup('talk').setup as any;
    assert(
      s.model === `models/${GEMINI_LIVE_MODEL}` && GEMINI_LIVE_MODEL === 'gemini-3.8-live',
      s.model
    );
    assert(JSON.stringify(s.generationConfig.responseModalities) === '["AUDIO"]', 'audio out');
    assert(s.realtimeInputConfig.activityHandling === 'START_OF_ACTIVITY_INTERRUPTS', 'barge-in');
    assert(s.inputAudioTranscription && s.outputAudioTranscription, 'transcripts');
    assert(/עברית|Hebrew/.test(s.systemInstruction.parts[0].text), 'Hebrew');
    assert(!('thinkingConfig' in s.generationConfig), 'no thinking level (not allowed)');
  });

  await test('dictation setup: transcription model, he-IL first, text only', () => {
    const s = buildLiveSetup('dictate').setup as any;
    assert(s.model === `models/${GEMINI_TRANSCRIBE_MODEL}`, s.model);
    assert(s.inputAudioTranscription.languageCodes[0] === 'he-IL', 'he first');
    assert(JSON.stringify(s.generationConfig.responseModalities) === '["TEXT"]', 'text');
    assert(!s.tools, 'no tools while dictating');
  });

  await test('tools: the app actions, all BLOCKING, and no way to send mail', () => {
    const decl = geminiLiveToolDeclarations() as any[];
    const names = decl.map((d) => d.name);
    for (const want of [
      'search_mail',
      'go_to_folder',
      'new_draft',
      'open_draft',
      'reply_to_selected',
      'fill_draft',
      'read_selected_message',
      'message_action',
      'delete_selected_message',
      'end_conversation',
    ]) {
      assert(names.includes(want), want);
    }
    assert(JSON.stringify(names) === JSON.stringify(GEMINI_LIVE_TOOL_NAMES), 'list in sync');
    assert(!names.some((n) => /send|forward|smtp|mailto/i.test(n)), 'no send tool');
    assert(!/\bsend_|"send"/i.test(JSON.stringify(decl)), 'no send in params');
    assert(
      decl.every((d) => d.behavior === 'BLOCKING'),
      'blocking'
    );
    const del = decl.find((d) => d.name === 'delete_selected_message');
    assert(del.parameters.required.includes('confirmed'), 'delete needs confirmed');
    assert(
      /never|לא/i.test(GEMINI_LIVE_SYSTEM_INSTRUCTION) &&
        /send/i.test(GEMINI_LIVE_SYSTEM_INSTRUCTION),
      'told: no send'
    );
  });

  await test('cost: per modality, unknown splits at the dearest rate', () => {
    // 1 minute of speech in ≈ 1500 audio tokens; 30 s answer ≈ 750 audio tokens.
    const usd = liveUsageUsd(GEMINI_LIVE_MODEL, {
      promptTokenCount: 1600,
      responseTokenCount: 750,
      promptTokensDetails: [
        { modality: 'AUDIO', tokenCount: 1500 },
        { modality: 'TEXT', tokenCount: 100 },
      ],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 750 }],
    });
    const want = (1500 * 3 + 100 * 0.75 + 750 * 12) / 1e6;
    assert(Math.abs(usd - want) < 1e-9, `${usd} vs ${want}`);
    const unknown = liveUsageUsd(GEMINI_LIVE_MODEL, {
      promptTokenCount: 1000,
      responseTokenCount: 1000,
    });
    assert(Math.abs(unknown - (1000 * 3 + 1000 * 12) / 1e6) < 1e-9, 'upper bound');
    const tool = liveUsageUsd(GEMINI_LIVE_MODEL, { toolUsePromptTokenCount: 1000 });
    assert(Math.abs(tool - (1000 * 0.75) / 1e6) < 1e-9, 'tool results are text');
    let t = emptyLiveTotals();
    t = addLiveUsage(t, GEMINI_LIVE_MODEL, {
      promptTokenCount: 10,
      responseTokenCount: 5,
      totalTokenCount: 15,
    });
    t = addLiveUsage(t, GEMINI_LIVE_MODEL, {
      promptTokenCount: 20,
      responseTokenCount: 5,
      totalTokenCount: 25,
    });
    assert(t.total === 40 && t.input === 30 && t.messages === 2, JSON.stringify(t));
  });

  await test('network: only the Live endpoint, wss, and only while a session runs', () => {
    assert(isAllowedLiveUrl(`wss://${GEMINI_LIVE_HOST}${GEMINI_LIVE_PATH}?key=x`), 'ok');
    assert(!isAllowedLiveUrl(`ws://${GEMINI_LIVE_HOST}${GEMINI_LIVE_PATH}`), 'ws');
    assert(!isAllowedLiveUrl(`wss://evil.example${GEMINI_LIVE_PATH}`), 'host');
    assert(!isAllowedLiveUrl(`wss://${GEMINI_LIVE_HOST}/other`), 'path');
    resetLiveGateForTests();
    const u = `wss://${GEMINI_LIVE_HOST}${GEMINI_LIVE_PATH}`;
    assert(offlineRequestDecision(u) === 'block', 'closed without a session');
    const { s } = mkSession();
    void s.start();
    assert(isLiveGateOpen() && offlineRequestDecision(u) === 'allow-remote', 'open during');
    s.stop();
    assert(!isLiveGateOpen() && offlineRequestDecision(u) === 'block', 'closed after');
    assert(offlineRequestDecision('wss://imap.mail.yahoo.com/') === 'block', 'other wss');
  });

  await test('session: setup first, ready on setupComplete, audio relayed as 16 kHz PCM', async () => {
    resetLiveGateForTests();
    const h = mkSession();
    const p = h.s.start();
    const sock = h.sock();
    assert(sock.url.includes(GEMINI_LIVE_PATH), 'url');
    assert(!h.s.audio(new Uint8Array(3200)), 'no audio before ready');
    sock.onopen && sock.onopen();
    assert(sock.sent[0].setup.model === `models/${GEMINI_LIVE_MODEL}`, 'setup first');
    sock.serve({ setupComplete: {} }, true);
    await tick();
    const r = await p;
    assert(r.ok, 'ready');
    assert(h.s.audio(new Uint8Array(3200)), 'audio sent');
    const a = sock.sent[1].realtimeInput.audio;
    assert(
      a.mimeType === 'audio/pcm;rate=16000' && Buffer.from(a.data, 'base64').length === 3200,
      'pcm'
    );
    assert(!h.s.audio(new Uint8Array(70000)), 'oversized chunk dropped');
    h.s.stop();
    assert(!h.s.audio(new Uint8Array(3200)), 'nothing after stop');
    assert(sock.closed, 'socket closed');
  });

  await test('session: transcripts, audio, interruption, tool calls and results, usage, end', async () => {
    resetLiveGateForTests();
    const h = mkSession();
    const p = h.s.start();
    const sock = h.sock();
    sock.onopen && sock.onopen();
    sock.serve({ setupComplete: {} });
    await tick();
    await p;
    sock.serve({ serverContent: { inputTranscription: { text: 'חפש מיילים' } } });
    sock.serve({
      toolCall: { functionCalls: [{ id: 'c1', name: 'search_mail', args: { query: 'דנה' } }] },
    });
    sock.serve({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
        outputTranscription: { text: 'מצאתי' },
      },
    });
    sock.serve({ serverContent: { interrupted: true } });
    sock.serve({ serverContent: { turnComplete: true } });
    sock.serve({
      usageMetadata: {
        promptTokenCount: 100,
        responseTokenCount: 50,
        totalTokenCount: 150,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 50 }],
      },
    });
    await tick();
    const types = h.events.map((e) => e.type);
    for (const t of [
      'ready',
      'input-text',
      'tool-call',
      'audio',
      'output-text',
      'interrupted',
      'turn-complete',
      'usage',
    ]) {
      assert(types.includes(t), t);
    }
    const tc = h.events.find((e) => e.type === 'tool-call');
    assert(tc.calls[0].name === 'search_mail' && tc.calls[0].args.query === 'דנה', 'call');
    assert(h.s.toolResult('c1', 'search_mail', { ok: true }), 'result sent');
    const last = sock.sent[sock.sent.length - 1];
    assert(last.toolResponse.functionResponses[0].id === 'c1', 'response id');
    h.advance(60000);
    const out = h.s.stop();
    assert(out.seconds === 60 && out.totals.total === 150, JSON.stringify(out));
    assert(
      h.ends.length === 1 && h.ends[0].mode === 'talk' && h.ends[0].totals.usd > 0,
      'recorded once'
    );
    h.s.stop();
    assert(h.ends.length === 1, 'not twice');
    assert(h.events[h.events.length - 1].type === 'closed', 'closed event');
  });

  await test('session: no key, setup timeout, server go-away, key never in messages', async () => {
    resetLiveGateForTests();
    const nokey = mkSession('talk', { key: '' });
    const r0 = await nokey.s.start();
    assert(!r0.ok && r0.reason === 'unconfigured' && !nokey.sock(), 'no socket without a key');
    const slow = mkSession('talk', { setupTimeoutMs: 10 });
    const r1 = await slow.s.start();
    assert(!r1.ok && r1.reason === 'timeout' && !isLiveGateOpen(), 'timeout closes the gate');
    const g = mkSession();
    const p = g.s.start();
    g.sock().onopen && g.sock().onopen!();
    g.sock().serve({ setupComplete: {} });
    await tick();
    await p;
    g.sock().serve({ goAway: { timeLeft: '10s' } });
    await tick();
    assert(g.ends[0].reason === 'server-go-away', 'stops on go-away');
    const bad = mkSession();
    const p2 = bad.s.start();
    bad.sock().onclose && bad.sock().onclose!({ code: 1008, reason: `bad key=${FAKE_KEY}` });
    const r2 = await p2;
    for (const e of [...bad.events, r2])
      assert(!JSON.stringify(e).includes(FAKE_KEY), 'key leaked');
    assert(redactKey(`x?key=${FAKE_KEY}&a=1`, FAKE_KEY) === 'x?key=[redacted-key]&a=1', 'redact');
  });

  await test('time limit: the session ends by itself', async () => {
    resetLiveGateForTests();
    const h = mkSession('dictate', { maxSeconds: 0.02 });
    const p = h.s.start();
    h.sock().onopen && h.sock().onopen!();
    h.sock().serve({ setupComplete: {} });
    await p;
    await new Promise((r) => setTimeout(r, 40));
    assert(
      h.ends.length === 1 && h.ends[0].reason === 'time-limit' && !isLiveGateOpen(),
      'time limit'
    );
    assert(h.ends[0].model === GEMINI_TRANSCRIBE_MODEL, 'dictation model');
  });

  await test('dictation without a usage report: cost estimated from the audio sent', async () => {
    resetLiveGateForTests();
    const h = mkSession('dictate');
    const p = h.s.start();
    h.sock().onopen && h.sock().onopen!();
    h.sock().serve({ setupComplete: {} });
    await tick();
    await p;
    for (let i = 0; i < 10; i++) h.s.audio(new Uint8Array(3200)); // 1 s
    h.sock().serve({ serverContent: { inputTranscription: { text: 'שלום עולם' } } });
    await tick();
    const out = h.s.stop();
    assert(out.totals.estimated === true && out.totals.input === 25, JSON.stringify(out.totals));
    assert(Math.abs(out.totals.usd - (25 * 3.5 + 3 * 21) / 1e6) < 1e-9, String(out.totals.usd));
    assert(h.ends[0].totals.usd > 0, 'recorded');
  });

  await test('transcript: bubbles per turn, spaces between joined words, app lines apart', () => {
    const it: LiveItem[] = [];
    addPiece(it, 'user', 'חפש מיילים');
    addPiece(it, 'user', ' על slides');
    addPiece(it, 'app', '🔍 חיפשתי: slides');
    addPiece(it, 'gemini', 'מצאתי שני מיילים');
    addPiece(it, 'gemini', 'שקשורים לסליידס.');
    closeTurn(it);
    addPiece(it, 'gemini', 'עוד משהו?');
    assert(it.length === 4, JSON.stringify(it));
    assert(it[0].text === 'חפש מיילים על slides', it[0].text);
    assert(it[2].text === 'מצאתי שני מיילים שקשורים לסליידס.', it[2].text);
    assert(it[3].text === 'עוד משהו?' && it[1].who === 'app', 'new bubble after turn end');
    const c = newConversation(0);
    c.items = it;
    const txt = conversationText(c);
    assert(/^אני: חפש/.test(txt) && /Gemini: מצאתי/.test(txt) && /· 🔍/.test(txt), txt);
  });

  await test('continue: recent turns only, capped, starting with the user', () => {
    const c = newConversation(0);
    addPiece(c.items, 'gemini', 'שלום');
    closeTurn(c.items);
    for (let i = 0; i < 40; i++) {
      addPiece(c.items, 'user', `שאלה ${i} ${'א'.repeat(150)}`);
      addPiece(c.items, 'app', 'x');
      addPiece(c.items, 'gemini', `תשובה ${i}`);
      closeTurn(c.items);
    }
    const h = continueHistory(c);
    const chars = h.reduce((n, t) => n + t.text.length, 0);
    assert(h.length && h.length <= 16 && chars <= LIVE_CONTINUE_MAX_CHARS, `${h.length} ${chars}`);
    assert(h[0].role === 'user' && h[h.length - 1].text === 'תשובה 39', 'order');
    assert(!h.some((t) => t.text === 'x'), 'no app lines');
    const s = sanitizeLiveHistory([
      { role: 'system', text: 'x' },
      { role: 'user', text: 'y'.repeat(5000) },
      3,
    ]);
    assert(s.length === 1 && s[0].text.length === 3000, 'sanitized');
  });

  await test('transcripts saved only in the profile, newest 30, empty ones dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tr-'));
    try {
      const list = [];
      for (let i = 0; i < 35; i++) {
        const c = newConversation(i);
        c.endedAt = i;
        addPiece(c.items, 'user', `שיחה ${i}`);
        list.push(c);
      }
      const empty = newConversation(99);
      empty.endedAt = 99;
      addPiece(empty.items, 'app', 'מחובר');
      writeTranscripts(dir, [...list, empty]);
      const back = readTranscripts(dir);
      assert(back.length === 30 && back[0].items[0].text === 'שיחה 34', String(back.length));
      assert(!back.some((c) => c.items.some((i) => (i as any).open)), 'no UI flags saved');
      assert(fs.readdirSync(dir).join() === 'gemini-live-transcripts.json', 'one file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('session: continue sends earlier turns once (history config); typed text is a user turn', async () => {
    resetLiveGateForTests();
    const h = mkSession('talk', {
      history: [
        { role: 'user', text: 'חפש' },
        { role: 'model', text: 'מצאתי' },
      ],
    });
    const p = h.s.start();
    h.sock().onopen && h.sock().onopen!();
    assert(
      h.sock().sent[0].setup.historyConfig.initialHistoryInClientContent === true,
      'history config'
    );
    h.sock().serve({ setupComplete: {} });
    await tick();
    await p;
    const cc = h.sock().sent[1].clientContent;
    assert(
      cc.turns.length === 2 && cc.turns[1].role === 'model' && cc.turnComplete === false,
      JSON.stringify(cc)
    );
    assert(h.s.sendText('תודה'), 'text');
    const t = h.sock().sent[2].clientContent;
    assert(t.turns[0].parts[0].text === 'תודה' && t.turnComplete === true, 'typed turn');
    h.s.stop();
    const plain = buildLiveSetup('talk').setup as any;
    assert(!plain.historyConfig, 'no history config for a new conversation');
  });

  await test('conversation panel: bubbles, history, copy / clear / continue, typing, saved locally', () => {
    const v = read('lib/offline-mail/offline-voice.tsx');
    for (const k of ['history', 'copy', 'clear', 'close', 'continue', 'new', 'say', 'stop']) {
      assert(v.includes(`data-offline-live-btn="${k}"`), k);
    }
    assert(/data-offline-live-item=\{i\.who\}/.test(v) && /dir="auto"/.test(v), 'bubbles, RTL');
    assert(
      /writeTranscripts\(dir/.test(v) && /AppEnv\.getConfigDirPath\(\)/.test(v),
      'profile only'
    );
    assert(/offlineVoiceHooks\.copyText/.test(v), 'clipboard hook for tests');
    assert(/חיפשתי:/.test(v) && /נמחק \(ניתן לבטל\)/.test(v), 'action lines');
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(
      /id: 'voice-transcript'[\s\S]{0,800}offlineVoice\.openPanel/.test(ribbon),
      'ribbon button'
    );
    const s = buildLiveSetup('talk').setup as any;
    assert(s.inputAudioTranscription && s.outputAudioTranscription, 'transcription on');
  });

  await test('delete needs a yes for the same message, soon', () => {
    const g = new DeleteGate(1000);
    assert(!g.confirm('m1', 0), 'no request → no delete');
    g.request('m1', 0);
    assert(!g.confirm('m2', 10), 'other message');
    assert(g.confirm('m1', 20), 'confirmed');
    assert(!g.confirm('m1', 30), 'only once');
    g.request('m1', 0);
    assert(!g.confirm('m1', 5000), 'too late');
  });

  await test('PCM: mic → 16-bit, Gemini 24 kHz → float, resample, auto-stop', () => {
    const b = floatTo16BitPcm(new Float32Array([0, 1, -1, 0.5]));
    assert(b.length === 8, 'bytes');
    const dv = new DataView(b.buffer);
    assert(dv.getInt16(2, true) === 32767 && dv.getInt16(4, true) === -32768, 'scale');
    const f = pcm16Base64ToFloat(Buffer.from(b).toString('base64'));
    assert(f.length === 4 && Math.abs(f[1] - 1) < 0.001 && f[2] === -1, 'roundtrip');
    assert(resampleTo16k(new Float32Array(48000), 48000).length === 16000, 'resample');
    assert(shouldAutoStop({ now: 31000, lastActivity: 0, idleSec: 30, speaking: false }), 'idle');
    assert(
      !shouldAutoStop({ now: 31000, lastActivity: 0, idleSec: 30, speaking: true }),
      'not while speaking'
    );
    assert(clipForGemini('a  b\n c', 3) === 'a b…', 'clip');
  });

  await test('folder by spoken name: exact, role names, loose spelling, none', () => {
    const F = [
      { path: 'Inbox', names: ['Inbox', 'inbox', 'דואר נכנס', 'נכנס'] },
      { path: 'Sent', names: ['Sent', 'נשלחו'] },
      { path: 'Family/Kids', names: ['Kids', 'Family/Kids', 'ילדים'] },
    ];
    assert(matchFolder('דואר נכנס', F) === 'Inbox', 'he role');
    assert(matchFolder('inbox', F) === 'Inbox', 'en');
    assert(matchFolder('הילדים', F) === 'Family/Kids', 'ה prefix');
    assert(matchFolder('נשלחוו', F) === 'Sent', 'loose');
    assert(matchFolder('קניות', F) === null, 'none');
  });

  await test('green mic next to every text field; ribbon + AI panel command mic; shortcut', () => {
    const has = (f: string, re: RegExp, what: string) => assert(re.test(read(f)), what);
    has(
      'lib/offline-mail/offline-search-view.tsx',
      /<OfflineMic\s+target="\[data-offline-search-input\]"/,
      'search'
    );
    has(
      'lib/offline-mail/offline-drafts-view.tsx',
      /<OfflineMic\s+target='input\[data-offline-draft-field="subject"\]'/,
      'subject'
    );
    has(
      'lib/offline-mail/offline-recipients.tsx',
      /<OfflineMic\s+target=\{`input\[data-offline-draft-field="\$\{field\}"\]`\}/,
      'To/Cc/Bcc'
    );
    has(
      'lib/offline-mail/offline-rich-editor.tsx',
      /<OfflineMic\s+target='\[data-offline-draft-field="body"\]'/,
      'body'
    );
    has('lib/ai-sidebar.tsx', /<OfflineMic\s+target="#ai-sidebar-question"/, 'AI box');
    has('lib/ai-sidebar.tsx', /<OfflineMic\s+command/, 'AI command mic');
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(
      /id: 'voice-command'[\s\S]{0,1500}offlineVoice\.toggle\('command'\)/.test(ribbon) &&
        ribbon.includes('<OfflineVoiceHud />'),
      'ribbon'
    );
    const v = read('lib/offline-mail/offline-voice.tsx');
    assert(/e\.ctrlKey && e\.shiftKey && \(e\.code === 'Space'/.test(v), 'Ctrl+Shift+Space');
    assert(
      /if \(!v\.available\) return null;/.test(v) && /process\.platform === 'win32'/.test(v),
      'Windows only (Mac unchanged)'
    );
    assert(v.includes("className={`offline-mic${rec ? ' recording' : ''}"), 'recording state');
  });

  await test('window side: key stays in main, live card + Stop, confirm buttons, limited mail text', () => {
    const v = read('lib/offline-mail/offline-voice.tsx');
    const core = read('lib/core/offline-voice.ts');
    assert(
      !/WebSocket|https?:\/\/|\bfetch\(|\?key=|apiKey|Credential/.test(v + core),
      'no socket / key in the window'
    );
    assert(/data-offline-voice-stop/.test(v) && /חי — מקשיב/.test(v), 'live card + stop');
    assert(
      /data-offline-voice-confirm-yes/.test(v) && /deleteGate\.confirm/.test(v),
      'on-screen confirm'
    );
    assert(/MAX_QA_MESSAGES = 6/.test(v) && /MAX_SELECTED_BODY = 4000/.test(v), 'caps');
    assert(/buildOfflineQuestionContext/.test(v), 'local search first (as Ask AI)');
    assert(!/actSend|sendDraft|smtp/i.test(v), 'no send path');
    assert(/GEMINI_LIVE_IDLE_SECONDS/.test(v) && /shouldAutoStop/.test(v), 'auto-stop');
  });

  await test('local Whisper is gone from the app', () => {
    const files = [
      'lib/offline-mail/offline-voice.tsx',
      'lib/core/offline-voice.ts',
      'lib/core/offline-tour.ts',
      'lib/offline-mail/offline-ribbon.tsx',
      'lib/offline-mail/register.ts',
      'lib/ai-sidebar.tsx',
    ];
    for (const f of files) assert(!/whisper/i.test(read(f)), f);
    assert(
      !/child_process|execFile|spawn\(/.test(read('lib/offline-mail/offline-voice.tsx')),
      'no local process'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
