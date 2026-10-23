import SellingPartner from 'amazon-sp-api';
import { kv } from '../lib/kv.js';
import * as txSql from '../lib/transactions.js';
import * as txRows from '../lib/transactionrows.js';
import * as stamps from '../lib/stamps.js';
import * as profit from '../lib/profitability.js';
// The profitability statement's other inputs, read the way their own
// endpoints read them. Vercel bundles these modules; they do not add
// serverless functions.
import { readProducts } from './products.js';
import { readMap } from './mappings.js';
import { readShippingRange } from './shipping.js';
import { readAdRange } from './adspend.js';

// A month's uploaded 2024 rows as { rows } (null when kv has no record), and
// their replacement — imported_transaction_rows when SQL_TABLES includes
// "transactions", otherwise the transactions:v2024:imported:YYYY-MM record.
async function readImportedMonth(month) {
  if (txSql.transactionsInSql()) return { rows: await txSql.getImportedMonth(month) };
  return kv.get(`transactions:v2024:imported:${month}`);
}
async function writeImportedMonth(month, rows) {
  if (txSql.transactionsInSql()) return txSql.replaceImportedMonth(month, rows);
  return kv.set(`transactions:v2024:imported:${month}`, { rows });
}

// Whether a month holds API transactions — the upload refuses to overwrite
// those. In kv a synced month counts even with zero transactions (its
// metadata says chunkCount 1); transaction_months records the same.
async function rawMonthHasData(month) {
  if (txSql.transactionsInSql()) return txSql.rawMonthHasData(month);
  const raw = await kv.get(`transactions:v2024:raw:${month}`);
  return Boolean(raw && (
    Array.isArray(raw.transactions) && raw.transactions.length > 0 ||
    Number.isFinite(raw.chunkCount) && raw.chunkCount > 0
  ));
}

// The months holding API data and uploaded rows, as { rawIndex,
// importedIndex }, and each month's latest posted date. With SQL_TABLES
// including "transactions" the tables answer (lib/transactions.js);
// otherwise the transactions:v2024:index / :imported-index /
// :latest-posted kv records do, which the sync and upload maintain only in
// that mode.
async function readMonthIndexes() {
  if (txSql.transactionsInSql()) {
    const [rawIndex, importedIndex] = await Promise.all([
      txSql.getRawMonths(), txSql.getImportedMonths()
    ]);
    return { rawIndex, importedIndex };
  }
  const [rawIndex, importedIndex] = await Promise.all([
    kv.get('transactions:v2024:index'),
    kv.get('transactions:v2024:imported-index')
  ]);
  return { rawIndex, importedIndex };
}
async function readLatestPostedMap() {
  if (txSql.transactionsInSql()) return txSql.getLatestPostedByMonth();
  return kv.get('transactions:v2024:latest-posted');
}

