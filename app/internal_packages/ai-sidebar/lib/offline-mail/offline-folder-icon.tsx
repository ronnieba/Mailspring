import React from 'react';
import { OfflineFolderIconKind } from '../core/offline-folder-roles';

/**
 * Inline SVG folder-tree icons (no remote assets). Strokes use currentColor;
 * fills come from CSS so every theme can tint them.
 */
const PATHS: { [k in OfflineFolderIconKind]: React.ReactNode } = {
  folder: (
    <path
      className="ofl-ficon-fill"
      d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3.3c.3 0 .6.1.8.3l1.2 1.2h5.5c.6 0 1.1.5 1.1 1.1v6.6c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"
    />
  ),
  'folder-open': (
    <>
      <path
        className="ofl-ficon-back"
        d="M1.5 12V4.2c0-.6.5-1.1 1.1-1.1h3.3c.3 0 .6.1.8.3l1.2 1.2h4.9c.6 0 1.1.5 1.1 1.1v1.1"
      />
      <path
        className="ofl-ficon-fill"
        d="M3.4 7.3c.1-.4.5-.7 1-.7h9.9c.5 0 .9.5.7 1l-1.4 4.6c-.1.4-.5.7-1 .7H2.2c-.5 0-.8-.4-.7-.9z"
      />
    </>
  ),
  'folder-leaf': (
    <path
      className="ofl-ficon-fill ofl-ficon-light"
      d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3.3c.3 0 .6.1.8.3l1.2 1.2h5.5c.6 0 1.1.5 1.1 1.1v6.6c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"
    />
  ),
  inbox: (
    <>
      <path
        className="ofl-ficon-soft"
        d="M1.8 9.3 3.9 3.6c.1-.3.4-.5.7-.5h6.8c.3 0 .6.2.7.5l2.1 5.7v3.4c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"
      />
      <path d="M1.8 9.3h3.5l1 1.6h3.4l1-1.6h3.5" />
    </>
  ),
  sent: (
    <>
      <path className="ofl-ficon-soft" d="M14.4 1.6 1.6 6.9l5 2 2 5z" />
      <path d="M14.4 1.6 6.6 8.9" />
    </>
  ),
  drafts: (
    <>
      <path className="ofl-ficon-soft" d="M3.5 1.6h5.8l3.2 3.2v9.6h-9z" />
      <path d="M9.3 1.6v3.2h3.2M5.5 8h5M5.5 10.5h3.5" />
    </>
  ),
  archive: (
    <>
      <path
        className="ofl-ficon-soft"
        d="M2.6 5.6h10.8v7.6c0 .6-.5 1.1-1.1 1.1H3.7c-.6 0-1.1-.5-1.1-1.1z"
      />
      <path d="M1.5 2.6h13v3h-13zM6.3 8.3h3.4" />
    </>
  ),
  spam: (
    <>
      <path
        className="ofl-ficon-soft"
        d="M8 1.5 13.5 3.4v4.1c0 3.4-2.4 5.9-5.5 7-3.1-1.1-5.5-3.6-5.5-7V3.4z"
      />
      <path d="M8 4.8v3.6M8 10.6v.3" />
    </>
  ),
  trash: (
    <>
      <path className="ofl-ficon-soft" d="m3.7 4.3.8 9.2c.1.5.5.9 1 .9h5c.5 0 .9-.4 1-.9l.8-9.2" />
      <path d="M2.3 4.3h11.4M6 4.3V2.6c0-.3.2-.5.5-.5h3c.3 0 .5.2.5.5v1.7M6.6 6.8v4.8M9.4 6.8v4.8" />
    </>
  ),
  'local-drafts': (
    <>
      <path
        className="ofl-ficon-soft"
        d="M10.9 2.1a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L6.2 12.8 2.4 13.6l.8-3.8z"
      />
      <path d="m9.6 3.4 3 3" />
    </>
  ),
};

export function OfflineFolderIcon({ kind }: { kind: OfflineFolderIconKind }) {
  return (
    <svg
      className={`ofl-ficon ofl-ficon-${kind}`}
      data-offline-folder-icon={kind}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[kind]}
    </svg>
  );
}
