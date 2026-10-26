// SQL storage for Sponsored Products keywords and targets, with their bids and
// Amazon's suggested bid for each (the `sp_targets` and
// `sp_target_bid_suggestions` tables).
//
// Why this exists: the campaign list holds each ad group's DEFAULT bid, and in
// September three quarters of search term spend ran on keywords and targets
// carrying a bid of their own, which a default bid does not touch. The bid that
// is actually doing the work lives here.
//
// A snapshot, not a history. A pull replaces the whole list, so what is stored
// is the account as it stood when the pull ran. The daily cron will keep it
// current; until then it is as fresh as the last press of Pull bids.
//
//   sp_targets                 — one row per keyword or target, enabled or
//                                paused. Archived ones are left out: Amazon
//                                will not switch an archived target back on.
//   sp_target_bid_suggestions  — Amazon's low, suggested and high bid per
//                                target, or why there is none. Kept apart from
//                                the targets so a re-pull of the bids does not
//                                blank the suggestions while new ones are fetched.

import { sql } from './sql.js';
import { PRODUCT_NAME, rangeParam } from './searchterms.js';

// [field, column, sql type], in the order a row is written. `expression` and
// `recExpr` are JSON, sent as text and cast on the way in.
//
// The two Amazon dates are when the keyword or target was created and last
// changed. Created is the useful one: for an exact keyword that came out of a
// search term it is the day the term was graduated, which is where "has it
// earned its place since" starts counting.
export const TG_COLUMNS = [
  ['targetId', 'target_id', 'text'], ['kind', 'kind', 'text'],
  ['campaignId', 'campaign_id', 'text'], ['adGroupId', 'ad_group_id', 'text'],
  ['state', 'state', 'text'], ['matchLabel', 'match_label', 'text'],
  ['text', 'target_text', 'text'], ['bid', 'bid', 'numeric'],
  ['expression', 'expression', 'json'], ['recExpr', 'rec_expr', 'json'],
  ['createdAt', 'amazon_created_at', 'timestamptz'],
  ['updatedAt', 'amazon_updated_at', 'timestamptz'],
  ['servingStatus', 'serving_status', 'text']
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS sp_targets (
    target_id   text        PRIMARY KEY,
    kind        text        NOT NULL,
    campaign_id text,
    ad_group_id text,
    state       text,
    match_label text,
    target_text text,
    bid         numeric,
    expression  json,
    rec_expr    json,
    pulled_at   timestamptz NOT NULL
  )`,
  // Amazon's suggestions are asked for an ad group at a time.
  'CREATE INDEX IF NOT EXISTS sp_targets_ad_group_idx ON sp_targets (ad_group_id)',
  `CREATE TABLE IF NOT EXISTS sp_target_bid_suggestions (
    target_id  text        PRIMARY KEY,
    low        numeric,
    mid        numeric,
    high       numeric,
    theme      text,
    version    text,
    note       text,
    fetched_at timestamptz NOT NULL DEFAULT now()
  )`,
  'ALTER TABLE sp_targets ADD COLUMN IF NOT EXISTS amazon_created_at timestamptz',
  'ALTER TABLE sp_targets ADD COLUMN IF NOT EXISTS amazon_updated_at timestamptz',
  'ALTER TABLE sp_targets ADD COLUMN IF NOT EXISTS serving_status text',
  // What changed between one pull and the next. Nothing in this app changes a
  // bid or a target yet, so every row here was made somewhere else — Ad Badger
  // or by hand in the console — and landed some time between previous_at and
  // detected_at. When the dashboard starts making changes they go in here too,
  // under their own source, so the two can be told apart.
  `CREATE TABLE IF NOT EXISTS sp_target_changes (
    id          bigserial   PRIMARY KEY,
    target_id   text        NOT NULL,
    campaign_id text,
    ad_group_id text,
    match_label text,
    target_text text,
    field       text        NOT NULL,
    from_value  text,
    to_value    text,
    source      text        NOT NULL,
    previous_at timestamptz,
    detected_at timestamptz NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS sp_target_changes_target_idx ON sp_target_changes (target_id)',
  // Each keyword and target's own day: impressions — all of them, not only
  // those of the searches that got a click, which is all the search term
  // report carries — and how much of the top of search it won.
  `CREATE TABLE IF NOT EXISTS sp_target_days (
    date            date    NOT NULL,
    target_id       text    NOT NULL,
    campaign_id     text,
    ad_group_id     text,
    keyword         text,
    targeting       text,
    match_type      text,
    keyword_type    text,
    status          text,
    keyword_bid     numeric,
    impressions     numeric,
    clicks          numeric,
    cost            numeric,
    purchases7d     numeric,
    sales7d         numeric,
    top_of_search_is numeric
  )`,
  'CREATE INDEX IF NOT EXISTS sp_target_days_date_idx ON sp_target_days (date)',
  'CREATE INDEX IF NOT EXISTS sp_target_days_target_idx ON sp_target_days (target_id)',
  // Negative keywords and negative product targets, at both levels. `list`
  // is which of Amazon's four lists a row came from: each is replaced on its
  // own, so one list failing leaves its rows as they were.
  `CREATE TABLE IF NOT EXISTS sp_negatives (
    negative_id text        NOT NULL,
    list        text        NOT NULL,
    level       text        NOT NULL,
    kind        text        NOT NULL,
    campaign_id text,
    ad_group_id text,
    state       text,
    match_type  text,
    neg_text    text,
    expression  json,
    amazon_created_at timestamptz,
    pulled_at   timestamptz NOT NULL,
    PRIMARY KEY (list, negative_id)
  )`,
  'CREATE INDEX IF NOT EXISTS sp_negatives_campaign_idx ON sp_negatives (campaign_id)',
  // The products each ad group advertises. What says a product is targeting
  // its own ASIN, or bidding on a search for itself.
  `CREATE TABLE IF NOT EXISTS sp_product_ads (
    ad_id       text        PRIMARY KEY,
    campaign_id text,
    ad_group_id text,
    asin        text,
    sku         text,
    state       text,
    pulled_at   timestamptz NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sp_product_ads_ad_group_idx ON sp_product_ads (ad_group_id)'
];

let ready = null;

export function ensure() {
  if (!ready) {
    ready = (async () => { for (const ddl of DDL) await sql().query(ddl); })();
    ready.catch(() => { ready = null; });   // try again on the next call
  }
  return ready;
}

const CHUNK = 2000;

// INSERT statements for a set of rows described by a column spec, `extra`
// naming further columns set the same for every row (`pulled_at = now()`).
// JSON travels as text and is cast on the way in: a JS array of objects has no
// Postgres array form. Chunked, and handed back unrun, so a caller can put
// them in one transaction with its delete.
export function insertsFor(s, table, spec, rows, extra = {}) {
  const cols = spec.map(([, col]) => col).join(', ');
  const unnest = spec.map(([, , t], i) => `$${i + 1}::${t === 'json' ? 'text' : t}[]`).join(', ');
  const picks = spec.map(([, col, t]) => (t === 'json' ? `${col}::json` : col)).join(', ');
  const extraCols = Object.keys(extra);
  const values = (chunk) => spec.map(([field, , t]) => chunk.map(r => {
    const v = r[field];
    if (v === undefined || v === null) return null;
    return t === 'json' ? JSON.stringify(v) : v;
  }));
  const out = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(s.query(
      `INSERT INTO ${table} (${cols}${extraCols.map(c => `, ${c}`).join('')})
       SELECT ${picks}${extraCols.map(c => `, ${extra[c]}`).join('')}
         FROM unnest(${unnest}) AS v(${cols})`,
      values(rows.slice(i, i + CHUNK))));
  }
  return out;
}

// What changed for each keyword and target between two pulls: one appearing,
// one going (archived, or deleted), a state switched, a bid moved. A bid of
// null is the ad group's default, so a target moving onto or off its default
// is a change too. Bids are compared to the cent; Amazon has no finer.
export function diffTargets(before, after) {
  const was = new Map(before.map(r => [String(r.targetId), r]));
  const now = new Map(after.map(r => [String(r.targetId), r]));
  const cents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
  const shown = (v) => (v === null || v === undefined ? null : String(v));
  const bidText = (v) => (cents(v) === null ? 'default' : (cents(v) / 100).toFixed(2));
  const out = [];
  const line = (r, field, from, to) => out.push({
    targetId: String(r.targetId), campaignId: r.campaignId || null, adGroupId: r.adGroupId || null,
    matchLabel: r.matchLabel || null, text: r.text || null, field, from, to
  });
  for (const [id, r] of now) {
    const old = was.get(id);
    if (!old) { line(r, 'added', null, shown(r.state)); continue; }
    if (shown(old.state) !== shown(r.state)) line(r, 'state', shown(old.state), shown(r.state));
    if (cents(old.bid) !== cents(r.bid)) line(r, 'bid', bidText(old.bid), bidText(r.bid));
  }
  for (const [id, old] of was) {
    if (!now.has(id)) line(old, 'removed', shown(old.state), null);
  }
  return out;
}

const CHANGE_SPEC = [
  ['targetId', 'target_id', 'text'], ['campaignId', 'campaign_id', 'text'],
  ['adGroupId', 'ad_group_id', 'text'], ['matchLabel', 'match_label', 'text'],
  ['text', 'target_text', 'text'], ['field', 'field', 'text'],
  ['from', 'from_value', 'text'], ['to', 'to_value', 'text']
];

// Replace the whole list with this pull, and log what changed since the last
// one. Every chunk goes in the same transaction as the delete, so a pull that
// fails part way leaves the previous list standing rather than half of a new
// one — and logs nothing, since nothing was replaced.
//
// The very first pull has nothing to compare with and logs nothing: every
// target "appearing" at once is not a change anyone made.
export async function replaceAll(rows) {
  await ensure();
  const s = sql();
  const previous = await s.query(
    `SELECT target_id, campaign_id, ad_group_id, match_label, target_text, state, bid,
            max(pulled_at) OVER () AS pulled_at
       FROM sp_targets`);
  const changes = previous.length
    ? diffTargets(previous.map(r => ({
        targetId: r.target_id, campaignId: r.campaign_id, adGroupId: r.ad_group_id,
        matchLabel: r.match_label, text: r.target_text, state: r.state,
        bid: r.bid === null ? null : Number(r.bid)
      })), rows)
    : [];
  const previousAt = previous.length && previous[0].pulled_at
    ? new Date(previous[0].pulled_at).toISOString() : null;
  await s.transaction([
    s.query('DELETE FROM sp_targets'),
    ...insertsFor(s, 'sp_targets', TG_COLUMNS, rows, { pulled_at: 'now()' }),
    ...insertsFor(s, 'sp_target_changes', CHANGE_SPEC, changes, {
      source: "'snapshot'",
      previous_at: previousAt ? `'${previousAt}'::timestamptz` : 'NULL::timestamptz'
    })
  ]);
  return { stored: rows.length, changes: changes.length, first: !previous.length };
}

// ─── EACH TARGET'S DAY ───────────────────────────────────────────────────────

export const DAY_COLUMNS = [
  ['date', 'date', 'date'], ['targetId', 'target_id', 'text'],
  ['campaignId', 'campaign_id', 'text'], ['adGroupId', 'ad_group_id', 'text'],
  ['keyword', 'keyword', 'text'], ['targeting', 'targeting', 'text'],
  ['matchType', 'match_type', 'text'], ['keywordType', 'keyword_type', 'text'],
  ['status', 'status', 'text'], ['keywordBid', 'keyword_bid', 'numeric'],
  ['impressions', 'impressions', 'numeric'], ['clicks', 'clicks', 'numeric'],
  ['cost', 'cost', 'numeric'], ['purchases7d', 'purchases7d', 'numeric'],
  ['sales7d', 'sales7d', 'numeric'], ['topOfSearchIs', 'top_of_search_is', 'numeric']
];

// Store a pull of the daily targeting report, replacing only the days it
// covers — the same rule as search terms: a re-pull that comes back shorter
// must not delete days it did not bring.
export async function replaceDays(rows) {
  await ensure();
  const dates = rows.map(r => r.date).filter(Boolean).sort();
  if (!dates.length) return { from: null, to: null, stored: 0 };
  const from = dates[0], to = dates[dates.length - 1];
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM sp_target_days WHERE date BETWEEN $1::date AND $2::date', [from, to]),
    ...insertsFor(s, 'sp_target_days', DAY_COLUMNS, rows)
  ]);
  return { from, to, stored: rows.length };
}

// The last day held, which is where the next daily pull carries on from.
export async function lastDay() {
  await ensure();
  const [r] = await sql().query(`SELECT to_char(max(date), 'YYYY-MM-DD') AS last FROM sp_target_days`);
  return (r && r.last) || null;
}

// ─── NEGATIVES AND PRODUCT ADS ───────────────────────────────────────────────

export const NEGATIVE_COLUMNS = [
  ['negativeId', 'negative_id', 'text'], ['list', 'list', 'text'],
  ['level', 'level', 'text'], ['kind', 'kind', 'text'],
  ['campaignId', 'campaign_id', 'text'], ['adGroupId', 'ad_group_id', 'text'],
  ['state', 'state', 'text'], ['matchType', 'match_type', 'text'],
  ['text', 'neg_text', 'text'], ['expression', 'expression', 'json'],
  ['createdAt', 'amazon_created_at', 'timestamptz']
];

// One of Amazon's four negative lists, replacing what that list held before.
export async function replaceNegatives(list, rows) {
  await ensure();
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM sp_negatives WHERE list = $1', [list]),
    ...insertsFor(s, 'sp_negatives', NEGATIVE_COLUMNS, rows.map(r => ({ ...r, list })), { pulled_at: 'now()' })
  ]);
  return { stored: rows.length };
}

export const PRODUCT_AD_COLUMNS = [
  ['adId', 'ad_id', 'text'], ['campaignId', 'campaign_id', 'text'],
  ['adGroupId', 'ad_group_id', 'text'], ['asin', 'asin', 'text'],
  ['sku', 'sku', 'text'], ['state', 'state', 'text']
];

export async function replaceProductAds(rows) {
  await ensure();
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM sp_product_ads'),
    ...insertsFor(s, 'sp_product_ads', PRODUCT_AD_COLUMNS, rows, { pulled_at: 'now()' })
  ]);
  return { stored: rows.length };
}

// A suggestion is current for a day from when it was fetched, however often
// the bids are pulled in between. Amazon's range for a target does not depend
// on what the target bids, so a fresh pull of the bids is no reason to ask
// again — and counting a suggestion as current only when it was fetched after
// the latest bid pull is what made every press of Pull bids start the whole
// list over.
const SUGGESTION_CURRENT = `s.fetched_at >= now() - interval '24 hours'`;

export const STATUS_SQL = `
  SELECT max(g.pulled_at) AS pulled_at,
         count(*)::int AS targets,
         count(*) FILTER (WHERE g.kind = 'keyword')::int AS keywords,
         count(*) FILTER (WHERE g.state = 'ENABLED')::int AS enabled,
         count(*) FILTER (WHERE g.state = 'PAUSED')::int AS paused,
         count(*) FILTER (WHERE g.bid IS NOT NULL)::int AS own_bid,
         count(*) FILTER (WHERE g.rec_expr IS NOT NULL)::int AS askable,
         count(*) FILTER (WHERE g.rec_expr IS NOT NULL AND ${SUGGESTION_CURRENT})::int AS asked,
         count(*) FILTER (WHERE ${SUGGESTION_CURRENT}
                            AND coalesce(s.low, s.mid, s.high) IS NOT NULL)::int AS suggested,
         count(DISTINCT g.ad_group_id) FILTER (
           WHERE g.rec_expr IS NOT NULL
             AND (s.fetched_at IS NULL OR NOT (${SUGGESTION_CURRENT})))::int AS groups_left,
         max(s.fetched_at) AS suggested_at
    FROM sp_targets g
    LEFT JOIN sp_target_bid_suggestions s ON s.target_id = g.target_id`;

export const NEED_SQL = `
  SELECT g.campaign_id, g.ad_group_id, g.target_id, g.state, g.rec_expr
    FROM sp_targets g
    LEFT JOIN sp_target_bid_suggestions s ON s.target_id = g.target_id
   WHERE g.rec_expr IS NOT NULL
     AND (s.fetched_at IS NULL OR NOT (${SUGGESTION_CURRENT}))
   ORDER BY g.ad_group_id, g.target_id`;

// What is stored, and how far Amazon's suggestions have got. A suggestion
// past its day is still shown; the next round asks for it again.
export async function status() {
  await ensure();
  const [r] = await sql().query(STATUS_SQL);
  if (!r || !r.targets) return null;
  return {
    pulledAt: r.pulled_at, targets: r.targets, keywords: r.keywords,
    enabled: r.enabled, paused: r.paused, ownBid: r.own_bid,
    askable: r.askable, asked: r.asked, suggested: r.suggested,
    groupsLeft: r.groups_left, suggestedAt: r.suggested_at
  };
}

// The ad groups still waiting on Amazon's suggestions, each with the targets
// to ask about. Enabled targets first, so a round cut short has spent itself
// on the ones that are running.
export async function needSuggestions(limitGroups = 50) {
  await ensure();
  const rows = await sql().query(NEED_SQL);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.campaign_id}|${r.ad_group_id}`;
    if (!groups.has(key)) {
      groups.set(key, { campaignId: r.campaign_id, adGroupId: r.ad_group_id, enabled: false, targets: [] });
    }
    const g = groups.get(key);
    if (r.state === 'ENABLED') g.enabled = true;
    g.targets.push({ targetId: r.target_id, rec: r.rec_expr });
  }
  return [...groups.values()]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .slice(0, limitGroups);
}

