// Permanent ad history, for looking back at what changed and what came of it.
// Used when SQL_TABLES includes "adhistory" (see lib/sql.js). Two tables:
//
//   campaign_changes — every campaign change the dashboard has logged: edits
//     it pushed to Amazon and changes the daily refresh found. It is the
//     adcampaigns:changes kv log without the 200-record cap: one row per
//     record id, replaced when the log replaces that id. `data` is the record
//     exactly as the log holds it; the other columns are copies for querying,
//     plus `origin`, the page an edit was made from (null for refresh records
//     and for edits logged before history began), and `seq`, the log's order:
//     each write takes the next number, so a record the log replaces moves
//     to the end, as it does in the kv log. With SQL_TABLES including
//     "adcampaigns" this table IS the change log: the page's capped list is
//     its latest 200 rows by seq (getRecentChanges).
//   ad_review_runs — one row per stored review run (weekly, biweekly,
//     monthly): its window and inputs, and `decisions`, what the page showed
//     for it when it was stored. The pages never read this table; they still
//     decide afresh on every load. Runs stored before history began have
//     inputs only.
//
// Writing history never fails what it records: callers log errors and carry
// on. The tables are created on first use, and each new process first copies
// in what already exists (the kv change log and each cadence's current run),
// so nothing logged before the first write is missed.

import { sql, usesSql } from './sql.js';

export function historyEnabled() {
  return usesSql('adhistory');
}

// Exported for tools/to-sql.mjs, which creates the tables when it fills them.
export const DDL = [
  `CREATE TABLE IF NOT EXISTS campaign_changes (
    id          text PRIMARY KEY,
    campaign_id text,
    field       text,
    pt_date     date,
    changed_at  timestamptz,
    source      text,
    origin      text,
    data        json NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS campaign_changes_campaign_idx ON campaign_changes (campaign_id, pt_date)',
  'CREATE SEQUENCE IF NOT EXISTS campaign_changes_seq',
  'ALTER TABLE campaign_changes ADD COLUMN IF NOT EXISTS seq bigint',
  'CREATE INDEX IF NOT EXISTS campaign_changes_seq_idx ON campaign_changes (seq)',
  `CREATE TABLE IF NOT EXISTS ad_review_runs (
    cadence      text        NOT NULL,
    collected_at text        NOT NULL,
    adopted_at   text,
    recorded_at  timestamptz NOT NULL DEFAULT now(),
    run_window   json        NOT NULL,
    inputs       json        NOT NULL,
    decisions    json,
    context      json,
    decided_at   timestamptz,
    PRIMARY KEY (cadence, collected_at)
  )`,
  // With SQL_TABLES including "adreviews" a run's inputs are rows in
  // ad_review_inputs (lib/adreviews.js); `inputs` here is then NULL, and
  // input_sections says how they nest (NULL = a list; else the keys of the
  // object of lists, in order).
  'ALTER TABLE ad_review_runs ALTER COLUMN inputs DROP NOT NULL',
  'ALTER TABLE ad_review_runs ADD COLUMN IF NOT EXISTS input_sections text[]'
];

// The kv records history starts from: the change log, and each cadence's
// current run (their keys live in api/adcampaigns.js and api/adspend.js).
const SEED_LOG_KEY = 'adcampaigns:changes';
const SEED_RUN_KEYS = { weekly: 'weekly:lastrun', biweekly: 'biweekly:lastrun', monthly: 'monthly:lastrun' };

let ready = null;

// Creates the tables if needed and copies in the existing records, once per
// process. kvGet reads a kv record. Safe to repeat: changes are upserted by
// id and an existing run is never replaced.
export function ensure(kvGet) {
  if (!ready) {
    ready = (async () => {
      for (const ddl of DDL) await sql().query(ddl);
      const [log, ...runs] = await Promise.all(
        [SEED_LOG_KEY, ...Object.values(SEED_RUN_KEYS)].map(k => kvGet(k)));
      // Once the census is in SQL this table is the log itself, and the kv
      // record is a frozen leftover that must not be copied over it.
      if (!usesSql('adcampaigns')) {
        await recordChanges((log && Array.isArray(log.rows)) ? log.rows : [], null);
      }
      // Likewise, once the reviews are in SQL the runs are stored there.
      const cadences = Object.keys(SEED_RUN_KEYS);
      for (let i = 0; i < cadences.length && !usesSql('adreviews'); i++) {
        if (runs[i] && runs[i].collectedAt) await recordRun(cadences[i], runs[i], null);
      }
    })();
    ready.catch(() => { ready = null; });   // try again on the next write
  }
  return ready;
}

// Upserts change records by id, in order: each takes the next seq, so a
// replaced record moves to the end as acAppendChanges moves it. origin is the
// page an edit came from, or null; a null never erases an origin already
// recorded.
export async function recordChanges(records, origin) {
  const list = records.filter(r => r && r.id);
  if (!list.length) return;
  const s = sql();
  await s.transaction(list.map(r => s.query(
    `INSERT INTO campaign_changes (id, campaign_id, field, pt_date, changed_at, source, origin, data, seq)
     SELECT d->>'id', d->>'campaignId', d->>'field',
       CASE WHEN d->>'ptDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (d->>'ptDate')::date END,
       CASE WHEN d->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (d->>'at')::timestamptz END,
       d->>'source', $2::text, d, nextval('campaign_changes_seq')
     FROM (SELECT $1::json AS d) x
     ON CONFLICT (id) DO UPDATE SET
       campaign_id = EXCLUDED.campaign_id, field = EXCLUDED.field, pt_date = EXCLUDED.pt_date,
       changed_at = EXCLUDED.changed_at, source = EXCLUDED.source,
       origin = COALESCE(EXCLUDED.origin, campaign_changes.origin), data = EXCLUDED.data,
       seq = EXCLUDED.seq`,
    [JSON.stringify(r), origin || null])));
}

// The newest `limit` change records, oldest first — the page's capped log
// when the census is in SQL.
export async function getRecentChanges(limit) {
  const rows = await sql().query(
    'SELECT data FROM campaign_changes ORDER BY seq DESC NULLS LAST LIMIT $1', [limit]);
  return rows.map(r => r.data).reverse();
}

// The Change log tab's search: change records matching every filter given,
// newest first, `limit` of them from `offset` (one page), with how many
// matched in all and every field the log has recorded (for the tab's field
// filter). text matches the
// campaign's name or id anywhere in it; field is a tracked field name;
// madeFrom is a page origin ('weekly', 'biweekly', 'monthly', 'campaigns'),
// 'dashboard' (an edit made before pages were recorded), or 'detected' (a
// change found by a refresh, made outside the dashboard); from and to are
// PT dates, inclusive. Each record comes back with its origin.
export async function searchChanges({ text = '', field = '', madeFrom = '', from = '', to = '', limit = 25, offset = 0 } = {}) {
  const where = [];
  const params = [];
  const param = (v) => { params.push(v); return `$${params.length}`; };
  if (text) {
    const like = param(`%${text.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(data->>'name' ILIKE ${like} OR campaign_id ILIKE ${like})`);
  }
  if (field) where.push(`field = ${param(field)}`);
  if (madeFrom === 'detected') where.push(`source IS DISTINCT FROM 'edit'`);
  else if (madeFrom === 'dashboard') where.push(`source = 'edit' AND origin IS NULL`);
  else if (madeFrom) where.push(`source = 'edit' AND origin = ${param(madeFrom)}`);
  if (from) where.push(`pt_date >= ${param(from)}::date`);
  if (to) where.push(`pt_date <= ${param(to)}::date`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const s = sql();
  const [rows, [{ total }], fields] = await s.transaction([
    s.query(`SELECT data, origin FROM campaign_changes ${clause}
      ORDER BY seq DESC NULLS LAST, changed_at DESC NULLS LAST, id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    s.query(`SELECT count(*)::int AS total FROM campaign_changes ${clause}`, params),
    s.query('SELECT DISTINCT field FROM campaign_changes WHERE field IS NOT NULL ORDER BY field')
  ], { isolationLevel: 'RepeatableRead', readOnly: true });
  return {
    rows: rows.map(r => ({ ...r.data, origin: r.origin })),
    total,
    limit,
    offset,
    fields: fields.map(r => r.field)
  };
}

