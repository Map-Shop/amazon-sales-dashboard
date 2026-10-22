import SellingPartner from 'amazon-sp-api';
import { kv } from '../lib/kv.js';
import * as ordersSql from '../lib/orders.js';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (action === 'get')                    return handleGet(req, res);
    if (action === 'get-v2')                 return handleGetV2(req, res);
    if (action === 'sync')                   return handleSync(req, res);
    if (action === 'get-summary')            return handleGetSummary(req, res);
    if (action === 'rebuild-summary')        return handleRebuildSummary(req, res);
    if (action === 'poll-flat-file-report')  return handlePollFlatFileReport(req, res);
    if (action === 'list-pending-reports')   return handleListPendingReports(req, res);
    if (action === 'cron-daily-request')     return handleCronDailyRequest(req, res);
    if (action === 'cron-collect')           return handleCronCollect(req, res);
    if (action === 'cron-data-check')        return handleCronDataCheck(req, res);
    if (action === 'get-alerts')             return handleGetAlerts(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'upload-orders-report')    return handleUploadOrdersReport(req, res);
    if (action === 'request-flat-file-report') return handleRequestFlatFileReport(req, res);
    if (action === 'delete-v2-months')        return handleDeleteV2Months(req, res);
    if (action === 'cron-daily-request')      return handleCronDailyRequest(req, res);
    if (action === 'dismiss-alert')           return handleDismissAlert(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ─────────────────────────────────────────────────────────────────────
// Returns stored orders from Upstash, optionally filtered by date range
async function handleGet(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });

    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const { startDate, endDate } = req.query;

    const index = await kv.get('orders:index') || [];
    if (index.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    let monthsToFetch = index;
    if (startDate && endDate) {
      const start = startDate.slice(0, 7);
      const end = endDate.slice(0, 7);
      monthsToFetch = index.filter(m => m >= start && m <= end);
    }

    const buckets = await Promise.all(monthsToFetch.map(m => kv.get(`orders:${m}`)));
    let orders = buckets.flat().filter(Boolean);

    if (startDate && endDate) {
      orders = orders.filter(o => o.orderDate >= startDate && o.orderDate <= endDate);
    }

    return res.status(200).json({ success: true, orders });

  } catch (error) {
    console.error('Error retrieving orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders: ' + error.message });
  }
}