export async function recordSuggestions(list) {
  if (!list.length) return;
  await ensure();
  await sql().query(
    `INSERT INTO sp_target_bid_suggestions (target_id, low, mid, high, theme, version, note, fetched_at)
     SELECT target_id, low, mid, high, theme, version, note, now()
       FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[],
                   $5::text[], $6::text[], $7::text[])
         AS v(target_id, low, mid, high, theme, version, note)
     ON CONFLICT (target_id) DO UPDATE SET
       low = excluded.low, mid = excluded.mid, high = excluded.high,
       theme = excluded.theme, version = excluded.version, note = excluded.note,
       fetched_at = excluded.fetched_at`,
    ['targetId', 'low', 'mid', 'high', 'theme', 'version', 'note']
      .map(f => list.map(x => (x[f] === undefined ? null : x[f]))));
}

// Whether any suggestion has ever come back. Until one has, a refusal from
// Amazon is more likely to be about how it was asked than about the target,
// so it is reported rather than written against every target.
export async function anySuggestion() {
  await ensure();
  const [r] = await sql().query(
    'SELECT EXISTS (SELECT 1 FROM sp_target_bid_suggestions WHERE coalesce(low, mid, high) IS NOT NULL) AS any');
  return !!(r && r.any);
}

// ─── THE TARGETS TABLE ───────────────────────────────────────────────────────
// One row per keyword or target: its bid today, Amazon's range today, and what
// it did in the range on screen. The two halves are from different times — the
// bid as of the last pull, the figures from the range — and the page says so.
//
// The figures are the targeting report's, each target's own day: every
// impression it won, not only those of the searches that got a click, which is
// all the search term report carries — a tenth of them in October. And how
// much of the top of search it won. A target that served nothing in the range
// is still listed, with no figures: a paused target is often exactly that.
//
// Top-of-search share is Amazon's per day; across days it is weighted by the
// day's impressions, so a day the target barely served counts for little.
//
// `position` is where the bid sits against Amazon's range. It is a comparison
// of two numbers, not a verdict on either.
//
// A target with no bid of its own bids its ad group's default. The campaign
// list carries the default of the campaign's one ad group, so it is only this
// target's default when the ad groups match. Otherwise it is not known here.
const TARGET_BASE = `
  WITH perf AS (
    SELECT target_id, sum(impressions) AS impressions, sum(clicks) AS clicks, sum(cost) AS cost,
           sum(purchases7d) AS orders, sum(sales7d) AS sales,
           sum(top_of_search_is * impressions) FILTER (WHERE top_of_search_is IS NOT NULL)
             / NULLIF(sum(impressions) FILTER (WHERE top_of_search_is IS NOT NULL), 0) AS top_share
      FROM sp_target_days
     WHERE $1::text = 'SP' AND date <@ $2::daterange
     GROUP BY 1
  ),
  tg AS (
    SELECT g.target_id, g.kind, g.state, g.match_label, g.target_text,
           g.campaign_id, g.ad_group_id, g.bid,
           CASE WHEN c.ad_group_id = g.ad_group_id THEN c.default_bid END AS default_bid,
           coalesce(g.bid, CASE WHEN c.ad_group_id = g.ad_group_id THEN c.default_bid END) AS live_bid,
           coalesce(c.name, g.campaign_id) AS campaign, c.state AS campaign_state,
           c.campaign_type, c.portfolio_id, ${PRODUCT_NAME} AS portfolio,
           g.rec_expr IS NOT NULL AS askable,
           s.low, s.mid, s.high, s.note, s.fetched_at,
           perf.impressions, perf.clicks, perf.cost, perf.orders, perf.sales, perf.top_share
      FROM sp_targets g
      LEFT JOIN ad_campaigns c ON c.campaign_id = g.campaign_id
      LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
      LEFT JOIN sp_target_bid_suggestions s ON s.target_id = g.target_id
      LEFT JOIN perf ON perf.target_id = g.target_id
  ),
  placed AS (
    SELECT tg.*,
           CASE WHEN low IS NULL OR high IS NULL OR live_bid IS NULL THEN 'none'
                WHEN live_bid < low  THEN 'below'
                WHEN live_bid > high THEN 'above'
                ELSE 'within' END AS position
      FROM tg
  )`;

