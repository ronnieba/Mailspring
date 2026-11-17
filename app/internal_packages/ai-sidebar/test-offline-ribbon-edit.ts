#!/usr/bin/env npx ts-node
/**
 * Offline experiment (t224-t226): ribbon editing.
 *  - Home always has "Select all messages" (the list on screen).
 *  - The Edit group (undo/redo/cut/copy/paste/paste as text/select all text)
 *    only shows while a draft is open; its "Select all" selects the text of
 *    the draft field last edited (the body by default).
 *  - Edit buttons put the focus back in the last used field first, so they
 *    also work after Tab-ing onto the ribbon.
 * Logic + source checks; the live behaviour is checked in a hidden window.
 *
 *   npx ts-node --transpile-only --project app/tsconfig.json app/internal_packages/ai-sidebar/test-offline-ribbon-edit.ts
 */
import fs from 'fs';
import path from 'path';
import { isEditableElement } from './lib/offline-mail/offline-edit-target';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: any) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra === undefined ? '' : extra);
  }
}

console.log('editable fields');
const el = (tag: string, extra: any = {}) => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  ...extra,
});
check('textarea (AI box)', isEditableElement(el('textarea')));
check('disabled textarea', !isEditableElement(el('textarea', { disabled: true })));
check('text input (subject)', isEditableElement(el('input', { type: 'text' })));
check('search input', isEditableElement(el('input', { type: 'search' })));
check('checkbox is not a text field', !isEditableElement(el('input', { type: 'checkbox' })));
check('button is not a text field', !isEditableElement(el('button')));
check('contentEditable (draft body)', isEditableElement(el('div', { isContentEditable: true })));
check('plain div', !isEditableElement(el('div')));
check('null', !isEditableElement(null));

const src = fs.readFileSync(path.join(__dirname, 'lib/offline-mail/offline-ribbon.tsx'), 'utf8');
const tracker = fs.readFileSync(
  path.join(__dirname, 'lib/offline-mail/offline-edit-target.ts'),
  'utf8'
);
const home = src.slice(src.indexOf("case 'home':"), src.indexOf("case 'view':"));
const drafts = src.slice(src.indexOf("case 'drafts':"), src.indexOf("case 'ai': {"));
const edit = src.slice(
  src.indexOf('_editGroup(): Group {'),
  src.indexOf('_groups(tab: OfflineRibbonTab)')
);

console.log('home: select all messages');
check(
  'always on Home',
  /id: 'select-messages'/.test(home) && !/draft \? \[[^\]]*select-messages/.test(home)
);
check(
  'label + tooltip',
  home.includes("tr('בחר את כל ההודעות', 'Select all messages')") &&
    home.includes('בוחר את כל ההודעות ברשימה המוצגת')
);
check(
  'uses the list selection (search results or folder list)',
  /ribbonSelectAllMessages\(\)[\s\S]*data-offline-search-select-all[\s\S]*selectAllVisible\(\)/.test(
    src
  )
);
check(
  'from the drafts screen goes back to the list (draft saved by hide())',
  /ribbonSelectAllMessages[\s\S]{0,300}offlineDraftsStore\.hide\(\)/.test(src)
);

console.log('contextual edit group');
check('Home: only while a draft is open', home.includes('...(draft ? [this._editGroup()] : [])'));
check(
  'Drafts tab: only while a draft is open',
  drafts.includes('...(draft ? [this._editGroup()] : [])')
);
check('no unconditional edit group left', !/^\s*this\._editGroup\(\),\s*$/m.test(src));
for (const id of ['undo', 'redo', 'cut', 'copy', 'paste', 'paste-plain', 'select-all-text']) {
  check(`edit group has ${id}`, edit.includes(`id: '${id}'`));
}
check(
  'select all text label + tooltip',
  edit.includes("tr('בחר הכל', 'Select all text')") && edit.includes('ברירת מחדל: גוף ההודעה')
);
check(
  'select all text -> last draft field, body by default',
  /ribbonSelectAllDraftText[\s\S]*draftSelectTarget\(\)/.test(src) &&
    /draftSelectTarget[\s\S]*lastDraftField[\s\S]*data-offline-draft-field="body"/.test(tracker)
);
check(
  'undo/redo/cut/paste/paste-as-text restore the field first',
  (edit.match(/inField\(\(\) => wc\(\)\./g) || []).length === 5
);
check('copy keeps text marked in the reader', /markedElsewhere/.test(edit));

console.log('focus');
check(
  'ribbon buttons never take focus on mousedown',
  /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/.test(src)
);
check(
  'tracker installed with the ribbon',
  src.includes('this._unsubs.push(installEditTargetTracker(document))')
);
check(
  'clicking plain content forgets the field, other windows do not',
  /doc\.hasFocus\(\) && \(!active \|\| active === doc\.body\)/.test(tracker)
);
check('caret / selection restored in the draft body', tracker.includes('sel.addRange(lastRange)'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
