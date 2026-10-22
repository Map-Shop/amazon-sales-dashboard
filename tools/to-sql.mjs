// Creates the SQL tables, fills them from the kv records in the same
// database, and verifies the two match.
//
// Run from the project root:
//   node tools/to-sql.mjs <table|all> --verify
//   node tools/to-sql.mjs <table|all> --fill
// Tables: orders, shipping, sessions, pricechanges, changelog, products,
// mappings, adspend, transactions (three tables, filled together). The
// target is the dev database (DATABASE_URL_DEV in .env.local). Nothing here
// prints a credential.
//
// Production's kv data records were deleted once the tables were live, so a
// dev branch reset from production already has the tables and needs no
// fill; a fill refuses any table whose kv records are gone rather than
// rebuild it empty.
//
// --fill DROPS and recreates each table from the kv records, in one
// transaction. Production was filled this way once, just before it switched
// to the tables on 2026-10-22. It is refused there now: production writes
// only to the tables, its kv records are frozen at the switch, and a fill
// would overwrite newer data (a verify would only report the difference).
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
const { rawExtracted, RAW_EXTRACTED_COLUMNS } = await lib('transactions.js');

// A data set stored in more than one table fills and verifies them together.
const GROUPS = { transactions: ['transactions-raw', 'transactions-months', 'transactions-imported'] };

