/**
 * Offline experiment (t233): Outlook-style rules, LOCAL only.
 *
 * A rule = conditions (from / to-cc / subject contain, has attachments, in
 * folder) + one action (move to folder, star, mark unread, delete to the
 * local Trash, block the sender). Rules live in the local-changes file of the
 * offline profile and only change how this app shows mail - the mail copy
 * and Yahoo never change. Every run is recorded so it can be undone.
 * Pure helpers here (no fs, no network).
 */
import type { LocalPlace, OverlayData, OverlayMessage } from './offline-local-overlay';

export type LocalRuleWhen = {
  /** Sender contains (any of the ';' / ',' separated values). */
  from?: string;
  /** To or Cc contains (any of the values). */
  to?: string;
  /** Subject contains (any of the values). */
  subject?: string;
  hasAttachment?: boolean;
  /** In this folder (or its subfolders), where the message shows now. */
  folder?: string;
};

export type LocalRuleActionKind = 'move' | 'star' | 'unread' | 'trash' | 'block';
export const RULE_ACTIONS: LocalRuleActionKind[] = ['move', 'star', 'unread', 'trash', 'block'];

export type LocalRuleThen = { kind: LocalRuleActionKind; folder?: string };

export type LocalRule = {
  id: string;
  name: string;
  enabled: boolean;
  when: LocalRuleWhen;
  then: LocalRuleThen;
  createdAt: number;
  /** Last time the rule ran: "new mail" runs only look at mail after it. */
  lastRunAt: number;
  /** Messages it changed so far (for the list). */
  applied: number;
};

export type RuleRunChange = { id: string; before: OverlayMessage | null };
export type RuleRun = {
  id: string;
  at: number;
  trigger: 'manual' | 'new-mail';
  ruleIds: string[];
  changes: RuleRunChange[];
  /** Sender addresses this run blocked. */
  blocked: string[];
};

export const MAX_RULES = 200;
export const MAX_RULE_RUNS = 5;
const MAX_TEXT = 300;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, MAX_TEXT);
  return s || undefined;
}

export function sanitizeRule(r: any): LocalRule | null {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) {
    return null;
  }
  const w = r.when && typeof r.when === 'object' ? r.when : {};
  const when: LocalRuleWhen = {};
  for (const k of ['from', 'to', 'subject'] as const) {
    const v = text(w[k]);
    if (v) when[k] = v;
  }
  if (w.hasAttachment === true) when.hasAttachment = true;
  const folder = typeof w.folder === 'string' && w.folder && w.folder.length < 1000 ? w.folder : '';
  if (folder) when.folder = folder;
  if (!ruleHasCondition(when)) {
    return null;
  }
  const t = r.then && typeof r.then === 'object' ? r.then : {};
  if (!RULE_ACTIONS.includes(t.kind)) {
    return null;
  }
  const then: LocalRuleThen = { kind: t.kind };
  if (t.kind === 'move') {
    if (typeof t.folder !== 'string' || !t.folder || t.folder.length >= 1000) return null;
    then.folder = t.folder;
  }
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
  return {
    id: r.id,
    name: (typeof r.name === 'string' ? r.name : '').trim().slice(0, 120),
    enabled: r.enabled !== false,
    when,
    then,
    createdAt: num(r.createdAt),
    lastRunAt: num(r.lastRunAt),
    applied: Math.floor(num(r.applied)),
  };
}

export function sanitizeRules(raw: unknown): LocalRule[] {
  const out: LocalRule[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw) ? raw : []) {
    const c = sanitizeRule(r);
    if (c && !seen.has(c.id) && out.length < MAX_RULES) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export function sanitizeRuleRuns(
  raw: unknown,
  cleanMessage: (m: any) => OverlayMessage | null
): RuleRun[] {
  const out: RuleRun[] = [];
  for (const r of Array.isArray(raw) ? raw.slice(-MAX_RULE_RUNS) : []) {
    if (!r || typeof r.id !== 'string' || !ID_RE.test(r.id)) continue;
    const changes: RuleRunChange[] = [];
    for (const c of Array.isArray(r.changes) ? r.changes : []) {
      if (c && typeof c.id === 'string' && ID_RE.test(c.id)) {
        changes.push({ id: c.id, before: c.before ? cleanMessage(c.before) : null });
      }
    }
    out.push({
      id: r.id,
      at: typeof r.at === 'number' && isFinite(r.at) ? r.at : 0,
      trigger: r.trigger === 'new-mail' ? 'new-mail' : 'manual',
      ruleIds: (Array.isArray(r.ruleIds) ? r.ruleIds : []).filter(
        (x: unknown) => typeof x === 'string' && ID_RE.test(x)
      ),
      changes,
      blocked: (Array.isArray(r.blocked) ? r.blocked : [])
        .filter((x: unknown) => typeof x === 'string' && x.length < 320)
        .map((x: string) => x.toLowerCase()),
    });
  }
  return out;
}

export function ruleHasCondition(w: LocalRuleWhen): boolean {
  return !!(w.from || w.to || w.subject || w.hasAttachment || w.folder);
}

/** Lower-case, no niqqud / accents, Hebrew final letters folded. */
export function normRuleText(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '')
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => (({ ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }) as any)[c])
    .replace(/\s+/g, ' ');
}

function terms(v: string): string[] {
  return v
    .split(/[;,]/)
    .map((x) => normRuleText(x).trim())
    .filter(Boolean);
}

function containsAny(hay: string, v: string | undefined): boolean {
  if (!v) return true;
  const h = normRuleText(hay);
  return terms(v).some((t) => h.includes(t));
}

/** What a rule looks at. `folder` = where the message shows now. */
export type RuleTarget = {
  id: string;
  folder: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  hasAttachments: boolean;
  attachCount?: number;
  ts: number;
  mtimeMs: number;
};

