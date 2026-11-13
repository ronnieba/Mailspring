import React from 'react';
import { offlineMailStore } from './offline-mail-store';

/** Re-render a component whenever the offline mail store changes. */
export class OfflineStoreComponent<
  P = Record<string, never>,
  S = Record<string, never>,
> extends React.Component<P, S> {
  private _unlisten: (() => void) | null = null;
  componentDidMount() {
    this._unlisten = offlineMailStore.listen(() => this.forceUpdate());
  }
  componentWillUnmount() {
    if (this._unlisten) {
      this._unlisten();
    }
  }
}