// readMonthV2024's kv reassembly, in SQL: a month record holding its own
// transactions array is used as-is; otherwise its parts p0..p(chunkCount-1)
// in order.
const RAW_MONTH_PARTS = `
  WITH base AS (
    SELECT split_part(key, ':', 4) AS month, value::json AS v
    FROM kv WHERE key ~ '^transactions:v2024:raw:[0-9]{4}-[0-9]{2}$'
  ), parts AS (
    SELECT month, 0 AS part, v->'transactions' AS arr
    FROM base WHERE json_typeof(v->'transactions') = 'array'
    UNION ALL
    SELECT b.month, split_part(k.key, ':p', 2)::int, k.value::json->'transactions'
    FROM base b JOIN kv k ON k.key LIKE 'transactions:v2024:raw:' || b.month || ':p%'
    WHERE json_typeof(b.v->'transactions') IS DISTINCT FROM 'array'
      AND json_typeof(b.v->'chunkCount') = 'number'
      AND split_part(k.key, ':p', 2)::int < (b.v->>'chunkCount')::int
  )
  SELECT p.month, p.part, e.d, e.ord
  FROM parts p, json_array_elements(p.arr) WITH ORDINALITY AS e(d, ord)`;

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

  adspend: {
    ddl: [
      `CREATE TABLE ad_spend_rows (
        ad_type     text        NOT NULL,
        month       text        NOT NULL,
        position    integer     NOT NULL,
        date        date,
        campaign    text,
        ad_group    text,
        sku         text,
        asin        text,
        campaign_id json,
        cost        numeric,
        impressions numeric,
        clicks      numeric,
        purchases7d numeric,
        sales7d     numeric,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (ad_type, month, position)
      )`,
      'CREATE INDEX ad_spend_rows_date_idx ON ad_spend_rows (ad_type, date)',
      'CREATE INDEX ad_spend_rows_sku_idx ON ad_spend_rows (sku)'
    ],
    columns: 'ad_type, month, position, date, campaign, ad_group, sku, asin, campaign_id, cost, impressions, clicks, purchases7d, sales7d',
    compareColumns: 'ad_type, month, position, date, campaign, ad_group, sku, asin, campaign_id::text AS campaign_id, cost, impressions, clicks, purchases7d, sales7d',
    kvRows: `SELECT split_part(kv.key, ':', 2) AS ad_type, split_part(kv.key, ':', 4) AS month,
        (e.ord - 1)::int AS position, (e.v->>'date')::date AS date, e.v->>'campaign' AS campaign,
        e.v->>'adGroup' AS ad_group, e.v->>'sku' AS sku, e.v->>'asin' AS asin,
        (e.v->'campaignId')::text::json AS campaign_id, (e.v->>'cost')::numeric AS cost,
        (e.v->>'impressions')::numeric AS impressions, (e.v->>'clicks')::numeric AS clicks,
        (e.v->>'purchases7d')::numeric AS purchases7d, (e.v->>'sales7d')::numeric AS sales7d
      FROM kv, jsonb_array_elements(kv.value::jsonb->'rows') WITH ORDINALITY AS e(v, ord)
      WHERE kv.key ~ '^adspend:(sp|sb):raw:[0-9]{4}-[0-9]{2}$'`,
    async apiCheck(sql, decodeValue) {
      const { getMonth } = await lib('adspend.js');
      const buckets = await sql.query("SELECT key, value FROM kv WHERE key ~ '^adspend:(sp|sb):raw:[0-9]{4}-[0-9]{2}$' ORDER BY key");
      const fromKv = [], fromApi = [];
      for (const b of buckets) {
        const [, type, , month] = b.key.split(':');
        fromKv.push(...(decodeValue(b.value)?.rows || []));
        fromApi.push(...await getMonth(type, month));
      }
      return compareLists(fromKv, fromApi);
    }
  },

  'transactions-raw': {
    ddl: [
      `CREATE TABLE amazon_transactions (
        month              text        NOT NULL,
        position           integer     NOT NULL,
        data               json        NOT NULL,
        posted_date        text,
        transaction_type   text,
        transaction_status text,
        order_id           text,
        shipment_id        text,
        refund_id          text,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (month, position)
      )`,
      'CREATE INDEX amazon_transactions_posted_idx ON amazon_transactions (posted_date)',
      'CREATE INDEX amazon_transactions_order_idx ON amazon_transactions (order_id)',
      'CREATE INDEX amazon_transactions_shipment_idx ON amazon_transactions (shipment_id)'
    ],
    columns: `month, position, data, ${RAW_EXTRACTED_COLUMNS}`,
    // Each record compared by the MD5 of its exact JSON text.
    compareColumns: `month, position, md5(data::text) AS data_md5, ${RAW_EXTRACTED_COLUMNS}`,
    kvRows: `SELECT month, (row_number() OVER (PARTITION BY month ORDER BY part, ord) - 1)::int AS position,
        d AS data, ${rawExtracted('d').map(([col, expr]) => `${expr} AS ${col}`).join(', ')}
      FROM (${RAW_MONTH_PARTS}) elems`,
    // Month by month: kv reassembly (as readMonthV2024 does it) vs the table.
    async apiCheck(sql, decodeValue) {
      const { getRawMonth } = await lib('transactions.js');
      // One month per query: all months at once exceeds Neon's 64 MB response cap.
      const keys = await sql.query("SELECT key FROM kv WHERE key ~ '^transactions:v2024:raw:[0-9]{4}-[0-9]{2}$' ORDER BY key");
      let result = { expected: 0, actual: 0, diffs: 0, samples: [] };
      for (const { key } of keys) {
        const [b] = await sql.query('SELECT key, value FROM kv WHERE key = $1', [key]);
        const month = b.key.split(':')[3];
        const meta = decodeValue(b.value);
        let fromKv;
        if (Array.isArray(meta?.transactions)) fromKv = meta.transactions;
        else {
          fromKv = [];
          for (let k = 0; k < (meta?.chunkCount || 0); k++) {
            const [part] = await sql.query('SELECT value FROM kv WHERE key = $1', [`${b.key}:p${k}`]);
            fromKv.push(...((part && decodeValue(part.value)?.transactions) || []));
          }
        }
        const r = compareLists(fromKv, await getRawMonth(month));
        result = { expected: result.expected + r.expected, actual: result.actual + r.actual,
          diffs: result.diffs + r.diffs, samples: [...result.samples, ...r.samples].slice(0, 3) };
      }
      return result;
    }
  },

  'transactions-months': {
    ddl: [
      `CREATE TABLE transaction_months (
        month             text        PRIMARY KEY,
        has_raw           boolean     NOT NULL,
        transaction_count integer     NOT NULL,
        updated_at        timestamptz NOT NULL DEFAULT now()
      )`
    ],
    columns: 'month, has_raw, transaction_count',
    // The upload's hasRaw rule: a non-empty transactions array, or chunkCount > 0.
    kvRows: `SELECT split_part(key, ':', 4) AS month,
        CASE WHEN json_typeof(v->'transactions') = 'array' THEN json_array_length(v->'transactions') > 0
             ELSE COALESCE(json_typeof(v->'chunkCount') = 'number' AND (v->>'chunkCount')::numeric > 0, false) END AS has_raw,
        CASE WHEN json_typeof(v->'transactions') = 'array' THEN json_array_length(v->'transactions')
             ELSE COALESCE((v->>'totalCount')::int, 0) END AS transaction_count
      FROM (SELECT key, value::json AS v FROM kv WHERE key ~ '^transactions:v2024:raw:[0-9]{4}-[0-9]{2}$') b`,
    async apiCheck(sql, decodeValue) {
      const { rawMonthHasData } = await lib('transactions.js');
      const keys = await sql.query("SELECT key FROM kv WHERE key ~ '^transactions:v2024:raw:[0-9]{4}-[0-9]{2}$' ORDER BY key");
      const fromKv = [], fromApi = [];
      for (const { key } of keys) {
        const [b] = await sql.query('SELECT key, value FROM kv WHERE key = $1', [key]);
        const month = b.key.split(':')[3];
        const raw = decodeValue(b.value);
        fromKv.push([month, Boolean(raw && (Array.isArray(raw.transactions) && raw.transactions.length > 0 ||
          Number.isFinite(raw.chunkCount) && raw.chunkCount > 0))]);
        fromApi.push([month, await rawMonthHasData(month)]);
      }
      return compareLists(fromKv, fromApi);
    }
  },

  'transactions-imported': {
    ddl: [
      `CREATE TABLE imported_transaction_rows (
        month              text        NOT NULL,
        position           integer     NOT NULL,
        type               text,
        order_id           text,
        date               date,
        sku                text,
        qty                numeric,
        fulfillment        text,
        sale               numeric,
        other_charges      numeric,
        fba_fees           numeric,
        transaction_fees   numeric,
        promotions         numeric,
        fee_type           text,
        fee_amount         numeric,
        adjustment_type    text,
        adjustment_amount  numeric,
        src                text,
        transaction_id     text,
        transaction_status text,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (month, position)
      )`,
      'CREATE INDEX imported_transaction_rows_date_idx ON imported_transaction_rows (date)'
    ],
    columns: 'month, position, type, order_id, date, sku, qty, fulfillment, sale, other_charges, fba_fees, transaction_fees, promotions, fee_type, fee_amount, adjustment_type, adjustment_amount, src, transaction_id, transaction_status',
    kvRows: `SELECT split_part(kv.key, ':', 4) AS month, (e.ord - 1)::int AS position,
        e.v->>'type' AS type, e.v->>'orderId' AS order_id, (e.v->>'date')::date AS date, e.v->>'sku' AS sku,
        (e.v->>'qty')::numeric AS qty, e.v->>'fulfillment' AS fulfillment, (e.v->>'sale')::numeric AS sale,
        (e.v->>'otherCharges')::numeric AS other_charges, (e.v->>'fbaFees')::numeric AS fba_fees,
        (e.v->>'transactionFees')::numeric AS transaction_fees, (e.v->>'promotions')::numeric AS promotions,
        e.v->>'feeType' AS fee_type, (e.v->>'feeAmount')::numeric AS fee_amount,
        e.v->>'adjustmentType' AS adjustment_type, (e.v->>'adjustmentAmount')::numeric AS adjustment_amount,
        e.v->>'_src' AS src, e.v->>'_transactionId' AS transaction_id, e.v->>'_transactionStatus' AS transaction_status
      FROM kv, jsonb_array_elements(kv.value::jsonb->'rows') WITH ORDINALITY AS e(v, ord)
      WHERE kv.key ~ '^transactions:v2024:imported:[0-9]{4}-[0-9]{2}$'`,
    async apiCheck(sql, decodeValue) {
      const { getImportedMonth } = await lib('transactions.js');
      const buckets = await sql.query("SELECT key, value FROM kv WHERE key ~ '^transactions:v2024:imported:[0-9]{4}-[0-9]{2}$' ORDER BY key");
      const fromKv = [], fromApi = [];
      for (const b of buckets) {
        fromKv.push(...(decodeValue(b.value)?.rows || []));
        fromApi.push(...await getImportedMonth(b.key.split(':')[3]));
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

// Equal values AND equal field order (JSON text), item by item.
function compareLists(expected, actual) {
  let diffs = 0;
  const samples = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (!isDeepStrictEqual(expected[i], actual[i]) || JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
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
const names = which === 'all' ? Object.keys(TABLES) : (GROUPS[which] || [which]);
if (target === 'prod') {
  console.error('Refusing to target production: it has read and written the SQL tables since 2026-10-22, and its kv records are frozen at the switch. A fill would overwrite newer data.');
  process.exit(1);
}
if (!names.every(n => TABLES[n]) || !envName || !(fill || args.includes('--verify'))) {
  console.error(`Usage: node tools/to-sql.mjs <${Object.keys(TABLES).join('|')}|all> --verify | --fill`);
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
    // Never rebuild a table from nothing. Production's kv data records were
    // deleted after the switch, so a dev branch reset from production has the
    // tables but no records to fill them from.
    const [{ n: sourceRows }] = await sql.query(`SELECT count(*)::int AS n FROM (${t.kvRows}) src`);
    if (sourceRows === 0) {
      console.log(`${name}: no kv records to fill from — table left as it is`);
      allOk = false;
      continue;
    }
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