// When a month was last synced, from transaction_month_syncs when SQL_TABLES
// includes "stamps" (lib/stamps.js), otherwise from the
// transactions:v2024:last-synced:YYYY-MM kv record.
function txSyncedRead(month) {
  return stamps.stampsInSql() ? stamps.getMonthSync('transactions', month) : kv.get(`transactions:v2024:last-synced:${month}`);
}
function txSyncedWrite(month, at) {
  return stamps.stampsInSql() ? stamps.setMonthSync('transactions', month, at) : kv.set(`transactions:v2024:last-synced:${month}`, at);
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//   GET  ?action=sync            [&month=YYYY-MM]            — pull SP-API → KV (v0 listFinancialEvents)
//   GET  ?action=get             &month=YYYY-MM              — raw pages, one month
//   GET  ?action=get-range       &startMonth=&endMonth=      — raw pages, many months
//   GET  ?action=get-months                                  — list of synced months
//   GET  ?action=fetch-order-raw &orderId=                   — one order straight from SP-API
//   GET  ?action=probe-v2024     [&month=|&orderId=]         — Finances v2024-06-19 probe (see below)
//   GET  ?action=sync-v2024      [&month=YYYY-MM]            — pull SP-API listTransactions → KV
//   GET  ?action=get-v2024       &month=YYYY-MM              — raw transactions, one month
//   GET  ?action=get-range-v2024 &startMonth=&endMonth=      — raw transactions, many months
//   GET  ?action=get-months-v2024                            — list of v2024-synced months
//   GET  ?action=profit-period   &startDate=&endDate=        — one period's statement
//   GET  ?action=profit-charts   &startMonth=&endMonth=      — per-month metrics for the charts
//   GET  ?action=profit-brand-product &startDate=&endDate=&brand= — Brand & Product table
//   POST ?action=upload-yearly-csv                           — backfill from
//          Amazon "Custom Unified Transaction" CSV. Lands rows in the
//          imported namespace (see KV layout below) so they coexist with
//          any SP-API-synced months. Used for years older than SP-API's
//          ~23-month listTransactions window.
//
// probe-v2024 is the diagnostic that confirmed v0 listFinancialEvents
// silently excludes Deferred transactions (notably B2B Invoiced Orders).
// sync-v2024 / get-v2024 are the production migration off v0 — they hit
// the v2024-06-19 listTransactions endpoint which surfaces deferred
// transactions with transactionStatus DEFERRED|RELEASED|DEFERRED_RELEASED.
// Dedup rule (skip RELEASED with DEFERRED_TRANSACTION_ID) lives in the
// derivation, not here — see _deriveV2024Rows in lib/profitability.js.
//
// KV layout — v0 (legacy, will be retired after v2024 cutover):
//   transactions:raw:YYYY-MM         → { pages: [<FinancialEvents>, ...] }
//   transactions:index               → ['YYYY-MM', ...]
//   transactions:last-synced:YYYY-MM → ISO timestamp
//
// KV layout — v2024 (parallel during migration, replaces v0 after cutover):
//   transactions:v2024:raw:YYYY-MM         → { chunkCount: N, totalCount: M }
//                                            (legacy: { transactions: [...] })
//   transactions:v2024:raw:YYYY-MM:pK      → { transactions: [<Transaction>, ...] }
//                                            (chunked storage; K = 0..N-1)
//   transactions:v2024:index               → ['YYYY-MM', ...]
//   transactions:v2024:last-synced:YYYY-MM → ISO timestamp
//   transactions:v2024:latest-posted       → { 'YYYY-MM': 'YYYY-MM-DDTHH:MM:SSZ', ... }
//   transactions:v2024:imported:YYYY-MM    → { rows: [<_v2024BlankRow>] }
//                                            CSV-uploaded rows in the
//                                            already-derived flat shape. Read
//                                            in parallel with raw chunks by
//                                            handleGetRangeV2024 and returned
//                                            as `importedRows`. Client merges
//                                            them with derived rows before
//                                            _buildStatement runs.
// With SQL_TABLES including "transactions", the raw and imported records,
// the index, imported-index, and latest-posted are all answered by tables
// (lib/transactions.js) and no longer written; last-synced stays in kv.
//
// Chunked storage: Upstash imposes a 10 MB per-request size limit on KV
// writes. A single month's transactions can exceed that (notably 2025-08
// at 3,300+ transactions / >10 MB JSON). handleSyncV2024 splits the
// transactions array into chunks targeting ~8 MB serialized each, writes
// them to per-chunk keys, and stores a metadata record at the legacy
// path. handleGetV2024 / handleGetRangeV2024 transparently read either
// shape so months synced before chunking still work.
//
// The derivation into report-ready rows happens at request time (the
// profit-* actions, lib/profitability.js). With SQL_TABLES including
// "transactionrows" it happens once per transaction instead, as a sync
// stores the month, and is redone automatically when the derivation code or
// the fee mappings change (lib/transactionrows.js). Either way mapping
// changes don't require a re-sync.
export default async function handler(req, res) {
  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'Action parameter required' });

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (action === 'sync')            return handleSync(req, res);
    if (action === 'get')             return handleGet(req, res);
    if (action === 'get-range')       return handleGetRange(req, res);
    if (action === 'get-months')      return handleGetMonths(req, res);
    if (action === 'fetch-order-raw') return handleFetchOrderRaw(req, res);
    if (action === 'probe-v2024')     return handleProbeV2024(req, res);
    if (action === 'sync-v2024')      return handleSyncV2024(req, res);
    if (action === 'get-v2024')       return handleGetV2024(req, res);
    if (action === 'get-range-v2024') return handleGetRangeV2024(req, res);
    if (action === 'get-months-v2024') return handleGetMonthsV2024(req, res);
    if (action === 'profit-period')   return handleProfitPeriod(req, res);
    if (action === 'profit-charts')   return handleProfitCharts(req, res);
    if (action === 'profit-brand-product') return handleProfitBrandProduct(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'upload-yearly-csv') return handleUploadYearlyCsv(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── SYNC ────────────────────────────────────────────────────────────────────
async function handleSync(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    console.log(`[TRANSACTIONS SYNC] Starting sync for ${month}`);

    const { start, end } = monthBounds(month);
    const { pages, pageCount, eventCount } = await fetchFinancialEvents(start, end);

    await kv.set(`transactions:raw:${month}`, { pages });
    const index = (await kv.get('transactions:index')) || [];
    const updatedIndex = [...new Set([...index, month])].sort();
    await kv.set('transactions:index', updatedIndex);
    await kv.set(`transactions:last-synced:${month}`, new Date().toISOString());

    console.log(`[TRANSACTIONS SYNC] ${month}: pages=${pageCount} events=${eventCount}`);
    return res.status(200).json({
      success: true,
      month,
      pageCount,
      eventCount,
      message: `Transactions sync complete for ${month}`
    });
  } catch (error) {
    console.error('[TRANSACTIONS SYNC] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}

// ─── SYNC v2024 ──────────────────────────────────────────────────────────────
// Mirrors handleSync but hits the v2024-06-19 listTransactions endpoint via
// api_path (so it works regardless of whether the bundled amazon-sp-api
// version recognizes the operation). Stores the raw transactions array
// under a separate KV namespace so v0 and v2024 can coexist during the
// migration. No dedup here; the derivation runs per request, or as the
// month is stored with "transactionrows" (storeRawMonthV2024).
async function handleSyncV2024(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    console.log(`[TRANSACTIONS SYNC v2024] Starting sync for ${month}`);

    const { start, end } = monthBounds(month);
    const { transactions, pageCount } = await fetchListTransactions(start, end);

    const chunks = await storeRawMonthV2024(month, transactions);

    // In SQL mode the tables already record the month and its latest
    // postedDate (see readMonthIndexes); kv mode keeps them here.
    const kvBookkeeping = !txSql.transactionsInSql();
    if (kvBookkeeping) {
      const index = (await kv.get('transactions:v2024:index')) || [];
      const updatedIndex = [...new Set([...index, month])].sort();
      await kv.set('transactions:v2024:index', updatedIndex);
    }
    await txSyncedWrite(month, new Date().toISOString());

    // Track the absolute latest postedDate for this month so the
    // overview page can render "Most Recent Transaction Data: 3/31/26"
    // without scanning every blob.
    const monthLatest = transactions.reduce((acc, t) => {
      const d = t?.postedDate;
      return (d && (!acc || d > acc)) ? d : acc;
    }, null);
    if (monthLatest && kvBookkeeping) {
      const map = (await kv.get('transactions:v2024:latest-posted')) || {};
      map[month] = monthLatest;
      await kv.set('transactions:v2024:latest-posted', map);
    }

    console.log(`[TRANSACTIONS SYNC v2024] ${month}: pages=${pageCount} transactions=${transactions.length} chunks=${chunks.length}`);
    return res.status(200).json({
      success: true,
      month,
      pageCount,
      transactionCount: transactions.length,
      chunkCount: chunks.length,
      latestPostedDate: monthLatest,
      message: `v2024 transactions sync complete for ${month}`
    });
  } catch (error) {
    console.error('[TRANSACTIONS SYNC v2024] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}

// Stores a synced month's transactions and returns its chunks (the sync's
// response reports chunkCount, so they're computed in both modes). With
// SQL_TABLES including "transactions" the month goes to the
// amazon_transactions table whole; otherwise to chunked kv records.
async function storeRawMonthV2024(month, transactions) {
  // Chunk to stay under Upstash's 10 MB per-request limit. Each chunk
  // serializes to roughly the target size; if a single transaction
  // somehow exceeds the target the chunk holds just that one record.
  const chunks = chunkTransactions(transactions, V2024_CHUNK_TARGET_BYTES);

  if (txSql.transactionsInSql()) {
    // With "transactionrows" the month's statement rows are stored in the
    // same write, derived with the current fee mappings.
    const feeMappings = txRows.rowsInSql() ? ((await readMap('fee').catch(() => null)) || {}) : null;
    await txSql.replaceRawMonth(month, transactions, feeMappings);
    return chunks;
  }

  // Wipe stale chunks from a previous sync that produced more chunks
  // than this one (otherwise old tail chunks would linger and double-
  // count on read). We don't know the previous chunkCount cheaply so
  // we delete the standard range we'd ever have written.
  const prevMeta = await kv.get(`transactions:v2024:raw:${month}`);
  const prevChunkCount = (prevMeta && Number.isFinite(prevMeta.chunkCount))
    ? prevMeta.chunkCount : 0;
  const wipeUpTo = Math.max(prevChunkCount, chunks.length);
  for (let k = chunks.length; k < wipeUpTo; k++) {
    await kv.del(`transactions:v2024:raw:${month}:p${k}`);
  }

  // Write chunks first, then the metadata pointer last — so a partial
  // failure leaves the prior month's data intact rather than half-
  // overwriting it.
  for (let k = 0; k < chunks.length; k++) {
    await kv.set(`transactions:v2024:raw:${month}:p${k}`, { transactions: chunks[k] });
  }
  await kv.set(`transactions:v2024:raw:${month}`, {
    chunkCount: chunks.length,
    totalCount: transactions.length
  });
  return chunks;
}

// Target serialized size per chunk. Upstash caps single requests at
// 10 MiB (10,485,760 bytes); 8 MiB leaves room for JSON wrapper bytes,
// transport encoding, and the small metadata fields the @vercel/kv client
// adds.
const V2024_CHUNK_TARGET_BYTES = 8 * 1024 * 1024;

function chunkTransactions(transactions, targetBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 2; // [] brackets
  for (const t of transactions) {
    // +1 for the comma separator between elements (negligible at scale
    // but keeps the estimate honest near the boundary).
    const tBytes = Buffer.byteLength(JSON.stringify(t)) + 1;
    if (current.length > 0 && currentBytes + tBytes > targetBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(t);
    currentBytes += tBytes;
  }
  if (current.length > 0) chunks.push(current);
  // Edge case: empty month still gets one (empty) chunk so reads have a
  // consistent shape.
  if (chunks.length === 0) chunks.push([]);
  return chunks;
}

// Reads a single month's transactions from KV, transparently handling
// both the chunked layout (current) and the legacy single-blob layout
// (months synced before chunking).
async function readMonthV2024(month) {
  if (txSql.transactionsInSql()) return txSql.getRawMonth(month);
  const meta = await kv.get(`transactions:v2024:raw:${month}`);
  if (!meta) return [];
  if (Array.isArray(meta.transactions)) return meta.transactions; // legacy
  const chunkCount = Number.isFinite(meta.chunkCount) ? meta.chunkCount : 0;
  if (chunkCount === 0) return [];
  const keys = [];
  for (let k = 0; k < chunkCount; k++) {
    keys.push(`transactions:v2024:raw:${month}:p${k}`);
  }
  const buckets = await Promise.all(keys.map(k => kv.get(k)));
  const out = [];
  for (const b of buckets) {
    if (!b || !Array.isArray(b.transactions)) continue;
    for (const t of b.transactions) out.push(t);
  }
  return out;
}

// ─── READ v2024 ──────────────────────────────────────────────────────────────
async function handleGetV2024(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required' });
    }

    const [transactions, lastSynced] = await Promise.all([
      readMonthV2024(month),
      txSyncedRead(month)
    ]);

    return res.status(200).json({
      success: true,
      month,
      transactions,
      lastSynced: lastSynced || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get v2024 transactions: ' + error.message });
  }
}

async function handleGetRangeV2024(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) {
      return res.status(400).json({ error: 'startMonth and endMonth required (YYYY-MM)' });
    }

    const { months, transactions, importedRows } = await readRangeV2024(startMonth, endMonth);
    return res.status(200).json({
      success: true, startMonth, endMonth, months, transactions, importedRows
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get v2024 range: ' + error.message });
  }
}

// The months in [startMonth, endMonth] with API or uploaded data, their
// transactions concatenated in month order, and the uploaded rows of months
// with no API data. Read by get-range-v2024 and, without "transactionrows",
// the profit-* actions.
async function readRangeV2024(startMonth, endMonth) {
  const months = await readRangeMonths(startMonth, endMonth);

  // Raw and imported reads run in parallel — each independent month
  // hits two keys at most, so the join here is fast.
  const [monthArrays, importedBuckets] = await Promise.all([
    Promise.all(months.map(m => readMonthV2024(m))),
    Promise.all(months.map(m => readImportedMonth(m)))
  ]);

  // Flatten: all months' transactions concatenated. Dedup happens later
  // in the derivation, since the dedup rule needs to inspect each
  // transaction's relatedIdentifiers.
  const transactions = [];
  for (const arr of monthArrays) {
    for (const t of arr) transactions.push(t);
  }
  // Imported rows are already in the derived `_v2024BlankRow` shape and
  // bypass _deriveV2024Rows. We only emit imported rows for months where
  // the raw SP-API namespace is empty — if both exist for the same month,
  // raw wins (it's the authoritative source). This makes a future SP-API
  // sync of a previously-imported month silently supersede the CSV
  // without anyone having to delete the imported bucket by hand.
  const importedRows = [];
  for (let i = 0; i < months.length; i++) {
    const rawHasData = monthArrays[i] && monthArrays[i].length > 0;
    if (rawHasData) continue;
    const b = importedBuckets[i];
    if (!b || !Array.isArray(b.rows)) continue;
    for (const r of b.rows) importedRows.push(r);
  }
  return { months, transactions, importedRows };
}

// The months in [startMonth, endMonth] with API or uploaded data, ascending.
async function readRangeMonths(startMonth, endMonth) {
  // Union the SP-API index and the imported (CSV-uploaded) index so a
  // month present only in imported rows still shows up in the read.
  const { rawIndex, importedIndex } = await readMonthIndexes();
  const monthSet = new Set();
  for (const m of (rawIndex || [])) {
    if (m >= startMonth && m <= endMonth) monthSet.add(m);
  }
  for (const m of (importedIndex || [])) {
    if (m >= startMonth && m <= endMonth) monthSet.add(m);
  }
  return [...monthSet].sort();
}

// readRangeV2024's result with the transactions as their stored rows
// (lib/transactionrows.js): the window [startDate, endDate]'s rows after
// the dedup over [startMonth, endMonth], as inputs.derived, in place of
// every raw record. The months and the uploaded rows are readRangeV2024's:
// uploaded rows only for months with no API transactions.
async function readRangeDerived(startMonth, endMonth, startDate, endDate, feeMappings) {
  const [months, { derived, monthCounts }] = await Promise.all([
    readRangeMonths(startMonth, endMonth),
    txRows.loadDerived({ startMonth, endMonth, startDate, endDate, feeMappings })
  ]);
  const buckets = await Promise.all(months.filter(m => !monthCounts[m]).map(m => readImportedMonth(m)));
  const importedRows = [];
  for (const b of buckets) {
    if (!b || !Array.isArray(b.rows)) continue;
    for (const r of b.rows) importedRows.push(r);
  }
  return { months, transactions: [], importedRows, derived };
}

// ─── PROFITABILITY ───────────────────────────────────────────────────────────
// The Profitability statement, its 12-month charts, and Brand & Product,
// computed by lib/profitability.js from the same reads the page used to
// fetch, so the page receives finished numbers instead of every raw
// transaction. Fee mappings are read per request.

// The inputs for [startDate, endDate]: transactions over the window's months
// widened by the dedup lookback, plus the catalog, ad spend, mappings, and
// shipping. The page treated ad spend, mappings, and shipping as optional (a
// failed fetch read as empty) and the latest sync time as best-effort; so
// does this. With "transactionrows" the transactions come as their stored
// rows, read once the fee mappings are known.
async function loadProfitInputs(startDate, endDate) {
  const startMonth = startDate.slice(0, 7);
  const endMonth   = endDate.slice(0, 7);
  const widenedStart = profit.shiftMonth(startMonth, -profit.V2024_LOOKBACK_MONTHS);
  const optional = (read, empty) => read.catch(() => empty);
  const rowsStored = txRows.rowsInSql();

  const [rawTx, products, spAd, sbAd, prodMap, brandMap, feeMap, shipping] = await Promise.all([
    rowsStored ? null : readRangeV2024(widenedStart, endMonth),
    readProducts(),
    optional(readAdRange('sp', startMonth, endMonth), { rows: [] }),
    optional(readAdRange('sb', startMonth, endMonth), { rows: [] }),
    optional(readMap('product'), null),
    optional(readMap('brand'), null),
    optional(readMap('fee'), null),
    optional(readShippingRange(startMonth, endMonth), { rows: [] })
  ]);
  const tx = rowsStored
    ? await readRangeDerived(widenedStart, endMonth, startDate, endDate, feeMap || {})
    : rawTx;

  const latestSyncedMonth = tx.months.length > 0 ? tx.months[tx.months.length - 1] : null;
  let lastSynced = null;
  try {
    if (latestSyncedMonth) {
      lastSynced = (await txSyncedRead(latestSyncedMonth)) || null;
    }
  } catch { /* non-fatal */ }

  return profit.buildInputs({
    tx,
    prod: { products: products || [] },
    spAd, sbAd,
    prodMap: { mappings: prodMap || {} },
    brandMap: { mappings: brandMap || {} },
    feeMap: { mappings: feeMap || {} },
    shipping,
    lastSynced
  });
}

const PROFIT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROFIT_MONTH = /^\d{4}-\d{2}$/;
// The charts ask for 12 months; this bounds what one request can load.
const PROFIT_CHART_MAX_MONTHS = 24;

async function handleProfitPeriod(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startDate, endDate } = req.query;
    if (!PROFIT_DATE.test(startDate || '') || !PROFIT_DATE.test(endDate || '')) {
      return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
    }
    const inputs = await loadProfitInputs(startDate, endDate);
    // Every derived row stays here; nothing on the page reads them.
    const { rows, ...period } = profit.computePeriod(inputs, startDate, endDate);
    return res.status(200).json({ success: true, period });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to build the statement: ' + error.message });
  }
}

async function handleProfitCharts(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startMonth, endMonth } = req.query;
    if (!PROFIT_MONTH.test(startMonth || '') || !PROFIT_MONTH.test(endMonth || '') || startMonth > endMonth) {
      return res.status(400).json({ error: 'startMonth and endMonth required (YYYY-MM, start first)' });
    }
    // Whole calendar months, as the page's 12-month window lists them.
    const months = [];
    for (let m = startMonth; m <= endMonth && months.length <= PROFIT_CHART_MAX_MONTHS; m = profit.shiftMonth(m, 1)) {
      const [y, mo] = m.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      months.push({ startDate: `${m}-01`, endDate: `${m}-${String(lastDay).padStart(2, '0')}` });
    }
    if (months.length > PROFIT_CHART_MAX_MONTHS) {
      return res.status(400).json({ error: `At most ${PROFIT_CHART_MAX_MONTHS} months` });
    }
    const inputs = await loadProfitInputs(months[0].startDate, months[months.length - 1].endDate);
    return res.status(200).json({ success: true, months: profit.computeChartMonths(inputs, months) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to build the charts: ' + error.message });
  }
}

async function handleProfitBrandProduct(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startDate, endDate, brand } = req.query;
    if (!PROFIT_DATE.test(startDate || '') || !PROFIT_DATE.test(endDate || '')) {
      return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
    }
    const inputs = await loadProfitInputs(startDate, endDate);
    return res.status(200).json({
      success: true,
      brands: profit.computeBrandProduct(inputs, startDate, endDate, brand)
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to build Brand & Product: ' + error.message });
  }
}

async function handleGetMonthsV2024(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const [{ rawIndex: index, importedIndex }, storedMap] = await Promise.all([
      readMonthIndexes(),
      readLatestPostedMap()
    ]);
    const latestPostedMap = (storedMap && typeof storedMap === 'object') ? { ...storedMap } : {};
    // Union with imported months so the navigation widget / data-blurb
    // can advertise CSV-uploaded months even if the SP-API has never
    // touched them (the only way to surface 2024 in a 2026 session).
    const monthSet = new Set(Array.isArray(index) ? index : []);
    for (const m of (importedIndex || [])) monthSet.add(m);
    const months = [...monthSet].sort();

    // Lazy backfill: months synced before the latest-posted-by-month
    // dictionary existed have no entry. Compute the max postedDate for
    // the *most recent* synced month if it's missing — that's the only
    // month that could affect the global "latest" label, so we don't
    // need to scan older months. After this populates once it persists.
    // (kv mode only: the tables' map always covers every month with data.)
    if (months.length > 0 && !txSql.transactionsInSql()) {
      const latestMonth = months[months.length - 1];
      if (!latestPostedMap[latestMonth]) {
        const txs = await readMonthV2024(latestMonth);
        let monthLatest = null;
        for (const t of txs) {
          const d = t?.postedDate;
          if (d && (!monthLatest || d > monthLatest)) monthLatest = d;
        }
        if (monthLatest) {
          latestPostedMap[latestMonth] = monthLatest;
          await kv.set('transactions:v2024:latest-posted', latestPostedMap);
        }
      }
    }

    // Global max across the dictionary.
    let latestPostedDate = null;
    for (const v of Object.values(latestPostedMap)) {
      if (v && (!latestPostedDate || v > latestPostedDate)) latestPostedDate = v;
    }
    return res.status(200).json({
      success: true,
      months,
      latestPostedDate,
      latestPostedByMonth: latestPostedMap
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list v2024 months: ' + error.message });
  }
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required' });
    }

    const [stored, lastSynced] = await Promise.all([
      kv.get(`transactions:raw:${month}`),
      kv.get(`transactions:last-synced:${month}`)
    ]);

    return res.status(200).json({
      success: true,
      month,
      pages: stored?.pages || [],
      lastSynced: lastSynced || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get transactions: ' + error.message });
  }
}

async function handleGetRange(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) {
      return res.status(400).json({ error: 'startMonth and endMonth required (YYYY-MM)' });
    }

    const index = (await kv.get('transactions:index')) || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`transactions:raw:${m}`)));

    // Flatten: all months' pages concatenated into one pages array. Order is
    // month-then-page within month, matching how the raw data was synced.
    const pages = [];
    for (const b of buckets) {
      if (!b || !Array.isArray(b.pages)) continue;
      for (const p of b.pages) pages.push(p);
    }

    return res.status(200).json({ success: true, startMonth, endMonth, months, pages });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get range: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const index = (await kv.get('transactions:index')) || [];
    return res.status(200).json({ success: true, months: index });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list months: ' + error.message });
  }
}

