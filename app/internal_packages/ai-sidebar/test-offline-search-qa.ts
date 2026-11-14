#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t232): "Ask about my mail" - a question becomes a local
 * search, and only the capped text of the top results would be sent to Gemini.
 * Pure helpers and the catalog step only; nothing is sent; no network.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-search-qa.ts
 */
import fs from 'fs';
import path from 'path';
import {
  capForQa,
  QA_MAX_BODY_CHARS,
  QA_MAX_MESSAGES,
  QA_MAX_TOTAL_CHARS,
  questionToSearchQuery,
  looksLikeQuestion,
  ASK_AI_TOOLTIP,
  ASK_AI_QUESTION_HINT,
} from './lib/core/offline-search-qa';
import {
  buildOfflineQuestionContext,
  hasOfflineQuestionSearch,
  setOfflineArchiveCatalog,
  setOfflineQuestionSearcher,
} from './lib/offline-archive-catalog';
import { OFFLINE_ARCHIVE_ACCOUNT_ID } from './lib/core/offline-archive-format';
import { sanitizeGeminiScopeFacts } from '../../src/browser/gemini-demo-protocol';
import { scopePhrase } from './lib/core/scope-answers';
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
function assert(c: unknown, m: string) {
  if (!c) throw new Error(m);
}

function msg(i: number, body: string): any {
  return {
    id: `offline-${i}`,
    threadId: `t-${i}`,
    accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
    folderId: 'INBOX',
    folderPath: 'Inbox',
    subject: `Synthetic ${i}`,
    from: `S${i} <s${i}@example.test>`,
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    snippet: body.slice(0, 40),
    bodyText: body,
    sha256: String(i).padStart(64, '0'),
    byteLength: body.length,
    attachmentCount: 0,
  };
}

