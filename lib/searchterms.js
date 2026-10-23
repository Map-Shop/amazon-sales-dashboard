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
  )`,
  // window_* is what the last pull asked for. covered_* is the widest range
  // actually HELD for the month — widened by each pull rather than replaced,
  // because a later pull of an old month returns less than the one before it
  // and the days already captured are still there. The two differ whenever
  // Amazon has dropped the start of the month. Added after a pull of August
  // returned the 19th onward and said nothing, leaving a short month stored
  // as though it were whole.
  'ALTER TABLE search_term_pulls ADD COLUMN IF NOT EXISTS covered_start date',
  'ALTER TABLE search_term_pulls ADD COLUMN IF NOT EXISTS covered_end date'
];

let ready = null;

// Creates the tables, once per process, and fills in the covered range of any
// pull recorded before that range was kept. The rows themselves know what they
// cover, so nothing is lost — but a month pulled earlier would otherwise read
// as whole when it is short, which is the thing this column exists to prevent.
export function ensure() {
  if (!ready) {
    ready = (async () => {
      for (const ddl of DDL) await sql().query(ddl);
      const [missing] = await sql().query(
        'SELECT count(*)::int AS n FROM search_term_pulls WHERE covered_start IS NULL');
      if (missing.n) {
        await sql().query(
          `UPDATE search_term_pulls p
              SET covered_start = c.first_day, covered_end = c.last_day
             FROM (SELECT ad_product, month, min(date) AS first_day, max(date) AS last_day
                     FROM search_terms GROUP BY ad_product, month) c
            WHERE p.ad_product = c.ad_product AND p.month = c.month
              AND p.covered_start IS NULL`);
      }
    })();
    ready.catch(() => { ready = null; });   // try again on the next call
  }
  return ready;
}

// The first and last day present in a set of rows.
export function coveredRange(rows) {
  let from = null, to = null;
  for (const r of rows) {
    const d = r && r.date;
    if (!d) continue;
    if (from === null || d < from) from = d;
    if (to === null || d > to) to = d;
  }
  return { from, to };
}

// Store these rows, replacing ONLY the days they cover.
//
// Not the whole month: Amazon's search term history is about 65 days, and a
// re-pull of an older month comes back shorter than the one before it — it
// quietly starts later and reports success. Replacing the month wholesale
// would then delete days we hold and cannot fetch again, so a late re-pull
// would destroy the very rows it was meant to refresh. Replacing the covered
// range tops a month up instead: the newly settled days are rewritten, the
// days Amazon has since forgotten stay as they were captured.
//
// Sent in chunks rather than as one statement: a month of search terms can run
// to six figures of rows, and a single insert carrying all of them is a request
// large enough to be refused on its own. The delete and the first chunk share a
// transaction so a failed pull cannot empty a range it then fails to refill.
const CHUNK = 4000;

export async function replaceRange(adProduct, month, rows) {
  await ensure();
  const { from, to } = coveredRange(rows);
  if (!from) return { from: null, to: null, stored: 0 };

  const s = sql();
  // Positions continue past whatever the month already holds, so rewriting a
  // range cannot collide with the rows either side of it. They record the
  // order a pull arrived in; nothing reads them to order a result.
  const [seq] = await s.query(
    'SELECT coalesce(max(position), -1) + 1 AS next FROM search_terms WHERE ad_product = $1 AND month = $2',
    [adProduct, month]);
  const base = Number(seq.next) || 0;

  const unnest = ST_COLUMNS.map(([, , t], i) => `$${i + 4}::${t}[]`).join(', ');
  const insert = (chunk, offset) => s.query(
    `INSERT INTO search_terms (ad_product, month, position, ${COLS})
     SELECT $1, $2, ord - 1 + $3, ${COLS} FROM unnest(${unnest}) WITH ORDINALITY AS v(${COLS}, ord)`,
    [adProduct, month, offset,
     ...ST_COLUMNS.map(([field]) => chunk.map(r => (r[field] === undefined ? null : r[field])))]);

  const first = rows.slice(0, CHUNK);
  await s.transaction([
    s.query(`DELETE FROM search_terms
              WHERE ad_product = $1 AND month = $2 AND date BETWEEN $3::date AND $4::date`,
            [adProduct, month, from, to]),
    ...(first.length ? [insert(first, base)] : [])
  ]);
  for (let i = CHUNK; i < rows.length; i += CHUNK) {
    await insert(rows.slice(i, i + CHUNK), base + i);
  }
  return { from, to, stored: rows.length };
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
       (ad_product, month, window_start, window_end, covered_start, covered_end,
        collected_at, rows, zero_click, terms, clicks, cost, data_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12)
     ON CONFLICT (ad_product, month) DO UPDATE SET
       window_start = excluded.window_start, window_end = excluded.window_end,
       covered_start = LEAST(search_term_pulls.covered_start, excluded.covered_start),
       covered_end = GREATEST(search_term_pulls.covered_end, excluded.covered_end),
       collected_at = excluded.collected_at, rows = excluded.rows,
       zero_click = excluded.zero_click, terms = excluded.terms,
       clicks = excluded.clicks, cost = excluded.cost, data_bytes = excluded.data_bytes`,
    [pull.adProduct, pull.month, pull.windowStart, pull.windowEnd,
     pull.coveredStart, pull.coveredEnd, pull.rows,
     pull.zeroClick, pull.terms, pull.clicks, pull.cost, pull.dataBytes]);
}

