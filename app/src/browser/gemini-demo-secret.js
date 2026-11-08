'use strict';

/**
 * Main-process Gemini DEMO credential containment.
 *
 * Native e1ec474c (Mac, renderer PID 70413): a NONSECRET marker on
 * MAILSPRING_DEMO_GEMINI_API_KEY in the launch environment was inherited by
 * --type=renderer. Capture-and-strip of process.env before require('electron')
 * fixed Chromium helpers (native 33d7f263: 15 child absences).
 *
 * Native 33d7f263 (main PID 71003, Node launcher PID 71001): macOS `ps eww`
 * still showed the original exec-time environ. JS delete cannot rewrite that
 * snapshot, and the Node `./node_modules/.bin/electron` launcher never runs
 * this module. Do not treat process.env deletion as OS launch-env secrecy.
 *
 * Supported delivery: MAILSPRING_DEMO_GEMINI_KEY_FILE points at a 0600 file
 * (`paid=0|1` newline key). Main reads it into this module's memory and
 * unlinks the file. Launch-env KEY/PAID names are ignored, never captured.
 * scripts/start-demo-gemini.sh execs the Electron binary with those names
 * unset so main and the launcher are not started with the secret in environ.
 *
 * Does not claim OS memory erasure, disk wipe, or that unlink is a secrecy
 * guarantee. Host reads the captured value; IPC/status/logs/UI never receive it.
 */
const fs = require('fs');
const path = require('path');

const KEY_ENV = 'MAILSPRING_DEMO_GEMINI_API_KEY';
const PAID_ENV = 'MAILSPRING_DEMO_GEMINI_PAID';
const KEY_FILE_ENV = 'MAILSPRING_DEMO_GEMINI_KEY_FILE';

let capturedKey = '';
let capturedPaid = false;
let captured = false;
let captureSource = 'none';

function isStripEnvName(name) {
  if (typeof name !== 'string') {
    return false;
  }
  const lower = name.toLowerCase();
  return (
    lower === KEY_ENV.toLowerCase() ||
    lower === PAID_ENV.toLowerCase() ||
    lower === KEY_FILE_ENV.toLowerCase()
  );
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

function envHasName(env, name) {
  if (!env) {
    return false;
  }
  const lower = name.toLowerCase();
  return Object.keys(env).some(key => key.toLowerCase() === lower);
}

function stripGeminiDemoCredentialNames(env) {
  if (!env) {
    return env;
  }
  for (const name of Object.keys(env)) {
    if (isStripEnvName(name)) {
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

function getGeminiDemoCaptureSource() {
  return captureSource;
}

function formatGeminiDemoStatusLog(status) {
  const s = status || {};
  return (
    '[Gemini DEMO] status keyPresent=' +
    (s.keyPresent ? 'true' : 'false') +
    ' paidAcknowledged=' +
    (s.paidAcknowledged ? 'true' : 'false') +
    ' configured=' +
    (s.configured ? 'true' : 'false') +
    ' billingProven=false (credential value not logged)'
  );
}

function formatGeminiDemoCaptureLog() {
  return (
    '[Gemini DEMO] capture source=' +
    captureSource +
    ' keyPresent=' +
    (capturedKey ? 'true' : 'false') +
    ' paidAcknowledged=' +
    (capturedPaid ? 'true' : 'false') +
    ' (credential value not logged)'
  );
}

function parseCredentialFile(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const nl = normalized.indexOf('\n');
  const first = (nl === -1 ? normalized : normalized.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : normalized.slice(nl + 1);
  const paidMatch = /^paid=([01])$/.exec(first);
  if (!paidMatch) {
    return { ok: false };
  }
  return {
    ok: true,
    key: rest.trim(),
    paidAcknowledged: paidMatch[1] === '1',
  };
}

function readCredentialFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false };
  }
  if (!path.isAbsolute(filePath)) {
    console.log('[Gemini DEMO] KEY_FILE refused: path must be absolute');
    return { ok: false };
  }
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      console.log(
        '[Gemini DEMO] KEY_FILE refused: group/other readable (0600 required). Capture skipped.'
      );
      return { ok: false };
    }
    const parsed = parseCredentialFile(fs.readFileSync(fd, 'utf8'));
    if (!parsed.ok) {
      console.log('[Gemini DEMO] KEY_FILE refused: expected first line paid=0 or paid=1');
      return { ok: false };
    }
    return parsed;
  } catch (err) {
    console.log('[Gemini DEMO] KEY_FILE unreadable. Capture skipped.');
    return { ok: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        // fd already closed
      }
    }
  }
}

function captureAndStripGeminiDemoCredentials(env) {
  const target = env || process.env;
  if (!captured) {
    const launchSecretPresent = envHasName(target, KEY_ENV) || envHasName(target, PAID_ENV);
    if (launchSecretPresent) {
      console.log(
        '[Gemini DEMO] containment: MAILSPRING_DEMO_GEMINI_API_KEY / MAILSPRING_DEMO_GEMINI_PAID present in OS launch environment and ignored. macOS ps eww records exec-time environ; JS delete cannot rewrite it (native 33d7f263). Use MAILSPRING_DEMO_GEMINI_KEY_FILE.'
      );
    }

    const filePath = envValue(target, KEY_FILE_ENV).trim();
    const fromFile = readCredentialFile(filePath);
    if (fromFile.ok) {
      capturedKey = fromFile.key;
      capturedPaid = fromFile.paidAcknowledged;
      captureSource = 'key-file';
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.log('[Gemini DEMO] KEY_FILE unlink failed (not a secrecy guarantee)');
      }
    } else {
      capturedKey = '';
      capturedPaid = false;
      captureSource = launchSecretPresent ? 'launch-env-ignored' : 'none';
    }
    captured = true;
    console.log(formatGeminiDemoCaptureLog());
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
  captureSource = 'none';
  stripGeminiDemoCredentialNames(process.env);
}

module.exports = {
  GEMINI_DEMO_KEY_ENV: KEY_ENV,
  GEMINI_DEMO_PAID_ENV: PAID_ENV,
  GEMINI_DEMO_KEY_FILE_ENV: KEY_FILE_ENV,
  captureAndStripGeminiDemoCredentials,
  getCapturedGeminiDemoCredentials,
  getGeminiDemoCaptureSource,
  formatGeminiDemoStatusLog,
  sanitizeSpawnEnv,
  stripGeminiDemoCredentialNames,
  resetGeminiDemoCredentialsForTests,
};
