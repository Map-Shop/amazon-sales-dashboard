// Read-only access to the dashboard's Neon database for local ad-hoc
// queries. The connection string comes from .env.local in the project root
// (gitignored):
//
//   NEON_READONLY_URL=postgresql://claude_readonly:...@.../neondb?sslmode=require
//
// The role must be read-only: before the first query this file checks the
// role's privileges on the kv table and refuses to run if it could write.
// Reads of credential:* keys are refused. Values decode with the app's own
// rules (lib/kv.js), so they come back exactly as the API sees them.
//
// CLI (run from the project root):
//   node tools/kv.mjs keys                   list every key
//   node tools/kv.mjs keys "orders:v2:*"     list keys matching a pattern
//   node tools/kv.mjs get products           print one value as JSON
//
// Module:
//   import { kvGet, kvGetRaw, kvMGet, kvKeys } from './tools/kv.mjs';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { neon } from '@neondatabase/serverless';
import { decodeValue } from '../lib/kv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadUrl() {
  let text;
  try {
    text = readFileSync(path.join(ROOT, '.env.local'), 'utf-8');
  } catch {
    throw new Error('.env.local not found in the project root');
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*NEON_READONLY_URL\s*=\s*(.*?)\s*$/);
    if (m && m[1]) {
      const url = m[1].replace(/^(['"])(.*)\1$/, '$2');
      // Validated before use so a malformed value can't surface in an error.
      if (!/^postgres(ql)?:\/\/[^\s]+$/.test(url)) {
        throw new Error('NEON_READONLY_URL in .env.local is not a postgres:// connection string');
      }
      return url;
    }
  }
  throw new Error('NEON_READONLY_URL is missing or empty in .env.local');
}

let _sql;
async function sql() {
  if (_sql) return _sql;
  const s = neon(loadUrl());
  const [p] = await s.query(`SELECT
    has_table_privilege('kv', 'INSERT') OR has_table_privilege('kv', 'UPDATE')
      OR has_table_privilege('kv', 'DELETE') OR has_table_privilege('kv', 'TRUNCATE') AS can_write`);
  if (p.can_write) throw new Error('NEON_READONLY_URL uses a role that can write; use the read-only role');
  _sql = s;
  return _sql;
}

// credential:* keys hold the app's stored API secrets. Business-data
// queries never need them, so reads are refused outright.
function assertReadable(key) {
  if (/^credential:/i.test(key)) throw new Error(`Refusing to read ${key}: credential keys hold secrets`);
}

// The stored text exactly as the database holds it, undecoded.
export async function kvGetRaw(key) {
  assertReadable(key);
  const rows = await (await sql()).query('SELECT value FROM kv WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

export async function kvGet(key) {
  const raw = await kvGetRaw(key);
  return raw === null ? null : decodeValue(raw);
}

export async function kvMGet(keys) {
  if (keys.length === 0) return [];
  keys.forEach(assertReadable);
  const rows = await (await sql()).query('SELECT key, value FROM kv WHERE key = ANY($1)', [keys]);
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  return keys.map(k => (byKey.has(k) ? decodeValue(byKey.get(k)) : null));
}

// Glob patterns as Redis SCAN takes them: * any run, ? one character.
export async function kvKeys(pattern = '*') {
  const like = pattern.replace(/[\\%_]/g, c => '\\' + c).replace(/\*/g, '%').replace(/\?/g, '_');
  const rows = await (await sql()).query("SELECT key FROM kv WHERE key LIKE $1 ESCAPE '\\' ORDER BY key", [like]);
  return rows.map(r => r.key);
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
