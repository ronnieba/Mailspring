/* eslint global-require: "off" */

import '../safe-shell';
import { installOfflineNetworkGuard } from './offline-network-guard';
import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  app,
  clipboard,
  ipcMain,
  dialog,
  nativeImage,
  powerMonitor,
  shell,
} from 'electron';

import fs from 'fs';
import url from 'url';
import path from 'path';
import proc from 'child_process';
import { EventEmitter } from 'events';

import { localized, initializeLocalization } from '../intl';
import WindowManager from './window-manager';
import FileListCache from './file-list-cache';
import ConfigMigrator from './config-migrator';
import ApplicationMenu from './application-menu';
import AutoUpdateManager from './autoupdate-manager';
import SystemAccentWatcher from './system-accent-watcher';
import SystemTrayManager from './system-tray-manager';
import { DefaultClientHelper } from '../default-client-helper';
import { developerToolsAvailable } from '../developer-tools';
import MailspringProtocolHandler from './mailspring-protocol-handler';
import ConfigPersistenceManager from './config-persistence-manager';
import moveToApplications from './move-to-applications';
import { MailsyncProcess } from '../mailsync-process';
import Config from '../config';
import { registerQuickpreviewIPCHandlers } from './quickpreview-ipc';
import { registerLocalAIIPCHandlers } from './local-ai-service';
import { resolveGeminiDemoStatus } from './gemini-demo-host';
import { registerGeminiDemoIpcHandlers } from './gemini-demo-ipc';
import { formatGeminiDemoStatusLog } from './gemini-demo-secret';
import { registerViewSessionIPCHandlers } from './view-sessions';
import { guardAuxiliaryWindowNavigation } from './auxiliary-window-guard';
import { onFromMailspringWindows, handleFromMailspringWindows } from './trusted-ipc';
import {
  handleWindowsToastXMLProtocolAction,
  registerNotificationIPCHandlers,
} from './notification-ipc';
import WindowsTaskbarManager from './windows-taskbar-manager';
import { resetThemeForRecovery } from './theme-recovery';
import { mailCacheRecoveryAction } from '../mail-database-policy';
import {
  DEMO_SIDEBAR_SNAPSHOT_JS,
  DEMO_SIDEBAR_RUN_QUERY_JS,
  DEMO_SIDEBAR_REVEAL_CITATIONS_JS,
  evaluateDemoSidebarReady,
  evaluateDemoQueryComplete,
  DemoSidebarSnapshot,
} from '../demo-sidebar-readiness';

// The options renderers may pass to `new-window`: what the popout composer (DraftStore) and
// thread popout (MessageStore) send, plus window sizing for plugins. The main process sets
// every other load setting itself, since some (like `bootstrapScript`) choose the code a
// nodeIntegration window runs.
const RENDERER_WINDOW_OPTIONS = [
  'title',
  'hidden',
  'windowKey',
  'windowType',
  'windowProps',
  'width',
  'height',
  'bounds',
];

function rendererWindowOptions(options: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const key of RENDERER_WINDOW_OPTIONS) {
    if (key in options) safe[key] = options[key];
  }
  return safe;
}

// The application's singleton class.
//
export default class Application extends EventEmitter {
  resourcePath: string;
  configDirPath: string;
  config: Config;
  version: string;
  devMode: boolean;
  specMode: boolean;
  safeMode: boolean;
  quitting: boolean;

  configMigrator: ConfigMigrator;
  configPersistenceManager: ConfigPersistenceManager;
  fileListCache: FileListCache;
  applicationMenu: ApplicationMenu;
  mailspringProtocolHandler: MailspringProtocolHandler;
  windowManager: WindowManager;
  autoUpdateManager: AutoUpdateManager;
  systemAccentWatcher: SystemAccentWatcher;
  systemTrayManager: SystemTrayManager;
  windowsTaskbarManager?: WindowsTaskbarManager;

  _sourceWindows: { [taskId: string]: BrowserWindow } = {};
  _resettingAndRelaunching: boolean;
  _initialized = false;
  _pendingLaunchOptions: any[] = [];
  _pendingUrls: string[] = [];
  demoMode: boolean;
  realSelectedSummary: boolean;
  offlineArchive: boolean;
  offlineArchivePath: string | null;
  demoCapturePath: string | null;