// Records a stored run. decided is { decisions, context } — what the page
// showed for the run and the settings behind it — or null when they were not
// captured. A run already recorded is kept; it only gains decisions it lacked.
export async function recordRun(cadence, run, decided) {
  await sql().query(
    `INSERT INTO ad_review_runs
       (cadence, collected_at, adopted_at, run_window, inputs, decisions, context, decided_at)
     VALUES ($1, $2, $3, $4::json, $5::json, $6::json, $7::json,
             CASE WHEN $6::json IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (cadence, collected_at) DO UPDATE SET
       decisions = EXCLUDED.decisions, context = EXCLUDED.context, decided_at = EXCLUDED.decided_at
     WHERE ad_review_runs.decisions IS NULL AND EXCLUDED.decisions IS NOT NULL`,
    [cadence, String(run.collectedAt), run.adoptedAt || null,
     JSON.stringify(run.window ?? null), JSON.stringify(run.inputs ?? null),
     decided && decided.decisions != null ? JSON.stringify(decided.decisions) : null,
     decided && decided.context != null ? JSON.stringify(decided.context) : null]);
}

// With the reviews in SQL the run is already stored (lib/adreviews.js); this
// adds what its page showed, kept only if the run has none yet.
export async function recordDecisions(cadence, collectedAt, decided) {
  if (!decided || decided.decisions == null) return;
  await sql().query(
    `UPDATE ad_review_runs SET decisions = $3::json, context = $4::json, decided_at = now()
     WHERE cadence = $1 AND collected_at = $2 AND decisions IS NULL`,
    [cadence, String(collectedAt), JSON.stringify(decided.decisions),
     decided.context != null ? JSON.stringify(decided.context) : null]);
}
