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

function isolationIdentity({ devMode = false, specMode = false, demoMode = false } = {}) {
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
  productionKeychainItemName,
  keychainItemNameForApp,
};
