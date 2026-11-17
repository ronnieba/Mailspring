/**
 * Offline experiment (t235): "מיילי" / "Maily", the Mail AI mascot (the
 * envelope-with-sparkle logo as a little character), a guided tour with
 * spotlight bubbles over the real UI, a first-run invitation and small "?"
 * tips. Hebrew / English, light / dark, skippable. Drawn locally (inline SVG,
 * no images or fonts from the network); prefs live in the offline profile.
 */
import React from 'react';
import { tr, offlineDir } from '../core/offline-i18n';
import { offlineMailStore } from './offline-mail-store';
import {
  MASCOT_NAME,
  MascotMood,
  TOUR_STEPS,
  TOUR_TIPS,
  TourPrefs,
  TourRibbonTab,
  placeBubble,
  readTourPrefs,
  shouldOfferTour,
  writeTourPrefs,
} from '../core/offline-tour';

type Listener = () => void;

export const OFFLINE_RIBBON_TAB_EVENT = 'offline-ribbon-show-tab';

/** Ask the ribbon to show a tab (the ribbon listens for this event). */
export function showRibbonTab(tab: TourRibbonTab) {
  window.dispatchEvent(new CustomEvent(OFFLINE_RIBBON_TAB_EVENT, { detail: tab }));
}

const L = (pair: [string, string]) => tr(pair[0], pair[1]);

// ---- Mascot ----------------------------------------------------------------

/** Maily: the Mail AI envelope with a face, little arms and its sparkle. */
export function OfflineMascot(props: {
  size?: number;
  mood?: MascotMood;
  animate?: boolean;
  className?: string;
}) {
  const size = props.size || 72;
  const mood = props.mood || 'happy';
  // Same gradients in every copy, so shared ids are harmless.
  const g = 'ofl-mascot-g';
  const env = 'ofl-mascot-e';
  const wink = mood === 'wink';
  return (
    <svg
      className={`offline-mascot mood-${mood}${props.animate === false ? '' : ' is-animated'} ${props.className || ''}`}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={L(MASCOT_NAME)}
      data-offline-mascot={mood}
    >
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8be32f" />
          <stop offset="0.55" stopColor="#25d07a" />
          <stop offset="1" stopColor="#0bc3d6" />
        </linearGradient>
        <linearGradient id={env} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eefaf3" />
        </linearGradient>
      </defs>
      <ellipse className="ofl-m-shadow" cx="60" cy="112" rx="30" ry="5" fill="rgba(0,0,0,0.18)" />
      <g className="ofl-m-body">
        {/* feet */}
        <ellipse cx="45" cy="101" rx="9" ry="5" fill="#16b36b" />
        <ellipse cx="75" cy="101" rx="9" ry="5" fill="#16b36b" />
        {/* arms */}
        <path
          className="ofl-m-arm-l"
          d="M20 66 q-12 -2 -14 -14"
          stroke="#16b36b"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          className="ofl-m-arm-r"
          d="M100 66 q12 -4 14 -18"
          stroke="#16b36b"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
        {/* envelope */}
        <rect x="16" y="34" width="88" height="64" rx="14" fill={`url(#${g})`} />
        <rect x="21" y="39" width="78" height="54" rx="10" fill={`url(#${env})`} />
        <path
          d="M23 43 L60 70 L97 43"
          stroke="#b5ebcd"
          strokeWidth="4"
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M24 90 L46 70 M96 90 L74 70"
          stroke="#d3f2e1"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* face */}
        <g className="ofl-m-eyes">
          {wink ? (
            <path
              d="M40 64 q6 -5 12 0"
              stroke="#6f4bd8"
              strokeWidth="4"
              strokeLinecap="round"
              fill="none"
            />
          ) : (
            <>
              <ellipse cx="46" cy="63" rx="6" ry="7.5" fill="#6f4bd8" />
              <circle cx="48" cy="60" r="2.2" fill="#fff" />
            </>
          )}
          <ellipse cx="74" cy="63" rx="6" ry="7.5" fill="#6f4bd8" />
          <circle cx="76" cy="60" r="2.2" fill="#fff" />
        </g>
        <ellipse cx="36" cy="75" rx="5.5" ry="3.5" fill="#ff9fc0" opacity="0.8" />
        <ellipse cx="84" cy="75" rx="5.5" ry="3.5" fill="#ff9fc0" opacity="0.8" />
        {mood === 'think' ? (
          <path
            d="M53 79 q7 -3 14 0"
            stroke="#6f4bd8"
            strokeWidth="3.5"
            strokeLinecap="round"
            fill="none"
          />
        ) : (
          <path
            d="M51 76 q9 10 18 0"
            stroke="#6f4bd8"
            strokeWidth="3.5"
            strokeLinecap="round"
            fill={mood === 'happy' || mood === 'wave' ? '#ff7aa8' : 'none'}
          />
        )}
      </g>
      {/* sparkle (the logo's star) */}
      <g className="ofl-m-sparkle">
        <path
          d="M100 6 C102 18 106 22 118 24 C106 26 102 30 100 42 C98 30 94 26 82 24 C94 22 98 18 100 6 Z"
          fill="#ffffff"
          stroke="#25d07a"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </g>
      <g className="ofl-m-sparkle-small">
        <path
          d="M84 2 C85 6 86 7 90 8 C86 9 85 10 84 14 C83 10 82 9 78 8 C82 7 83 6 84 2 Z"
          fill="#ffffff"
          stroke="#8be32f"
          strokeWidth="1.5"
        />
      </g>
    </svg>
  );
}

