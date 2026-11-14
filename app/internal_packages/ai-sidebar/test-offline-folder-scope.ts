#!/usr/bin/env npx ts-node
/**
 * Offline experiment regression: folder scope is exactly the selected folder
 * (no subfolders, no id collisions for Hebrew / nested names), scope facts
 * are exact, metadata questions are answered locally, and Summarize citations
 * are rebuilt from the local copy. No network.
 *
 *   npx ts-node --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-folder-scope.ts
 */
import {
  OFFLINE_ARCHIVE_ACCOUNT_ID,
  sanitizeGeminiScopeFacts,
} from '../../src/browser/gemini-demo-protocol';
import {
  buildOfflineGeminiContext,
  getOfflineArchiveScope,
  getOfflineScopeFacts,
  offlineFolderIdFor,
  searchOfflineArchive,
  setOfflineArchiveBrowserCatalog,
  setOfflineArchiveCatalog,
  setOfflineArchiveCurrentFolder,
} from './lib/offline-archive-catalog';
import {
  answerScopeMetadataLocally,
  classifyScopeMetadataQuestion,
  OFFLINE_SUMMARY_LABEL,
  rebuildCitationsFromSources,
} from './lib/core/scope-answers';
import { isAIBoundaryOk, validateProviderPayload } from './lib/core/ai-boundary';
import { MessageRef } from './lib/core/types';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
  }
}
function eq(a: any, b: any) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function ok(v: any, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}

let seq = 0;
function msgs(folderPath: string, n: number, opts: { legacyId?: string; senders?: number } = {}) {
  return Array.from({ length: n }, (_, i) => {
    seq++;
    const id = `offline-${String(seq).padStart(24, '0')}`;
    return {
      id,
      threadId: `offline-thread-${seq}`,
      accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
      folderId: opts.legacyId || offlineFolderIdFor(folderPath),
      folderPath,
      subject: `Subject ${seq}`,
      from: `Sender ${i % (opts.senders || 3)} <s${i % (opts.senders || 3)}@example.test>`,
      date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
      snippet: '',
      bodyText: '',
      sha256: '',
      byteLength: 10,
      attachmentCount: 0,
      sourceRelPath: `${folderPath}/${seq}.eml`,
    };
  });
}

