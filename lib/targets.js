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
import { PRODUCT_NAME } from './searchterms.js';

// [field, column, sql type], in the order a row is written. `expression` and
// `recExpr` are JSON, sent as text and cast on the way in.
export const TG_COLUMNS = [
  ['targetId', 'target_id', 'text'], ['kind', 'kind', 'text'],
  ['campaignId', 'campaign_id', 'text'], ['adGroupId', 'ad_group_id', 'text'],
  ['state', 'state', 'text'], ['matchLabel', 'match_label', 'text'],
  ['text', 'target_text', 'text'], ['bid', 'bid', 'numeric'],
  ['expression', 'expression', 'json'], ['recExpr', 'rec_expr', 'json']
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
  )`
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

// Replace the whole list with this pull. Every chunk goes in the same
// transaction as the delete, so a pull that fails part way leaves the previous
// list standing rather than half of a new one.
export async function replaceAll(rows) {
  await ensure();
  const s = sql();
  const cols = TG_COLUMNS.map(([, col]) => col).join(', ');
  // JSON travels as text: a JS array of objects has no Postgres array form.
  const unnest = TG_COLUMNS.map(([, , t], i) => `$${i + 1}::${t === 'json' ? 'text' : t}[]`).join(', ');
  const picks = TG_COLUMNS.map(([, col, t]) => (t === 'json' ? `${col}::json` : col)).join(', ');
  const values = (chunk) => TG_COLUMNS.map(([field, , t]) => chunk.map(r => {
    const v = r[field];
    if (v === undefined || v === null) return null;
    return t === 'json' ? JSON.stringify(v) : v;
  }));
  const inserts = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    inserts.push(s.query(
      `INSERT INTO sp_targets (${cols}, pulled_at)
       SELECT ${picks}, now() FROM unnest(${unnest}) AS v(${cols})`,
      values(rows.slice(i, i + CHUNK))));
  }
  await s.transaction([s.query('DELETE FROM sp_targets'), ...inserts]);
  return { stored: rows.length };
}

// What is stored, and how far Amazon's suggestions have got. A suggestion
// counts as current when it was fetched after the bids were pulled; one from
// before is still shown, but the next round of suggestions asks again.
export async function status() {
  await ensure();
  const [r] = await sql().query(
    `SELECT max(g.pulled_at) AS pulled_at,
            count(*)::int AS targets,
            count(*) FILTER (WHERE g.kind = 'keyword')::int AS keywords,
            count(*) FILTER (WHERE g.state = 'ENABLED')::int AS enabled,
            count(*) FILTER (WHERE g.state = 'PAUSED')::int AS paused,
            count(*) FILTER (WHERE g.bid IS NOT NULL)::int AS own_bid,
            count(*) FILTER (WHERE g.rec_expr IS NOT NULL)::int AS askable,
            count(*) FILTER (WHERE g.rec_expr IS NOT NULL AND s.fetched_at >= g.pulled_at)::int AS asked,
            count(*) FILTER (WHERE s.fetched_at >= g.pulled_at
                               AND coalesce(s.low, s.mid, s.high) IS NOT NULL)::int AS suggested,
            count(DISTINCT g.ad_group_id) FILTER (
              WHERE g.rec_expr IS NOT NULL
                AND (s.fetched_at IS NULL OR s.fetched_at < g.pulled_at))::int AS groups_left,
            max(s.fetched_at) AS suggested_at
       FROM sp_targets g
       LEFT JOIN sp_target_bid_suggestions s ON s.target_id = g.target_id`);
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
  const rows = await sql().query(
    `SELECT g.campaign_id, g.ad_group_id, g.target_id, g.state, g.rec_expr
       FROM sp_targets g
       LEFT JOIN sp_target_bid_suggestions s ON s.target_id = g.target_id
      WHERE g.rec_expr IS NOT NULL
        AND (s.fetched_at IS NULL OR s.fetched_at < g.pulled_at)
      ORDER BY g.ad_group_id, g.target_id`);
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
// it did in the stored month. The two halves are from different times — the
// bid as of the last pull, the figures from the month on screen — and the page
// says so.
//
// The search term report names the keyword or target behind every row, so its
// month joins straight on. A target that matched nothing that month is still
// listed, with no figures: a paused target is often exactly that.
//
// `position` is where the bid sits against Amazon's range. It is a comparison
// of two numbers, not a verdict on either.
//
// A target with no bid of its own bids its ad group's default. The campaign
// list carries the default of the campaign's one ad group, so it is only this
// target's default when the ad groups match. Otherwise it is not known here.
const TARGET_BASE = `
  WITH perf AS (
    SELECT keyword_id, sum(clicks) AS clicks, sum(cost) AS cost,
           sum(purchases7d) AS orders, sum(sales7d) AS sales
      FROM search_terms
     WHERE ad_product = $1 AND month = $2
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
           perf.clicks, perf.cost, perf.orders, perf.sales
      FROM sp_targets g
      LEFT JOIN ad_campaigns c ON c.campaign_id = g.campaign_id
      LEFT JOIN ad_portfolios p ON p.portfolio_id = c.portfolio_id
      LEFT JOIN sp_target_bid_suggestions s ON s.target_id = g.target_id
      LEFT JOIN perf ON perf.keyword_id = g.target_id
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
  clicks: 'clicks', cost: 'cost', cpc: '(cost / NULLIF(clicks, 0))',
  orders: 'orders', sales: 'sales', roas: '(sales / NULLIF(cost, 0))',
  campaign: 'lower(campaign)', product: 'lower(portfolio)'
};

export const TARGET_POSITIONS = ['below', 'within', 'above', 'none'];

// Filters numbered first and paging last, as in searchterms.js, and the
// position filter last of the filters: the tally of positions takes every
// filter except that one, and dropping the final parameter is the only way
// to leave one out without renumbering the rest.
export function targetQueries({ adProduct = 'SP', month, portfolioId = null, q = '',
                                match = null, state = null, position = null,
                                sort = 'cost', dir = 'desc', limit = 200, offset = 0 } = {}) {
  const col = TARGET_SORTS[sort] || TARGET_SORTS.cost;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const filters = [adProduct, month, portfolioId || null, q ? `%${q}%` : null,
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
    // How many targets, and how much of the month's spend, sit at each
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

const num = (v) => (v === null || v === undefined ? null : Number(v));

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
      clicks: num(r.clicks), cost: num(r.cost), orders: num(r.orders), sales: num(r.sales)
    }))
  };
}
