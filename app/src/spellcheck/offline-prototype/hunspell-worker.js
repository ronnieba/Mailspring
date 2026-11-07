'use strict';
/**
 * Isolated Hunspell WASM child. Parent may SIGTERM this process on timeout.
 * Do not require nspell. dictionary-he aff/dic are AGPL-3.0 — never commit them.
 */
const fs = require('fs');
const path = require('path');

const sidecarModules = path.join(__dirname, 'node_modules');
if (!module.paths.includes(sidecarModules)) {
  module.paths.unshift(sidecarModules);
}

let factory = null;
let en = null;
let he = null;

function send(msg) {
  if (typeof process.send === 'function') {
    process.send(msg);
  }
}

function inst(lang) {
  return lang === 'he' ? he : en;
}

async function loadHunspell(payload) {
  const hunspellAsm = require(path.join(sidecarModules, 'hunspell-asm'));
  const loadModule = hunspellAsm.loadModule;
  if (typeof loadModule !== 'function') {
    throw new Error('hunspell-asm.loadModule missing');
  }
  factory = await loadModule({ timeout: 5000 });
  if (payload.enAff && payload.enDic) {
    const aff = factory.mountBuffer(fs.readFileSync(payload.enAff), 'en.aff');
    const dic = factory.mountBuffer(fs.readFileSync(payload.enDic), 'en.dic');
    en = factory.create(aff, dic);
  }
  if (payload.heAff && payload.heDic) {
    const aff = factory.mountBuffer(fs.readFileSync(payload.heAff), 'he.aff');
    const dic = factory.mountBuffer(fs.readFileSync(payload.heDic), 'he.dic');
    he = factory.create(aff, dic);
  }
  return { english: !!en, hebrew: !!he };
}

process.on('message', async (msg) => {
  const id = msg && msg.id;
  const t0 = Date.now();
  try {
    if (!msg || !msg.op) {
      throw new Error('bad message');
    }
    if (msg.op === 'ping') {
      send({ id, ok: true, result: 'pong', ms: Date.now() - t0 });
      return;
    }
    if (msg.op === 'load') {
      const result = await loadHunspell(msg);
      send({ id, ok: true, result, ms: Date.now() - t0 });
      return;
    }
    if (msg.op === 'correct') {
      const i = inst(msg.lang);
      if (!i) {
        throw new Error('dictionary not loaded: ' + msg.lang);
      }
      send({ id, ok: true, result: !!i.spell(msg.word), ms: Date.now() - t0 });
      return;
    }
    if (msg.op === 'correctMany') {
      const out = [];
      for (const item of msg.items || []) {
        const i = inst(item.lang);
        out.push({
          word: item.word,
          lang: item.lang,
          correct: i ? !!i.spell(item.word) : null,
        });
      }
      send({ id, ok: true, result: out, ms: Date.now() - t0 });
      return;
    }
    if (msg.op === 'suggest') {
      const i = inst(msg.lang);
      if (!i) {
        throw new Error('dictionary not loaded: ' + msg.lang);
      }
      let list = i.suggest(msg.word) || [];
      const limit = msg.limit || 5;
      if (list.length > limit) {
        list = list.slice(0, limit);
      }
      send({ id, ok: true, result: list, ms: Date.now() - t0 });
      return;
    }
    if (msg.op === 'dispose') {
      if (en) {
        en.dispose();
      }
      if (he) {
        he.dispose();
      }
      en = he = factory = null;
      send({ id, ok: true, result: true, ms: Date.now() - t0 });
      return;
    }
    throw new Error('unknown op ' + msg.op);
  } catch (err) {
    send({
      id,
      ok: false,
      error: String(err && err.message ? err.message : err),
      ms: Date.now() - t0,
    });
  }
});

send({ op: 'ready' });