async function main() {
  setOfflineLangOverride('en');

  await test('question words are dropped; the rest is OR-ed (Hebrew + English)', () => {
    const a = questionToSearchQuery('What did Tom say about the budget report?');
    assert(a.query === 'tom OR budget OR report', a.query);
    const b = questionToSearchQuery('מתי הפגישה עם דנה על התקציב?');
    assert(
      b.terms.includes('פגישה') && b.terms.includes('דנה') && b.terms.includes('תקציב'),
      b.query
    );
    assert(!/(^| )(מתי|עם|על)( |$)/.test(b.query), b.query);
    assert(b.query.split(' OR ').length === b.terms.length, 'OR between all');
  });

  await test('quoted phrases and search operators are kept', () => {
    const r = questionToSearchQuery('מה כתבו "הלוואה לדיור" על הריבית from:bank has:attachment');
    assert(r.query.startsWith('"הלוואה לדיור" OR הריבית OR ריבית'), r.query);
    assert(r.query.endsWith('from:bank has:attachment'), r.query);
    assert(!r.terms.includes('כתבו'), 'verb dropped');
  });

  await test('only question words: no search, nothing to send', () => {
    assert(questionToSearchQuery('מה? איך? why?').query === '', 'empty');
    assert(questionToSearchQuery('').query === '', 'blank');
  });

  await test('term count is capped', () => {
    const r = questionToSearchQuery(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
    );
    assert(r.terms.length === 8, String(r.terms.length));
  });

  await test('caps: at most 12 messages, 2500 chars each, 30000 total; ranking kept', () => {
    assert(
      QA_MAX_MESSAGES === 12 && QA_MAX_BODY_CHARS === 2500 && QA_MAX_TOTAL_CHARS === 30000,
      'caps'
    );
    const rows = Array.from({ length: 30 }, (_, i) => ({ n: i, body: 'x'.repeat(5000) }));
    const out = capForQa(rows);
    assert(out.length === 12 && out.every((o) => o.cleanBody.length === 2500), String(out.length));
    assert(out.map((o) => o.n).join() === Array.from({ length: 12 }, (_, i) => i).join(), 'order');
    const tight = capForQa(rows, { maxTotalChars: 6000 });
    assert(tight.length === 2, String(tight.length));
  });

  await test('catalog: search ids → capped message text, in search order, search-scope facts', async () => {
    const all = Array.from({ length: 20 }, (_, i) => msg(i, `body ${i} ` + 'y'.repeat(3000)));
    setOfflineArchiveCatalog(all);
    assert(!hasOfflineQuestionSearch(), 'no searcher yet');
    const none = await buildOfflineQuestionContext('anything');
    assert(none.messages.length === 0, 'nothing without a search');
    let asked = '';
    setOfflineQuestionSearcher((q) => {
      asked = q;
      return {
        query: 'budget',
        terms: ['budget'],
        ids: ['offline-7', 'offline-3', 'nope', 'offline-15'],
        total: 41,
      };
    });
    const ctx = await buildOfflineQuestionContext('What about the budget?');
    assert(asked === 'What about the budget?', 'question passed');
    assert(
      ctx.messages.map((m) => m.id).join() === 'offline-7,offline-3,offline-15',
      'order + unknown dropped'
    );
    assert(
      ctx.messages.every((m) => m.bodyText!.length <= QA_MAX_BODY_CHARS),
      'per-message cap'
    );
    assert(ctx.found === 41 && ctx.sent === 3, `${ctx.found}/${ctx.sent}`);
    assert(
      ctx.facts.scopeKind === 'search' && ctx.facts.sent === 3 && ctx.facts.totalInScope === 41,
      JSON.stringify(ctx.facts)
    );
    setOfflineQuestionSearcher(() => ({ query: 'zzz', terms: ['zzz'], ids: [], total: 0 }));
    const empty = await buildOfflineQuestionContext('zzz?');
    assert(empty.messages.length === 0 && empty.query === 'zzz', 'no matches');
    setOfflineQuestionSearcher(null);
  });

  await test('Gemini request facts accept the search scope; the panel names it', () => {
    const f = sanitizeGeminiScopeFacts(
      {
        scopeKind: 'search',
        totalInScope: 41,
        sent: 99,
        oldest: null,
        newest: null,
        distinctSenders: 3,
      },
      3
    );
    assert(
      f && f.scopeKind === 'search' && f.sent === 3 && f.totalInScope === 41,
      JSON.stringify(f)
    );
    const bad = sanitizeGeminiScopeFacts({ scopeKind: 'evil', totalInScope: 1 }, 1);
    assert(bad && bad.scopeKind === 'all', 'unknown kind');
    assert(scopePhrase(f!) === 'In the local search results', scopePhrase(f!));
    const host = fs.readFileSync(
      path.join(__dirname, '../../src/browser/gemini-demo-host.ts'),
      'utf8'
    );
    assert(
      /f\.scopeKind === 'search'[\s\S]{0,80}local full-text search/.test(host),
      'prompt wording'
    );
  });

  await test('explicit click only: buttons call askAboutMail; nothing runs on load or typing', () => {
    const view = fs.readFileSync(
      path.join(__dirname, 'lib/offline-mail/offline-search-view.tsx'),
      'utf8'
    );
    assert(
      /data-offline-search-ask-ai[\s\S]{0,900}onClick=\{\(\) => askAiAboutMail\(s\.query\)\}/.test(
        view
      ),
      'search bar button'
    );
    assert(!/onKeyDown[^\n]*askAi/.test(view), 'not on Enter');
    const panel = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar.tsx'), 'utf8');
    assert(
      /onClick=\{this\._onAskAboutMail\}[\s\S]{0,200}data-ai-ask-mail="true"/.test(panel),
      'panel button'
    );
    const calls = panel.match(/askAboutMail\(/g) || [];
    assert(calls.length === 1, 'one call site in the panel');
    const store = fs.readFileSync(path.join(__dirname, 'lib/ai-sidebar-store.ts'), 'utf8');
    const body = store.slice(
      store.indexOf('async askAboutMail('),
      store.indexOf('async summarizeSelectedMessage(')
    );
    assert(
      body.includes('if (!this._state.geminiStatus.configured)') &&
        body.includes('nothing was sent'),
      'no Gemini → local list'
    );
    assert(
      body.indexOf('buildOfflineQuestionContext') < body.indexOf('processQuery'),
      'local search first'
    );
    assert(
      body.includes('scopeFacts: ctx.facts') && body.includes('allowedSourceIds'),
      'citations only from sent ids'
    );
    assert(
      !/fetch\(|XMLHttpRequest|require\(['"]https?['"]\)/.test(
        fs.readFileSync(path.join(__dirname, 'lib/core/offline-search-qa.ts'), 'utf8')
      ),
      'no network in helpers'
    );
  });

  await test('looks like a question: question words or "?", never one word', () => {
    for (const q of [
      'מתי הפגישה עם דנה',
      'מה כתבו על החשבונית',
      'ומתי זה נקבע',
      'איפה הקבלה?',
      'כמה עלה הטיפול',
      'האם שילמנו',
      'למה זה בוטל',
      'איך מגיעים',
      'what did dana say',
      'When is the meeting',
      'who sent the invoice',
      'Where is it',
      'how much',
      'did we pay',
      'is it done',
      'the meeting tomorrow?',
    ]) {
      assert(looksLikeQuestion(q), q);
    }
    for (const q of [
      '',
      '   ',
      'חשבונית',
      'מתי',
      'מתי?',
      'invoice?',
      'what',
      'from:dana has:attachment',
      'חשבונית חשמל',
      'meeting notes',
      'משפחה OR כסף',
    ]) {
      assert(!looksLikeQuestion(q), `not: ${q}`);
    }
  });

  await test('Ask AI tooltip and hint explain local typing vs. paid click (Hebrew + English)', () => {
    const [he, en] = ASK_AI_TOOLTIP;
    assert(
      /מקומית/.test(he) &&
        /Gemini/.test(he) &&
        he.includes('12') &&
        /טקסט בלבד/.test(he) &&
        /חלונית ה-AI/.test(he) &&
        /בתשלום/.test(he) &&
        /רק בלחיצה/.test(he),
      he
    );
    assert(
      /locally/.test(en) &&
        /Gemini/.test(en) &&
        en.includes('12') &&
        /text only/.test(en) &&
        /AI panel/.test(en) &&
        /click to open/.test(en) &&
        /Paid/.test(en) &&
        /only on click/.test(en),
      en
    );
    assert(ASK_AI_QUESTION_HINT[0] === 'נראה כמו שאלה — לחץ שאל AI לתשובה', 'he hint');
    const view = fs.readFileSync(
      path.join(__dirname, 'lib/offline-mail/offline-search-view.tsx'),
      'utf8'
    );
    assert(
      view.includes("'חפש מילים, או כתוב שאלה ולחץ שאל AI'") &&
        view.includes("'Search words, or type a question and click Ask AI'"),
      'placeholder'
    );
    assert(
      view.includes('title={tr(ASK_AI_TOOLTIP[0], ASK_AI_TOOLTIP[1])}') &&
        view.includes('is-question') &&
        view.includes('data-offline-search-question-hint'),
      'button + hint'
    );
    assert(
      /onClick=\{\(\) => askAiAboutMail\(s\.query\)\}/.test(view) &&
        (view.match(/askAiAboutMail\(/g) || []).length === 1,
      'sent only from the click'
    );
    const tour = fs.readFileSync(path.join(__dirname, 'lib/core/offline-tour.ts'), 'utf8');
    assert(
      tour.includes('מאת:') && tour.includes('has:attachment') && tour.includes('12 הודעות'),
      'operators + limit in the ? tip'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
