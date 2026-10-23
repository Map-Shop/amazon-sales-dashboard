// SQL storage for the statement rows derived from each Amazon transaction,
// used when SQL_TABLES includes "transactionrows" (along with
// "transactions"). The Profitability statement, its charts, and Brand &
// Product then read these rows instead of loading every raw transaction in
// their window and deriving them per request (lib/profitability.js), and
// the database runs the dedup. Three tables:
//
//   transaction_rows        — each transaction's derived rows, in the
//                             _v2024BlankRow shape (the same fields as
//                             imported_transaction_rows), keyed by the
//                             transaction's month and position in
//                             amazon_transactions and the row's order.
//   transaction_derivations — per transaction, only where it has either:
//                             its unmapped leaves ([type, amount] pairs, in
//                             walk order) and the breakdown types whose
//                             handling the fee mappings decide.
//   transaction_row_months  — per month, what its rows were derived from:
//                             the derivation code (DERIVE_FINGERPRINT), the
//                             fee mapping classes (feeClasses), and the
//                             month's revision, the xmin of its
//                             transaction_months row, which every write of
//                             the month changes.
//
// A sync derives the month's rows in the same write (syncStatements). Any
// month whose rows don't match its current state — never derived, written
// while this was off, derived by older code, or with fee mappings that have
// since changed — is re-derived by the next request that reads it: a whole
// month at a time, or for a fee mapping change only the transactions that
// reach a changed type. A re-derivation never overwrites a newer sync: its
// writes apply only while the month is still at the revision it read.

import { sql, usesSql } from './sql.js';
import { deriveTransaction, feeClasses, DERIVE_FINGERPRINT } from './profitability.js';

export function rowsInSql() {
  return usesSql('transactionrows') && usesSql('transactions');
}

// [field, column, type]: every field of a derived row, in its order.
const ROW_COLUMNS = [
  ['type', 'type', 'text'], ['orderId', 'order_id', 'text'], ['date', 'date', 'text'],
  ['sku', 'sku', 'text'], ['qty', 'qty', 'numeric'], ['fulfillment', 'fulfillment', 'text'],
  ['sale', 'sale', 'numeric'], ['otherCharges', 'other_charges', 'numeric'],
  ['fbaFees', 'fba_fees', 'numeric'], ['transactionFees', 'transaction_fees', 'numeric'],
  ['promotions', 'promotions', 'numeric'], ['feeType', 'fee_type', 'text'],
  ['feeAmount', 'fee_amount', 'numeric'], ['adjustmentType', 'adjustment_type', 'text'],
  ['adjustmentAmount', 'adjustment_amount', 'numeric'], ['_src', 'src', 'text'],
  ['_transactionId', 'transaction_id', 'text'], ['_transactionStatus', 'transaction_status', 'text']
];
const ROW_COLUMN_NAMES = ROW_COLUMNS.map(([, col]) => col).join(', ');

const DDL = [
  `CREATE TABLE IF NOT EXISTS transaction_rows (
    month text NOT NULL,
    position int NOT NULL,
    row_index int NOT NULL,
    ${ROW_COLUMNS.map(([, col, type]) => `${col} ${type}`).join(',\n    ')},
    extra json,
    PRIMARY KEY (month, position, row_index))`,
  `CREATE TABLE IF NOT EXISTS transaction_derivations (
    month text NOT NULL,
    position int NOT NULL,
    unmapped json,
    mapped_types text[] NOT NULL,
    PRIMARY KEY (month, position))`,
  `CREATE TABLE IF NOT EXISTS transaction_row_months (
    month text PRIMARY KEY,
    fingerprint text NOT NULL,
    fee_classes json NOT NULL,
    source_rev text NOT NULL,
    transaction_count int NOT NULL,
    row_count int NOT NULL,
    derived_at timestamptz NOT NULL DEFAULT now())`
];

// Creates the tables if they don't exist, once per process.
let _ensured = null;
export function ensure() {
  if (!_ensured) {
    const s = sql();
    _ensured = s.transaction([
      s.query("SELECT pg_advisory_xact_lock(hashtext('transaction_rows:ddl'))"),
      ...DDL.map(q => s.query(q))
    ]).catch(e => { _ensured = null; throw e; });
  }
  return _ensured;
}

// ── Rows as stored ───────────────────────────────────────────────────────

// A derived row as written: its values in column order when every field
// has its column's type, which the derivation's strings and numbers always
// do; otherwise the whole row as extra json, so nothing is coerced.
function encodeRow(r) {
  const keys = Object.keys(r);
  const fits = keys.length === ROW_COLUMNS.length && ROW_COLUMNS.every(([field, , type], i) =>
    keys[i] === field && (type === 'text' ? typeof r[field] === 'string' : typeof r[field] === 'number'));
  for (const v of Object.values(r)) {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`a derived row holds ${v}, which can't be stored exactly`);
  }
  return fits ? { c: ROW_COLUMNS.map(([field]) => r[field]) } : { x: r };
}

