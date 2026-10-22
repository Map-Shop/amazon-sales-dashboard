// SQL storage for the campaign census (Campaign Overview's snapshot of the
// Amazon ad account), used when SQL_TABLES includes "adcampaigns".
// Otherwise it stays in the adcampaigns:* kv records, as before.
//
//   ad_census          — when each snapshot was taken: one row for the
//                        campaigns (synced_at, pt_date) and one for the
//                        portfolios (synced_at).
//   ad_campaigns       — every campaign in the snapshot, in stored order.
//   ad_portfolios      — every portfolio, in stored order.
//   ad_census_syncs    — one row per refresh attempt; the latest is the
//                        census status (adcampaigns:meta), the rest a history.
//   ad_brand_overrides — brands set by hand on the page, by campaign id.
//
// Rows keep each record's exact shape (lib/records.js). The change log lives
// in campaign_changes (lib/adhistory.js).

import { sql, usesSql } from './sql.js';
import { recordColumns, recordValues, recordSelect, toRecord } from './records.js';

export function censusInSql() {
  return usesSql('adcampaigns');
}

export const CAMPAIGN_SPEC = [
  ['campaignId', 'campaign_id', 'text'], ['adProduct', 'ad_product', 'text'], ['name', 'name', 'text'],
  ['state', 'state', 'text'], ['dailyBudget', 'daily_budget', 'numeric'], ['budgetType', 'budget_type', 'text'],
  ['targetingType', 'targeting_type', 'text'], ['biddingStrategy', 'bidding_strategy', 'text'],
  ['portfolioId', 'portfolio_id', 'text'], ['startDate', 'start_date', 'text'], ['endDate', 'end_date', 'text'],
  ['brand', 'brand', 'text'], ['brandFromPrefix', 'brand_from_prefix', 'text'], ['brandSource', 'brand_source', 'text'],
  ['campaignType', 'campaign_type', 'text'], ['typeSource', 'type_source', 'text'],
  ['placements', 'placements', 'json'], ['placementsSummary', 'placements_summary', 'text'],
  ['defaultBid', 'default_bid', 'numeric'], ['adGroupId', 'ad_group_id', 'text'],
  ['firstSeenAt', 'first_seen_at', 'text'], ['lastSeenAt', 'last_seen_at', 'text'],
  ['missingRuns', 'missing_runs', 'numeric'], ['presumedArchived', 'presumed_archived', 'boolean']
];

export const PORTFOLIO_SPEC = [
  ['portfolioId', 'portfolio_id', 'text'], ['name', 'name', 'text'], ['state', 'state', 'text'],
  ['budgetAmount', 'budget_amount', 'numeric'], ['budgetPolicy', 'budget_policy', 'text'],
  ['budgetStart', 'budget_start', 'text'], ['budgetEnd', 'budget_end', 'text'], ['inBudget', 'in_budget', 'boolean'],
  ['firstSeenAt', 'first_seen_at', 'text'], ['lastSeenAt', 'last_seen_at', 'text'],
  ['missingRuns', 'missing_runs', 'numeric'], ['presumedArchived', 'presumed_archived', 'boolean']
];

export const SYNC_SPEC = [
  ['lastSyncAt', 'last_sync_at', 'text'], ['lastSyncOk', 'last_sync_ok', 'boolean'],
  ['lastSyncDurationMs', 'last_sync_duration_ms', 'numeric'], ['counts', 'counts', 'json'],
  ['sources', 'sources', 'json'], ['pages', 'pages', 'json'], ['coverage', 'coverage', 'json'],
  ['warnings', 'warnings', 'json'], ['lastError', 'last_error', 'json']
];

export const OVERRIDE_SPEC = [['brand', 'brand', 'text'], ['at', 'at', 'text']];

// ── Snapshots ────────────────────────────────────────────────────────────

// The snapshots' rows alone, in stored order.
export async function getCampaignRows() {
  const rows = await sql().query(`SELECT ${recordSelect(CAMPAIGN_SPEC)} FROM ad_campaigns ORDER BY position`);
  return rows.map(r => toRecord(r, CAMPAIGN_SPEC));
}
export async function getPortfolioRows() {
  const rows = await sql().query(`SELECT ${recordSelect(PORTFOLIO_SPEC)} FROM ad_portfolios ORDER BY position`);
  return rows.map(r => toRecord(r, PORTFOLIO_SPEC));
}

