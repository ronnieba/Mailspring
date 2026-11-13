import React from 'react';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { offlineSearchStore } from './offline-search-store';

/** Re-render a component whenever the offline mail or local drafts store changes. */
export class OfflineStoreComponent<
  P = Record<string, never>,
  S = Record<string, never>,
> extends React.Component<P, S> {
  private _unlisten: (() => void) | null = null;
  private _unlistenDrafts: (() => void) | null = null;
  private _unlistenSearch: (() => void) | null = null;
  componentDidMount() {
    this._unlisten = offlineMailStore.listen(() => this.forceUpdate());
    this._unlistenDrafts = offlineDraftsStore.listen(() => this.forceUpdate());
    this._unlistenSearch = offlineSearchStore.listen(() => this.forceUpdate());
  }
  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
    if (this._unlistenDrafts) {
      this._unlistenDrafts();
    }
    if (this._unlistenSearch) {
      this._unlistenSearch();
    }
  }
}