// ---- Tour state ------------------------------------------------------------

class OfflineTourStore {
  active = false;
  step = 0;
  prompt = false;
  prefs: TourPrefs | null = null;
  private _promptChecked = false;
  private _listeners = new Set<Listener>();

  listen(cb: Listener) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  emit() {
    for (const cb of Array.from(this._listeners)) {
      try {
        cb();
      } catch (e) {
        console.error('[Offline tour] listener failed', e);
      }
    }
  }

  get steps() {
    return TOUR_STEPS;
  }

  loadPrefs(): TourPrefs {
    if (!this.prefs) this.prefs = readTourPrefs(offlineMailStore.configDir);
    return this.prefs;
  }

  private _save(p: Partial<TourPrefs>) {
    this.prefs = { ...this.loadPrefs(), ...p };
    writeTourPrefs(offlineMailStore.configDir, this.prefs);
  }

  /** Once the mail is loaded: offer the tour if never done / never declined. */
  maybeOffer() {
    if (this._promptChecked || offlineMailStore.status !== 'ready' || !offlineMailStore.configDir)
      return;
    this._promptChecked = true;
    if (shouldOfferTour(this.loadPrefs())) {
      this.prompt = true;
      this.emit();
    }
  }

  start(at = 0) {
    this.prompt = false;
    this.active = true;
    this.step = Math.max(0, Math.min(TOUR_STEPS.length - 1, at));
    this._prepare();
    this.emit();
  }

  next() {
    if (this.step >= TOUR_STEPS.length - 1) return this.finish();
    this.step++;
    this._prepare();
    this.emit();
  }

  back() {
    if (this.step <= 0) return;
    this.step--;
    this._prepare();
    this.emit();
  }

  /** Skip or finish: the invitation is not shown again. */
  finish() {
    this.active = false;
    this._save({ done: true });
    this.emit();
  }

  later() {
    this.prompt = false;
    this.emit();
  }

  never() {
    this.prompt = false;
    this._save({ promptNever: true });
    this.emit();
  }

  get tipsOn(): boolean {
    return this.loadPrefs().tips;
  }

  setTips(on: boolean) {
    this._save({ tips: !!on });
    this.emit();
  }

  private _prepare() {
    const s = TOUR_STEPS[this.step];
    if (s && s.tab) showRibbonTab(s.tab);
  }
}

export const offlineTour = new OfflineTourStore();

export function startOfflineTour() {
  offlineTour.start(0);
}

// ---- Overlay ---------------------------------------------------------------

function visibleRect(selectors: string[]): DOMRect | null {
  for (const sel of selectors) {
    const all = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    for (const el of all) {
      if (el.closest('[data-offline-tour]')) continue;
      const r = el.getBoundingClientRect();
      if (
        r.width > 4 &&
        r.height > 4 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < window.innerHeight &&
        r.left < window.innerWidth
      ) {
        return r;
      }
    }
  }
  return null;
}

type HostState = { tick: number; rect: DOMRect | null; bubbleH: number };

