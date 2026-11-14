/**
 * Offline experiment (t233): the "Rules" window (Outlook-like), LOCAL only.
 * Make / edit / turn off / reorder / delete rules, run them now on existing
 * mail, undo the last run. Rules also act on new mail when the app indexes.
 * Nothing is written to the mail copy and nothing goes to Yahoo.
 */
import React from 'react';
import { tr, offlineDir, offlineLang } from '../core/offline-i18n';
import { offlineMailStore } from './offline-mail-store';
import { offlineSearchStore } from './offline-search-store';
import { offlineActionsUi } from './offline-message-actions';
import { localPlaceOf, senderEmail } from '../core/offline-local-overlay';
import {
  describeRule,
  LocalRule,
  LocalRuleActionKind,
  RULE_ACTIONS,
  ruleActionLabel,
} from '../core/offline-rules';

type Listener = () => void;

export type RuleForm = {
  id?: string;
  name: string;
  from: string;
  to: string;
  subject: string;
  hasAttachment: boolean;
  folder: string;
  kind: LocalRuleActionKind;
  target: string;
  runNow: boolean;
  error?: string;
};

function blankForm(): RuleForm {
  return {
    name: '',
    from: '',
    to: '',
    subject: '',
    hasAttachment: false,
    folder: '',
    kind: 'move',
    target: '',
    runNow: true,
  };
}

class OfflineRulesUi {
  open = false;
  form: RuleForm | null = null;
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
        console.error('[Offline rules] listener failed', e);
      }
    }
  }
}

export const offlineRulesUi = new OfflineRulesUi();

function refreshSearch() {
  if (offlineSearchStore.active) {
    offlineSearchStore.run();
  }
}

export function openRules() {
  offlineRulesUi.open = true;
  offlineRulesUi.form = null;
  offlineRulesUi.emit();
}

export function closeRules() {
  offlineRulesUi.open = false;
  offlineRulesUi.form = null;
  offlineRulesUi.emit();
}

/** "New rule from this message": sender filled in (Outlook "Create rule"). */
export function newRuleFromMessage(id?: string) {
  const s = offlineMailStore;
  const msgId = id || s.actionIds()[0];
  const e = msgId ? s.getEntry(msgId) : null;
  const form = blankForm();
  if (e) {
    form.from = senderEmail(e.from) || '';
  }
  offlineRulesUi.open = true;
  offlineRulesUi.form = form;
  offlineRulesUi.emit();
}

export function editRule(r: LocalRule) {
  offlineRulesUi.open = true;
  offlineRulesUi.form = {
    id: r.id,
    name: r.name,
    from: r.when.from || '',
    to: r.when.to || '',
    subject: r.when.subject || '',
    hasAttachment: !!r.when.hasAttachment,
    folder: r.when.folder || '',
    kind: r.then.kind,
    target: r.then.folder || '',
    runNow: false,
  };
  offlineRulesUi.emit();
}

function count(n: number): string {
  return n === 1 ? tr('הודעה אחת', '1 message') : tr(`${n} הודעות`, `${n} messages`);
}

function runSummary(changed: number, blocked: number): string {
  const parts = [tr(`שונו ${count(changed)}`, `${count(changed)} changed`)];
  if (blocked) parts.push(tr(`נחסמו ${blocked} שולחים`, `${blocked} senders blocked`));
  return parts.join(' · ');
}

/** Run rules now (all enabled, or one) on the mail already here. */
export function actRunRules(ids: string[] | null) {
  const res = offlineMailStore.runRules(ids, 'manual');
  refreshSearch();
  offlineActionsUi.showToast(
    res.run
      ? tr(
          `📋 הכללים הופעלו: ${runSummary(res.changed, res.blocked)}`,
          `📋 Rules ran: ${runSummary(res.changed, res.blocked)}`
        )
      : tr('📋 הכללים הופעלו: אין מה לשנות', '📋 Rules ran: nothing to change'),
    res.run ? () => void offlineMailStore.undoLastRuleRun() : null
  );
  return res;
}

export function actUndoLastRuleRun() {
  const n = offlineMailStore.undoLastRuleRun();
  refreshSearch();
  offlineActionsUi.showToast(
    n
      ? tr(`ההפעלה האחרונה של הכללים בוטלה (${n})`, `The last rules run was undone (${n})`)
      : tr('אין הפעלה לבטל', 'Nothing to undo'),
    null
  );
}

