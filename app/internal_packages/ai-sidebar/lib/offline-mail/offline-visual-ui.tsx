/**
 * Offline experiment (t243): small shared visual pieces. Sender avatars
 * (initials on a stable color, generated locally — never fetched), one set
 * of inline SVG icons for list/reader flags, and local color tag chips.
 */
import React from 'react';
import { avatarFor } from '../core/offline-visual';
import { LocalTag } from '../core/offline-local-overlay';

export function OfflineAvatar(props: { from: string; size?: number; className?: string }) {
  const a = avatarFor(props.from);
  const size = props.size || 32;
  return (
    <span
      className={`offline-avatar ${props.className || ''}`}
      data-offline-avatar={a.initials}
      aria-hidden="true"
      style={{
        background: a.color,
        width: size,
        height: size,
        minWidth: size,
        fontSize: Math.round(size * 0.4),
        lineHeight: `${size}px`,
      }}
    >
      {a.initials}
    </span>
  );
}

export type OfflineIconName = 'attach' | 'star' | 'star-on' | 'reply' | 'forward' | 'tag';

const PATHS: { [k in OfflineIconName]: string } = {
  attach: 'M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  'star-on': 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  reply: 'M10 7L4 12l6 5M4.5 12H14a6 6 0 0 1 6 6v1',
  forward: 'M14 7l6 5-6 5M19.5 12H10a6 6 0 0 0-6 6v1',
  tag: 'M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-6.9 6.9a1 1 0 0 1-1.4 0z M8 8h.01',
};

/** One consistent stroke icon (inherits the text color; RTL-safe). */
export function OfflineIcon(props: {
  name: OfflineIconName;
  size?: number;
  title?: string;
  className?: string;
}) {
  const size = props.size || 14;
  const filled = props.name === 'star-on';
  return (
    <svg
      className={`offline-icon offline-icon-${props.name} ${props.className || ''}`}
      data-offline-icon={props.name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={props.title ? 'img' : undefined}
      aria-hidden={props.title ? undefined : true}
      aria-label={props.title}
    >
      {props.title ? <title>{props.title}</title> : null}
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** Tag chips (reader header / tag menu preview). */
export function OfflineTagChips(props: { tags: LocalTag[]; onRemove?: (t: LocalTag) => void }) {
  if (!props.tags.length) return null;
  return (
    <span className="offline-tag-chips" data-offline-tag-chips={props.tags.length}>
      {props.tags.map((t) => (
        <span
          key={t.id}
          className="offline-tag-chip"
          data-offline-tag-chip={t.id}
          style={{ borderColor: t.color, ['--ofl-tag' as any]: t.color }}
        >
          <span className="offline-tag-dot" style={{ background: t.color }} />
          <span dir="auto">{t.name}</span>
          {props.onRemove ? (
            <button
              type="button"
              className="offline-tag-chip-x"
              data-offline-tag-remove={t.id}
              aria-label={`× ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                props.onRemove!(t);
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** Thin color strip at the row edge: one band per tag. */
export function OfflineTagStrip(props: { tags: LocalTag[] }) {
  if (!props.tags.length) return null;
  return (
    <span
      className="offline-tag-strip"
      data-offline-tag-strip={props.tags.map((t) => t.id).join(' ')}
      title={props.tags.map((t) => t.name).join(', ')}
    >
      {props.tags.map((t) => (
        <span key={t.id} style={{ background: t.color }} />
      ))}
    </span>
  );
}