// A stored row as the derivation built it.
function decodeRow(r) {
  let row;
  if (r.extra !== null) row = r.extra;
  else {
    row = {};
    for (const [field, col, type] of ROW_COLUMNS) row[field] = type === 'numeric' ? Number(r[col]) : r[col];
  }
  // A refunded item with no quantity has qty -0 (0 × -1). numeric and json
  // both store it as 0; restore it, so the row is exactly the derivation's.
  if (row.type === 'Refund' && row.qty === 0) row.qty = -0;
  return row;
}

// One element per row: { p: position, i: row index, c: [values] | x: row }.
const ROW_INSERT = `INSERT INTO transaction_rows (month, position, row_index, ${ROW_COLUMN_NAMES}, extra)
  SELECT $1, (e.v->>'p')::int, (e.v->>'i')::int,
    ${ROW_COLUMNS.map(([, , type], k) => (type === 'numeric' ? `(e.v->'c'->>${k})::numeric` : `e.v->'c'->>${k}`)).join(', ')},
    e.v->'x'
  FROM json_array_elements($2::json) AS e(v)`;

// One element per transaction that has unmapped leaves or mapped types:
// { p: position, m: types, u: pairs (only when it has unmapped leaves) }.
const DERIVATION_INSERT = `INSERT INTO transaction_derivations (month, position, unmapped, mapped_types)
  SELECT $1, (e.v->>'p')::int, e.v->'u', ARRAY(SELECT json_array_elements_text(e.v->'m'))
  FROM json_array_elements($2::json) AS e(v)`;

// Derives each { position, transaction } and returns the rows and
// derivations to insert.
function deriveAll(items, feeMappings) {
  const rows = [];
  const derivations = [];
  for (const { position, transaction } of items) {
    const d = deriveTransaction(transaction, feeMappings);
    d.rows.forEach((r, i) => rows.push({ p: position, i, ...encodeRow(r) }));
    if (d.unmapped.length || d.mappedTypes.length) {
      derivations.push({ p: position, m: d.mappedTypes, ...(d.unmapped.length ? { u: d.unmapped } : {}) });
    }
  }
  return { rows, derivations };
}

const lockStatement = (s, month) =>
  s.query("SELECT pg_advisory_xact_lock(hashtext('transaction_rows:' || $1))", [month]);

// The statements that store `derived` for `month` — every transaction's, or
// only `positions`' — and restamp the month. With a guard, each statement
// applies only while the month is still at revision guard.rev and, for a
// partial update, still stamped with guard.classes, so a re-derivation that
// lost a race with a sync changes nothing. Run after lockStatement, in one
// transaction.
function writeStatements(s, month, derived, classesText, { positions = null, guard = null } = {}) {
  const only = positions ? ' AND position = ANY($2::int[])' : '';
  const only2 = positions ? [positions] : [];
  // The guard's parameters follow the statement's own; `at` is the first's number.
  const guardSql = (at) => !guard ? '' : ` AND (SELECT xmin::text FROM transaction_months WHERE month = $1) = $${at}`
    + (guard.classes === undefined ? '' : ` AND EXISTS (SELECT 1 FROM transaction_row_months
        WHERE month = $1 AND fingerprint = $${at + 1} AND fee_classes::text = $${at + 2})`);
  const guardParams = !guard ? [] : guard.classes === undefined ? [guard.rev] : [guard.rev, DERIVE_FINGERPRINT, guard.classes];
  const where = (at) => (guard ? ` WHERE true${guardSql(at)}` : '');
  return [
    s.query(`DELETE FROM transaction_rows WHERE month = $1${only}${guardSql(2 + only2.length)}`, [month, ...only2, ...guardParams]),
    s.query(`DELETE FROM transaction_derivations WHERE month = $1${only}${guardSql(2 + only2.length)}`, [month, ...only2, ...guardParams]),
    s.query(`${ROW_INSERT}${where(3)}`, [month, JSON.stringify(derived.rows), ...guardParams]),
    s.query(`${DERIVATION_INSERT}${where(3)}`, [month, JSON.stringify(derived.derivations), ...guardParams]),
    s.query(`INSERT INTO transaction_row_months
        (month, fingerprint, fee_classes, source_rev, transaction_count, row_count, derived_at)
      SELECT $1, $2, $3::json, (SELECT xmin::text FROM transaction_months WHERE month = $1),
        (SELECT count(*) FROM amazon_transactions WHERE month = $1),
        (SELECT count(*) FROM transaction_rows WHERE month = $1), now()${where(4)}
      ON CONFLICT (month) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, fee_classes = EXCLUDED.fee_classes,
        source_rev = EXCLUDED.source_rev, transaction_count = EXCLUDED.transaction_count,
        row_count = EXCLUDED.row_count, derived_at = EXCLUDED.derived_at`,
      [month, DERIVE_FINGERPRINT, classesText, ...guardParams])
  ];
}

