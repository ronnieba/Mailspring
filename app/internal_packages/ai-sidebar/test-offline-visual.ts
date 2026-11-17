#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t243): visual polish helpers. Avatars (stable, local),
 * friendly dates, replied/forwarded marks, welcome stats, text size, local
 * color tags in the overlay and the "add tag" rule action. Synthetic only.
 */
import fs from 'fs';
import path from 'path';
import {
  AVATAR_COLORS,
  answeredMarks,
  appearanceOfTheme,
  avatarFor,
  clampTextScale,
  friendlyDate,
  initialsOf,
  markFor,
  stepTextScale,
  welcomeStats,
} from './lib/core/offline-visual';
import {
  defaultTags,
  emptyOverlay,
  localPlaceOf,
  newTagId,
  overlayCounts,
  patchMessage,
  sanitizeOverlay,
} from './lib/core/offline-local-overlay';
import { describeRule, planRules, sanitizeRule } from './lib/core/offline-rules';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
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

test('avatar: stable color, initials, local only', () => {
  const a = avatarFor('Alpha Person <alpha@example.test>');
  const b = avatarFor('"Alpha Person" <ALPHA@example.test>');
  assert(a.color === b.color && a.key === b.key, 'same sender → same color');
  assert(AVATAR_COLORS.includes(a.color), 'palette color');
  assert(a.initials === 'AP', `initials ${a.initials}`);
  assert(avatarFor('גמא כהן <g@example.test>').initials === 'גכ', 'Hebrew initials');
  assert(initialsOf('', 'zed@example.test').length >= 1, 'email fallback');
  assert(avatarFor('').initials.length >= 1, 'empty sender still renders');
  const src = read('lib/core/offline-visual.ts');
  assert(!/gravatar|https?:\/\//i.test(src), 'no network / gravatar');
});

test('friendly dates', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime();
  const at = (d: number, h = 9) => new Date(2026, 10, d, h, 5).getTime();
  assert(friendlyDate(at(14), now).startsWith('היום'), friendlyDate(at(14), now));
  assert(friendlyDate(at(13), now).startsWith('אתמול'), friendlyDate(at(13), now));
  assert(/יום|שבת/.test(friendlyDate(at(10), now)), friendlyDate(at(10), now));
  const old = friendlyDate(new Date(2026, 1, 3).getTime(), now);
  assert(/3/.test(old) && !/יום/.test(old), old);
  const older = friendlyDate(new Date(2024, 1, 3).getTime(), now);
  assert(/24/.test(older), older);
  assert(friendlyDate(at(13), now, 'en').startsWith('Yesterday'), friendlyDate(at(13), now, 'en'));
  assert(friendlyDate(0, now) === '', 'no date → empty');
});

test('replied / forwarded marks from Sent', () => {
  const entries = [
    { folder: 'Inbox', subject: 'Q', msgId: '<q1@x>' },
    { folder: 'Inbox', subject: 'R', msgId: '<r1@x>' },
    { folder: 'Sent', subject: 'Re: Q', inReplyTo: '<q1@x>', refs: '<q1@x>' },
    { folder: 'Sent', subject: 'Fwd: R', refs: '<a@x> <r1@x>' },
    { folder: 'Inbox', subject: 'Re: R', inReplyTo: '<r1@x>' },
  ];
  const m = answeredMarks(entries, (f) => f === 'Sent');
  assert(markFor(m, '<q1@x>')?.replied && !markFor(m, '<q1@x>')?.forwarded, 'replied');
  assert(
    markFor(m, 'R1@x')?.forwarded && !markFor(m, '<r1@x>')?.replied,
    'forwarded (inbox reply ignored)'
  );
  assert(markFor(m, undefined) === null, 'no id');
});

test('welcome stats', () => {
  const now = new Date(2026, 10, 14, 12).getTime();
  const day = (d: number) => new Date(2026, 10, d, 10).getTime();
  const es = [
    { id: '1', from: 'A <a@x.test>', ts: day(14), hasAttachments: true },
    { id: '2', from: 'A <a@x.test>', ts: day(13), hasAttachments: false },
    { id: '3', from: 'B <b@x.test>', ts: day(1), hasAttachments: false },
  ];
  const s = welcomeStats(es, { unread: (id) => id === '1', starred: (id) => id === '3' }, now);
  assert(s.total === 3 && s.unread === 1 && s.starred === 1 && s.withAttachments === 1, 'counts');
  assert(s.last7 === 2, `last7 ${s.last7}`);
  assert(s.perDay.length === 14 && s.perDay[13].count === 1, 'per day');
  assert(s.topSenders[0].email === 'a@x.test' && s.topSenders[0].count === 2, 'top sender');
});

test('text size + appearance', () => {
  assert(
    clampTextScale('x') === 1 && clampTextScale(5) === 1.35 && clampTextScale(0.1) === 0.9,
    'clamp'
  );
  assert(
    stepTextScale(1, 1) === 1.1 && stepTextScale(1, -1) === 0.9 && stepTextScale(1.35, 1) === 1.35,
    'step'
  );
  assert(
    appearanceOfTheme('ui-automatic') === 'auto' && appearanceOfTheme('ui-dark') === 'dark',
    'themes'
  );
});