export async function listPulls() {
  await ensure();
  const rows = await sql().query(
    `SELECT ad_product, month, to_char(window_start, 'YYYY-MM-DD') AS window_start,
            to_char(window_end, 'YYYY-MM-DD') AS window_end,
            to_char(covered_start, 'YYYY-MM-DD') AS covered_start,
            to_char(covered_end, 'YYYY-MM-DD') AS covered_end, collected_at,
            rows, zero_click, terms, clicks, cost, data_bytes
       FROM search_term_pulls ORDER BY month DESC, ad_product`);
  return rows.map(r => ({
    adProduct: r.ad_product, month: r.month,
    windowStart: r.window_start, windowEnd: r.window_end,
    coveredStart: r.covered_start, coveredEnd: r.covered_end,
    // A month whose first stored day is not its first day is short, and
    // nothing else on the page would say so.
    partial: !!(r.covered_start && r.covered_start > monthFirstDay(r.month)),
    collectedAt: r.collected_at, rows: r.rows, zeroClick: r.zero_click,
    terms: r.terms, clicks: Number(r.clicks), cost: Number(r.cost),
    dataBytes: Number(r.data_bytes)
  }));
}

const monthFirstDay = (month) => `${month}-01`;

// Sort keys the page may ask for. A whitelist because the column name is
// interpolated into the statement; anything outside it falls back to spend.
const SORTS = {
  cost: 'cost', clicks: 'clicks', impressions: 'impressions',
  orders: 'purchases7d', sales: 'sales7d', searchTerm: 'search_term', date: 'date'
};

// The two statements behind getMonth, built together so they cannot drift.
//
// The filters are numbered first and the paging last, because the count
// statement reuses the filter text and takes only those parameters. Numbering
// them the other way round sends it parameters it never mentions, and Postgres
// refuses a statement whose parameter types it cannot infer:
// "could not determine data type of parameter $3".
export function monthQueries({ adProduct = 'SP', month, sort = 'cost', dir = 'desc',
                               limit = 200, offset = 0, q = '', minClicks = 0 } = {}) {
  const col = SORTS[sort] || SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const filters = [adProduct, month, Number(minClicks) || 0, q ? `%${q}%` : null];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];
  const where = `t.ad_product = $1 AND t.month = $2
                 AND coalesce(t.clicks, 0) >= $3
                 AND ($4::text IS NULL OR t.search_term ILIKE $4)`;
  return {
    rows: {
      text: `SELECT to_char(t.date, 'YYYY-MM-DD') AS date, t.campaign_id, t.campaign, t.ad_group,
                    t.keyword, t.targeting, t.match_type, t.search_term,
                    t.impressions, t.clicks, t.cost, t.purchases7d, t.sales7d,
                    c.brand, c.campaign_type
               FROM search_terms t
               LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
              WHERE ${where}
              ORDER BY ${col} ${order} NULLS LAST, t.search_term
              LIMIT $5::int OFFSET $6::int`,
      params: [...filters, ...paging]
    },
    count: {
      text: `SELECT count(*)::int AS n FROM search_terms t WHERE ${where}`,
      params: filters
    }
  };
}

// ─── ROLLUPS ─────────────────────────────────────────────────────────────────
// A list of rows is not a view of anything. These two are: a product, and the
// terms inside it.
//
// The product is the unit a decision is actually made at — a portfolio here is
// one product, the same rule the weekly checks judge by. A cluster of terms
// with no orders is one question about that product, not fifty questions about
// terms. The term rollup is the drill-down where a negate or a graduate is
// chosen.
//
// Both aggregate per term FIRST and then per product, because a term matched
// by three campaigns is one term, not three.