  async start(options) {
    const {
      resourcePath,
      configDirPath,
      version,
      devMode,
      specMode,
      safeMode,
      demoMode,
      realSelectedSummary,
      offlineArchive,
      offlineArchivePath,
      demoCapturePath,
    } = options;

    initializeLocalization({ configDirPath });

    // Normalize to make sure drive letter case is consistent on Windows
    this.resourcePath = resourcePath;
    this.configDirPath = configDirPath;
    this.version = version;
    this.devMode = devMode;
    this.specMode = specMode;
    this.safeMode = safeMode;
    // Demo is developer-build only (parsed in main.js). Never on packaged production.
    this.demoMode = !!demoMode;
    this.offlineArchive = !this.demoMode && !!offlineArchive;
    this.offlineArchivePath =
      this.offlineArchive && offlineArchivePath ? String(offlineArchivePath) : null;
    this.realSelectedSummary = !this.demoMode && !this.offlineArchive && !!realSelectedSummary;
    this.demoCapturePath = demoCapturePath || null;

    this.fileListCache = new FileListCache();
    this.mailspringProtocolHandler = new MailspringProtocolHandler({
      configDirPath,
      resourcePath,
      safeMode,
    });

    try {
      if (this.demoMode) {
        console.log('[Demo Mode] Skipping mailsync migrate — no real mailbox database');
        console.log(formatGeminiDemoStatusLog(resolveGeminiDemoStatus({ demoMode: true })));
        if (process.env.MAILSPRING_DEMO_DELAY_MS) {
          console.log(
            `[Demo Mode] Mock query delay ${process.env.MAILSPRING_DEMO_DELAY_MS}ms (Cancel testing only)`
          );
        }
      } else if (this.offlineArchive) {
        installOfflineNetworkGuard();
        console.log(
          '[Offline archive] Skipping mailsync — disconnected experiment. Official /Applications/Mailspring.app is unused. Yahoo IMAP is not opened. Gemini is not bulk-upload; only explicit Summarize of one selected local message.'
        );
        console.log(
          formatGeminiDemoStatusLog(
            resolveGeminiDemoStatus({
              demoMode: false,
              realSelectedSummary: false,
              offlineArchive: true,
            })
          )
        );
      } else {
        if (this.realSelectedSummary) {
          console.log(
            '[Real selected summary] Isolated Mailspring-dev. Official /Applications/Mailspring.app is unused. Do not copy production profile/Keychain. Yahoo in this profile is a separate login. One selected message is sent only after explicit Summarize.'
          );
          console.log(
            formatGeminiDemoStatusLog(
              resolveGeminiDemoStatus({ demoMode: false, realSelectedSummary: true })
            )
          );
        }
        const mailsync = new MailsyncProcess(options);
        await mailsync.migrate();
      }
    } catch (err) {
      let message = null;
      let buttons = [localized('Quit')];
      if (err.toString().includes('ENOENT')) {
        message = localized(
          `Mailspring could not find the mailsync process. If you're building Mailspring from source, make sure mailsync.tar.gz has been downloaded and unpacked in your working copy.`
        );
      } else if (err.toString().includes('spawn')) {
        message = localized(`Mailspring could not spawn the mailsync process. %@`, err.toString());
      } else {
        message = localized(
          `We encountered a problem with your local email database. %@\n\nCheck that no other copies of Mailspring are running and click Rebuild to reset your local cache.`,
          err.toString()
        );
        buttons = [localized('Quit'), localized('Rebuild')];
      }

      const buttonIndex = dialog.showMessageBoxSync({ type: 'warning', buttons, message });

      if (buttonIndex === 0) {
        app.quit();
      } else {
        this._deleteDatabase(() => {
          app.relaunch();
          app.quit();
        });
      }
      return;
    }

    const Config = require('../config').default;
    const config = new Config();
    this.config = config;
    this.configPersistenceManager = new ConfigPersistenceManager({ configDirPath, resourcePath });

    // If the user's config.json could not be read (eg: corrupted / truncated on disk)
    // and they chose to quit from the error dialog, ConfigPersistenceManager has
    // already called app.quit() and left `settings` empty. app.quit() does not halt
    // synchronous execution, so without this check we'd continue on to config.load(),
    // which throws because there are no settings to load, reporting a confusing
    // "this.settings is empty" error on our way out the door. Stop here instead.
    if (this.configPersistenceManager.userWantsToPreserveErrors) {
      return;
    }
    config.load();

    this.configMigrator = new ConfigMigrator(this.config);
    this.configMigrator.migrate();

    let initializeInBackground = options.background;
    if (initializeInBackground === undefined) {
      initializeInBackground = false;
    }

    if (!this.demoMode && !this.offlineArchive) {
      await this.oneTimeMoveToApplications();
      await this.oneTimeAddToDock();
    }

    guardAuxiliaryWindowNavigation();
    this.autoUpdateManager = new AutoUpdateManager(
      version,
      config,
      specMode || this.demoMode || this.offlineArchive
    );
    this.applicationMenu = new ApplicationMenu(version);
    this.windowManager = new WindowManager({
      resourcePath: this.resourcePath,
      configDirPath: this.configDirPath,
      config: this.config,
      devMode: this.devMode,
      specMode: this.specMode,
      safeMode: this.safeMode,
      initializeInBackground: initializeInBackground,
    });
    this.systemTrayManager = new SystemTrayManager(process.platform, this);
    this.systemAccentWatcher = new SystemAccentWatcher();
    this.systemAccentWatcher.on('change', (color: string) => {
      this.windowManager.sendToAllWindows('system-accent-color-changed', {}, color);
    });
    this.systemAccentWatcher.on('dark-mode-change', (darkMode: boolean) => {
      this.windowManager.sendToAllWindows('system-dark-mode-changed', {}, darkMode);
    });
    if (process.platform === 'win32') {
      this.windowsTaskbarManager = new WindowsTaskbarManager(this);
    }

    this.handleEvents();

    // Mark initialization complete, then process the initial launch options
    // followed by any second-instance options that arrived while we were
    // still awaiting async initialization steps above.
    this._initialized = true;
    this.handleLaunchOptions(options);
    for (const pendingOpts of this._pendingLaunchOptions.splice(0)) {
      this.handleLaunchOptions(pendingOpts);
    }
    for (const pendingUrl of this._pendingUrls.splice(0)) {
      this.openUrl(pendingUrl);
    }

    // Skip URL scheme registration in dev/spec mode to avoid taking over links
    // from the production app. Dev instances can still open mailspring:// URLs
    // passed on the command line, but won't become the system handler.
    if (!this.devMode && !this.specMode) {
      if (process.platform === 'linux') {
        const helper = new DefaultClientHelper();
        helper.registerForURLScheme('mailspring');
      } else {
        app.setAsDefaultProtocolClient('mailspring');
      }
    }
  }

  getMainWindow() {
    const win = this.windowManager.get(WindowManager.MAIN_WINDOW);
    return win ? win.browserWindow : null;
  }

  getAllWindowDimensions() {
    return this.windowManager.getAllWindowDimensions();
  }

  isQuitting() {
    return this.quitting;
  }

  // Opens a new window based on the options provided.
  handleLaunchOptions(options) {
    // If start() hasn't finished initializing yet (e.g. a second-instance event
    // arrives while the async mailsync migration or oneTimeMoveToApplications is
    // still running), windowManager won't exist yet.  Queue the options and
    // process them once initialization is complete.
    if (!this._initialized) {
      this._pendingLaunchOptions.push(options);
      return;
    }

    const { specMode, pathsToOpen, urlsToOpen } = options;

    if (specMode) {
      const {
        resourcePath,
        specDirectory,
        specFilePattern,
        logFile,
        showSpecsInWindow,
        jUnitXmlPath,
      } = options;
      const exitWhenDone = true;
      this.runSpecs({
        exitWhenDone,
        showSpecsInWindow,
        resourcePath,
        specDirectory,
        specFilePattern,
        logFile,
        jUnitXmlPath,
      });
      return;
    }

    const hasPaths = pathsToOpen instanceof Array && pathsToOpen.length > 0;
    const hasUrls = urlsToOpen instanceof Array && urlsToOpen.length > 0;

    this.ensureWindowsForTokenState({ preserveHiddenOrMinimized: hasPaths || hasUrls });

    if (hasPaths) {
      this.openComposerWithFiles(pathsToOpen);
    }
    if (hasUrls) {
      for (const urlToOpen of urlsToOpen) {
        this.openUrl(urlToOpen);
      }
    }
  }

