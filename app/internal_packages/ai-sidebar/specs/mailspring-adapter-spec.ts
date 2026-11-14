/**
 * Mailspring adapter tests.
 * Tests scope resolution, search, and navigation behavior.
 * Uses mocked Mailspring stores.
 */
import {
  AccountStore,
  FocusedContentStore,
  FocusedPerspectiveStore,
  FolderSyncProgressStore,
  Actions,
} from 'mailspring-exports';

describe('MailspringAdapter', function () {
  let MailspringAdapter: any;
  let adapter: any;

  beforeEach(function () {
    MailspringAdapter = require('../lib/mailspring-adapter').MailspringAdapter;
    adapter = new MailspringAdapter();

    spyOn(AccountStore, 'accountIds').andReturn([TEST_ACCOUNT_ID]);
    spyOn(FolderSyncProgressStore, 'getSyncState').andReturn({
      [TEST_ACCOUNT_ID]: {
        INBOX: { busy: false, scanProgress: 1.0, bodyProgress: 0.9 },
        Sent: { busy: false, scanProgress: 1.0, bodyProgress: 1.0 },
      },
    });
  });

  describe('resolveScope', function () {
    it('returns empty scope when nothing selected', async function () {
      spyOn(FocusedContentStore, 'focused').andReturn(null);
      spyOn(FocusedPerspectiveStore, 'current').andReturn({
        accountIds: [TEST_ACCOUNT_ID],
        categories: () => [],
      });

      const scope = await adapter.resolveScope('selected-messages');
      expect(scope.isEmpty).toBe(true);
      expect(scope.mode).toBe('selected-messages');
    });

    it('resolves current folder scope', async function () {
      spyOn(FocusedPerspectiveStore, 'current').andReturn({
        accountIds: [TEST_ACCOUNT_ID],
        categories: () => [
          {
            id: 'folder-inbox',
            accountId: TEST_ACCOUNT_ID,
            displayName: 'Inbox',
            role: 'inbox',
          },
        ],
      });

      const scope = await adapter.resolveScope('current-folder');
      expect(scope.mode).toBe('current-folder');
      expect(scope.folder).toBeDefined();
      expect(scope.folder.role).toBe('inbox');
    });

    it('resolves all-mail scope', async function () {
      spyOn(FocusedPerspectiveStore, 'current').andReturn({
        accountIds: [TEST_ACCOUNT_ID],
        categories: () => [],
      });

      const scope = await adapter.resolveScope('all-mail');
      expect(scope.mode).toBe('all-mail');
      expect(scope.isEmpty).toBe(false);
    });
  });

  describe('getSyncProgress', function () {
    it('calculates sync progress for known accounts', async function () {
      const progress = await adapter.getSyncProgress([TEST_ACCOUNT_ID]);
      expect(progress[TEST_ACCOUNT_ID]).toBeDefined();
      expect(progress[TEST_ACCOUNT_ID]).toBeGreaterThan(0);
    });

    it('returns 0 for unknown accounts', async function () {
      const progress = await adapter.getSyncProgress(['unknown-account']);
      expect(progress['unknown-account']).toBe(0);
    });
  });

  describe('navigateToMessage', function () {
    it('indicates read state cannot be preserved', async function () {
      // Navigation always changes read state in Mailspring
      const preserved = await adapter.navigateToMessage('any-msg-id', true);
      // We expect it to return false because Mailspring cannot preserve read state
      expect(preserved).toBe(false);
    });
  });
});