// { syncedAt, ptDate, rows } as adcampaigns:current held it, or null.
export async function getCampaigns() {
  const [doc, rows] = await Promise.all([
    sql().query(`SELECT synced_at, pt_date FROM ad_census WHERE doc = 'campaigns'`),
    getCampaignRows()
  ]);
  if (!doc.length) return null;
  return { syncedAt: doc[0].synced_at, ptDate: doc[0].pt_date, rows };
}

// { syncedAt, rows } as adcampaigns:portfolios held it, or null.
export async function getPortfolios() {
  const [doc, rows] = await Promise.all([
    sql().query(`SELECT synced_at FROM ad_census WHERE doc = 'portfolios'`),
    getPortfolioRows()
  ]);
  if (!doc.length) return null;
  return { syncedAt: doc[0].synced_at, rows };
}

// The statements that replace a snapshot, for a transaction.
function snapshotStatements(s, doc, table, spec, docName, ptDate) {
  return [
    s.query(`INSERT INTO ad_census (doc, synced_at, pt_date) VALUES ($1, $2, $3)
      ON CONFLICT (doc) DO UPDATE SET synced_at = EXCLUDED.synced_at, pt_date = EXCLUDED.pt_date`,
      [docName, doc.syncedAt ?? null, ptDate ?? null]),
    s.query(`DELETE FROM ${table}`),
    s.query(`INSERT INTO ${table} (position, ${recordColumns(spec)})
      SELECT (e.ord - 1)::int, ${recordValues(spec, 'e.v')}
      FROM json_array_elements($1::json) WITH ORDINALITY AS e(v, ord)`,
      [JSON.stringify(doc.rows || [])])
  ];
}

function syncStatement(s, meta) {
  return s.query(`INSERT INTO ad_census_syncs (${recordColumns(SYNC_SPEC)})
    SELECT ${recordValues(SYNC_SPEC, 'm.v')} FROM (SELECT $1::json AS v) m`, [JSON.stringify(meta)]);
}

export async function replaceCampaigns(doc) {
  const s = sql();
  await s.transaction(snapshotStatements(s, doc, 'ad_campaigns', CAMPAIGN_SPEC, 'campaigns', doc.ptDate));
}

// A refresh's writes, all or nothing: both snapshots and the status.
export async function storeRefresh(current, portfolios, meta) {
  const s = sql();
  await s.transaction([
    ...snapshotStatements(s, current, 'ad_campaigns', CAMPAIGN_SPEC, 'campaigns', current.ptDate),
    ...snapshotStatements(s, portfolios, 'ad_portfolios', PORTFOLIO_SPEC, 'portfolios', null),
    syncStatement(s, meta)
  ]);
}

// ── Status ───────────────────────────────────────────────────────────────

// The latest refresh's status, as adcampaigns:meta held it, or null.
export async function getStatus() {
  const rows = await sql().query(`SELECT ${recordSelect(SYNC_SPEC)} FROM ad_census_syncs ORDER BY id DESC LIMIT 1`);
  return rows.length ? toRecord(rows[0], SYNC_SPEC) : null;
}

export async function recordStatus(meta) {
  const s = sql();
  await syncStatement(s, meta);
}

// ── Brand overrides ──────────────────────────────────────────────────────

// { [campaignId]: { brand, at } } in stored order, or null when none.
export async function getOverrides() {
  const rows = await sql().query(`SELECT campaign_id, ${recordSelect(OVERRIDE_SPEC)}
    FROM ad_brand_overrides ORDER BY position`);
  if (!rows.length) return null;
  return Object.fromEntries(rows.map(r => [r.campaign_id, toRecord(r, OVERRIDE_SPEC)]));
}

export async function replaceOverrides(overrides) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM ad_brand_overrides'),
    s.query(`INSERT INTO ad_brand_overrides (position, campaign_id, ${recordColumns(OVERRIDE_SPEC)})
      SELECT (e.ord - 1)::int, e.k, ${recordValues(OVERRIDE_SPEC, 'e.v')}
      FROM json_each($1::json) WITH ORDINALITY AS e(k, v, ord)`, [JSON.stringify(overrides || {})])
  ]);
}