  async oneTimeMoveToApplications() {
    if (process.platform !== 'darwin') {
      return;
    }
    if (this.devMode || this.specMode) {
      return;
    }
    if (this.config.get('askedAboutAppMove')) {
      return;
    }
    this.config.set('askedAboutAppMove', true);
    moveToApplications();
  }

  async oneTimeAddToDock() {
    if (process.platform !== 'darwin') {
      return;
    }
    if (this.devMode || this.specMode || this.demoMode) {
      return;
    }
    const addedToDock = this.config.get('addedToDock');
    const appPath = process.argv[0];
    if (!addedToDock && appPath.includes('/Applications/') && appPath.includes('.app/')) {
      const appBundlePath = appPath.split('.app/')[0];
      proc.exec(
        `defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-type</key><string>file-tile</string><key>tile-data</key><dict><key>file-type</key><integer>41</integer><key>file-label</key><string>Mailspring</string><key>bundle-identifier</key><string>com.mailspring.mailspring</string><key>file-data</key><dict><key>_CFURLString</key><string>file://${appBundlePath}.app/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>" && pkill "Dock"`
      );
      this.config.set('addedToDock', true);
    }
  }

  // On Windows, removing a file can fail if a process still has it open. When
  // we close windows and log out, we need to wait for these processes to completely
  // exit and then delete the file. It's hard to tell when this happens, so we just
  // retry the deletion a few times.
  deleteFileWithRetry(filePath, callback = () => {}, retries = 5) {
    const callbackWithRetry = (err: NodeJS.ErrnoException | null) => {
      if (err && err.message.indexOf('no such file') === -1) {
        console.log(`File Error: ${err.message} - retrying in 150msec`);
        setTimeout(() => {
          this.deleteFileWithRetry(filePath, callback, retries - 1);
        }, 150);
      } else {
        callback();
      }
    };

    if (!fs.existsSync(filePath)) {
      callback();
      return;
    }

    if (retries > 0) {
      fs.unlink(filePath, callbackWithRetry);
    } else {
      fs.unlink(filePath, callback);
    }
  }

  ensureWindowsForTokenState(behavior?: { preserveHiddenOrMinimized: boolean }) {
    // user may trigger this using the application menu / by focusing the app
    // before migration has completed and the config has been loaded.
    if (!this.config || !this.windowManager) return;

    const accounts = this.config.get('accounts');
    const hasAccount = accounts && accounts.length > 0;

    // Demo mode (dev only): Skip onboarding and open main window with synthetic data.
    // Does not create or impersonate a real account. Production onboarding is unchanged.
    if (this.demoMode) {
      console.log('[Demo Mode] Opening main window with synthetic data');
      this.config.set('core.workspace.mode', 'split');
      this.config.set('core.messageListSidebar.panel', 'ai-sidebar');
      this.windowManager.ensureWindow(
        WindowManager.MAIN_WINDOW,
        {
          windowProps: { demoMode: true },
          title: 'Mailspring Demo (synthetic — no account)',
        },
        behavior
      );
      this._scheduleDemoWindowCapture();
    } else if (this.offlineArchive) {
      console.log('[Offline archive] Opening main window from local archive (no Yahoo)');
      this.config.set('core.workspace.mode', 'split');
      this.config.set('core.messageListSidebar.panel', 'ai-sidebar');
      this.config.set('core.reading.autoloadImages', false);
      this.windowManager.ensureWindow(
        WindowManager.MAIN_WINDOW,
        {
          ...this._mainWindowOptions(),
          title: 'Mailspring Offline Archive (disconnected — no Yahoo)',
        },
        behavior
      );
    } else if (hasAccount) {
      this.windowManager.ensureWindow(
        WindowManager.MAIN_WINDOW,
        this._mainWindowOptions(),
        behavior
      );
    } else {
      const title = localized('Welcome to Mailspring');
      this.windowManager.ensureWindow(WindowManager.ONBOARDING_WINDOW, { title }, behavior);
    }
  }

  _mainWindowOptions() {
    if (this.offlineArchive) {
      return {
        windowProps: {
          offlineArchive: true,
          offlineArchivePath: this.offlineArchivePath,
        },
      };
    }
    if (this.realSelectedSummary) {
      return { windowProps: { realSelectedSummary: true } };
    }
    return {};
  }

  /**
   * Demo-only: capture THIS BrowserWindow via Electron's capturePage.
   * Does not use macOS screencapture, Screen Recording permission, or a
   * persistent remote-debug endpoint. Writes only the path passed as --demo-capture.
   */
  _scheduleDemoWindowCapture() {
    if (!this.demoMode || !this.demoCapturePath) {
      return;
    }
    const dest = path.resolve(this.demoCapturePath);
    const win = this.windowManager.get(WindowManager.MAIN_WINDOW);
    if (!win) {
      console.error('[Demo Mode] capture skipped: main window missing');
      return;
    }
    win.waitForLoad(() => {
      this._captureDemoWhenReady(win, dest).catch((err) => {
        console.error('[Demo Mode] capture failed:', (err as Error).message);
      });
    });
  }

