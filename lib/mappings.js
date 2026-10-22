// SQL storage for the product, brand, and fee mappings (the
// `mapping_entries` table), used when SQL_TABLES includes "mappings" (see
// lib/sql.js). Otherwise each mapping stays in its mappings:<type> kv
// record, as before.
//
// A mapping is a lookup object ({ campaign: { brand, skus } },
// { campaign: brand }, { feeType: line }). Every write rebuilds the whole
// object in code, so the table stores its entries in the object's key
// order and rebuilds an identical object on read. Values keep their exact
// JSON.
//
// The mappings:<type>:updated-at timestamps stay in kv.
//
// Table (created by tools/to-sql.mjs):
//   mapping_entries (type, position) primary key, unique (type, key).

import { sql, usesSql } from './sql.js';

export function mappingsInSql() {
  return usesSql('mappings');
}

// The mapping as an object; {} when it has no entries.
export async function getMap(type) {
  const rows = await sql().query(
    'SELECT key, value FROM mapping_entries WHERE type = $1 ORDER BY position', [type]);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

// Replace the mapping with exactly the given object's entries, in order.
export async function replaceMap(type, map) {
  const s = sql();
  const entries = Object.entries(map || {});
  const statements = [s.query('DELETE FROM mapping_entries WHERE type = $1', [type])];
  if (entries.length) {
    statements.push(s.query(
      `INSERT INTO mapping_entries (type, position, key, value)
       SELECT $1, ord - 1, k, v FROM unnest($2::text[], $3::json[]) WITH ORDINALITY AS e(k, v, ord)`,
      [type, entries.map(([k]) => k), entries.map(([, v]) => JSON.stringify(v))]));
  }
  await s.transaction(statements);
}