/** Save the open form. Returns the saved rule or null (form.error says why). */
export function saveRuleForm(): LocalRule | null {
  const f = offlineRulesUi.form;
  if (!f) return null;
  const when = {
    from: f.from.trim() || undefined,
    to: f.to.trim() || undefined,
    subject: f.subject.trim() || undefined,
    hasAttachment: f.hasAttachment || undefined,
    folder: f.folder || undefined,
  };
  if (!when.from && !when.to && !when.subject && !when.hasAttachment && !when.folder) {
    offlineRulesUi.form = {
      ...f,
      error: tr('בחרו לפחות תנאי אחד.', 'Choose at least one condition.'),
    };
    offlineRulesUi.emit();
    return null;
  }
  if (f.kind === 'move' && !f.target) {
    offlineRulesUi.form = {
      ...f,
      error: tr('בחרו לאיזו תיקייה להעביר.', 'Choose the folder to move to.'),
    };
    offlineRulesUi.emit();
    return null;
  }
  const rule = offlineMailStore.saveRule({
    id: f.id,
    name: f.name.trim(),
    when,
    then: { kind: f.kind, folder: f.kind === 'move' ? f.target : undefined },
  });
  if (!rule) {
    offlineRulesUi.form = { ...f, error: tr('לא ניתן לשמור את הכלל.', 'Could not save the rule.') };
    offlineRulesUi.emit();
    return null;
  }
  offlineRulesUi.form = null;
  offlineRulesUi.emit();
  if (f.runNow) {
    actRunRules([rule.id]);
  } else {
    offlineActionsUi.showToast(tr('📋 הכלל נשמר', '📋 Rule saved'), null);
  }
  return rule;
}

function folderOptions(): { path: string; label: string }[] {
  return offlineMailStore
    .allFolderNodes()
    .filter((n) => !localPlaceOf(n.path))
    .map((n) => ({ path: n.path, label: `${'\u00a0\u00a0'.repeat(n.depth)}${n.name}` }));
}

function folderName(p: string): string {
  const n = offlineMailStore.allFolderNodes().find((x) => x.path === p);
  return n ? n.displayPath : p;
}

type State = { tick: number };

export class OfflineRulesDialog extends React.Component<Record<string, never>, State> {
  static displayName = 'OfflineRulesDialog';
  state: State = { tick: 0 };
  private _unsubs: (() => void)[] = [];

  componentDidMount() {
    const update = () => this.setState({ tick: this.state.tick + 1 });
    this._unsubs.push(offlineRulesUi.listen(update));
    this._unsubs.push(offlineMailStore.listen(update));
    this._showPendingNotice();
    this._unsubs.push(offlineMailStore.listen(() => this._showPendingNotice()));
  }

  componentWillUnmount() {
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
  }

  /** Rules that acted on new mail while indexing: one toast with Undo. */
  _showPendingNotice() {
    const n = offlineMailStore.pendingRuleNotice;
    if (!n || offlineMailStore.status !== 'ready') return;
    offlineMailStore.pendingRuleNotice = null;
    window.setTimeout(() => {
      refreshSearch();
      offlineActionsUi.showToast(
        tr(
          `📋 כללים על דואר חדש: ${runSummary(n.changed, n.blocked)}`,
          `📋 Rules on new mail: ${runSummary(n.changed, n.blocked)}`
        ),
        () => void offlineMailStore.undoLastRuleRun()
      );
    }, 0);
  }

  _set(patch: Partial<RuleForm>) {
    const f = offlineRulesUi.form;
    if (!f) return;
    offlineRulesUi.form = { ...f, ...patch, error: undefined };
    offlineRulesUi.emit();
  }

