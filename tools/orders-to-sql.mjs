// Creates the `orders` table, fills it from the orders:v2:YYYY-MM records
// in the same database's kv table, and verifies the two match.
//
// Run from the project root:
//   node tools/orders-to-sql.mjs --verify             compare only (dev database)
//   node tools/orders-to-sql.mjs --fill               create, fill, verify (dev database)
//   node tools/orders-to-sql.mjs --fill --target prod  same, against production
//
// Databases come from .env.local: dev = DATABASE_URL_DEV, prod =
// DATABASE_URL (an owner role). Nothing here prints a credential.
//
// --fill REPLACES the whole orders table with what the kv records hold, in
// one transaction. That's right before production switches to
// ORDERS_STORE=sql, and wrong after: by then the table is newer than kv.
//
// Verification is two-sided: every field of every row is compared in SQL
// (kv minus table and table minus kv must both be empty), then the API's
// own read (lib/orders.js getOrders) is compared object-for-object with
// the decoded kv records.

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { neon } from '@neondatabase/serverless';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fill = args.includes('--fill');
const verify = args.includes('--verify') || fill;
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'dev';
const envName = { dev: 'DATABASE_URL_DEV', prod: 'DATABASE_URL' }[target];
if (!envName || !verify) {
  console.error('Usage: node tools/orders-to-sql.mjs --verify | --fill [--target dev|prod]');
  process.exit(1);
}

function readEnv(name) {
  for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name && m[2]) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new Error(`${name} is missing or empty in .env.local`);
}

const dbUrl = readEnv(envName);
const sql = neon(dbUrl);
const BUCKET_KEYS = `key ~ '^orders:v2:[0-9]{4}-[0-9]{2}$'`;
// Every stored field of an order line, typed to match the table.
const KV_ROWS = `SELECT e->>'orderId' AS order_id, e->>'sku' AS sku, (e->>'orderDate')::date AS order_date,
    COALESCE(e->>'asin', '') AS asin, (e->>'quantity')::int AS quantity,
    (e->>'itemTotal')::numeric AS item_total, COALESCE(e->>'fulfillmentChannel', '') AS fulfillment_channel,
    COALESCE((e->>'isBusinessOrder')::boolean, false) AS is_business_order
  FROM kv, jsonb_array_elements(kv.value::jsonb) AS e WHERE ${BUCKET_KEYS}`;
const TABLE_ROWS = `SELECT order_id, sku, order_date, asin, quantity, item_total,
    fulfillment_channel, is_business_order FROM orders`;

console.log(`Target: ${target} database`);

if (fill) {
  await sql.transaction([
    sql.query(`CREATE TABLE IF NOT EXISTS orders (
      order_id            text          NOT NULL,
      sku                 text          NOT NULL,
      order_date          date          NOT NULL,
      asin                text          NOT NULL,
      quantity            integer       NOT NULL,
      item_total          numeric(12,2) NOT NULL,
      fulfillment_channel text          NOT NULL,
      is_business_order   boolean       NOT NULL,
      updated_at          timestamptz   NOT NULL DEFAULT now(),
      PRIMARY KEY (order_id, sku)
    )`),
    sql.query('CREATE INDEX IF NOT EXISTS orders_order_date_idx ON orders (order_date)'),
    sql.query('TRUNCATE orders'),
    sql.query(`INSERT INTO orders (order_id, sku, order_date, asin, quantity, item_total,
        fulfillment_channel, is_business_order) ${KV_ROWS}`)
  ]);
  console.log('Filled the orders table from the kv records.');
}

// 1. Counts per month, both sides.
const perMonth = await sql.query(`
  WITH k AS (SELECT to_char(order_date, 'YYYY-MM') AS m, count(*) AS n, sum(item_total) AS s FROM (${KV_ROWS}) x GROUP BY 1),
       t AS (SELECT to_char(order_date, 'YYYY-MM') AS m, count(*) AS n, sum(item_total) AS s FROM orders GROUP BY 1)
  SELECT COALESCE(k.m, t.m) AS month, k.n::int AS kv_rows, t.n::int AS table_rows, k.s AS kv_sales, t.s AS table_sales
  FROM k FULL JOIN t ON k.m = t.m ORDER BY 1`);
const monthMismatches = perMonth.filter(r => r.kv_rows !== r.table_rows || Number(r.kv_sales) !== Number(r.table_sales));
const totalKv = perMonth.reduce((n, r) => n + (r.kv_rows || 0), 0);
const totalTable = perMonth.reduce((n, r) => n + (r.table_rows || 0), 0);
console.log(`Months: ${perMonth.length} · kv rows: ${totalKv} · table rows: ${totalTable} · months that differ: ${monthMismatches.length}`);
monthMismatches.slice(0, 10).forEach(r => console.log('  differs:', r));

// 2. Field-by-field, both directions.
const [onlyKv] = await sql.query(`SELECT count(*)::int AS n FROM ((${KV_ROWS}) EXCEPT ALL (${TABLE_ROWS})) d`);
const [onlyTable] = await sql.query(`SELECT count(*)::int AS n FROM ((${TABLE_ROWS}) EXCEPT ALL (${KV_ROWS})) d`);
console.log(`Rows only in kv: ${onlyKv.n} · rows only in the table: ${onlyTable.n}`);

// 3. The API's read path vs the decoded kv records, object for object.
process.env.DATABASE_URL = dbUrl;
const { getOrders } = await import(pathToFileURL(path.join(ROOT, 'lib', 'orders.js')).href);
const { decodeValue } = await import(pathToFileURL(path.join(ROOT, 'lib', 'kv.js')).href);
const buckets = await sql.query(`SELECT value FROM kv WHERE ${BUCKET_KEYS}`);
const sortKey = (r) => `${r.orderDate}\u0000${r.orderId}\u0000${r.sku}`;
const fromKv = buckets.flatMap(b => decodeValue(b.value)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
const fromApi = (await getOrders()).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
let objectDiffs = 0;
for (let i = 0; i < Math.max(fromKv.length, fromApi.length); i++) {
  if (!isDeepStrictEqual(fromKv[i], fromApi[i])) {
    if (objectDiffs < 5) console.log('  object differs:', JSON.stringify(fromKv[i]), '|', JSON.stringify(fromApi[i]));
    objectDiffs++;
  }
}
console.log(`API read vs kv records: ${fromApi.length} vs ${fromKv.length} objects, ${objectDiffs} differ`);

const ok = monthMismatches.length === 0 && onlyKv.n === 0 && onlyTable.n === 0 && objectDiffs === 0 && totalKv === totalTable;
console.log(ok ? '\nVERIFIED: the orders table matches the kv records exactly.' : '\nVERIFY FAILED');
process.exit(ok ? 0 : 1);
