// Creates the SQL tables, fills them from the kv records in the same
// database, and verifies the two match.
//
// Run from the project root:
//   node tools/to-sql.mjs <table|group|all> --verify
//   node tools/to-sql.mjs <table|group|all> --fill
// Tables: orders, shipping, sessions, pricechanges, changelog, products,
// mappings, adspend, transactions (three tables, filled together), and the
// groups adcampaigns, adreviews, adspendops, ordersops, stamps. The target
// is the dev database (DATABASE_URL_DEV in .env.local); production is
// refused. Nothing here prints a credential.
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
const { recordColumns, recordValues, recordCompareColumns, toRecord } = await lib('records.js');
const adcensus = await lib('adcensus.js');
const adreviews = await lib('adreviews.js');
const adspendops = await lib('adspendops.js');
const ordersops = await lib('ordersops.js');
const stamps = await lib('stamps.js');
const specColumnDefs = (spec) => spec.map(([, col, type]) => `${col} ${type}`).join(',\n        ');

// The review records and where each lives in the tables.
const REVIEW_SLOTS = [
  ['weekly:lastrun', 'weekly', 'run'], ['biweekly:lastrun', 'biweekly', 'run'],
  ['monthly:lastrun', 'monthly', 'run'], ['biweekly:available', 'biweekly', 'available']
];

// A data set stored in more than one table fills and verifies them together.
const GROUPS = {
  transactions: ['transactions-raw', 'transactions-months', 'transactions-imported'],
  // Rows before the snapshot documents, whose check reads them back whole.
  adcampaigns: ['ad-campaigns', 'ad-portfolios', 'ad-census', 'ad-census-syncs',
                'ad-brand-overrides', 'campaign-changes'],
  adreviews: ['ad-review-runs', 'review-notes', 'brand-postures', 'ad-cron-jobs'],
  // Rollup rows before the year table, whose check reads both back whole.
  adspendops: ['ad-spend-months', 'ad-spend-month-syncs', 'ad-spend-report-queue',
               'ad-spend-weeks', 'ad-spend-week-years'],
  ordersops: ['orders-sync-status', 'orders-alerts', 'orders-report-queue', 'orders-report-results'],
  stamps: ['shipping-months', 'shipping-month-syncs', 'transaction-month-syncs', 'edit-stamps']
};

