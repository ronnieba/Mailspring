import React from 'react';
import { ComposerEditor, ComposerSupport } from 'mailspring-component-kit';
import { Editor } from 'slate';
import SpellPlugins, {
  refreshSpellDecorations,
  setSpellPersonalDictionary,
} from '../../../src/components/composer-editor/spell-plugins';
import { createDemoComposerValue } from '../../../src/components/composer-editor/demo-composer-fixtures';
import { paragraphSnapshots } from '../../../src/components/composer-editor/paragraph-direction';
import {
  describeSpellBackends,
  enableNativeSpellSession,
  formatBackendStatusText,
  SpellBackendStatus,
} from '../../../src/spellcheck/native-availability';
import {
  ensurePersonalDictionary,
  installPersonalDictionary,
  PersonalDictionary,
} from '../../../src/spellcheck/personal-dictionary';
import { isDemoMode } from './synthetic-demo';

const { convertFromHTML, convertToHTML } = ComposerSupport.Conversion;

interface DemoComposerState {
  value: any;
  lastHtml: string;
  backendNote: string;
  dictWords: string[];
  hebrewListed: boolean;
}

function currentSession(): {
  availableSpellCheckerLanguages?: string[];
  setSpellCheckerEnabled?: (enable: boolean) => void;
  setSpellCheckerLanguages?: (languages: string[]) => void;
} | null {
  try {
    return require('@electron/remote').getCurrentWebContents().session;
  } catch {
    return null;
  }
}

export default class DemoComposer extends React.Component<
  Record<string, never>,
  DemoComposerState
> {
  static displayName = 'DemoComposer';
  private dict: PersonalDictionary | null = null;
  private unsubDict: (() => void) | null = null;
  private slate: Editor | null = null;

  state: DemoComposerState = {
    value: createDemoComposerValue(),
    lastHtml: '',
    backendNote: '',
    dictWords: [],
    hebrewListed: false,
  };

  componentDidMount() {
    if (!isDemoMode()) {
      return;
    }
    try {
      this.dict = ensurePersonalDictionary(AppEnv.getConfigDirPath());
      setSpellPersonalDictionary(this.dict);
      this.unsubDict = this.dict.subscribe(() => {
        this._refreshOverlay();
      });
      this.setState({ dictWords: this.dict.list() });
    } catch (err) {
      console.error('[Demo Composer] personal dictionary not installed', err);
    }
    const session = currentSession();
    const langs = session ? session.availableSpellCheckerLanguages || [] : [];
    enableNativeSpellSession(session, null);
    const status: SpellBackendStatus = describeSpellBackends(langs);
    this.setState({
      backendNote: formatBackendStatusText(status),
      hebrewListed: status.hebrew.listedInSession,
    });
    (window as any).__mailspringDemoComposer = {
      serializeAndReopen: () => this._onSerializeReopen(),
      reload: () => this._onReload(),
      getHtml: () => this.state.lastHtml || convertToHTML(this.state.value),
      getParagraphs: () => paragraphSnapshots(this.state.value),
      dictWords: () => (this.dict ? this.dict.list() : []),
      refreshSpell: () => this._refreshOverlay(),
    };
  }

  componentWillUnmount() {
    if (this.unsubDict) {
      this.unsubDict();
    }
    installPersonalDictionary(null);
    if ((window as any).__mailspringDemoComposer) {
      delete (window as any).__mailspringDemoComposer;
    }
  }

  _onEditor = (editor: Editor | null) => {
    this.slate = editor;
    if (editor) {
      try {
        refreshSpellDecorations(editor);
      } catch {
        // First paint may precede plugin attach.
      }
    }
  };

  _refreshOverlay = () => {
    if (this.slate) {
      try {
        refreshSpellDecorations(this.slate);
      } catch {
        // Editor torn down.
      }
    }
    this.setState({
      dictWords: this.dict ? this.dict.list() : [],
      value: this.slate ? this.slate.value : this.state.value,
    });
  };

  _onChange = (change: { operations: any; value: any }) => {
    this.setState({ value: change.value });
  };

  _onReload = () => {
    this.setState({ value: createDemoComposerValue(), lastHtml: '' }, () => this._refreshOverlay());
  };

  _onSerializeReopen = () => {
    const html = convertToHTML(this.state.value);
    const reopened = convertFromHTML(html);
    this.setState({ value: reopened, lastHtml: html }, () => this._refreshOverlay());
    return html;
  };

  _removeDictWord = (word: string) => {
    this.dict?.remove(word);
  };

  render() {
    const { backendNote, lastHtml, value, hebrewListed } = this.state;
    return (
      <div
        className="demo-composer"
        data-demo-composer="true"
        role="region"
        aria-label="DEMO composer (synthetic)"
      >
        <div className="demo-composer-banner">
          עורך DEMO · אותו ComposerEditor · אין שליחה · אין שמירת טיוטה
        </div>
        <details
          className="demo-composer-backend"
          role="status"
          aria-label="מצב בודק איות"
          data-hebrew-native={hebrewListed ? 'listed' : 'absent'}
          data-hebrew-runtime="pending"
          data-hebrew-bundled="not-shipped"
        >
          <summary>
            {hebrewListed
              ? 'Native Hebrew listed this session — runtime verification pending'
              : 'Native Hebrew not listed this session — not a universal unavailable claim'}
          </summary>
          <p>
            {backendNote ||
              'Native runtime pending · UI-test overlay only · bundled Hspell not shipped · no silent auto-correct'}
          </p>
        </details>
        <div className="demo-composer-actions">
          <button
            type="button"
            aria-label="סריאליזציה ופתיחה מחדש"
            onClick={this._onSerializeReopen}
          >
            סריאליזציה ופתיחה מחדש
          </button>
          <button type="button" aria-label="טען טיוטת DEMO מחדש" onClick={this._onReload}>
            טען טיוטת DEMO מחדש
          </button>
        </div>
        <ComposerEditor
          value={value}
          className="demo-composer-editor"
          nativeSpellCheck={true}
          extraPlugins={SpellPlugins}
          propsForPlugins={{ draft: null, session: null, demoComposer: true }}
          onChange={this._onChange}
          onFileReceived={() => {}}
          onUpdatedSlateEditor={this._onEditor}
        />
        <div className="demo-composer-dict" role="region" aria-label="מילון אישי">
          <div className="demo-composer-dict-label">מילון אישי (פרופיל DEMO בלבד)</div>
          {this.state.dictWords.length === 0 ? (
            <div className="demo-composer-dict-empty">אין מילים שמורות</div>
          ) : (
            this.state.dictWords.map((w) => (
              <button
                key={w}
                type="button"
                className="demo-composer-dict-remove"
                aria-label={`הסר מהמילון האישי: ${w}`}
                onClick={() => this._removeDictWord(w)}
              >
                {w} ✕
              </button>
            ))
          )}
        </div>
        {lastHtml ? (
          <pre className="demo-composer-html" aria-label="HTML after serialize">
            {lastHtml}
          </pre>
        ) : null}
      </div>
    );
  }
}