// Sort keys the page may ask for, whitelisted because the column is
// interpolated. CPC and ROAS divide, and a division by zero stops the whole
// statement, so both go through NULLIF and sort last when they cannot be had.
const TARGET_SORTS = {
  target: 'lower(target_text)', match: 'match_label', state: 'state',
  bid: 'live_bid', low: 'low', mid: 'mid', high: 'high',
  impressions: 'impressions', ctr: '(clicks / NULLIF(impressions, 0))', top: 'top_share',
  clicks: 'clicks', cost: 'cost', cpc: '(cost / NULLIF(clicks, 0))',
  orders: 'orders', sales: 'sales', roas: '(sales / NULLIF(cost, 0))',
  campaign: 'lower(campaign)', product: 'lower(portfolio)'
};

export const TARGET_POSITIONS = ['below', 'within', 'above', 'none'];

// Filters numbered first and paging last, as in searchterms.js, and the
// position filter last of the filters: the tally of positions takes every
// filter except that one, and dropping the final parameter is the only way
// to leave one out without renumbering the rest.
export function targetQueries({ adProduct = 'SP', range, portfolioId = null, q = '',
                                match = null, state = null, position = null,
                                sort = 'cost', dir = 'desc', limit = 200, offset = 0 } = {}) {
  const col = TARGET_SORTS[sort] || TARGET_SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const filters = [adProduct, rangeParam(range), portfolioId || null, q ? `%${q}%` : null,
                   match || null, state || null,
                   TARGET_POSITIONS.includes(position) ? position : null];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];
  const where = `($3::text IS NULL OR portfolio_id = $3)
             AND ($4::text IS NULL OR target_text ILIKE $4)
             AND ($5::text IS NULL OR match_label = $5)
             AND ($6::text IS NULL OR state = $6)`;
  return {
    rows: {
      text: `${TARGET_BASE}
             SELECT * FROM placed
              WHERE ${where} AND ($7::text IS NULL OR position = $7)
              ORDER BY ${col} ${order} NULLS LAST, lower(target_text), target_id
              LIMIT $8::int OFFSET $9::int`,
      params: [...filters, ...paging]
    },
    count: {
      text: `${TARGET_BASE}
             SELECT count(*)::int AS n FROM placed
              WHERE ${where} AND ($7::text IS NULL OR position = $7)`,
      params: filters
    },
    // How many targets, and how much of the range's spend, sit at each
    // position — under every filter but position itself, so the choices in
    // that filter say what picking each one would show.
    positions: {
      text: `${TARGET_BASE}
             SELECT position, count(*)::int AS targets,
                    coalesce(sum(cost), 0)::numeric AS cost
               FROM placed WHERE ${where}
              GROUP BY 1`,
      params: filters.slice(0, 6)
    },
    // The products and match types present, for the filters' choices.
    facets: {
      text: `${TARGET_BASE}
             SELECT DISTINCT portfolio_id, portfolio, match_label FROM placed`,
      params: filters.slice(0, 2)
    }
  };
}