// ─── SYNC ─────────────────────────────────────────────────────────────────────
// Two call patterns, chosen by query param:
//   ?date=YYYY-MM-DD           — fetch exactly that day (manual backfill)
//   ?days=N                    — fetch trailing N days [today-N .. yesterday]
//   neither                    — defaults to days=1 (yesterday only)
//
// `date` wins if both are present (explicit single-day overrides window). The
// daily cron now passes `&days=14` so each run re-fetches the last 2 weeks and
// catches SP-API order data that has settled since the original sync (Pending
// → Shipped transitions, returns, refunds). The dedup key in upsertOrdersToKV
// (`${orderId}:${sku}`) makes re-fetching idempotent — a re-fetched order
// just overwrites its previous record.
//
// The window also enables cancellation reconciliation: orders that were in KV
// for dates in the window but no longer come back from SP-API (because they
// were canceled) get evicted by upsertOrdersToKV. Without this, the trailing
// window would leave zombie canceled orders inflating revenue.
async function handleSync(req, res) {
  try {
    const dateParam = req.query.date || null;
    const daysParam = req.query.days || null;

    let windowStart;  // inclusive YYYY-MM-DD
    let windowEnd;    // inclusive YYYY-MM-DD

    if (dateParam) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      windowStart = dateParam;
      windowEnd = dateParam;
    } else {
      // Default 1 day (= yesterday). Clamp days to [1, 60] — anything
      // larger doesn't make sense for "trailing window" semantics and
      // risks pushing wall time toward the 300s function timeout.
      let n = parseInt(daysParam || '1', 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      if (n > 60) n = 60;

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - n);

      windowStart = start.toISOString().slice(0, 10);
      windowEnd = yesterday.toISOString().slice(0, 10);
    }

    console.log(`[ORDERS SYNC] Starting sync for ${windowStart} → ${windowEnd}`);

    const { lineItems, seenOrderIds } = await fetchOrdersForDateRange(windowStart, windowEnd);
    console.log(`[ORDERS SYNC] Captured ${lineItems.length} new line items across ${seenOrderIds.size} orders for ${windowStart} → ${windowEnd}`);

    await upsertOrdersToKV(lineItems, seenOrderIds, windowStart, windowEnd);

    // Rebuild summary cache in the background (fire and forget)
    rebuildSummaryCache().catch(e => console.warn('[SYNC] Summary rebuild failed:', e.message));

    return res.status(200).json({
      success: true,
      startDate: windowStart,
      endDate: windowEnd,
      // Preserve the legacy field shape for runOrdersBackfill (single-day
      // callers used to read `data.date` and `data.newRecords`). The new
      // `date` field aliases startDate when start==end.
      date: windowStart === windowEnd ? windowStart : undefined,
      newRecords: lineItems.length,
      ordersSeen: seenOrderIds.size,
      message: `Orders sync complete for ${windowStart} → ${windowEnd}`
    });

  } catch (error) {
    console.error('[ORDERS SYNC] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}


// ─── GET SUMMARY ─────────────────────────────────────────────────────────────
// Returns pre-aggregated monthly summary from cache. Fast single KV read.
async function handleGetSummary(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const summary = await kv.get('orders:monthly-summary');
    return res.status(200).json({ success: true, summary: summary || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get summary: ' + error.message });
  }
}

// ─── REBUILD SUMMARY ─────────────────────────────────────────────────────────
// Core logic extracted so it can be called from sync without auth overhead.
async function rebuildSummaryCache() {
  const index = await kv.get('orders:index') || [];
  const buckets = await Promise.all(index.map(m => kv.get(`orders:${m}`)));
  const allOrders = buckets.flat().filter(Boolean);

  const aggMap = {};
  for (const o of allOrders) {
    const key = `${o.orderDate.slice(0, 7)}|${o.sku}`;
    if (!aggMap[key]) aggMap[key] = { yearMonth: o.orderDate.slice(0, 7), sku: o.sku, revenue: 0, units: 0 };
    aggMap[key].revenue += o.itemTotal || 0;
    aggMap[key].units   += o.quantity  || 0;
  }

  const summary = Object.values(aggMap).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  await kv.set('orders:monthly-summary', summary);
  console.log(`[SUMMARY] Rebuilt: ${summary.length} SKU-month records from ${allOrders.length} orders`);
  return summary;
}

// HTTP handler — auth-gated, calls rebuildSummaryCache()
async function handleRebuildSummary(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const summary = await rebuildSummaryCache();
    return res.status(200).json({ success: true, records: summary.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to rebuild summary: ' + error.message });
  }
}

// ─── GET-V2 ──────────────────────────────────────────────────────────────────
// Same shape as handleGet but reads from the orders:v2:* keyspace (data
// ingested from Amazon's flat-file "All Orders" report via
// handleUploadOrdersReport). Sales & Volume flips its fetch URL to this
// action to consume the reconciled report data instead of the fragile
// getOrders/getOrderItems cron output. Old handleGet stays intact for
// rollback.
async function handleGetV2(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });

    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const { startDate, endDate } = req.query;

    if (ordersSql.ordersInSql()) {
      const orders = (startDate && endDate)
        ? await ordersSql.getOrders({ startDate, endDate })
        : await ordersSql.getOrders();
      return res.status(200).json({ success: true, orders });
    }

    const index = await kv.get('orders:v2:index') || [];
    if (index.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    let monthsToFetch = index;
    if (startDate && endDate) {
      const start = startDate.slice(0, 7);
      const end = endDate.slice(0, 7);
      monthsToFetch = index.filter(m => m >= start && m <= end);
    }

    const buckets = await Promise.all(monthsToFetch.map(m => kv.get(`orders:v2:${m}`)));
    let orders = buckets.flat().filter(Boolean);

    if (startDate && endDate) {
      orders = orders.filter(o => o.orderDate >= startDate && o.orderDate <= endDate);
    }

    return res.status(200).json({ success: true, orders });

  } catch (error) {
    console.error('Error retrieving v2 orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders: ' + error.message });
  }
}

// ─── UPLOAD ORDERS REPORT (Amazon flat-file "All Orders" report) ────────────
//
// Client-parsed Amazon flat-file `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_
// DATE_GENERAL` posted as JSON rows. Normalizes each row to the same shape
// the existing Sales & Volume code already consumes (orderDate / sku /
// asin / quantity / itemTotal / fulfillmentChannel), so no downstream
// changes are needed once we swap the read to handleGetV2.
//
// Why this exists: the getOrders + getOrderItems path we've been running
// on a daily cron systematically undercounts revenue (Pending orders with
// $0 item prices get locked in by skip-already-captured; business-buyer
// discounts and various edge cases don't round-trip cleanly). The flat
// file contains Amazon's actual transacted line-item amounts as they
// appear in Seller Central — matches Sales & Traffic by construction.
//
// Idempotency: refuses to overwrite an existing month's bucket unless
// `?overwrite=true` is passed. Prevents accidental data loss on re-upload.
//
// Body: { rows: [{ 'amazon-order-id', 'purchase-date', 'sku', 'asin',
// 'quantity', 'item-price', 'fulfillment-channel', 'item-status',
// 'is-business-order' }, ...] }
// Case-tolerant on keys (matches the transactions uploader pattern).
async function handleUploadOrdersReport(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rawRows) return res.status(400).json({ error: 'rows array required in body' });

    const overwrite = req.query.overwrite === 'true';
    const result = await _normalizeAndWriteOrdersMonth(rawRows, { overwrite });

    if (result.collision) {
      return res.status(409).json({
        error: `Months already have data: ${result.collidingMonths.join(', ')}. Re-upload with ?overwrite=true to replace.`,
        collidingMonths: result.collidingMonths
      });
    }

    return res.status(200).json({
      success: true,
      writtenMonths: result.writtenMonths,
      totalRows: result.totalRows,
      skippedCancelled: result.skippedCancelled,
      skippedNoDate: result.skippedNoDate,
      skippedNoOrder: result.skippedNoOrder,
      message: result.writtenMonths.length === 0
        ? 'No valid rows found in the upload'
        : `Uploaded ${result.totalRows} line items across ${result.writtenMonths.length} month${result.writtenMonths.length === 1 ? '' : 's'}${result.skippedCancelled ? `, skipped ${result.skippedCancelled} cancelled` : ''}.`
    });
  } catch (error) {
    console.error('[ORDERS UPLOAD-REPORT] Error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}

// Shared ingestion helper — used by both the manual upload path
// (handleUploadOrdersReport) and the SP-API pull path
// (handlePollFlatFileReport). Takes raw flat-file report rows (case-
// tolerant keys) and does: drop-cancelled → normalize per-row → group
// by month → refuse-if-exists guard → write per-month buckets → update
// index.
//
// Returns:
//   {
//     collision: false, writtenMonths: [...], totalRows, skippedCancelled,
//     skippedNoDate, skippedNoOrder
//   }
// OR, when overwrite is false and any target month already has data:
//   { collision: true, collidingMonths: [...] }
//
// Options:
//   overwrite: boolean — if true, skip the collision guard entirely
//
// Both call sites want to render slightly different response shapes on
// top of this, so this helper only returns the aggregates. The caller
// wraps them into an HTTP response.
async function _normalizeAndWriteOrdersMonth(rawRows, { overwrite = false } = {}) {
  const { byMonth, skippedCancelled, skippedNoDate, skippedNoOrder,
          rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount,
          rawRowCount } =
    _normalizeReportRows(rawRows);

  const monthsToWrite = Object.keys(byMonth).sort();
  if (monthsToWrite.length === 0) {
    return {
      collision: false,
      writtenMonths: [], totalRows: 0, rawRowCount,
      skippedCancelled, skippedNoDate, skippedNoOrder,
      rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount
    };
  }

  // Refuse to overwrite months that already have data unless the
  // caller explicitly passes overwrite=true. Protects against
  // accidental data loss on re-upload / re-pull.
  if (!overwrite) {
    const collisions = [];
    if (ordersSql.ordersInSql()) {
      collisions.push(...await ordersSql.monthsWithData(monthsToWrite));
    } else {
      for (const m of monthsToWrite) {
        const existing = await kv.get(`orders:v2:${m}`);
        if (Array.isArray(existing) && existing.length > 0) collisions.push(m);
      }
    }
    if (collisions.length > 0) {
      return { collision: true, collidingMonths: collisions };
    }
  }

  if (ordersSql.ordersInSql()) {
    await ordersSql.replaceMonths(byMonth);
    return {
      collision: false,
      writtenMonths: monthsToWrite,
      totalRows: monthsToWrite.reduce((n, m) => n + byMonth[m].length, 0),
      rawRowCount, skippedCancelled, skippedNoDate, skippedNoOrder,
      rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount
    };
  }

  // Write per-month buckets, then update the index. Data-first-then-
  // pointer order so a partial failure doesn't leave dangling index
  // entries pointing at empty keys.
  let totalRows = 0;
  for (const m of monthsToWrite) {
    const rows = byMonth[m].sort((a, b) => a.orderDate.localeCompare(b.orderDate));
    await kv.set(`orders:v2:${m}`, rows);
    totalRows += rows.length;
  }
  const existingIndex = (await kv.get('orders:v2:index')) || [];
  const mergedIndex = [...new Set([...existingIndex, ...monthsToWrite])].sort();
  await kv.set('orders:v2:index', mergedIndex);

  return {
    collision: false,
    writtenMonths: monthsToWrite, totalRows, rawRowCount,
    skippedCancelled, skippedNoDate, skippedNoOrder,
    rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount
  };
}

// Merge-mode ingestion — used by the Phase 3 cron-collect path when
// pulling a single day's data. Unlike _normalizeAndWriteOrdersMonth
// (which replaces the entire target month bucket), this READ-modifies-
// WRITEs: reads existing rows, merges the new rows in, dedupes by
// ${orderId}:${sku} (new rows win on conflict), writes back. Safe to
// re-run — same day twice just re-overwrites the same rows.
//
// Never returns a collision result — merges by definition don't collide.
// options.updateOnly: for BY_LAST_UPDATE reports — apply rows only to
// orders ALREADY stored (refresh values, delete cancelled) and never
// insert. An update report's rows include orders the user never chose
// to load (anything merely touched during the window), so inserting
// them would seed months with partial data and collide with later
// whole-month replaces. New orders enter exclusively via BY_ORDER_DATE.
async function _mergeOrdersDay(rawRows, { updateOnly = false } = {}) {
  const { byMonth, cancelledKeys, skippedCancelled, skippedNoDate, skippedNoOrder,
          rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount,
          rawRowCount } =
    _normalizeReportRows(rawRows);

  // Cancelled identities grouped by their PURCHASE month — that's where
  // the previously-imported copy lives, regardless of when the
  // cancellation happened.
  const cancelledByMonth = {};
  for (const c of cancelledKeys) {
    if (!cancelledByMonth[c.month]) cancelledByMonth[c.month] = [];
    cancelledByMonth[c.month].push(`${c.orderId}:${c.sku}`);
  }

  const monthsToWrite = [...new Set([
    ...Object.keys(byMonth),
    ...Object.keys(cancelledByMonth)
  ])].sort();
  if (monthsToWrite.length === 0) {
    return {
      collision: false,
      writtenMonths: [], totalRows: 0, removedCancelled: 0, rawRowCount,
      skippedCancelled, skippedNoDate, skippedNoOrder,
      rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount
    };
  }

  if (ordersSql.ordersInSql()) {
    // Same order of operations as the kv path below: apply the report's
    // lines (refresh-only in update mode), then delete cancellations.
    const rows = monthsToWrite.flatMap(m => byMonth[m] || []);
    let applied;
    if (updateOnly) {
      applied = await ordersSql.updateExistingOrders(rows);
    } else {
      await ordersSql.upsertOrders(rows);
      applied = rows.length;
    }
    const removed = await ordersSql.deleteOrderKeys(cancelledKeys);
    return {
      collision: false,
      writtenMonths: monthsToWrite, totalRows: applied, removedCancelled: removed, rawRowCount,
      skippedCancelled, skippedNoDate, skippedNoOrder,
      rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount
    };
  }

  let totalRows = 0;
  let removedCancelled = 0;
  for (const m of monthsToWrite) {
    const existing = (await kv.get(`orders:v2:${m}`)) || [];
    // Nothing stored for this month → an update-only pass has nothing
    // to touch. Skipping avoids creating partial month buckets.
    if (updateOnly && existing.length === 0) continue;
    // Dedupe map keyed by orderId+sku. Existing rows loaded first, then
    // new rows overwrite matches — new rows win on conflict, matching
    // the semantic "the freshest report is authoritative for the rows
    // it covers." Rows the new report doesn't touch (e.g., other days
    // in the same month) stay intact.
    const dedup = new Map();
    for (const r of existing) if (r && r.orderId) dedup.set(`${r.orderId}:${r.sku}`, r);
    let changed = false;
    for (const r of (byMonth[m] || [])) {
      const key = `${r.orderId}:${r.sku}`;
      if (updateOnly && !dedup.has(key)) continue; // update-only never inserts
      dedup.set(key, r);
      changed = true;
      totalRows++; // rows actually applied (all of them in normal merge)
    }
    // Cancellation-aware: rows the fresh report marks Cancelled are
    // deleted. Amazon blanks a cancelled row's value rather than keeping
    // it, so deletion — not a negative adjustment — is what makes stored
    // data re-verifiable against a fresh report at every slice.
    for (const key of (cancelledByMonth[m] || [])) {
      if (dedup.delete(key)) { removedCancelled++; changed = true; }
    }
    if (!updateOnly || changed) {
      const merged = [...dedup.values()].sort((a, b) => a.orderDate.localeCompare(b.orderDate));
      await kv.set(`orders:v2:${m}`, merged);
    }
  }
  // Update-only passes never introduce months, so the index is only
  // maintained for normal merges.
  if (!updateOnly) {
    const existingIndex = (await kv.get('orders:v2:index')) || [];
    const mergedIndex = [...new Set([...existingIndex, ...monthsToWrite])].sort();
    if (mergedIndex.length !== existingIndex.length) {
      await kv.set('orders:v2:index', mergedIndex);
    }
  }

  return {
    collision: false,
    writtenMonths: monthsToWrite, totalRows, removedCancelled, rawRowCount,
    skippedCancelled, skippedNoDate, skippedNoOrder,
    rowsWithItemTotal, rowsWithQuantity, ingestedOrders, ingestedRevenue, keptRowCount
  };
}

// Columns _normalizeReportRows depends on, as alternate-name groups
// (mirroring its pick() calls). The header check passes if at least one
// name in each group is present, case-insensitive.
const REQUIRED_REPORT_COLUMNS = [
  ['item-status', 'itemStatus'],
  ['purchase-date', 'purchaseDate'],
  ['amazon-order-id', 'amazonOrderId', 'orderId'],
  ['sku'],
  ['asin'],
  ['quantity'],
  ['item-price', 'itemPrice'],
  ['fulfillment-channel', 'fulfillmentChannel'],
  ['is-business-order', 'isBusinessOrder']
];

// Integrity check: validate the raw TSV header line before ingesting.
// Amazon renaming or dropping a column doesn't crash the parser — it
// silently produces rows with empty fields — so bad reports must be
// refused at the door with a precise diagnosis. An entirely empty body
// (no header at all) passes: that's the "no data in range" case the
// zero-row handling downstream already covers.
function _validateReportHeader(text) {
  const raw = String(text || '');
  if (raw.trim() === '') return { ok: true, missing: [] };
  const firstLine = raw.split(/\r?\n/, 1)[0] || '';
  const present = new Set(firstLine.split('\t').map(h => h.trim().toLowerCase()).filter(Boolean));
  const missing = REQUIRED_REPORT_COLUMNS
    .filter(group => !group.some(name => present.has(name.toLowerCase())))
    .map(group => group[0]);
  return { ok: missing.length === 0, missing };
}

// Shared row-normalization used by both _normalizeAndWriteOrdersMonth
// (replace mode) and _mergeOrdersDay (merge mode). Takes raw flat-file
// rows (case-tolerant keys), drops cancelled, extracts our canonical
// per-row shape, groups by YYYY-MM. Pure — no KV I/O.
function _normalizeReportRows(rawRows) {
  const pick = (obj, ...keys) => {
    for (const k of keys) if (obj[k] !== undefined) return obj[k];
    const lower = {};
    for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const byMonth = {};
  // Identities of rows the report marks Cancelled — merge mode uses
  // these to DELETE previously-imported copies (order cancelled after
  // we ingested it as valid). Amazon blanks a cancelled row's value in
  // fresh reports, so removal is what converges us to Amazon's truth.
  const cancelledKeys = [];
  let skippedCancelled = 0;
  let skippedNoDate = 0;
  let skippedNoOrder = 0;
  // Field-population counters over kept rows — near-100% normally, so a
  // crater in either means the report's value format changed shape.
  let rowsWithItemTotal = 0;
  let rowsWithQuantity = 0;
  // "Last sync" summary inputs — distinct orders and revenue ingested.
  const orderIdSet = new Set();
  let ingestedRevenue = 0;
  let keptRowCount = 0;
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;

    // Bucket by the PACIFIC calendar date of the purchase timestamp —
    // that's the day convention every Seller Central surface uses, so
    // it's what makes our totals reconcile with Amazon's. A bare
    // YYYY-MM-DD (no time component) is taken as-is.
    const orderDateRaw = String(pick(r, 'purchase-date', 'purchaseDate') || '').trim();
    const orderDate = /^\d{4}-\d{2}-\d{2}$/.test(orderDateRaw)
      ? orderDateRaw
      : _ptDate(orderDateRaw);
    const orderId = String(pick(r, 'amazon-order-id', 'amazonOrderId', 'orderId') || '').trim();
    const sku = String(pick(r, 'sku') || '').trim();

    const status = String(pick(r, 'item-status', 'itemStatus') || '').trim();
    if (status === 'Cancelled' || status === 'Canceled') {
      skippedCancelled++;
      if (/^\d{4}-\d{2}-\d{2}$/.test(orderDate) && orderId) {
        cancelledKeys.push({ month: orderDate.slice(0, 7), orderId, sku });
      }
      continue;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) { skippedNoDate++; continue; }
    if (!orderId) { skippedNoOrder++; continue; }

    const asin = String(pick(r, 'asin') || '').trim();
    const qtyRaw = pick(r, 'quantity');
    const quantity = parseInt(String(qtyRaw ?? '0').replace(/[,]/g, ''), 10) || 0;

    const priceRaw = pick(r, 'item-price', 'itemPrice');
    const itemTotal = parseFloat(String(priceRaw ?? '0').replace(/[$,]/g, '')) || 0;

    const fulfillmentChannel = String(pick(r, 'fulfillment-channel', 'fulfillmentChannel') || '').trim();

    const isBusinessRaw = pick(r, 'is-business-order', 'isBusinessOrder');
    const isBusinessOrder = isBusinessRaw === true ||
                            isBusinessRaw === 'true' ||
                            isBusinessRaw === 'True' ||
                            isBusinessRaw === 'TRUE' ||
                            isBusinessRaw === 1 ||
                            isBusinessRaw === '1';

    if (itemTotal > 0) rowsWithItemTotal++;
    if (quantity > 0) rowsWithQuantity++;
    orderIdSet.add(orderId);
    ingestedRevenue += itemTotal;
    keptRowCount++;

    const month = orderDate.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push({
      orderDate, orderId, sku, asin, quantity,
      itemTotal, fulfillmentChannel, isBusinessOrder
    });
  }

  return {
    byMonth,
    cancelledKeys,
    skippedCancelled,
    skippedNoDate,
    skippedNoOrder,
    rowsWithItemTotal,
    rowsWithQuantity,
    ingestedOrders: orderIdSet.size,
    ingestedRevenue,
    keptRowCount,
    rawRowCount: rawRows.length
  };
}

// ─── REQUEST FLAT-FILE REPORT (SP-API createReport) ─────────────────────────
//
// Kicks off Amazon's report generation for
// GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL scoped to a single
// month (the report type accepts up to 30 days per request; a calendar
// month always fits). Reports take minutes to hours on Amazon's side —
// this endpoint returns immediately with a reportId and the client (or
// a cron) polls poll-flat-file-report later to check status and
// download when ready.
//
// The reportId is stashed in KV key `orders:v2:pending-reports` (an
// array of { reportId, month, requestedAt, name, merge? }). Same
// pending-queue pattern as api/adspend.js.
//
// Body, one of:
//   { month: 'YYYY-MM' } — whole-month pull (Pull UI). Collected with
//     whole-month replace semantics (collision-guarded).
//   { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } — arbitrary inclusive
//     range (Sales & Volume backfill card). ≤31 days per report; end is
//     clamped to yesterday UTC since data is only complete through
//     yesterday. Queue entry is stamped merge:true so whichever
//     collector picks it up merges into existing month buckets instead
//     of replacing them — ranges can be partial months.
async function handleRequestFlatFileReport(req, res) {
  // resultKey declared outside the try so the catch can record a
  // per-request failure to lastResults (surfaces in the UI status panel).
  let resultKey;
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const { month, start, end } = req.body || {};
    let tag, dataStartTime, dataEndTime;
    let merge = false;
    let clamped = false;
    let effectiveEnd;

    if (start || end) {
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRe.test(start || '') || !dateRe.test(end || '')) {
        return res.status(400).json({ error: 'start and end must both be YYYY-MM-DD' });
      }
      if (start > end) {
        return res.status(400).json({ error: 'start must be on or before end' });
      }
      const yesterday = _yesterdayPT();
      effectiveEnd = end > yesterday ? yesterday : end;
      clamped = effectiveEnd !== end;
      if (start > effectiveEnd) {
        return res.status(400).json({ error: `Range is entirely in the future — data exists through ${yesterday} (Pacific) only.` });
      }
      const spanDays = (Date.parse(effectiveEnd) - Date.parse(start)) / 86400000 + 1;
      if (spanDays > 31) {
        return res.status(400).json({ error: 'Range too long for one report — 31 days max per request.' });
      }
      tag = start === effectiveEnd ? start : `${start}..${effectiveEnd}`;
      ({ dataStartTime, dataEndTime } = _ptRangeBoundsUtc(start, effectiveEnd));
      merge = true;
    } else {
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month=YYYY-MM (or start/end=YYYY-MM-DD) required in body' });
      }
      // Pacific calendar-month bounds — matches how Seller Central (and
      // the humans reading it) define a month.
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      ({ dataStartTime, dataEndTime } = _ptRangeBoundsUtc(`${month}-01`, `${month}-${String(lastDay).padStart(2, '0')}`));
      tag = month;
    }
    resultKey = tag;
    const updTag = `upd:${tag}`;

    // Every pull requests BOTH reports so all paths behave identically
    // (daily cron, month pull, range backfill): BY_ORDER_DATE loads the
    // window's orders; BY_LAST_UPDATE applies every change that
    // happened DURING the window (cancellation deletes, pending-price
    // refreshes) to orders wherever they live — including other months.
    // The update report is always merge-mode: its rows span many months
    // and must never whole-month-replace.
    const orderReport = await _requestReportForMonth({
      tag,
      name: `AllOrders ${tag}`,
      dataStartTime,
      dataEndTime,
      merge
    });

    resultKey = updTag;
    const updateReport = await _requestReportForMonth({
      tag: updTag,
      name: `AllOrdersByUpdate ${tag}`,
      dataStartTime,
      dataEndTime,
      merge: true,
      updateOnly: true,
      dependsOn: tag,
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL'
    });
    resultKey = tag;

    // Clear stale lastResults entries for freshly-queued tags — a
    // previous failure shouldn't linger in the UI now that we've
    // successfully re-queued.
    const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};
    let lrDirty = false;
    if (!orderReport.alreadyPending && lastResults[tag]) { delete lastResults[tag]; lrDirty = true; }
    if (!updateReport.alreadyPending && lastResults[updTag]) { delete lastResults[updTag]; lrDirty = true; }
    if (lrDirty) await kv.set('orders:v2:report-lastresult', lastResults);

    return res.status(200).json({
      success: true,
      reportId: orderReport.reportId,
      tag,
      month: tag,
      tags: [tag, updTag],
      reports: [
        { tag, reportId: orderReport.reportId, alreadyPending: orderReport.alreadyPending },
        { tag: updTag, reportId: updateReport.reportId, alreadyPending: updateReport.alreadyPending }
      ],
      ...(clamped ? { clamped: true, effectiveEnd } : {}),
      alreadyPending: orderReport.alreadyPending,
      ...(orderReport.alreadyPending
        ? { message: `Report for ${tag} already pending since ${orderReport.requestedAt}` }
        : {})
    });
  } catch (error) {
    const errorMsg = _extractSpApiErrorMessage(error);
    console.error('[ORDERS REQUEST-REPORT] Error:', errorMsg);

    // Persist request-time failures to lastResults so the status panel
    // can render them.
    if (resultKey) {
      try {
        const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};
        lastResults[resultKey] = {
          status: 'FAILED',
          error: errorMsg,
          completedAt: new Date().toISOString(),
          phase: 'request'
        };
        await kv.set('orders:v2:report-lastresult', lastResults);
      } catch { /* best-effort */ }
    }

    return res.status(500).json({ error: 'Request failed: ' + errorMsg, month: resultKey });
  }
}

