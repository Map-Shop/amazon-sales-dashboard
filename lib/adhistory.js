// Permanent ad history, for looking back at what changed and what came of it.
// Used when SQL_TABLES includes "adhistory" (see lib/sql.js). Two tables:
//
//   campaign_changes — every campaign change the dashboard has logged: edits
//     it pushed to Amazon and changes the daily refresh found. It is the
//     adcampaigns:changes kv log without the 200-record cap: one row per
//     record id, replaced when the log replaces that id. `data` is the record
//     exactly as the log holds it; the other columns are copies for querying,
//     plus `origin`, the page an edit was made from (null for refresh records
//     and for edits logged before history began).
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

const DDL = [
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
  )`
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
      await recordChanges((log && Array.isArray(log.rows)) ? log.rows : [], null);
      const cadences = Object.keys(SEED_RUN_KEYS);
      for (let i = 0; i < cadences.length; i++) {
        if (runs[i] && runs[i].collectedAt) await recordRun(cadences[i], runs[i], null);
      }
    })();
    ready.catch(() => { ready = null; });   // try again on the next write
  }
  return ready;
}

// Upserts change records by id. origin is the page an edit came from, or
// null; a null never erases an origin already recorded.
export async function recordChanges(records, origin) {
  const byId = new Map();
  for (const r of records) if (r && r.id) byId.set(String(r.id), r);
  if (!byId.size) return;
  await sql().query(
    `INSERT INTO campaign_changes (id, campaign_id, field, pt_date, changed_at, source, origin, data)
     SELECT d->>'id', d->>'campaignId', d->>'field',
       CASE WHEN d->>'ptDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (d->>'ptDate')::date END,
       CASE WHEN d->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (d->>'at')::timestamptz END,
       d->>'source', $2::text, d
     FROM json_array_elements($1::json) AS e(d)
     ON CONFLICT (id) DO UPDATE SET
       campaign_id = EXCLUDED.campaign_id, field = EXCLUDED.field, pt_date = EXCLUDED.pt_date,
       changed_at = EXCLUDED.changed_at, source = EXCLUDED.source,
       origin = COALESCE(EXCLUDED.origin, campaign_changes.origin), data = EXCLUDED.data`,
    [JSON.stringify([...byId.values()]), origin || null]);
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
