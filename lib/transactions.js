// SQL storage for Amazon transactions, used when SQL_TABLES includes
// "transactions" (see lib/sql.js). Otherwise they stay in the
// transactions:v2024:* kv records, as before. Three tables:
//
//   amazon_transactions — every Finances API transaction exactly as Amazon
//     returned it (json keeps the text, key order, and numbers), in each
//     month's stored order. A few fields are copied into their own columns
//     for querying (posted date, type, status, order/shipment/refund ids);
//     reads return only the original record.
//   transaction_months — which months hold API data. A synced month with
//     no transactions still counts, as its kv metadata did, so the CSV
//     upload's "don't overwrite API months" check behaves identically.
//   imported_transaction_rows — the 2024 rows uploaded from Seller
//     Central's transaction report, already in the derived row shape.
//
// The kv layout split big months into ~8 MB parts for Upstash's request
// limit; the tables don't need that. Indexes, sync timestamps, and the
// latest-posted map stay in kv.

import { sql, usesSql } from './sql.js';

export function transactionsInSql() {
  return usesSql('transactions');
}

// ── Raw API transactions ─────────────────────────────────────────────────

// A month's transactions in stored order ([] when none).
export async function getRawMonth(month) {
  const rows = await sql().query(
    'SELECT data FROM amazon_transactions WHERE month = $1 ORDER BY position', [month]);
  return rows.map(r => r.data);
}

// Whether the month holds API data, by the kv layout's rule.
export async function rawMonthHasData(month) {
  const rows = await sql().query('SELECT has_raw FROM transaction_months WHERE month = $1', [month]);
  return rows.length > 0 && rows[0].has_raw === true;
}

// ── Month bookkeeping, answered by the tables ────────────────────────────
// In kv mode these were separate records kept beside the data
// (transactions:v2024:index, :imported-index, :latest-posted); each only
// ever restated what the data says, so the tables answer instead.

// Every synced month, ascending — including months Amazon returned no
// transactions for (the sync still records them in transaction_months).
export async function getRawMonths() {
  const rows = await sql().query('SELECT month FROM transaction_months ORDER BY month COLLATE "C"');
  return rows.map(r => r.month);
}

// Every month with uploaded rows, ascending.
export async function getImportedMonths() {
  const rows = await sql().query(
    'SELECT month FROM imported_transaction_rows GROUP BY month ORDER BY month COLLATE "C"');
  return rows.map(r => r.month);
}

// Each month's latest posted date: for months with API transactions, the
// latest postedDate among them (compared as strings, as the sync did); for
// months with only uploaded rows, the latest row date at end of day UTC, as
// the upload recorded it.
export async function getLatestPostedByMonth() {
  const [raw, imported] = await Promise.all([
    sql().query(`SELECT month, max(NULLIF(posted_date, '') COLLATE "C") AS latest
      FROM amazon_transactions GROUP BY month`),
    sql().query(`SELECT month, to_char(max(date), 'YYYY-MM-DD') || 'T23:59:59Z' AS latest
      FROM imported_transaction_rows WHERE date IS NOT NULL GROUP BY month`)
  ]);
  const map = {};
  for (const r of imported) map[r.month] = r.latest;
  for (const r of raw) if (r.latest) map[r.month] = r.latest;
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Columns copied out of each record, as [column, SQL expression over the
// json record d]. relatedIdentifiers is a list of { relatedIdentifierName,
// relatedIdentifierValue }; the first match wins, as in the client's lookup.
const relatedId = (d, name) => `(SELECT ri->>'relatedIdentifierValue'
     FROM json_array_elements(CASE WHEN json_typeof(${d}->'relatedIdentifiers') = 'array'
       THEN ${d}->'relatedIdentifiers' END) ri
     WHERE ri->>'relatedIdentifierName' = '${name}' LIMIT 1)`;
export const rawExtracted = (d) => [
  ['posted_date', `${d}->>'postedDate'`],
  ['transaction_type', `${d}->>'transactionType'`],
  ['transaction_status', `${d}->>'transactionStatus'`],
  ['order_id', relatedId(d, 'ORDER_ID')],
  ['shipment_id', relatedId(d, 'SHIPMENT_ID')],
  ['refund_id', relatedId(d, 'REFUND_ID')]
];
export const RAW_EXTRACTED = (d) => rawExtracted(d).map(([, expr]) => expr).join(',\n  ');
export const RAW_EXTRACTED_COLUMNS = rawExtracted('d').map(([col]) => col).join(', ');

// Replace a month's transactions (a sync), and record that it holds API
// data — a synced month always does, even when Amazon returned none.
export async function replaceRawMonth(month, transactions) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM amazon_transactions WHERE month = $1', [month]),
    s.query(`INSERT INTO amazon_transactions (month, position, data, ${RAW_EXTRACTED_COLUMNS})
      SELECT $1, (v.ord - 1)::int, v.d, ${RAW_EXTRACTED('v.d')}
      FROM json_array_elements($2::json) WITH ORDINALITY AS v(d, ord)`,
      [month, JSON.stringify(transactions)]),
    s.query(`INSERT INTO transaction_months (month, has_raw, transaction_count) VALUES ($1, true, $2)
      ON CONFLICT (month) DO UPDATE SET has_raw = true, transaction_count = EXCLUDED.transaction_count`,
      [month, transactions.length])
  ]);
}

