// SQL storage for the ad reviews (weekly, bi-weekly, monthly), used when
// SQL_TABLES includes "adreviews". Otherwise they stay in kv records
// (weekly:lastrun, biweekly:lastrun, monthly:lastrun, biweekly:available,
// weekly:notes, biweekly:posture, ads:cron:pending, monthly:cron:pending).
//
//   ad_review_runs   — one row per collected run (also the history table,
//                      lib/adhistory.js): window, and what its page showed.
//   ad_review_inputs — each run's per-campaign metrics, one row per campaign
//                      (monthly runs keep their sp and sb lists as sections).
//   ad_review_slots  — which run each review decides from ("run"), and the
//                      bi-weekly fetch waiting to be adopted ("available").
//   review_notes     — the weekly review's notes, by portfolio and week.
//   brand_postures   — the posture set per brand.
//   ad_cron_jobs     — the Tuesday and monthly cron jobs' current state.
//
// Every record reads back exactly as written (lib/records.js).

import { sql, usesSql } from './sql.js';
import { recordColumns, recordValues, recordSelect, toRecord } from './records.js';

export function reviewsInSql() {
  return usesSql('adreviews');
}

// Every cadence's per-campaign input fields; each run uses its own subset.
export const INPUT_SPEC = [
  ['campaignId', 'campaign_id', 'text'],
  ['spend7', 'spend7', 'numeric'], ['clicks7', 'clicks7', 'numeric'], ['impressions7', 'impressions7', 'numeric'],
  ['spend28', 'spend28', 'numeric'], ['clicks28', 'clicks28', 'numeric'], ['impressions28', 'impressions28', 'numeric'],
  ['sales28', 'sales28', 'numeric'], ['daily7', 'daily7', 'json'],
  ['spend', 'spend', 'numeric'], ['orders', 'orders', 'numeric'], ['sales', 'sales', 'numeric'],
  ['clicks', 'clicks', 'numeric'], ['impressions', 'impressions', 'numeric'],
  ['priorSpend', 'prior_spend', 'numeric'], ['priorSales', 'prior_sales', 'numeric'],
  ['priorOrders', 'prior_orders', 'numeric'], ['priorClicks', 'prior_clicks', 'numeric'],
  ['priorImpressions', 'prior_impressions', 'numeric'],
  ['ntbOrders', 'ntb_orders', 'numeric'], ['ntbSales', 'ntb_sales', 'numeric'], ['daily', 'daily', 'json']
];

export const NOTE_SPEC = [
  ['portfolioId', 'portfolio_id', 'text'], ['weekStart', 'week_start', 'text'], ['text', 'text', 'text'],
  ['portfolio', 'portfolio', 'text'], ['updatedAt', 'updated_at', 'text']
];

export const CRON_SPEC = [
  ['weekly', 'weekly', 'json'], ['biweekly', 'biweekly', 'json'], ['window', 'run_window', 'json'],
  ['reports', 'reports', 'json'], ['failures', 'failures', 'json'], ['notes', 'notes', 'json'],
  ['censusError', 'census_error', 'json'], ['ptDate', 'pt_date', 'text'], ['requestedAt', 'requested_at', 'text'],
  ['collected', 'collected', 'boolean'], ['notified', 'notified', 'boolean'],
  ['lastCollectAt', 'last_collect_at', 'text'], ['notifiedAt', 'notified_at', 'text']
];

// The slot record's timestamp field: a run's collectedAt, a fetch's fetchedAt.
const STAMP = { run: 'collectedAt', available: 'fetchedAt' };