// Shared request-side helper. Callable from both the user-facing
// handleRequestFlatFileReport (Phase 2 Pull UI, per-month) and the
// Phase 3 cron actions (per-day). Returns:
//   { reportId, tag, alreadyPending, requestedAt? }
// Throws on any SP-API error the caller should treat as failure.
//
// The `tag` is a string identifier stored in the pending queue as
// `p.month`. Phase 2 uses "2026-07" (month); Phase 3 cron uses
// "2026-07-13" (date). Same field, different granularity — the poll
// path treats it as an opaque string.
async function _requestReportForMonth({ tag, name, dataStartTime, dataEndTime, merge = false,
                                        updateOnly = false, dependsOn = null,
                                        reportType = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' }) {
  // If a report with this tag is already pending, reuse rather than
  // firing a duplicate at Amazon.
  const pending = (await kv.get('orders:v2:pending-reports')) || [];
  const existing = pending.find(p => p.month === tag);
  if (existing) {
    return {
      reportId: existing.reportId,
      tag,
      alreadyPending: true,
      requestedAt: existing.requestedAt
    };
  }

  const sp = createSellingPartner();
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

  let reportId;
  try {
    const response = await sp.callAPI({
      operation: 'createReport',
      endpoint: 'reports',
      body: {
        reportType,
        marketplaceIds: [marketplaceId],
        dataStartTime,
        dataEndTime
      }
    });
    reportId = response.reportId;
  } catch (err) {
    // SP-API 425 (Duplicate) — reuse the existing reportId from the
    // errors array if we can extract it.
    const isDuplicate = err?.statusCode === 425 ||
                        /duplicate|already.+request/i.test(err?.message || '');
    if (isDuplicate) {
      const errBody = err?.response?.data || err?.body || {};
      const errArr = Array.isArray(errBody?.errors) ? errBody.errors : [];
      const numMatch = (s) => (typeof s === 'string' && s.match(/[0-9]{12,}/)) ? s.match(/[0-9]{12,}/)[0] : null;
      const dupId = errArr.map(e => numMatch(e.details) || numMatch(e.message)).find(Boolean);
      if (dupId) {
        reportId = dupId;
      } else {
        throw new Error(`SP-API 425 duplicate but no reportId extractable: ${JSON.stringify(errBody).slice(0, 300)}`);
      }
    } else {
      throw err;
    }
  }

  // Ingestion semantics ride along on the queue entry so the COLLECTOR
  // (not the poll caller) applies them, no matter which path drains the
  // queue: merge for partial-range reports, updateOnly for
  // BY_LAST_UPDATE reports, dependsOn to hold an update report back
  // until its paired order-date report has been ingested.
  const updated = [...pending, {
    reportId,
    month: tag,
    requestedAt: new Date().toISOString(),
    name,
    ...(merge ? { merge: true } : {}),
    ...(updateOnly ? { updateOnly: true } : {}),
    ...(dependsOn ? { dependsOn } : {})
  }];
  await kv.set('orders:v2:pending-reports', updated);

  return { reportId, tag, alreadyPending: false };
}

// SP-API errors from the amazon-sp-api npm package come in a few shapes
// depending on version. This walker pulls the user-facing message from
// wherever it lives. Prefers structured errors[] over raw .message so
// we get e.g. "InvalidInput: dataStartTime must be within the last 2
// years" instead of the wrapper's opaque "Request failed" string.
function _extractSpApiErrorMessage(err) {
  if (!err) return 'Unknown error';
  const body = err?.response?.data || err?.body || err?.data;
  if (body?.errors && Array.isArray(body.errors) && body.errors.length > 0) {
    return body.errors.map(e => {
      const code = e.code ? `${e.code}: ` : '';
      const msg = e.message || e.details || '';
      return `${code}${msg}`.trim();
    }).filter(Boolean).join('; ');
  }
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

// ─── POLL FLAT-FILE REPORT (SP-API getReport + getReportDocument) ───────────
//
// Walks the pending queue (`orders:v2:pending-reports`), processes up
// to 5 entries per call to stay well within the 300s Vercel function
// timeout. For each entry: calls getReport to check status. If DONE,
// pulls the download URL via getReportDocument, fetches + gunzips the
// TSV, parses it, runs the shared normalization helper, writes to
// `orders:v2:${month}`. Removes DONE and FAILED entries from the
// queue; leaves IN_QUEUE / IN_PROGRESS entries for the next poll.
//
// Query params: `overwrite=true` (optional) — pass through to the
// normalization helper's overwrite behavior. Default false.
//
// Returns { success, collected, stillPending, failed, remaining }.
async function handlePollFlatFileReport(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const overwrite = req.query.overwrite === 'true';
    const result = await _pollPendingReports({ overwrite, mergeMode: false });

    return res.status(200).json({
      success: true,
      collected: result.collected,
      stillPending: result.stillPending,
      failed: result.failed,
      remaining: result.remaining
    });
  } catch (error) {
    console.error('[ORDERS POLL-REPORT] Error:', error);
    return res.status(500).json({ error: 'Poll failed: ' + error.message });
  }
}

// Shared collect-side helper. Callable from both the user-facing
// handlePollFlatFileReport (Phase 2 Pull UI) and the Phase 3 cron-collect
// action. Processes up to 5 pending reports per call to stay well within
// the 300s Vercel timeout — subsequent calls drain the tail.
//
// Options:
//   overwrite: passed to _normalizeAndWriteOrdersMonth. Ignored in merge mode.
//   mergeMode: if true, use _mergeOrdersDay (append into existing month
//     bucket, dedupe by orderId+sku). If false, use
//     _normalizeAndWriteOrdersMonth (whole-month replace with collision
//     guard). Phase 3 cron uses mergeMode=true because it fetches single
//     days that should stack into the current month's data rather than
//     replacing it.
//
// Returns { collected, stillPending, failed, remaining }.
async function _pollPendingReports({ overwrite = false, mergeMode = false } = {}) {
  const pending = (await kv.get('orders:v2:pending-reports')) || [];
  if (pending.length === 0) {
    return { collected: [], stillPending: [], failed: [], remaining: 0 };
  }

  const sp = createSellingPartner();
  const MAX_PER_CALL = 5;
  const toProcess = pending.slice(0, MAX_PER_CALL);
  const untouchedTail = pending.slice(MAX_PER_CALL);

  const collected = [];
  const failed = [];
  const stillPending = [];
  const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};

  for (const p of toProcess) {
    // Ordering guarantee: an update (BY_LAST_UPDATE) report never
    // ingests before its paired order-date report. If the pair was in
    // the queue when this poll started and hasn't been ingested yet
    // (still generating, deferred, or queued behind us), hold this
    // entry for a later pass. Once the pair leaves the queue —
    // collected or failed — the update proceeds.
    const dep = p.dependsOn || (String(p.month || '').startsWith('upd:') ? String(p.month).slice(4) : null);
    if (dep) {
      const depIngested = collected.some(c => c.month === dep) || failed.some(f => f.month === dep);
      const depInQueue = pending.some(x => x.month === dep);
      if (depInQueue && !depIngested) {
        stillPending.push(p);
        continue;
      }
    }

    try {
      const statusResp = await sp.callAPI({
        operation: 'getReport',
        endpoint: 'reports',
        path: { reportId: p.reportId }
      });
      const status = statusResp.processingStatus;

      if (status === 'DONE') {
        const docId = statusResp.reportDocumentId;
        const doc = await sp.callAPI({
          operation: 'getReportDocument',
          endpoint: 'reports',
          path: { reportDocumentId: docId }
        });
        const dlResp = await fetch(doc.url);
        if (!dlResp.ok) throw new Error(`Report download failed (${dlResp.status})`);
        const buf = Buffer.from(await dlResp.arrayBuffer());
        const { gunzipSync } = await import('zlib');
        const text = doc.compressionAlgorithm === 'GZIP'
          ? gunzipSync(buf).toString('utf-8')
          : buf.toString('utf-8');

        // Integrity check 1: refuse reports whose header row is missing
        // required columns — ingesting one would store rows with
        // silently-empty fields. `alerted: true` tells cron-collect not
        // to double-alert this entry as a generic collect-failure.
        const header = _validateReportHeader(text);
        if (!header.ok) {
          const headerErr = `missing required column(s): ${header.missing.join(', ')} — Amazon may have changed the report format`;
          failed.push({
            reportId: p.reportId,
            month: p.month,
            status: 'BAD_HEADER',
            error: `Ingest refused — ${headerErr}`,
            alerted: true
          });
          lastResults[p.month] = {
            status: 'FAILED',
            error: `Ingest refused — ${headerErr}`,
            completedAt: new Date().toISOString()
          };
          await _addAlert({
            id: `import-integrity:${p.month}`,
            severity: 'error',
            category: 'import-integrity',
            message: `Import refused for ${p.month}: ${headerErr}.`,
            details: { reportId: p.reportId, missing: header.missing }
          });
          continue;
        }

        const rows = _parseTsv(text);
        // Per-entry ingestion semantics (stamped at request time) win
        // over the caller's default — a partial report must never
        // whole-month-replace, and a BY_LAST_UPDATE report only
        // updates/deletes rows already stored, never inserts.
        const updateOnly = p.updateOnly === true || String(p.month || '').startsWith('upd:');
        const result = (mergeMode || p.merge === true || updateOnly)
          ? await _mergeOrdersDay(rows, { updateOnly })
          : await _normalizeAndWriteOrdersMonth(rows, { overwrite });

        if (result.collision) {
          failed.push({
            reportId: p.reportId,
            month: p.month,
            status: 'COLLISION',
            error: `Month ${p.month} already has data. Re-run with overwrite=true to replace.`
          });
          lastResults[p.month] = {
            status: 'FAILED',
            error: 'Refused to overwrite existing month',
            completedAt: new Date().toISOString()
          };
        } else {
          collected.push({
            reportId: p.reportId,
            month: p.month,
            status: 'DONE',
            rowCount: result.totalRows,
            rawRowCount: result.rawRowCount,
            skippedCancelled: result.skippedCancelled,
            removedCancelled: result.removedCancelled || 0,
            orders: result.ingestedOrders || 0,
            revenue: result.ingestedRevenue || 0
          });
          lastResults[p.month] = {
            status: 'DONE',
            rowCount: result.totalRows,
            rawRowCount: result.rawRowCount,
            skippedCancelled: result.skippedCancelled,
            skippedNoDate: result.skippedNoDate,
            skippedNoOrder: result.skippedNoOrder,
            removedCancelled: result.removedCancelled || 0,
            completedAt: new Date().toISOString()
          };

          // Integrity checks 2+3: rows landed, but did they parse into
          // sense? An abnormal skip rate or mostly-empty critical fields
          // mean the report's values changed shape even though the
          // header looked right. Row floors keep tiny ranges from
          // tripping the percentages on a single odd row.
          const parseSkips = (result.skippedNoDate || 0) + (result.skippedNoOrder || 0);
          const problems = [];
          if (result.rawRowCount >= 20 && parseSkips / result.rawRowCount > 0.05) {
            problems.push(`${parseSkips} of ${result.rawRowCount} raw rows were unparseable (missing date or order id)`);
          }
          // Population checks run over the report's kept rows (not rows
          // applied — update-only ingests apply a subset).
          const kept = (result.keptRowCount != null) ? result.keptRowCount : result.totalRows;
          if (kept >= 20) {
            if (result.rowsWithItemTotal / kept < 0.5) {
              problems.push(`only ${result.rowsWithItemTotal} of ${kept} rows have a sale amount — the price format may have changed`);
            }
            if (result.rowsWithQuantity / kept < 0.9) {
              problems.push(`only ${result.rowsWithQuantity} of ${kept} rows have a quantity`);
            }
          }
          if (problems.length > 0) {
            await _addAlert({
              id: `import-integrity:${p.month}`,
              severity: 'error',
              category: 'import-integrity',
              message: `Import for ${p.month} looks corrupted: ${problems.join('; ')}.`,
              details: { reportId: p.reportId }
            });
          } else {
            // Self-heal: a clean import of this range clears any earlier
            // integrity alert for it.
            await _resolveAlert(`import-integrity:${p.month}`);
          }
        }
      } else if (status === 'CANCELLED' || status === 'FATAL') {
        failed.push({
          reportId: p.reportId,
          month: p.month,
          status,
          error: `Amazon returned processingStatus=${status}`
        });
        lastResults[p.month] = {
          status: 'FAILED',
          error: `Amazon returned processingStatus=${status}`,
          completedAt: new Date().toISOString()
        };
      } else {
        // IN_QUEUE / IN_PROGRESS — keep waiting.
        stillPending.push({ ...p, currentStatus: status });
      }
    } catch (err) {
      console.error(`[ORDERS POLL] Error processing reportId ${p.reportId}:`, err);
      // Don't drop on transient errors — leave in queue with the last
      // error recorded so a subsequent poll retries.
      stillPending.push({ ...p, lastError: err.message });
    }
  }

  // Reconstruct queue: newly stillPending (from processed batch) +
  // untouched tail. Collected and failed are removed.
  const nextQueue = [...stillPending, ...untouchedTail];
  await kv.set('orders:v2:pending-reports', nextQueue);
  await kv.set('orders:v2:report-lastresult', lastResults);

  // "Last sync" summary for the dashboard blurb: the PT date range the
  // just-collected order-date reports covered and what they loaded.
  // upd:* (BY_LAST_UPDATE) reports are excluded — they refresh/delete
  // existing rows rather than load a range of new orders.
  const loaded = collected
    .map(c => ({ c, range: _tagDateRange(c.month) }))
    .filter(x => x.range);
  if (loaded.length > 0) {
    await _touchHeartbeat({
      lastSync: {
        at: new Date().toISOString(),
        start: loaded.map(x => x.range[0]).sort()[0],
        end: loaded.map(x => x.range[1]).sort().pop(),
        orders: loaded.reduce((s, x) => s + (x.c.orders || 0), 0),
        revenue: Math.round(loaded.reduce((s, x) => s + (x.c.revenue || 0), 0) * 100) / 100
      }
    });
  }

  return {
    collected,
    stillPending: nextQueue,
    failed,
    remaining: nextQueue.length
  };
}