  _renderForm(f: RuleForm) {
    const folders = folderOptions();
    const field = (key: 'from' | 'to' | 'subject', label: string, ph: string) => (
      <label className="offline-rule-field">
        <span>{label}</span>
        <input
          type="text"
          dir="auto"
          data-offline-rule-input={key}
          placeholder={ph}
          value={f[key]}
          onChange={(e) => this._set({ [key]: e.target.value } as Partial<RuleForm>)}
        />
      </label>
    );
    return (
      <div className="offline-rule-form" data-offline-rule-form={f.id || 'new'}>
        <div className="offline-rule-section">{tr('כשהודעה…', 'When a message…')}</div>
        {field(
          'from',
          tr('השולח מכיל', 'Sender contains'),
          tr('כתובת או שם (כמה: מופרדים ב-;)', 'address or name (several: separate with ;)')
        )}
        {field(
          'to',
          tr('אל / עותק מכיל', 'To / Cc contains'),
          tr('כתובת או שם', 'address or name')
        )}
        {field(
          'subject',
          tr('הנושא מכיל', 'Subject contains'),
          tr('מילה או ביטוי', 'word or phrase')
        )}
        <label className="offline-rule-check">
          <input
            type="checkbox"
            data-offline-rule-input="hasAttachment"
            checked={f.hasAttachment}
            onChange={(e) => this._set({ hasAttachment: e.target.checked })}
          />
          {tr('יש קבצים מצורפים', 'Has attachments')}
        </label>
        <label className="offline-rule-field">
          <span>{tr('בתיקייה', 'In folder')}</span>
          <select
            data-offline-rule-input="folder"
            value={f.folder}
            onChange={(e) => this._set({ folder: e.target.value })}
          >
            <option value="">{tr('כל תיקייה', 'Any folder')}</option>
            {folders.map((o) => (
              <option key={o.path} value={o.path}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="offline-rule-section">{tr('אז…', 'Then…')}</div>
        <div className="offline-rule-actions" role="radiogroup">
          {RULE_ACTIONS.map((k) => (
            <label key={k} className="offline-rule-check">
              <input
                type="radio"
                name="offline-rule-kind"
                data-offline-rule-kind={k}
                checked={f.kind === k}
                onChange={() => this._set({ kind: k })}
              />
              {ruleActionLabel(k, offlineLang())}
            </label>
          ))}
        </div>
        {f.kind === 'move' ? (
          <label className="offline-rule-field">
            <span>{tr('לתיקייה', 'To folder')}</span>
            <select
              data-offline-rule-input="target"
              value={f.target}
              onChange={(e) => this._set({ target: e.target.value })}
            >
              <option value="">{tr('בחרו תיקייה…', 'Choose a folder…')}</option>
              {folders.map((o) => (
                <option key={o.path} value={o.path}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="offline-rule-field">
          <span>{tr('שם (לא חובה)', 'Name (optional)')}</span>
          <input
            type="text"
            dir="auto"
            data-offline-rule-input="name"
            value={f.name}
            onChange={(e) => this._set({ name: e.target.value })}
          />
        </label>
        <label className="offline-rule-check">
          <input
            type="checkbox"
            data-offline-rule-input="runNow"
            checked={f.runNow}
            onChange={(e) => this._set({ runNow: e.target.checked })}
          />
          {tr('הפעל עכשיו גם על הדואר שכבר כאן', 'Also run it now on the mail already here')}
        </label>
        {f.error ? (
          <div className="offline-rule-error" role="alert" data-offline-rule-error="true">
            {f.error}
          </div>
        ) : null}
        <div className="offline-modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              offlineRulesUi.form = null;
              offlineRulesUi.emit();
            }}
          >
            {tr('ביטול', 'Cancel')}
          </button>
          <button
            type="button"
            className="btn btn-emphasis"
            data-offline-rule-save="true"
            onClick={() => void saveRuleForm()}
          >
            {tr('שמור כלל', 'Save rule')}
          </button>
        </div>
      </div>
    );
  }

  _renderList() {
    const s = offlineMailStore;
    const rules = s.rules;
    const last = s.lastRuleRun();
    const lang = offlineLang();
    return (
      <>
        {rules.length ? (
          <div className="offline-rule-rows" data-offline-rule-count={rules.length}>
            {rules.map((r, i) => (
              <div
                key={r.id}
                className={`offline-rule-row${r.enabled ? '' : ' is-off'}`}
                data-offline-rule={r.id}
              >
                <input
                  type="checkbox"
                  checked={r.enabled}
                  title={
                    r.enabled
                      ? tr('פעיל — לחצו לכיבוי', 'On — click to turn off')
                      : tr('כבוי — לחצו להפעלה', 'Off — click to turn on')
                  }
                  data-offline-rule-enabled={r.enabled ? 'true' : 'false'}
                  onChange={(e) => s.setRuleEnabled(r.id, e.target.checked)}
                />
                <div className="offline-rule-text">
                  {r.name ? (
                    <div className="offline-rule-name" dir="auto">
                      {r.name}
                    </div>
                  ) : null}
                  <div className="offline-rule-desc" dir="auto">
                    {describeRule(r, lang, folderName)}
                  </div>
                  <div className="offline-rule-meta">
                    {tr(`שינה עד עכשיו: ${r.applied}`, `Changed so far: ${r.applied}`)}
                  </div>
                </div>
                <div className="offline-rule-buttons">
                  <button
                    type="button"
                    className="btn btn-small"
                    title={tr('למעלה', 'Up')}
                    disabled={i === 0}
                    onClick={() => s.moveRule(r.id, -1)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    title={tr('למטה', 'Down')}
                    disabled={i === rules.length - 1}
                    onClick={() => s.moveRule(r.id, 1)}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-offline-rule-run={r.id}
                    onClick={() => actRunRules([r.id])}
                  >
                    {tr('▶ הפעל עכשיו', '▶ Run now')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-offline-rule-edit={r.id}
                    onClick={() => editRule(r)}
                  >
                    {tr('✏️ ערוך', '✏️ Edit')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-offline-rule-delete={r.id}
                    onClick={() => {
                      const undo = s.deleteRule(r.id);
                      offlineActionsUi.showToast(tr('הכלל נמחק', 'Rule deleted'), undo);
                    }}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="offline-move-empty" data-offline-rule-count="0">
            {tr(
              'אין עדיין כללים. כלל עושה משהו אוטומטית בהודעות שמתאימות לו — למשל מעביר לתיקייה כל הודעה משולח מסוים.',
              'No rules yet. A rule does something automatically to matching messages — e.g. moves every message from a sender to a folder.'
            )}
          </div>
        )}
        <div className="offline-rule-toolbar">
          <button
            type="button"
            className="btn btn-emphasis"
            data-offline-rule-new="true"
            onClick={() => {
              offlineRulesUi.form = blankForm();
              offlineRulesUi.emit();
            }}
          >
            {tr('➕ כלל חדש', '➕ New rule')}
          </button>
          <button
            type="button"
            className="btn"
            data-offline-rules-run-all="true"
            disabled={!rules.some((r) => r.enabled)}
            onClick={() => actRunRules(null)}
          >
            {tr('▶ הפעל את כל הכללים עכשיו', '▶ Run all rules now')}
          </button>
          <button
            type="button"
            className="btn"
            data-offline-rules-undo={last ? last.changes.length + last.blocked.length : 0}
            disabled={!last}
            title={tr(
              'מחזיר את ההודעות למצב שלפני ההפעלה האחרונה של הכללים',
              'Puts messages back as they were before the last rules run'
            )}
            onClick={() => actUndoLastRuleRun()}
          >
            {last
              ? tr(
                  `↶ בטל הפעלה אחרונה (${last.changes.length + last.blocked.length})`,
                  `↶ Undo last run (${last.changes.length + last.blocked.length})`
                )
              : tr('↶ בטל הפעלה אחרונה', '↶ Undo last run')}
          </button>
          <button
            type="button"
            className="btn"
            data-offline-rules-delete-all="true"
            disabled={!rules.length}
            onClick={() => {
              if (
                offlineActionsUi.confirm(
                  tr(
                    `למחוק את כל ${rules.length} הכללים?\nמה שהם כבר שינו נשאר (אפשר "בטל הפעלה אחרונה" או "אפס את כל השינויים המקומיים").`,
                    `Delete all ${rules.length} rules?\nWhat they already changed stays ("Undo last run" or "Reset all local changes" put it back).`
                  )
                )
              ) {
                s.deleteAllRules();
              }
            }}
          >
            {tr('מחק את כל הכללים', 'Delete all rules')}
          </button>
        </div>
      </>
    );
  }

  render() {
    if (!offlineRulesUi.open) {
      return null;
    }
    const f = offlineRulesUi.form;
    return (
      <div className="offline-modal-backdrop" onMouseDown={closeRules}>
        <div
          className="offline-modal offline-rules"
          dir={offlineDir()}
          role="dialog"
          aria-label={tr('כללים', 'Rules')}
          data-offline-rules="true"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            if (f) {
              offlineRulesUi.form = null;
              offlineRulesUi.emit();
            } else {
              closeRules();
            }
          }}
        >
          <div className="offline-modal-title">
            {f
              ? f.id
                ? tr('✏️ עריכת כלל', '✏️ Edit rule')
                : tr('➕ כלל חדש', '➕ New rule')
              : tr('📋 כללים', '📋 Rules')}
          </div>
          <div className="offline-modal-note">
            {tr(
              'כללים פועלים רק במחשב הזה: הם משנים איך האפליקציה מציגה את הדואר (העברה, כוכב, לא נקרא, מחיקה לאשפה המקומית, חסימה). עותק הדואר ו-Yahoo לא משתנים. כללים פעילים פועלים גם על דואר חדש כשהאפליקציה טוענת אותו.',
              'Rules work on this computer only: they change how the app shows mail (move, star, unread, delete to local Trash, block). The mail copy and Yahoo never change. Enabled rules also act on new mail when the app loads it.'
            )}
          </div>
          {f ? this._renderForm(f) : this._renderList()}
          {f ? null : (
            <div className="offline-modal-actions">
              <button type="button" className="btn" autoFocus onClick={closeRules}>
                {tr('סגור', 'Close')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
}
