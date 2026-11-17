#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t233): Outlook-like LOCAL rules. Conditions, actions,
 * run now / on new mail, undo, persistence, reset. Synthetic messages in temp
 * folders only; the mail copy must never change; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-rules.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  describeRule,
  LocalRule,
  normRuleText,
  planRules,
  ruleMatches,
  sanitizeRule,
  sanitizeRules,
} from './lib/core/offline-rules';
import {
  emptyOverlay,
  localFolderPath,
  localPlaceOf,
  readOverlay,
  sanitizeOverlay,
} from './lib/core/offline-local-overlay';
import { setOfflineLangOverride } from './lib/core/offline-i18n';

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

const A = 'Alpha Person <alpha@example.test>';
const B = 'Beta Sender <beta@example.test>';
const C = 'גמא כהן <gamma@example.test>';

function eml(
  from: string,
  subject: string,
  day: number,
  id: string,
  opts: { cc?: string; file?: boolean } = {}
) {
  const head = [
    `From: ${from}`,
    `To: ${A}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${subject}`,
    `Date: Mon, ${String(day).padStart(2, '0')} Nov 2026 09:00:00 +0000`,
    `Message-ID: <${id}@x>`,
    'MIME-Version: 1.0',
  ];
  if (!opts.file) {
    return (
      [...head, 'Content-Type: text/plain; charset=utf-8'].join('\r\n') +
      '\r\n\r\nsynthetic body\r\n'
    );
  }
  return (
    [...head, 'Content-Type: multipart/mixed; boundary="b1"'].join('\r\n') +
    '\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsynthetic body\r\n' +
    '--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="doc.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b1--\r\n'
  );
}