// Fetches a single order directly from SP-API (bypasses KV entirely). For
// debugging / schema discovery — returns exactly what listFinancialEventsByOrderId
// produced, no reshaping. Paginates in case the order has more events than
// fit on one page.
async function handleFetchOrderRaw(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId query param required' });

    const sp = createSellingPartner();
    const pages = [];
    let nextToken = null;
    let calls = 0;
    do {
      const raw = await sp.callAPI({
        operation: 'listFinancialEventsByOrderId',
        endpoint: 'finances',
        path: { orderId },
        query: { MaxResultsPerPage: 100, ...(nextToken ? { NextToken: nextToken } : {}) }
      });
      const body = raw?.payload ?? raw ?? {};
      pages.push(body);
      nextToken = body.NextToken || body.nextToken || null;
      calls++;
      if (nextToken) await sleep(500);
    } while (nextToken && calls < 20);

    return res.status(200).json({ success: true, orderId, pageCount: calls, pages });
  } catch (error) {
    console.error('[FETCH ORDER RAW] Error:', error);
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── FINANCES v2024-06-19 PROBE ──────────────────────────────────────────────
// Diagnostic-only. Does NOT write to KV. Issues listTransactions against the
// new Finances API surface and returns the raw response plus a summary
// (counts by transactionType / transactionStatus, every breakdownType and
// deferralReason seen, the first transaction, and the first deferred
// transaction found). Three input modes, in priority order:
//   &orderId=114-...      — filter to one order (fastest, use this to find
//                           the known-missing $6,412 sale)
//   &month=YYYY-MM        — month window, capped at 10 paginated calls
//   (default)             — last 24h, capped at 5 paginated calls
//
// Uses api_path to bypass whatever operation map the amazon-sp-api library
// bundles — works regardless of library version. The library still signs
// the request and manages the access token normally.
async function handleProbeV2024(req, res) {
  try {
    // No Google auth check — matches handleSync's posture. SP-API creds
    // live in env vars, the endpoint is bounded (pagination cap), and
    // there are no KV writes. Paste the URL straight into a browser.
    const { orderId, month } = req.query;
    // Response is always a compact distilled summary (counts, shape per
    // type/status, dedup rule validation, every breakdownType seen). Add
    // &raw=1 to additionally include the full untransformed transactions
    // array — only useful for one-off deep inspection, not for decisions.
    let query;
    let maxCalls;
    if (orderId) {
      // relatedIdentifierName/Value is the documented filter as of 2026-01-28.
      // postedAfter is required and Amazon rejects anything older than
      // ~2 years from now, so use "now minus 23 months" — the widest window
      // Amazon will accept.
      const now = new Date();
      const windowStart = new Date(now.getTime());
      windowStart.setUTCMonth(windowStart.getUTCMonth() - 23);
      query = {
        relatedIdentifierName: 'ORDER_ID',
        relatedIdentifierValue: orderId,
        postedAfter: windowStart.toISOString().replace(/\.\d{3}Z$/, 'Z')
      };
      maxCalls = 20;
    } else if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month must be YYYY-MM' });
      }
      const { start, end } = monthBounds(month);
      query = { postedAfter: start, postedBefore: end };
      maxCalls = 50;
    } else {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      query = {
        postedAfter: dayAgo.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        postedBefore: now.toISOString().replace(/\.\d{3}Z$/, 'Z')
      };
      maxCalls = 5;
    }

    const sp = createSellingPartner();
    const transactions = [];
    let nextToken = null;
    let calls = 0;

    do {
      const raw = await sp.callAPI({
        api_path: '/finances/2024-06-19/transactions',
        method: 'GET',
        query: { ...query, ...(nextToken ? { nextToken } : {}) }
      });
      const body = raw?.payload ?? raw ?? {};
      const list = Array.isArray(body.transactions) ? body.transactions : [];
      transactions.push(...list);
      nextToken = body.nextToken || null;
      calls++;
      console.log(`[PROBE V2024] page ${calls}: transactions=${list.length} hasNextToken=${!!nextToken}`);
      // Rate limit is 0.5 req/s with burst of 10, so 2.2s between calls is safe.
      if (nextToken && calls < maxCalls) await sleep(2200);
    } while (nextToken && calls < maxCalls);

    // Distill each transaction into a compact shape descriptor so a single
    // response tells us everything the derivation needs to know: counts per
    // (type, status), which related-identifier names appear per partition
    // (that's the dedup-rule check), every breakdownType string ever seen,
    // and one distilled example per (type, status) combo. Full raw
    // transactions only included when &raw=1 is set.
    const byType = {};
    const byStatus = {};
    const breakdownTypes = new Set();
    const deferralReasons = new Set();
    const relatedIdentifierNames = new Set();
    const typeStatusShapes = {}; // key: "type|status" → { count, sample: {...} }
    let releasedWithDeferredAncestor = 0;
    let releasedPure = 0;
    const pureReleasedRidNames = new Set();
    const ancestorReleasedRidNames = new Set();

    const walkBreakdowns = (bs, out) => {
      for (const b of (bs || [])) {
        if (b?.breakdownType) {
          breakdownTypes.add(b.breakdownType);
          if (out) out.add(b.breakdownType);
        }
        if (Array.isArray(b?.breakdowns)) walkBreakdowns(b.breakdowns, out);
      }
    };

    const hasDeferredAncestor = (t) =>
      (t.relatedIdentifiers || []).some(r => r?.relatedIdentifierName === 'DEFERRED_TRANSACTION_ID');

    const distill = (t) => {
      const ridNames = [...new Set((t.relatedIdentifiers || [])
        .map(r => r?.relatedIdentifierName).filter(Boolean))].sort();
      const ctxTypes = [...new Set((t.contexts || [])
        .map(c => c?.contextType).filter(Boolean))].sort();
      const topBreakdowns = new Set();
      walkBreakdowns(t.breakdowns, topBreakdowns);
      const itemCount = Array.isArray(t.items) ? t.items.length : 0;
      const itemBreakdowns = new Set();
      let itemFulfillmentNetwork = null;
      let itemHasSku = false;
      if (itemCount > 0) {
        for (const item of t.items) {
          walkBreakdowns(item.breakdowns, itemBreakdowns);
          for (const c of (item.contexts || [])) {
            if (c?.contextType === 'ProductContext') {
              if (c.fulfillmentNetwork) itemFulfillmentNetwork = c.fulfillmentNetwork;
              if (c.sku) itemHasSku = true;
            }
          }
        }
      }
      const deferralReason = (t.contexts || [])
        .find(c => c?.contextType === 'DeferredContext')?.deferralReason || null;
      return {
        transactionId: t.transactionId || null,
        description: t.description || null,
        totalAmount: t.totalAmount?.currencyAmount ?? null,
        postedDate: t.postedDate || null,
        accountType: t.sellingPartnerMetadata?.accountType || null,
        relatedIdentifierNames: ridNames,
        contextTypes: ctxTypes,
        deferralReason,
        topLevelBreakdownTypes: [...topBreakdowns].sort(),
        itemCount,
        itemBreakdownTypes: [...itemBreakdowns].sort(),
        itemFulfillmentNetwork,
        itemHasSku
      };
    };

    for (const t of transactions) {
      const tType = t.transactionType || '(null)';
      const tStatus = t.transactionStatus || '(null)';
      byType[tType] = (byType[tType] || 0) + 1;
      byStatus[tStatus] = (byStatus[tStatus] || 0) + 1;
      const key = `${tType}|${tStatus}`;
      if (!typeStatusShapes[key]) typeStatusShapes[key] = { count: 0, sample: distill(t) };
      typeStatusShapes[key].count++;
      walkBreakdowns(t.breakdowns, null);
      for (const item of (t.items || [])) walkBreakdowns(item.breakdowns, null);
      for (const ctx of (t.contexts || [])) {
        if (ctx?.deferralReason) deferralReasons.add(ctx.deferralReason);
      }
      for (const rid of (t.relatedIdentifiers || [])) {
        if (rid?.relatedIdentifierName) relatedIdentifierNames.add(rid.relatedIdentifierName);
      }
      if (tStatus === 'RELEASED') {
        const names = (t.relatedIdentifiers || []).map(r => r?.relatedIdentifierName).filter(Boolean);
        if (hasDeferredAncestor(t)) {
          releasedWithDeferredAncestor++;
          for (const n of names) ancestorReleasedRidNames.add(n);
        } else {
          releasedPure++;
          for (const n of names) pureReleasedRidNames.add(n);
        }
      }
    }

    const response = {
      success: true,
      query,
      pageCount: calls,
      hitPageCap: nextToken !== null && calls >= maxCalls,
      totalTransactions: transactions.length,
      byType,
      byStatus,
      dedup: {
        releasedWithDeferredAncestor,
        releasedPure,
        pureReleasedIdentifierNames: [...pureReleasedRidNames].sort(),
        ancestorReleasedIdentifierNames: [...ancestorReleasedRidNames].sort(),
        ruleValidated: !pureReleasedRidNames.has('DEFERRED_TRANSACTION_ID') &&
                        ancestorReleasedRidNames.has('DEFERRED_TRANSACTION_ID')
      },
      breakdownTypesSeen: [...breakdownTypes].sort(),
      deferralReasonsSeen: [...deferralReasons].sort(),
      relatedIdentifierNamesSeen: [...relatedIdentifierNames].sort(),
      typeStatusShapes
    };
    if (req.query.raw === '1') response.allTransactions = transactions;
    return res.status(200).json(response);
  } catch (error) {
    console.error('[PROBE V2024] Error:', error);
    return res.status(500).json({ error: 'Probe failed: ' + error.message, stack: error.stack });
  }
}