// For a sync's write of `month` (lib/transactions.js replaceRawMonth): the
// lock to take before it, and the statements that store the month's rows
// after it, in the same transaction, so the stamp records the revision that
// write creates.
export function syncStatements(s, month, transactions, feeMappings) {
  const classesText = JSON.stringify(feeClasses(feeMappings));
  const derived = deriveAll(transactions.map((transaction, position) => ({ position, transaction })), feeMappings);
  return { before: [lockStatement(s, month)], after: writeStatements(s, month, derived, classesText) };
}

// ── Keeping months current ───────────────────────────────────────────────

// Each month in [startMonth, endMonth] with API data, with its revision and
// stamp.
const MONTH_STATE_SQL = `SELECT m.month, m.xmin::text AS rev, s.fingerprint,
    s.fee_classes::text AS fee_classes, s.source_rev
  FROM transaction_months m LEFT JOIN transaction_row_months s ON s.month = m.month
  WHERE m.month COLLATE "C" >= $1 AND m.month COLLATE "C" <= $2
  ORDER BY m.month COLLATE "C"`;

const isCurrent = (m, classesText) =>
  m.fingerprint === DERIVE_FINGERPRINT && m.source_rev === m.rev && m.fee_classes === classesText;

// Types whose class differs between two feeClasses results.
function changedTypes(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(t => a[t] !== b[t]);
}

// Brings one month's rows up to date: only the transactions that reach a
// changed type when just the fee mappings changed, otherwise the whole month.
// Skipped if another request got there first (the page's requests arrive
// together, and on a first load each finds the same months out of date).
async function rederive(stale, feeMappings, classesText) {
  const s = sql();
  const [m] = await s.query(MONTH_STATE_SQL, [stale.month, stale.month]);
  if (!m || isCurrent(m, classesText)) return;
  const onlyFees = m.fingerprint === DERIVE_FINGERPRINT && m.source_rev === m.rev;
  if (onlyFees) {
    const changed = changedTypes(JSON.parse(m.fee_classes), JSON.parse(classesText));
    const [[state], affected] = await s.transaction([
      s.query('SELECT xmin::text AS rev FROM transaction_months WHERE month = $1', [m.month]),
      s.query(`SELECT t.position, t.data FROM transaction_derivations d
        JOIN amazon_transactions t ON t.month = d.month AND t.position = d.position
        WHERE d.month = $1 AND d.mapped_types && $2::text[] ORDER BY t.position`, [m.month, changed])
    ], { isolationLevel: 'RepeatableRead', readOnly: true });
    if (state?.rev === m.rev) {
      const positions = affected.map(r => r.position);
      const derived = deriveAll(affected.map(r => ({ position: r.position, transaction: r.data })), feeMappings);
      await s.transaction([lockStatement(s, m.month),
        ...writeStatements(s, m.month, derived, classesText, { positions, guard: { rev: m.rev, classes: m.fee_classes } })]);
      return;
    }
  }
  const [[state], items] = await s.transaction([
    s.query('SELECT xmin::text AS rev FROM transaction_months WHERE month = $1', [m.month]),
    s.query('SELECT position, data FROM amazon_transactions WHERE month = $1 ORDER BY position', [m.month])
  ], { isolationLevel: 'RepeatableRead', readOnly: true });
  if (!state) return;
  const derived = deriveAll(items.map(r => ({ position: r.position, transaction: r.data })), feeMappings);
  await s.transaction([lockStatement(s, m.month),
    ...writeStatements(s, m.month, derived, classesText, { guard: { rev: state.rev } })]);
}

// ── Reading ──────────────────────────────────────────────────────────────

