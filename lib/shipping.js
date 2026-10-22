// SQL storage for shipping cost rows (the `shipping_costs` table), used
// when SQL_TABLES includes "shipping" (see lib/sql.js). Otherwise rows stay
// in the shipping:raw:YYYY-MM records of the kv table, as before.
//
// Every write replaces a whole month, so each row keeps its position
// within its month and a month reads back in exactly the order it was
// written. Rows come out in the shape the rest of the code uses:
//   { shipDate, orderId, sku, qty, cost, carrier?, service? }
// carrier and service are present only when the row had them (live
// ShipStation rows do; uploaded and Sheets rows don't).
//
// The month list (shipping:index) and sync timestamps stay in kv.
//
// Table (created by tools/to-sql.mjs):
//   shipping_costs (ship_month, position) primary key.

import { sql, usesSql } from './sql.js';

export function shippingInSql() {
  return usesSql('shipping');
}

const toRow = (r) => {
  const row = { shipDate: r.ship_date, orderId: r.order_id, sku: r.sku, qty: r.qty, cost: Number(r.cost) };
  if (r.carrier !== null) row.carrier = r.carrier;
  if (r.service !== null) row.service = r.service;
  return row;
};

const SELECT_COLUMNS = `ship_month, to_char(ship_date, 'YYYY-MM-DD') AS ship_date,
  order_id, sku, qty, cost, carrier, service`;

// One month's rows, in written order.
export async function getMonth(month) {
  const rows = await sql().query(`SELECT ${SELECT_COLUMNS} FROM shipping_costs
    WHERE ship_month = $1 ORDER BY position`, [month]);
  return rows.map(toRow);
}

// Rows for several months, month by month in the order given.
export async function getMonths(months) {
  if (months.length === 0) return [];
  const rows = await sql().query(`SELECT ${SELECT_COLUMNS} FROM shipping_costs
    WHERE ship_month = ANY($1) ORDER BY ship_month, position`, [months]);
  const byMonth = new Map(months.map(m => [m, []]));
  for (const r of rows) byMonth.get(r.ship_month)?.push(toRow(r));
  return months.flatMap(m => byMonth.get(m));
}

// Replace a month's rows with exactly the given rows.
export async function replaceMonth(month, rows) {
  const s = sql();
  const statements = [s.query('DELETE FROM shipping_costs WHERE ship_month = $1', [month])];
  if (rows.length) {
    statements.push(s.query(`INSERT INTO shipping_costs
        (ship_month, position, ship_date, order_id, sku, qty, cost, carrier, service)
      SELECT $1, v.position - 1, v.ship_date, v.order_id, v.sku, v.qty, v.cost, v.carrier, v.service
      FROM unnest($2::date[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::text[], $8::text[])
        WITH ORDINALITY AS v(ship_date, order_id, sku, qty, cost, carrier, service, position)`,
      [month,
       rows.map(r => r.shipDate),
       rows.map(r => r.orderId ?? ''),
       rows.map(r => r.sku ?? ''),
       rows.map(r => r.qty ?? 0),
       rows.map(r => r.cost),
       rows.map(r => (r.carrier === undefined ? null : r.carrier)),
       rows.map(r => (r.service === undefined ? null : r.service))]));
  }
  await s.transaction(statements);
}
