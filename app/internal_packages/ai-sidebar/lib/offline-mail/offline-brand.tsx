// Mail AI branding for the offline experiment (logo + short name). Only used
// in offline-archive mode; the official Mailspring UI is never branded.
import React from 'react';
import path from 'path';
import { pathToFileURL } from 'url';
import { tr } from '../core/offline-i18n';

export const OFFLINE_BRAND_NAME = 'Mail AI';

export type BrandLogoSize = 16 | 24 | 32 | 48 | 64 | 128 | 256;

export function offlineBrandLogoPath(resourcePath: string, size: BrandLogoSize = 64): string {
  return path.join(resourcePath || '', 'static', 'images', 'offline', `mail-ai-${size}.png`);
}

export function offlineBrandLogoUrl(size: BrandLogoSize = 64): string {
  let resourcePath = '';
  try {
    resourcePath = (AppEnv.getLoadSettings() || {}).resourcePath || '';
  } catch (e) {
    resourcePath = '';
  }
  return pathToFileURL(offlineBrandLogoPath(resourcePath, size)).href;
}

export function offlineBrandSubtitle(): string {
  return tr('מצב לא מקוון', 'Offline');
}

/** Full product label, e.g. "Mail AI · מצב לא מקוון". */
export function offlineBrandLabel(): string {
  return `${OFFLINE_BRAND_NAME} · ${offlineBrandSubtitle()}`;
}

// 24px uses the pixel-drawn icon (crisp "AI" on 1x screens), 48px on 2x.
export function OfflineBrandLogo(props: { size?: 16 | 24 | 32; className?: string }) {
  const px = props.size || 24;
  const hi = (px * 2) as BrandLogoSize;
  return (
    <img
      className={props.className || 'offline-brand-logo'}
      src={offlineBrandLogoUrl(px)}
      srcSet={`${offlineBrandLogoUrl(px)} 1x, ${offlineBrandLogoUrl(hi)} 2x, ${offlineBrandLogoUrl(128)} 3x`}
      width={px}
      height={px}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function offlineBrandToggleTitle(): string {
  return tr(`פתח/סגור את עוזר ${OFFLINE_BRAND_NAME}`, `Toggle ${OFFLINE_BRAND_NAME} assistant`);
}

/** Ribbon brand. With onActivate it is a button that toggles the AI panel
 * (native <button>: Enter / Space work, focus ring via :focus-visible). */
export function OfflineBrand(props: {
  compact?: boolean;
  onActivate?: () => void;
  aiOpen?: boolean;
}) {
  const content = (
    <>
      <OfflineBrandLogo />
      <span className="offline-brand-name" dir="ltr">
        {OFFLINE_BRAND_NAME}
      </span>
      {props.compact ? null : (
        <span className="offline-brand-sub">
          <span className="offline-brand-dot" aria-hidden="true">
            ·
          </span>
          {offlineBrandSubtitle()}
        </span>
      )}
    </>
  );
  if (!props.onActivate) {
    return (
      <div
        className="offline-brand"
        data-offline-brand="true"
        title={offlineBrandLabel()}
        aria-label={offlineBrandLabel()}
        role="img"
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="offline-brand offline-brand-button"
      data-offline-brand="true"
      data-offline-brand-ai-open={props.aiOpen ? 'true' : 'false'}
      title={offlineBrandToggleTitle()}
      aria-label={`${offlineBrandLabel()} – ${offlineBrandToggleTitle()}`}
      aria-pressed={!!props.aiOpen}
      onClick={props.onActivate}
    >
      {content}
    </button>
  );
}