// A term counts as a negation candidate at this many clicks with no orders —
// the monthly doc's own rule. Passed in so a caller can loosen it.
export const NEGATE_CLICKS = 15;

const TERM_SOURCE = `
  SELECT c.portfolio_id,
         coalesce(p.name, '(no portfolio)') AS portfolio,
         c.brand, t.search_term,
         sum(t.clicks) AS clicks, sum(t.cost) AS cost,
         sum(t.purchases7d) AS orders, sum(t.sales7d) AS sales
    FROM search_terms t
    JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
    LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
   WHERE t.ad_product = $1 AND t.month = $2
   GROUP BY 1, 2, 3, 4`;

export function productQuery({ adProduct = 'SP', month, negateClicks = NEGATE_CLICKS } = {}) {
  return {
    text: `WITH term AS (${TERM_SOURCE})
           SELECT portfolio_id, portfolio, brand,
                  count(*)::int AS terms,
                  sum(clicks)::numeric AS clicks,
                  sum(cost)::numeric AS cost,
                  sum(orders)::numeric AS orders,
                  sum(sales)::numeric AS sales,
                  count(*) FILTER (WHERE orders = 0)::int AS dead_terms,
                  coalesce(sum(cost) FILTER (WHERE orders = 0), 0)::numeric AS dead_cost,
                  count(*) FILTER (WHERE orders = 0 AND clicks >= $3)::int AS negate_terms,
                  coalesce(sum(cost) FILTER (WHERE orders = 0 AND clicks >= $3), 0)::numeric AS negate_cost
             FROM term
            GROUP BY 1, 2, 3
            ORDER BY sum(cost) DESC NULLS LAST`,
    params: [adProduct, month, Number(negateClicks) || NEGATE_CLICKS]
  };
}

// Sort keys for the term rollup. Whitelisted for the same reason as SORTS.
const TERM_SORTS = {
  cost: 'cost', clicks: 'clicks', orders: 'orders', sales: 'sales',
  searchTerm: 'search_term'
};

export function termQueries({ adProduct = 'SP', month, portfolioId = null, sort = 'cost',
                              dir = 'desc', limit = 200, offset = 0, q = '', minClicks = 0,
                              onlyDead = false } = {}) {
  const col = TERM_SORTS[sort] || TERM_SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // $3 portfolio, $4 minimum clicks, $5 term filter, $6 only-unconverted.
  const filters = [adProduct, month, portfolioId || null, Number(minClicks) || 0,
                   q ? `%${q}%` : null, !!onlyDead];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];

  // Which campaigns matched it, and whether one of them already targets it as
  // an exact keyword — the report names the keyword that matched, so a term
  // that is already graduated says so without asking Amazon for the keyword
  // list. It cannot see an exact keyword that drew no impressions at all.
  const source = `
    SELECT t.search_term,
           sum(t.clicks) AS clicks, sum(t.cost) AS cost,
           sum(t.purchases7d) AS orders, sum(t.sales7d) AS sales,
           count(DISTINCT t.campaign_id)::int AS campaigns,
           string_agg(DISTINCT c.campaign_type, ', ' ORDER BY c.campaign_type) AS types,
           string_agg(DISTINCT coalesce(nullif(t.keyword, ''), t.targeting), ' · ') AS matched,
           bool_or(c.campaign_type = 'Exact'
                   AND lower(t.keyword) = lower(t.search_term)) AS targeted_exact
      FROM search_terms t
      JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
     WHERE t.ad_product = $1 AND t.month = $2
       AND ($3::text IS NULL OR c.portfolio_id = $3)
     GROUP BY 1`;
  const having = `WHERE clicks >= $4
                    AND ($5::text IS NULL OR search_term ILIKE $5)
                    AND ($6 = false OR orders = 0)`;

  // How many of your own products bid on this term, counted across the whole
  // account even when the list is narrowed to one of them. Half this account's
  // search term spend goes on terms two or more products chase, and a decision
  // taken inside one product while another pays for the same search is taken
  // blind.
  const spread = `
    SELECT t.search_term, count(DISTINCT c.portfolio_id)::int AS products
      FROM search_terms t
      JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
     WHERE t.ad_product = $1 AND t.month = $2
     GROUP BY 1`;

  return {
    rows: {
      text: `WITH term AS (${source}), spread AS (${spread})
             SELECT term.*, spread.products FROM term JOIN spread USING (search_term)
             ${having}
              ORDER BY ${col} ${order} NULLS LAST, search_term
              LIMIT $7::int OFFSET $8::int`,
      params: [...filters, ...paging]
    },
    count: {
      text: `WITH term AS (${source}) SELECT count(*)::int AS n FROM term ${having}`,
      params: filters
    }
  };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function byProduct(opts = {}) {
  await ensure();
  const { text, params } = productQuery(opts);
  const rows = await sql().query(text, params);
  return rows.map(r => ({
    portfolioId: r.portfolio_id, portfolio: r.portfolio, brand: r.brand,
    terms: r.terms, clicks: num(r.clicks), cost: num(r.cost),
    orders: num(r.orders), sales: num(r.sales),
    deadTerms: r.dead_terms, deadCost: num(r.dead_cost),
    negateTerms: r.negate_terms, negateCost: num(r.negate_cost),
    acos: num(r.sales) > 0 ? num(r.cost) / num(r.sales) : null
  }));
}

