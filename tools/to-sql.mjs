// Creates the SQL tables, fills them from the kv records in the same
// database, and verifies the two match.
//
// Run from the project root:
//   node tools/to-sql.mjs <table|all> --verify
//   node tools/to-sql.mjs <table|all> --fill
//   node tools/to-sql.mjs <table|all> --fill --target prod --before-switch
// Tables: orders, shipping, sessions, pricechanges, changelog, products,
// mappings. Default target is the dev database.
//
// Databases come from .env.local: dev = DATABASE_URL_DEV, prod =
// DATABASE_URL (an owner role). Nothing here prints a credential.
//
// --fill DROPS and recreates each table from the kv records, in one
// transaction. That is right only before production switches the table on
// in SQL_TABLES; afterwards the table is newer than kv. Production fills
// therefore also require --before-switch.
//
// Verification: row counts, a field-by-field comparison in SQL in both
// directions (kv rows minus table rows, and table rows minus kv rows, must
// both be empty), and the API's own read path compared object-for-object
// with the decoded kv records.

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { neon } from '@neondatabase/serverless';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => import(pathToFileURL(path.join(ROOT, 'lib', name)).href);

const TABLES = {
  orders: {
    ddl: [
      `CREATE TABLE orders (
        order_id            text        NOT NULL,
        sku                 text        NOT NULL,
        order_date          date        NOT NULL,
        asin                text        NOT NULL,
        quantity            integer     NOT NULL,
        item_total          numeric     NOT NULL,
        fulfillment_channel text        NOT NULL,
        is_business_order   boolean     NOT NULL,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (order_id, sku)
      )`,
      'CREATE INDEX orders_order_date_idx ON orders (order_date)'
    ],
    columns: 'order_id, sku, order_date, asin, quantity, item_total, fulfillment_channel, is_business_order',
    kvRows: `SELECT e->>'orderId' AS order_id, e->>'sku' AS sku, (e->>'orderDate')::date AS order_date,
        COALESCE(e->>'asin', '') AS asin, (e->>'quantity')::int AS quantity,
        (e->>'itemTotal')::numeric AS item_total, COALESCE(e->>'fulfillmentChannel', '') AS fulfillment_channel,
        COALESCE((e->>'isBusinessOrder')::boolean, false) AS is_business_order
      FROM kv, jsonb_array_elements(kv.value::jsonb) AS e
      WHERE kv.key ~ '^orders:v2:[0-9]{4}-[0-9]{2}$'`,
    // The API read (lib/orders.js) against the decoded kv records. Row order
    // within a day isn't meaningful, so both sides are sorted.
    async apiCheck(sql, decodeValue) {
      const { getOrders } = await lib('orders.js');
      const key = (r) => `${r.orderDate}\u0000${r.orderId}\u0000${r.sku}`;
      const sort = (rows) => rows.sort((a, b) => key(a).localeCompare(key(b)));
      const buckets = await sql.query("SELECT value FROM kv WHERE key ~ '^orders:v2:[0-9]{4}-[0-9]{2}$'");
      return compareLists(sort(buckets.flatMap(b => decodeValue(b.value))), sort(await getOrders()));
    }
  },

  shipping: {
    ddl: [
      `CREATE TABLE shipping_costs (
        ship_month text        NOT NULL,
        position   integer     NOT NULL,
        ship_date  date        NOT NULL,
        order_id   text        NOT NULL,
        sku        text        NOT NULL,
        qty        integer     NOT NULL,
        cost       numeric     NOT NULL,
        carrier    text,
        service    text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (ship_month, position)
      )`,
      'CREATE INDEX shipping_costs_ship_date_idx ON shipping_costs (ship_date)'
    ],
    columns: 'ship_month, position, ship_date, order_id, sku, qty, cost, carrier, service',
    kvRows: `SELECT substring(kv.key from 14) AS ship_month, (e.ord - 1)::int AS position,
        (e.v->>'shipDate')::date AS ship_date, COALESCE(e.v->>'orderId', '') AS order_id,
        COALESCE(e.v->>'sku', '') AS sku, COALESCE((e.v->>'qty')::int, 0) AS qty,
        (e.v->>'cost')::numeric AS cost, e.v->>'carrier' AS carrier, e.v->>'service' AS service
      FROM kv, jsonb_array_elements(kv.value::jsonb->'rows') WITH ORDINALITY AS e(v, ord)
      WHERE kv.key ~ '^shipping:raw:[0-9]{4}-[0-9]{2}$'`,
    // Month by month, in written order — position is preserved exactly.
    async apiCheck(sql, decodeValue) {
      const { getMonth } = await lib('shipping.js');
      const buckets = await sql.query("SELECT key, value FROM kv WHERE key ~ '^shipping:raw:[0-9]{4}-[0-9]{2}$' ORDER BY key");
      const fromKv = [], fromApi = [];
      for (const b of buckets) {
        fromKv.push(...(decodeValue(b.value)?.rows || []));
        fromApi.push(...await getMonth(b.key.slice('shipping:raw:'.length)));
      }
      return compareLists(fromKv, fromApi);
    }
  },

  sessions: {
    ddl: [
      `CREATE TABLE session_traffic (
        id                      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        date                    date,
        asin                    text,
        sessions                integer     NOT NULL,
        session_percentage      numeric     NOT NULL,
        page_views              integer     NOT NULL,
        unit_session_percentage numeric     NOT NULL,
        buy_box_percentage      numeric     NOT NULL,
        created_at              timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX session_traffic_date_idx ON session_traffic (date)'
    ],
    columns: 'date, asin, sessions, session_percentage, page_views, unit_session_percentage, buy_box_percentage',
    kvRows: `SELECT (e.v->>'date')::date AS date, e.v->>'asin' AS asin, (e.v->>'sessions')::int AS sessions,
        (e.v->>'sessionPercentage')::numeric AS session_percentage, (e.v->>'pageViews')::int AS page_views,
        (e.v->>'unitSessionPercentage')::numeric AS unit_session_percentage,
        (e.v->>'buyBoxPercentage')::numeric AS buy_box_percentage, e.ord
      FROM kv, jsonb_array_elements(kv.value::jsonb) WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = 'session_data'`,
    // Insert in list order so the identity column reproduces it.
    fillOrder: 'ord',
    async apiCheck(sql, decodeValue) {
      const { getAll } = await lib('sessions.js');
      const [rec] = await sql.query("SELECT value FROM kv WHERE key = 'session_data'");
      return compareLists(rec ? decodeValue(rec.value) : [], await getAll());
    }
  },

  pricechanges: entryLog('pricechanges', 'pricechanges:entries', 'price_changes', [
    ['id', 'id', 'text'], ['createdAt', 'created_at', 'text'], ['date', 'date', 'date'],
    ['sku', 'sku', 'text'], ['oldPrice', 'old_price', 'numeric'], ['newPrice', 'new_price', 'numeric']
  ]),

  products: {
    ddl: [
      `CREATE TABLE products (
        position         integer     PRIMARY KEY,
        sku              text        NOT NULL,
        name             text,
        brand            text,
        fulfillment      text,
        cost             numeric,
        asin             text,
        type             text,
        status           text,
        transaction_fees numeric,
        fba_fees         numeric,
        avg_shipping     numeric,
        updated_at       timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX products_sku_idx ON products (sku)'
    ],
    columns: 'position, sku, name, brand, fulfillment, cost, asin, type, status, transaction_fees, fba_fees, avg_shipping',
    kvRows: `SELECT (e.ord - 1)::int AS position, e.v->>'sku' AS sku, e.v->>'name' AS name,
        e.v->>'brand' AS brand, e.v->>'fulfillment' AS fulfillment, (e.v->>'cost')::numeric AS cost,
        e.v->>'asin' AS asin, e.v->>'type' AS type, e.v->>'status' AS status,
        (e.v->>'transactionFees')::numeric AS transaction_fees, (e.v->>'fbaFees')::numeric AS fba_fees,
        (e.v->>'avgShipping')::numeric AS avg_shipping
      FROM kv, jsonb_array_elements(kv.value::jsonb) WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = 'products'`,
    async apiCheck(sql, decodeValue) {
      const { getProducts } = await lib('products.js');
      const [rec] = await sql.query("SELECT value FROM kv WHERE key = 'products'");
      return compareLists(rec ? decodeValue(rec.value) : [], await getProducts());
    }
  },

  mappings: {
    ddl: [
      `CREATE TABLE mapping_entries (
        type       text        NOT NULL,
        position   integer     NOT NULL,
        key        text        NOT NULL,
        value      json        NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (type, position),
        UNIQUE (type, key)
      )`
    ],
    columns: 'type, position, key, value',
    // json has no equality operator; compare its exact text.
    compareColumns: 'type, position, key, value::text AS value',
    // json_each (not jsonb) keeps the object's key order and exact value text.
    kvRows: `SELECT substring(kv.key from 10) AS type, (e.ord - 1)::int AS position, e.key AS key, e.value AS value
      FROM kv, json_each(kv.value::json) WITH ORDINALITY AS e(key, value, ord)
      WHERE kv.key IN ('mappings:product', 'mappings:brand', 'mappings:fee')`,
    // Entries in order, so key order is checked as well as values.
    async apiCheck(sql, decodeValue) {
      const { getMap } = await lib('mappings.js');
      const fromKv = [], fromApi = [];
      for (const type of ['product', 'brand', 'fee']) {
        const [rec] = await sql.query('SELECT value FROM kv WHERE key = $1', [`mappings:${type}`]);
        fromKv.push(...Object.entries(rec ? decodeValue(rec.value) : {}).map(e => [type, ...e]));
        fromApi.push(...Object.entries(await getMap(type)).map(e => [type, ...e]));
      }
      return compareLists(fromKv, fromApi);
    }
  },

  changelog: entryLog('changelog', 'changelog:entries', 'listing_changes', [
    ['id', 'id', 'text'], ['createdAt', 'created_at', 'text'], ['date', 'date', 'date'],
    ['productName', 'product_name', 'text'], ['asin', 'asin', 'text'],
    ['changes', 'changes', 'text'], ['notes', 'notes', 'text']
  ])
};

// An entry log (lib/entries.js): a list kept in the order entries were added.
function entryLog(name, kvKey, table, columns) {
  return {
    ddl: [
      `CREATE TABLE ${table} (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ${columns.map(([, col, type]) => `${col} ${type} NOT NULL`).join(',\n        ')}
      )`,
      `CREATE INDEX ${table}_id_idx ON ${table} (id)`
    ],
    columns: columns.map(([, col]) => col).join(', '),
    kvRows: `SELECT ${columns.map(([field, col, type]) =>
        type === 'text' ? `e.v->>'${field}' AS ${col}` : `(e.v->>'${field}')::${type} AS ${col}`).join(', ')}, e.ord
      FROM kv, jsonb_array_elements(kv.value::jsonb) WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = '${kvKey}'`,
    fillOrder: 'ord',
    async apiCheck(sql, decodeValue) {
      const { getAll } = await lib('entries.js');
      const [rec] = await sql.query('SELECT value FROM kv WHERE key = $1', [kvKey]);
      return compareLists(rec ? decodeValue(rec.value) : [], await getAll(name));
    }
  };
}

function compareLists(expected, actual) {
  let diffs = 0;
  const samples = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (!isDeepStrictEqual(expected[i], actual[i])) {
      diffs++;
      if (samples.length < 3) samples.push(`${JSON.stringify(expected[i])} | ${JSON.stringify(actual[i])}`);
    }
  }
  return { expected: expected.length, actual: actual.length, diffs, samples };
}

