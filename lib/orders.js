// SQL storage for Amazon order lines (the `orders` table), used when
// SQL_TABLES includes "orders" (see lib/sql.js). Otherwise order lines stay
// in the orders:v2:YYYY-MM records of the kv table, as before.
//
// Rows go in and come out in exactly the shape the rest of the code uses
// for an order line:
//   { orderDate, orderId, sku, asin, quantity, itemTotal,
//     fulfillmentChannel, isBusinessOrder }
// with orderDate the Pacific calendar date as 'YYYY-MM-DD'.
//
// Table (created by tools/to-sql.mjs):
//   orders (order_id, sku) primary key — the same identity the kv merge
//   deduplicates on — plus an index on order_date.

import { sql, usesSql } from './sql.js';

export function ordersInSql() {
  return usesSql('orders');
}

const SELECT_COLUMNS = `to_char(order_date, 'YYYY-MM-DD') AS "orderDate",
  order_id AS "orderId", sku, asin, quantity, item_total AS "itemTotal",
  fulfillment_channel AS "fulfillmentChannel", is_business_order AS "isBusinessOrder"`;

// numeric comes back from the driver as text.
const toRow = (r) => ({ ...r, itemTotal: Number(r.itemTotal) });

const monthStart = (month) => `${month}-01`;
const nextMonthStart = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

// A report can repeat an order line; the last copy wins, matching the kv
// merge. One INSERT ... ON CONFLICT can't touch the same key twice.
function lastCopyPerKey(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.orderId}\u0000${r.sku}`, r);
  return [...byKey.values()];
}

function columnArrays(rows) {
  return [
    rows.map(r => r.orderId),
    rows.map(r => r.sku),
    rows.map(r => r.orderDate),
    rows.map(r => r.asin ?? ''),
    rows.map(r => r.quantity),
    rows.map(r => r.itemTotal),
    rows.map(r => r.fulfillmentChannel ?? ''),
    rows.map(r => r.isBusinessOrder === true)
  ];
}

const UNNEST_ROWS = `unnest($1::text[], $2::text[], $3::date[], $4::text[],
  $5::int[], $6::numeric[], $7::text[], $8::bool[])
  AS v(order_id, sku, order_date, asin, quantity, item_total, fulfillment_channel, is_business_order)`;

const INSERT_ROWS = `INSERT INTO orders (order_id, sku, order_date, asin, quantity,
    item_total, fulfillment_channel, is_business_order)
  SELECT * FROM ${UNNEST_ROWS}
  ON CONFLICT (order_id, sku) DO UPDATE SET
    order_date = EXCLUDED.order_date, asin = EXCLUDED.asin,
    quantity = EXCLUDED.quantity, item_total = EXCLUDED.item_total,
    fulfillment_channel = EXCLUDED.fulfillment_channel,
    is_business_order = EXCLUDED.is_business_order, updated_at = now()`;

// ── Reads ────────────────────────────────────────────────────────────────

// All order lines, or those with startDate <= orderDate <= endDate when
// both are given. Ordered by date, then order id and SKU.
export async function getOrders({ startDate, endDate } = {}) {
  const rows = (startDate && endDate)
    ? await sql().query(`SELECT ${SELECT_COLUMNS} FROM orders
        WHERE order_date BETWEEN $1 AND $2 ORDER BY order_date, order_id, sku`, [startDate, endDate])
    : await sql().query(`SELECT ${SELECT_COLUMNS} FROM orders ORDER BY order_date, order_id, sku`);
  return rows.map(toRow);
}

// Order lines dated within one calendar month ('YYYY-MM').
export async function getMonth(month) {
  const rows = await sql().query(`SELECT ${SELECT_COLUMNS} FROM orders
    WHERE order_date >= $1 AND order_date < $2 ORDER BY order_date, order_id, sku`,
    [monthStart(month), nextMonthStart(month)]);
  return rows.map(toRow);
}

// Which of the given months already hold order lines.
export async function monthsWithData(months) {
  if (months.length === 0) return [];
  const rows = await sql().query(`SELECT DISTINCT to_char(order_date, 'YYYY-MM') AS month
    FROM orders WHERE to_char(order_date, 'YYYY-MM') = ANY($1)`, [months]);
  return rows.map(r => r.month).sort();
}

// ── Writes ───────────────────────────────────────────────────────────────

// Whole-month replace: each month's lines become exactly the given rows.
// All months change in one transaction.
export async function replaceMonths(byMonth) {
  const months = Object.keys(byMonth).sort();
  if (months.length === 0) return;
  const s = sql();
  const statements = [];
  for (const m of months) {
    statements.push(s.query('DELETE FROM orders WHERE order_date >= $1 AND order_date < $2',
      [monthStart(m), nextMonthStart(m)]));
    const rows = lastCopyPerKey(byMonth[m]);
    if (rows.length) statements.push(s.query(INSERT_ROWS, columnArrays(rows)));
  }
  await s.transaction(statements);
}

// Insert new lines and refresh existing ones (newest report wins).
export async function upsertOrders(rows) {
  const unique = lastCopyPerKey(rows);
  if (unique.length === 0) return;
  await sql().query(INSERT_ROWS, columnArrays(unique));
}

// Refresh only lines already stored; never inserts. Returns how many of
// the given rows matched a stored line.
export async function updateExistingOrders(rows) {
  const unique = lastCopyPerKey(rows);
  if (unique.length === 0) return 0;
  const matched = await sql().query(`UPDATE orders o SET
      order_date = v.order_date, asin = v.asin, quantity = v.quantity,
      item_total = v.item_total, fulfillment_channel = v.fulfillment_channel,
      is_business_order = v.is_business_order, updated_at = now()
    FROM ${UNNEST_ROWS}
    WHERE o.order_id = v.order_id AND o.sku = v.sku
    RETURNING o.order_id, o.sku`, columnArrays(unique));
  // Count input rows (not distinct keys) that matched, as the kv merge does.
  const hit = new Set(matched.map(r => `${r.order_id}\u0000${r.sku}`));
  return rows.filter(r => hit.has(`${r.orderId}\u0000${r.sku}`)).length;
}

// Delete lines by { orderId, sku }. Returns the number removed.
export async function deleteOrderKeys(keys) {
  if (keys.length === 0) return 0;
  const removed = await sql().query(`DELETE FROM orders o
    USING unnest($1::text[], $2::text[]) AS k(order_id, sku)
    WHERE o.order_id = k.order_id AND o.sku = k.sku
    RETURNING o.order_id`, [keys.map(k => k.orderId), keys.map(k => k.sku)]);
  return removed.length;
}

// Delete every line dated within the given months.
export async function deleteMonths(months) {
  if (months.length === 0) return;
  const s = sql();
  await s.transaction(months.map(m =>
    s.query('DELETE FROM orders WHERE order_date >= $1 AND order_date < $2', [monthStart(m), nextMonthStart(m)])
  ));
}
