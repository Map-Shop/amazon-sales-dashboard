// Storage adapter. The API calls kv.get / kv.set / kv.del exactly as it
// did with @vercel/kv; the DB_BACKEND env var picks where they go:
//
//   unset or 'upstash' → @vercel/kv (Upstash), unchanged
//   'neon'             → the `kv` table in Neon (DATABASE_URL)
//
// Neon values are encoded and decoded with @vercel/kv's own rules
// (@upstash/redis 1.25.x): strings, numbers and booleans are stored as
// their plain text, anything else as JSON; reads JSON-parse when they can
// and otherwise return the raw text. A value therefore reads back the same
// from either backend, and tools/migrate-to-neon.mjs can copy the stored
// text across unchanged.
//
// Table (created by tools/migrate-to-neon.mjs):
//   kv (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz)

import { kv as upstashKv } from '@vercel/kv';
import { neon } from '@neondatabase/serverless';

export function encodeValue(value) {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return JSON.stringify(value) ?? 'null';
  }
}

export function decodeValue(text) {
  try {
    const parsed = JSON.parse(text);
    // Matches @upstash/redis: a value that parses to a number but doesn't
    // round-trip (e.g. "007", or an integer too large for a JS number)
    // stays text.
    return typeof parsed === 'number' && parsed.toString() !== text ? text : parsed;
  } catch {
    return text;
  }
}

let _sql;
function sql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DB_BACKEND=neon but DATABASE_URL is not set');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

const neonKv = {
  async get(key) {
    const rows = await sql().query('SELECT value FROM kv WHERE key = $1', [key]);
    return rows.length ? decodeValue(rows[0].value) : null;
  },

  async set(key, value) {
    await sql().query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, encodeValue(value)]
    );
    return 'OK';
  },

  async del(...keys) {
    const flat = keys.flat();
    if (flat.length === 0) return 0;
    const rows = await sql().query('DELETE FROM kv WHERE key = ANY($1) RETURNING key', [flat]);
    return rows.length;
  }
};

export const kv = process.env.DB_BACKEND === 'neon' ? neonKv : upstashKv;