// ─── LIST PENDING REPORTS ───────────────────────────────────────────────────
//
// Returns the current pending queue + last-result-per-month state so
// the UI can render "what's in flight" and "what happened last time"
// without triggering a poll (which would consume SP-API quota).
async function handleListPendingReports(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const [pending, lastResults] = await Promise.all([
      kv.get('orders:v2:pending-reports'),
      kv.get('orders:v2:report-lastresult')
    ]);

    return res.status(200).json({
      success: true,
      pending: Array.isArray(pending) ? pending : [],
      lastResults: (lastResults && typeof lastResults === 'object') ? lastResults : {}
    });
  } catch (error) {
    console.error('[ORDERS LIST-PENDING] Error:', error);
    return res.status(500).json({ error: 'List failed: ' + error.message });
  }
}

// ─── DELETE V2 MONTHS ───────────────────────────────────────────────────────
//
// Clears specified months from the orders:v2:* keyspace so they can be
// re-populated cleanly (e.g. after a partial-month API pull that only
// caught the tail end of a retention-bounded month). Removes three
// things per month:
//   1. `orders:v2:${month}` — the actual line-item bucket
//   2. entries from `orders:v2:index`
//   3. entries from `orders:v2:report-lastresult` — so the UI's Recent
//      results panel doesn't render stale "42 rows" for a month that's
//      now empty
//
// Body: { months: ['YYYY-MM', ...] }
async function handleDeleteV2Months(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const months = Array.isArray(req.body?.months) ? req.body.months : null;
    if (!months || months.length === 0) {
      return res.status(400).json({ error: 'months array required in body' });
    }
    const invalid = months.filter(m => !/^\d{4}-\d{2}$/.test(m));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid month format: ${invalid.join(', ')}. Use YYYY-MM.` });
    }

    if (ordersSql.ordersInSql()) {
      await ordersSql.deleteMonths(months);
    } else {
      // 1. Delete the per-month buckets in parallel.
      await Promise.all(months.map(m => kv.del(`orders:v2:${m}`)));

      // 2. Remove from the index.
      const existingIndex = (await kv.get('orders:v2:index')) || [];
      const toRemove = new Set(months);
      const newIndex = existingIndex.filter(m => !toRemove.has(m));
      if (newIndex.length !== existingIndex.length) {
        await kv.set('orders:v2:index', newIndex);
      }
    }

    // 3. Remove from lastResults (so the UI doesn't render stale "N
    // rows" entries for months whose bucket is now empty).
    const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};
    let lastResultsChanged = false;
    for (const m of months) {
      if (lastResults[m]) {
        delete lastResults[m];
        lastResultsChanged = true;
      }
    }
    if (lastResultsChanged) {
      await kv.set('orders:v2:report-lastresult', lastResults);
    }

    return res.status(200).json({
      success: true,
      deleted: months,
      message: `Deleted ${months.length} month${months.length === 1 ? '' : 's'} from the dashboard.`
    });
  } catch (error) {
    console.error('[ORDERS DELETE-V2] Error:', error);
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

// ─── CRON: DAILY REQUEST ────────────────────────────────────────────────────
//
// Fires TWO SP-API createReport calls for yesterday (Pacific time). Runs
// unauthenticated (Vercel cron). Both are single-day, merge-mode reports
// so cron-collect merges rather than replacing whole months:
//
//   1. BY_ORDER_DATE — orders PLACED yesterday: the day's new data.
//   2. BY_LAST_UPDATE — orders UPDATED yesterday, whenever placed:
//      cancelled rows delete their previously-stored copies (an order
//      cancelled after we imported it as valid), and non-cancelled rows
//      refresh stale values (e.g. pending orders whose prices finalized
//      after first import).
//
// On any thrown error: writes a `pull-failure` alert before returning
// 500. On success: writes the requestAt heartbeat and returns 200.
async function handleCronDailyRequest(req, res) {
  const yesterday = _yesterdayPT();
  try {
    const { dataStartTime, dataEndTime } = _ptRangeBoundsUtc(yesterday, yesterday);

    const orderReport = await _requestReportForMonth({
      tag: yesterday,
      name: `AllOrders ${yesterday}`,
      dataStartTime,
      dataEndTime,
      merge: true
    });

    const updateReport = await _requestReportForMonth({
      tag: `upd:${yesterday}`,
      name: `AllOrdersByUpdate ${yesterday}`,
      dataStartTime,
      dataEndTime,
      merge: true,
      updateOnly: true,
      dependsOn: yesterday,
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL'
    });

    // Heartbeat: write requestAt so the client-side stale-check has
    // fresh info, and so the dashboard can show "Last sync: X ago."
    await _touchHeartbeat({ requestAt: new Date().toISOString() });

    // Self-heal: a successful request clears the pull-failure alert any
    // earlier failed attempt wrote for this same date (e.g. expired
    // credentials fixed later the same day).
    await _resolveAlert(`pull-failure:${yesterday}`);

    return res.status(200).json({
      success: true,
      date: yesterday,
      tags: [yesterday, `upd:${yesterday}`],
      reports: [
        { tag: yesterday, reportId: orderReport.reportId, alreadyPending: orderReport.alreadyPending },
        { tag: `upd:${yesterday}`, reportId: updateReport.reportId, alreadyPending: updateReport.alreadyPending }
      ]
    });
  } catch (error) {
    const errorMsg = _extractSpApiErrorMessage(error);
    console.error('[ORDERS CRON-DAILY-REQUEST] Error:', errorMsg);
    await _addAlert({
      id: `pull-failure:${yesterday}`,
      severity: 'error',
      category: 'pull-failure',
      message: `Daily order-report request failed for ${yesterday}: ${errorMsg}`
    });
    return res.status(500).json({ error: 'Request failed: ' + errorMsg, date: yesterday });
  }
}

// ─── CRON: COLLECT ──────────────────────────────────────────────────────────
//
// Drains the pending report queue. Runs 3× daily to catch reports
// whenever Amazon finishes them (5–15 min typical; occasionally hours).
// Uses mergeMode: true because Phase 3 requests are single-day slices
// that should stack into the current month, not replace it.
//
// For any FAILED entry the poll returns: emits a collect-failure alert.
async function handleCronCollect(req, res) {
  try {
    // overwrite is irrelevant in merge mode (merges don't collide) but
    // pass true for parity with the Pull UI's overwrite semantic.
    const result = await _pollPendingReports({ overwrite: true, mergeMode: true });

    for (const f of result.failed) {
      // Integrity refusals already fired their own alert at ingest time.
      if (f.alerted) continue;
      await _addAlert({
        id: `collect-failure:${f.reportId}`,
        severity: 'error',
        category: 'collect-failure',
        message: `Report ${f.month} failed on Amazon's side: ${f.error}`,
        details: { reportId: f.reportId, month: f.month, status: f.status }
      });
    }

    await _touchHeartbeat({ collectAt: new Date().toISOString() });

    return res.status(200).json({
      success: true,
      collected: result.collected,
      failed: result.failed,
      remaining: result.remaining
    });
  } catch (error) {
    console.error('[ORDERS CRON-COLLECT] Error:', error);
    return res.status(500).json({ error: 'Collect failed: ' + error.message });
  }
}

