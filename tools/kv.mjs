// Read-only access to the dashboard's Neon database for local ad-hoc
// queries. The connection string comes from .env.local in the project root
// (gitignored):
//
//   NEON_READONLY_URL=postgresql://claude_readonly:...@.../neondb?sslmode=require
//
// The role must be read-only: before the first query this file checks its
// privileges on every table in the public schema and refuses to run if it
// could write to any of them. Anything naming a credential is refused.
// Values decode with the app's own rules (lib/kv.js), so they come back
// exactly as the API sees them.
//
// The app's data lives in SQL tables now, so query() is the useful entry
// point; the kv* helpers remain for the few records still kept that way.
//
// CLI (run from the project root):
//   node tools/kv.mjs keys                   list every key
//   node tools/kv.mjs keys "orders:v2:*"     list keys matching a pattern
//   node tools/kv.mjs get products           print one value as JSON
//   node tools/kv.mjs tables                 list the tables and their sizes
//   node tools/kv.mjs query "SELECT ..."     run one read-only statement
//
// Module:
//   import { query, kvGet, kvGetRaw, kvMGet, kvKeys } from './tools/kv.mjs';

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
  // Every table, not one of them: the data moved out of kv into tables of its
  // own, and a role that cannot write to kv may still be able to write to
  // those. has_table_privilege is used rather than the grant tables because it
  // accounts for privileges inherited through role membership.
  const [p] = await s.query(`SELECT count(*)::int AS writable
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (has_table_privilege(c.oid, 'INSERT')
         OR has_table_privilege(c.oid, 'UPDATE')
         OR has_table_privilege(c.oid, 'DELETE')
         OR has_table_privilege(c.oid, 'TRUNCATE'))`);
  if (p.writable) {
    throw new Error(`NEON_READONLY_URL uses a role that can write to ${p.writable} ` +
                    'table(s); use the read-only role');
  }
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

// One read-only statement against the SQL tables.
//
// The role cannot write, so this is about keeping honest mistakes out rather
// than defending the database: a statement that reads like a write is refused
// here instead of producing a permissions error, and anything naming a
// credential is refused for the same reason kv reads of credential:* are.
const FORBIDDEN = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy)\b/i;
const MAX_ROWS = 1000;

export async function query(text, params = []) {
  const statement = String(text || '').trim();
  if (!statement) throw new Error('query() needs a statement');
  if (/credential/i.test(statement)) {
    throw new Error('Refusing a query naming credentials: those records hold secrets');
  }
  if (FORBIDDEN.test(statement)) {
    throw new Error('Refusing a statement that reads as a write; this connection is for SELECT only');
  }
  if (statement.includes(';') && !/;\s*$/.test(statement)) {
    throw new Error('Refusing several statements at once; run them one at a time');
  }
  const rows = await (await sql()).query(statement, params);
  if (Array.isArray(rows) && rows.length > MAX_ROWS) {
    const head = rows.slice(0, MAX_ROWS);
    head.truncated = rows.length;
    return head;
  }
  return rows;
}

// What is in the database and how big it is.
export async function tables() {
  const rows = await query(
    `SELECT relname AS table,
            n_live_tup::bigint AS approx_rows,
            pg_total_relation_size(relid)::bigint AS bytes
       FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`);
  return rows.map(r => ({ table: r.table, approxRows: Number(r.approx_rows), bytes: Number(r.bytes) }));
}

const asMB = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'keys') console.log((await kvKeys(arg || '*')).join('\n'));
    else if (cmd === 'get' && arg) console.log(JSON.stringify(await kvGet(arg), null, 2));
    else if (cmd === 'query' && arg) {
      const rows = await query(arg);
      console.log(JSON.stringify(rows, null, 2));
      if (rows.truncated) console.error(`(showing ${MAX_ROWS} of ${rows.truncated} rows)`);
    } else if (cmd === 'tables') {
      for (const t of await tables()) {
        console.log(`${t.table.padEnd(28)} ${String(t.approxRows).padStart(10)} rows  ${asMB(t.bytes)}`);
      }
    } else {
      console.error('Usage: node tools/kv.mjs keys [pattern] | get <key> | tables | query "SELECT ..."');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