// The records the main pass keeps over months [$1, $2] and their order: the
// dedup of _deriveV2024Rows (lib/profitability.js) in SQL. Shipment records
// group by SHIPMENT_ID and Refund records by REFUND_ID, when they have one;
// each group keeps one record, by status priority, then posted date, then
// stored order, placed where its group first appears; every other record
// follows in stored order. (Amazon's posted dates are all
// YYYY-MM-DDTHH:MM:SSZ, where byte order is the derivation's localeCompare
// order.) sel narrows the kept records to those the pass derives for the
// window [$3, $4]: not transfers, and dated in the window or undated.
const KEPT_SQL = `
  u AS (
    SELECT month, position, transaction_type, posted_date,
      CASE WHEN transaction_type = 'Refund' AND refund_id <> '' THEN 'Refund|' || refund_id
           WHEN transaction_type = 'Shipment' AND shipment_id <> '' THEN 'Shipment|' || shipment_id END AS dkey,
      CASE transaction_status WHEN 'DEFERRED_RELEASED' THEN 0 WHEN 'DEFERRED' THEN 1
                              WHEN 'RELEASED' THEN 2 ELSE 99 END AS priority,
      row_number() OVER (ORDER BY month COLLATE "C", position) AS seq
    FROM amazon_transactions
    WHERE month COLLATE "C" >= $1 AND month COLLATE "C" <= $2
  ),
  ranked AS (
    SELECT u.*, min(seq) OVER g AS first_seq,
      row_number() OVER (g ORDER BY priority, coalesce(posted_date, '') COLLATE "C", seq) AS group_rank
    FROM u WINDOW g AS (PARTITION BY dkey)
  ),
  kept AS (
    SELECT month, position, transaction_type, left(coalesce(posted_date, ''), 10) AS date,
      dkey IS NULL AS passed_through, CASE WHEN dkey IS NULL THEN seq ELSE first_seq END AS ord
    FROM ranked WHERE dkey IS NULL OR group_rank = 1
  ),
  sel AS (
    SELECT * FROM kept
    WHERE transaction_type IS DISTINCT FROM 'Transfer'
      AND (date = '' OR (date COLLATE "C" >= $3 AND date COLLATE "C" <= $4))
  )`;

// The stored rows for the window [startDate, endDate], dedup'd over the
// months [startMonth, endMonth] (the window's widened by the lookback), as
// lib/profitability.js's inputs.derived, plus each month's transaction
// count. Re-derives whatever is out of date first.
export async function loadDerived({ startMonth, endMonth, startDate, endDate, feeMappings }) {
  await ensure();
  const s = sql();
  const classesText = JSON.stringify(feeClasses(feeMappings));
  const range = [startMonth, endMonth];
  const window = [startMonth, endMonth, startDate, endDate];
  for (let attempt = 1; ; attempt++) {
    for (const m of await s.query(MONTH_STATE_SQL, range)) {
      if (!isCurrent(m, classesText)) await rederive(m, feeMappings, classesText);
    }
    // One snapshot, so the rows and counts agree with each other and with
    // the month states they were checked against.
    const [states, [counts], monthCounts, rows, unmapped] = await s.transaction([
      s.query(MONTH_STATE_SQL, range),
      s.query(`WITH ${KEPT_SQL}
        SELECT (SELECT count(*) FROM ranked WHERE dkey IS NOT NULL AND group_rank > 1)::int AS dedup_skipped,
          (SELECT count(*) FROM kept WHERE transaction_type = 'Transfer')::int AS transfer_skipped,
          (SELECT count(*) FROM kept WHERE transaction_type IS DISTINCT FROM 'Transfer' AND date <> ''
            AND (date COLLATE "C" < $3 OR date COLLATE "C" > $4))::int AS out_of_window`, window),
      s.query(`SELECT month, count(*)::int AS n FROM amazon_transactions
        WHERE month COLLATE "C" >= $1 AND month COLLATE "C" <= $2 GROUP BY month`, range),
      s.query(`WITH ${KEPT_SQL}
        SELECT ${ROW_COLUMNS.map(([, col]) => `r.${col}`).join(', ')}, r.extra
        FROM sel JOIN transaction_rows r ON r.month = sel.month AND r.position = sel.position
        ORDER BY sel.passed_through, sel.ord, r.row_index`, window),
      s.query(`WITH ${KEPT_SQL}
        SELECT sel.date, d.unmapped
        FROM sel JOIN transaction_derivations d ON d.month = sel.month AND d.position = sel.position
        WHERE d.unmapped IS NOT NULL
        ORDER BY sel.passed_through, sel.ord`, window)
    ], { isolationLevel: 'RepeatableRead', readOnly: true });
    if (states.every(m => isCurrent(m, classesText))) {
      return {
        derived: {
          rows: rows.map(decodeRow),
          unmapped: unmapped.map(r => ({ date: r.date, pairs: r.unmapped })),
          dedupSkipped: counts.dedup_skipped,
          transferSkipped: counts.transfer_skipped,
          outOfWindowSkipped: counts.out_of_window
        },
        monthCounts: Object.fromEntries(monthCounts.map(r => [r.month, r.n]))
      };
    }
    // A sync or a mapping change landed in between; catch up and read again.
    if (attempt === 3) throw new Error('Statement rows kept changing while being read; try again');
  }
}