function readEnv(name) {
  for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name && m[2]) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new Error(`${name} is missing or empty in .env.local`);
}

const args = process.argv.slice(2);
const which = args[0];
const fill = args.includes('--fill');
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'dev';
const envName = { dev: 'DATABASE_URL_DEV', prod: 'DATABASE_URL' }[target];
const names = which === 'all' ? Object.keys(TABLES) : [which];
if (!names.every(n => TABLES[n]) || !envName || !(fill || args.includes('--verify'))) {
  console.error(`Usage: node tools/to-sql.mjs <${Object.keys(TABLES).join('|')}|all> --verify | --fill [--target dev|prod]`);
  process.exit(1);
}
if (fill && target === 'prod' && !args.includes('--before-switch')) {
  console.error('Refusing a production fill without --before-switch: once production reads a table, refilling it from kv would overwrite newer data.');
  process.exit(1);
}

const dbUrl = readEnv(envName);
process.env.DATABASE_URL = dbUrl;     // for the lib/ read paths in apiCheck
const sql = neon(dbUrl);
const { decodeValue } = await lib('kv.js');
console.log(`Target: ${target} database`);

let allOk = true;
for (const name of names) {
  const t = TABLES[name];
  const table = t.ddl[0].match(/CREATE TABLE (\w+)/)[1];
  if (fill) {
    await sql.transaction([
      sql.query(`DROP TABLE IF EXISTS ${table}`),
      ...t.ddl.map(d => sql.query(d)),
      sql.query(`INSERT INTO ${table} (${t.columns}) SELECT ${t.columns} FROM (${t.kvRows}) src` +
        (t.fillOrder ? ` ORDER BY src.${t.fillOrder}` : ''))
    ]);
  }
  const cmp = t.compareColumns || t.columns;
  const tableRows = `SELECT ${cmp} FROM ${table}`;
  const kvRows = `SELECT ${cmp} FROM (${t.kvRows}) src`;
  const [counts] = await sql.query(`SELECT (SELECT count(*) FROM (${kvRows}) a)::int AS kv, (SELECT count(*) FROM ${table})::int AS tbl`);
  const [onlyKv] = await sql.query(`SELECT count(*)::int AS n FROM ((${kvRows}) EXCEPT ALL (${tableRows})) d`);
  const [onlyTable] = await sql.query(`SELECT count(*)::int AS n FROM ((${tableRows}) EXCEPT ALL (${kvRows})) d`);
  const api = await t.apiCheck(sql, decodeValue);
  const ok = counts.kv === counts.tbl && onlyKv.n === 0 && onlyTable.n === 0 && api.diffs === 0 && api.expected === api.actual;
  allOk &&= ok;
  console.log(`\n${name}${fill ? ' (filled)' : ''}: kv rows ${counts.kv} · table rows ${counts.tbl} · only in kv ${onlyKv.n} · only in table ${onlyTable.n}`);
  console.log(`  API read vs kv records: ${api.actual} vs ${api.expected} objects, ${api.diffs} differ`);
  api.samples.forEach(s => console.log('  differs:', s));
  console.log(`  ${ok ? 'VERIFIED' : 'VERIFY FAILED'}`);
}
process.exit(allOk ? 0 : 1);