export async function byTerm(opts = {}) {
  await ensure();
  const q = termQueries(opts);
  const [rows, [total]] = await Promise.all([
    sql().query(q.rows.text, q.rows.params),
    sql().query(q.count.text, q.count.params)
  ]);
  return {
    total: total.n,
    rows: rows.map(r => ({
      searchTerm: r.search_term, clicks: num(r.clicks), cost: num(r.cost),
      orders: num(r.orders), sales: num(r.sales), campaigns: r.campaigns,
      types: r.types, matched: r.matched, targetedExact: r.targeted_exact,
      products: r.products,
      acos: num(r.sales) > 0 ? num(r.cost) / num(r.sales) : null
    }))
  };
}

// Everything that matched one search term, across the whole account — one row
// per campaign and target rather than per day.
//
// Always account-wide, even when the list above is narrowed to one product:
// the term row totals a product's share, and this is where you see the rest of
// what is paying for the same search. One line is one mechanism, which is what
// makes it one possible action — an exact keyword earning its place, an auto
// close-match that is not, another product's broad keyword catching the same
// shopper.
export function termDetailQuery({ adProduct = 'SP', month, searchTerm } = {}) {
  return {
    text: `SELECT c.portfolio_id,
                  coalesce(p.name, '(no portfolio)') AS portfolio, c.brand,
                  c.name AS campaign, c.campaign_type,
                  coalesce(nullif(t.keyword, ''), t.targeting) AS matched, t.match_type,
                  sum(t.clicks)::numeric AS clicks, sum(t.cost)::numeric AS cost,
                  sum(t.purchases7d)::numeric AS orders, sum(t.sales7d)::numeric AS sales
             FROM search_terms t
             JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
             LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
            WHERE t.ad_product = $1 AND t.month = $2 AND t.search_term = $3
            GROUP BY 1, 2, 3, 4, 5, 6, 7
            -- By product first: the breakdown is read to see which products are
            -- paying for one search, and spend order scattered a product's own
            -- lines through the list.
            --
            -- Then by campaign type in FUNNEL order rather than alphabetically,
            -- so each product reads the way the structure is meant to work:
            -- Auto discovers it, Broad widens it, Exact targets it deliberately,
            -- ASIN catches it on a product page. Phrase sits where its breadth
            -- puts it, between Broad and Exact. Biggest line first inside a type.
            ORDER BY lower(coalesce(p.name, '(no portfolio)')) ASC,
                     CASE c.campaign_type
                       WHEN 'Auto'   THEN 1
                       WHEN 'Broad'  THEN 2
                       WHEN 'Phrase' THEN 3
                       WHEN 'Exact'  THEN 4
                       WHEN 'ASIN'   THEN 5
                       ELSE 6
                     END,
                     sum(t.cost) DESC NULLS LAST`,
    params: [adProduct, month, String(searchTerm || '')]
  };
}

export async function termDetail(opts = {}) {
  await ensure();
  const { text, params } = termDetailQuery(opts);
  const rows = await sql().query(text, params);
  return rows.map(r => ({
    portfolioId: r.portfolio_id, portfolio: r.portfolio, brand: r.brand,
    campaign: r.campaign, campaignType: r.campaign_type,
    matched: r.matched, matchType: r.match_type,
    clicks: num(r.clicks), cost: num(r.cost), orders: num(r.orders), sales: num(r.sales)
  }));
}

// One page of a month's rows. Brand and campaign type are joined from the
// census rather than stored here, the same rule every cadence follows:
// configuration is read at query time so a re-mapped brand moves its history.
export async function getMonth(opts = {}) {
  await ensure();
  const q = monthQueries(opts);
  const [rows, [total]] = await Promise.all([
    sql().query(q.rows.text, q.rows.params),
    sql().query(q.count.text, q.count.params)
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
