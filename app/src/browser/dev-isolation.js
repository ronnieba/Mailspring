/**
 * Pure isolation identity for dev/demo/spec vs production.
 * No Electron APIs — required from main.js early and unit-tested from Node.
 *
 * Production (no flags): app name "Mailspring", config dir "Mailspring".
 * --dev: "Mailspring-dev" so Keychain/Crashpad/userData never share the
 * production "Mailspring Safe Storage" item or Mailspring/Crashpad path.
 * --demo (implies --dev): "Mailspring-demo", mock keychain, no mailsync.
 */
const path = require('path');

/**
 * Raw argv flags without Optimist. `--demo-delay-ms` / `--demo-capture` are
 * not `--demo`. Used before CLI parse so a declareOptions throw cannot leave
 * Chromium helpers on the production userData path (native 63b7210).
 */
function startupFlagsFromArgv(argv) {
  const list = argv || [];
  const hasShort = (short, long) =>
    list.some(arg => arg === `-${short}` || arg === `--${long}` || arg.startsWith(`--${long}=`));

  let configDirPath = null;
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === '--config-dir-path' || arg === '-c') {
      const next = list[i + 1];
      configDirPath = next && !String(next).startsWith('-') ? next : null;
    } else if (arg.startsWith('--config-dir-path=')) {
      configDirPath = arg.slice('--config-dir-path='.length) || null;
    }
  }

  const demoMode = list.some(arg => arg === '--demo' || arg.startsWith('--demo='));
  const realSelectedSummary = list.some(
    arg => arg === '--real-selected-summary' || arg.startsWith('--real-selected-summary=')
  );
  // `--offline-archive-path` is not `--offline-archive` (same class as --demo-delay-ms).
  const offlineArchive = list.some(
    arg => arg === '--offline-archive' || arg.startsWith('--offline-archive=')
  );
  const specMode = hasShort('t', 'test');
  const explicitDev = hasShort('d', 'dev');
  return {
    demoMode,
    realSelectedSummary,
    offlineArchive,
    specMode,
    // Force isolated identities even if `--dev` was omitted with these flags.
    // Never treat this as production Mailspring / official app profile.
    devMode: explicitDev || demoMode || specMode || realSelectedSummary || offlineArchive,
    configDirPath,
  };
}

/**
 * Isolation identity from argv + whether this is an unpackaged developer build.
 * Packaged production ignores --demo/--dev/--test (same as parseCommandLine).
 */
function identityFromArgv(argv, { developerBuild = false } = {}) {
  const flags = startupFlagsFromArgv(argv);
  const demoMode = !!developerBuild && flags.demoMode;
  const specMode = !!developerBuild && flags.specMode;
  // --demo wins: synthetic Mailspring-demo, not a mailbox profile.
  const offlineArchive = !!developerBuild && flags.offlineArchive && !demoMode;
  // Live Yahoo selected-summary is not used when offline-archive is set.
  const realSelectedSummary =
    !!developerBuild && flags.realSelectedSummary && !demoMode && !offlineArchive;
  const devMode =
    !!developerBuild &&
    (flags.devMode || specMode || demoMode || realSelectedSummary || offlineArchive);
  return isolationIdentity({ devMode, specMode, demoMode, offlineArchive });
}

function isolationIdentity({
  devMode = false,
  specMode = false,
  demoMode = false,
  offlineArchive = false,
} = {}) {
  if (specMode) {
    return {
      appName: 'Mailspring-spec',
      configDirName: 'Mailspring-spec',
      useMockKeychain: true,
      skipProtocolRegistration: true,
      skipSingleInstanceLock: true,
      skipMailsync: true,
      skipDefaultClient: true,
      skipAutoUpdate: true,
    };
  }
  if (demoMode) {
    return {
      appName: 'Mailspring-demo',
      configDirName: 'Mailspring-demo',
      useMockKeychain: true,
      skipProtocolRegistration: true,
      skipSingleInstanceLock: true,
      skipMailsync: true,
      skipDefaultClient: true,
      skipAutoUpdate: true,
    };
  }
  if (offlineArchive) {
    return {
      appName: 'Mailspring-offline',
      configDirName: 'Mailspring-offline',
      useMockKeychain: true,
      skipProtocolRegistration: true,
      skipSingleInstanceLock: true,
      skipMailsync: true,
      skipDefaultClient: true,
      skipAutoUpdate: true,
    };
  }
  if (devMode) {
    return {
      appName: 'Mailspring-dev',
      configDirName: 'Mailspring-dev',
      useMockKeychain: false,
      skipProtocolRegistration: true,
      skipSingleInstanceLock: true,
      skipMailsync: false,
      skipDefaultClient: true,
      skipAutoUpdate: false,
    };
  }
  return {
    appName: 'Mailspring',
    configDirName: 'Mailspring',
    useMockKeychain: false,
    skipProtocolRegistration: false,
    skipSingleInstanceLock: false,
    skipMailsync: false,
    skipDefaultClient: false,
    skipAutoUpdate: false,
  };
}

function isolatedPaths(appDataPath, identity, configDirPathOverride) {
  const configDirPath = configDirPathOverride || path.join(appDataPath, identity.configDirName);
  return {
    configDirPath,
    userData: configDirPath,
    sessionData: configDirPath,
    crashDumps: path.join(configDirPath, 'Crashpad'),
    logs: path.join(configDirPath, 'logs'),
  };
}

function productionKeychainItemName() {
  return 'Mailspring Safe Storage';
}

function keychainItemNameForApp(appName) {
  return `${appName} Safe Storage`;
}

module.exports = {
  isolationIdentity,
  isolatedPaths,
  startupFlagsFromArgv,
  identityFromArgv,
  productionKeychainItemName,
  keychainItemNameForApp,
};
