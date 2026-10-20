// Loads api/adspend.js outside Vercel.
//
// Two imports do not resolve here. The storage adapter (../lib/kv.js) pulls in
// packages that are not installed locally, and
// ./adcampaigns.js is relative to api/ rather than to this directory. Both are
// rewritten in a copy written beside this file; the copies are gitignored.
//
// Pass a kv stub when the test exercises anything that stores. Without one, kv
// is null and touching it throws, which is the honest outcome for a suite that
// should be testing pure functions.
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

// An in-memory stand-in for the storage adapter. Only get and set are used.
export function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null; },
    async set(k, v) { store.set(k, JSON.parse(JSON.stringify(v))); return 'OK'; }
  };
}

const stubKv = (src) =>
  // The stub is reached through globalThis so the test can hand one in.
  src.replace(/^import \{ kv \} from '\.\.\/lib\/kv\.js';$/m,
              'const kv = globalThis.__TEST_KV__ || null;');

export async function loadAdspend(tag, kv) {
  // adcampaigns.js is copied and stubbed too, rather than having its imports
  // faked. adspend.js borrows real logic from it, the brand-prefix table among
  // it, and a hand-written stand-in here could drift from the real table
  // without any test noticing.
  const campaignsFile = path.join(here, `.${tag}_adcampaigns_testable.mjs`);
  fs.writeFileSync(campaignsFile,
    stubKv(fs.readFileSync(path.join(here, '..', 'api', 'adcampaigns.js'), 'utf8')));

  const src = stubKv(fs.readFileSync(path.join(here, '..', 'api', 'adspend.js'), 'utf8'))
    .replace(/^import \{([^}]*)\} from '\.\/adcampaigns\.js';$/m,
             `import {$1} from './${path.basename(campaignsFile)}';`);

  const f = path.join(here, `.${tag}_testable.mjs`);
  fs.writeFileSync(f, src);
  globalThis.__TEST_KV__ = kv || null;
  const M = await import(pathToFileURL(f).href);
  return {
    M,
    cleanup: () => {
      for (const x of [f, campaignsFile]) {
        try { fs.unlinkSync(x); } catch { /* already gone */ }
      }
    }
  };
}

// Loads api/adcampaigns.js on its own, for suites that drive its write paths
// directly. Its only unresolvable import is the storage adapter.
export async function loadAdcampaigns(tag, kv) {
  const f = path.join(here, `.${tag}_testable.mjs`);
  fs.writeFileSync(f, stubKv(fs.readFileSync(path.join(here, '..', 'api', 'adcampaigns.js'), 'utf8')));
  globalThis.__TEST_KV__ = kv || null;
  const M = await import(pathToFileURL(f).href);
  return { M, cleanup: () => { try { fs.unlinkSync(f); } catch { /* already gone */ } } };
}
