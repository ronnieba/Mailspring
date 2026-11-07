import React from 'react';
import { ComposerEditor, ComposerSupport } from 'mailspring-component-kit';
import SpellPlugins, {
  setSpellPersonalDictionary,
} from '../../../src/components/composer-editor/spell-plugins';
import { createDemoComposerValue } from '../../../src/components/composer-editor/demo-composer-fixtures';
import { paragraphSnapshots } from '../../../src/components/composer-editor/paragraph-direction';
import {
  describeSpellBackends,
  formatBackendStatusText,
} from '../../../src/spellcheck/native-availability';
import {
  ensurePersonalDictionary,
  PersonalDictionary,
} from '../../../src/spellcheck/personal-dictionary';
import { isDemoMode } from './synthetic-demo';

const { convertFromHTML, convertToHTML } = ComposerSupport.Conversion;

interface DemoComposerState {
  value: any;
  lastHtml: string;
  backendNote: string;
  dictWords: string[];
}

function nativeLanguages(): string[] {
  try {
    const session = require('@electron/remote').getCurrentWebContents().session;
    return session.availableSpellCheckerLanguages || [];
  } catch {
    return [];
  }
}

export default class DemoComposer extends React.Component<
  Record<string, never>,
  DemoComposerState
> {
  static displayName = 'DemoComposer';
  private dict: PersonalDictionary | null = null;
  private unsubDict: (() => void) | null = null;

  state: DemoComposerState = {
    value: createDemoComposerValue(),
    lastHtml: '',
    backendNote: '',
    dictWords: [],
  };

  componentDidMount() {
    if (!isDemoMode()) {
      return;
    }
    try {
      this.dict = ensurePersonalDictionary(AppEnv.getConfigDirPath());
      setSpellPersonalDictionary(this.dict);
      this.unsubDict = this.dict.subscribe(() => {
        this.setState({ dictWords: this.dict ? this.dict.list() : [] });
      });
      this.setState({ dictWords: this.dict.list() });
    } catch (err) {
      console.error('[Demo Composer] personal dictionary not installed', err);
    }
    const status = describeSpellBackends(nativeLanguages());
    this.setState({
      backendNote: formatBackendStatusText(status),
    });
    (window as any).__mailspringDemoComposer = {
      serializeAndReopen: () => this._onSerializeReopen(),
      reload: () => this._onReload(),
      getHtml: () => this.state.lastHtml || convertToHTML(this.state.value),
      getParagraphs: () => paragraphSnapshots(this.state.value),
      dictWords: () => (this.dict ? this.dict.list() : []),
    };
  }

  componentWillUnmount() {
    if (this.unsubDict) {
      this.unsubDict();
    }
    if ((window as any).__mailspringDemoComposer) {
      delete (window as any).__mailspringDemoComposer;
    }
  }

  _onChange = (change: { operations: any; value: any }) => {
    this.setState({ value: change.value });
  };

  _onReload = () => {
    this.setState({ value: createDemoComposerValue(), lastHtml: '' });
  };

  _onSerializeReopen = () => {
    const html = convertToHTML(this.state.value);
    const reopened = convertFromHTML(html);
    this.setState({ value: reopened, lastHtml: html });
    return html;
  };

  render() {
    const { backendNote, lastHtml, value } = this.state;
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
        <div
          className="demo-composer-backend"
          role="status"
          aria-label="מצב בודק איות"
          data-hebrew-general="blocked"
        >
          {backendNote || 'General Hebrew: BLOCKED · UI-test overlay only · no silent auto-correct'}
        </div>
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
                onClick={() => this.dict?.remove(w)}
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