// ─── CRON: DATA CHECK ──────────────────────────────────────────────────────
//
// Data-centric monitoring: reads the KV directly and verifies yesterday
// has rows. Doesn't call Amazon. Fires an alert if the target date is
// empty (which means the daily request or collect broke in some way).
// Self-heals: on a successful check with non-zero rows, clears any
// existing no-data alert for that date (via re-emit with dismissed=true,
// but simpler is to just leave it — the next visit clears it via the
// dismiss endpoint, and the count > 0 path can proactively mark it).
async function handleCronDataCheck(req, res) {
  // Logged (not returned) so the runtime's exact Node version is on record
  // in Vercel's function logs once a day without exposing it publicly.
  console.log(`[cron-data-check] runtime node ${process.version}`);
  const yesterday = _yesterdayPT();
  const yesterdayMonth = yesterday.slice(0, 7);
  try {
    // Month buckets cached across the no-data and plausibility checks —
    // the trailing-weekday history reads from the same 1-2 months.
    const buckets = {};
    const getBucket = async (m) => {
      if (!(m in buckets)) {
        buckets[m] = ordersSql.ordersInSql()
          ? await ordersSql.getMonth(m)
          : (await kv.get(`orders:v2:${m}`)) || [];
      }
      return buckets[m];
    };

    const dayRows = (await getBucket(yesterdayMonth)).filter(r => r && r.orderDate === yesterday);
    const count = dayRows.length;

    if (count === 0) {
      await _addAlert({
        id: `no-data:${yesterday}`,
        severity: 'error',
        category: 'no-data',
        message: `No orders captured for ${yesterday}. Daily sync may be broken.`
      });
    } else {
      // Self-heal: if a previous check for this same date wrote a
      // no-data alert and a subsequent run finds data, mark that
      // alert dismissed so it stops appearing in the banner.
      await _resolveAlert(`no-data:${yesterday}`);
    }

    // Integrity check 4 (plausibility): yesterday's rows may all be
    // well-formed and still be wrong — a truncated report, a partial
    // generation on Amazon's side, a double-import. Compare row count
    // and revenue against the median of the trailing 4 same-weekdays
    // (weekday-aware: weekends sell differently than weekdays). Warn,
    // not error — a genuinely great or terrible sales day is possible.
    let plausibility = 'skipped';
    if (count > 0) {
      const revenue = dayRows.reduce((s, r) => s + (r.itemTotal || 0), 0);
      const history = [];
      for (let k = 1; k <= 4; k++) {
        const d = new Date(Date.parse(yesterday + 'T00:00:00Z') - k * 7 * 86400000);
        const dateStr = d.toISOString().slice(0, 10);
        const rows = (await getBucket(dateStr.slice(0, 7))).filter(r => r && r.orderDate === dateStr);
        if (rows.length > 0) {
          history.push({
            date: dateStr,
            count: rows.length,
            revenue: rows.reduce((s, r) => s + (r.itemTotal || 0), 0)
          });
        }
      }

      // Need at least 3 comparable weekdays with data, and a non-trivial
      // baseline, before calling anything an anomaly.
      if (history.length >= 3) {
        const median = (arr) => {
          const s = [...arr].sort((a, b) => a - b);
          const mid = Math.floor(s.length / 2);
          return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
        };
        const medCount = median(history.map(h => h.count));
        const medRevenue = median(history.map(h => h.revenue));
        const countOff = medCount >= 5 && (count < medCount * 0.3 || count > medCount * 3);
        const revenueOff = medRevenue > 0 && (revenue < medRevenue * 0.3 || revenue > medRevenue * 3);

        if (countOff || revenueOff) {
          const weekday = new Date(yesterday + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
          const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
          await _addAlert({
            id: `plausibility:${yesterday}`,
            severity: 'warn',
            category: 'plausibility',
            message: `Yesterday (${yesterday}) imported ${count} rows / ${usd(revenue)} in sales — typical ${weekday} is ~${Math.round(medCount)} rows / ~${usd(medRevenue)} (median of the last ${history.length} ${weekday}s). Could be a real sales swing, or a partial/duplicated import.`,
            details: {
              count,
              revenue: Math.round(revenue * 100) / 100,
              medianCount: medCount,
              medianRevenue: Math.round(medRevenue * 100) / 100,
              historyDates: history.map(h => h.date)
            }
          });
          plausibility = 'alert';
        } else {
          // Self-heal: a corrected re-import that lands back inside the
          // normal band clears the earlier warning.
          await _resolveAlert(`plausibility:${yesterday}`);
          plausibility = 'ok';
        }
      }
    }

    await _touchHeartbeat({ checkAt: new Date().toISOString(), lastCheckDate: yesterday, lastCheckCount: count });

    return res.status(200).json({
      success: true,
      date: yesterday,
      count,
      plausibility,
      status: count === 0 ? 'alert' : 'ok'
    });
  } catch (error) {
    console.error('[ORDERS CRON-DATA-CHECK] Error:', error);
    return res.status(500).json({ error: 'Data check failed: ' + error.message });
  }
}

// ─── USER-FACING: GET ALERTS ────────────────────────────────────────────────
//
// Returns undismissed alerts + heartbeat data for the Sales & Volume
// banner. Auth-gated (unlike the cron actions).
async function handleGetAlerts(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const [alertsRaw, heartbeat] = await Promise.all([
      kv.get('orders:v2:alerts'),
      kv.get('orders:v2:last-cron-run')
    ]);
    const alerts = (Array.isArray(alertsRaw) ? alertsRaw : []).filter(a => a && !a.dismissed);

    return res.status(200).json({
      success: true,
      alerts,
      heartbeat: (heartbeat && typeof heartbeat === 'object') ? heartbeat : {}
    });
  } catch (error) {
    console.error('[ORDERS GET-ALERTS] Error:', error);
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── USER-FACING: DISMISS ALERT ─────────────────────────────────────────────
//
// Marks an alert as dismissed (doesn't delete — kept in the array for
// audit, but doesn't render in the banner). Body: { id }.
async function handleDismissAlert(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const id = req.body?.id;
    if (!id) return res.status(400).json({ error: 'id required in body' });

    const alerts = (await kv.get('orders:v2:alerts')) || [];
    const idx = alerts.findIndex(a => a && a.id === id);
    if (idx < 0) return res.status(404).json({ error: `Alert not found: ${id}` });

    alerts[idx] = { ...alerts[idx], dismissed: true, dismissedAt: new Date().toISOString() };
    await kv.set('orders:v2:alerts', alerts);

    return res.status(200).json({ success: true, id });
  } catch (error) {
    console.error('[ORDERS DISMISS-ALERT] Error:', error);
    return res.status(500).json({ error: 'Dismiss failed: ' + error.message });
  }
}

// Self-heal path: mark an active alert dismissed because a later run
// found the condition resolved (data arrived, a re-import came back
// clean, a day fell back inside its normal band). No-op if the alert
// doesn't exist or was already dismissed.
async function _resolveAlert(id) {
  try {
    const alerts = (await kv.get('orders:v2:alerts')) || [];
    const idx = alerts.findIndex(a => a && a.id === id && !a.dismissed);
    if (idx < 0) return false;
    alerts[idx] = { ...alerts[idx], dismissed: true, resolvedAt: new Date().toISOString() };
    await kv.set('orders:v2:alerts', alerts);
    return true;
  } catch (err) {
    console.warn('[_resolveAlert] KV write failed:', err.message);
    return false;
  }
}

// Read-modify-write helper for the heartbeat KV. Merges the supplied
// fields into orders:v2:last-cron-run rather than replacing wholesale,
// so a cron that only updates requestAt doesn't clobber collectAt.
async function _touchHeartbeat(patch) {
  try {
    const current = (await kv.get('orders:v2:last-cron-run')) || {};
    await kv.set('orders:v2:last-cron-run', { ...current, ...patch });
  } catch (err) {
    console.warn('[_touchHeartbeat] KV write failed:', err.message);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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

// Minimal tab-separated-values parser. Amazon's flat-file reports come
// back as gzipped TSV; after gunzip we have a string, and we want an
// array of objects keyed by header column name so the shared
// _normalizeAndWriteOrdersMonth helper can consume it identically to
// rows from the client-side manual upload.
//
// Assumptions (all safe for Amazon's flat file):
//   • Fields don't contain tabs (Amazon escapes any tab characters in
//     values before shipping the report)
//   • Fields don't contain newlines within a single value
//   • Trailing blank lines are ignored
//   • CRLF line endings handled
function _parseTsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] ?? '';
    }
    out.push(row);
  }
  return out;
}