// The run tables beside ad_review_runs (whose own DDL is lib/adhistory.js's).
// Created by tools/to-sql.mjs when it fills them.
export const RUN_DDL = [
  `CREATE TABLE IF NOT EXISTS ad_review_inputs (
    cadence      text    NOT NULL,
    collected_at text    NOT NULL,
    section      text    NOT NULL,
    position     integer NOT NULL,
    ${INPUT_SPEC.map(([, col, type]) => `${col} ${type}`).join(',\n    ')},
    fields       text[]  NOT NULL,
    extra        json,
    PRIMARY KEY (cadence, collected_at, section, position)
  )`,
  'CREATE INDEX IF NOT EXISTS ad_review_inputs_campaign_idx ON ad_review_inputs (campaign_id)',
  `CREATE TABLE IF NOT EXISTS ad_review_slots (
    cadence      text        NOT NULL,
    slot         text        NOT NULL,
    collected_at text        NOT NULL,
    adopted_at   text,
    fields       text[]      NOT NULL,
    extra        json,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cadence, slot)
  )`
];

// ── Runs ─────────────────────────────────────────────────────────────────

// The statements that store a run's window and inputs under (cadence,
// collectedAt), replacing any earlier copy of the same run. Its recorded
// decisions are left as they are.
export function runStatements(s, cadence, collectedAt, window, inputs) {
  const sections = Array.isArray(inputs) ? null : Object.keys(inputs || {});
  const lists = sections === null ? [['', inputs || []]] : sections.map(k => [k, inputs[k] || []]);
  return [
    s.query(`INSERT INTO ad_review_runs (cadence, collected_at, run_window, inputs, input_sections)
      VALUES ($1, $2, $3::json, NULL, $4::text[])
      ON CONFLICT (cadence, collected_at) DO UPDATE SET
        run_window = EXCLUDED.run_window, inputs = NULL, input_sections = EXCLUDED.input_sections`,
      [cadence, collectedAt, JSON.stringify(window ?? null), sections]),
    s.query('DELETE FROM ad_review_inputs WHERE cadence = $1 AND collected_at = $2', [cadence, collectedAt]),
    s.query(`INSERT INTO ad_review_inputs (cadence, collected_at, section, position, ${recordColumns(INPUT_SPEC)})
      SELECT $1, $2, l.section, (e.ord - 1)::int, ${recordValues(INPUT_SPEC, 'e.v')}
      FROM json_to_recordset($3::json) AS l(section text, rows json),
           json_array_elements(l.rows) WITH ORDINALITY AS e(v, ord)`,
      [cadence, collectedAt, JSON.stringify(lists.map(([section, rows]) => ({ section, rows })))])
  ];
}

// Stores a run and makes it the slot's record: `record` is the kv record
// exactly ({ window, inputs, collectedAt[, adoptedAt] } for a run,
// { window, inputs, fetchedAt } for a fetch).
export async function saveSlot(cadence, slot, record) {
  const s = sql();
  const stamp = String(record[STAMP[slot]]);
  const known = new Set(['window', 'inputs', STAMP[slot], 'adoptedAt']);
  const extra = Object.fromEntries(Object.entries(record).filter(([k]) => !known.has(k)));
  await s.transaction([
    ...runStatements(s, cadence, stamp, record.window, record.inputs),
    s.query(`UPDATE ad_review_runs SET adopted_at = $3 WHERE cadence = $1 AND collected_at = $2 AND $3::text IS NOT NULL`,
      [cadence, stamp, record.adoptedAt ?? null]),
    s.query(`INSERT INTO ad_review_slots (cadence, slot, collected_at, adopted_at, fields, extra)
      VALUES ($1, $2, $3, $4, $5::text[], $6::json)
      ON CONFLICT (cadence, slot) DO UPDATE SET collected_at = EXCLUDED.collected_at,
        adopted_at = EXCLUDED.adopted_at, fields = EXCLUDED.fields, extra = EXCLUDED.extra,
        updated_at = now()`,
      [cadence, slot, stamp, record.adoptedAt ?? null, Object.keys(record),
       Object.keys(extra).length ? JSON.stringify(extra) : null])
  ]);
}