async function run() {
  console.log('Category: folder ids');
  await test('Hebrew folders of the same length get different ids', () => {
    ok(offlineFolderIdFor('חשבון') !== offlineFolderIdFor('הזמנה'));
  });
  await test('nested vs dashed vs underscored names get different ids', () => {
    const ids = ['Work/2024', 'Work-2024', 'Work_2024', 'Work 2024'].map(offlineFolderIdFor);
    eq(new Set(ids).size, 4);
    eq(offlineFolderIdFor('Inbox'), 'Inbox');
  });

  // Inbox (16) has a subfolder Inbox/Sub (30) and a look-alike Inbox-Sub (20);
  // two Hebrew folders of the same length; one folder uses an old colliding id.
  const all = [
    ...msgs('Inbox', 16, { senders: 4 }),
    ...msgs('Inbox/Sub', 30),
    ...msgs('Inbox-Sub', 20),
    ...msgs('חשבון', 10, { legacyId: '_____' }),
    ...msgs('הזמנה', 9, { legacyId: '_____' }),
  ];
  setOfflineArchiveBrowserCatalog(all as any, null, (m) => `body of ${m.id}`);

  console.log('Category: folder scope is exactly one folder');
  await test('parent folder excludes its subfolder and look-alikes', async () => {
    setOfflineArchiveCurrentFolder({ path: 'Inbox', name: 'Inbox' });
    const scope = getOfflineArchiveScope('current-folder');
    eq(scope.messageCount, 16);
    ok(scope.description.includes('(16'), scope.description);
    ok(scope.description.includes('בלי תת-תיקיות'), 'subfolders stated');
    eq(searchOfflineArchive(scope, '', 'exhaustive', 100, 0).progress.totalEligible, 16);
    const ctx = await buildOfflineGeminiContext(scope, 'כמה מיילים יש בתיקייה הזו?');
    eq(ctx.inScope, 16);
    ok(ctx.sent <= 16 && ctx.scanned <= 16, `sent ${ctx.sent} scanned ${ctx.scanned}`);
    ok(ctx.messages.every((m) => all.find((x) => x.id === m.id)!.folderPath === 'Inbox'));
    eq(ctx.facts.totalInScope, 16);
    eq(ctx.facts.sent, ctx.sent);
    eq(ctx.facts.includesSubfolders, false);
    eq(ctx.facts.scopeKind, 'folder');
  });
  await test('subfolder alone', async () => {
    setOfflineArchiveCurrentFolder({ path: 'Inbox/Sub', name: 'Sub' });
    const scope = getOfflineArchiveScope('current-folder');
    eq(scope.messageCount, 30);
    const ctx = await buildOfflineGeminiContext(scope, 'סכם');
    eq(ctx.inScope, 30);
    ok(ctx.sent <= 30);
  });
  await test('Hebrew folders with an old colliding id stay separate', async () => {
    setOfflineArchiveCurrentFolder({ path: 'חשבון', name: 'חשבון' });
    const s1 = getOfflineArchiveScope('current-folder');
    eq(s1.messageCount, 10);
    eq(searchOfflineArchive(s1, '', 'exhaustive', 100, 0).progress.totalEligible, 10);
    eq((await buildOfflineGeminiContext(s1, 'סכם')).inScope, 10);
    setOfflineArchiveCurrentFolder({ path: 'הזמנה', name: 'הזמנה' });
    eq((await buildOfflineGeminiContext(getOfflineArchiveScope('current-folder'), 'x')).inScope, 9);
  });
  await test('whole copy facts and exact dates/senders', () => {
    setOfflineArchiveCurrentFolder({ path: 'Inbox', name: 'Inbox' });
    const f = getOfflineScopeFacts(getOfflineArchiveScope('current-folder'));
    eq(f.totalInScope, 16);
    eq(f.distinctSenders, 4);
    eq(f.oldest, '2024-01-01T00:00:00.000Z');
    eq(f.newest, '2024-01-16T00:00:00.000Z');
    eq(getOfflineScopeFacts(getOfflineArchiveScope('all-mail')).totalInScope, 85);
  });

  console.log('Category: local metadata answers');
  const facts = {
    scopeKind: 'folder' as const,
    includesSubfolders: false,
    totalInScope: 16,
    sent: 0,
    oldest: '2024-01-01T00:00:00.000Z',
    newest: '2024-01-16T00:00:00.000Z',
    distinctSenders: 4,
  };
  await test('"כמה מיילים יש בתיקייה הזו?" is answered locally with 16', () => {
    eq(classifyScopeMetadataQuestion('כמה מיילים יש בתיקייה הזו?'), 'count');
    const a = answerScopeMetadataLocally('כמה מיילים יש בתיקייה הזו?', facts)!;
    ok(a.includes('16'), a);
    ok(a.includes('בלי Gemini'), a);
  });
  await test('English and variants', () => {
    eq(classifyScopeMetadataQuestion('How many emails are in this folder?'), 'count');
    eq(classifyScopeMetadataQuestion('כמה הודעות יש?'), 'count');
    eq(classifyScopeMetadataQuestion('כמה שולחים שונים יש?'), 'senders');
    eq(classifyScopeMetadataQuestion('מתי התקבל המייל הראשון?'), 'oldest');
    eq(classifyScopeMetadataQuestion('what is the date of the newest email'), 'newest');
    ok(answerScopeMetadataLocally('כמה שולחים שונים יש?', facts)!.includes('4'));
  });
  await test('content questions still go to Gemini', () => {
    eq(classifyScopeMetadataQuestion('כמה מיילים יש מדני?'), null);
    eq(classifyScopeMetadataQuestion('סכם את המיילים בתיקייה'), null);
    eq(classifyScopeMetadataQuestion('מה המייל האחרון?'), null);
    eq(classifyScopeMetadataQuestion('כמה כסף שילמתי בחשבוניות?'), null);
    eq(classifyScopeMetadataQuestion('how many invoices did I get from Acme'), null);
  });
  await test('facts sanitizer: sent forced, total >= sent, junk rejected', () => {
    const f = sanitizeGeminiScopeFacts({ ...facts, sent: 999 }, 12)!;
    eq(f.sent, 12);
    eq(f.totalInScope, 16);
    eq(sanitizeGeminiScopeFacts({ ...facts, totalInScope: 3 }, 12)!.totalInScope, 12);
    eq(sanitizeGeminiScopeFacts({ totalInScope: 'x' }, 1), undefined);
    eq(sanitizeGeminiScopeFacts({ ...facts, oldest: 'not a date' }, 1)!.oldest, null);
  });

  console.log('Category: Summarize citations');
  const sent: MessageRef[] = [
    {
      id: all[0].id,
      threadId: all[0].threadId,
      accountId: OFFLINE_ARCHIVE_ACCOUNT_ID,
      subject: '',
      from: 'a@example.test',
      date: new Date('2024-01-01T00:00:00Z'),
      snippet: 's',
      folderId: all[0].folderId,
      bodyText: 'b',
    },
  ];
  await test('id-only citations are rebuilt; unknown and duplicate ids dropped', () => {
    const c = rebuildCitationsFromSources(
      [
        { messageId: all[0].id },
        { messageId: 'offline-unknown' },
        { messageId: all[0].id },
        all[0].id,
      ],
      sent
    );
    eq(c.length, 1);
    eq(c[0].threadId, all[0].threadId);
    eq(c[0].subject, '(ללא נושא)');
    eq(c[0].from, 'a@example.test');
  });
  await test('rebuilt Summarize answer passes the boundary (was: threadId/subject/from required)', () => {
    const v = validateProviderPayload(
      {
        response: 'סיכום',
        citations: rebuildCitationsFromSources([{ messageId: all[0].id }], sent),
        tokensUsed: 10,
        isMock: false,
        mockLabel: 'Gemini',
      },
      {
        allowedSourceIds: new Set([all[0].id]),
        startedGeneration: 1,
        currentGeneration: 1,
        aborted: false,
        allowLiveRealSelectedSingle: true,
        sourcesAreSynthetic: false,
      }
    );
    ok(isAIBoundaryOk(v), JSON.stringify(v));
  });
  await test('Summarize bubble label is Hebrew, not the internal prompt', () => {
    ok(/[\u0590-\u05FF]/.test(OFFLINE_SUMMARY_LABEL));
    ok(!/Summarize/i.test(OFFLINE_SUMMARY_LABEL));
  });

  setOfflineArchiveCatalog([], null);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void run();
