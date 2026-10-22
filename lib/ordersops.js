// SQL storage for the orders sync's own records, used when SQL_TABLES
// includes "ordersops". Otherwise they stay in kv (orders:v2:last-cron-run,
// orders:v2:alerts, orders:v2:pending-reports, orders:v2:report-lastresult).
// The order lines themselves are the orders table (lib/orders.js).
//
//   orders_sync_status    — the heartbeat: when the daily request, collect,
//                           and data check last ran, and what the check saw.
//   orders_syncs          — one row per sync that loaded orders (date range,
//                           orders, revenue). The heartbeat's lastSync is the
//                           latest; the rest is the sync history.
//   orders_alerts         — the Sales & Volume alerts, in stored order.
//   orders_report_queue   — reports requested from Amazon, not yet ingested.
//   orders_report_results — the last result per report range ("2024-08",
//                           "2026-07-14", "upd:2024-08", …).
//
// Every record reads back exactly as written (lib/records.js).

import { sql, usesSql } from './sql.js';
import { recordColumns, recordValues, recordSelect, toRecord } from './records.js';

export function ordersOpsInSql() {
  return usesSql('ordersops');
}

// The heartbeat's own fields. lastSync is a flag here (true when the
// heartbeat has one); its value is the latest orders_syncs row.
export const STATUS_SPEC = [
  ['checkAt', 'check_at', 'text'], ['lastCheckDate', 'last_check_date', 'text'],
  ['lastCheckCount', 'last_check_count', 'numeric'], ['requestAt', 'request_at', 'text'],
  ['collectAt', 'collect_at', 'text'], ['lastSync', 'has_last_sync', 'boolean']
];

export const SYNC_SPEC = [
  ['at', 'synced_at', 'text'], ['start', 'start_date', 'text'], ['end', 'end_date', 'text'],
  ['orders', 'orders', 'numeric'], ['revenue', 'revenue', 'numeric']
];

export const ALERT_SPEC = [
  ['id', 'id', 'text'], ['severity', 'severity', 'text'], ['category', 'category', 'text'],
  ['message', 'message', 'text'], ['createdAt', 'created_at', 'text'], ['dismissed', 'dismissed', 'boolean'],
  ['dismissedAt', 'dismissed_at', 'text'], ['resolvedAt', 'resolved_at', 'text'], ['details', 'details', 'json']
];

export const QUEUE_SPEC = [
  ['reportId', 'report_id', 'text'], ['month', 'month', 'text'], ['requestedAt', 'requested_at', 'text'],
  ['name', 'name', 'text'], ['merge', 'merge', 'boolean'], ['updateOnly', 'update_only', 'boolean'],
  ['dependsOn', 'depends_on', 'text'], ['currentStatus', 'current_status', 'text']
];

export const RESULT_SPEC = [
  ['status', 'status', 'text'], ['rowCount', 'row_count', 'numeric'], ['rawRowCount', 'raw_row_count', 'numeric'],
  ['skippedCancelled', 'skipped_cancelled', 'numeric'], ['skippedNoDate', 'skipped_no_date', 'numeric'],
  ['skippedNoOrder', 'skipped_no_order', 'numeric'], ['removedCancelled', 'removed_cancelled', 'numeric'],
  ['error', 'error', 'text'], ['completedAt', 'completed_at', 'text']
];

// ── Heartbeat ────────────────────────────────────────────────────────────

// The heartbeat as orders:v2:last-cron-run held it, or null.
export async function getHeartbeat() {
  const [status, latest] = await Promise.all([
    sql().query(`SELECT ${recordSelect(STATUS_SPEC)} FROM orders_sync_status WHERE id = 'orders'`),
    sql().query(`SELECT ${recordSelect(SYNC_SPEC)} FROM orders_syncs ORDER BY id DESC LIMIT 1`)
  ]);
  if (!status.length) return null;
  const record = toRecord(status[0], STATUS_SPEC);
  if (record.lastSync === true) record.lastSync = latest.length ? toRecord(latest[0], SYNC_SPEC) : null;
  return record;
}

// Stores the heartbeat record whole. A lastSync different from the latest
// stored one is a new sync, and joins the history.
export async function saveHeartbeat(record) {
  const s = sql();
  const statements = [];
  const sync = record.lastSync;
  if (sync && typeof sync === 'object') {
    const [latest] = await s.query(`SELECT ${recordSelect(SYNC_SPEC)} FROM orders_syncs ORDER BY id DESC LIMIT 1`);
    const prev = latest ? toRecord(latest, SYNC_SPEC) : null;
    if (JSON.stringify(prev) !== JSON.stringify(sync)) {
      statements.push(s.query(`INSERT INTO orders_syncs (${recordColumns(SYNC_SPEC)})
        SELECT ${recordValues(SYNC_SPEC, 'r.v')} FROM (SELECT $1::json AS v) r`, [JSON.stringify(sync)]));
    }
  }
  const flagged = { ...record };
  if ('lastSync' in flagged && flagged.lastSync !== null) flagged.lastSync = true;
  const cols = recordColumns(STATUS_SPEC);
  statements.push(s.query(`INSERT INTO orders_sync_status (id, ${cols})
    SELECT 'orders', ${recordValues(STATUS_SPEC, 'r.v')} FROM (SELECT $1::json AS v) r
    ON CONFLICT (id) DO UPDATE SET ${cols.split(', ').map(c => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
    [JSON.stringify(flagged)]));
  await s.transaction(statements);
}

// ── Alerts, queue, results ───────────────────────────────────────────────

// orders:v2:alerts, in stored order ([] when none).
export async function getAlerts() {
  const rows = await sql().query(`SELECT ${recordSelect(ALERT_SPEC)} FROM orders_alerts ORDER BY position`);
  return rows.map(r => toRecord(r, ALERT_SPEC));
}

export async function replaceAlerts(alerts) {
  await replaceList('orders_alerts', ALERT_SPEC, alerts);
}

// orders:v2:pending-reports, in stored order ([] when none).
export async function getQueue() {
  const rows = await sql().query(`SELECT ${recordSelect(QUEUE_SPEC)} FROM orders_report_queue ORDER BY position`);
  return rows.map(r => toRecord(r, QUEUE_SPEC));
}

export async function replaceQueue(entries) {
  await replaceList('orders_report_queue', QUEUE_SPEC, entries);
}

async function replaceList(table, spec, list) {
  const s = sql();
  await s.transaction([
    s.query(`DELETE FROM ${table}`),
    s.query(`INSERT INTO ${table} (position, ${recordColumns(spec)})
      SELECT (e.ord - 1)::int, ${recordValues(spec, 'e.v')}
      FROM json_array_elements($1::json) WITH ORDINALITY AS e(v, ord)`, [JSON.stringify(list || [])])
  ]);
}

// orders:v2:report-lastresult: { [range]: result } in stored order ({} when none).
export async function getResults() {
  const rows = await sql().query(`SELECT report_key, ${recordSelect(RESULT_SPEC)} FROM orders_report_results ORDER BY position`);
  return Object.fromEntries(rows.map(r => [r.report_key, toRecord(r, RESULT_SPEC)]));
}

export async function replaceResults(results) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM orders_report_results'),
    s.query(`INSERT INTO orders_report_results (position, report_key, ${recordColumns(RESULT_SPEC)})
      SELECT (e.ord - 1)::int, e.k, ${recordValues(RESULT_SPEC, 'e.v')}
      FROM json_each($1::json) WITH ORDINALITY AS e(k, v, ord)`, [JSON.stringify(results || {})])
  ]);
}