// ─── SP-API FETCH ────────────────────────────────────────────────────────────

function createSellingPartner() {
  return new SellingPartner({
    region: 'na',
    refresh_token: process.env.AMAZON_REFRESH_TOKEN,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
    }
  });
}

async function fetchFinancialEvents(postedAfter, postedBefore) {
  const sp = createSellingPartner();
  const pages = [];
  let nextToken = null;
  let calls = 0;
  let eventCount = 0;

  do {
    const raw = await sp.callAPI({
      operation: 'listFinancialEvents',
      endpoint: 'finances',
      query: {
        PostedAfter: postedAfter,
        PostedBefore: postedBefore,
        MaxResultsPerPage: 100,
        ...(nextToken ? { NextToken: nextToken } : {})
      }
    });
    const body = raw?.payload ?? raw ?? {};
    const financialEvents = body.FinancialEvents || body.financialEvents || {};
    nextToken = body.NextToken || body.nextToken || null;

    const pageEvents = countEvents(financialEvents);
    eventCount += pageEvents;
    pages.push(financialEvents);
    calls++;

    console.log(`[TRANSACTIONS SYNC] page ${calls}: events=${pageEvents} hasNextToken=${!!nextToken}`);
    if (nextToken) await sleep(500);
  } while (nextToken && calls < 200);

  return { pages, pageCount: calls, eventCount };
}

