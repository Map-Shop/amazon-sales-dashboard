// SQL storage for daily ad spend rows (the `ad_spend_rows` table), used
// when SQL_TABLES includes "adspend" (see lib/sql.js). Otherwise rows stay
// in the adspend:<sp|sb>:raw:YYYY-MM kv records, as before.
//
// Every write replaces one ad type's whole month, so each row keeps its
// position within its month and reads back in written order. Rows have two
// shapes per type, and a field a row didn't have is NULL and comes back
// absent:
//   spend only (Sheets/CSV): { date, campaign, cost }
//   SP from the API:         { date, campaign, adGroup, sku, asin, cost,
//                              impressions, clicks, purchases7d, sales7d }
//   SB from the API:         { date, campaign, campaignId, cost,
//                              impressions, clicks }
// campaignId is stored as JSON because the API path writes '' when Amazon
// omits it, a number otherwise.
//
// The month lists, latest-posted maps, sync timestamps, pending queue, and
// weekly rollups stay in kv.
//
// Table (created by tools/to-sql.mjs):
//   ad_spend_rows (ad_type, month, position) primary key.

import { sql, usesSql } from './sql.js';

// [field, column, sql type], in the order that reproduces every row shape.
export const AD_COLUMNS = [
  ['date', 'date', 'date'], ['campaign', 'campaign', 'text'], ['adGroup', 'ad_group', 'text'],
  ['sku', 'sku', 'text'], ['asin', 'asin', 'text'], ['campaignId', 'campaign_id', 'json'],
  ['cost', 'cost', 'numeric'], ['impressions', 'impressions', 'numeric'], ['clicks', 'clicks', 'numeric'],
  ['purchases7d', 'purchases7d', 'numeric'], ['sales7d', 'sales7d', 'numeric']
];

export function adspendInSql() {
  return usesSql('adspend');
}

const SELECT_COLUMNS = ['month', ...AD_COLUMNS.map(([field, col, type]) =>
  type === 'date' ? `to_char(${col}, 'YYYY-MM-DD') AS "${field}"` : `${col} AS "${field}"`)].join(', ');

const toRow = (r) => {
  const row = {};
  for (const [field, , type] of AD_COLUMNS) {
    if (r[field] === null) continue;
    row[field] = type === 'numeric' ? Number(r[field]) : r[field];
  }
  return row;
};

// One month's rows for an ad type, in written order.
export async function getMonth(type, month) {
  const rows = await sql().query(`SELECT ${SELECT_COLUMNS} FROM ad_spend_rows
    WHERE ad_type = $1 AND month = $2 ORDER BY position`, [type, month]);
  return rows.map(toRow);
}

// Rows for several months, month by month in the order given.
export async function getMonths(type, months) {
  if (months.length === 0) return [];
  const rows = await sql().query(`SELECT ${SELECT_COLUMNS} FROM ad_spend_rows
    WHERE ad_type = $1 AND month = ANY($2) ORDER BY month, position`, [type, months]);
  const byMonth = new Map(months.map(m => [m, []]));
  for (const r of rows) byMonth.get(r.month)?.push(toRow(r));
  return months.flatMap(m => byMonth.get(m));
}

// Replace an ad type's month with exactly the given rows.
export async function replaceMonth(type, month, rows) {
  const s = sql();
  const statements = [s.query('DELETE FROM ad_spend_rows WHERE ad_type = $1 AND month = $2', [type, month])];
  if (rows.length) {
    const cols = AD_COLUMNS.map(([, col]) => col).join(', ');
    const unnest = AD_COLUMNS.map(([, , t], i) => `$${i + 3}::${t}[]`).join(', ');
    statements.push(s.query(
      `INSERT INTO ad_spend_rows (ad_type, month, position, ${cols})
       SELECT $1, $2, ord - 1, ${cols} FROM unnest(${unnest}) WITH ORDINALITY AS v(${cols}, ord)`,
      [type, month, ...AD_COLUMNS.map(([field, , t]) => rows.map(r => {
        const v = r[field];
        if (v === undefined) return null;
        return t === 'json' ? JSON.stringify(v) : v;
      }))]));
  }
  await s.transaction(statements);
}
