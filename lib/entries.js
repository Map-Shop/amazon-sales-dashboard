// SQL storage for the dashboard's two entry logs, used when SQL_TABLES
// includes the log's name (see lib/sql.js). Otherwise each log stays in its
// kv record, as before.
//
//   pricechanges → price_changes    (pricechanges:entries)
//   changelog    → listing_changes  (changelog:entries)
//
// Entries are kept in the order they were added (the seq column). The API
// sorts on read and falls back to that order for entries sharing a date and
// createdAt (bulk adds), so it is preserved exactly. Entries come out in the
// same shape the APIs store.
//
// Tables (created by tools/to-sql.mjs): seq identity primary key, plus an
// index on id. Ids aren't declared unique because the kv list never
// enforced it; delete removes every entry with the id, as the kv filter did.

import { sql, usesSql } from './sql.js';

// [field, column, sql type]
const LISTS = {
  pricechanges: {
    table: 'price_changes',
    columns: [
      ['id', 'id', 'text'], ['createdAt', 'created_at', 'text'], ['date', 'date', 'date'],
      ['sku', 'sku', 'text'], ['oldPrice', 'old_price', 'numeric'], ['newPrice', 'new_price', 'numeric']
    ]
  },
  changelog: {
    table: 'listing_changes',
    columns: [
      ['id', 'id', 'text'], ['createdAt', 'created_at', 'text'], ['date', 'date', 'date'],
      ['productName', 'product_name', 'text'], ['asin', 'asin', 'text'],
      ['changes', 'changes', 'text'], ['notes', 'notes', 'text']
    ]
  }
};

export function listInSql(name) {
  return usesSql(name);
}

function spec(name) {
  const s = LISTS[name];
  if (!s) throw new Error(`Unknown entry log: ${name}`);
  return s;
}

const selectList = (s) => s.columns.map(([field, col, type]) =>
  type === 'date' ? `to_char(${col}, 'YYYY-MM-DD') AS "${field}"` : `${col} AS "${field}"`).join(', ');

const toEntry = (s) => (r) => {
  const e = {};
  for (const [field, , type] of s.columns) e[field] = type === 'numeric' ? Number(r[field]) : r[field];
  return e;
};

// Every entry, in the order added.
export async function getAll(name) {
  const s = spec(name);
  const rows = await sql().query(`SELECT ${selectList(s)} FROM ${s.table} ORDER BY seq`);
  return rows.map(toEntry(s));
}

function insertStatement(s, entries) {
  const cols = s.columns.map(([, col]) => col).join(', ');
  const unnest = s.columns.map(([, , type], i) => `$${i + 1}::${type}[]`).join(', ');
  const names = s.columns.map(([, col]) => col).join(', ');
  return sql().query(
    `INSERT INTO ${s.table} (${cols})
     SELECT ${names} FROM unnest(${unnest}) WITH ORDINALITY AS v(${names}, ord) ORDER BY ord`,
    s.columns.map(([field]) => entries.map(e => e[field] ?? null)));
}

// Add entries after the existing ones, in the given order.
export async function append(name, entries) {
  if (entries.length) await insertStatement(spec(name), entries);
}

// Remove every entry with this id; returns how many were removed.
export async function deleteById(name, id) {
  const s = spec(name);
  const removed = await sql().query(`DELETE FROM ${s.table} WHERE id = $1 RETURNING seq`, [id]);
  return removed.length;
}

// Replace the whole log with the given entries.
export async function replaceAll(name, entries) {
  const s = spec(name);
  const statements = [sql().query(`DELETE FROM ${s.table}`)];
  if (entries.length) statements.push(insertStatement(s, entries));
  await sql().transaction(statements);
}