// Same shape as fetchFinancialEvents but for the v2024-06-19 listTransactions
// endpoint. Calls via api_path so it's not dependent on the bundled
// amazon-sp-api version's endpoint map. Rate limit is 0.5 req/s with burst
// 10, so we wait 2.2s between paginated calls. Returns the flat transactions
// array — dedup happens later in the client-side derivation.
async function fetchListTransactions(postedAfter, postedBefore) {
  const sp = createSellingPartner();
  const transactions = [];
  let nextToken = null;
  let calls = 0;

  do {
    const raw = await sp.callAPI({
      api_path: '/finances/2024-06-19/transactions',
      method: 'GET',
      query: {
        postedAfter,
        postedBefore,
        ...(nextToken ? { nextToken } : {})
      }
    });
    const body = raw?.payload ?? raw ?? {};
    const list = Array.isArray(body.transactions) ? body.transactions : [];
    transactions.push(...list);
    nextToken = body.nextToken || null;
    calls++;

    console.log(`[TRANSACTIONS SYNC v2024] page ${calls}: transactions=${list.length} hasNextToken=${!!nextToken}`);
    if (nextToken) await sleep(2200);
  } while (nextToken && calls < 200);

  return { transactions, pageCount: calls };
}

function countEvents(fe) {
  const lists = [
    'ShipmentEventList', 'RefundEventList', 'GuaranteeClaimEventList',
    'ChargebackEventList', 'ServiceFeeEventList', 'AdjustmentEventList',
    'PayWithAmazonEventList', 'RentalTransactionEventList',
    'ProductAdsPaymentEventList', 'RetrochargeEventList',
    'PerformanceBondRefundEventList', 'TrialShipmentEventList'
  ];
  let total = 0;
  for (const name of lists) {
    const arr = fe[name];
    if (Array.isArray(arr)) total += arr.length;
  }
  return total;
}

