// SQL storage for the remaining bookkeeping, used when SQL_TABLES includes
// "stamps". Otherwise it stays in kv (shipping:index,
// shipping:last-synced:YYYY-MM, transactions:v2024:last-synced:YYYY-MM,
// products:updated-at, mappings:<type>:updated-at).
//
//   shipping_months         — the months shipping holds, in stored order (a
//                             sync that found no shipments still counts).
//   shipping_month_syncs    — when each shipping month was last synced.
//   transaction_month_syncs — when each transactions month was last synced.
//   edit_stamps             — when the catalog and each mapping were last
//                             written ('products', 'mappings:product', …).
//
// Values are stored as the text the kv records held.

import { sql, usesSql } from './sql.js';

export function stampsInSql() {
  return usesSql('stamps');
}

const MONTH_SYNC_TABLE = { shipping: 'shipping_month_syncs', transactions: 'transaction_month_syncs' };

// shipping:index, or null when there is none.
export async function getShippingIndex() {
  const rows = await sql().query('SELECT month FROM shipping_months ORDER BY position');
  return rows.length ? rows.map(r => r.month) : null;
}

export async function replaceShippingIndex(months) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM shipping_months'),
    s.query(`INSERT INTO shipping_months (position, month)
      SELECT (e.ord - 1)::int, e.m FROM unnest($1::text[]) WITH ORDINALITY AS e(m, ord)`, [months || []])
  ]);
}

// When a data set's month was last synced ('shipping' | 'transactions'), or null.
export async function getMonthSync(dataSet, month) {
  const [row] = await sql().query(`SELECT synced_at FROM ${MONTH_SYNC_TABLE[dataSet]} WHERE month = $1`, [month]);
  return row ? row.synced_at : null;
}

export async function setMonthSync(dataSet, month, at) {
  await sql().query(`INSERT INTO ${MONTH_SYNC_TABLE[dataSet]} (month, synced_at) VALUES ($1, $2)
    ON CONFLICT (month) DO UPDATE SET synced_at = EXCLUDED.synced_at`, [month, at]);
}

// When a data set was last written, or null.
export async function getEditStamp(dataSet) {
  const [row] = await sql().query('SELECT updated_at FROM edit_stamps WHERE data_set = $1', [dataSet]);
  return row ? row.updated_at : null;
}

export async function setEditStamp(dataSet, at) {
  await sql().query(`INSERT INTO edit_stamps (data_set, updated_at) VALUES ($1, $2)
    ON CONFLICT (data_set) DO UPDATE SET updated_at = EXCLUDED.updated_at`, [dataSet, at]);
}
