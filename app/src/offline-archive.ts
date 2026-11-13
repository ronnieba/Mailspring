/**
 * Disconnected experiment reader. `--offline-archive` uses Mailspring-offline,
 * skips mailsync, and never opens the official profile. It is not `--demo`
 * (synthetic) and not `--real-selected-summary` (live Yahoo).
 *
 * Tests may override via `setOfflineArchiveOverride`.
 */
let override: boolean | null = null;

export function setOfflineArchiveOverride(value: boolean | null): void {
  override = value;
}

export function isOfflineArchiveMode(): boolean {
  if (override !== null) {
    return override;
  }
  if (typeof window !== 'undefined') {
    const props = (
      window as unknown as { loadSettings?: { windowProps?: { offlineArchive?: boolean } } }
    ).loadSettings?.windowProps;
    if (props && props.offlineArchive === true) {
      return true;
    }
  }
  if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
    if (process.argv.includes('--demo') || process.env.MAILSPRING_DEMO === '1') {
      return false;
    }
    if (process.argv.includes('--offline-archive')) {
      return true;
    }
  }
  if (typeof process !== 'undefined' && process.env.MAILSPRING_OFFLINE_ARCHIVE === '1') {
    return true;
  }
  return false;
}

export function offlineArchivePathFromEnv(): string | null {
  if (typeof process === 'undefined' || !process.env) {
    return null;
  }
  const p = process.env.MAILSPRING_OFFLINE_ARCHIVE_PATH;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/**
 * Packages that are not activated in the offline experiment. They depend on a
 * real account, the mail database, mailsync, sending, or outside services.
 * The offline browser in ai-sidebar replaces the folder/thread/message views.
 */
export const OFFLINE_ARCHIVE_DISABLED_PACKAGES: ReadonlyArray<string> = [
  'account-sidebar',
  'activity',
  'category-picker',
  'composer',
  'composer-grammar-check',
  'composer-signature',
  'composer-templates',
  'contacts',
  'draft-list',
  'events',
  'github-contact-card',
  'link-tracking',
  'list-unsubscribe',
  'unsubscribe',
  'main-calendar',
  'mcp-server',
  'message-list',
  'message-view-on-github',
  'notifications',
  'open-tracking',
  'participant-profile',
  'personal-level-indicators',
  'phishing-detection',
  'send-and-archive',
  'send-later',
  'send-reminders',
  'system-tray',
  'thread-list',
  'thread-search',
  'thread-sharing',
  'thread-snooze',
  'translation',
  'undo-redo',
  'unread-notifications',
];

export function isPackageDisabledInOfflineArchive(name: string): boolean {
  return OFFLINE_ARCHIVE_DISABLED_PACKAGES.includes(name);
}