// Returns yesterday's date as YYYY-MM-DD in UTC. Cron-driven — no local
// tz drift. Matches the flat file's `purchase-date` UTC dating.
// ─── PACIFIC-TIME DATE HELPERS ──────────────────────────────────────────────
//
// Amazon's human-facing surfaces (Seller Central report date pickers,
// Business Reports day buckets) treat "a day" as a calendar day in the
// marketplace's local timezone — Pacific for amazon.com — while the
// flat file's purchase-date timestamps are UTC instants. The dashboard
// buckets orders by their PACIFIC date and requests reports with
// Pacific day bounds, so its day/month totals reconcile exactly with a
// Seller Central export for the same range.

// UTC instant (ISO string or Date) → 'YYYY-MM-DD' in America/Los_Angeles.
// Returns '' for unparseable input (callers regex-validate anyway).
function _ptDate(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// Calendar arithmetic on a 'YYYY-MM-DD' label (timezone-free).
function _addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Yesterday's calendar date in Pacific time.
function _yesterdayPT() {
  return _addDays(_ptDate(new Date()), -1);
}

// UTC instant of midnight Pacific on the given calendar date. Probes
// both possible offsets (PDT -07:00 / PST -08:00) and keeps the one
// that round-trips to midnight of the same date — exact across DST.
function _ptMidnightUtc(dateStr) {
  for (const off of ['-07:00', '-08:00']) {
    const d = new Date(`${dateStr}T00:00:00${off}`);
    if (_ptDate(d) === dateStr &&
        d.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false }).startsWith('00:00')) {
      return d;
    }
  }
  return new Date(`${dateStr}T00:00:00-08:00`);
}

