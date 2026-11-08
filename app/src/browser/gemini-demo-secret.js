'use strict';

/**
 * Main-process Gemini DEMO credential containment.
 *
 * Native e1ec474c (Mac, renderer PID 70413, --type=renderer): a NONSECRET
 * marker set on MAILSPRING_DEMO_GEMINI_API_KEY in the launch environment was
 * present in the renderer environ. Chromium copies the browser process
 * environment into renderer/gpu/utility and crashpad at spawn. Leaving the
 * value in process.env therefore fails a main-only credential boundary.
 *
 * Capture into this module's memory and unset the named variables from
 * process.env before `require('electron')` and before any BrowserWindow.
 * Subsequent child spawns inherit the stripped environ. The host reads the
 * captured value; IPC/status/logs/UI never receive it.
 */
const KEY_ENV = 'MAILSPRING_DEMO_GEMINI_API_KEY';
const PAID_ENV = 'MAILSPRING_DEMO_GEMINI_PAID';

let capturedKey = '';
let capturedPaid = false;
let captured = false;

function isCredentialEnvName(name) {
  if (typeof name !== 'string') {
    return false;
  }
  const lower = name.toLowerCase();
  return lower === KEY_ENV.toLowerCase() || lower === PAID_ENV.toLowerCase();
}

function envValue(env, name) {
  if (!env) {
    return '';
  }
  if (typeof env[name] === 'string') {
    return env[name];
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower && typeof env[key] === 'string') {
      return env[key];
    }
  }
  return '';
}

function stripGeminiDemoCredentialNames(env) {
  if (!env) {
    return env;
  }
  for (const name of Object.keys(env)) {
    if (isCredentialEnvName(name)) {
      delete env[name];
    }
  }
  return env;
}

function getCapturedGeminiDemoCredentials() {
  return {
    key: capturedKey,
    paidAcknowledged: capturedPaid,
  };
}

function captureAndStripGeminiDemoCredentials(env) {
  const target = env || process.env;
  if (!captured) {
    const raw = envValue(target, KEY_ENV);
    capturedKey = typeof raw === 'string' ? raw.trim() : '';
    capturedPaid = envValue(target, PAID_ENV) === '1';
    captured = true;
    if (capturedKey) {
      console.log(
        '[Gemini DEMO] provider credential captured in main process memory; stripped from process environment (value not logged)'
      );
    }
  }
  stripGeminiDemoCredentialNames(target);
  if (target !== process.env) {
    stripGeminiDemoCredentialNames(process.env);
  }
  return getCapturedGeminiDemoCredentials();
}

function sanitizeSpawnEnv(env) {
  return stripGeminiDemoCredentialNames(Object.assign(Object.create(null), env || {}));
}

function resetGeminiDemoCredentialsForTests() {
  capturedKey = '';
  capturedPaid = false;
  captured = false;
  stripGeminiDemoCredentialNames(process.env);
}

module.exports = {
  GEMINI_DEMO_KEY_ENV: KEY_ENV,
  GEMINI_DEMO_PAID_ENV: PAID_ENV,
  captureAndStripGeminiDemoCredentials,
  getCapturedGeminiDemoCredentials,
  sanitizeSpawnEnv,
  stripGeminiDemoCredentialNames,
  resetGeminiDemoCredentialsForTests,
};