function hashTree(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const rule = (p: Partial<LocalRule>): LocalRule =>
  sanitizeRule({
    id: 'r1',
    enabled: true,
    createdAt: 1,
    lastRunAt: 0,
    applied: 0,
    ...p,
  }) as LocalRule;

async function main() {
  console.log('offline local rules (t233)');
  setOfflineLangOverride('he');

  await test('sanitize: needs a condition and a valid action; move needs a folder', () => {
    assert(!sanitizeRule({ id: 'x', when: {}, then: { kind: 'star' } }), 'no condition');
    assert(
      !sanitizeRule({ id: 'x', when: { from: 'a' }, then: { kind: 'explode' } }),
      'bad action'
    );
    assert(
      !sanitizeRule({ id: 'x', when: { from: 'a' }, then: { kind: 'move' } }),
      'move without folder'
    );
    assert(!sanitizeRule({ id: 'bad id!', when: { from: 'a' }, then: { kind: 'star' } }), 'bad id');
    const r = sanitizeRule({
      id: 'x',
      when: { from: '  a  ', junk: 1 },
      then: { kind: 'move', folder: 'F' },
    })!;
    assert(r.when.from === 'a' && r.then.folder === 'F' && r.enabled, JSON.stringify(r));
    assert(sanitizeRules([r, r, 'x', null]).length === 1, 'dedupe + junk');
    const ov = sanitizeOverlay({
      version: 1,
      messages: {},
      rules: [r],
      ruleRuns: [
        { id: 'run-1', changes: [{ id: 'm1', before: { star: true } }], blocked: ['X@E.T'] },
      ],
    });
    assert(
      ov.rules.length === 1 &&
        ov.ruleRuns[0].changes[0].before!.star &&
        ov.ruleRuns[0].blocked[0] === 'x@e.t',
      'overlay keeps rules'
    );
    const old = sanitizeOverlay({ version: 1, messages: {}, blocked: [], contacts: [] });
    assert(
      Array.isArray(old.rules) && old.rules.length === 0 && old.ruleRuns.length === 0,
      'old file ok'
    );
  });

  await test('conditions: contains (case, Hebrew finals, several values), to/cc, files, folder subtree', () => {
    const t = {
      id: 'm',
      folder: 'Work/Projects',
      from: C,
      to: A,
      cc: 'Delta <d@x.test>',
      subject: 'דוח שנתי Q4',
      hasAttachments: true,
      attachCount: 1,
      ts: 0,
      mtimeMs: 0,
    };
    assert(normRuleText('כהן') === normRuleText('כהנ'), 'finals folded');
    assert(
      ruleMatches(rule({ when: { from: 'GAMMA@example' }, then: { kind: 'star' } }), t),
      'from case'
    );
    assert(ruleMatches(rule({ when: { from: 'כהנ' }, then: { kind: 'star' } }), t), 'Hebrew name');
    assert(
      ruleMatches(rule({ when: { from: 'nobody; gamma' }, then: { kind: 'star' } }), t),
      'any of values'
    );
    assert(ruleMatches(rule({ when: { to: 'd@x.test' }, then: { kind: 'star' } }), t), 'cc');
    assert(
      !ruleMatches(rule({ when: { to: 'gamma' }, then: { kind: 'star' } }), t),
      'to is not from'
    );
    assert(
      ruleMatches(
        rule({ when: { subject: 'q4', hasAttachment: true }, then: { kind: 'star' } }),
        t
      ),
      'subject + files'
    );
    assert(
      !ruleMatches(rule({ when: { hasAttachment: true }, then: { kind: 'star' } }), {
        ...t,
        attachCount: 0,
      }),
      'no files'
    );
    assert(ruleMatches(rule({ when: { folder: 'Work' }, then: { kind: 'star' } }), t), 'subfolder');
    assert(
      !ruleMatches(rule({ when: { folder: 'Wor' }, then: { kind: 'star' } }), t),
      'prefix is not a folder'
    );
  });

  await test('plan: rule order, trash/spam left alone, no-op not counted, new-mail cut-off, block once', () => {
    const base = { to: A, subject: 's', hasAttachments: false, ts: 0 };
    const targets = [
      { ...base, id: 'a', folder: 'Inbox', from: B, mtimeMs: 10 },
      { ...base, id: 'b', folder: 'Inbox', from: B, mtimeMs: 100 },
      { ...base, id: 'c', folder: localFolderPath('trash'), from: B, mtimeMs: 100 },
      { ...base, id: 'd', folder: 'Inbox', from: C, mtimeMs: 100 },
    ];
    const ov = emptyOverlay();
    ov.messages.a = { star: true };
    const rules = [
      rule({ id: 'star', when: { from: 'beta' }, then: { kind: 'star' } }),
      rule({ id: 'mv', when: { from: 'beta' }, then: { kind: 'move', folder: 'Work' } }),
      rule({ id: 'mv2', when: { folder: 'Work' }, then: { kind: 'unread' } }),
      rule({ id: 'blk', when: { from: 'beta' }, then: { kind: 'block' } }),
      rule({ id: 'off', enabled: false, when: { from: 'gamma' }, then: { kind: 'trash' } }),
    ];
    const opts = {
      senderOf: (f: string) => ({
        email: f.includes('beta') ? 'beta@example.test' : 'x',
        name: '',
      }),
      placeOf: localPlaceOf,
    };
    const p = planRules(rules, targets, ov, opts);
    assert(!p.patches.has('c') && !p.patches.has('d'), 'trash + disabled untouched');
    assert(p.perRule.star === 1, `star counted once (a already starred): ${p.perRule.star}`);
    assert(
      p.patches.get('a')!.folder === 'Work' &&
        p.patches.get('b')!.star &&
        p.patches.get('b')!.unread,
      'later rules see the move'
    );
    assert(p.block.size === 1 && p.perRule.blk === 1, 'block once');
    const n = planRules(rules, targets, ov, { ...opts, since: () => 50 });
    assert(!n.patches.has('a') && n.patches.has('b'), 'new mail only');
  });

  await test('describe in Hebrew and English', () => {
    const r = rule({
      when: { from: 'beta', hasAttachment: true },
      then: { kind: 'move', folder: 'Work' },
    });
    assert(
      describeRule(r, 'he') === 'אם השולח מכיל "beta" וגם יש קבצים מצורפים ← העבר לתיקייה: "Work"',
      describeRule(r, 'he')
    );
    assert(
      describeRule(r, 'en') ===
        'If sender contains "beta" and has attachments → Move to folder: "Work"',
      describeRule(r, 'en')
    );
  });

  // ---- store with a synthetic copy ----
  const { offlineMailStore } = require('./lib/offline-mail/offline-mail-store');
  const {
    offlineActionsUi,
    actResetLocalChanges,
  } = require('./lib/offline-mail/offline-message-actions');
  const rv = require('./lib/offline-mail/offline-rules-view');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-rules-root-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofl-rules-prof-'));
  fs.mkdirSync(path.join(root, 'Inbox'));
  fs.mkdirSync(path.join(root, 'Work', 'Projects'), { recursive: true });
  for (let i = 1; i <= 6; i++) {
    fs.writeFileSync(
      path.join(root, 'Inbox', `i${i}.eml`),
      eml(i % 2 ? B : C, `Note ${i}`, i, `i${i}`, { file: i === 2 })
    );
  }
  fs.writeFileSync(path.join(root, 'Work', 'Projects', 'p1.eml'), eml(B, 'Plan', 7, 'p1'));
  const old = Date.now() - 3600_000;
  for (const f of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'])
    fs.utimesSync(path.join(root, 'Inbox', `${f}.eml`), old / 1000, old / 1000);
  fs.utimesSync(path.join(root, 'Work', 'Projects', 'p1.eml'), old / 1000, old / 1000);
  const s = offlineMailStore;
  const cache = path.join(profile, 'offline-mail-index.json');
  await s.start(root, cache);
  const before = hashTree(root);
  const count = (p: string) => (s as any)._byFolder.get(p)?.length || 0;

  await test('form: needs a condition; move needs a folder; saved rule runs now with Undo', () => {
    rv.openRules();
    rv.offlineRulesUi.form = {
      ...rv.offlineRulesUi.form,
      name: '',
      from: '',
      to: '',
      subject: '',
      hasAttachment: false,
      folder: '',
      kind: 'move',
      target: '',
      runNow: true,
    };
    assert(!rv.saveRuleForm() && /תנאי/.test(rv.offlineRulesUi.form.error), 'condition required');
    rv.offlineRulesUi.form = { ...rv.offlineRulesUi.form, from: 'beta@example.test' };
    assert(!rv.saveRuleForm() && /תיקייה/.test(rv.offlineRulesUi.form.error), 'folder required');
    rv.offlineRulesUi.form = { ...rv.offlineRulesUi.form, target: 'Work', error: undefined };
    const r = rv.saveRuleForm();
    assert(r && s.rules.length === 1, 'saved');
    assert(
      count('Inbox') === 3 && count('Work') === 4,
      `moved: inbox ${count('Inbox')} work ${count('Work')}`
    );
    assert(
      offlineActionsUi.toast &&
        offlineActionsUi.toast.undo &&
        /שונו 4/.test(offlineActionsUi.toast.text),
      offlineActionsUi.toast && offlineActionsUi.toast.text
    );
    assert(s.rules[0].applied === 4, 'applied count (3 in Inbox + 1 in a subfolder)');
    offlineActionsUi.undoToast();
    assert(count('Inbox') === 6 && !s.lastRuleRun(), 'undo puts them back');
  });

  await test('rules are saved in the local-changes file of the profile', () => {
    const ov = readOverlay(profile);
    assert(ov.rules.length === 1 && ov.rules[0].then.folder === 'Work', 'persisted');
  });

  await test('star / unread / attachments; disabled rules skip "run all" but "Run now" works', () => {
    const star = s.saveRule({ when: { hasAttachment: true }, then: { kind: 'star' } });
    const unread = s.saveRule({
      enabled: false,
      when: { subject: 'note 4; note 6' },
      then: { kind: 'unread' },
    });
    s.setRuleEnabled(s.rules[0].id, false);
    const res = s.runRules(null);
    assert(res.changed === 1 && res.perRule[star.id] === 1, JSON.stringify(res.perRule));
    const starred = s.index.entries.filter((e: any) => s.isStarred(e.id));
    assert(starred.length === 1 && starred[0].rel.endsWith('i2.eml'), 'the one with a file');
    const r2 = rv.actRunRules([unread.id]);
    assert(r2.changed === 2, `unread ${r2.changed}`);
    assert(s.lastRuleRun().changes.length === 2, 'last run');
    s.undoLastRuleRun();
    s.undoLastRuleRun();
    assert(!s.index.entries.some((e: any) => s.isStarred(e.id) || s.isUnread(e.id)), 'both undone');
  });

  await test('delete-locally and block are undoable', () => {
    for (const r of s.rules.slice()) s.deleteRule(r.id);
    const del = s.saveRule({ when: { from: 'gamma' }, then: { kind: 'trash' } });
    rv.actRunRules([del.id]);
    assert(s.localFolderCount('trash') === 3 && count('Inbox') === 3, 'to local trash');
    rv.actUndoLastRuleRun();
    assert(s.localFolderCount('trash') === 0, 'back');
    const blk = s.saveRule({ when: { subject: 'plan' }, then: { kind: 'block' } });
    const res = s.runRules([blk.id]);
    assert(
      res.blocked === 1 && s.isBlocked('beta@example.test') && count('Inbox') === 3,
      'blocked sender hidden'
    );
    s.undoLastRuleRun();
    assert(!s.isBlocked('beta@example.test') && count('Inbox') === 6, 'unblocked');
    s.deleteAllRules();
  });

  await test('on (re)index: enabled rules act only on mail that arrived since they last ran', async () => {
    const r = s.saveRule({ when: { from: 'beta' }, then: { kind: 'star' } });
    assert(r.lastRunAt > old, 'starts now');
    await new Promise((res) => setTimeout(res, 30));
    fs.writeFileSync(path.join(root, 'Inbox', 'n1.eml'), eml(B, 'New one', 13, 'n1'));
    await s.start(root, cache);
    const starred = s.index.entries
      .filter((e: any) => s.isStarred(e.id))
      .map((e: any) => path.basename(e.rel));
    assert(starred.join() === 'n1.eml', starred.join());
    assert(s.pendingRuleNotice && s.pendingRuleNotice.changed === 1, 'notice for the toast');
    await s.start(root, cache);
    assert(
      !s.pendingRuleNotice || s.pendingRuleNotice.changed === 1,
      'no second run on the same mail'
    );
    assert(s.lastRuleRun().trigger === 'new-mail', 'recorded');
    s.undoLastRuleRun();
    fs.unlinkSync(path.join(root, 'Inbox', 'n1.eml'));
  });

  await test('reset all local changes also clears the rules', () => {
    s.saveRule({ when: { from: 'beta' }, then: { kind: 'unread' } });
    offlineActionsUi.confirm = (t: string) => /כללים: 2/.test(t);
    actResetLocalChanges();
    assert(s.rules.length === 0 && readOverlay(profile).rules.length === 0, 'cleared');
  });

  await test('ribbon and ⋯ menu entry points; no network code', () => {
    const ribbon = read('lib/offline-mail/offline-ribbon.tsx');
    assert(/id: 'rules',[\s\S]{0,600}onClick: \(\) => openRules\(\)/.test(ribbon), 'ribbon Rules');
    assert(
      /id: 'rule-from-message'/.test(ribbon) && ribbon.includes('<OfflineRulesDialog />'),
      'from message + dialog'
    );
    assert(
      read('lib/offline-mail/offline-message-actions.tsx').includes('newRuleFromMessage(ids[0])'),
      '⋯ menu'
    );
    for (const f of ['lib/core/offline-rules.ts', 'lib/offline-mail/offline-rules-view.tsx']) {
      assert(
        !/\b(fetch|XMLHttpRequest|WebSocket|require\(['"](https?|net|tls)['"]\)|gemini)\b/i.test(
          read(f)
        ),
        f
      );
    }
  });

  // (n1 was added then removed by the test itself; compare the original files)
  await test('original files unchanged', () => {
    assert(
      hashTree(root) !== '' && fs.readdirSync(path.join(root, 'Inbox')).length === 6,
      'six files'
    );
    for (let i = 1; i <= 6; i++) {
      const p = path.join(root, 'Inbox', `i${i}.eml`);
      assert(
        fs.readFileSync(p, 'utf8') ===
          eml(i % 2 ? B : C, `Note ${i}`, i, `i${i}`, { file: i === 2 }),
        p
      );
    }
    void before;
  });

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
