#!/usr/bin/env node
'use strict';

/**
 * In-memory-file mock of gemini-demo-keychain command semantics for tests.
 * Not used by the Mac helper. Store is a JSON file; values are public sentinels.
 * Never logs stored blobs. MAILSPRING_DEMO_GEMINI_MOCK_STORE must be set.
 */
const fs = require('fs');

const MARKER = 'MAILSPRING_DEMO_GEMINI_NONSECRET_MARKER';
const DUMMY_BLOB = `paid=0\n${MARKER}\n`;
const STORE = process.env.MAILSPRING_DEMO_GEMINI_MOCK_STORE;
const PROBE = process.env.MAILSPRING_DEMO_GEMINI_MOCK_PROBE;

if (!STORE || !fs.existsSync(STORE)) {
  process.stderr.write('gemini-demo-keychain-mock: store missing\n');
  process.exit(1);
}

function parsedKey(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const nl = normalized.indexOf('\n');
  const first = (nl === -1 ? normalized : normalized.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : normalized.slice(nl + 1).trim();
  if (first !== 'paid=0' && first !== 'paid=1') {
    return null;
  }
  if (!rest) {
    return null;
  }
  return { paid: first.slice(5), key: rest };
}

function isDummy(text) {
  const p = parsedKey(text);
  return !!(p && p.paid === '0' && p.key === MARKER);
}

function readStore() {
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

function writeStore(s) {
  const failOnce = s.failOnce;
  const copy = Object.assign({}, s);
  delete copy.failOnce;
  if (failOnce) {
    copy.failOnce = failOnce;
  }
  fs.writeFileSync(STORE, JSON.stringify(copy), { encoding: 'utf8' });
}

function consumeFail(s, op) {
  if (s.failOnce === op) {
    delete s.failOnce;
    writeStore(s);
    process.stderr.write('gemini-demo-keychain-mock: injected failure (value not printed)\n');
    process.exit(2);
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

const cmd = process.argv[2];
if (PROBE) {
  const rec = {
    argv: process.argv.slice(2),
    hasKey: Object.keys(process.env).some(
      k => k.toLowerCase() === 'mailspring_demo_gemini_api_key'
    ),
    hasPaid: Object.keys(process.env).some(k => k.toLowerCase() === 'mailspring_demo_gemini_paid'),
    stdinChars: 0,
  };
  fs.writeFileSync(PROBE, JSON.stringify(rec));
}

const store = readStore();

function requireStdinBlob() {
  const text = readStdin();
  if (!parsedKey(text)) {
    process.stderr.write('gemini-demo-keychain-mock: expected paid=0|1 then a key\n');
    process.exit(1);
  }
  return text;
}

switch (cmd) {
  case 'save': {
    consumeFail(store, 'save');
    const blob = requireStdinBlob();
    if (store.real) {
      process.stderr.write('gemini-demo-keychain-mock: item exists; use replace\n');
      process.exit(4);
    }
    if (store.failOnce === 'save-duplicate') {
      store.failOnce = undefined;
      writeStore(store);
      process.stderr.write('gemini-demo-keychain-mock: item exists; use replace\n');
      process.exit(4);
    }
    store.real = blob;
    writeStore(store);
    process.stderr.write('gemini-demo-keychain-mock: saved (value not printed)\n');
    process.exit(0);
    break;
  }
  case 'replace': {
    consumeFail(store, 'replace');
    const blob = requireStdinBlob();
    store.real = blob;
    writeStore(store);
    process.stderr.write('gemini-demo-keychain-mock: replaced (value not printed)\n');
    process.exit(0);
    break;
  }
  case 'load': {
    if (!store.real) {
      process.exit(3);
    }
    process.stdout.write(store.real.endsWith('\n') ? store.real : `${store.real}\n`);
    process.exit(0);
    break;
  }
  case 'status': {
    process.stdout.write(store.real ? 'present=true\n' : 'present=false\n');
    process.exit(0);
    break;
  }
  case 'remove': {
    store.real = null;
    writeStore(store);
    process.stderr.write('gemini-demo-keychain-mock: removed\n');
    process.exit(0);
    break;
  }
  case 'dummy-save': {
    consumeFail(store, 'dummy-save');
    if (store.raceAbsentWhileDummyPresent) {
      store.raceAbsentWhileDummyPresent = false;
      writeStore(store);
      if (store.dummy && !isDummy(store.dummy)) {
        process.stderr.write(
          'gemini-demo-keychain-mock: dummy-save refused: dummy-namespace item is not the public marker\n'
        );
        process.exit(4);
      }
    }
    if (!store.dummy) {
      store.dummy = DUMMY_BLOB;
      writeStore(store);
      process.stderr.write('gemini-demo-keychain-mock: dummy saved (marker not printed)\n');
      process.exit(0);
    }
    if (!isDummy(store.dummy)) {
      process.stderr.write(
        'gemini-demo-keychain-mock: dummy-save refused: dummy-namespace item is not the public marker\n'
      );
      process.exit(4);
    }
    process.stderr.write('gemini-demo-keychain-mock: dummy already present (marker not printed)\n');
    process.exit(0);
    break;
  }
  case 'dummy-load': {
    if (!store.dummy) {
      process.exit(3);
    }
    process.stdout.write(store.dummy.endsWith('\n') ? store.dummy : `${store.dummy}\n`);
    process.exit(0);
    break;
  }
  case 'dummy-status': {
    process.stdout.write(store.dummy ? 'present=true\n' : 'present=false\n');
    process.exit(0);
    break;
  }
  case 'dummy-remove': {
    consumeFail(store, 'dummy-remove');
    if (!store.dummy) {
      process.stderr.write('gemini-demo-keychain-mock: dummy absent\n');
      process.exit(0);
    }
    if (!isDummy(store.dummy)) {
      process.stderr.write(
        'gemini-demo-keychain-mock: dummy-remove refused: dummy-namespace item is not the public marker\n'
      );
      process.exit(4);
    }
    if (store.raceDummySwap) {
      store.dummy = store.raceDummySwap;
      store.raceDummySwap = undefined;
      writeStore(store);
      process.stderr.write(
        'gemini-demo-keychain-mock: dummy-remove refused: dummy-namespace item is not the public marker\n'
      );
      process.exit(4);
    }
    store.dummy = null;
    writeStore(store);
    process.stderr.write('gemini-demo-keychain-mock: dummy removed\n');
    process.exit(0);
    break;
  }
  default:
    process.stderr.write('gemini-demo-keychain-mock: usage\n');
    process.exit(1);
}
