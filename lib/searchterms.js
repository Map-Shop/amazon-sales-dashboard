// SQL storage for Sponsored Products search term reports (the `search_terms`
// table).
//
// Unlike every other module here there is no kv history to carry over and no
// SQL_TABLES switch: this data has never been stored anywhere else, so there is
// no other backend to fall back to. The table is created on first use and
// starts empty.
//
// Rows are kept at DAILY grain — one row per date, campaign, ad group,
// target and search term. Amazon credits a conversion to the CLICK date, so a
// day's orders and sales keep arriving for 7 days after it; daily rows are
// what makes re-pulling a month to collect those late conversions a plain
// replace. Monthly thresholds are then a SUM over a date range, and a rolling
// 30- or 60-day window stays possible without re-pulling — which matters,
// because Amazon keeps only 95 days and a month that was never pulled is gone
// for good.
//
// A month is replaced whole, exactly as ad_spend_rows is, so each row keeps
// its position and a re-pull cannot leave half of an old month behind.
//
//   search_terms       — the rows.
//   search_term_pulls  — one row per completed pull: what was asked for, what
//                        came back, and how much space it took. The size
//                        numbers are the point of the first pull.

import { sql } from './sql.js';

// [field, column, sql type], in the order a row is written.
//
// `keyword` and `targeting` are both kept because they are not the same
// column in Amazon's answer: a keyword-targeted row carries the keyword text,
// while an Auto row carries a targeting expression ("close-match",
// "loose-match", a product target) and no keyword. Auto is a third of this
// account's clicks, so dropping either one would blank out a third of the
// table's "what matched this" column.
export const ST_COLUMNS = [
  ['date', 'date', 'date'],
  ['campaignId', 'campaign_id', 'text'], ['campaign', 'campaign', 'text'],
  ['adGroupId', 'ad_group_id', 'text'], ['adGroup', 'ad_group', 'text'],
  ['keywordId', 'keyword_id', 'text'], ['keyword', 'keyword', 'text'],
  ['targeting', 'targeting', 'text'], ['matchType', 'match_type', 'text'],
  ['searchTerm', 'search_term', 'text'],
  ['impressions', 'impressions', 'numeric'], ['clicks', 'clicks', 'numeric'],
  ['cost', 'cost', 'numeric'],
  ['purchases7d', 'purchases7d', 'numeric'], ['sales7d', 'sales7d', 'numeric']
];

const COLS = ST_COLUMNS.map(([, col]) => col).join(', ');

const DDL = [
  `CREATE TABLE IF NOT EXISTS search_terms (
    ad_product  text        NOT NULL,
    month       text        NOT NULL,
    position    integer     NOT NULL,
    date        date,
    campaign_id text,
    campaign    text,
    ad_group_id text,
    ad_group    text,
    keyword_id  text,
    keyword     text,
    targeting   text,
    match_type  text,
    search_term text,
    impressions numeric,
    clicks      numeric,
    cost        numeric,
    purchases7d numeric,
    sales7d     numeric,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (ad_product, month, position)
  )`,
  // Joining to ad_campaigns for brand and campaign type is what every list
  // built on this table will do first.
  'CREATE INDEX IF NOT EXISTS search_terms_campaign_idx ON search_terms (campaign_id)',
  // The same term across months is the question the later phases ask: did this
  // convert before it was negated, is it new this quarter.
  'CREATE INDEX IF NOT EXISTS search_terms_term_idx ON search_terms (search_term)',
  `CREATE TABLE IF NOT EXISTS search_term_pulls (
    ad_product    text        NOT NULL,
    month         text        NOT NULL,
    window_start  date        NOT NULL,
    window_end    date        NOT NULL,
    collected_at  timestamptz NOT NULL DEFAULT now(),
    rows          integer     NOT NULL,
    zero_click    integer     NOT NULL,
    terms         integer,
    clicks        numeric,
    cost          numeric,
    data_bytes    bigint,
    PRIMARY KEY (ad_product, month)
  )`
];

let ready = null;

// Creates the tables, once per process. There is nothing to seed.
export function ensure() {
  if (!ready) {
    ready = (async () => { for (const ddl of DDL) await sql().query(ddl); })();
    ready.catch(() => { ready = null; });   // try again on the next call
  }
  return ready;
}

// Replace one ad product's month with exactly these rows.
//
// Sent in chunks rather than as one statement: a month of search terms can run
// to six figures of rows, and a single insert carrying all of them is a request
// large enough to be refused on its own. The delete and the first chunk share a
// transaction so a failed pull cannot empty a month it then fails to refill.
const CHUNK = 4000;

export async function replaceMonth(adProduct, month, rows) {
  await ensure();
  const s = sql();
  const unnest = ST_COLUMNS.map(([, , t], i) => `$${i + 4}::${t}[]`).join(', ');
  const insert = (chunk, offset) => s.query(
    `INSERT INTO search_terms (ad_product, month, position, ${COLS})
     SELECT $1, $2, ord - 1 + $3, ${COLS} FROM unnest(${unnest}) WITH ORDINALITY AS v(${COLS}, ord)`,
    [adProduct, month, offset,
     ...ST_COLUMNS.map(([field]) => chunk.map(r => (r[field] === undefined ? null : r[field])))]);

  const first = rows.slice(0, CHUNK);
  await s.transaction([
    s.query('DELETE FROM search_terms WHERE ad_product = $1 AND month = $2', [adProduct, month]),
    ...(first.length ? [insert(first, 0)] : [])
  ]);
  for (let i = CHUNK; i < rows.length; i += CHUNK) {
    await insert(rows.slice(i, i + CHUNK), i);
  }
}

