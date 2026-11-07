import fs from 'fs';
import path from 'path';
import { isDemoMode } from './demo-mode';
import { languagesToEnable, pickSupportedLanguage } from './spellcheck/native-availability';
import {
  ensurePersonalDictionary,
  getActivePersonalDictionary,
} from './spellcheck/personal-dictionary';

const { app } = require('@electron/remote');
const customDictFilePath = path.join(AppEnv.getConfigDirPath(), 'custom-dict.json');

class Spellchecker {
  private _session = require('@electron/remote').getCurrentWebContents().session;

  constructor() {
    //this._session = ;

    // Nobody will notice if spellcheck isn't available for a few seconds and it
    // takes a considerable amount of time to startup (212ms in dev mode on my 2017 MBP)
    const initHandler = () => {
      this._migrateFromCustomDict();

      const initialLanguage = AppEnv.config.get('core.composing.spellcheckDefaultLanguage');
      this._switchToLanguage(initialLanguage);

      // Monitor language setting for changes. Note that as the user types in a draft we
      // change spellcheck to that language.
      AppEnv.config.onDidChange('core.composing.spellcheckDefaultLanguage', (value) => {
        this._switchToLanguage(value.newValue);
      });
    };

    if (AppEnv.inSpecMode()) {
      initHandler();
    } else {
      setTimeout(initHandler, 5000);
    }
  }

  _switchToLanguage = (lang: string | undefined | null) => {
    if (lang === null || lang === undefined || lang === '') {
      lang = app.getLocale() || 'en-US';
    }
    const supported: string[] = this._session.availableSpellCheckerLanguages || [];
    const list = languagesToEnable(supported, lang);
    if (list.length === 0) {
      return;
    }
    try {
      this._session.setSpellCheckerLanguages(list);
    } catch (err) {
      const fallback = pickSupportedLanguage(supported, [lang, 'en-US', 'en']);
      if (fallback) {
        try {
          this._session.setSpellCheckerLanguages([fallback]);
        } catch {
          // Unknown codes throw on some platforms; leave the session language unchanged.
        }
      }
    }
  };

  _migrateFromCustomDict = () => {
    // macOS addWordToSpellCheckerDictionary writes ~/Library/Spelling. Demo must not.
    if (isDemoMode()) {
      return;
    }
    fs.readFile(customDictFilePath, (err, data) => {
      let fileData: any = data;
      if (err) {
        if (err.code === 'ENOENT') {
          // File doesn't exist, we haven't saved any words yet
          fileData = '{}';
        } else {
          AppEnv.reportError(err);
          return;
        }
      }
      const loadedDict = JSON.parse(fileData);
      Object.keys(loadedDict).forEach((word) =>
        this._session.addWordToSpellCheckerDictionary(word)
      );
      fs.unlink(customDictFilePath, () => {});
    });
  };

  learnWord = (word: string) => {
    if (isDemoMode()) {
      const dict =
        getActivePersonalDictionary() || ensurePersonalDictionary(AppEnv.getConfigDirPath());
      dict.add(word);
      return;
    }
    this._session.addWordToSpellCheckerDictionary(word);
  };

  unlearnWord = (word: string) => {
    if (isDemoMode()) {
      const dict =
        getActivePersonalDictionary() || ensurePersonalDictionary(AppEnv.getConfigDirPath());
      dict.remove(word);
      return;
    }
    this._session.removeWordFromSpellCheckerDictionary(word);
  };
}

export default new Spellchecker();