// ─── THE NEGATIVES TABLE ─────────────────────────────────────────────────────
// One row per negative that is on: what it blocks, where, since when — and
// what the term it blocks did in that campaign, from the stored search terms,
// split at the day the negative was added.
//
// The figures are every stored day, not the month on screen: "before it was
// added" reaches back as far as the store does. A negative older than the
// first stored day has nothing stored before it, which is not the same as
// nothing happening — its before figures are left empty rather than zero.
//
// The day a negative was added counts as before: it went in partway through
// that day, and the clicks that day are mostly from before it — "equal earth
// map" took 26 clicks the morning it was negated, and none after. "Since"
// starts the day after, so anything there is the term getting through.
//
// Graduated is the same fact as on a product's terms: the product targets the
// term as a keyword of its own, broad, phrase or exact — each with the day it
// was added, since a term often goes Auto to Broad to Exact over months. A
// converting term negated in Auto with a keyword of its own beside it is a
// graduation; without one, it is a block.
const NEG_TYPE = `CASE WHEN n.kind = 'target' THEN 'Product'
                       WHEN upper(n.match_type) = 'NEGATIVE_PHRASE' THEN 'Phrase'
                       ELSE 'Exact' END`;

// Every keyword the product holds, one per term and match type: the enabled
// one over a paused one, then the oldest. The same rule a product's terms
// apply in lib/searchterms.js, so both tabs read the same fact the same way.
export const GRADUATED_KEYWORDS = `
  SELECT DISTINCT ON (kc.portfolio_id, lower(btrim(k.target_text)), k.match_label)
         kc.portfolio_id, lower(btrim(k.target_text)) AS term, k.match_label,
         k.amazon_created_at AS created_at, k.state
    FROM sp_targets k
    JOIN ad_campaigns kc ON kc.campaign_id = k.campaign_id
   WHERE k.kind = 'keyword' AND k.match_label IN ('Broad', 'Phrase', 'Exact')
   ORDER BY kc.portfolio_id, lower(btrim(k.target_text)), k.match_label,
            (k.state = 'ENABLED') DESC, k.amazon_created_at ASC NULLS LAST`;