// ── Uploaded 2024 rows ───────────────────────────────────────────────────

// [field, column, sql type], in the row shape's field order.
export const IMPORTED_COLUMNS = [
  ['type', 'type', 'text'], ['orderId', 'order_id', 'text'], ['date', 'date', 'date'],
  ['sku', 'sku', 'text'], ['qty', 'qty', 'numeric'], ['fulfillment', 'fulfillment', 'text'],
  ['sale', 'sale', 'numeric'], ['otherCharges', 'other_charges', 'numeric'],
  ['fbaFees', 'fba_fees', 'numeric'], ['transactionFees', 'transaction_fees', 'numeric'],
  ['promotions', 'promotions', 'numeric'], ['feeType', 'fee_type', 'text'],
  ['feeAmount', 'fee_amount', 'numeric'], ['adjustmentType', 'adjustment_type', 'text'],
  ['adjustmentAmount', 'adjustment_amount', 'numeric'], ['_src', 'src', 'text'],
  ['_transactionId', 'transaction_id', 'text'], ['_transactionStatus', 'transaction_status', 'text']
];

const IMPORTED_SELECT = IMPORTED_COLUMNS.map(([field, col, type]) =>
  type === 'date' ? `to_char(${col}, 'YYYY-MM-DD') AS "${field}"` : `${col} AS "${field}"`).join(', ');

const toImportedRow = (r) => {
  const row = {};
  for (const [field, , type] of IMPORTED_COLUMNS) {
    if (r[field] === null) continue;
    row[field] = type === 'numeric' ? Number(r[field]) : r[field];
  }
  return row;
};

// A month's uploaded rows in stored order ([] when none).
export async function getImportedMonth(month) {
  const rows = await sql().query(`SELECT ${IMPORTED_SELECT} FROM imported_transaction_rows
    WHERE month = $1 ORDER BY position`, [month]);
  return rows.map(toImportedRow);
}

export async function replaceImportedMonth(month, rows) {
  const s = sql();
  const statements = [s.query('DELETE FROM imported_transaction_rows WHERE month = $1', [month])];
  if (rows.length) {
    const cols = IMPORTED_COLUMNS.map(([, col]) => col).join(', ');
    const unnest = IMPORTED_COLUMNS.map(([, , type], i) => `$${i + 2}::${type}[]`).join(', ');
    statements.push(s.query(
      `INSERT INTO imported_transaction_rows (month, position, ${cols})
       SELECT $1, ord - 1, ${cols} FROM unnest(${unnest}) WITH ORDINALITY AS v(${cols}, ord)`,
      [month, ...IMPORTED_COLUMNS.map(([field]) => rows.map(r => (r[field] === undefined ? null : r[field])))]));
  }
  await s.transaction(statements);
}
