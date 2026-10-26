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
  // Every view reads a range of days.
  'CREATE INDEX IF NOT EXISTS search_terms_date_idx ON search_terms (ad_product, date)',
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

// Every product's name. The page shortens them — "Wall Map - SOK - US Ranger"
// to "US Ranger" — and has to know every name to tell when two products
// shorten to the same one.
export async function portfolioNames() {
  const rows = await sql().query('SELECT portfolio_id, name FROM ad_portfolios ORDER BY name');
  return rows.map(r => ({ id: r.portfolio_id, name: r.name }));
}

// The last day held, which is where the next daily pull carries on from.
export async function lastDate(adProduct = 'SP') {
  await ensure();
  const [r] = await sql().query(
    `SELECT to_char(max(date), 'YYYY-MM-DD') AS last FROM search_terms WHERE ad_product = $1`,
    [adProduct]);
  return (r && r.last) || null;
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

// A range of days as Postgres reads it: both ends included. Every view is
// filtered by one, passed as a single parameter, so a statement's numbering
// does not depend on whether it is filtered by a month or by a week.
export function rangeParam(range) {
  if (typeof range === 'string') return range;
  const r = range || {};
  return `[${r.start},${r.end}]`;
}

// The first and last day held. Ranges are drawn inside these.
export async function storeSpan(adProduct = 'SP') {
  await ensure();
  const [r] = await sql().query(
    `SELECT to_char(min(date), 'YYYY-MM-DD') AS first, to_char(max(date), 'YYYY-MM-DD') AS last,
            count(*)::int AS rows
       FROM search_terms WHERE ad_product = $1`,
    [adProduct]);
  return { first: r.first, last: r.last, rows: r.rows };
}

// What a range holds: the counts the page's footer of figures shows.
export async function rangeStats(adProduct, range) {
  await ensure();
  const [r] = await sql().query(
    `SELECT count(*)::int AS rows,
            count(DISTINCT search_term)::int AS terms,
            coalesce(sum(clicks), 0)::numeric AS clicks,
            coalesce(sum(cost), 0)::numeric AS cost,
            coalesce(sum(purchases7d), 0)::numeric AS orders,
            coalesce(sum(sales7d), 0)::numeric AS sales,
            to_char(min(date), 'YYYY-MM-DD') AS first, to_char(max(date), 'YYYY-MM-DD') AS last
       FROM search_terms t WHERE t.ad_product = $1 AND t.date <@ $2::daterange`,
    [adProduct, rangeParam(range)]);
  return {
    rows: r.rows, terms: r.terms, clicks: Number(r.clicks), cost: Number(r.cost),
    orders: Number(r.orders), sales: Number(r.sales), first: r.first, last: r.last
  };
}

// Sort keys the page may ask for. A whitelist because the column name is
// interpolated into the statement; anything outside it falls back to spend.
//
// ROAS is a ratio, so it divides by spend — and Postgres stops the whole
// statement on a division by zero rather than returning nothing for that row.
// NULLIF turns zero spend into no ROAS, which sorts last in either direction.
const SORTS = {
  cost: 'cost', clicks: 'clicks', impressions: 'impressions',
  orders: 'purchases7d', sales: 'sales7d', searchTerm: 'search_term', date: 'date',
  roas: '(t.sales7d / NULLIF(t.cost, 0))'
};

// The two statements behind getRows, built together so they cannot drift.
//
// The filters are numbered first and the paging last, because the count
// statement reuses the filter text and takes only those parameters. Numbering
// them the other way round sends it parameters it never mentions, and Postgres
// refuses a statement whose parameter types it cannot infer:
// "could not determine data type of parameter $3".
export function rowQueries({ adProduct = 'SP', range, sort = 'cost', dir = 'desc',
                             limit = 200, offset = 0, q = '', minClicks = 0 } = {}) {
  const col = SORTS[sort] || SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const filters = [adProduct, rangeParam(range), Number(minClicks) || 0, q ? `%${q}%` : null];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];
  const where = `t.ad_product = $1 AND t.date <@ $2::daterange
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

// ─── HOW A ROW MATCHED ───────────────────────────────────────────────────────
// Amazon reports the match type on every row, and that is what this page shows.
// The campaign's name says what the campaign was MEANT to do — "(Exact)",
// "(Broad)" — and the two disagree more than you would think: in September, 48
// rows inside Exact campaigns were caught by broad keywords, and 32 rows inside
// Broad campaigns by keyword groups. Labelling those from the name would say
// "Exact" about a broad match.
//
// TARGETING_EXPRESSION covers more than one kind of target, so the label comes
// from the target itself: an ASIN, a keyword group, a category.
const MATCH_LABEL = `CASE
    WHEN upper(t.match_type) = 'EXACT'  THEN 'Exact'
    WHEN upper(t.match_type) = 'PHRASE' THEN 'Phrase'
    WHEN upper(t.match_type) = 'BROAD'  THEN 'Broad'
    WHEN upper(t.match_type) = 'TARGETING_EXPRESSION_PREDEFINED' THEN 'Auto'
    WHEN t.targeting ILIKE 'asin=%'          THEN 'ASIN'
    WHEN t.targeting ILIKE 'keyword-group=%' THEN 'Keyword group'
    WHEN t.targeting ILIKE 'category=%'      THEN 'Category'
    ELSE coalesce(t.match_type, '—')
  END`;

// The order a product's structure is meant to work in: Auto discovers a term,
// Broad and keyword groups widen it, Phrase narrows, Exact targets it on
// purpose, ASIN and category targets catch it on a product page.
export const MATCH_FUNNEL = ['Auto', 'Broad', 'Keyword group', 'Phrase', 'Exact', 'ASIN', 'Category'];

const matchOrder = (expr) =>
  `CASE ${expr} ${MATCH_FUNNEL.map((label, i) => `WHEN '${label}' THEN ${i + 1}`).join(' ')} ` +
  `ELSE ${MATCH_FUNNEL.length + 1} END`;

// Already graduated: the term is targeted by an exact-match keyword that is the
// term itself. From the match type Amazon reports, not the campaign's name — the
// name marked one September term exact that a broad keyword had caught.
const TARGETED_EXACT = `bool_or(upper(t.match_type) = 'EXACT'
                                AND lower(t.keyword) = lower(t.search_term))`;

// The product a row belongs to. Joined from TODAY's campaign list, and outer
// joined: a campaign that has since left the list keeps its history here under
// its own heading rather than vanishing from every total while the stored
// figures at the foot of the page still count it.
export const PRODUCT_NAME = `CASE WHEN c.campaign_id IS NULL THEN '(not in campaign list)'
                           ELSE coalesce(p.name, '(no portfolio)') END`;

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

const TERM_SOURCE = `
  SELECT c.portfolio_id,
         ${PRODUCT_NAME} AS portfolio,
         c.brand, t.search_term,
         sum(t.clicks) AS clicks, sum(t.cost) AS cost,
         sum(t.purchases7d) AS orders, sum(t.sales7d) AS sales
    FROM search_terms t
    LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
    LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
   WHERE t.ad_product = $1 AND t.date <@ $2::daterange
   GROUP BY 1, 2, 3, 4`;

export function productQuery({ adProduct = 'SP', range } = {}) {
  return {
    text: `WITH term AS (${TERM_SOURCE})
           SELECT portfolio_id, portfolio, brand,
                  count(*)::int AS terms,
                  sum(clicks)::numeric AS clicks,
                  sum(cost)::numeric AS cost,
                  sum(orders)::numeric AS orders,
                  sum(sales)::numeric AS sales,
                  count(*) FILTER (WHERE orders = 0)::int AS dead_terms,
                  coalesce(sum(cost) FILTER (WHERE orders = 0), 0)::numeric AS dead_cost
             FROM term
            GROUP BY 1, 2, 3
            ORDER BY sum(cost) DESC NULLS LAST`,
    params: [adProduct, rangeParam(range)]
  };
}

// Sort keys for the term rollup. Whitelisted for the same reason as SORTS.
const TERM_SORTS = {
  cost: 'cost', clicks: 'clicks', orders: 'orders', sales: 'sales',
  searchTerm: 'search_term', roas: '(sales / NULLIF(cost, 0))'
};

export function termQueries({ adProduct = 'SP', range, portfolioId = null, sort = 'cost',
                              dir = 'desc', limit = 200, offset = 0, q = '', minClicks = 0,
                              onlyDead = false, minProducts = 0 } = {}) {
  const col = TERM_SORTS[sort] || TERM_SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // $3 portfolio, $4 minimum clicks, $5 term filter, $6 only-unconverted,
  // $7 how many of your products must be paying for the term.
  const filters = [adProduct, rangeParam(range), portfolioId || null, Number(minClicks) || 0,
                   q ? `%${q}%` : null, !!onlyDead, Math.max(Number(minProducts) || 0, 0)];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];

  // Which campaigns matched it, and whether one of them already targets it as
  // an exact keyword — the report names the keyword that matched, so a term
  // that is already graduated says so without asking Amazon for the keyword
  // list. It cannot see an exact keyword that drew no impressions at all.
  // Match types come back as a list and are put in funnel order by the
  // caller: Postgres can only order a DISTINCT aggregate by the value itself,
  // which would be alphabetical.
  const source = `
    SELECT t.search_term,
           sum(t.clicks) AS clicks, sum(t.cost) AS cost,
           sum(t.purchases7d) AS orders, sum(t.sales7d) AS sales,
           count(DISTINCT t.campaign_id)::int AS campaigns,
           array_agg(DISTINCT ${MATCH_LABEL}) AS match_types,
           ${TARGETED_EXACT} AS targeted_exact
      FROM search_terms t
      LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
     WHERE t.ad_product = $1 AND t.date <@ $2::daterange
       AND ($3::text IS NULL OR c.portfolio_id = $3)
     GROUP BY 1`;
  const having = `WHERE clicks >= $4
                    AND ($5::text IS NULL OR search_term ILIKE $5)
                    AND ($6 = false OR orders = 0)
                    AND coalesce(spread.products, 0) >= $7::int`;

  // How many of your own products bid on this term, counted across the whole
  // account even when the list is narrowed to one of them. Half this account's
  // search term spend goes on terms two or more products chase, and a decision
  // taken inside one product while another pays for the same search is taken
  // blind.
  // Outer joined so a term seen only in a campaign that has left the list
  // still appears, with no products counted, rather than being dropped by
  // the join below. The Shared terms tab is this count at 2 or more: the
  // searches several of your products are paying for at once.
  const spread = `
    SELECT t.search_term, count(DISTINCT c.portfolio_id)::int AS products
      FROM search_terms t
      LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
     WHERE t.ad_product = $1 AND t.date <@ $2::daterange
     GROUP BY 1`;

  return {
    rows: {
      text: `WITH term AS (${source}), spread AS (${spread})
             SELECT term.*, spread.products FROM term JOIN spread USING (search_term)
             ${having}
              ORDER BY ${col} ${order} NULLS LAST, search_term
              LIMIT $8::int OFFSET $9::int`,
      params: [...filters, ...paging]
    },
    count: {
      text: `WITH term AS (${source}), spread AS (${spread})
             SELECT count(*)::int AS n FROM term JOIN spread USING (search_term) ${having}`,
      params: filters
    }
  };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Match types in funnel order rather than the alphabetical order they arrive in.
export function funnelSort(types) {
  const rank = (t) => { const i = MATCH_FUNNEL.indexOf(t); return i < 0 ? MATCH_FUNNEL.length : i; };
  return [...(types || [])].filter(Boolean).sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(b));
}

export async function byProduct(opts = {}) {
  await ensure();
  const { text, params } = productQuery(opts);
  const rows = await sql().query(text, params);
  return rows.map(r => ({
    portfolioId: r.portfolio_id, portfolio: r.portfolio, brand: r.brand,
    terms: r.terms, clicks: num(r.clicks), cost: num(r.cost),
    orders: num(r.orders), sales: num(r.sales),
    deadTerms: r.dead_terms, deadCost: num(r.dead_cost),
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
      matchTypes: funnelSort(r.match_types), targetedExact: r.targeted_exact,
      products: r.products,
      acos: num(r.sales) > 0 ? num(r.cost) / num(r.sales) : null
    }))
  };
}

// ─── ONE PRODUCT'S TERMS ─────────────────────────────────────────────────────
// Looking inside a product asks a different question than looking across the
// account, so it is a different table rather than the same one filtered.
//
// Here a row is one way this product matched one term — Exact on the keyword,
// Broad on another keyword, Auto on a close match — because within a product
// that is the thing you would act on. The account-wide table keeps one row per
// term, because there the question is whether the term is worth anything at
// all.
//
// Filters and ordering work on the TERM's totals inside this product, not on
// the individual match, so a term's rows stay together and arrive or vanish
// as a group. A match type filter narrows the rows first, so the totals are
// that match type's: with Auto picked, a term's spend and orders are what
// Auto spent on it and what Auto earned from it.
const PRODUCT_TERM_SORTS = {
  cost: 'term_cost', clicks: 'term_clicks', orders: 'term_orders',
  sales: 'term_sales', roas: 'term_roas', searchTerm: 'search_term'
};

// What has already been done about a term, from the morning's snapshot of the
// keywords and negatives — facts, not advice.
//
//   graduated  this product targets the term as a keyword of its own —
//              broad, phrase or exact, enabled or paused — each with the day
//              it was added, oldest first: a term often goes Auto to Broad to
//              Exact over months. Compared as text, so it misses the plurals
//              and misspellings Amazon's exact match also catches.
//   negated  the campaign this row matched in blocks the term: a negative
//            exact keyword that is the term, a negative phrase inside it on
//            whole words, or a negative product target for an ASIN term.
//            Either level counts — the whole campaign, or this row's ad group.
//
// One keyword per match type, the enabled one over a paused one; one negative
// at most, a negative exact over a phrase, the oldest first.
const TERM_STATUS = `
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('type', g.match_label, 'since', g.created_at, 'state', g.state)
                    ORDER BY g.created_at ASC NULLS LAST, g.match_label) AS graduated
      FROM (
        SELECT DISTINCT ON (k.match_label) k.match_label, k.amazon_created_at AS created_at, k.state
          FROM sp_targets k
          JOIN ad_campaigns kc ON kc.campaign_id = k.campaign_id
         WHERE k.kind = 'keyword' AND k.match_label IN ('Broad', 'Phrase', 'Exact')
           AND kc.portfolio_id = $3
           AND lower(btrim(k.target_text)) = lower(btrim(i.search_term))
         ORDER BY k.match_label, (k.state = 'ENABLED') DESC, k.amazon_created_at ASC NULLS LAST
      ) g
  ) ex ON true
  LEFT JOIN LATERAL (
    SELECT n.amazon_created_at AS created_at, n.match_type, n.neg_text, n.level
      FROM sp_negatives n
     WHERE n.campaign_id = i.campaign_id
       AND (n.level = 'campaign' OR n.ad_group_id = i.ad_group_id)
       AND coalesce(n.state, 'ENABLED') = 'ENABLED'
       AND ((n.kind = 'keyword' AND upper(n.match_type) = 'NEGATIVE_EXACT'
             AND lower(btrim(n.neg_text)) = lower(btrim(i.search_term)))
         OR (n.kind = 'keyword' AND upper(n.match_type) = 'NEGATIVE_PHRASE'
             AND position(' ' || lower(btrim(n.neg_text)) || ' ' IN ' ' || lower(btrim(i.search_term)) || ' ') > 0)
         OR (n.kind = 'target' AND lower(n.neg_text) = 'asin="' || lower(btrim(i.search_term)) || '"'))
     ORDER BY (upper(n.match_type) = 'NEGATIVE_EXACT') DESC, n.amazon_created_at ASC NULLS LAST
     LIMIT 1
  ) ng ON true`;

export function productTermQueries({ adProduct = 'SP', range, portfolioId = null,
                                     sort = 'cost', dir = 'desc', limit = 200, offset = 0,
                                     q = '', minClicks = 0, onlyDead = false, match = null } = {}) {
  const col = PRODUCT_TERM_SORTS[sort] || PRODUCT_TERM_SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // $7 is the match type, from the funnel's own list or nothing.
  const filters = [adProduct, rangeParam(range), portfolioId, Number(minClicks) || 0,
                   q ? `%${q}%` : null, !!onlyDead,
                   MATCH_FUNNEL.includes(match) ? match : null];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];

  // Paged by TERM, not by row: a page holds whole terms, so a term's rows are
  // never split across two pages. The count is of terms for the same reason.
  // The campaign and ad group ride along so a row can be checked against its
  // own campaign's negatives; a product runs one campaign of each type, so
  // they do not split a row in two.
  const ctes = `
    WITH inproduct AS (
      SELECT t.search_term, ${MATCH_LABEL} AS match_label, c.campaign_type,
             coalesce(nullif(t.keyword, ''), t.targeting) AS matched,
             t.campaign_id, t.ad_group_id,
             sum(t.clicks) AS clicks, sum(t.cost) AS cost,
             sum(t.purchases7d) AS orders, sum(t.sales7d) AS sales
        FROM search_terms t
        JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
       WHERE t.ad_product = $1 AND t.date <@ $2::daterange AND c.portfolio_id = $3
         AND ($7::text IS NULL OR ${MATCH_LABEL} = $7)
       GROUP BY 1, 2, 3, 4, 5, 6
    ),
    term AS (
      SELECT search_term, sum(clicks) AS term_clicks, sum(cost) AS term_cost,
             sum(orders) AS term_orders, sum(sales) AS term_sales,
             sum(sales) / NULLIF(sum(cost), 0) AS term_roas
        FROM inproduct GROUP BY 1
    ),
    spread AS (
      SELECT t.search_term, count(DISTINCT c.portfolio_id)::int AS products
        FROM search_terms t
        LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
       WHERE t.ad_product = $1 AND t.date <@ $2::daterange
       GROUP BY 1
    ),
    picked AS (
      SELECT term.*, spread.products
        FROM term LEFT JOIN spread USING (search_term)
       WHERE term.term_clicks >= $4
         AND ($5::text IS NULL OR term.search_term ILIKE $5)
         AND ($6 = false OR term.term_orders = 0)
    )`;

  return {
    rows: {
      text: `${ctes},
             page AS (
               SELECT * FROM picked
                ORDER BY ${col} ${order} NULLS LAST, search_term
                LIMIT $8::int OFFSET $9::int
             )
             SELECT i.*, page.term_clicks, page.term_cost, page.term_orders,
                    page.term_sales, page.products,
                    ex.graduated,
                    ng.created_at AS negated_since, ng.match_type AS negated_by,
                    ng.neg_text AS negated_text, ng.level AS negated_level
               FROM inproduct i JOIN page USING (search_term)
               ${TERM_STATUS}
              ORDER BY ${col.replace(/^term_/, 'page.term_')} ${order} NULLS LAST,
                       i.search_term, ${matchOrder('i.match_label')}, i.cost DESC`,
      params: [...filters, ...paging]
    },
    count: { text: `${ctes} SELECT count(*)::int AS n FROM picked`, params: filters }
  };
}

export async function byProductTerm(opts = {}) {
  await ensure();
  const q = productTermQueries(opts);
  const [rows, [total]] = await Promise.all([
    sql().query(q.rows.text, q.rows.params),
    sql().query(q.count.text, q.count.params)
  ]);
  return {
    total: total.n,
    rows: rows.map(r => ({
      searchTerm: r.search_term, matchLabel: r.match_label, campaignType: r.campaign_type,
      matched: r.matched,
      clicks: num(r.clicks), cost: num(r.cost), orders: num(r.orders), sales: num(r.sales),
      termClicks: num(r.term_clicks), termCost: num(r.term_cost),
      termOrders: num(r.term_orders), termSales: num(r.term_sales),
      products: r.products,
      graduated: Array.isArray(r.graduated) && r.graduated.length ? r.graduated : null,
      negated: r.negated_level ? { since: r.negated_since, by: r.negated_by,
                                   text: r.negated_text, level: r.negated_level } : null
    }))
  };
}

// One term's totals per product, for the row that has been opened inside a
// product: what the whole term costs, and who else is paying for it.
export function termProductQuery({ adProduct = 'SP', range, searchTerm } = {}) {
  return {
    text: `SELECT c.portfolio_id,
                  ${PRODUCT_NAME} AS portfolio, c.brand,
                  sum(t.clicks)::numeric AS clicks, sum(t.cost)::numeric AS cost,
                  sum(t.purchases7d)::numeric AS orders, sum(t.sales7d)::numeric AS sales
             FROM search_terms t
             LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
             LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
            WHERE t.ad_product = $1 AND t.date <@ $2::daterange AND t.search_term = $3
            GROUP BY 1, 2, 3
            ORDER BY lower(${PRODUCT_NAME}) ASC`,
    params: [adProduct, rangeParam(range), String(searchTerm || '')]
  };
}

export async function termByProduct(opts = {}) {
  await ensure();
  const { text, params } = termProductQuery(opts);
  const rows = await sql().query(text, params);
  const products = rows.map(r => ({
    portfolioId: r.portfolio_id, portfolio: r.portfolio, brand: r.brand,
    clicks: num(r.clicks), cost: num(r.cost), orders: num(r.orders), sales: num(r.sales)
  }));
  const total = products.reduce((a, p) => ({
    clicks: a.clicks + (p.clicks || 0), cost: r2(a.cost + (p.cost || 0)),
    orders: a.orders + (p.orders || 0), sales: r2(a.sales + (p.sales || 0))
  }), { clicks: 0, cost: 0, orders: 0, sales: 0 });
  return { total, products };
}

const r2 = (n) => Math.round(n * 100) / 100;

// Everything that matched one search term, across the whole account — one row
// per campaign and target rather than per day.
//
// Always account-wide, even when the list above is narrowed to one product:
// the term row totals a product's share, and this is where you see the rest of
// what is paying for the same search. One line is one mechanism, which is what
// makes it one possible action — an exact keyword earning its place, an auto
// close-match that is not, another product's broad keyword catching the same
// shopper.
export function termDetailQuery({ adProduct = 'SP', range, searchTerm } = {}) {
  return {
    text: `SELECT c.portfolio_id,
                  ${PRODUCT_NAME} AS portfolio, c.brand,
                  coalesce(c.name, t.campaign) AS campaign, c.campaign_type,
                  coalesce(nullif(t.keyword, ''), t.targeting) AS matched,
                  ${MATCH_LABEL} AS match_label,
                  sum(t.clicks)::numeric AS clicks, sum(t.cost)::numeric AS cost,
                  sum(t.purchases7d)::numeric AS orders, sum(t.sales7d)::numeric AS sales
             FROM search_terms t
             LEFT JOIN ad_campaigns c ON c.campaign_id = t.campaign_id
             LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
            WHERE t.ad_product = $1 AND t.date <@ $2::daterange AND t.search_term = $3
            GROUP BY 1, 2, 3, 4, 5, 6, 7
            -- By product first: the breakdown is read to see which products are
            -- paying for one search, and spend order scattered a product's own
            -- lines through the list.
            --
            -- Then by how it matched, in FUNNEL order rather than alphabetically,
            -- so each product reads the way the structure is meant to work.
            -- Biggest line first inside a match type.
            ORDER BY lower(${PRODUCT_NAME}) ASC,
                     ${matchOrder(MATCH_LABEL)},
                     sum(t.cost) DESC NULLS LAST`,
    params: [adProduct, rangeParam(range), String(searchTerm || '')]
  };
}

export async function termDetail(opts = {}) {
  await ensure();
  const { text, params } = termDetailQuery(opts);
  const rows = await sql().query(text, params);
  return rows.map(r => ({
    portfolioId: r.portfolio_id, portfolio: r.portfolio, brand: r.brand,
    campaign: r.campaign, campaignType: r.campaign_type,
    matched: r.matched, matchLabel: r.match_label,
    clicks: num(r.clicks), cost: num(r.cost), orders: num(r.orders), sales: num(r.sales)
  }));
}

// One page of the range's daily rows. Brand and campaign type are joined from
// the census rather than stored here, the same rule every cadence follows:
// configuration is read at query time so a re-mapped brand moves its history.
export async function getRows(opts = {}) {
  await ensure();
  const q = rowQueries(opts);
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
