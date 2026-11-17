/**
 * Windows Credential Manager plumbing for Gemini in the offline experiment.
 * Uses throwaway dummy reader scripts only; the real Credential Manager item
 * is never read by this test.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const secret = require('../../src/browser/gemini-demo-secret');
import {
  windowsGeminiMissingReason,
  storeGeminiKeyCommand,
} from '../../src/browser/gemini-demo-ipc';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

function dummyScript(dir: string, name: string, body: string) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `param([string]$Target, [string]$UserName)\r\n${body}\r\n`, 'utf8');
  return p;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('skipped (Windows only)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cred-test-'));
  try {
    const missing = dummyScript(dir, 'missing.ps1', 'exit 44');
    const good = dummyScript(
      dir,
      'good.ps1',
      'if ($Target -ne \'Mailspring-offline Gemini API|gemini-api-key\') { exit 1 }\r\n[Console]::Out.Write("paid=1`nDUMMY-NOT-A-KEY")\r\nexit 0'
    );
    const unpaid = dummyScript(
      dir,
      'unpaid.ps1',
      '[Console]::Out.Write("paid=0`nDUMMY-NOT-A-KEY")'
    );
    const garbage = dummyScript(dir, 'garbage.ps1', '[Console]::Out.Write("not a blob")');

    secret.resetGeminiDemoCredentialsForTests();
    let r = await secret.loadGeminiFromWindowsCredentialManager({
      scriptPath: missing,
      force: true,
    });
    check('missing item -> not-found', !r.ok && r.reason === 'not-found');
    check('no key captured when missing', secret.getCapturedGeminiDemoCredentials().key === '');
    const msg = windowsGeminiMissingReason('not-found', false);
    check('missing message names the store script', msg.includes('store-gemini-api-key.ps1'));
    check('missing message is Hebrew-first', /[\u0590-\u05FF]/.test(msg.slice(0, 20)));
    check('command uses -File and the script', storeGeminiKeyCommand().includes('-File "'));

    r = await secret.loadGeminiFromWindowsCredentialManager({ scriptPath: missing });
    check('retry is throttled', !r.ok);

    secret.resetGeminiDemoCredentialsForTests();
    r = await secret.loadGeminiFromWindowsCredentialManager({ scriptPath: garbage, force: true });
    check('bad blob -> format', !r.ok && r.reason === 'format');

    secret.resetGeminiDemoCredentialsForTests();
    r = await secret.loadGeminiFromWindowsCredentialManager({ scriptPath: unpaid, force: true });
    const c0 = secret.getCapturedGeminiDemoCredentials();
    check('unpaid blob loads but paid=false', r.ok && c0.paidAcknowledged === false);
    check(
      'unpaid message asks to re-run',
      windowsGeminiMissingReason('loaded', true).includes('y')
    );

    secret.resetGeminiDemoCredentialsForTests();
    r = await secret.loadGeminiFromWindowsCredentialManager({ scriptPath: good, force: true });
    const c = secret.getCapturedGeminiDemoCredentials();
    check('good blob -> loaded', r.ok && r.reason === 'loaded');
    check('key held in memory', c.key === 'DUMMY-NOT-A-KEY' && c.paidAcknowledged === true);
    check('capture source', secret.getGeminiDemoCaptureSource() === 'windows-credential-manager');
    r = await secret.loadGeminiFromWindowsCredentialManager({ scriptPath: missing, force: true });
    check('cached after success (no re-read)', r.ok && r.reason === 'cached');
  } finally {
    secret.resetGeminiDemoCredentialsForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.log('ERROR', e && e.message);
    process.exit(1);
  });