// Those keywords as one list per term, oldest first — the order it moved down
// the funnel in.
export const GRADUATED_AGG = `json_agg(json_build_object('type', match_label, 'since', created_at, 'state', state)
                                       ORDER BY created_at ASC NULLS LAST, match_label)`;

const NEGATIVE_BASE = `
  WITH neg AS (
    SELECT n.negative_id, n.list, n.level, n.kind, n.campaign_id, n.ad_group_id,
           n.neg_text, n.amazon_created_at,
           (n.amazon_created_at AT TIME ZONE 'America/Los_Angeles')::date AS added_on,
           ${NEG_TYPE} AS neg_type,
           CASE WHEN n.kind = 'target' THEN lower(substring(n.neg_text FROM 'asin="([^"]+)"'))
                ELSE lower(btrim(n.neg_text)) END AS match_key,
           coalesce(c.name, n.campaign_id) AS campaign, c.campaign_type,
           c.portfolio_id, ${PRODUCT_NAME} AS portfolio
      FROM sp_negatives n
      LEFT JOIN ad_campaigns c ON c.campaign_id = n.campaign_id
      LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
     WHERE coalesce(n.state, 'ENABLED') = 'ENABLED'
  ),
  first_day AS (
    SELECT min(date) AS d FROM search_terms WHERE ad_product = $1
  ),
  terms AS (
    SELECT campaign_id, ad_group_id, lower(btrim(search_term)) AS term, date,
           clicks, cost, purchases7d, sales7d
      FROM search_terms WHERE ad_product = $1
  ),
  matched AS (
    SELECT neg.list, neg.negative_id, neg.added_on, terms.date,
           terms.clicks, terms.cost, terms.purchases7d, terms.sales7d
      FROM neg
      JOIN terms ON terms.campaign_id = neg.campaign_id AND terms.term = neg.match_key
     WHERE neg.neg_type <> 'Phrase'
       AND (neg.level = 'campaign' OR terms.ad_group_id = neg.ad_group_id)
    UNION ALL
    SELECT neg.list, neg.negative_id, neg.added_on, terms.date,
           terms.clicks, terms.cost, terms.purchases7d, terms.sales7d
      FROM neg
      JOIN terms ON terms.campaign_id = neg.campaign_id
     WHERE neg.neg_type = 'Phrase'
       AND (neg.level = 'campaign' OR terms.ad_group_id = neg.ad_group_id)
       AND position(' ' || neg.match_key || ' ' IN ' ' || terms.term || ' ') > 0
  ),
  hit AS (
    SELECT list, negative_id,
           sum(clicks)      FILTER (WHERE date <= added_on) AS before_clicks,
           sum(cost)        FILTER (WHERE date <= added_on) AS before_cost,
           sum(purchases7d) FILTER (WHERE date <= added_on) AS before_orders,
           sum(sales7d)     FILTER (WHERE date <= added_on) AS before_sales,
           sum(clicks)      FILTER (WHERE date >  added_on) AS since_clicks,
           sum(cost)        FILTER (WHERE date >  added_on) AS since_cost
      FROM matched
     GROUP BY 1, 2
  ),
  grads AS (
    SELECT portfolio_id, term, ${GRADUATED_AGG} AS graduated
      FROM (${GRADUATED_KEYWORDS}) one
     GROUP BY 1, 2
  ),
  listed AS (
    SELECT neg.*,
           CASE WHEN neg.added_on >= fd.d THEN coalesce(hit.before_clicks, 0) END AS before_clicks,
           CASE WHEN neg.added_on >= fd.d THEN coalesce(hit.before_cost, 0) END AS before_cost,
           CASE WHEN neg.added_on >= fd.d THEN coalesce(hit.before_orders, 0) END AS before_orders,
           CASE WHEN neg.added_on >= fd.d THEN coalesce(hit.before_sales, 0) END AS before_sales,
           CASE WHEN neg.added_on IS NOT NULL AND fd.d IS NOT NULL
                THEN coalesce(hit.since_clicks, 0) END AS since_clicks,
           CASE WHEN neg.added_on IS NOT NULL AND fd.d IS NOT NULL
                THEN coalesce(hit.since_cost, 0) END AS since_cost,
           g.graduated
      FROM neg
      CROSS JOIN first_day fd
      LEFT JOIN hit ON hit.list = neg.list AND hit.negative_id = neg.negative_id
      LEFT JOIN grads g
        ON neg.kind = 'keyword' AND g.portfolio_id = neg.portfolio_id AND g.term = neg.match_key
  )`;