  async _pollDemoSidebarSnapshot(win, timeoutMs: number): Promise<DemoSidebarSnapshot | null> {
    const deadline = Date.now() + timeoutMs;
    let last: DemoSidebarSnapshot | null = null;
    while (Date.now() < deadline) {
      if (win.browserWindow.isDestroyed()) {
        return last;
      }
      try {
        last = (await win.browserWindow.webContents.executeJavaScript(
          DEMO_SIDEBAR_SNAPSHOT_JS,
          true
        )) as DemoSidebarSnapshot;
      } catch (err) {
        last = {
          readyAttr: false,
          hasRoot: false,
          hasDemoBanner: false,
          hasMockWarning: false,
          scopeCount: 0,
          citationCount: 0,
          conversationCount: 0,
          tabs: [],
          reason: (err as Error).message,
        };
      }
      if (evaluateDemoSidebarReady(last).ready) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return last;
  }

  async _captureDemoWhenReady(win, dest: string) {
    const started = Date.now();
    const snap = await this._pollDemoSidebarSnapshot(win, 20000);
    const ready = evaluateDemoSidebarReady(snap);
    let queryComplete = false;
    if (!ready.ready) {
      console.error(
        `[Demo Mode] capture FAILED after ${Date.now() - started}ms: ${ready.reason}`,
        JSON.stringify(snap)
      );
    } else {
      console.log(
        `[Demo Mode] sidebar ready after ${Date.now() - started}ms tabs=${JSON.stringify(snap && snap.tabs)}`
      );
      try {
        const ran = await win.browserWindow.webContents.executeJavaScript(
          DEMO_SIDEBAR_RUN_QUERY_JS,
          true
        );
        if (!ran || !ran.ok) {
          console.error('[Demo Mode] mock query did not run:', ran && ran.reason);
        } else {
          const queryDeadline = Date.now() + 10000;
          let querySnap = snap;
          while (Date.now() < queryDeadline) {
            querySnap = (await win.browserWindow.webContents.executeJavaScript(
              DEMO_SIDEBAR_SNAPSHOT_JS,
              true
            )) as DemoSidebarSnapshot;
            if (evaluateDemoQueryComplete(querySnap).complete) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const q = evaluateDemoQueryComplete(querySnap);
          queryComplete = q.complete;
          if (!q.complete) {
            console.error(
              `[Demo Mode] mock query incomplete: ${q.reason}`,
              JSON.stringify(querySnap)
            );
          } else {
            console.log(
              `[Demo Mode] mock query complete citations=${querySnap.citationCount} messages=${querySnap.conversationCount}`
            );
          }
        }
      } catch (err) {
        console.error('[Demo Mode] mock query failed:', (err as Error).message);
      }
    }

    if (win.browserWindow.isDestroyed()) {
      console.error('[Demo Mode] capture skipped: window destroyed');
      return;
    }
    if (queryComplete) {
      try {
        await win.browserWindow.webContents.executeJavaScript(
          DEMO_SIDEBAR_REVEAL_CITATIONS_JS,
          true
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch {
        // still capture
      }
    }
    const image = await win.browserWindow.capturePage();
    const png = image.toPNG();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, png);
    if (ready.ready && queryComplete) {
      console.log(`[Demo Mode] Wrote own-window capture (${png.length} bytes) to ${dest}`);
    } else {
      console.error(
        `[Demo Mode] Wrote diagnostic capture (${png.length} bytes) to ${dest} (ready=${ready.ready} query=${queryComplete})`
      );
    }
  }

  _resetDatabaseAndRelaunch = ({ errorMessage }: { errorMessage?: string } = {}) => {
    // Demo has no mail cache. Rebuild+relaunch with the same --demo args is
    // the endless Okay dialog (SqliteError readonly → delete → relaunch).
    if (mailCacheRecoveryAction({ demoMode: this.demoMode }) !== 'rebuild-and-relaunch') {
      console.error(
        '[Demo Mode] Ignoring application:reset-database (no mail DB rebuild):',
        errorMessage
      );
      return;
    }
    if (this._resettingAndRelaunching) return;
    this._resettingAndRelaunching = true;

    if (errorMessage) {
      dialog.showMessageBoxSync({
        type: 'warning',
        buttons: [localized('Okay')],
        message: localized(
          `We encountered a problem with your local email database. We will now attempt to rebuild it.`
        ),
        detail: errorMessage,
      });
    }

    const done = () => {
      app.relaunch();
      app.quit();
    };
    this.windowManager.destroyAllWindows();
    this._deleteDatabase(done);
  };

  _deleteDatabase = (callback) => {
    this.deleteFileWithRetry(path.join(this.configDirPath, 'edgehill.db'), callback);
    this.deleteFileWithRetry(path.join(this.configDirPath, 'edgehill.db-wal'));
    this.deleteFileWithRetry(path.join(this.configDirPath, 'edgehill.db-shm'));
  };

  // Registers basic application commands, non-idempotent.
  // Note: If these events are triggered while an application window is open, the window
  // needs to manually bubble them up to the Application instance via IPC or they won't be
  // handled. This happens in workspace-element.ts
  handleEvents() {
    this.on('application:run-all-specs', () => {
      const win = this.windowManager.focusedWindow();
      this.runSpecs({
        exitWhenDone: false,
        showSpecsInWindow: true,
        resourcePath: this.resourcePath,
        safeMode: win && win.safeMode,
      });
    });

    this.on('application:run-package-specs', async () => {
      const { filePaths } = await dialog.showOpenDialog({
        title: localized('Choose Directory'),
        defaultPath: this.configDirPath,
        buttonLabel: localized('Choose'),
        properties: ['openDirectory'],
      });

      if (!filePaths || filePaths.length === 0) {
        return;
      }
      this.runSpecs({
        exitWhenDone: false,
        showSpecsInWindow: true,
        resourcePath: this.resourcePath,
        specDirectory: filePaths[0],
      });
    });

    this.on('application:reset-database', this._resetDatabaseAndRelaunch);

    this.on('application:quit', () => {
      app.quit();
    });

    this.on('application:inspect', ({ x, y, MailspringWindow }) => {
      const win = MailspringWindow || this.windowManager.focusedWindow();
      if (!win) {
        return;
      }
      win.browserWindow.inspectElement(x, y);
    });

    this.on('application:add-identity', () => {
      const onboarding = this.windowManager.get(WindowManager.ONBOARDING_WINDOW);
      if (onboarding) {
        onboarding.show();
        onboarding.focus();
      } else {
        this.windowManager.ensureWindow(WindowManager.ONBOARDING_WINDOW, {
          title: localized('Welcome to Mailspring'),
          windowProps: {},
        });
      }
    });

    this.on('application:add-account', ({ existingAccountJSON, o365SharedMailbox } = {}) => {
      const onboarding = this.windowManager.get(WindowManager.ONBOARDING_WINDOW);
      if (onboarding) {
        onboarding.show();
        onboarding.focus();
      } else {
        this.windowManager.ensureWindow(WindowManager.ONBOARDING_WINDOW, {
          windowProps: { addingAccount: true, existingAccountJSON, o365SharedMailbox },
          title: localized('Add Account'),
        });
      }
    });

    this.on('application:new-message', () => {
      const main = this.windowManager.get(WindowManager.MAIN_WINDOW);
      if (main) {
        main.sendMessage('new-message');
      }
    });

    // Unlike show-main-window (tray, Preferences), these also switch the main window's section.
    this.on('application:show-mail', () => {
      this.ensureWindowsForTokenState();
      this.windowManager.get(WindowManager.MAIN_WINDOW)?.sendMessage('show-mail');
    });

    // `focusEvent` names an event to show; the menu item passes none.
    this.on('application:show-calendar', (focusEvent?: unknown) => {
      this.ensureWindowsForTokenState();
      this.windowManager.get(WindowManager.MAIN_WINDOW)?.sendMessage('show-calendar', focusEvent);
    });

    this.on('application:show-activity', () => {
      this.ensureWindowsForTokenState();
      this.windowManager.get(WindowManager.MAIN_WINDOW)?.sendMessage('show-activity');
    });

    // Only the main window's MailsyncBridge has sync clients, so other windows route a
    // refresh through here.
    this.on('application:sync-calendar', (accountId?: string) => {
      this.sendCalendarSync(accountId);
    });

    this.on('application:show-contacts', () => {
      this.windowManager.ensureWindow(WindowManager.CONTACTS_WINDOW, {});
      const main = this.windowManager.get(WindowManager.MAIN_WINDOW);
      if (main) {
        main.sendMessage('run-contact-sync');
      }
    });

    this.on('application:view-help', () => {
      const helpUrl = 'https://getmailspring.com/docs/';
      shell.openExternal(helpUrl);
    });

    this.on('application:view-getting-started', () => {
      const helpUrl = 'https://community.getmailspring.com/pub/quick-start-guide';
      shell.openExternal(helpUrl);
    });

    this.on('application:view-community', () => {
      const helpUrl = 'https://community.getmailspring.com/';
      shell.openExternal(helpUrl);
    });

    this.on('application:open-preferences', () => {
      const main = this.windowManager.get(WindowManager.MAIN_WINDOW);
      if (main) {
        main.sendMessage('open-preferences');
      }
    });

    this.on('application:show-main-window', () => {
      this.ensureWindowsForTokenState();
    });

    this.on('application:check-for-update', () => {
      this.autoUpdateManager.check();
    });

    this.on('application:install-update', () => {
      this.quitting = true;
      this.windowManager.cleanupBeforeAppQuit();
      this.autoUpdateManager.install();
    });

    this.on('application:toggle-dev', () => {
      if (!developerToolsAvailable()) return;
      let args = process.argv.slice(1);
      if (args.includes('--dev')) {
        args = args.filter((a) => a !== '--dev');
      } else {
        args.push('--dev');
      }
      app.relaunch({ args });
      app.quit();
    });

    this.on('application:view-license', () => {
      // Workaround to correctly get the unpacked path of the licenses file.
      // For more information, see: https://github.com/electron/electron/issues/6262
      shell.openPath(
        path
          .join(this.resourcePath, 'static', 'all_licenses.html')
          .replace('app.asar', 'app.asar.unpacked')
      );
    });

    if (process.platform === 'darwin') {
      this.on('application:about', () => {
        Menu.sendActionToFirstResponder('orderFrontStandardAboutPanel:');
      });
      this.on('application:bring-all-windows-to-front', () => {
        Menu.sendActionToFirstResponder('arrangeInFront:');
      });
      this.on('application:hide', () => {
        Menu.sendActionToFirstResponder('hide:');
      });
      this.on('application:hide-other-applications', () => {
        Menu.sendActionToFirstResponder('hideOtherApplications:');
      });
      this.on('application:minimize', () => {
        Menu.sendActionToFirstResponder('performMiniaturize:');
      });
      this.on('application:unhide-all-applications', () => {
        Menu.sendActionToFirstResponder('unhideAllApplications:');
      });
      this.on('application:zoom', () => {
        Menu.sendActionToFirstResponder('zoom:');
      });
    } else {
      this.on('application:minimize', () => {
        const win = this.windowManager.focusedWindow();
        if (win) {
          win.minimize();
        }
      });
      this.on('application:zoom', () => {
        const win = this.windowManager.focusedWindow();
        if (win) {
          win.maximize();
        }
      });
    }

    app.on('window-all-closed', () => {
      this.windowManager.quitWinLinuxIfNoWindows();
    });

    // Called before the app tries to close any windows.
    app.on('before-quit', () => {
      // Allow the main window to be closed.
      this.quitting = true;
      // Destroy hot windows so that they can't block the app from quitting.
      // (Electron will wait for them to finish loading before quitting.)
      this.windowManager.cleanupBeforeAppQuit();
      this.systemTrayManager.destroyTray();
    });

    let pathsToOpen = [];
    let pathsTimeout = null;
    app.on('open-file', (event, pathToOpen) => {
      event.preventDefault();

      // if the user drags many files onto the app, this method is called
      // back-to-back several times. collect all the files and then fire.
      pathsToOpen.push(pathToOpen);
      clearTimeout(pathsTimeout);
      pathsTimeout = setTimeout(() => {
        this.openComposerWithFiles(pathsToOpen);
        pathsToOpen = [];
      }, 250);
    });

    app.on('open-url', (event, urlToOpen) => {
      this.openUrl(urlToOpen);
      event.preventDefault();
    });

    // System Tray
    onFromMailspringWindows(ipcMain, 'update-system-tray', (event, iconPath, unreadString) => {
      this.systemTrayManager.updateTraySettings(iconPath, unreadString);
    });

    onFromMailspringWindows(ipcMain, 'set-badge-value', (event, value) => {
      if (app.dock && app.dock.setBadge) {
        app.dock.setBadge(value);
      } else if (app.setBadgeCount) {
        app.setBadgeCount(value.length ? value.replace('+', '') / 1 : 0);
      }
    });

    const dockMenu = Menu.buildFromTemplate([
      {
        label: localized('Compose New Message'),
        click: () => global.application.emit('application:new-message'),
      },
    ]);

    app.whenReady().then(() => {
      if (process.platform === 'darwin') {
        app.dock.setMenu(dockMenu);
      }
    });

    onFromMailspringWindows(ipcMain, 'new-window', (event, options) => {
      const win = options.windowKey ? this.windowManager.get(options.windowKey) : null;
      if (win) {
        win.show();
        win.focus();
      } else {
        this.windowManager.newWindow(rendererWindowOptions(options));
      }
    });

    // Theme Error Handling

    let userResetTheme = false;

    handleFromMailspringWindows(ipcMain, 'get-system-accent-color', () => {
      return this.systemAccentWatcher ? this.systemAccentWatcher.getCurrent() : null;
    });

    // Synchronous because ThemeManager needs the value during its constructor to
    // pick the initial ui-light / ui-dark variant without a flash.
    onFromMailspringWindows(
      ipcMain,
      'get-system-dark-mode-sync',
      (event: Electron.IpcMainEvent) => {
        event.returnValue = this.systemAccentWatcher
          ? this.systemAccentWatcher.getDarkMode()
          : false;
      }
    );

    onFromMailspringWindows(ipcMain, 'encountered-theme-error', (event, { message, detail }) => {
      if (userResetTheme) return;

      // showMessageBoxSync blocks the main process indefinitely in headless
      // test environments (xvfb can't render or accept input), hanging the
      // spec suite until the 20 minute CI timeout.
      if (this.specMode) {
        console.error(`${message}\n${detail}`);
        return;
      }

      const buttonIndex = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: [localized('Reset Theme and Restart'), localized('Continue')],
        defaultId: 0,
        message,
        detail: `${detail}\n\n${localized(
          'Reset Theme and Restart restores the bundled automatic, light, and dark themes, clears cached theme styles, and restarts Mailspring. Your accounts, mail, plugins, and other settings are not changed.'
        )}`,
      });
      if (buttonIndex === 0) {
        userResetTheme = true;
        const cacheClearErrors = resetThemeForRecovery(this.config, this.configDirPath);
        for (const error of cacheClearErrors) {
          console.warn(`Theme was reset but a compiled LESS cache could not be removed: ${error}`);
        }
        // Relaunch rather than recompiling in place: the renderer still holds
        // the failed theme's cache open, and a clean start is the only way to
        // guarantee the bundled themes load without leftover state.
        app.relaunch();
        app.quit();
      }
    });

    onFromMailspringWindows(ipcMain, 'inline-style-parse', (event, { html, key }) => {
      const juice = require('juice');
      let out = null;
      try {
        out = juice(html);
      } catch (e) {
        // If the juicer fails (because of malformed CSS or some other
        // reason), then just return the body. We will still push it
        // through the HTML sanitizer which will strip the style tags. Oh
        // well.
        out = html;
      }
      // win = BrowserWindow.fromWebContents(event.sender)
      if (key) {
        event.sender.send('inline-styles-result', { html: out, key });
      } else {
        event.returnValue = out;
      }
    });

    // The sync engine's retry wait only counts awake time, so after sleep it can sit out
    // its full 120s interval before reconnecting unless the main window wakes it.
    const onSystemResumed = () => {
      const main = this.windowManager.get(WindowManager.MAIN_WINDOW);
      if (main) {
        main.sendMessage('system-resumed');
      }
    };
    powerMonitor.on('resume', onSystemResumed);
    powerMonitor.on('unlock-screen', onSystemResumed);

    app.on('activate', (event, hasVisibleWindows) => {
      if (!hasVisibleWindows) {
        this.ensureWindowsForTokenState();
      }
      event.preventDefault();
    });

    onFromMailspringWindows(
      ipcMain,
      'update-application-menu',
      (event, template, keystrokesByCommand) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          this.applicationMenu.update(win, template, keystrokesByCommand);
        }
      }
    );

