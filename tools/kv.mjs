// Read-only access to the dashboard's Upstash database for local ad-hoc
// queries. Credentials come from .env.local in the project root
// (gitignored):
//
//   KV_REST_API_URL=https://...upstash.io
//   KV_REST_API_READ_ONLY_TOKEN=...
//
// Only the read-only token is ever loaded, so nothing run through this
// file can modify or delete data — Upstash rejects writes server-side.
//
// CLI (run from the project root):
//   node tools/kv.mjs keys "orders:v2:*"     list keys matching a pattern
//   node tools/kv.mjs get products           print one value as JSON
//
// Module:
//   import { kvGet, kvMGet, kvKeys } from './tools/kv.mjs';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const env = {};
  let text;
  try {
    text = readFileSync(path.join(ROOT, '.env.local'), 'utf-8');
  } catch {
    throw new Error('.env.local not found in the project root');
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_READ_ONLY_TOKEN']) {
    if (!env[k]) throw new Error(`${k} is missing or empty in .env.local`);
  }
  // Errors must never echo either value — the URL check runs before any
  // fetch so a misplaced token can't surface in a parse error.
  if (!/^https:\/\/[^\s]+$/.test(env.KV_REST_API_URL)) {
    throw new Error('KV_REST_API_URL in .env.local is not an https:// URL (is a token on that line?)');
  }
  return { url: env.KV_REST_API_URL.replace(/\/+$/, ''), token: env.KV_REST_API_READ_ONLY_TOKEN };
}

let _creds;
async function command(args) {
  _creds = _creds || loadEnv();
  const res = await fetch(_creds.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${_creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Upstash ${args[0]} failed (${res.status}): ${body.error || 'unknown error'}`);
  return body.result;
}

// @vercel/kv JSON-encodes values on write; decode on the way out.
function decode(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// credential:* keys hold the app's stored API secrets. Business-data
// queries never need them, so reads are refused outright.
function assertReadable(key) {
  if (/^credential:/i.test(key)) throw new Error(`Refusing to read ${key}: credential keys hold secrets`);
}

export async function kvGet(key) {
  assertReadable(key);
  return decode(await command(['GET', key]));
}

export async function kvMGet(keys) {
  if (keys.length === 0) return [];
  keys.forEach(assertReadable);
  return (await command(['MGET', ...keys])).map(decode);
}

export async function kvKeys(pattern = '*') {
  const out = [];
  let cursor = '0';
  do {
    const [next, batch] = await command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000']);
    out.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'keys') console.log((await kvKeys(arg || '*')).join('\n'));
    else if (cmd === 'get' && arg) console.log(JSON.stringify(await kvGet(arg), null, 2));
    else console.error('Usage: node tools/kv.mjs keys [pattern] | get <key>');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
