// Copies the dashboard's data from Upstash to Neon and verifies the copy.
//
// Run from the project root:
//   node tools/migrate-to-neon.mjs --verify   compare Upstash and Neon
// (Copying is disabled now that production runs on Neon; see below.)
//
// Needs in .env.local: KV_REST_API_URL + KV_REST_API_READ_ONLY_TOKEN
// (Upstash, read-only) and DATABASE_URL (Neon, a role that can write).
// Nothing here prints a credential.
//
// The copy is a mirror: each Upstash record's stored text is written to
// the Neon `kv` table unchanged (lib/kv.js decodes it with Upstash's own
// rules), and Neon records with no Upstash counterpart are deleted. Safe
// to re-run; the final run just before switching production over makes
// Neon an exact copy of Upstash at that moment.
//
// Verification compares every record's byte length and MD5 between the two
// stores, and the record counts and total sizes.

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { neon } from '@neondatabase/serverless';
import { kvKeys, kvGetRaw } from './upstash.mjs';

// Records left behind, with why. Everything else is copied.
const SKIP = [
  [/^credential:/, 'stored copies of app secrets; the running app reads secrets from Vercel environment variables'],
  [/^transactions:raw:/, 'old-format transactions; only unused endpoints read them'],
  [/^transactions:index$/, 'old-format transactions index; only unused endpoints read it'],
  [/^transactions:last-synced:/, 'old-format sync stamps; only unused endpoints read them'],
  [/^transactions:\d{4}-\d{2}$/, 'not referenced by any code'],
  [/^productads:/, 'not referenced by any code'],
  [/^brandads:/, 'not referenced by any code'],
  [/^shipping:\d{4}-\d{2}$/, 'not referenced by any code'],
];
const skipReason = (key) => SKIP.find(([re]) => re.test(key))?.[1] || null;

function databaseUrl() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/);
    if (m && m[1]) return m[1].replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new Error('DATABASE_URL is missing or empty in .env.local');
}

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const mb = (n) => (n / 1048576).toFixed(2);

const verifyOnly = process.argv.includes('--verify');

// Production switched to Neon on 2026-10-20, so Upstash is now the stale
// copy. A mirror run would overwrite production's newer data and delete
// records written since the switch, so only verification is allowed.
if (!verifyOnly) {
  console.error('Copying is disabled: production runs on Neon since 2026-10-20 and Upstash is stale.');
  console.error('Use --verify to compare the two stores.');
  process.exit(1);
}

const sql = neon(databaseUrl());

await sql.query(`CREATE TABLE IF NOT EXISTS kv (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`);

const allKeys = await kvKeys('*');
const copyKeys = allKeys.filter(k => !skipReason(k));
const skipped = allKeys.filter(k => skipReason(k));
console.log(`Upstash records: ${allKeys.length} · to copy: ${copyKeys.length} · left behind: ${skipped.length}`);
const reasons = {};
for (const k of skipped) reasons[skipReason(k)] = (reasons[skipReason(k)] || 0) + 1;
for (const [why, n] of Object.entries(reasons)) console.log(`  left behind ${n}: ${why}`);

// One pass over Upstash: copy (unless --verify) and remember each record's
// fingerprint for the comparison.
const expected = new Map();
let copied = 0;
for (const key of copyKeys) {
  const text = await kvGetRaw(key);
  if (text === null) continue; // deleted between the listing and the read
  expected.set(key, { bytes: bytes(text), md5: md5(text) });
  if (!verifyOnly) {
    await sql.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, text]
    );
    copied++;
    if (copied % 25 === 0) console.log(`  copied ${copied}/${copyKeys.length}`);
  }
}

if (!verifyOnly) {
  const removed = await sql.query('DELETE FROM kv WHERE NOT (key = ANY($1)) RETURNING key', [[...expected.keys()]]);
  console.log(`Copied ${copied} records${removed.length ? `; removed ${removed.length} Neon records no longer in Upstash` : ''}.`);
}

// Compare against what Neon now holds.
const neonRows = await sql.query('SELECT key, octet_length(value) AS bytes, md5(value) AS md5 FROM kv');
const actual = new Map(neonRows.map(r => [r.key, { bytes: Number(r.bytes), md5: r.md5 }]));
const problems = [];
for (const [key, e] of expected) {
  const a = actual.get(key);
  if (!a) problems.push(`missing in Neon: ${key}`);
  else if (a.bytes !== e.bytes || a.md5 !== e.md5) problems.push(`differs: ${key} (Upstash ${e.bytes} B, Neon ${a.bytes} B)`);
}
for (const key of actual.keys()) if (!expected.has(key)) problems.push(`extra in Neon: ${key}`);

const sum = (m) => [...m.values()].reduce((s, v) => s + v.bytes, 0);
console.log(`\nUpstash (copied set): ${expected.size} records, ${mb(sum(expected))} MB`);
console.log(`Neon:                 ${actual.size} records, ${mb(sum(actual))} MB`);
if (problems.length) {
  console.log(`\nVERIFY FAILED: ${problems.length} problem(s)`);
  problems.slice(0, 30).forEach(p => console.log('  ' + p));
  process.exit(1);
}
console.log('\nVERIFIED: every record matches byte for byte.');