export function ruleMatches(rule: LocalRule, t: RuleTarget): boolean {
  const w = rule.when;
  if (!ruleHasCondition(w)) return false;
  if (!containsAny(t.from, w.from)) return false;
  if (!containsAny(`${t.to || ''}, ${t.cc || ''}`, w.to)) return false;
  if (!containsAny(t.subject, w.subject)) return false;
  if (w.hasAttachment && !(t.attachCount !== undefined ? t.attachCount > 0 : t.hasAttachments)) {
    return false;
  }
  if (w.folder && !(t.folder === w.folder || t.folder.startsWith(`${w.folder}/`))) return false;
  return true;
}

export type RulePlan = {
  /** Overlay patch per message (in rule order; later rules win on place/folder). */
  patches: Map<string, Partial<OverlayMessage>>;
  /** Senders to block: lower-case address -> display name. */
  block: Map<string, string>;
  /** Messages each rule changed. */
  perRule: { [ruleId: string]: number };
};

/**
 * What enabled rules would change. Messages in the local Trash / Spam are
 * left alone; actions already in effect are not counted.
 * `since(rule)`: only mail newer than this (file time or date) - "new mail" runs.
 */
export function planRules(
  rules: LocalRule[],
  targets: RuleTarget[],
  overlay: Pick<OverlayData, 'messages' | 'blocked'>,
  opts: {
    since?: (rule: LocalRule) => number;
    senderOf: (from: string) => { email: string; name: string };
    placeOf: (folder: string) => LocalPlace | null;
  }
): RulePlan {
  const plan: RulePlan = { patches: new Map(), block: new Map(), perRule: {} };
  const blocked = new Set(overlay.blocked.map((b) => b.email));
  const active = rules.filter((r) => r.enabled);
  for (const r of active) plan.perRule[r.id] = 0;
  for (const t of targets) {
    const place0 = opts.placeOf(t.folder);
    if (place0 === 'trash' || place0 === 'spam') continue;
    const cur: OverlayMessage = { ...(overlay.messages[t.id] || {}) };
    let folder = t.folder;
    let patch: Partial<OverlayMessage> | null = null;
    for (const r of active) {
      const since = opts.since ? opts.since(r) : 0;
      if (since && Math.max(t.mtimeMs || 0, t.ts || 0) <= since) continue;
      if (!ruleMatches(r, { ...t, folder })) continue;
      const k = r.then.kind;
      let changed = false;
      if (k === 'star' && !cur.star) {
        cur.star = true;
        patch = { ...(patch || {}), star: true };
        changed = true;
      } else if (k === 'unread' && !cur.unread) {
        cur.unread = true;
        patch = { ...(patch || {}), unread: true };
        changed = true;
      } else if (k === 'trash' && cur.place !== 'trash') {
        cur.place = 'trash';
        delete cur.folder;
        const p: Partial<OverlayMessage> = { ...(patch || {}), place: 'trash' };
        delete p.folder;
        patch = p;
        changed = true;
      } else if (k === 'move' && r.then.folder && folder !== r.then.folder && !cur.place) {
        cur.folder = r.then.folder;
        folder = r.then.folder;
        const p: Partial<OverlayMessage> = { ...(patch || {}), folder: r.then.folder };
        delete p.place;
        patch = p;
        changed = true;
      } else if (k === 'block') {
        const s = opts.senderOf(t.from);
        if (s.email && !blocked.has(s.email)) {
          blocked.add(s.email);
          plan.block.set(s.email, s.name);
          changed = true;
        }
      }
      if (changed) plan.perRule[r.id]++;
    }
    if (patch) plan.patches.set(t.id, patch);
  }
  return plan;
}

const ACTION_LABELS: { [k in LocalRuleActionKind]: [string, string] } = {
  move: ['העבר לתיקייה', 'Move to folder'],
  star: ['סמן בכוכב', 'Star'],
  unread: ['סמן כלא נקרא', 'Mark as unread'],
  trash: ['מחק (לאשפה המקומית)', 'Delete (to local Trash)'],
  block: ['חסום את השולח', 'Block the sender'],
};

export function ruleActionLabel(kind: LocalRuleActionKind, lang: 'he' | 'en'): string {
  return ACTION_LABELS[kind][lang === 'he' ? 0 : 1];
}

/** "If from contains x and has attachments → Move to folder: y". */
export function describeRule(
  r: Pick<LocalRule, 'when' | 'then'>,
  lang: 'he' | 'en',
  folderName: (p: string) => string = (p) => p
): string {
  const he = lang === 'he';
  const w = r.when;
  const parts: string[] = [];
  if (w.from) parts.push(he ? `השולח מכיל "${w.from}"` : `sender contains "${w.from}"`);
  if (w.to) parts.push(he ? `אל/עותק מכיל "${w.to}"` : `to/cc contains "${w.to}"`);
  if (w.subject) parts.push(he ? `הנושא מכיל "${w.subject}"` : `subject contains "${w.subject}"`);
  if (w.hasAttachment) parts.push(he ? 'יש קבצים מצורפים' : 'has attachments');
  if (w.folder)
    parts.push(he ? `בתיקייה "${folderName(w.folder)}"` : `in folder "${folderName(w.folder)}"`);
  const cond = parts.join(he ? ' וגם ' : ' and ');
  const act =
    ruleActionLabel(r.then.kind, lang) +
    (r.then.kind === 'move' && r.then.folder ? `: "${folderName(r.then.folder)}"` : '');
  return he ? `אם ${cond} ← ${act}` : `If ${cond} → ${act}`;
}

export function newRuleId(now = Date.now()): string {
  return `rule-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