// The slot's record exactly as saved, or null.
export async function getSlot(cadence, slot) {
  const [row] = await sql().query(`SELECT s.collected_at, s.adopted_at, s.fields, s.extra,
      r.run_window, r.input_sections
    FROM ad_review_slots s JOIN ad_review_runs r ON r.cadence = s.cadence AND r.collected_at = s.collected_at
    WHERE s.cadence = $1 AND s.slot = $2`, [cadence, slot]);
  if (!row) return null;
  const inputRows = await sql().query(`SELECT section, ${recordSelect(INPUT_SPEC)} FROM ad_review_inputs
    WHERE cadence = $1 AND collected_at = $2 ORDER BY section, position`, [cadence, row.collected_at]);
  const bySection = new Map();
  for (const r of inputRows) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section).push(toRecord(r, INPUT_SPEC));
  }
  const inputs = row.input_sections === null
    ? (bySection.get('') || [])
    : Object.fromEntries(row.input_sections.map(k => [k, bySection.get(k) || []]));
  const extra = row.extra || {};
  const out = {};
  for (const f of row.fields) {
    if (f === 'window') out[f] = row.run_window;
    else if (f === 'inputs') out[f] = inputs;
    else if (f === STAMP[slot]) out[f] = row.collected_at;
    else if (f === 'adoptedAt') out[f] = row.adopted_at;
    else out[f] = extra[f];
  }
  return out;
}

// ── Notes and postures ───────────────────────────────────────────────────

// { notes: { [portfolioId|weekStart]: note } } as weekly:notes held it, or
// null when there are none.
export async function getNotes() {
  const rows = await sql().query(`SELECT note_key, ${recordSelect(NOTE_SPEC)} FROM review_notes ORDER BY position`);
  return rows.length ? { notes: Object.fromEntries(rows.map(r => [r.note_key, toRecord(r, NOTE_SPEC)])) } : null;
}

export async function replaceNotes(doc) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM review_notes'),
    s.query(`INSERT INTO review_notes (position, note_key, ${recordColumns(NOTE_SPEC)})
      SELECT (e.ord - 1)::int, e.k, ${recordValues(NOTE_SPEC, 'e.v')}
      FROM json_each($1::json) WITH ORDINALITY AS e(k, v, ord)`, [JSON.stringify((doc && doc.notes) || {})])
  ]);
}

// { [brand]: posture } as biweekly:posture held it, or null when none.
export async function getPostures() {
  const rows = await sql().query('SELECT brand, posture FROM brand_postures ORDER BY position');
  return rows.length ? Object.fromEntries(rows.map(r => [r.brand, r.posture])) : null;
}

export async function replacePostures(postures) {
  const s = sql();
  await s.transaction([
    s.query('DELETE FROM brand_postures'),
    s.query(`INSERT INTO brand_postures (position, brand, posture)
      SELECT (e.ord - 1)::int, e.k, e.v FROM json_each_text($1::json) WITH ORDINALITY AS e(k, v, ord)`,
      [JSON.stringify(postures || {})])
  ]);
}

// ── Cron jobs ────────────────────────────────────────────────────────────

// A cron job's state record ('ads' = ads:cron:pending, 'monthly' =
// monthly:cron:pending), or null.
export async function getCronJob(job) {
  const [row] = await sql().query(`SELECT ${recordSelect(CRON_SPEC)} FROM ad_cron_jobs WHERE job = $1`, [job]);
  return row ? toRecord(row, CRON_SPEC) : null;
}

export async function saveCronJob(job, record) {
  const cols = recordColumns(CRON_SPEC);
  await sql().query(`INSERT INTO ad_cron_jobs (job, ${cols})
    SELECT $1, ${recordValues(CRON_SPEC, 'r.v')} FROM (SELECT $2::json AS v) r
    ON CONFLICT (job) DO UPDATE SET ${cols.split(', ').map(c => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
    [job, JSON.stringify(record)]);
}
