// SQL storage for the ad spend bookkeeping, used when SQL_TABLES includes
// "adspendops". Otherwise it stays in kv records (adspend:sp:index,
// adspend:sb:index, adspend:last-synced:YYYY-MM, adspend:pending,
// adspend:weeks:YYYY). The daily rows themselves are ad_spend_rows
// (lib/adspend.js).
//
//   ad_spend_months       — the months each ad type holds, in stored order
//                           (a sync that came back empty still counts).
//   ad_spend_month_syncs  — when each month's report was last collected.
//   ad_spend_report_queue — reports requested from Amazon, not yet collected.
//   ad_spend_weeks        — the weekly per-campaign rollups, in stored order
//                           within each year.
//   ad_spend_week_years   — when each year's rollup was last written.
//
// Every record reads back exactly as written (lib/records.js).

import { sql, usesSql } from './sql.js';
import { recordColumns, recordValues, recordSelect, toRecord } from './records.js';

export function adspendOpsInSql() {
  return usesSql('adspendops');
}

export const QUEUE_SPEC = [
  ['reportId', 'report_id', 'text'], ['type', 'ad_type', 'text'], ['month', 'month', 'text'],
  ['requestedAt', 'requested_at', 'text'], ['name', 'name', 'text'], ['lastError', 'last_error', 'text']
];

export const WEEK_SPEC = [
  ['week', 'week', 'text'], ['campaign', 'campaign', 'text'], ['impressions', 'impressions', 'numeric'],
  ['clicks', 'clicks', 'numeric'], ['orders', 'orders', 'numeric'], ['spend', 'spend', 'numeric'],
  ['sales', 'sales', 'numeric']
];

// ── Month lists and sync times ───────────────────────────────────────────

// An ad type's months as adspend:<type>:index held them, or null.
export async function getIndex(type) {
  const rows = await sql().query('SELECT month FROM ad_spend_months WHERE ad_type = $1 ORDER BY position', [type]);
  return rows.length ? rows.map(r => r.month) : null;
}

export async function replaceIndex(type, months) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM ad_spend_months WHERE ad_type = $1', [type]),
    s.query(`INSERT INTO ad_spend_months (ad_type, position, month)
      SELECT $1, (e.ord - 1)::int, e.m FROM unnest($2::text[]) WITH ORDINALITY AS e(m, ord)`, [type, months || []])
  ]);
}

// When the month's report was last collected (adspend:last-synced:YYYY-MM), or null.
export async function getLastSynced(month) {
  const [row] = await sql().query('SELECT synced_at FROM ad_spend_month_syncs WHERE month = $1', [month]);
  return row ? row.synced_at : null;
}

export async function setLastSynced(month, at) {
  await sql().query(`INSERT INTO ad_spend_month_syncs (month, synced_at) VALUES ($1, $2)
    ON CONFLICT (month) DO UPDATE SET synced_at = EXCLUDED.synced_at`, [month, at]);
}

// ── Report queue ─────────────────────────────────────────────────────────

// The pending reports as adspend:pending held them ([] when none: the queue
// is written empty after every collect, so that is what kv holds).
export async function getQueue() {
  const rows = await sql().query(`SELECT ${recordSelect(QUEUE_SPEC)} FROM ad_spend_report_queue ORDER BY position`);
  return rows.map(r => toRecord(r, QUEUE_SPEC));
}

export async function replaceQueue(entries) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM ad_spend_report_queue'),
    s.query(`INSERT INTO ad_spend_report_queue (position, ${recordColumns(QUEUE_SPEC)})
      SELECT (e.ord - 1)::int, ${recordValues(QUEUE_SPEC, 'e.v')}
      FROM json_array_elements($1::json) WITH ORDINALITY AS e(v, ord)`, [JSON.stringify(entries || [])])
  ]);
}

// ── Weekly rollups ───────────────────────────────────────────────────────

// A year's rollup as adspend:weeks:YYYY held it ({ rows, updatedAt }), or null.
export async function getWeekYear(year) {
  const [doc, rows] = await Promise.all([
    sql().query('SELECT updated_at FROM ad_spend_week_years WHERE year = $1', [String(year)]),
    sql().query(`SELECT ${recordSelect(WEEK_SPEC)} FROM ad_spend_weeks WHERE year = $1 ORDER BY position`, [String(year)])
  ]);
  if (!doc.length) return null;
  return { rows: rows.map(r => toRecord(r, WEEK_SPEC)), updatedAt: doc[0].updated_at };
}

export async function replaceWeekYear(year, doc) {
  const s = sql();
  await s.transaction([
    s.query(`INSERT INTO ad_spend_week_years (year, updated_at) VALUES ($1, $2)
      ON CONFLICT (year) DO UPDATE SET updated_at = EXCLUDED.updated_at`, [String(year), doc.updatedAt ?? null]),
    s.query('DELETE FROM ad_spend_weeks WHERE year = $1', [String(year)]),
    s.query(`INSERT INTO ad_spend_weeks (year, position, ${recordColumns(WEEK_SPEC)})
      SELECT $1, (e.ord - 1)::int, ${recordValues(WEEK_SPEC, 'e.v')}
      FROM json_array_elements($2::json) WITH ORDINALITY AS e(v, ord)`, [String(year), JSON.stringify(doc.rows || [])])
  ]);
}
