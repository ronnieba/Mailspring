/**
 * Demo sidebar readiness for --demo-capture.
 *
 * PackageManager defers packages without syncInit by 800ms, then require()
 * compiles them. waitForLoad + a fixed 2s screenshot can fire while only
 * syncInit panels (Calendar) are registered — native d979449 Mac capture
 * showed Calendar/Participants, no AI tab. Poll the live DOM instead.
 */

export const DEMO_SIDEBAR_READY_ATTR = 'data-demo-ready';
export const DEMO_CAPTURE_QUERY = 'חפש חשבוניות';

export type DemoSidebarSnapshot = {
  readyAttr: boolean;
  hasRoot: boolean;
  hasDemoBanner: boolean;
  hasMockWarning: boolean;
  scopeCount: number;
  citationCount: number;
  conversationCount: number;
  tabs: string[];
  reason?: string;
};

export const DEMO_SIDEBAR_SNAPSHOT_JS = `(() => {
  const el = document.querySelector('.ai-sidebar');
  const tabs = Array.from(document.querySelectorAll('.sidebar-panel-tab')).map(
    (t) => (t.textContent || '').trim()
  );
  if (!el) {
    return {
      readyAttr: false,
      hasRoot: false,
      hasDemoBanner: false,
      hasMockWarning: false,
      scopeCount: 0,
      citationCount: 0,
      conversationCount: 0,
      tabs,
      reason: 'missing .ai-sidebar',
    };
  }
  const text = el.innerText || '';
  return {
    readyAttr: el.getAttribute('data-demo-ready') === 'true',
    hasRoot: true,
    hasDemoBanner: text.indexOf('DEMO') !== -1 || text.indexOf('מצב DEMO') !== -1,
    hasMockWarning: !!el.querySelector('.ai-sidebar-mock-warning'),
    scopeCount: el.querySelectorAll('.scope-btn').length,
    citationCount: el.querySelectorAll('.citation-btn').length,
    conversationCount: el.querySelectorAll('.ai-sidebar-messages .message').length,
    tabs,
  };
})()`;

export const DEMO_SIDEBAR_REVEAL_CITATIONS_JS = `(() => {
  const btn = document.querySelector('.ai-sidebar .citation-btn');
  if (btn && typeof btn.scrollIntoView === 'function') {
    btn.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  return !!btn;
})()`;

export const DEMO_SIDEBAR_RUN_QUERY_JS = `(async () => {
  const api = window.__mailspringDemoSidebar;
  if (!api || typeof api.setScopeMode !== 'function' || typeof api.submitQuery !== 'function') {
    return { ok: false, reason: 'missing window.__mailspringDemoSidebar' };
  }
  await api.setScopeMode('all-mail');
  await api.submitQuery(${JSON.stringify(DEMO_CAPTURE_QUERY)});
  return { ok: true };
})()`;

export function evaluateDemoSidebarReady(snap: DemoSidebarSnapshot | null): {
  ready: boolean;
  reason: string;
} {
  if (!snap) {
    return { ready: false, reason: 'no snapshot' };
  }
  if (!snap.hasRoot) {
    return { ready: false, reason: snap.reason || 'missing .ai-sidebar' };
  }
  if (!snap.readyAttr) {
    return { ready: false, reason: 'data-demo-ready is not true' };
  }
  if (!snap.hasDemoBanner || !snap.hasMockWarning) {
    return { ready: false, reason: 'missing DEMO/MOCK banner' };
  }
  if (snap.scopeCount < 3) {
    return { ready: false, reason: `expected 3 scope buttons, got ${snap.scopeCount}` };
  }
  return { ready: true, reason: 'ok' };
}

export function evaluateDemoQueryComplete(snap: DemoSidebarSnapshot | null): {
  complete: boolean;
  reason: string;
} {
  if (!snap || !snap.hasRoot) {
    return { complete: false, reason: 'sidebar not mounted' };
  }
  if (snap.citationCount < 1) {
    return { complete: false, reason: `no fixture citations (count=${snap.citationCount})` };
  }
  if (snap.conversationCount < 1) {
    return { complete: false, reason: 'no conversation messages' };
  }
  return { complete: true, reason: 'ok' };
}