// A set of kv records each holding one bare string (kv keeps a string as its
// own text), keyed by part of the record's key, as a two-column table.
function stringRecords({ table, keyCol, valueCol, keyPattern, keyExpr, read, keyOf }) {
  return {
    ddl: [`CREATE TABLE ${table} (${keyCol} text PRIMARY KEY, ${valueCol} text)`],
    columns: `${keyCol}, ${valueCol}`,
    kvRows: `SELECT ${keyExpr} AS ${keyCol}, kv.value AS ${valueCol} FROM kv WHERE kv.key ~ '${keyPattern}'`,
    async apiCheck(sql, decodeValue) {
      const recs = await sql.query(`SELECT key, value FROM kv WHERE key ~ '${keyPattern}' ORDER BY key`);
      const actual = [];
      for (const r of recs) actual.push(await read(keyOf(r.key)));
      return compareLists(recs.map(r => decodeValue(r.value)), actual);
    }
  };
}

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
  ]),

  // ── Campaign census (lib/adcensus.js) ─────────────────────────────────
  'ad-campaigns': recordRows({
    table: 'ad_campaigns', key: 'adcampaigns:current', spec: adcensus.CAMPAIGN_SPEC,
    extraDdl: ['CREATE INDEX ad_campaigns_campaign_idx ON ad_campaigns (campaign_id)'],
    read: () => adcensus.getCampaignRows()
  }),

  'ad-portfolios': recordRows({
    table: 'ad_portfolios', key: 'adcampaigns:portfolios', spec: adcensus.PORTFOLIO_SPEC,
    read: () => adcensus.getPortfolioRows()
  }),

  // When each snapshot was taken. Its check reads both snapshots back whole.
  'ad-census': {
    ddl: [
      `CREATE TABLE ad_census (
        doc        text        PRIMARY KEY,
        synced_at  text,
        pt_date    text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`
    ],
    columns: 'doc, synced_at, pt_date',
    kvRows: `SELECT 'campaigns' AS doc, c.v->>'syncedAt' AS synced_at, c.v->>'ptDate' AS pt_date
        FROM (SELECT value::json AS v FROM kv WHERE key = 'adcampaigns:current') c
      UNION ALL
      SELECT 'portfolios', p.v->>'syncedAt', NULL
        FROM (SELECT value::json AS v FROM kv WHERE key = 'adcampaigns:portfolios') p`,
    async apiCheck(sql, decodeValue) {
      const read = async (key) => { const [r] = await sql.query('SELECT value FROM kv WHERE key = $1', [key]); return r ? decodeValue(r.value) : null; };
      return compareLists([await read('adcampaigns:current'), await read('adcampaigns:portfolios')],
                          [await adcensus.getCampaigns(), await adcensus.getPortfolios()]);
    }
  },

  // The refresh status: one row per refresh from here on, the latest being
  // what adcampaigns:meta held.
  'ad-census-syncs': {
    ddl: [
      `CREATE TABLE ad_census_syncs (
        id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ${adcensus.SYNC_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields      text[]      NOT NULL,
        extra       json,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )`
    ],
    columns: recordColumns(adcensus.SYNC_SPEC),
    compareColumns: recordCompareColumns(adcensus.SYNC_SPEC),
    kvRows: `SELECT ${recordValues(adcensus.SYNC_SPEC, 'm.v', { aliased: true })}
      FROM (SELECT value::json AS v FROM kv WHERE key = 'adcampaigns:meta') m`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'adcampaigns:meta'");
      return compareLists([r ? decodeValue(r.value) : null], [await adcensus.getStatus()]);
    }
  },

  'ad-brand-overrides': {
    allowEmpty: true,   // nobody may have set one
    ddl: [
      `CREATE TABLE ad_brand_overrides (
        position    integer PRIMARY KEY,
        campaign_id text    NOT NULL UNIQUE,
        ${adcensus.OVERRIDE_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields      text[]  NOT NULL,
        extra       json
      )`
    ],
    columns: `position, campaign_id, ${recordColumns(adcensus.OVERRIDE_SPEC)}`,
    compareColumns: `position, campaign_id, ${recordCompareColumns(adcensus.OVERRIDE_SPEC)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, e.k AS campaign_id,
        ${recordValues(adcensus.OVERRIDE_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_each(kv.value::json) WITH ORDINALITY AS e(k, v, ord)
      WHERE kv.key = 'adcampaigns:overrides'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'adcampaigns:overrides'");
      // The page treats an absent record and an empty one alike.
      const fromKv = r ? decodeValue(r.value) : null;
      return compareLists([fromKv && Object.keys(fromKv).length ? fromKv : null], [await adcensus.getOverrides()]);
    }
  },

  // The change log. This table may already hold history the kv log has
  // evicted (lib/adhistory.js has been recording it), so it is merged into,
  // never dropped: the kv log's records are upserted in the log's order, after
  // everything older, keeping any recorded origin. Verified by reading the
  // page's capped log back from the table.
  'campaign-changes': {
    ddl: [`CREATE TABLE IF NOT EXISTS campaign_changes (id text PRIMARY KEY)`],
    async fill(sql) {
      const { DDL } = await lib('adhistory.js');
      for (const d of DDL) await sql.query(d);
      await sql.transaction([
        // Rows recorded before the table had an order: oldest first.
        sql.query(`UPDATE campaign_changes c SET seq = n.rn
          FROM (SELECT id, row_number() OVER (ORDER BY changed_at NULLS FIRST, id) AS rn
                FROM campaign_changes WHERE seq IS NULL) n
          WHERE c.id = n.id`),
        sql.query(`INSERT INTO campaign_changes (id, campaign_id, field, pt_date, changed_at, source, origin, data, seq)
          SELECT e.d->>'id', e.d->>'campaignId', e.d->>'field',
            CASE WHEN e.d->>'ptDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (e.d->>'ptDate')::date END,
            CASE WHEN e.d->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (e.d->>'at')::timestamptz END,
            e.d->>'source', NULL, e.d,
            (SELECT coalesce(max(seq), 0) FROM campaign_changes) + e.ord
          FROM kv, json_array_elements(kv.value::json->'rows') WITH ORDINALITY AS e(d, ord)
          WHERE kv.key = 'adcampaigns:changes'
          ON CONFLICT (id) DO UPDATE SET
            campaign_id = EXCLUDED.campaign_id, field = EXCLUDED.field, pt_date = EXCLUDED.pt_date,
            changed_at = EXCLUDED.changed_at, source = EXCLUDED.source,
            origin = COALESCE(EXCLUDED.origin, campaign_changes.origin), data = EXCLUDED.data,
            seq = EXCLUDED.seq`),
        sql.query(`SELECT setval('campaign_changes_seq', GREATEST((SELECT coalesce(max(seq), 0) FROM campaign_changes), 1))`)
      ]);
    },
    async verify(sql, decodeValue) {
      const { getRecentChanges } = await lib('adhistory.js');
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'adcampaigns:changes'");
      const log = r ? (decodeValue(r.value).rows || []) : [];
      const [{ n }] = await sql.query('SELECT count(*)::int AS n FROM campaign_changes');
      const cmp = compareLists(log, await getRecentChanges(200));
      return {
        ok: n >= log.length && cmp.diffs === 0 && cmp.expected === cmp.actual,
        summary: `kv log ${log.length} · table rows ${n} · page log read from the table: ${cmp.actual} records, ${cmp.diffs} differ`,
        samples: cmp.samples
      };
    }
  },

  // ── Ad reviews (lib/adreviews.js) ─────────────────────────────────────
  // The runs. ad_review_runs may already hold history (lib/adhistory.js), so
  // it is merged into, never dropped: history rows still carrying inputs as
  // json get them as ad_review_inputs rows, then each kv record (every
  // cadence's run, the bi-weekly fetch) is stored through the app's own
  // saveSlot. Verified by reading every record back through getSlot.
  'ad-review-runs': {
    ddl: ['CREATE TABLE IF NOT EXISTS ad_review_runs (cadence text)'],
    async fill(sql, decodeValue) {
      const { DDL } = await lib('adhistory.js');
      for (const d of [...DDL, ...adreviews.RUN_DDL]) await sql.query(d);
      const legacy = await sql.query('SELECT cadence, collected_at, run_window, inputs FROM ad_review_runs WHERE inputs IS NOT NULL');
      for (const r of legacy) {
        await sql.transaction(adreviews.runStatements(sql, r.cadence, r.collected_at, r.run_window, r.inputs));
      }
      for (const [key, cadence, slot] of REVIEW_SLOTS) {
        const [rec] = await sql.query('SELECT value FROM kv WHERE key = $1', [key]);
        if (rec) await adreviews.saveSlot(cadence, slot, decodeValue(rec.value));
      }
    },
    async verify(sql, decodeValue) {
      const expected = [], actual = [];
      for (const [key, cadence, slot] of REVIEW_SLOTS) {
        const [rec] = await sql.query('SELECT value FROM kv WHERE key = $1', [key]);
        expected.push(rec ? decodeValue(rec.value) : null);
        actual.push(await adreviews.getSlot(cadence, slot));
      }
      const cmp = compareLists(expected, actual);
      const [{ runs, withJson, inputs }] = await sql.query(`SELECT (SELECT count(*) FROM ad_review_runs)::int AS runs,
        (SELECT count(*) FROM ad_review_runs WHERE inputs IS NOT NULL)::int AS "withJson",
        (SELECT count(*) FROM ad_review_inputs)::int AS inputs`);
      return {
        ok: cmp.diffs === 0 && withJson === 0,
        summary: `${REVIEW_SLOTS.length} records read back: ${cmp.diffs} differ · runs ${runs} · campaign input rows ${inputs} · runs still holding json inputs ${withJson}`,
        samples: cmp.samples
      };
    }
  },

  'review-notes': {
    allowEmpty: true,
    ddl: [
      `CREATE TABLE review_notes (
        position integer PRIMARY KEY,
        note_key text    NOT NULL UNIQUE,
        ${adreviews.NOTE_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields   text[]  NOT NULL,
        extra    json
      )`
    ],
    columns: `position, note_key, ${recordColumns(adreviews.NOTE_SPEC)}`,
    compareColumns: `position, note_key, ${recordCompareColumns(adreviews.NOTE_SPEC)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, e.k AS note_key,
        ${recordValues(adreviews.NOTE_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_each(kv.value::json->'notes') WITH ORDINALITY AS e(k, v, ord)
      WHERE kv.key = 'weekly:notes'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'weekly:notes'");
      const fromKv = r ? decodeValue(r.value) : null;
      // The page treats no notes and an empty set alike.
      return compareLists([fromKv && Object.keys(fromKv.notes || {}).length ? fromKv : null], [await adreviews.getNotes()]);
    }
  },

  'brand-postures': {
    allowEmpty: true,
    ddl: [
      `CREATE TABLE brand_postures (
        position integer PRIMARY KEY,
        brand    text    NOT NULL UNIQUE,
        posture  text
      )`
    ],
    columns: 'position, brand, posture',
    kvRows: `SELECT (e.ord - 1)::int AS position, e.k AS brand, e.v AS posture
      FROM kv, json_each_text(kv.value::json) WITH ORDINALITY AS e(k, v, ord)
      WHERE kv.key = 'biweekly:posture'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'biweekly:posture'");
      const fromKv = r ? decodeValue(r.value) : null;
      return compareLists([fromKv && Object.keys(fromKv).length ? fromKv : null], [await adreviews.getPostures()]);
    }
  },

  'ad-cron-jobs': {
    allowEmpty: true,
    ddl: [
      `CREATE TABLE ad_cron_jobs (
        job        text        PRIMARY KEY,
        ${adreviews.CRON_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields     text[]      NOT NULL,
        extra      json,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`
    ],
    columns: `job, ${recordColumns(adreviews.CRON_SPEC)}`,
    compareColumns: `job, ${recordCompareColumns(adreviews.CRON_SPEC)}`,
    kvRows: `SELECT j.job, ${recordValues(adreviews.CRON_SPEC, 'j.v', { aliased: true })}
      FROM (SELECT CASE key WHEN 'ads:cron:pending' THEN 'ads' ELSE 'monthly' END AS job, value::json AS v
            FROM kv WHERE key IN ('ads:cron:pending', 'monthly:cron:pending')) j`,
    async apiCheck(sql, decodeValue) {
      const expected = [], actual = [];
      for (const [key, job] of [['ads:cron:pending', 'ads'], ['monthly:cron:pending', 'monthly']]) {
        const [r] = await sql.query('SELECT value FROM kv WHERE key = $1', [key]);
        expected.push(r ? decodeValue(r.value) : null);
        actual.push(await adreviews.getCronJob(job));
      }
      return compareLists(expected, actual);
    }
  },

  // ── Ad spend bookkeeping (lib/adspendops.js) ──────────────────────────
  'ad-spend-months': {
    ddl: [
      `CREATE TABLE ad_spend_months (
        ad_type  text    NOT NULL,
        position integer NOT NULL,
        month    text    NOT NULL,
        PRIMARY KEY (ad_type, position)
      )`
    ],
    columns: 'ad_type, position, month',
    kvRows: `SELECT split_part(kv.key, ':', 2) AS ad_type, (e.ord - 1)::int AS position, e.m AS month
      FROM kv, json_array_elements_text(kv.value::json) WITH ORDINALITY AS e(m, ord)
      WHERE kv.key IN ('adspend:sp:index', 'adspend:sb:index')`,
    async apiCheck(sql, decodeValue) {
      const expected = [], actual = [];
      for (const type of ['sp', 'sb']) {
        const [r] = await sql.query('SELECT value FROM kv WHERE key = $1', [`adspend:${type}:index`]);
        expected.push(r ? decodeValue(r.value) : null);
        actual.push(await adspendops.getIndex(type));
      }
      return compareLists(expected, actual);
    }
  },

  // Bare string values: kv keeps a string as its own text.
  'ad-spend-month-syncs': {
    ddl: [`CREATE TABLE ad_spend_month_syncs (month text PRIMARY KEY, synced_at text)`],
    columns: 'month, synced_at',
    kvRows: `SELECT split_part(kv.key, ':', 3) AS month, kv.value AS synced_at
      FROM kv WHERE kv.key ~ '^adspend:last-synced:[0-9]{4}-[0-9]{2}$'`,
    async apiCheck(sql, decodeValue) {
      const recs = await sql.query("SELECT key, value FROM kv WHERE key ~ '^adspend:last-synced:[0-9]{4}-[0-9]{2}$' ORDER BY key");
      const actual = [];
      for (const r of recs) actual.push(await adspendops.getLastSynced(r.key.split(':')[2]));
      return compareLists(recs.map(r => decodeValue(r.value)), actual);
    }
  },

  'ad-spend-report-queue': {
    allowEmpty: true,   // nothing pending is the normal state
    ddl: [
      `CREATE TABLE ad_spend_report_queue (
        position integer PRIMARY KEY,
        ${adspendops.QUEUE_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields   text[]  NOT NULL,
        extra    json
      )`
    ],
    columns: `position, ${recordColumns(adspendops.QUEUE_SPEC)}`,
    compareColumns: `position, ${recordCompareColumns(adspendops.QUEUE_SPEC)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, ${recordValues(adspendops.QUEUE_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_array_elements(kv.value::json) WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = 'adspend:pending'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'adspend:pending'");
      // Every reader treats no queue and an empty one alike; the table reads [].
      return compareLists([(r ? decodeValue(r.value) : null) || []], [await adspendops.getQueue()]);
    }
  },

  'ad-spend-weeks': {
    ddl: [
      `CREATE TABLE ad_spend_weeks (
        year     text    NOT NULL,
        position integer NOT NULL,
        ${adspendops.WEEK_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields   text[]  NOT NULL,
        extra    json,
        PRIMARY KEY (year, position)
      )`,
      'CREATE INDEX ad_spend_weeks_week_idx ON ad_spend_weeks (week, campaign)'
    ],
    columns: `year, position, ${recordColumns(adspendops.WEEK_SPEC)}`,
    compareColumns: `year, position, ${recordCompareColumns(adspendops.WEEK_SPEC)}`,
    kvRows: `SELECT split_part(kv.key, ':', 3) AS year, (e.ord - 1)::int AS position,
        ${recordValues(adspendops.WEEK_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_array_elements(kv.value::json->'rows') WITH ORDINALITY AS e(v, ord)
      WHERE kv.key ~ '^adspend:weeks:[0-9]{4}$'`,
    async apiCheck(sql, decodeValue) {
      const recs = await sql.query("SELECT key, value FROM kv WHERE key ~ '^adspend:weeks:[0-9]{4}$' ORDER BY key");
      const fromKv = [], fromApi = [];
      for (const r of recs) {
        fromKv.push(...(decodeValue(r.value).rows || []));
        const rows = await sql.query(`SELECT ${recordColumns(adspendops.WEEK_SPEC)} FROM ad_spend_weeks WHERE year = $1 ORDER BY position`, [r.key.split(':')[2]]);
        fromApi.push(...rows.map(x => toRecord(x, adspendops.WEEK_SPEC)));
      }
      return compareLists(fromKv, fromApi);
    }
  },

  // When each year's rollup was written. Its check reads the years back whole.
  'ad-spend-week-years': {
    ddl: [`CREATE TABLE ad_spend_week_years (year text PRIMARY KEY, updated_at text)`],
    columns: 'year, updated_at',
    kvRows: `SELECT split_part(kv.key, ':', 3) AS year, kv.value::json->>'updatedAt' AS updated_at
      FROM kv WHERE kv.key ~ '^adspend:weeks:[0-9]{4}$'`,
    async apiCheck(sql, decodeValue) {
      const recs = await sql.query("SELECT key, value FROM kv WHERE key ~ '^adspend:weeks:[0-9]{4}$' ORDER BY key");
      const actual = [];
      for (const r of recs) actual.push(await adspendops.getWeekYear(r.key.split(':')[2]));
      return compareLists(recs.map(r => decodeValue(r.value)), actual);
    }
  },

  // ── Orders sync records (lib/ordersops.js) ────────────────────────────
  // The heartbeat and the sync history it starts. Filled through the app's
  // own saveHeartbeat, so the current lastSync becomes the first history row.
  'orders-sync-status': {
    ddl: ['CREATE TABLE IF NOT EXISTS orders_sync_status (id text)'],
    async fill(sql, decodeValue) {
      await sql.transaction([
        sql.query('DROP TABLE IF EXISTS orders_sync_status, orders_syncs'),
        sql.query(`CREATE TABLE orders_sync_status (
          id          text        PRIMARY KEY,
          ${specColumnDefs(ordersops.STATUS_SPEC)},
          fields      text[]      NOT NULL,
          extra       json,
          updated_at  timestamptz NOT NULL DEFAULT now()
        )`),
        sql.query(`CREATE TABLE orders_syncs (
          id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          ${specColumnDefs(ordersops.SYNC_SPEC)},
          fields      text[]      NOT NULL,
          extra       json,
          recorded_at timestamptz NOT NULL DEFAULT now()
        )`)
      ]);
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'orders:v2:last-cron-run'");
      if (r) await ordersops.saveHeartbeat(decodeValue(r.value));
    },
    async verify(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'orders:v2:last-cron-run'");
      const cmp = compareLists([r ? decodeValue(r.value) : null], [await ordersops.getHeartbeat()]);
      const [{ n }] = await sql.query('SELECT count(*)::int AS n FROM orders_syncs');
      return { ok: cmp.diffs === 0, summary: `heartbeat read back: ${cmp.diffs} differ · sync history rows ${n}`, samples: cmp.samples };
    }
  },

  'orders-alerts': {
    allowEmpty: true,
    ddl: [
      `CREATE TABLE orders_alerts (
        position integer PRIMARY KEY,
        ${specColumnDefs(ordersops.ALERT_SPEC)},
        fields   text[]  NOT NULL,
        extra    json
      )`
    ],
    columns: `position, ${recordColumns(ordersops.ALERT_SPEC)}`,
    compareColumns: `position, ${recordCompareColumns(ordersops.ALERT_SPEC)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, ${recordValues(ordersops.ALERT_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_array_elements(kv.value::json) WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = 'orders:v2:alerts'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'orders:v2:alerts'");
      return compareLists((r ? decodeValue(r.value) : null) || [], await ordersops.getAlerts());
    }
  },

  'orders-report-queue': {
    allowEmpty: true,   // nothing pending is the normal state
    ddl: [
      `CREATE TABLE orders_report_queue (
        position integer PRIMARY KEY,
        ${specColumnDefs(ordersops.QUEUE_SPEC)},
        fields   text[]  NOT NULL,
        extra    json
      )`
    ],
    columns: `position, ${recordColumns(ordersops.QUEUE_SPEC)}`,
    compareColumns: `position, ${recordCompareColumns(ordersops.QUEUE_SPEC)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, ${recordValues(ordersops.QUEUE_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_array_elements(kv.value::json) WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = 'orders:v2:pending-reports'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'orders:v2:pending-reports'");
      return compareLists([(r ? decodeValue(r.value) : null) || []], [await ordersops.getQueue()]);
    }
  },

  'orders-report-results': {
    allowEmpty: true,
    ddl: [
      `CREATE TABLE orders_report_results (
        position   integer PRIMARY KEY,
        report_key text    NOT NULL UNIQUE,
        ${specColumnDefs(ordersops.RESULT_SPEC)},
        fields     text[]  NOT NULL,
        extra      json
      )`
    ],
    columns: `position, report_key, ${recordColumns(ordersops.RESULT_SPEC)}`,
    compareColumns: `position, report_key, ${recordCompareColumns(ordersops.RESULT_SPEC)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, e.k AS report_key,
        ${recordValues(ordersops.RESULT_SPEC, 'e.v', { aliased: true })}
      FROM kv, json_each(kv.value::json) WITH ORDINALITY AS e(k, v, ord)
      WHERE kv.key = 'orders:v2:report-lastresult'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'orders:v2:report-lastresult'");
      const fromKv = (r ? decodeValue(r.value) : null) || {};
      const fromApi = await ordersops.getResults();
      return compareLists([...Object.entries(fromKv)], [...Object.entries(fromApi)]);
    }
  },

  // ── Remaining bookkeeping (lib/stamps.js) ─────────────────────────────
  'shipping-months': {
    ddl: [`CREATE TABLE shipping_months (position integer PRIMARY KEY, month text NOT NULL)`],
    columns: 'position, month',
    kvRows: `SELECT (e.ord - 1)::int AS position, e.m AS month
      FROM kv, json_array_elements_text(kv.value::json) WITH ORDINALITY AS e(m, ord)
      WHERE kv.key = 'shipping:index'`,
    async apiCheck(sql, decodeValue) {
      const [r] = await sql.query("SELECT value FROM kv WHERE key = 'shipping:index'");
      return compareLists([r ? decodeValue(r.value) : null], [await stamps.getShippingIndex()]);
    }
  },

  'shipping-month-syncs': stringRecords({
    table: 'shipping_month_syncs', keyCol: 'month', valueCol: 'synced_at',
    keyPattern: '^shipping:last-synced:[0-9]{4}-[0-9]{2}$', keyExpr: "split_part(kv.key, ':', 3)",
    read: (month) => stamps.getMonthSync('shipping', month), keyOf: (key) => key.split(':')[2]
  }),

  'transaction-month-syncs': stringRecords({
    table: 'transaction_month_syncs', keyCol: 'month', valueCol: 'synced_at',
    keyPattern: '^transactions:v2024:last-synced:[0-9]{4}-[0-9]{2}$', keyExpr: "split_part(kv.key, ':', 4)",
    read: (month) => stamps.getMonthSync('transactions', month), keyOf: (key) => key.split(':')[3]
  }),

  // 'products' and 'mappings:<type>', from their :updated-at records.
  'edit-stamps': stringRecords({
    table: 'edit_stamps', keyCol: 'data_set', valueCol: 'updated_at',
    keyPattern: '^(products|mappings:(product|brand|fee)):updated-at$',
    keyExpr: "regexp_replace(kv.key, ':updated-at$', '')",
    read: (dataSet) => stamps.getEditStamp(dataSet), keyOf: (key) => key.replace(/:updated-at$/, '')
  })
};

// A kv record holding { rows: [record] } as a table of exact-shape rows
// (lib/records.js), in stored order.
function recordRows({ table, key, spec, extraDdl = [], read }) {
  return {
    ddl: [
      `CREATE TABLE ${table} (
        position integer PRIMARY KEY,
        ${spec.map(([, col, type]) => `${col} ${type}`).join(',\n        ')},
        fields   text[]  NOT NULL,
        extra    json
      )`,
      ...extraDdl
    ],
    columns: `position, ${recordColumns(spec)}`,
    compareColumns: `position, ${recordCompareColumns(spec)}`,
    kvRows: `SELECT (e.ord - 1)::int AS position, ${recordValues(spec, 'e.v', { aliased: true })}
      FROM kv, json_array_elements(kv.value::json->'rows') WITH ORDINALITY AS e(v, ord)
      WHERE kv.key = '${key}'`,
    async apiCheck(sql, decodeValue) {
      const [rec] = await sql.query('SELECT value FROM kv WHERE key = $1', [key]);
      return compareLists(rec ? (decodeValue(rec.value).rows || []) : [], await read());
    }
  };
}

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
// Every table has been live in production since 2026-10-22 (the first nine
// data sets in the morning, the rest at 20:13 UTC): production writes only
// to them, so a fill from kv would overwrite newer data and a verify would
// only report the difference.
if (target === 'prod') {
  console.error('Refusing to target production: every table is live there since 2026-10-22, and kv no longer holds its data.');
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
  const table = t.ddl[0].match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/)[1];
  if (fill && t.fill) {
    // A table holding history kv never had is merged into, never dropped.
    await t.fill(sql, decodeValue);
  } else if (fill) {
    // Never rebuild a table from nothing. Production's kv data records were
    // deleted after the switch, so a dev branch reset from production has the
    // tables but no records to fill them from. (allowEmpty: a record that may
    // legitimately not exist, like a set of brand overrides nobody has made.)
    const [{ n: sourceRows }] = await sql.query(`SELECT count(*)::int AS n FROM (${t.kvRows}) src`);
    if (sourceRows === 0 && !t.allowEmpty) {
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
  if (t.verify) {
    const v = await t.verify(sql, decodeValue);
    allOk &&= v.ok;
    console.log(`\n${name}${fill ? ' (filled)' : ''}: ${v.summary}`);
    v.samples.forEach(s => console.log('  differs:', s));
    console.log(`  ${v.ok ? 'VERIFIED' : 'VERIFY FAILED'}`);
    continue;
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
