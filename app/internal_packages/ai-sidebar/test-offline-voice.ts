#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t233): local voice with Whisper.
 * Finding whisper-cli + model, WAV in/out, splitting at pauses, CLI args,
 * whisper JSON, spoken punctuation, the voice-command rules (incl. the way
 * Whisper actually mishears short Hebrew commands), folder matching, and
 * where the mic buttons are. No network, no Gemini for parsing.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-voice.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  WHISPER_DIR_NAME,
  applySpokenPunctuation,
  cleanTranscript,
  decodeWav,
  encodeWav16,
  findWhisperIn,
  matchFolder,
  parseVoiceCommand,
  parseWhisperJson,
  splitOnSilence,
  whisperArgs,
  whisperDirCandidates,
  whisperJsonPathCandidates,
} from './lib/core/offline-voice';

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

function tone(sec: number, amp = 0.3, rate = 16000): Float32Array {
  const a = new Float32Array(Math.round(sec * rate));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate);
  return a;
}
function cat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function main() {
  console.log('offline local voice (t233)');

  await test('Whisper folder: env override, %LOCALAPPDATA% on Windows, per-user elsewhere', () => {
    const w = whisperDirCandidates({ LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, 'win32', 'C:\\U');
    assert(w[0] === path.join('C:\\U\\AppData\\Local', WHISPER_DIR_NAME), w.join(','));
    const m = whisperDirCandidates({}, 'darwin', '/Users/x');
    assert(
      m[0] === path.join('/Users/x', 'Library', 'Application Support', WHISPER_DIR_NAME),
      m.join(',')
    );
    assert(
      whisperDirCandidates({ MAILAI_WHISPER_DIR: '/t' }, 'linux', '/h')[0] === '/t',
      'override'
    );
  });

  await test('finds whisper-cli and the model (preference order, voice.json override)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-whisper-'));
    assert(findWhisperIn(dir, 'win32') === null, 'empty');
    fs.mkdirSync(path.join(dir, 'bin', 'Release'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'models'));
    fs.writeFileSync(path.join(dir, 'bin', 'Release', 'whisper-cli.exe'), 'x');
    assert(findWhisperIn(dir, 'win32') === null, 'no model');
    fs.writeFileSync(path.join(dir, 'models', 'ggml-small.bin'), 'xx');
    fs.writeFileSync(path.join(dir, 'models', 'ggml-medium-q5_0.bin'), 'xxx');
    const s = findWhisperIn(dir, 'win32')!;
    assert(
      s && s.modelName === 'medium-q5_0' && s.modelBytes === 3 && s.cli.endsWith('whisper-cli.exe'),
      JSON.stringify(s)
    );
    fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify({ model: 'ggml-small.bin' }));
    assert(findWhisperIn(dir, 'win32')!.modelName === 'small', 'voice.json');
    fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify({ model: '../../evil.bin' }));
    assert(findWhisperIn(dir, 'win32')!.modelName === 'medium-q5_0', 'no path tricks');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('WAV: 16 kHz mono 16-bit out; stereo / 22 kHz in → 16 kHz mono', () => {
    const s = tone(0.5);
    const w = encodeWav16(s);
    assert(
      w.length === 44 + s.length * 2 &&
        w.toString('ascii', 0, 4) === 'RIFF' &&
        w.readUInt32LE(24) === 16000,
      'header'
    );
    const back = decodeWav(w);
    assert(back.length === s.length && Math.abs(back[100] - s[100]) < 0.001, 'roundtrip');
    // stereo 22050 Hz
    const n = 22050;
    const b = Buffer.alloc(44 + n * 4);
    b.write('RIFF', 0, 'ascii');
    b.writeUInt32LE(36 + n * 4, 4);
    b.write('WAVEfmt ', 8, 'ascii');
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(2, 22);
    b.writeUInt32LE(22050, 24);
    b.writeUInt32LE(22050 * 4, 28);
    b.writeUInt16LE(4, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii');
    b.writeUInt32LE(n * 4, 40);
    const d = decodeWav(b);
    assert(Math.abs(d.length - 16000) <= 1, `resampled ${d.length}`);
  });

  await test('split at pauses: two phrases → two parts; silence → none; short bits join', () => {
    const sil = (s: number) => new Float32Array(Math.round(s * 16000));
    const parts = splitOnSilence(cat(sil(0.5), tone(2), sil(1.0), tone(2.5), sil(0.4)));
    assert(parts.length === 2, JSON.stringify(parts));
    assert(parts[0][0] < 0.5 * 16000 && parts[1][1] >= 5.5 * 16000, 'padding kept');
    assert(splitOnSilence(sil(3)).length === 0, 'silence');
    assert(splitOnSilence(cat(tone(2), sil(0.3), tone(2))).length === 1, 'short pause = one part');
    assert(splitOnSilence(cat(tone(2), sil(0.9), tone(0.5))).length === 1, 'short tail joins');
    const many = [] as Float32Array[];
    for (let i = 0; i < 12; i++) many.push(tone(1.5), sil(0.9));
    assert(splitOnSilence(cat(...many)).length <= 8, 'max parts');
  });

  await test('whisper-cli args: model, language, threads, JSON out, short-audio speed-up, files', () => {
    const a = whisperArgs({
      model: 'm.bin',
      files: ['a.wav', 'b.wav'],
      lang: 'auto',
      threads: 99,
      longestSec: 5,
    });
    assert(
      a.join(' ') === '-m m.bin -l auto -t 32 -nt -np -oj -ac 768 -f a.wav -f b.wav',
      a.join(' ')
    );
    assert(
      !whisperArgs({ model: 'm', files: ['a'], lang: 'he', threads: 4, longestSec: 20 }).includes(
        '-ac'
      ),
      'long audio: full context'
    );
    assert(
      whisperJsonPathCandidates('x/part0.wav').join() === 'x/part0.wav.json,x/part0.json',
      'json names'
    );
  });

  await test('whisper JSON → text + language; tags removed', () => {
    const j = JSON.stringify({
      result: { language: 'he' },
      transcription: [{ text: ' שלום,' }, { text: ' עולם [BLANK_AUDIO]' }],
    });
    const r = parseWhisperJson('\uFEFF' + j);
    assert(r.text === 'שלום, עולם' && r.lang === 'he', JSON.stringify(r));
    assert(
      cleanTranscript('(music) hello ,  world') === 'hello, world',
      cleanTranscript('(music) hello ,  world')
    );
  });

  await test('spoken punctuation (Hebrew + English)', () => {
    assert(
      applySpokenPunctuation('שלום פסיק מה שלומך סימן שאלה שורה חדשה תודה נקודה') ===
        'שלום, מה שלומך?\nתודה.',
      'he'
    );
    assert(
      applySpokenPunctuation('hello comma how are you question mark') === 'hello, how are you?',
      'en'
    );
    assert(
      applySpokenPunctuation('בדיקה של נקודות') === 'בדיקה של נקודות',
      'inside words untouched'
    );
  });

  await test('voice commands: clear Hebrew + English, and how Whisper really hears them', () => {
    const k = (t: string) => parseVoiceCommand(t);
    const eq = (t: string, want: any) => {
      const got = k(t);
      assert(JSON.stringify(got) === JSON.stringify(want), `${t} → ${JSON.stringify(got)}`);
    };
    eq('פתח טיוטה חדשה', { kind: 'new-draft' });
    eq('פתח טיוטה חדשה.', { kind: 'new-draft' });
    eq('פתחתי אותה חדשה', { kind: 'new-draft' });
    eq('new draft', { kind: 'new-draft' });
    eq('חפש חשבונית חשמל', { kind: 'search', query: 'חשבונית חשמל' });
    eq('search for invoices', { kind: 'search', query: 'invoices' });
    eq('עבור לתיקייה דואר נכנס', { kind: 'folder', name: 'דואר נכנס' });
    eq('עבור לתקיעה דואר נכנס.', { kind: 'folder', name: 'דואר נכנס' });
    eq('go to the sent folder', { kind: 'folder', name: 'sent' });
    eq('מחק', { kind: 'delete' });
    eq('מחק את ההודעה', { kind: 'delete' });
    eq('ארכיון', { kind: 'archive' });
    eq('תעביר לארכיון', { kind: 'archive' });
    eq('סמן בכוכב', { kind: 'star' });
    eq('סמן בכוחב!', { kind: 'star' });
    eq('star this', { kind: 'star' });
    eq('סמן כלא נקרא', { kind: 'unread' });
    eq('תענה שאני מגיע מחר בשמונה', { kind: 'reply', instruction: 'אני מגיע מחר בשמונה' });
    eq('תנה שאני מגיע מחר בשמונה.', { kind: 'reply', instruction: 'אני מגיע מחר בשמונה' });
    eq('תנא שאני מגיע מחר בשמונה', { kind: 'reply', instruction: 'אני מגיע מחר בשמונה' });
    eq('עבו לתקיעה דואר נכנס.', { kind: 'folder', name: 'דואר נכנס' });
    eq('עבול התקיעה דואר נכנס', { kind: 'folder', name: 'דואר נכנס' });
    eq('reply that I will be there tomorrow', {
      kind: 'reply',
      instruction: 'I will be there tomorrow',
    });
    eq('שאל מתי הפגישה', { kind: 'ask', question: 'מתי הפגישה' });
    eq('עזרה', { kind: 'help' });
    assert(k('מה שלומך היום').kind === 'unknown', 'unknown');
    assert(k('').kind === 'unknown', 'empty');
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
      /if \(!offlineVoice\.available\) return null;/.test(v),
      'hidden without Whisper (Mac unchanged)'
    );
    assert(v.includes("className={`offline-mic${rec ? ' recording' : ''}"), 'recording state');
  });

  await test('audio stays local: temp WAV deleted, no network, no Gemini in voice code', () => {
    const v = read('lib/offline-mail/offline-voice.tsx');
    const core = read('lib/core/offline-voice.ts');
    assert(
      /finally \{\s*fs\.rmSync\(dir, \{ recursive: true, force: true \}\);/.test(v),
      'temp dir removed'
    );
    for (const src of [v, core]) {
      assert(
        !/https?:\/\/|\bfetch\(|XMLHttpRequest|WebSocket|require\(['"](https?|net|tls)['"]\)|processQuery|gemini-ipc|askAiAboutMail|askAboutMail/i.test(
          src
        ),
        'no network / Gemini'
      );
    }
    // "תענה ש…" only fills the AI box: no send call.
    const reply = v.slice(v.indexOf("case 'reply'"), v.indexOf("case 'help'"));
    assert(
      /setFieldValue\(ta, cmd\.instruction\)/.test(reply) &&
        !/send|submit|_onSend|processQuery/i.test(reply.replace(/"שלח"|"Send"/g, '')),
      'reply never sends'
    );
    assert(
      !/setPermission|systemPreferences|privacy/i.test(
        v.replace(/Privacy → Microphone|פרטיות ← מיקרופון/g, '')
      ),
      'no permission changes'
    );
  });

  await test('guide step + "?" tip for voice (Hebrew + English)', () => {
    const t = read('lib/core/offline-tour.ts');
    assert(/id: 'voice',[\s\S]{0,200}data-offline-ribbon-btn="voice-command"/.test(t), 'step');
    assert(/ {2}voice: \[\s*'[^']*Whisper[^']*',\s*'[^']*Whisper/.test(t), 'tip');
    assert(/<OfflineHelpTip tip="voice" \/>/.test(read('lib/ai-sidebar.tsx')), 'tip placed');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