export class OfflineTourHost extends React.Component<Record<string, never>, HostState> {
  static displayName = 'OfflineTourHost';
  state: HostState = { tick: 0, rect: null, bubbleH: 220 };
  private _unsubs: (() => void)[] = [];
  private _bubble = React.createRef<HTMLDivElement>();
  private _timer: number | null = null;
  private _next = React.createRef<HTMLButtonElement>();

  componentDidMount() {
    const update = () => {
      this.setState({ tick: this.state.tick + 1 });
      this._measureSoon();
    };
    this._unsubs.push(offlineTour.listen(update));
    this._unsubs.push(
      offlineMailStore.listen(() => {
        offlineTour.maybeOffer();
      })
    );
    offlineTour.maybeOffer();
    const onResize = () => this._measure();
    window.addEventListener('resize', onResize);
    this._unsubs.push(() => window.removeEventListener('resize', onResize));
    const onKey = (e: KeyboardEvent) => {
      if (!offlineTour.active) return;
      const rtl = offlineDir() === 'rtl';
      if (e.key === 'Escape') offlineTour.finish();
      else if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) offlineTour.next();
      else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) offlineTour.back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    this._unsubs.push(() => window.removeEventListener('keydown', onKey, true));
  }

  componentWillUnmount() {
    this._unsubs.forEach((u) => u());
    if (this._timer) window.clearTimeout(this._timer);
  }

  componentDidUpdate() {
    const b = this._bubble.current;
    if (b && Math.abs(b.offsetHeight - this.state.bubbleH) > 2) {
      this.setState({ bubbleH: b.offsetHeight });
    }
  }

  _measureSoon() {
    if (this._timer) window.clearTimeout(this._timer);
    // The ribbon tab / panel may change first.
    this._timer = window.setTimeout(() => {
      this._measure();
      if (this._next.current && offlineTour.active) this._next.current.focus();
    }, 160);
  }

  _measure() {
    if (!offlineTour.active) return;
    const s = TOUR_STEPS[offlineTour.step];
    this.setState({ rect: s ? visibleRect(s.targets) : null });
  }

  _renderPrompt() {
    return (
      <div
        className="offline-tour-prompt"
        dir={offlineDir()}
        role="dialog"
        data-offline-tour="prompt"
        aria-label={L(MASCOT_NAME)}
      >
        <OfflineMascot size={64} mood="wave" />
        <div className="offline-tour-prompt-text">
          <div className="offline-tour-title">{tr('היי! אני מיילי ✨', "Hi! I'm Maily ✨")}</div>
          <div>
            {tr(
              'רוצים סיור קצר באפליקציה? דקה אחת, אפשר לדלג בכל רגע.',
              'Want a quick tour of the app? One minute, skip any time.'
            )}
          </div>
          <div className="offline-tour-buttons">
            <button
              type="button"
              className="btn btn-emphasis"
              data-offline-tour-start="true"
              onClick={() => offlineTour.start(0)}
            >
              {tr('🚀 בואו נתחיל', "🚀 Let's go")}
            </button>
            <button
              type="button"
              className="btn"
              data-offline-tour-later="true"
              onClick={() => offlineTour.later()}
            >
              {tr('לא עכשיו', 'Not now')}
            </button>
            <button
              type="button"
              className="btn btn-link"
              data-offline-tour-never="true"
              onClick={() => offlineTour.never()}
            >
              {tr('אל תציג שוב', "Don't show again")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  _renderTour() {
    const i = offlineTour.step;
    const s = TOUR_STEPS[i];
    const rect = this.state.rect && s.targets.length ? this.state.rect : null;
    const pad = 6;
    const view = { width: window.innerWidth, height: window.innerHeight };
    const width = Math.min(360, view.width - 20);
    const hole = rect
      ? {
          left: Math.max(2, rect.left - pad),
          top: Math.max(2, rect.top - pad),
          width: Math.min(view.width - 4, rect.width + pad * 2),
          height: Math.min(view.height - 4, rect.height + pad * 2),
        }
      : null;
    const place = placeBubble(hole, { width, height: this.state.bubbleH }, view);
    const last = i === TOUR_STEPS.length - 1;
    return (
      <div
        className="offline-tour"
        dir={offlineDir()}
        data-offline-tour="active"
        data-offline-tour-step={s.id}
      >
        <div className="offline-tour-blocker" onMouseDown={(e) => e.preventDefault()} />
        {hole ? (
          <div
            className="offline-tour-spot"
            data-offline-tour-spot="true"
            style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height }}
          />
        ) : (
          <div className="offline-tour-dim" />
        )}
        <div
          ref={this._bubble}
          className={`offline-tour-bubble side-${place.side}`}
          role="dialog"
          aria-live="polite"
          aria-label={L(s.title)}
          data-offline-tour-bubble={s.id}
          style={{ left: place.left, top: place.top, width }}
        >
          <div className="offline-tour-head">
            <OfflineMascot size={58} mood={s.mood || (i % 3 === 2 ? 'wink' : 'happy')} />
            <div className="offline-tour-title" dir="auto">
              {L(s.title)}
            </div>
          </div>
          <div className="offline-tour-body" dir="auto">
            {L(s.body)}
          </div>
          {!rect && s.targets.length && s.missing ? (
            <div className="offline-tour-missing">{L(s.missing)}</div>
          ) : null}
          <div className="offline-tour-dots" aria-hidden="true">
            {TOUR_STEPS.map((x, k) => (
              <span key={x.id} className={k === i ? 'on' : k < i ? 'past' : ''} />
            ))}
          </div>
          <div className="offline-tour-buttons">
            <span className="offline-tour-count">{`${i + 1} / ${TOUR_STEPS.length}`}</span>
            <button
              type="button"
              className="btn btn-link"
              data-offline-tour-skip="true"
              onClick={() => offlineTour.finish()}
            >
              {last ? tr('סגור', 'Close') : tr('דלג', 'Skip')}
            </button>
            {i > 0 ? (
              <button
                type="button"
                className="btn"
                data-offline-tour-back="true"
                onClick={() => offlineTour.back()}
              >
                {tr('הקודם', 'Back')}
              </button>
            ) : null}
            <button
              ref={this._next}
              type="button"
              className="btn btn-emphasis"
              data-offline-tour-next="true"
              onClick={() => offlineTour.next()}
            >
              {last ? tr('סיום 🎉', 'Done 🎉') : tr('הבא', 'Next')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    if (offlineTour.active) return this._renderTour();
    if (offlineTour.prompt) return this._renderPrompt();
    return null;
  }
}

// ---- "?" tips --------------------------------------------------------------

type TipState = { open: boolean; tick: number };

/** A small "?" that shows Maily with a short tip (no network, nothing sent). */
export class OfflineHelpTip extends React.Component<
  { tip: keyof typeof TOUR_TIPS | string },
  TipState
> {
  static displayName = 'OfflineHelpTip';
  state: TipState = { open: false, tick: 0 };
  private _un: (() => void) | null = null;
  private _root = React.createRef<HTMLSpanElement>();

  componentDidMount() {
    this._un = offlineTour.listen(() => this.setState({ tick: this.state.tick + 1 }));
    document.addEventListener('mousedown', this._outside, true);
  }

  componentWillUnmount() {
    if (this._un) this._un();
    document.removeEventListener('mousedown', this._outside, true);
  }

  _outside = (e: MouseEvent) => {
    if (this.state.open && this._root.current && !this._root.current.contains(e.target as Node)) {
      this.setState({ open: false });
    }
  };

  render() {
    const text = TOUR_TIPS[this.props.tip];
    if (!text || !offlineTour.tipsOn) return null;
    return (
      <span className="offline-tip" ref={this._root} data-offline-tip={this.props.tip}>
        <button
          type="button"
          className="offline-tip-btn"
          aria-label={tr('טיפ', 'Tip')}
          title={tr('טיפ', 'Tip')}
          aria-expanded={this.state.open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => this.setState({ open: !this.state.open })}
        >
          ?
        </button>
        {this.state.open ? (
          <span
            className="offline-tip-pop"
            role="tooltip"
            dir={offlineDir()}
            data-offline-tip-open={this.props.tip}
          >
            <OfflineMascot size={40} mood="wink" animate={false} />
            <span className="offline-tip-text" dir="auto">
              {L(text)}
            </span>
          </span>
        ) : null}
      </span>
    );
  }
}