    onFromMailspringWindows(ipcMain, 'command', (event, command, ...args) => {
      if (typeof command !== 'string' || !command.startsWith('application:')) return;
      this.emit(command, ...args);
    });

    onFromMailspringWindows(ipcMain, 'window-command', (event, command, ...args) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      win.emit(command, ...args);
    });

    const ALLOWED_WINDOW_METHODS = new Set([
      'setPosition',
      'center',
      'focus',
      'show',
      'hide',
      'maximize',
      'minimize',
      'setFullScreen',
    ]);
    const ALLOWED_WEBCONTENTS_METHODS = new Set(
      developerToolsAvailable() ? ['reload', 'openDevTools', 'toggleDevTools'] : ['reload']
    );
    const ALLOWED_DEVTOOLS_WEBCONTENTS_METHODS = new Set(['executeJavaScript']);

    onFromMailspringWindows(ipcMain, 'call-window-method', (event, method, ...args) => {
      if (!ALLOWED_WINDOW_METHODS.has(method)) {
        console.error(`Method ${method} is not permitted on BrowserWindow!`);
        return;
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      if (!win[method]) {
        console.error(`Method ${method} does not exist on BrowserWindow!`);
        return;
      }
      win[method](...args);
    });

    onFromMailspringWindows(
      ipcMain,
      'call-devtools-webcontents-method',
      (event, method, ...args) => {
        if (!ALLOWED_DEVTOOLS_WEBCONTENTS_METHODS.has(method)) {
          console.error(`Method ${method} is not permitted on devToolsWebContents!`);
          return;
        }
        // If devtools aren't open the `webContents::devToolsWebContents` will be null
        if (!event.sender.devToolsWebContents) {
          return;
        }
        if (!event.sender.devToolsWebContents[method]) {
          console.error(`Method ${method} does not exist on devToolsWebContents!`);
          return;
        }
        event.sender.devToolsWebContents[method](...args);
      }
    );

    onFromMailspringWindows(ipcMain, 'call-webcontents-method', (event, method, ...args) => {
      if (!ALLOWED_WEBCONTENTS_METHODS.has(method)) {
        console.error(`Method ${method} is not permitted on WebContents!`);
        return;
      }
      if (!event.sender[method]) {
        console.error(`Method ${method} does not exist on WebContents!`);
        return;
      }
      event.sender[method](...args);
    });

    onFromMailspringWindows(ipcMain, 'mailsync-bridge-rebroadcast-to-all', (event, ...args) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      this.windowManager.sendToAllWindows('mailsync-bridge-message', { except: win }, ...args);
    });

    onFromMailspringWindows(ipcMain, 'action-bridge-rebroadcast-to-all', (event, ...args) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      this.windowManager.sendToAllWindows('action-bridge-message', { except: win }, ...args);
    });

    onFromMailspringWindows(ipcMain, 'action-bridge-rebroadcast-to-default', (event, ...args) => {
      const mainWindow = this.windowManager.get(WindowManager.MAIN_WINDOW);
      if (!mainWindow || !mainWindow.browserWindow.webContents) {
        return;
      }
      if (BrowserWindow.fromWebContents(event.sender) === mainWindow.browserWindow) {
        return;
      }
      mainWindow.browserWindow.webContents.send('action-bridge-message', ...args);
    });

    onFromMailspringWindows(ipcMain, 'write-image-to-clipboard', (event, dataURL) => {
      // This can't be done from the renderer due to https://github.com/electron/electron/issues/8151
      const png = nativeImage.createFromDataURL(dataURL).toPNG();
      clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    });

    onFromMailspringWindows(ipcMain, 'write-text-to-selection-clipboard', (event, selectedText) => {
      if (clipboard.selection) clipboard.selection.writeText(selectedText);
    });

    onFromMailspringWindows(ipcMain, 'account-setup-successful', () => {
      this.windowManager.ensureWindow(WindowManager.MAIN_WINDOW, this._mainWindowOptions());
      const mainWindow = this.windowManager.get(WindowManager.MAIN_WINDOW);
      const onboarding = this.windowManager.get(WindowManager.ONBOARDING_WINDOW);
      if (onboarding) {
        if (mainWindow) {
          // Wait for the main window to finish loading before closing onboarding.
          // On Wayland, closing the onboarding window (which holds the activation
          // context) before the main window is visible causes show() to fail
          // silently because the activation context is lost.
          mainWindow.waitForLoad(() => {
            onboarding.close();
          });
        } else {
          onboarding.close();
        }
      }
    });

    onFromMailspringWindows(ipcMain, 'run-in-window', (event, params) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      this._sourceWindows[params.taskId] = sourceWindow;

      const targetWindowKey = {
        main: WindowManager.MAIN_WINDOW,
      }[params.window];
      if (!targetWindowKey) {
        throw new Error("We don't support running in that window");
      }

      const targetWindow = this.windowManager.get(targetWindowKey);
      if (!targetWindow || !targetWindow.browserWindow.webContents) {
        return;
      }
      targetWindow.browserWindow.webContents.send('run-in-window', params);
    });

    onFromMailspringWindows(ipcMain, 'remote-run-results', (event, params) => {
      const sourceWindow = this._sourceWindows[params.taskId];
      sourceWindow.webContents.send('remote-run-results', params);
      delete this._sourceWindows[params.taskId];
    });

    onFromMailspringWindows(
      ipcMain,
      'report-error',
      (event, params: { extra?: string; errorJSON?: string } = {}) => {
        try {
          const errorParams = JSON.parse(params.errorJSON || '{}');
          const extra = JSON.parse(params.extra || '{}');

          // LESS compilation errors from custom themes/plugins are already handled
          // by the theme error dialog (encountered-theme-error IPC handler). These
          // errors have no useful stack trace when reported to Sentry because
          // LessError objects don't carry a JS stack, so the Sentry report only
          // shows the IPC handler call site. Skip reporting them.
          if (
            errorParams &&
            typeof errorParams === 'object' &&
            typeof errorParams.line === 'number' &&
            Array.isArray(errorParams.extract) &&
            (errorParams.type === 'Parse' || errorParams.type === 'Syntax')
          ) {
            event.returnValue = true;
            return;
          }

          // Use new Error(message) to ensure the message is set as a proper Error property,
          // since Object.assign on an Error with no initial message may not propagate it
          // correctly to error reporting tools like Sentry/Raven.
          const message =
            errorParams && typeof errorParams === 'object' ? errorParams.message : undefined;
          const stack =
            errorParams && typeof errorParams === 'object' ? errorParams.stack : undefined;

          // Drop reports with neither a message nor a stack: they would surface
          // in Sentry as "Unknown error" with only this IPC handler frame,
          // which is unactionable. The renderer wraps inputs before sending so
          // this is defense-in-depth for any path that bypasses that wrapping.
          if (!message && !stack) {
            event.returnValue = true;
            return;
          }

          const err = new Error(message || undefined);
          if (stack) {
            err.stack = stack;
          }
          Object.assign(err, errorParams);
          global.errorLogger.reportError(err, extra);
        } catch (parseError) {
          console.error(parseError);
          global.errorLogger.reportError(parseError, {});
        }
        event.returnValue = true;
      }
    );

    onFromMailspringWindows(ipcMain, 'resize-window', (event, params) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      if (!sourceWindow) return;
      sourceWindow.setSize(params.width, params.height);
    });

    registerQuickpreviewIPCHandlers(ipcMain);
    registerNotificationIPCHandlers(ipcMain);
    registerViewSessionIPCHandlers(ipcMain);
    registerLocalAIIPCHandlers(ipcMain, {
      configDirPath: this.configDirPath,
      config: this.config,
      devMode: this.devMode,
    });
    registerGeminiDemoIpcHandlers(ipcMain, {
      isDemoMode: () => this.demoMode,
      isRealSelectedSummary: () => this.realSelectedSummary,
      isOfflineArchive: () => this.offlineArchive,
    });
  }

  sendCalendarSync(accountId?: string) {
    const main = this.windowManager.get(WindowManager.MAIN_WINDOW);
    if (main) {
      main.sendMessage('run-calendar-sync', accountId);
    }
  }

  // Public: Executes the given command.
  //
  // If it isn't handled globally, delegate to the currently focused window.
  // If there is no focused window (all the windows of the app are hidden),
  // fire the command to the main window. (This ensures that `application:`
  // commands, like Cmd-N work when no windows are visible.)
  //
  // command - The string representing the command.
  // args - The optional arguments to pass along.
  sendCommand(command, ...args) {
    if (this.emit(command, ...args)) {
      return;
    }
    const focusedWindow = this.windowManager.focusedWindow();
    if (focusedWindow) {
      focusedWindow.sendCommand(command, ...args);
    } else {
      if (this.sendCommandToFirstResponder(command)) {
        return;
      }

      const focusedBrowserWindow = BrowserWindow.getFocusedWindow();
      const mainWindow = this.windowManager.get(WindowManager.MAIN_WINDOW);
      if (focusedBrowserWindow) {
        switch (command) {
          case 'window:reload':
            focusedBrowserWindow.reload();
            break;
          case 'window:toggle-dev-tools':
            if (developerToolsAvailable()) {
              focusedBrowserWindow.webContents.toggleDevTools();
            }
            break;
          case 'window:close':
            focusedBrowserWindow.close();
            break;
          default:
            break;
        }
      } else if (mainWindow) {
        mainWindow.sendCommand(command, ...args);
      }
    }
  }

  // Public: Executes the given command on the given window.
  //
  // command - The string representing the command.
  // MailspringWindow - The {MailspringWindow} to send the command to.
  // args - The optional arguments to pass along.
  sendCommandToWindow = (command, MailspringWindow, ...args) => {
    console.log('sendCommandToWindow');
    console.log(command);
    if (this.emit(command, ...args)) {
      return;
    }
    if (MailspringWindow) {
      MailspringWindow.sendCommand(command, ...args);
    } else {
      this.sendCommandToFirstResponder(command);
    }
  };

  // Translates the command into OS X action and sends it to application's first
  // responder.
  sendCommandToFirstResponder = (command) => {
    if (process.platform !== 'darwin') {
      return false;
    }

    const commandsToActions = {
      'core:undo': 'undo:',
      'core:redo': 'redo:',
      'core:copy': 'copy:',
      'core:cut': 'cut:',
      'core:paste': 'paste:',
      'core:select-all': 'selectAll:',
    };

    if (commandsToActions[command]) {
      Menu.sendActionToFirstResponder(commandsToActions[command]);
      return true;
    }
    return false;
  };

  // Open a mailto:// url.
  //
  openUrl(urlToOpen) {
    if (!this._initialized) {
      this._pendingUrls.push(urlToOpen);
      return;
    }

    // url.parse throws on malformed input, and the URL comes from whatever app
    // launched us (MAILSPRING-CLIENT-M2).
    let parts: url.UrlWithParsedQuery;
    try {
      parts = url.parse(urlToOpen, true);
    } catch (err) {
      console.warn(`Ignoring URL - could not parse ${urlToOpen}: ${err.message}`);
      return;
    }
    const main = this.windowManager.get(WindowManager.MAIN_WINDOW);

    if (!main) {
      console.log(`Ignoring URL - main window is not available, user may not be authed.`);
      return;
    }

    if (parts.protocol === 'mailto:') {
      main.sendMessage('mailto', urlToOpen);
    } else if (parts.protocol === 'mailspring:') {
      // Handle notification action URLs from Windows toast notifications
      // These URLs are triggered when users click buttons on Windows toast notifications
      // since Windows toast XML with activationType="background" doesn't work reliably with Electron
      if (parts.host.startsWith('notification-')) {
        handleWindowsToastXMLProtocolAction(parts);
      } else if (parts.host === 'open-inbox') {
        main.show();
        main.focus();
      } else if (parts.host === 'open-preferences') {
        main.show();
        main.focus();
        main.sendMessage('open-preferences');
      } else if (parts.host === 'plugins') {
        main.sendMessage('changePluginStateFromUrl', urlToOpen);
      } else if (parts.host === 'install-view') {
        // A shared View's landing page (getmailspring.com/v/<shareId>) links here.
        main.show();
        main.focus();
        main.sendMessage('install-view', urlToOpen);
      } else {
        main.sendMessage('openThreadFromWeb', urlToOpen);
      }
    } else {
      console.log(`Ignoring unknown URL type: ${urlToOpen}`);
    }
  }

  openComposerWithFiles(pathsToOpen) {
    const main = this.windowManager.get(WindowManager.MAIN_WINDOW);
    if (main) {
      main.sendMessage('mailfiles', pathsToOpen);
    }
  }

  // Opens up a new {MailspringWindow} to run specs within.
  //
  // options -
  //   :exitWhenDone - A Boolean that, if true, will close the window upon
  //                   completion and exit the app with the status code of
  //                   1 if the specs failed and 0 if they passed.
  //   :showSpecsInWindow - A Boolean that, if true, will run specs in a
  //                        window
  //   :resourcePath - The path to include specs from.
  //   :specPath - The directory to load specs from.
  //   :safeMode - A Boolean that, if true, won't run specs from <config-dir>/packages
  //               and <config-dir>/dev/packages, defaults to false.
  //   :jUnitXmlPath - The path to output jUnit XML reports to, if desired.
  runSpecs(specWindowOptionsArg) {
    const specWindowOptions = specWindowOptionsArg;
    let { resourcePath } = specWindowOptions;
    if (resourcePath !== this.resourcePath && !fs.existsSync(resourcePath)) {
      resourcePath = this.resourcePath;
    }

    let bootstrapScript = null;
    try {
      bootstrapScript = require.resolve(
        path.resolve(this.resourcePath, 'spec', 'spec-runner', 'spec-bootstrap')
      );
    } catch (error) {
      bootstrapScript = require.resolve(
        path.resolve(__dirname, '..', '..', 'spec', 'spec-runner', 'spec-bootstrap')
      );
    }

    // Important: Use .mailspring-spec instead of .mailspring-mail to avoid overwriting the
    // user's real email config!
    const configDirPath = path.join(app.getPath('home'), '.mailspring-spec');

    specWindowOptions.resourcePath = resourcePath;
    specWindowOptions.configDirPath = configDirPath;
    specWindowOptions.bootstrapScript = bootstrapScript;

    this.windowManager.ensureWindow(WindowManager.SPEC_WINDOW, specWindowOptions);
  }
}
