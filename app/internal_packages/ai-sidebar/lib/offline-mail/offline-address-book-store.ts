/**
 * Offline experiment: local address book state (renderer).
 * Built from the offline index headers (From/To/Cc/Reply-To) and saved only
 * in the offline profile. No network, no Gemini.
 */
import {
  AddressBookSourceEntry,
  OFFLINE_ADDRESS_BOOK_VERSION,
  OfflineContact,
  buildAddressBook,
  readAddressBook,
  searchAddressBook,
  writeAddressBook,
} from '../core/offline-address-book';

type Listener = () => void;

export class OfflineAddressBookStore {
  contacts: OfflineContact[] = [];
  builtFrom = 0;
  private _dir: string | null = null;
  private _listeners = new Set<Listener>();
  private _lastIndex: unknown = null;

  configure(configDir: string) {
    this._dir = configDir;
    const saved = readAddressBook(configDir);
    if (saved) {
      this.contacts = saved.contacts;
      this.builtFrom = saved.sourceMessages;
      this._emit();
    }
  }

  listen(cb: Listener): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (e) {
        console.error('[Offline address book] listener failed', e);
      }
    }
  }

  /** Rebuild from a fresh index (once per index object). */
  rebuild(
    index: { entries: AddressBookSourceEntry[]; folderNames?: { [k: string]: string } } | null,
    now = Date.now()
  ) {
    if (!index || index === this._lastIndex) {
      return;
    }
    this._lastIndex = index;
    const t0 = Date.now();
    this.contacts = buildAddressBook(index.entries, { folderNames: index.folderNames, now });
    this.builtFrom = index.entries.length;
    if (this._dir) {
      try {
        writeAddressBook(this._dir, {
          version: OFFLINE_ADDRESS_BOOK_VERSION,
          builtAt: new Date(now).toISOString(),
          sourceMessages: index.entries.length,
          contacts: this.contacts,
        });
      } catch (e) {
        console.error('[Offline address book] save failed:', (e as Error).message);
      }
    }
    console.log(
      `[Offline address book] ${this.contacts.length} contacts from ${index.entries.length} messages (${
        Date.now() - t0
      }ms)`
    );
    this._emit();
  }

  /** Contacts the user saved with "Add sender to contacts" (local overlay). */
  savedProvider: (() => { email: string; name: string; at: number }[]) | null = null;

  /** Saved contacts (ranked first) followed by contacts learned from headers. */
  allContacts(): OfflineContact[] {
    const saved = this.savedProvider ? this.savedProvider() : [];
    if (!saved.length) {
      return this.contacts;
    }
    const byEmail = new Map(this.contacts.map((c) => [c.email.toLowerCase(), c]));
    const first: OfflineContact[] = saved.map((s) => {
      const known = byEmail.get(s.email.toLowerCase());
      return {
        email: known ? known.email : s.email,
        name: s.name || (known ? known.name : ''),
        count: known ? known.count : 0,
        sentTo: known ? known.sentTo : 0,
        last: known ? known.last : s.at,
        score: Number.MAX_SAFE_INTEGER,
      };
    });
    const savedSet = new Set(saved.map((s) => s.email.toLowerCase()));
    return [...first, ...this.contacts.filter((c) => !savedSet.has(c.email.toLowerCase()))];
  }

  search(query: string, limit = 8, exclude: string[] = []): OfflineContact[] {
    return searchAddressBook(this.allContacts(), query, limit, exclude);
  }
}

export const offlineAddressBook = new OfflineAddressBookStore();