// Whitelisted, because the column is interpolated. ROAS divides, so it goes
// through NULLIF and sorts last when there was no spend.
const NEGATIVE_SORTS = {
  negative: 'lower(neg_text)', type: 'neg_type', level: 'level', added: 'amazon_created_at',
  campaignType: 'campaign_type', graduated: "(graduated->0->>'since')",
  beforeClicks: 'before_clicks', beforeCost: 'before_cost', beforeOrders: 'before_orders',
  beforeSales: 'before_sales', beforeRoas: '(before_sales / NULLIF(before_cost, 0))',
  sinceClicks: 'since_clicks', sinceCost: 'since_cost', campaign: 'lower(campaign)',
  product: 'lower(portfolio)'
};

export const NEGATIVE_TYPES = ['Exact', 'Phrase', 'Product'];
export const NEGATIVE_LEVELS = ['ad_group', 'campaign'];

// Filters numbered first and paging last, as everywhere on this page.
export function negativeQueries({ adProduct = 'SP', portfolioId = null, q = '', type = null,
                                  level = null, campaignType = null, sort = 'added', dir = 'desc',
                                  limit = 200, offset = 0 } = {}) {
  const col = NEGATIVE_SORTS[sort] || NEGATIVE_SORTS.added;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // The campaign type is a parameter, so any value is safe; one that names
  // no type simply matches nothing.
  const filters = [adProduct, portfolioId || null, q ? `%${q}%` : null,
                   NEGATIVE_TYPES.includes(type) ? type : null,
                   NEGATIVE_LEVELS.includes(level) ? level : null,
                   campaignType ? String(campaignType).slice(0, 40) : null];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];
  const where = `($2::text IS NULL OR portfolio_id = $2)
             AND ($3::text IS NULL OR neg_text ILIKE $3)
             AND ($4::text IS NULL OR neg_type = $4)
             AND ($5::text IS NULL OR level = $5)
             AND ($6::text IS NULL OR campaign_type = $6)`;
  return {
    rows: {
      text: `${NEGATIVE_BASE}
             SELECT * FROM listed WHERE ${where}
              ORDER BY ${col} ${order} NULLS LAST, lower(neg_text), negative_id
              LIMIT $7::int OFFSET $8::int`,
      params: [...filters, ...paging]
    },
    // The total, and how many of those were added lately and how many
    // blocked a term that had sold before — under the same filters.
    summary: {
      text: `${NEGATIVE_BASE}
             SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE amazon_created_at >= now() - interval '7 days')::int AS last7,
                    count(*) FILTER (WHERE amazon_created_at >= now() - interval '30 days')::int AS last30,
                    count(*) FILTER (WHERE before_orders > 0)::int AS sold_before,
                    count(*) FILTER (WHERE before_orders > 0 AND graduated IS NOT NULL)::int AS sold_before_graduated,
                    (SELECT to_char(d, 'YYYY-MM-DD') FROM first_day) AS first_day
               FROM listed WHERE ${where}`,
      params: filters
    },
    // The products and campaign types present, for the filters' choices.
    // Every negative, not only the filtered ones, so a choice can be made
    // from any state.
    facets: {
      text: `SELECT DISTINCT c.portfolio_id, ${PRODUCT_NAME} AS portfolio, c.campaign_type
               FROM sp_negatives n
               LEFT JOIN ad_campaigns c ON c.campaign_id = n.campaign_id
               LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id`,
      params: []
    }
  };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function byNegative(opts = {}) {
  await ensure();
  const q = negativeQueries(opts);
  const [rows, [summary], facets] = await Promise.all([
    sql().query(q.rows.text, q.rows.params),
    sql().query(q.summary.text, q.summary.params),
    sql().query(q.facets.text, q.facets.params)
  ]);
  const products = new Map();
  const campaignTypes = new Set();
  for (const f of facets) {
    if (f.portfolio_id) products.set(f.portfolio_id, f.portfolio);
    if (f.campaign_type) campaignTypes.add(f.campaign_type);
  }
  return {
    total: summary.total,
    summary: { last7: summary.last7, last30: summary.last30, soldBefore: summary.sold_before,
               soldBeforeGraduated: summary.sold_before_graduated, firstDay: summary.first_day },
    products: [...products].map(([id, name]) => ({ id, name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    campaignTypes: [...campaignTypes],
    rows: rows.map(r => ({
      negativeId: r.negative_id, list: r.list, level: r.level, kind: r.kind,
      type: r.neg_type, text: r.neg_text, addedAt: r.amazon_created_at,
      campaignId: r.campaign_id, campaign: r.campaign, campaignType: r.campaign_type,
      portfolioId: r.portfolio_id, portfolio: r.portfolio,
      graduated: Array.isArray(r.graduated) && r.graduated.length ? r.graduated : null,
      beforeClicks: num(r.before_clicks), beforeCost: num(r.before_cost),
      beforeOrders: num(r.before_orders), beforeSales: num(r.before_sales),
      sinceClicks: num(r.since_clicks), sinceCost: num(r.since_cost)
    }))
  };
}

export async function byTarget(opts = {}) {
  await ensure();
  const q = targetQueries(opts);
  const [rows, [total], positions, facets] = await Promise.all([
    sql().query(q.rows.text, q.rows.params),
    sql().query(q.count.text, q.count.params),
    sql().query(q.positions.text, q.positions.params),
    sql().query(q.facets.text, q.facets.params)
  ]);
  const products = new Map();
  const matches = new Set();
  for (const f of facets) {
    if (f.portfolio_id) products.set(f.portfolio_id, f.portfolio);
    if (f.match_label) matches.add(f.match_label);
  }
  return {
    total: total.n,
    positions: Object.fromEntries(positions.map(p => [p.position, { targets: p.targets, cost: num(p.cost) }])),
    products: [...products].map(([id, name]) => ({ id, name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    matches: [...matches],
    rows: rows.map(r => ({
      targetId: r.target_id, kind: r.kind, state: r.state,
      matchLabel: r.match_label, text: r.target_text,
      campaignId: r.campaign_id, campaign: r.campaign, campaignState: r.campaign_state,
      campaignType: r.campaign_type, portfolioId: r.portfolio_id, portfolio: r.portfolio,
      bid: num(r.bid), defaultBid: num(r.default_bid), liveBid: num(r.live_bid),
      askable: r.askable, low: num(r.low), mid: num(r.mid), high: num(r.high),
      note: r.note, suggestedAt: r.fetched_at, position: r.position,
      impressions: num(r.impressions), topShare: num(r.top_share),
      clicks: num(r.clicks), cost: num(r.cost), orders: num(r.orders), sales: num(r.sales)
    }))
  };
}

// ─── THE CHANGE LOG ──────────────────────────────────────────────────────────
// What changed in the account, day by day, from two sources:
//
//   Amazon's own dates — every keyword, target and negative carries the day it
//     was created, so graduations and negatives can be listed back as far as
//     the account goes. Only those still enabled or paused are in the
//     snapshot; one since archived has left no trace here.
//   The morning snapshots — what changed between one pull and the next: a bid
//     raised or lowered, a target paused, enabled or archived. Amazon keeps no
//     history of these (its report's daily bid is today's bid on every day),
//     so they start the day the snapshots did and are dated the morning they
//     were seen, having happened some time since the pull before.
//
// Nothing in this dashboard changes the account yet, so everything here is
// Ad Badger's or made by hand. A target the snapshots saw appear is left to
// its creation date, so it is not listed twice.
const CHANGE_BASE = `
  WITH ev AS (
    SELECT g.amazon_created_at AS at, NULL::timestamptz AS previous_at,
           CASE WHEN g.kind = 'keyword' THEN 'keyword' ELSE 'target' END AS kind,
           g.target_text AS item, g.match_label AS detail, NULL::text AS from_value, NULL::text AS to_value,
           g.campaign_id, 'amazon' AS source
      FROM sp_targets g WHERE g.amazon_created_at IS NOT NULL
    UNION ALL
    SELECT n.amazon_created_at, NULL::timestamptz, 'negative', n.neg_text,
           CASE WHEN n.kind = 'target' THEN 'Negative ASIN'
                WHEN upper(n.match_type) = 'NEGATIVE_PHRASE' THEN 'Negative phrase'
                ELSE 'Negative exact' END || CASE WHEN n.level = 'campaign' THEN ', whole campaign' ELSE '' END,
           NULL::text, NULL::text, n.campaign_id, 'amazon'
      FROM sp_negatives n
     WHERE n.amazon_created_at IS NOT NULL AND coalesce(n.state, 'ENABLED') = 'ENABLED'
    UNION ALL
    SELECT x.detected_at, x.previous_at,
           CASE WHEN x.field = 'bid' THEN
                  CASE WHEN x.from_value ~ '^[0-9.]+$' AND x.to_value ~ '^[0-9.]+$' THEN
                         CASE WHEN x.to_value::numeric > x.from_value::numeric THEN 'bid_up' ELSE 'bid_down' END
                       ELSE 'bid' END
                WHEN x.field = 'state' THEN
                  CASE WHEN x.to_value = 'PAUSED' THEN 'paused' WHEN x.to_value = 'ENABLED' THEN 'enabled' ELSE 'state' END
                ELSE x.field END,
           x.target_text, x.match_label, x.from_value, x.to_value, x.campaign_id, 'snapshot'
      FROM sp_target_changes x WHERE x.field <> 'added'
  ),
  listed AS (
    SELECT ev.*, (ev.at AT TIME ZONE 'America/Los_Angeles')::date AS day,
           c.campaign_type, coalesce(c.name, ev.campaign_id) AS campaign,
           c.portfolio_id, ${PRODUCT_NAME} AS portfolio
      FROM ev
      LEFT JOIN ad_campaigns c ON c.campaign_id = ev.campaign_id
      LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
  )`;

export const CHANGE_KINDS = ['keyword', 'target', 'negative', 'bid_up', 'bid_down', 'bid',
                             'paused', 'enabled', 'removed'];

const CHANGE_SORTS = {
  date: 'at', kind: 'kind', item: 'lower(item)', product: 'lower(portfolio)', campaignType: 'campaign_type'
};

// Filters first, the kind last of them: the tally by kind takes every filter
// but that one, as the Targets tally by position does.
export function changeQueries({ range, portfolioId = null, q = '', kind = null,
                                sort = 'date', dir = 'desc', limit = 200, offset = 0 } = {}) {
  const col = CHANGE_SORTS[sort] || CHANGE_SORTS.date;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const filters = [rangeParam(range), portfolioId || null, q ? `%${q}%` : null,
                   CHANGE_KINDS.includes(kind) ? kind : null];
  const paging = [Math.min(Number(limit) || 200, 1000), Math.max(Number(offset) || 0, 0)];
  const where = `day <@ $1::daterange
             AND ($2::text IS NULL OR portfolio_id = $2)
             AND ($3::text IS NULL OR item ILIKE $3)`;
  return {
    rows: {
      text: `${CHANGE_BASE}
             SELECT *, to_char(day, 'YYYY-MM-DD') AS day_text
               FROM listed WHERE ${where} AND ($4::text IS NULL OR kind = $4)
              ORDER BY ${col} ${order} NULLS LAST, at DESC, lower(item)
              LIMIT $5::int OFFSET $6::int`,
      params: [...filters, ...paging]
    },
    count: {
      text: `${CHANGE_BASE}
             SELECT count(*)::int AS n FROM listed WHERE ${where} AND ($4::text IS NULL OR kind = $4)`,
      params: filters
    },
    kinds: {
      text: `${CHANGE_BASE}
             SELECT kind, count(*)::int AS n FROM listed WHERE ${where} GROUP BY 1`,
      params: filters.slice(0, 3)
    },
    // When the snapshots began, so the page can say bid changes start there.
    since: {
      text: `SELECT min(detected_at) AS first, max(detected_at) AS last FROM sp_target_changes`,
      params: []
    }
  };
}

export async function byChange(opts = {}) {
  await ensure();
  const q = changeQueries(opts);
  const [rows, [total], kinds, [since], [firstPull]] = await Promise.all([
    sql().query(q.rows.text, q.rows.params),
    sql().query(q.count.text, q.count.params),
    sql().query(q.kinds.text, q.kinds.params),
    sql().query(q.since.text, q.since.params),
    sql().query('SELECT min(pulled_at) AS first FROM sp_targets')
  ]);
  return {
    total: total.n,
    kinds: Object.fromEntries(kinds.map(k => [k.kind, k.n])),
    // The snapshot log can only begin once two pulls exist to compare; the
    // oldest pull held is the earliest it could have seen anything from.
    snapshotsSince: since.first || firstPull.first || null,
    rows: rows.map(r => ({
      at: r.at, previousAt: r.previous_at, day: r.day_text, kind: r.kind, source: r.source,
      item: r.item, detail: r.detail, from: r.from_value, to: r.to_value,
      campaign: r.campaign, campaignType: r.campaign_type,
      portfolioId: r.portfolio_id, portfolio: r.portfolio
    }))
  };
}

// The first and last day of the targeting report held. It reaches back less
// far than the search terms, so a range before it has no target figures.
export async function daySpan() {
  await ensure();
  const [r] = await sql().query(
    `SELECT to_char(min(date), 'YYYY-MM-DD') AS first, to_char(max(date), 'YYYY-MM-DD') AS last FROM sp_target_days`);
  return { first: r.first, last: r.last };
}