// What the first pull is for: how many rows, how many of them never got a
// click, and what the whole thing costs on disk. data_bytes is the rows' own
// size and excludes the indexes; table_bytes below covers everything.
export async function monthStats(adProduct, month) {
  await ensure();
  const [r] = await sql().query(
    `SELECT count(*)::int AS rows,
            count(*) FILTER (WHERE coalesce(clicks, 0) = 0)::int AS zero_click,
            count(DISTINCT search_term)::int AS terms,
            coalesce(sum(clicks), 0)::numeric AS clicks,
            coalesce(sum(impressions), 0)::numeric AS impressions,
            coalesce(sum(cost), 0)::numeric AS cost,
            coalesce(sum(purchases7d), 0)::numeric AS orders,
            coalesce(sum(sales7d), 0)::numeric AS sales,
            coalesce(sum(pg_column_size(t.*)), 0)::bigint AS data_bytes
       FROM search_terms t WHERE ad_product = $1 AND month = $2`,
    [adProduct, month]);
  return {
    rows: r.rows, zeroClick: r.zero_click, terms: r.terms,
    clicks: Number(r.clicks), impressions: Number(r.impressions),
    cost: Number(r.cost), orders: Number(r.orders), sales: Number(r.sales),
    dataBytes: Number(r.data_bytes)
  };
}

// Every byte the table occupies, indexes included. Not per month — Postgres
// does not account for storage that way — so it is reported as the table total
// it is.
export async function tableBytes() {
  await ensure();
  const [r] = await sql().query(
    `SELECT pg_total_relation_size('search_terms')::bigint AS total,
            pg_indexes_size('search_terms')::bigint AS indexes`);
  return { total: Number(r.total), indexes: Number(r.indexes) };
}

export async function recordPull(pull) {
  await ensure();
  await sql().query(
    `INSERT INTO search_term_pulls
       (ad_product, month, window_start, window_end, collected_at, rows, zero_click, terms, clicks, cost, data_bytes)
     VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10)
     ON CONFLICT (ad_product, month) DO UPDATE SET
       window_start = excluded.window_start, window_end = excluded.window_end,
       collected_at = excluded.collected_at, rows = excluded.rows,
       zero_click = excluded.zero_click, terms = excluded.terms,
       clicks = excluded.clicks, cost = excluded.cost, data_bytes = excluded.data_bytes`,
    [pull.adProduct, pull.month, pull.windowStart, pull.windowEnd, pull.rows,
     pull.zeroClick, pull.terms, pull.clicks, pull.cost, pull.dataBytes]);
}

export async function listPulls() {
  await ensure();
  const rows = await sql().query(
    `SELECT ad_product, month, to_char(window_start, 'YYYY-MM-DD') AS window_start,
            to_char(window_end, 'YYYY-MM-DD') AS window_end, collected_at,
            rows, zero_click, terms, clicks, cost, data_bytes
       FROM search_term_pulls ORDER BY month DESC, ad_product`);
  return rows.map(r => ({
    adProduct: r.ad_product, month: r.month,
    windowStart: r.window_start, windowEnd: r.window_end,
    collectedAt: r.collected_at, rows: r.rows, zeroClick: r.zero_click,
    terms: r.terms, clicks: Number(r.clicks), cost: Number(r.cost),
    dataBytes: Number(r.data_bytes)
  }));
}

// Sort keys the page may ask for. A whitelist because the column name is
// interpolated into the statement; anything outside it falls back to spend.
const SORTS = {
  cost: 'cost', clicks: 'clicks', impressions: 'impressions',
  orders: 'purchases7d', sales: 'sales7d', searchTerm: 'search_term', date: 'date'
};

// One page of a month's rows. Brand and campaign type are joined from the
// census rather than stored here, the same rule every cadence follows:
// configuration is read at query time so a re-mapped brand moves its history.
export async function getMonth({ adProduct = 'SP', month, sort = 'cost', dir = 'desc',
                                 limit = 200, offset = 0, q = '', minClicks = 0 } = {}) {
  await ensure();
  const col = SORTS[sort] || SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const params = [adProduct, month, Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0),
                  Number(minClicks) || 0, q ? `%${q}%` : null];
  const where = `t.ad_product = $1 AND t.month = $2
                 AND coalesce(t.clicks, 0) >= $5
                 AND ($6::text IS NULL OR t.search_term ILIKE $6)`;
  const [rows, [total]] = await Promise.all([
    sql().query(
      `SELECT to_char(t.date, 'YYYY-MM-DD') AS date, t.campaign_id, t.campaign, t.ad_group,
              t.keyword, t.targeting, t.match_type, t.search_term,
              t.impressions, t.clicks, t.cost, t.purchases7d, t.sales7d,
              c.brand, c.campaign_type
         FROM search_terms t
         LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
        WHERE ${where}
        ORDER BY ${col} ${order} NULLS LAST, t.search_term
        LIMIT $3 OFFSET $4`, params),
    sql().query(`SELECT count(*)::int AS n FROM search_terms t WHERE ${where}`, params)
  ]);
  return {
    total: total.n,
    rows: rows.map(r => ({
      date: r.date, campaignId: r.campaign_id, campaign: r.campaign, adGroup: r.ad_group,
      keyword: r.keyword, targeting: r.targeting, matchType: r.match_type,
      searchTerm: r.search_term, brand: r.brand, campaignType: r.campaign_type,
      impressions: Number(r.impressions), clicks: Number(r.clicks), cost: Number(r.cost),
      orders: Number(r.purchases7d), sales: Number(r.sales7d)
    }))
  };
}