test('tags in the local overlay', () => {
  const ov = emptyOverlay();
  assert(ov.tags.length === 3 && ov.tags[0].name === 'עבודה', 'default tags');
  patchMessage(ov, 'm1', { tags: ['work', 'bills'] });
  assert(overlayCounts(ov).tagged === 1, 'tagged count');
  patchMessage(ov, 'm1', { tags: [] });
  assert(!ov.messages.m1, 'removing all tags drops the entry');
  const s = sanitizeOverlay({
    version: 1,
    messages: { a: { tags: ['work', 'gone', 'BAD ID', 'work'] }, b: { tags: ['gone'] } },
    tags: [...defaultTags(), { id: 'x', name: '', color: '#fff' }],
  });
  assert(
    JSON.stringify(s.messages.a.tags) === '["work"]',
    `cleaned ${JSON.stringify(s.messages.a)}`
  );
  assert(!s.messages.b, 'unknown tag only → dropped');
  assert(s.tags.length === 3, 'invalid tag definition dropped');
  const old = sanitizeOverlay({ version: 1, messages: {} });
  assert(old.tags.length === 3, 'older overlay gets defaults');
  assert(
    sanitizeOverlay({ version: 1, messages: {}, tags: [] }).tags.length === 0,
    'deleted all stays empty'
  );
  assert(newTagId('Work', defaultTags()) === 'work-2', 'unique id');
  assert(/^tag-/.test(newTagId('קבלות', [])), 'hebrew name id');
});

test('rule action: add tag', () => {
  const r = sanitizeRule({
    id: 'r1',
    name: '',
    enabled: true,
    when: { from: 'beta' },
    then: { kind: 'tag', tag: 'bills' },
    createdAt: 1,
  });
  assert(r && r.then.tag === 'bills', 'tag rule kept');
  assert(
    !sanitizeRule({
      id: 'r2',
      name: '',
      enabled: true,
      when: { from: 'b' },
      then: { kind: 'tag' },
    }),
    'needs a tag'
  );
  const ov = emptyOverlay();
  ov.messages.b = { tags: ['work'] };
  const base = { to: '', subject: 's', hasAttachments: false, ts: 0, mtimeMs: 10, folder: 'Inbox' };
  const p = planRules(
    [r!],
    [
      { ...base, id: 'a', from: 'beta <beta@x>' },
      { ...base, id: 'b', from: 'beta <beta@x>' },
      { ...base, id: 'c', from: 'gamma <g@x>' },
    ],
    ov,
    {
      senderOf: (f) => ({ email: f.includes('beta') ? 'beta@x' : 'g@x', name: '' }),
      placeOf: localPlaceOf,
    }
  );
  assert(JSON.stringify(p.patches.get('a')!.tags) === '["bills"]', 'adds tag');
  assert(JSON.stringify(p.patches.get('b')!.tags) === '["work","bills"]', 'keeps existing tags');
  assert(!p.patches.has('c') && p.perRule.r1 === 2, 'counted');
  assert(
    /חשבונות/.test(
      describeRule(
        r!,
        'he',
        (x) => x,
        () => 'חשבונות'
      )
    ),
    describeRule(r!, 'he')
  );
});

test('bundled font: local file + OFL, no CDN', () => {
  const ttf = path.join(__dirname, 'fonts', 'Assistant-Variable.ttf');
  const buf = fs.readFileSync(ttf);
  assert(buf.length > 50000 && buf.readUInt32BE(0) === 0x00010000, 'TrueType file');
  assert(
    /SIL OPEN FONT LICENSE/i.test(
      fs.readFileSync(path.join(__dirname, 'fonts', 'OFL.txt'), 'utf8')
    ),
    'OFL text'
  );
  const ap = read('lib/offline-mail/offline-appearance.ts');
  assert(/pathToFileURL/.test(ap) && !/https?:\/\//.test(ap), 'file: URL only');
  const less = read('styles/offline-mail.less');
  assert(!/fonts\.googleapis|fonts\.gstatic|@import url\(/i.test(less), 'no CDN in styles');
  assert(
    /OfflineAssistant/.test(less) && /--ofl-text-scale/.test(less),
    'font + text scale in styles'
  );
});

test('UI wiring: avatars, icons, tags, welcome, appearance, thinking', () => {
  const list = read('lib/offline-mail/offline-message-list.tsx');
  assert(
    /OfflineAvatar/.test(list) && /OfflineTagStrip/.test(list) && /friendlyDate/.test(list),
    'list'
  );
  assert(
    /data-offline-row-replied/.test(list) && /data-offline-tag-filter/.test(list),
    'list flags/filter'
  );
  assert(/onContextMenu/.test(list), 'right-click menu');
  const reader = read('lib/offline-mail/offline-message-reader.tsx');
  assert(/<OfflineWelcome/.test(reader) && /offline-reader-avatar/.test(reader), 'reader');
  const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
  for (const id of [
    'act-tag',
    'appearance',
    'text-smaller',
    'text-bigger',
    'tags-s',
    'appearance-s',
  ]) {
    assert(ribbon.includes(`id: '${id}'`), `ribbon ${id}`);
  }
  const actions = read('lib/offline-mail/offline-message-actions.tsx');
  assert(
    /submenu: tagMenu/.test(actions) && /data-offline-tag-manager/.test(actions),
    'context menu + manager'
  );
  const ai = read('lib/ai-sidebar.tsx');
  assert(/ai-thinking/.test(ai) && /message-thinking/.test(ai), 'thinking animation');
  const less = read('styles/offline-mail.less');
  assert(/prefers-reduced-motion[\s\S]*ai-thinking/.test(less), 'reduced motion');
  const vis =
    read('lib/offline-mail/offline-visual-ui.tsx') + read('lib/offline-mail/offline-welcome.tsx');
  assert(
    !/https?:\/\/|gravatar|gemini/i.test(vis.replace(/Gemini/g, '')),
    'no network / no AI in visuals'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
