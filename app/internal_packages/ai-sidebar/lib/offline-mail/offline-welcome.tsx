/**
 * Offline experiment (t243): welcome / summary screen in the reader when no
 * message is open. Counts, top senders, the last 14 days and the newest
 * messages, plus quick actions. Computed locally from the index — no AI,
 * no network.
 */
import React from 'react';
import { offlineMailStore } from './offline-mail-store';
import { offlineDraftsStore } from './offline-drafts-store';
import { offlineSearchStore } from './offline-search-store';
import { offlineDir, offlineLang, tr } from '../core/offline-i18n';
import { WelcomeStats, friendlyDate, parseSender, welcomeStats } from '../core/offline-visual';
import { localPlaceOf } from '../core/offline-local-overlay';
import { OfflineAvatar, OfflineIcon } from './offline-visual-ui';
import { OfflineHelpTip } from './offline-tour';

type Recent = { id: string; from: string; subject: string; ts: number; folder: string };
let cache: { key: string; stats: WelcomeStats; recent: Recent[] } | null = null;

function compute() {
  const s = offlineMailStore;
  const entries = s.index ? s.index.entries : [];
  const day = new Date().toDateString();
  const key = `${s.index ? s.index.builtAt : ''}:${entries.length}:${s.overlayVersion}:${day}`;
  if (cache && cache.key === key) return cache;
  // Mail the user sees: not blocked, not in the local trash / spam.
  const shown = entries.filter((e) => s.searchShows(e.id, false, null));
  const seen = new Set<string>();
  const unique = shown.filter((e) => {
    const k = e.msgId || e.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const stats = welcomeStats(unique, {
    unread: (id) => s.isUnread(id),
    starred: (id) => s.isStarred(id),
  });
  const recent = unique
    .filter((e) => e.ts && !localPlaceOf(e.folder))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map((e) => ({ id: e.id, from: e.from, subject: e.subject, ts: e.ts, folder: e.folder }));
  cache = { key, stats, recent };
  return cache;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return tr('לילה טוב', 'Good night');
  if (h < 12) return tr('בוקר טוב', 'Good morning');
  if (h < 17) return tr('צהריים טובים', 'Good afternoon');
  return tr('ערב טוב', 'Good evening');
}

function openMessage(r: Recent) {
  const s = offlineMailStore;
  if (s.currentFolder !== r.folder) s.setFolder(r.folder);
  s.select(r.id, {});
}

function searchFor(q: string) {
  offlineSearchStore.setQuery(q);
  setTimeout(() => {
    const el = document.querySelector('[data-offline-search-input]') as HTMLInputElement | null;
    if (el) el.focus();
  }, 50);
}

export function OfflineWelcome() {
  const s = offlineMailStore;
  if (s.status !== 'ready' || !s.index) {
    return (
      <div className="offline-reader-placeholder">
        {tr(
          'בחר הודעה כדי לקרוא אותה (עותק מקומי, קריאה בלבד).',
          'Select a message to read it (local copy, read-only).'
        )}
      </div>
    );
  }
  const { stats, recent } = compute();
  const lang = offlineLang();
  const max = Math.max(1, ...stats.perDay.map((d) => d.count));
  const card = (id: string, icon: string, n: number, label: string, onClick?: () => void) => (
    <button
      type="button"
      key={id}
      className="offline-welcome-card"
      data-offline-welcome-card={id}
      data-count={n}
      disabled={!onClick}
      onClick={onClick}
    >
      <span className="offline-welcome-card-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="offline-welcome-card-n">{n.toLocaleString()}</span>
      <span className="offline-welcome-card-label">{label}</span>
    </button>
  );
  const quick = (id: string, icon: string, label: string, onClick: () => void) => (
    <button
      type="button"
      key={id}
      className="offline-welcome-quick"
      data-offline-welcome-quick={id}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span> {label}
    </button>
  );
  return (
    <div className="offline-welcome" dir={offlineDir()} data-offline-welcome="true">
      <div className="offline-welcome-head">
        <div className="offline-welcome-title">
          {greeting()} 👋 <OfflineHelpTip tip="welcome" />
        </div>
        <div className="offline-welcome-sub">
          {tr(
            'סיכום הדואר המקומי. בחר הודעה כדי לקרוא אותה (עותק מקומי, קריאה בלבד).',
            'Your local mail at a glance. Select a message to read it (local copy, read-only).'
          )}
        </div>
      </div>
      <div className="offline-welcome-cards">
        {card('total', '📬', stats.total, tr('הודעות', 'Messages'))}
        {card(
          'unread',
          '✉️',
          stats.unread,
          tr('לא נקראו', 'Unread'),
          stats.unread ? () => s.setUnreadOnly(true) : undefined
        )}
        {card(
          'starred',
          '⭐',
          stats.starred,
          tr('בכוכב', 'Starred'),
          stats.starred ? () => s.setStarredOnly(true) : undefined
        )}
        {card(
          'attach',
          '📎',
          stats.withAttachments,
          tr('עם צרופות', 'With attachments'),
          stats.withAttachments ? () => s.setAttachmentsOnly(true) : undefined
        )}
        {card('week', '📅', stats.last7, tr('ב-7 הימים האחרונים', 'In the last 7 days'))}
      </div>
      <div className="offline-welcome-grid">
        <section className="offline-welcome-box" data-offline-welcome-box="activity">
          <h3>{tr('פעילות — 14 הימים האחרונים', 'Activity — last 14 days')}</h3>
          <div
            className="offline-welcome-bars"
            role="img"
            aria-label={tr('הודעות ליום', 'Messages per day')}
          >
            {stats.perDay.map((d) => (
              <span
                key={d.day}
                className="offline-welcome-bar"
                data-count={d.count}
                title={`${friendlyDate(d.day + 12 * 3600000, Date.now(), lang).replace(/ \d\d:\d\d$/, '')}: ${d.count}`}
              >
                <span style={{ height: `${Math.round((d.count / max) * 100)}%` }} />
              </span>
            ))}
          </div>
        </section>
        <section className="offline-welcome-box" data-offline-welcome-box="senders">
          <h3>{tr('שולחים מובילים (שנה אחרונה)', 'Top senders (last year)')}</h3>
          {stats.topSenders.length ? (
            stats.topSenders.map((p) => (
              <button
                type="button"
                key={p.email || p.name}
                className="offline-welcome-person"
                data-offline-welcome-sender="true"
                title={tr('חפש הודעות מהשולח', 'Search messages from this sender')}
                onClick={() => searchFor(`from:${p.email || p.name}`)}
              >
                <OfflineAvatar from={p.email ? `${p.name} <${p.email}>` : p.name} size={26} />
                <bdi className="offline-welcome-person-name">{p.name || p.email}</bdi>
                <span className="offline-welcome-person-n">{p.count.toLocaleString()}</span>
              </button>
            ))
          ) : (
            <div className="offline-welcome-empty">{tr('אין עדיין', 'None yet')}</div>
          )}
        </section>
        <section className="offline-welcome-box wide" data-offline-welcome-box="recent">
          <h3>{tr('הגיעו לאחרונה', 'Recently arrived')}</h3>
          {recent.map((r) => (
            <button
              type="button"
              key={r.id}
              className="offline-welcome-recent"
              data-offline-welcome-recent="true"
              onClick={() => openMessage(r)}
            >
              <OfflineAvatar from={r.from} size={26} />
              <bdi className="offline-welcome-recent-from">
                {parseSender(r.from).name || parseSender(r.from).email}
              </bdi>
              <bdi className="offline-welcome-recent-subject">
                {r.subject || tr('(ללא נושא)', '(no subject)')}
              </bdi>
              <span className="offline-welcome-recent-date">
                {friendlyDate(r.ts, Date.now(), lang)}
              </span>
            </button>
          ))}
        </section>
      </div>
      <div className="offline-welcome-quicks" data-offline-welcome-quicks="true">
        {quick('search', '🔍', tr('חיפוש', 'Search'), () => searchFor(''))}
        {quick('new', '✉️', tr('טיוטה חדשה', 'New draft'), () => offlineDraftsStore.createNew())}
        {quick('talk', '🎙️', tr('דבר עם Gemini', 'Talk to Gemini'), () =>
          // Late require: the voice module imports the ribbon helpers.
          require('./offline-voice').offlineVoice.toggle('command')
        )}
        {quick('tags', '🏷️', tr('תגיות', 'Tags'), () =>
          require('./offline-message-actions').openTagManager()
        )}
        {quick('tour', '❓', tr('סיור מודרך', 'Guided tour'), () =>
          require('./offline-tour').startOfflineTour()
        )}
      </div>
      <div className="offline-welcome-foot">
        <OfflineIcon name="tag" size={12} />{' '}
        {tr(
          'הכל מחושב במחשב הזה — שום דבר לא נשלח.',
          'All computed on this computer — nothing is sent.'
        )}
      </div>
    </div>
  );
}
