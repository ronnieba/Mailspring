/**
 * nspell was rejected after native 7c346435: constructor eager-expands Hspell
 * PFX into a JS hash (nspell lib/util/add.js + apply.js). Test 5 stalled 194s
 * at 99% CPU / 1.31GiB RSS. Runtime is Hunspell WASM in a child process.
 * Never silently mutates text.
 */
export * from './offline-spell-engine';