// Inclusive PT calendar range → SP-API dataStartTime/dataEndTime (UTC).
// End bound is the last second of endDate in Pacific time.
function _ptRangeBoundsUtc(startDate, endDate) {
  return {
    dataStartTime: _ptMidnightUtc(startDate).toISOString(),
    dataEndTime: new Date(_ptMidnightUtc(_addDays(endDate, 1)).getTime() - 1000).toISOString()
  };
}

// Map a pending-queue tag to the inclusive PT date range it covered:
// '2026-07-15' → single day; '2026-07-01..2026-07-14' → range;
// '2026-07' → whole month. Returns null for upd:* (BY_LAST_UPDATE)
// tags and anything unrecognized.
function _tagDateRange(tag) {
  if (typeof tag !== 'string' || tag.startsWith('upd:')) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(tag)) return [tag, tag];
  const range = tag.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) return [range[1], range[2]];
  if (/^\d{4}-\d{2}$/.test(tag)) {
    const [y, m] = tag.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${tag}-01`, `${tag}-${String(lastDay).padStart(2, '0')}`];
  }
  return null;
}

// Alert helper — writes to orders:v2:alerts (dedupes by id, caps array
// at 100 entries, oldest dropped first) and if SLACK_WEBHOOK_URL env var
// is set, POSTs a formatted message to Slack. Slack failures are logged
// but never thrown (alerting mustn't break the caller).
//
// Alert shape:
//   { id, severity, category, message, createdAt, dismissed: false, details? }
//
// The `id` is a stable string per alert type + subject (e.g.
// 'no-data:2026-07-13'). Re-emitting the same id overwrites the
// existing entry rather than duplicating — data-check running on July
// 15 and finding July 13 still empty replaces the entry with a fresh
// timestamp instead of stacking.
async function _addAlert({ id, severity = 'error', category, message, details }) {
  const alert = {
    id,
    severity,
    category,
    message,
    createdAt: new Date().toISOString(),
    dismissed: false,
    ...(details ? { details } : {})
  };

  try {
    const existing = (await kv.get('orders:v2:alerts')) || [];
    const filtered = existing.filter(a => a && a.id !== id);
    // Cap at 100. When trimming, drop dismissed first, then oldest.
    let combined = [...filtered, alert];
    if (combined.length > 100) {
      const [dismissed, active] = combined.reduce((acc, a) => {
        (a.dismissed ? acc[0] : acc[1]).push(a);
        return acc;
      }, [[], []]);
      const trimmed = [
        ...active,
        ...dismissed.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                    .slice(0, Math.max(0, 100 - active.length))
      ];
      combined = trimmed.slice(-100);
    }
    await kv.set('orders:v2:alerts', combined);
  } catch (err) {
    console.error('[_addAlert] KV write failed:', err.message);
    // Fall through — still try Slack even if KV failed
  }

  // Slack notification. Skip silently if webhook not configured.
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    const emoji = severity === 'error' ? '🔴' : (severity === 'warn' ? '⚠️' : 'ℹ️');
    const text = `${emoji} [Sales & Volume] ${category} — ${message}`;
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!resp.ok) {
        console.warn(`[_addAlert] Slack POST returned ${resp.status}: ${await resp.text().catch(() => '')}`);
      }
    } catch (err) {
      console.warn('[_addAlert] Slack POST failed:', err.message);
    }
  }
}

// Returns { lineItems, seenOrderIds }.
//
// `lineItems` are the per-SKU rows for orders newly captured during this
// run. `seenOrderIds` is every order ID returned by SP-API's getOrders in
// the window (whether or not we re-fetched its items) — needed by
// upsertOrdersToKV's cancellation-reconciliation pass to tell "this order
// still exists" apart from "this order was canceled and should be evicted".
//
// Why we skip getOrderItems for orders we already have:
//   - getOrderItems is the slow part (200ms sleep + 200–500ms network per
//     call). On a 14-day window with hundreds of orders, calling it for
//     every order pushes wall time past Vercel's 300s function timeout
//     — that's the bug we're fixing here.
//   - Once an order has any line items in KV, its existence is captured.
//     The bug that justified the trailing window was orders silently
//     missing because getOrderItems returned empty while they were
//     Pending. Re-checking an order whose items are already in KV adds
//     no information (orders' line items don't materially change after
//     they leave Pending; quantity drift after first capture is rare
//     enough that the user can manually backfill if they spot it).
//
// Trade-off: line-item-level value updates (e.g. quantity change on a B2B
// order after partial cancellation) won't propagate after first capture.
// For Sales & Volume (order existence + initial captured volume), this
// is acceptable. Profitability uses a different data pipeline entirely
// and is unaffected.
async function fetchOrdersForDateRange(startDate, endDate) {
  const sp = createSellingPartner();
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

  // Pass 1: pull every order header in the window from getOrders. This is
  // the cheap part — paginated, no per-order API call. We need the full
  // list before we can decide which ones to re-fetch items for, since the
  // "already have items?" check is keyed on orderId.
  const allOrders = []; // [{ AmazonOrderId, PurchaseDate, FulfillmentChannel }]
  let nextToken = null;
  do {
    const query = {
      MarketplaceIds: marketplaceId,
      CreatedAfter: `${startDate}T00:00:00Z`,
      CreatedBefore: `${endDate}T23:59:59Z`,
      ...(nextToken ? { NextToken: nextToken } : {})
    };

    const response = await sp.callAPI({
      operation: 'getOrders',
      endpoint: 'orders',
      query
    });

    const orders = response.Orders || [];
    nextToken = response.NextToken || null;

    // Filter Canceled here so they don't enter seenOrderIds either — the
    // reconciliation pass in upsertOrdersToKV then correctly evicts them
    // from KV (any prior captured record without a matching seenOrderId
    // in the window is treated as canceled).
    for (const o of orders) {
      if (o.OrderStatus !== 'Canceled') allOrders.push(o);
    }
  } while (nextToken);

  const seenOrderIds = new Set(allOrders.map(o => o.AmazonOrderId));

  // Pass 2: build the set of orderIds we already have line items for in
  // KV. Read every month bucket the window could touch (almost always 1
  // or 2). The Set lets us skip getOrderItems for orders that are
  // already fully captured.
  const monthsInWindow = new Set();
  for (const o of allOrders) {
    const month = o.PurchaseDate.slice(0, 7);
    monthsInWindow.add(month);
  }
  const existingOrderIds = new Set();
  for (const month of monthsInWindow) {
    const bucket = (await kv.get(`orders:${month}`)) || [];
    for (const row of bucket) {
      if (row && row.orderId) existingOrderIds.add(row.orderId);
    }
  }

  // Pass 3: fetch items only for orders we don't already have. Sleeps and
  // throttle retries scale with new-orders count, not total-orders count
  // — so a 14-day window with mostly-already-captured orders runs in
  // seconds instead of minutes.
  const lineItems = [];
  let fetchedCount = 0;
  let skippedCount = 0;
  for (const order of allOrders) {
    if (existingOrderIds.has(order.AmazonOrderId)) {
      skippedCount++;
      continue;
    }
    fetchedCount++;
    const items = await fetchOrderItems(sp, order.AmazonOrderId);
    for (const item of items) {
      lineItems.push({
        orderDate: order.PurchaseDate.split('T')[0],
        orderId: order.AmazonOrderId,
        sku: item.SellerSKU,
        asin: item.ASIN,
        quantity: parseInt(item.QuantityOrdered) || 0,
        itemTotal: parseFloat(item.ItemPrice?.Amount || 0),
        fulfillmentChannel: order.FulfillmentChannel // AFN = FBA, MFN = Seller
      });
    }
    await sleep(200);
  }
  console.log(`[ORDERS] Items pass: fetched=${fetchedCount} skipped-already-captured=${skippedCount} (${allOrders.length} orders in window)`);

  return { lineItems, seenOrderIds };
}

// Retry on SP-API rate-limit (429 / QuotaExceeded). Without this, a
// throttled getOrderItems silently dropped the order's items — meaning the
// trailing-window re-fetch (14× more calls/run than the old yesterday-only
// cron) would re-introduce the same silent data loss this plan is meant to
// fix. Exponential backoff: 2s, 4s, 8s; 3 retries max before falling back
// to the original silent-failure path (so a persistent outage doesn't kill
// the whole sync, just the orders that won't respond).
async function fetchOrderItems(sp, orderId, attempt = 0) {
  try {
    const response = await sp.callAPI({
      operation: 'getOrderItems',
      endpoint: 'orders',
      path: { orderId }
    });
    return response.OrderItems || [];
  } catch (error) {
    const is429 = error?.statusCode === 429
                  || error?.code === 'QuotaExceeded'
                  || /quota|throttl|too many|rate.?limit/i.test(error?.message || '');
    if (is429 && attempt < 3) {
      const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(`[ORDERS] Throttled on ${orderId}, retry ${attempt + 1}/3 in ${wait}ms`);
      await sleep(wait);
      return fetchOrderItems(sp, orderId, attempt + 1);
    }
    console.error(`Error fetching items for order ${orderId}:`, error);
    return [];
  }
}

// Writes newLineItems to KV month-by-month, deduping by `${orderId}:${sku}`.
// `seenOrderIds` is the set of every active order ID returned by getOrders
// for the window (NOT just orders whose items were re-fetched this run —
// fetchOrdersForDateRange now skips re-fetching items for orders already
// captured, so newLineItems alone is no longer a complete view of "which
// orders exist for this window"). seenOrderIds is what cancellation
// reconciliation uses to tell "still on Amazon" apart from "canceled".
//
// When a window is provided, any KV record whose orderDate falls in
// `[windowStart, windowEnd]` AND whose orderId is missing from
// seenOrderIds is considered canceled-since-original-sync and gets
// evicted. Without this, the trailing window would leave canceled
// orders in place as zombie revenue.
//
// `seenOrderIds`/`windowStart`/`windowEnd` are optional — when omitted
// (no current caller, kept for forward-compatibility), the function
// preserves its pre-change add-only behavior.
async function upsertOrdersToKV(newLineItems, seenOrderIds, windowStart, windowEnd) {
  // Skip only if there's nothing to write AND no reconciliation work
  // (no window means no eviction pass). When a window IS supplied, even
  // an empty newLineItems still triggers the per-month read so eviction
  // can run.
  if (newLineItems.length === 0 && !windowStart) return;

  const byMonth = {};
  for (const order of newLineItems) {
    const month = order.orderDate.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(order);
  }

  // When reconciling we also need to touch any month that the window
  // straddles, even if zero new orders for that month came back. Add
  // those months to the work list with an empty bucket — the eviction
  // pass below handles them.
  if (windowStart && windowEnd) {
    const ws = windowStart.slice(0, 7);
    const we = windowEnd.slice(0, 7);
    // Most windows span 1–2 months; this loop runs at most ~3× even
    // for a 30-day window crossing a month boundary.
    let cur = ws;
    while (cur <= we) {
      if (!byMonth[cur]) byMonth[cur] = [];
      // Increment to next month (string math via Date to keep edge
      // cases — Dec→Jan, leap years — out of this code).
      const [y, m] = cur.split('-').map(Number);
      const next = new Date(Date.UTC(y, m, 1));
      cur = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }

  const index = await kv.get('orders:index') || [];
  const updatedIndex = [...new Set([...index, ...Object.keys(byMonth)])].sort();
  await kv.set('orders:index', updatedIndex);

  const reconcile = !!(seenOrderIds && windowStart && windowEnd);

  for (const [month, orders] of Object.entries(byMonth)) {
    const existing = await kv.get(`orders:${month}`) || [];
    const dedupeMap = {};
    for (const o of existing) dedupeMap[`${o.orderId}:${o.sku}`] = o;
    for (const o of orders) dedupeMap[`${o.orderId}:${o.sku}`] = o;

    // Cancellation reconciliation: drop KV records whose orderDate is
    // inside the re-fetched window but whose orderId is NOT in
    // seenOrderIds. fetchOrdersForDateRange filters out Canceled orders
    // before building seenOrderIds, so a missing orderId means "canceled
    // or otherwise disappeared on Amazon's side".
    let evictedCount = 0;
    if (reconcile) {
      for (const key of Object.keys(dedupeMap)) {
        const o = dedupeMap[key];
        if (o.orderDate >= windowStart && o.orderDate <= windowEnd
            && !seenOrderIds.has(o.orderId)) {
          delete dedupeMap[key];
          evictedCount++;
        }
      }
    }

    const merged = Object.values(dedupeMap).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
    await kv.set(`orders:${month}`, merged);
    const evictedNote = evictedCount > 0 ? ` (evicted ${evictedCount} canceled)` : '';
    console.log(`[ORDERS] Saved ${merged.length} records for ${month}${evictedNote}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