// ─── UPLOAD YEARLY CSV (Amazon Custom Unified Transaction Report) ───────────
//
// The client parses the CSV (so the API stays under Vercel's request-size
// cap) and POSTs the rows as JSON. Each row's CSV columns are the flat
// "Date Range Report" shape: date/time, type, order id, sku, quantity,
// fulfillment, product sales, selling fees, fba fees, etc. We normalize to
// the same `_v2024BlankRow` shape `_deriveV2024Rows` outputs and write per-
// month buckets keyed `transactions:v2024:imported:YYYY-MM`.
//
// Why store the derived shape instead of trying to reconstruct nested
// SP-API breakdown trees: the CSV is already flat. Reverse-engineering it
// into the listTransactions response shape (items[].breakdowns[] with
// breakdownType + breakdownAmount) would be lossy and brittle — the CSV
// merges multiple breakdown leaves under one column. Flat rows skip that
// entire path: handleGetRangeV2024 returns them as `importedRows`, the
// client concatenates them with derived rows, and _buildStatement
// consumes them identically.
//
// Marketplace-Facilitator tax handling: every order row in the CSV
// includes both the tax Amazon collected (product sales tax, shipping
// credits tax, etc.) and a "marketplace withheld tax" that nets the
// collection to zero. We drop all tax columns rather than carrying them
// through — they have no P&L impact for the seller.
//
// Idempotency: a re-upload of the same year overwrites the imported
// rows for those months. The raw SP-API namespace is untouched, so any
// 2025+ months that have *both* an SP-API sync and accidentally appear
// in a re-uploaded CSV would double-count. The client guards against
// this by warning if you upload a CSV that contains months already in
// the raw index (see processUpload in js/upload.js).
async function handleUploadYearlyCsv(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows array required in body' });
    if (rows.length === 0) {
      return res.status(200).json({ success: true, months: [], totalRows: 0 });
    }

    // Group normalized rows by YYYY-MM. Skip rows whose date doesn't
    // parse — those are header preamble lines or malformed entries and
    // would otherwise land in a bogus "undefined" bucket.
    const byMonth = {};
    const monthLatestDate = {}; // month → latest YYYY-MM-DD seen
    let skippedNoDate = 0;
    let skippedTransfer = 0;
    for (const raw of rows) {
      const norm = _normalizeYearlyCsvRow(raw);
      if (!norm) { skippedTransfer++; continue; }
      const date = norm.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skippedNoDate++; continue; }
      const month = date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push(norm);
      if (!monthLatestDate[month] || date > monthLatestDate[month]) {
        monthLatestDate[month] = date;
      }
    }

    const writtenMonths = Object.keys(byMonth).sort();
    if (writtenMonths.length === 0) {
      return res.status(200).json({
        success: true, months: [], totalRows: 0,
        skippedNoDate, skippedTransfer,
        message: 'No valid rows found in the upload'
      });
    }

    // Refuse to overwrite months that already have raw SP-API data — the
    // SP-API is authoritative (it includes deferred/B2B detail the CSV
    // can't reconstruct). The user can run the upload again after
    // explicitly clearing the raw key if they really want to replace it.
    const collisions = [];
    for (const m of writtenMonths) {
      if (await rawMonthHasData(m)) collisions.push(m);
    }
    if (collisions.length > 0) {
      return res.status(409).json({
        error: `Refusing to upload: months ${collisions.join(', ')} already have SP-API data. Delete those KV keys first if you really mean to replace them.`,
        collidingMonths: collisions
      });
    }

    // Write per-month buckets, then update the imported-month index and
    // the latest-posted map. Same write-data-first-then-pointer pattern
    // as handleSyncV2024 so a partial failure doesn't corrupt the index.
    let totalRows = 0;
    for (const m of writtenMonths) {
      await writeImportedMonth(m, byMonth[m]);
      totalRows += byMonth[m].length;
    }
    // In SQL mode the table already knows the months and their latest
    // dates (see readMonthIndexes); kv mode keeps them here.
    if (!txSql.transactionsInSql()) {
      const existingIndex = (await kv.get('transactions:v2024:imported-index')) || [];
      const mergedIndex = [...new Set([...existingIndex, ...writtenMonths])].sort();
      await kv.set('transactions:v2024:imported-index', mergedIndex);

      // Latest-posted: store as an ISO timestamp at end-of-day UTC so the
      // overview's "Most Recent Transaction Data" label renders the right
      // calendar date. Only updates the per-month entry; the global max
      // is computed at read time.
      const latestPostedMap = (await kv.get('transactions:v2024:latest-posted')) || {};
      for (const m of writtenMonths) {
        const date = monthLatestDate[m];
        const iso = `${date}T23:59:59Z`;
        if (!latestPostedMap[m] || iso > latestPostedMap[m]) {
          latestPostedMap[m] = iso;
        }
      }
      await kv.set('transactions:v2024:latest-posted', latestPostedMap);
    }

    return res.status(200).json({
      success: true,
      months: writtenMonths,
      totalRows,
      skippedNoDate,
      skippedTransfer,
      message: `Imported ${totalRows} rows across ${writtenMonths.length} months`
    });
  } catch (error) {
    console.error('[TRANSACTIONS UPLOAD-YEARLY] Error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}

// Map a CSV row (keys = original column headers) to the flat
// `_v2024BlankRow` shape used by _buildStatement. Returns null for rows
// we want to drop entirely (Transfer = bank disbursement, not P&L).
//
// The CSV columns referenced here are the Amazon "Custom Unified
// Transaction Report" headers as of 2024 — see the file
// `2024data/2024Jan1-2024Dec31CustomUnifiedTransaction.csv` for the
// canonical example. Header keys are matched case-insensitively against
// a normalized alias map so future report variants still parse.
function _normalizeYearlyCsvRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const get = (...keys) => {
    for (const k of keys) {
      // Direct hit first (fast path for already-normalized payloads)
      if (raw[k] !== undefined) return raw[k];
    }
    // Case-insensitive fallback. The client may pass keys with any
    // casing depending on how XLSX parsed the header row.
    const lowerMap = _lowerKeyMap(raw);
    for (const k of keys) {
      const v = lowerMap[k.toLowerCase()];
      if (v !== undefined) return v;
    }
    return undefined;
  };

  // ISO date (YYYY-MM-DD). Client should pre-parse via parseAmazonDate
  // but accept the raw "Jan 1, 2024" form as fallback.
  let date = String(get('date/time', 'date') || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}/.test(date)) {
    const parsed = _parseAmazonDateServer(date);
    if (parsed) date = parsed;
  }
  date = date.slice(0, 10);

  const type = String(get('type') || '').trim();
  if (!type) return null;
  if (type === 'Transfer') return null; // disbursement, not P&L

  const orderId = String(get('order id') || '').trim();
  const sku = String(get('sku') || '').trim();
  const description = String(get('description') || '').trim();
  const fulfillmentRaw = String(get('fulfillment') || '').trim().toLowerCase();
  let fulfillment = '';
  if (fulfillmentRaw === 'amazon' || fulfillmentRaw === 'afn' || fulfillmentRaw === 'fba') fulfillment = 'FBA';
  else if (fulfillmentRaw === 'seller' || fulfillmentRaw === 'mfn' || fulfillmentRaw === 'fbm') fulfillment = 'FBM';

  const num = (k1, k2, k3) => {
    const v = get(k1, k2, k3);
    if (v === '' || v === null || v === undefined) return 0;
    const n = parseFloat(String(v).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const productSales        = num('product sales');
  const shippingCredits     = num('shipping credits');
  const giftwrapCredits     = num('gift wrap credits', 'giftwrap credits');
  const regulatoryFee       = num('Regulatory Fee', 'regulatory fee');
  const promoRebates        = num('promotional rebates');
  const sellingFees         = num('selling fees');
  const fbaFees             = num('fba fees');
  const otherTransactionFees= num('other transaction fees');
  const other               = num('other');
  const qty = parseInt(get('quantity') || '0', 10) || 0;

  // Build the row according to the rules _buildStatement applies — see
  // the section "Order routing" in overview-upstash.js for the canonical
  // bucket map. We're matching V2024_LEAF_HANDLER's flat bucket choices.
  const base = {
    type: '', orderId, date, sku, qty: 0,
    fulfillment,
    sale: 0, otherCharges: 0, fbaFees: 0, transactionFees: 0, promotions: 0,
    feeType: '', feeAmount: 0,
    adjustmentType: '', adjustmentAmount: 0,
    _src: 'v2024-imported', _transactionId: '', _transactionStatus: ''
  };

  if (type === 'Order' || type === 'Refund') {
    const isRefund = type === 'Refund';
    base.type = isRefund ? 'Refund' : 'Order';
    base.qty = qty * (isRefund ? -1 : 1);
    base.sale         = productSales;
    base.otherCharges = shippingCredits + giftwrapCredits;
    base.promotions   = promoRebates;
    // selling fees + other transaction fees + regulatory fee all land in
    // the Transaction Fees bucket in V2024_LEAF_HANDLER (Commission,
    // VariableClosingFee, FixedClosingFee, RefundCommission).
    base.transactionFees = sellingFees + otherTransactionFees + regulatoryFee;
    base.fbaFees      = fbaFees;
    return base;
  }

  if (type === 'Order_Retrocharge' || type === 'Retrocharge') {
    // Rare. The existing _buildStatement collapses Chargeback /
    // GuaranteeClaim / Retrocharge entirely into Other Expenses by
    // summing sale + otherCharges + fbaFees + transactionFees +
    // promotions. We mirror that input shape.
    base.type = 'Retrocharge';
    base.qty = qty;
    base.sale         = productSales;
    base.otherCharges = shippingCredits + giftwrapCredits;
    base.promotions   = promoRebates;
    base.transactionFees = sellingFees + otherTransactionFees + regulatoryFee;
    base.fbaFees      = fbaFees;
    return base;
  }

  // FBA Inventory Fee / Service Fee / Shipping Services / FBA Customer
  // Return Fee → ServiceFee, with the description as feeType so it
  // shows up in the editable unmapped-fee warning panel until the user
  // routes it. The fee amount is whatever non-zero column carries it;
  // sum of every monetary column except sales/credits/promos covers
  // every case I've seen in the 2024 sample.
  if (type === 'FBA Inventory Fee'      ||
      type === 'Service Fee'            ||
      type === 'Shipping Services'      ||
      type === 'FBA Customer Return Fee') {
    base.type = 'ServiceFee';
    base.feeType = description || type;
    base.feeAmount = sellingFees + fbaFees + otherTransactionFees + regulatoryFee + other;
    return base;
  }

  if (type === 'Adjustment' || type === 'FBA Inventory Reimbursement') {
    base.type = 'Adjustment';
    base.adjustmentType = description || type;
    base.adjustmentAmount = sellingFees + fbaFees + otherTransactionFees + regulatoryFee + other +
                            productSales + shippingCredits + giftwrapCredits + promoRebates;
    return base;
  }

  // Unknown type — drop. Surfaces in skippedTransfer count alongside
  // genuine Transfer drops; not worth a separate counter for now.
  return null;
}

function _lowerKeyMap(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

// Server-side fallback for parseAmazonDate. Mirrors the client helper
// in js/upload.js so the API still works if the client forgot to
// pre-normalize.
function _parseAmazonDateServer(s) {
  if (!s) return null;
  const m = String(s).match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                   jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const mm = months[m[1].toLowerCase().substring(0, 3)];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

function monthBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));
  return {
    start: startDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end:   endDate.toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
}

function previousMonthISO() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
