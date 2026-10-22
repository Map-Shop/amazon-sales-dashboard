import { kv } from '../lib/kv.js';
import * as ordersSql from '../lib/orders.js';
import * as productsSql from '../lib/products.js';
import * as adspendSql from '../lib/adspend.js';
import * as adHistory from '../lib/adhistory.js';

// An ad type's month as { rows } (null when kv has no record), and its
// replacement — the ad_spend_rows table when SQL_TABLES includes
// "adspend", otherwise the adspend:<type>:raw:YYYY-MM kv record.
async function readAdMonth(type, month) {
  if (adspendSql.adspendInSql()) return { rows: await adspendSql.getMonth(type, month) };
  return kv.get(`adspend:${type}:raw:${month}`);
}
async function writeAdMonth(type, month, rows) {
  if (adspendSql.adspendInSql()) return adspendSql.replaceMonth(type, month, rows);
  return kv.set(`adspend:${type}:raw:${month}`, { rows });
}
// An ad type's synced months in [startMonth, endMonth] and their rows, as
// get-range returns them. Also used by the profitability statement
// (api/transactions.js).
export async function readAdRange(type, startMonth, endMonth) {
  const index = (await kv.get(`adspend:${type}:index`)) || [];
  const months = index.filter(m => m >= startMonth && m <= endMonth);
  const buckets = await Promise.all(months.map(m => readAdMonth(type, m)));
  const rows = [];
  for (const b of buckets) {
    if (b && Array.isArray(b.rows)) for (const r of b.rows) rows.push(r);
  }
  return { months, rows };
}
// The campaign census. Imported rather than re-implemented: the cron needs to
// refresh it before fetching reports, and there is exactly one correct way to
// do that. Vercel bundles the module; it does not add a serverless function.
import { acRunSync, acBrandFromPrefix, acEnsureHistory } from './adcampaigns.js';
import { gunzip } from 'zlib';
import { promisify } from 'util';

const gunzipAsync = promisify(gunzip);

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Amazon Advertising API, v3 reporting endpoints. Reports are async:
//   POST /reporting/reports        → returns reportId (queued)
//   GET  /reporting/reports/{id}   → status; when COMPLETED, includes url
//   GET  {url}                     → gzipped JSON of daily rows
//
// Because report generation takes 1–5+ minutes, a single HTTP request can't
// reliably request + poll + download in one shot. So we split:
//   sync-request  → POSTs the SP + SB report requests, stashes reportIds.
//   sync-collect  → polls status; downloads + stores when ready. Idempotent.
//   sync-status   → inspect pending state.
//
// This file also hosts the Weekly Red Flag Monitor (weekly-request /
// weekly-status / weekly-collect) at the bottom. It shares the
// Advertising API client below but none of the KV layout described here — see
// that section's own banner. It is here only because Vercel's Hobby plan caps a
// deployment at 12 serverless functions.
//
// KV layout:
//   adspend:pending                  → [{ reportId, type, month, requestedAt, name }]
//   adspend:<type>:raw:YYYY-MM       → { rows: [...] }           type ∈ {sp, sb}
//   adspend:<type>:index             → ['YYYY-MM', ...]
//   adspend:last-synced:YYYY-MM      → ISO timestamp (most recent successful write)
//
// Row shape (normalized across API-sourced and Sheets-backfilled):
//   SP rows (API): { date, campaign, adGroup?, sku?, asin?, cost,
//                    impressions?, clicks?, purchases7d?, sales7d? }
//   SB rows (API): { date, campaign, cost, impressions?, clicks? }
//   Historical (Sheets backfill): { date, campaign, cost }  — no sku/asin.
// Client-side allocation checks for `sku` to decide between direct-SKU
// attribution (new API data) and campaign→SKU mapping (historical).

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
    if (action === 'sync-request')        return handleSyncRequest(req, res);
    if (action === 'sync-collect')        return handleSyncCollect(req, res);
    if (action === 'sync-status')         return handleSyncStatus(req, res);
    if (action === 'get')                 return handleGet(req, res);
    if (action === 'get-range')           return handleGetRange(req, res);
    if (action === 'get-months')          return handleGetMonths(req, res);
    // Weekly Red Flag Monitor — see the section at the bottom of this file.
    if (action === 'weekly-request')      return handleWeeklyRequest(req, res);
    if (action === 'weekly-status')       return handleWeeklyStatus(req, res);
    if (action === 'weekly-collect')      return handleWeeklyCollect(req, res);
    if (action === 'weekly-get')          return handleWeeklyGet(req, res);
    // Bi-weekly tactical budget management — see the section at the bottom.
    if (action === 'biweekly-request')    return handleBiweeklyRequest(req, res);
    if (action === 'biweekly-status')     return handleBiweeklyStatus(req, res);
    if (action === 'biweekly-collect')    return handleBiweeklyCollect(req, res);
    if (action === 'biweekly-get')        return handleBiweeklyGet(req, res);
    // Monthly brand posture review — see the section at the bottom.
    if (action === 'monthly-request')      return handleMonthlyRequest(req, res);
    if (action === 'monthly-status')       return handleMonthlyStatus(req, res);
    if (action === 'monthly-collect')      return handleMonthlyCollect(req, res);
    if (action === 'monthly-get')          return handleMonthlyGet(req, res);
    // Weekly history — the continuous series, see the section at the bottom.
    if (action === 'weeks-get')            return handleWeeksGet(req, res);
    if (action === 'weeks-rebuild')        return handleWeeksRebuild(req, res);
    // Vercel cron. Unauthenticated by the convention every other cron here
    // follows; nothing in them writes a budget.
    if (action === 'cron-ads-request')    return handleCronAdsRequest(req, res);
    if (action === 'cron-ads-collect')    return handleCronAdsCollect(req, res);
    if (action === 'cron-monthly-request') return handleCronMonthlyRequest(req, res);
    if (action === 'cron-monthly-collect') return handleCronMonthlyCollect(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'migrate-from-sheets')     return handleMigrateFromSheets(req, res);
    if (action === 'dedupe-sheets-vs-api')    return handleDedupeSheetsVsApi(req, res);
    if (action === 'delete-sheets-rows')      return handleDeleteSheetsRows(req, res);
    if (action === 'upload-yearly-csv')       return handleUploadYearlyCsv(req, res);
    if (action === 'biweekly-posture')        return handleBiweeklyPosture(req, res);
    if (action === 'weekly-note')             return handleWeeklyNote(req, res);
    if (action === 'biweekly-adopt')          return handleBiweeklyAdopt(req, res);
    if (action === 'biweekly-import')         return handleBiweeklyImport(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── SYNC REQUEST ────────────────────────────────────────────────────────────
// Kicks off both the SP Advertised Product and SB Campaigns reports for the
// requested month. Each returns a reportId that we stash in adspend:pending;
// sync-collect later polls those IDs and downloads the results when ready.
async function handleSyncRequest(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const { start, end } = monthBoundDates(month);

    // types=sp, types=sb, or types=sp,sb (default = both).
    const typesParam = (req.query.types || 'sp,sb').toLowerCase();
    const wanted = new Set(typesParam.split(',').map(s => s.trim()).filter(Boolean));

    const accessToken = await getAdsAccessToken();
    const requested = [];

    // Sponsored Products — SKU-level spend attribution via "advertised product".
    if (wanted.has('sp')) try {
      const spReportId = await requestReport(accessToken, {
        name: `SP Advertised Product ${month}`,
        startDate: start,
        endDate: end,
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['advertiser'],
          columns: [
            'date', 'campaignName', 'adGroupName',
            'advertisedSku', 'advertisedAsin',
            'cost', 'impressions', 'clicks',
            'purchases7d', 'sales7d'
          ],
          reportTypeId: 'spAdvertisedProduct',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON'
        }
      });
      requested.push({ reportId: spReportId, type: 'sp', month, requestedAt: new Date().toISOString(), name: `SP Advertised Product ${month}` });
    } catch (err) {
      console.error('[ADSPEND] SP request failed:', err.message);
      requested.push({ type: 'sp', month, error: err.message });
    }

    // Sponsored Brands — campaign-level (SB doesn't expose per-SKU spend).
    if (wanted.has('sb')) try {
      const sbReportId = await requestReport(accessToken, {
        name: `SB Campaigns ${month}`,
        startDate: start,
        endDate: end,
        configuration: {
          adProduct: 'SPONSORED_BRANDS',
          groupBy: ['campaign'],
          columns: [
            'date', 'campaignName', 'campaignId',
            'cost', 'impressions', 'clicks'
          ],
          reportTypeId: 'sbCampaigns',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON'
        }
      });
      requested.push({ reportId: sbReportId, type: 'sb', month, requestedAt: new Date().toISOString(), name: `SB Campaigns ${month}` });
    } catch (err) {
      console.error('[ADSPEND] SB request failed:', err.message);
      requested.push({ type: 'sb', month, error: err.message });
    }

    // Merge new report requests into the pending list (keep existing ones).
    const pending = (await kv.get('adspend:pending')) || [];
    const goodOnes = requested.filter(r => r.reportId);
    await kv.set('adspend:pending', [...pending, ...goodOnes]);

    return res.status(200).json({
      success: true,
      month,
      requested,
      pendingNow: pending.length + goodOnes.length,
      message: 'Reports requested from Amazon. Call sync-collect in ~1–5 minutes to download when ready.'
    });
  } catch (error) {
    console.error('[ADSPEND SYNC-REQUEST] Error:', error);
    return res.status(500).json({ error: 'Sync-request failed: ' + error.message });
  }
}

// ─── SYNC COLLECT ────────────────────────────────────────────────────────────
// Walks every pending report, checks status, downloads + stores any that are
// done. Idempotent: safe to call repeatedly (UI polling) or on a cron.
async function handleSyncCollect(req, res) {
  try {
    const pending = (await kv.get('adspend:pending')) || [];
    if (pending.length === 0) {
      return res.status(200).json({ success: true, collected: [], stillPending: [], message: 'Nothing pending.' });
    }

    const accessToken = await getAdsAccessToken();
    const collected = [];
    const stillPending = [];
    const failed = [];

    for (const p of pending) {
      try {
        const status = await getReportStatus(accessToken, p.reportId);
        const statusStr = (status.status || '').toUpperCase();

        if (statusStr === 'COMPLETED' || statusStr === 'SUCCESS') {
          if (!status.url) {
            // Some tenants return `url` at the top level; others nest it.
            // Defensive: surface failure rather than silently dropping.
            failed.push({ ...p, error: 'COMPLETED but no url on status response' });
            continue;
          }
          const rawRows = await downloadReport(status.url);
          const normalized = normalizeRows(rawRows, p.type);
          await storeMonthly(p.type, p.month, normalized);
          await kv.set(`adspend:last-synced:${p.month}`, new Date().toISOString());
          collected.push({ ...p, rowCount: normalized.length });
        } else if (statusStr === 'FAILURE' || statusStr === 'CANCELLED') {
          failed.push({ ...p, error: status.statusDetails || `status=${statusStr}` });
        } else {
          // PENDING / PROCESSING / etc. — keep waiting.
          stillPending.push({ ...p, currentStatus: statusStr });
        }
      } catch (err) {
        console.error('[ADSPEND] Collect failure for report', p.reportId, err.message);
        // Don't drop from pending on transient errors; try again next collect call.
        stillPending.push({ ...p, lastError: err.message });
      }
    }

    // Anything collected or explicitly failed is removed from pending. Still-
    // pending items stay for the next call.
    await kv.set('adspend:pending', stillPending);

    return res.status(200).json({
      success: true,
      collected,
      failed,
      stillPending,
      message:
        collected.length === 0 && stillPending.length > 0
          ? 'Reports still generating on Amazon\'s side. Try again in a minute.'
          : `Collected ${collected.length}; ${stillPending.length} still pending; ${failed.length} failed.`
    });
  } catch (error) {
    console.error('[ADSPEND SYNC-COLLECT] Error:', error);
    return res.status(500).json({ error: 'Sync-collect failed: ' + error.message });
  }
}

async function handleSyncStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const pending = (await kv.get('adspend:pending')) || [];
    return res.status(200).json({ success: true, pending, count: pending.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, month } = req.query;
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });
    if (!/^\d{4}-\d{2}$/.test(month))  return res.status(400).json({ error: 'month=YYYY-MM required' });

    const [stored, lastSynced] = await Promise.all([
      readAdMonth(type, month),
      kv.get(`adspend:last-synced:${month}`)
    ]);
    return res.status(200).json({
      success: true,
      type,
      month,
      rows: stored?.rows || [],
      lastSynced: lastSynced || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

async function handleGetRange(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, startMonth, endMonth } = req.query;
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });
    if (!startMonth || !endMonth)      return res.status(400).json({ error: 'startMonth and endMonth required' });

    const { months, rows } = await readAdRange(type, startMonth, endMonth);
    return res.status(200).json({ success: true, type, startMonth, endMonth, months, rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    // Each month's latest row date comes from the table in SQL mode; kv
    // mode keeps it in adspend:<type>:latest-posted (see storeMonthly).
    const sqlLatest = adspendSql.adspendInSql();
    const [spIndex, sbIndex, spLatestMap, sbLatestMap] = await Promise.all([
      kv.get('adspend:sp:index'),
      kv.get('adspend:sb:index'),
      sqlLatest ? adspendSql.getLatestByMonth('sp') : kv.get('adspend:sp:latest-posted'),
      sqlLatest ? adspendSql.getLatestByMonth('sb') : kv.get('adspend:sb:latest-posted')
    ]);

    const sp = Array.isArray(spIndex) ? spIndex : [];
    const sb = Array.isArray(sbIndex) ? sbIndex : [];

    // Lazy backfill: the most recent month for each type may pre-date
    // the latest-posted-by-month dictionary. Scan that month's rows
    // once if missing so the overview "Most Recent Ad Spend Data" label
    // still shows the actual latest date (e.g. 3/31/26) rather than
    // being blank for users who haven't re-synced since this code
    // shipped.
    const sanitize = (v) => (v && typeof v === 'object') ? { ...v } : {};
    const spMap = sanitize(spLatestMap);
    const sbMap = sanitize(sbLatestMap);

    async function backfill(type, months, map, mapKey) {
      if (sqlLatest || months.length === 0) return;
      const latestMonth = months[months.length - 1];
      if (map[latestMonth]) return;
      const stored = await readAdMonth(type, latestMonth);
      const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
      let monthLatest = null;
      for (const r of rows) {
        const d = r?.date;
        if (d && (!monthLatest || d > monthLatest)) monthLatest = d;
      }
      if (monthLatest) {
        map[latestMonth] = monthLatest;
        await kv.set(mapKey, map);
      }
    }
    await Promise.all([
      backfill('sp', sp, spMap, 'adspend:sp:latest-posted'),
      backfill('sb', sb, sbMap, 'adspend:sb:latest-posted')
    ]);

    // Global latest across both ad-product types.
    let latestPostedDate = null;
    for (const v of [...Object.values(spMap), ...Object.values(sbMap)]) {
      if (v && (!latestPostedDate || v > latestPostedDate)) latestPostedDate = v;
    }

    return res.status(200).json({
      success: true,
      sp,
      sb,
      latestPostedDate,
      spLatestPostedByMonth: spMap,
      sbLatestPostedByMonth: sbMap
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── MIGRATE FROM SHEETS ─────────────────────────────────────────────────────
// Reads ProductAdSpend / BrandAdSpend tabs from the user's Google Sheet and
// stores each month's daily rows under the corresponding adspend:<type>:raw
// keys. Historical rows don't have SKU attribution (Sheets was campaign-level
// only) — those are stored as { date, campaign, cost } and the client uses the
// existing campaign→SKU mapping for allocation.
async function handleMigrateFromSheets(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const readSheet = async (tab) => {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${tab}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`${tab} read failed (${r.status})`);
      return (await r.json()).values || [];
    };

    const counts = {};
    for (const { type, tab } of [
      { type: 'sp', tab: 'ProductAdSpend' },
      { type: 'sb', tab: 'BrandAdSpend' }
    ]) {
      const values = await readSheet(tab);
      if (values.length < 2) { counts[type] = 0; continue; }

      const headers = values[0].map(h => String(h || '').trim().toLowerCase());
      const iDate     = headers.indexOf('date');
      const iCampaign = headers.findIndex(h => h === 'campaign name' || h === 'campaign');
      const iCost     = headers.findIndex(h => h === 'spend' || h === 'cost');
      if (iDate === -1 || iCampaign === -1 || iCost === -1) {
        throw new Error(`${tab} missing required columns (date, campaign name, spend)`);
      }

      const byMonth = {};
      for (let i = 1; i < values.length; i++) {
        const row = values[i] || [];
        const date = String(row[iDate] || '').trim().substring(0, 10);
        const campaign = String(row[iCampaign] || '').trim();
        const cost = parseFloat(row[iCost]);
        if (!date || !campaign || !Number.isFinite(cost)) continue;
        const month = date.substring(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push({ date, campaign, cost });
      }

      // Write each month as its own raw bucket, but skip any month where
      // API data already exists (detected by the presence of at least one
      // sku-bearing row). API data is richer and authoritative; we only
      // want Sheets migration to fill in months the API hasn't touched.
      const index = (await kv.get(`adspend:${type}:index`)) || [];
      let writtenRows = 0;
      const skippedMonths = [];
      for (const [month, rows] of Object.entries(byMonth)) {
        const existing = await readAdMonth(type, month);
        const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
        const apiRowsPresent = existingRows.some(r => r && r.sku);
        if (apiRowsPresent) {
          skippedMonths.push(month);
          continue;
        }
        await writeAdMonth(type, month, dedupeRows(rows));
        writtenRows += rows.length;
        if (!index.includes(month)) index.push(month);
      }
      index.sort();
      await kv.set(`adspend:${type}:index`, index);
      counts[type] = { rows: writtenRows, skippedMonths };
    }

    return res.status(200).json({
      success: true,
      counts,
      message: `Migrated from Sheets: SP=${counts.sp.rows} rows (skipped ${counts.sp.skippedMonths.length} months that already have API data), SB=${counts.sb.rows} rows (skipped ${counts.sb.skippedMonths.length}).`
    });
  } catch (error) {
    console.error('[ADSPEND MIGRATE] Error:', error);
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── UPLOAD YEARLY CSV (Amazon Ads Sponsored Products Report) ───────────────
//
// Client-parsed Amazon Ads "Sponsored Products Campaign Performance" CSV
// posted as JSON rows. Same destination as handleMigrateFromSheets — the
// `adspend:sp:raw:YYYY-MM` bucket — but data comes from a file upload
// instead of a Google Sheets tab. The row shape we write is the same
// historical/Sheets shape ({ date, campaign, cost }, no SKU) which means
// allocation falls back to the campaign→SKU mapping table on the client.
//
// Body: { type: 'sp' | 'sb', rows: [{Date|date, "Campaign Name"|campaign,
// Spend|spend|cost}, ...] }. We accept either the raw CSV column casing
// or already-normalized lowercase keys; that way the client doesn't have
// to know which format the API expects.
async function handleUploadYearlyCsv(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const type = String(req.body?.type || '').toLowerCase();
    if (!['sp', 'sb'].includes(type)) {
      return res.status(400).json({ error: 'type must be "sp" or "sb"' });
    }
    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rawRows) return res.status(400).json({ error: 'rows array required in body' });

    // Reuse the same casing-tolerant lookup pattern as the transactions
    // upload — pull the three fields we care about and ignore the rest.
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
    let skippedNoDate = 0;
    let skippedNoCost = 0;
    for (const r of rawRows) {
      if (!r || typeof r !== 'object') continue;
      let date = String(pick(r, 'date', 'Date') || '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        // Tolerate the raw "Jan 01, 2024" form if the client didn't pre-
        // parse it (Amazon Ads exports it that way).
        const parsed = _adspendParseDateServer(date);
        if (parsed) date = parsed;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skippedNoDate++; continue; }
      const campaign = String(pick(r, 'campaign', 'Campaign Name', 'campaign name') || '').trim();
      const costRaw = pick(r, 'cost', 'spend', 'Spend');
      const cost = parseFloat(String(costRaw ?? '').replace(/[$,]/g, ''));
      if (!campaign || !Number.isFinite(cost)) { skippedNoCost++; continue; }

      const month = date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push({ date, campaign, cost });
    }

    // Same "skip if API rows present" rule as migrate-from-sheets. API
    // rows are detected by the presence of a `sku` field on at least one
    // row — historical/Sheets/upload rows never set sku, so this check
    // cleanly separates the two sources.
    const index = (await kv.get(`adspend:${type}:index`)) || [];
    let writtenRows = 0;
    const writtenMonths = [];
    const skippedMonths = [];
    for (const [month, rows] of Object.entries(byMonth)) {
      const existing = await readAdMonth(type, month);
      const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
      const apiRowsPresent = existingRows.some(rw => rw && rw.sku);
      if (apiRowsPresent) {
        skippedMonths.push(month);
        continue;
      }
      await writeAdMonth(type, month, dedupeRows(rows));
      writtenRows += rows.length;
      writtenMonths.push(month);
      if (!index.includes(month)) index.push(month);
    }
    index.sort();
    await kv.set(`adspend:${type}:index`, index);

    return res.status(200).json({
      success: true,
      type,
      writtenMonths: writtenMonths.sort(),
      writtenRows,
      skippedMonths,
      skippedNoDate,
      skippedNoCost,
      message: `Uploaded ${writtenRows} ${type.toUpperCase()} rows across ${writtenMonths.length} months${skippedMonths.length ? `; skipped ${skippedMonths.length} months with API data already present` : ''}.`
    });
  } catch (error) {
    console.error('[ADSPEND UPLOAD-YEARLY] Error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}

function _adspendParseDateServer(s) {
  if (!s) return null;
  const m = String(s).match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                   jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const mm = months[m[1].toLowerCase().substring(0, 3)];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

// ─── DELETE SHEETS-MIGRATED ROWS ─────────────────────────────────────────────
// Brute-force version of the dedupe: wipe every row that's missing a `sku`
// from the specified month's bucket. Unconditional — doesn't check whether
// API data is present, so it also clears any pure-Sheets month if you aim
// it there. Leaves API rows (sku present) untouched. Returns before/after
// counts and total cost so the cleanup is easy to verify.
//
// POST body: { type: 'sp' | 'sb', month: 'YYYY-MM' }
async function handleDeleteSheetsRows(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, month } = req.body || {};
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });

    const stored = await readAdMonth(type, month);
    const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
    const before = rows.length;
    const beforeCost = rows.reduce((s, r) => s + (Number(r?.cost) || 0), 0);

    const kept = rows.filter(r => r && typeof r.sku === 'string' && r.sku.length > 0);
    const dropped = before - kept.length;
    const keptCost = kept.reduce((s, r) => s + (Number(r.cost) || 0), 0);

    await writeAdMonth(type, month, kept);

    return res.status(200).json({
      success: true,
      type, month,
      before: { rows: before, totalCost: round2(beforeCost) },
      after:  { rows: kept.length, totalCost: round2(keptCost) },
      dropped
    });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── DEDUPE SHEETS VS API ────────────────────────────────────────────────────
// One-shot fixup for months that were written both by migrate-from-sheets
// (campaign-level, no SKU) and by sync-collect (SKU-level from the API),
// producing doubled totals. Rule: within any month whose stored rows
// include at least one sku-bearing row, drop every sku-less row. Months
// that are still purely Sheets-sourced (no sku on any row) are untouched
// so historical data isn't wiped.
//
// POST body: { type: 'sp' | 'sb', month?: 'YYYY-MM' }
//   month omitted ⇒ walk every month in the type's index.
async function handleDedupeSheetsVsApi(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, month } = req.body || {};
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });

    const monthsToCheck = month
      ? [month]
      : ((await kv.get(`adspend:${type}:index`)) || []);

    const results = [];
    for (const m of monthsToCheck) {
      const stored = await readAdMonth(type, m);
      const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
      if (rows.length === 0) { results.push({ month: m, action: 'no-data' }); continue; }

      const hasApi = rows.some(r => r && r.sku);
      if (!hasApi) { results.push({ month: m, action: 'kept-as-sheets-only', rows: rows.length }); continue; }

      const kept = rows.filter(r => r && r.sku);
      const dropped = rows.length - kept.length;
      if (dropped === 0) { results.push({ month: m, action: 'already-clean', rows: rows.length }); continue; }

      await writeAdMonth(type, m, kept);
      results.push({ month: m, action: 'deduped', kept: kept.length, dropped });
    }

    return res.status(200).json({ success: true, type, results });
  } catch (error) {
    return res.status(500).json({ error: 'Dedupe failed: ' + error.message });
  }
}

// ─── ADVERTISING API CLIENT ──────────────────────────────────────────────────

async function getAdsAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.ADV_REFRESH_TOKEN,
    client_id: process.env.ADV_CLIENT_ID,
    client_secret: process.env.ADV_CLIENT_SECRET
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(body));
  }
  return body.access_token;
}

function adsAuthHeaders(accessToken, extra = {}) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Amazon-Advertising-API-ClientId': process.env.ADV_CLIENT_ID,
    'Amazon-Advertising-API-Scope': process.env.ADV_PROFILE_ID,
    ...extra
  };
}

async function requestReport(accessToken, body) {
  const res = await fetch('https://advertising-api.amazon.com/reporting/reports', {
    method: 'POST',
    headers: adsAuthHeaders(accessToken, {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportrequest.v3+json'
    }),
    body: JSON.stringify(body)
  });
  const resp = await res.json().catch(() => ({}));
  if (!res.ok || !resp.reportId) {
    throw new Error(`Report request failed (${res.status}): ${JSON.stringify(resp)}`);
  }
  return resp.reportId;
}

async function getReportStatus(accessToken, reportId) {
  const res = await fetch(`https://advertising-api.amazon.com/reporting/reports/${reportId}`, {
    headers: adsAuthHeaders(accessToken, {
      'Accept': 'application/vnd.getasyncreportrequest.v3+json'
    })
  });
  const resp = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Status check failed (${res.status}): ${JSON.stringify(resp)}`);
  }
  return resp;
}

async function downloadReport(url) {
  // The download URL is pre-signed — no auth headers needed.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const decompressed = await gunzipAsync(buffer);
  const text = decompressed.toString('utf-8');
  // V3 reports return a JSON array. Some tenants return NDJSON (one row per line);
  // handle either.
  try {
    return JSON.parse(text);
  } catch {
    return text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }
}

// Normalize an API row to our stored shape. Different report types return
// different column names; collapse to a common schema here so the client
// doesn't have to care.
function normalizeRows(rawRows, type) {
  if (!Array.isArray(rawRows)) return [];
  if (type === 'sp') {
    return rawRows.map(r => ({
      date:        (r.date || '').substring(0, 10),
      campaign:    r.campaignName || '',
      adGroup:     r.adGroupName || '',
      sku:         r.advertisedSku || '',
      asin:        r.advertisedAsin || '',
      cost:        num(r.cost),
      impressions: num(r.impressions),
      clicks:      num(r.clicks),
      purchases7d: num(r.purchases7d),
      sales7d:     num(r.sales7d)
    })).filter(r => r.date && r.campaign);
  }
  if (type === 'sb') {
    return rawRows.map(r => ({
      date:        (r.date || '').substring(0, 10),
      campaign:    r.campaignName || '',
      campaignId:  r.campaignId || '',
      cost:        num(r.cost),
      impressions: num(r.impressions),
      clicks:      num(r.clicks)
    })).filter(r => r.date && r.campaign);
  }
  return [];
}

async function storeMonthly(type, month, rows) {
  // Replace rather than merge: API-sourced data is authoritative for the
  // month. Merging would stack Sheets-migrated campaign-level rows on top
  // of API-delivered SKU-level rows and double-count totals. Re-pulling
  // the same month is expected to overwrite cleanly.
  await writeAdMonth(type, month, rows);

  const index = (await kv.get(`adspend:${type}:index`)) || [];
  if (!index.includes(month)) {
    index.push(month);
    index.sort();
    await kv.set(`adspend:${type}:index`, index);
  }

  // Track the latest daily date in this month's rows so the overview
  // page can render "Most Recent Ad Spend Data: 3/31/26" without
  // scanning every blob. Stored as a single dictionary key per type
  // keyed by YYYY-MM. In SQL mode the table answers this directly
  // (adspendSql.getLatestByMonth), so nothing is stored.
  if (adspendSql.adspendInSql()) return;
  let monthLatest = null;
  for (const r of rows) {
    const d = r?.date;
    if (d && (!monthLatest || d > monthLatest)) monthLatest = d;
  }
  if (monthLatest) {
    const map = (await kv.get(`adspend:${type}:latest-posted`)) || {};
    map[month] = monthLatest;
    await kv.set(`adspend:${type}:latest-posted`, map);
  }
}

// Best-effort dedupe: drop rows that match on the dimension fields and cost.
// Prevents duplicate entries if a sync pull overlaps an existing stored set.
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.date}|${r.campaign}|${r.sku || ''}|${r.adGroup || ''}|${r.cost}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function monthBoundDates(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const endExclusive = new Date(Date.UTC(y, m, 1));
  const endInclusive = new Date(endExclusive.getTime() - 86400000);
  const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start: ymd(start), end: ymd(endInclusive) };
}

function previousMonthISO() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// WEEKLY RED FLAG MONITOR
// ═════════════════════════════════════════════════════════════════════════════
// Implements Amazon_Ad_Management_Weekly.docx — the Tuesday cadence.
//
// OBSERVATIONAL ONLY. It reports; it never writes to Amazon and never adjusts
// anything. Adjustments belong to the bi-weekly cadence, and the separation is
// deliberate — do not add edit controls here.
//
// Two sources, and keeping them apart is the whole design:
//
//   CONFIGURATION — which campaigns exist, and their daily budget, state,
//                   brand and portfolio. Read from the Campaign Overview
//                   snapshot (adcampaigns:current). The reporting API has no
//                   column for any of it; asking it for configuration is what
//                   the previous implementation did, and it is why budgets and
//                   portfolios never worked.
//
//   PERFORMANCE   — cost, clicks, impressions, orders and sales per campaign
//                   per day. The 7-day week window and the 28-day trailing
//                   baseline abut, but v3 caps a report at MAX_REPORT_DAYS,
//                   and 35 is over it — so they go as separate requests, two
//                   per ad product. Nothing is stored between runs.
//
// The snapshot is the spine. Every enabled campaign in it is evaluated whether
// or not the report mentions it — a campaign with no report rows spent nothing
// that week, which is a fact rather than a gap. This is what makes the
// denominator knowable.
//
// Flow, client-driven because report generation takes 1–5+ minutes:
//   /api/adcampaigns?action=refresh  → freshen the census (step 0)
//   weekly-request                   → 2 report requests, returns reportIds
//   weekly-status                    → poll
//   weekly-collect                   → download, evaluate, return the note
//
// Persists nothing of its own — it reads adcampaigns:* and writes no KV key.
//
// Lives in this file rather than its own because Vercel's Hobby plan caps a
// deployment at 12 serverless functions. It shares the Advertising API client
// above but none of the adspend:* KV layout.

// ─── RF_CONFIG ───────────────────────────────────────────────────────────────
// Every threshold is from the cadence doc and is applied exactly — the doc's
// own words are "do not adjust for feel or context". Returned with each run so
// the output can be checked against the spec without reading this file.
const RF_CONFIG = {
  // 1 — budget cap emergencies
  CAP_DAY_RATIO:         0.95,  // a day counts as "at cap" at ≥ 95% of the daily budget
  CAP_DAYS_MIN:          4,     // ... on at least this many days of the week
  CAP_RETENTION_MIN:     0.50,  // ... and 28-day profit retention ≥ 50%
  RAISE_MIN:             0.25,  // suggested raise at CAP_DAYS_MIN days at cap
  RAISE_MAX:             0.50,  // ... rising to this when capped every day
  // 2 — silent portfolios
  SILENT_MIN_WEEKLY_IMPRESSIONS: 100,  // the portfolio averaged at least this many a week before
  // 3 — spend collapse
  COLLAPSE_RATIO:        0.50,  // 7-day spend at or below half the trailing weekly average
  COLLAPSE_MIN_BASELINE: 10,    // ... and a baseline worth collapsing from
  // 4 — CTR collapse
  CTR_COLLAPSE_RATIO:    0.50,  // week CTR at or below half the baseline
  CTR_MIN_IMPRESSIONS:   2000,  // ... on enough impressions to mean anything
  // 5 — CPC spike
  CPC_SPIKE_MULTIPLE:    1.50,  // week CPC at or above 1.5× the baseline
  CPC_MIN_CLICKS:        20,    // ... on enough clicks in both windows
  CUT_MIN:               0.10,  // suggested bid cut at the flagging threshold
  CUT_MAX:               0.25,  // ... rising to this at twice the threshold
  // 6 — brand pacing
  PACING_DEVIATION:      0.30   // brand spend ±30% of trailing weekly average
};

// DEVIATIONS FROM THE CADENCE DOC, recorded so they stay decisions rather than
// drift. The doc's four checks predate knowing that Amazon's 7-day attribution
// window leaves conversion data incomplete for the days closest to the run —
// which is fatal for a cadence whose whole value is speed.
const RF_SPEC_DEVIATIONS = [
  'Checks 2 (runaway spenders) and 3 (stalled campaigns) are removed. Both turn ' +
  'on conversion metrics, which Amazon leaves incomplete for 7 days after the ' +
  'click, biased downward — so on a fresh window they manufacture runaways and ' +
  'stalls. Profitability judgements belong to the bi-weekly cadence, where the ' +
  'data has settled.',

  'Four checks added that use only impressions, clicks and spend, all final the ' +
  'day they happen: silent portfolios, spend collapse, CTR collapse and CPC spike.',

  'Silent, spend collapse and CTR collapse are judged per portfolio, and a ' +
  'portfolio is one product. Their causes are the product and its competition, ' +
  'which reach every campaign at once; a single campaign moving is its own bids ' +
  'or targets, which Ad Badger manages, and is not listed.',

  'This cadence writes to Amazon. The doc has it observe only, with every ' +
  'adjustment left to the bi-weekly — but a budget cap and a CPC spike are both ' +
  'urgent and both cost money for the days they are left alone. Checks 1 and 5 ' +
  'each offer a one-click change: the budget raise steps 25% at four days at cap ' +
  'to 50% at seven, the bid cut 10% at 1.5x the usual CPC to 25% at 3x, both to ' +
  'the cent, and neither is written without a confirmation.',

  'Check 1 counts days at cap rather than time-in-budget, which Amazon exposes ' +
  'only in the console Budget Report. Its profit retention gate reads the 28-day ' +
  'baseline rather than the week: campaign economics are a standing property, ' +
  'and there is no fresher retention to be had.',

  'Every enabled campaign is evaluated; the doc excludes campaigns under $5 of ' +
  'weekly spend. The reports are pulled in full either way.',

  'Sponsored Brands is not evaluated. Two campaigns out of ~142, and its report ' +
  'was the slow one gating every run. SB is reviewed in the monthly cadence, ' +
  'which already has a dedicated section for it.'
];

// Tier 1 in the doc cuts straight to a $1 floor. It is staged here instead:
// -40% on one bad fortnight, -70% when the prior fortnight was bad too. These
// campaigns are volatile enough that one fortnight is not proof, and a floored
// campaign produces too little data to ever demonstrate a recovery. Repeated,
// -70% reaches the floor on its own.
const BW_SPEC_DEVIATIONS = [
  'Rows are sorted alphabetically by campaign name; the doc sorts by magnitude ' +
  'of change. The list is worked down with checkboxes rather than skimmed, and ' +
  'the naming convention already groups each brand together.',

  'Tier 1 stages its response rather than cutting straight to the $1 floor: ' +
  '-40% on a single bad fortnight, -70% when the prior fortnight was bad too. ' +
  'Repeated, that reaches the floor anyway, with a chance to recover at each step.',

  'Sponsored Brands is not evaluated. Its 14-day attribution window does not ' +
  'settle inside the 8-day lag this cadence uses, so retention would read low — and ' +
  'Tier 1 acts on exactly that. SB is reviewed monthly.',

  'Capped campaigns under 25% retention hold, per the strict first-match rule ' +
  'the doc states. The Tier 3 scope line ("not capped or retention too low to ' +
  'scale") could ' +
  'be read as sending them to a decrease instead; holding never cuts a budget on ' +
  'an interpretation.',

  'Budgets are kept to the cent. The doc rounds each new budget to the nearest ' +
  'dollar, which is immaterial at $50 and a different decision at $2 — a -15% ' +
  'step on a $9 budget became -22%. The $1 floor is unchanged.'
];

// Gross margin per MARGIN SEGMENT. Brand comes from the census — which already
// applies the prefix table AND any manual override set on the Campaign
// Overview page — so there is no second brand table here. Only the BrightWay
// split needs the campaign name: Packs and Sets have materially different
// economics and nothing else distinguishes them.
const MARGINS = {
  BW_PACKS:   0.38,
  BW_SETS:    0.51,
  BW_BLENDED: 0.45,
  HUBBARD:    0.52,
  MAPSHOP:    0.44,
  SOK:        0.39
};

const BRAND_SEGMENT = {
  'BrightWay Educational': 'BW_BLENDED',
  'Hubbard Scientific':    'HUBBARD',
  'MapShop State Maps':    'MAPSHOP',
  'South of Kings':        'SOK'
};

function rfSegment(brand, campaignName) {
  if (brand !== 'BrightWay Educational') return BRAND_SEGMENT[brand] || null;
  const up = String(campaignName || '').trim().toUpperCase();
  if (up.startsWith('MAP PACKS') || up.startsWith('BW PACK')) return 'BW_PACKS';
  if (up.startsWith('BW SET')) return 'BW_SETS';
  return 'BW_BLENDED';
}

// Metrics only. Name, status, budget, budget type and portfolio all come from
// the census, so none of them are requested here — which is also why there is
// no fallback ladder: a refused column now means a real problem worth stopping
// for, not a cue to silently run on less data.
const RF_COLUMNS = {
  sp: ['date', 'campaignId', 'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d']
  // No sb set: neither cadence requests a Sponsored Brands report any more.
};

// Amazon's v3 reporting API rejects a request whose date range exceeds this.
// It is the entire reason the week and the baseline cannot be one report: they
// are contiguous and total 35 days.
const MAX_REPORT_DAYS = 31;

// How far back each report type still HAS data, which is a separate limit from
// how long a single request may span, and differs by ad product. Read off
// Amazon's own refusals on 2026-09-11:
//
//   sp: "startDate (2026-06-01) must be equal to or after report type data
//        retention start date (2026-06-08)"   → 95 days
//   sb: "startDate (2026-07-01) ... (2026-07-13)"                → 60 days
//
// Only the monthly review reaches anywhere near these. The weekly and the
// bi-weekly never ask for anything older than about 36 days.
const REPORT_RETENTION_DAYS = { sp: 95, sb: 60 };

// The oldest date a report of this type can still cover.
function reportRetentionStart(product, nowInstant) {
  const days = REPORT_RETENTION_DAYS[product];
  if (!days) return null;
  return _addDays(_ptDate(nowInstant || new Date()), -days);
}

// Two windows, Sponsored Products only. Rows from both are pooled and binned
// by their own `date`, so the split is a transport detail rather than
// something the evaluation has to know about.
//
// SPONSORED BRANDS IS DELIBERATELY ABSENT. Two campaigns out of ~142, and its
// report is the slow one — it gated the whole run for 1.4% of the account. SB
// is reviewed monthly instead, where the doc already has a dedicated section
// for it with new-to-brand metrics and a 30-day window.
//
// If SB ever comes back, it must return to the SPINE as well as here: a census
// row with no report behind it reads as zero impressions and zero spend, which
// would flag both campaigns as silent and collapsed on every single run.
const REPORT_KEYS = ['spWeek', 'spBase'];

function reportSpec(key, window) {
  return key.endsWith('Week')
    ? { product: 'sp', start: window.weekStart, end: window.weekEnd }
    : { product: 'sp', start: window.baseStart, end: window.baseEnd };
}
const REPORT_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── WEEKLY REQUEST ──────────────────────────────────────────────────────────
// Fires the two report requests SEQUENTIALLY. v3 returns 425 for a duplicate
// createReport while an identical one is still running, and has been observed
// to false-positive when similar reports go out in the same tick.
async function handleWeeklyRequest(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const window = resolveWindow(new Date());
    const accessToken = await getAdsAccessToken();
    const reports = [];
    const failures = [];

    for (const key of REPORT_KEYS) {
      const spec = reportSpec(key, window);
      try {
        const r = await requestCampaignReport(accessToken, spec);
        reports.push({ key, ...r });
      } catch (err) {
        console.error(`[REDFLAGS REQUEST] ${key} failed:`, err.message);
        failures.push({
          key, error: err.message,
          window: `${spec.start}..${spec.end}`,
          invalidColumns: rfInvalidColumns(err.message)
        });
      }
      await sleep(600);
    }

    if (!reports.length) {
      // Amazon's reason goes in `error` as well as `failures`. A client that
      // reads only `error` on a non-2xx — which is the normal thing to do —
      // would otherwise show a generic sentence and drop the actual answer.
      return res.status(502).json({
        error: 'No report could be requested. ' + (failures[0] ? failures[0].error : ''),
        failures
      });
    }

    return res.status(200).json({
      success: true, window, reports, failures,
      requestedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[REDFLAGS REQUEST] Error:', error);
    return res.status(500).json({ error: 'Weekly-request failed: ' + error.message });
  }
}

// ─── WEEKLY STATUS ───────────────────────────────────────────────────────────
async function handleWeeklyStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const accessToken = await getAdsAccessToken();
    const statuses = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const norm = (status.status || '').toUpperCase();
        statuses.push({
          key, reportId, status: norm,
          done: norm === 'COMPLETED' || norm === 'SUCCESS',
          failed: norm === 'FAILURE' || norm === 'FAILED' || norm === 'CANCELLED'
        });
      } catch (err) {
        console.error(`[REDFLAGS STATUS] ${key} failed:`, err.message);
        statuses.push({ key, reportId, status: 'ERROR', done: false, failed: false, error: err.message });
      }
    }

    return res.status(200).json({
      success: true, statuses,
      allDone: statuses.every(s => s.done || s.failed),
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[REDFLAGS STATUS] Error:', error);
    return res.status(500).json({ error: 'Weekly-status failed: ' + error.message });
  }
}

// ─── WEEKLY COLLECT ──────────────────────────────────────────────────────────
async function handleWeeklyCollect(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const window = parseWindowParam(req.query);
    if (window.error) return res.status(400).json({ error: window.error });

    const census = await loadCensus();
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'the weekly check reads campaign budgets, brands and portfolios from it.'
      });
    }

    const accessToken = await getAdsAccessToken();
    const rows = [];
    const notes = [];

    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) {
          notes.push({ key, note: `report not ready (${status.status || 'unknown'})` });
          continue;
        }
        const raw = await withAdsRetry(() => downloadReport(url));
        rows.push(...rfNormalizeRows(raw, key.startsWith('sp') ? 'SP' : 'SB'));
      } catch (err) {
        console.error(`[REDFLAGS COLLECT] ${key} failed:`, err.message);
        notes.push({ key, note: 'download failed: ' + err.message });
      }
    }

    if (!rows.length) {
      return res.status(502).json({ error: 'No report rows could be downloaded.', notes });
    }

    const { inputs, orphanRows } = rfBuildInputs({ census, rows, window });
    // Stored: what the reports said. Never: what to do about it.
    await rfSaveRun(window, inputs);
    // The same rows also feed the continuous series. The baseline is four whole
    // settled weeks, which is the only place the recent end of that series can
    // come from: the month buckets are a month behind by construction.
    const weeksWritten = await whIngestWeeklyRun({ rows, census, window });

    const result = rfDecideAll({ inputs, census, window });
    result.coverage.orphanRows += orphanRows;
    result.flags = rfAttachNotes(result.flags, await rfLoadNotes(), window.weekStart);

    return res.status(200).json({
      success: true,
      window,
      config: RF_CONFIG,
      deviations: RF_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      ...result,
      notes,
      weeksWritten,
      collectedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[REDFLAGS COLLECT] Error:', error);
    return res.status(500).json({ error: 'Weekly-collect failed: ' + error.message });
  }
}

// The page's only read. The six checks are re-run every time from the stored
// metrics and the current census, so a budget or bid applied since the reports
// were pulled is reflected at once and nothing decided is ever written down.
async function handleWeeklyGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [run, census, logNotes] = await Promise.all([rfLoadRun(), loadCensus(), rfLoadNotes()]);
    if (!run) return res.status(200).json({ success: true, empty: true });
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'budgets, brands and bids are read from it on every load.'
      });
    }

    const result = rfPageResult({ run, census, logNotes });
    return res.status(200).json({
      success: true,
      window: run.window,
      config: RF_CONFIG,
      deviations: RF_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      collectedAt: run.collectedAt,
      ...result
    });
  } catch (error) {
    console.error('[REDFLAGS GET] Error:', error);
    return res.status(500).json({ error: 'Weekly-get failed: ' + error.message });
  }
}

// ─── CENSUS ──────────────────────────────────────────────────────────────────
// The campaign configuration snapshot written by the Campaign Overview page.
// Read-only: nothing here writes an adcampaigns:* key.
async function loadCensus() {
  const [current, portfolios, changes] = await Promise.all([
    kv.get('adcampaigns:current'),
    kv.get('adcampaigns:portfolios'),
    // What changed and when. Five of the six checks say something moved without
    // saying why, and the most common why is that we moved it ourselves.
    kv.get('adcampaigns:changes')
  ]);
  const portfolioNames = {};
  for (const p of (portfolios?.rows || [])) {
    if (p.portfolioId) portfolioNames[String(p.portfolioId)] = p.name;
  }
  return {
    campaigns: current?.rows || [],
    portfolioNames,
    changes: changes?.rows || [],
    syncedAt: current?.syncedAt || null
  };
}

// ─── WINDOW ──────────────────────────────────────────────────────────────────

// Most recent COMPLETE Monday–Sunday week in Pacific time, plus the 28 days
// immediately before it. "Complete" means strictly before today, so the
// Tuesday run evaluates the week that ended Sunday. Pacific because Vercel
// runs UTC while Ads report dates are marketplace-local — a UTC-naive window
// sits a day ahead between 00:00 and 08:00 UTC.
function resolveWindow(nowInstant) {
  const today = _ptDate(nowInstant);
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0=Sun … 6=Sat
  const back = dow === 0 ? 7 : dow;                       // → most recent past Sunday
  const weekEnd = _addDays(today, -back);
  const weekStart = _addDays(weekEnd, -6);
  const baseEnd = _addDays(weekStart, -1);
  const baseStart = _addDays(baseEnd, -27);
  return { weekStart, weekEnd, baseStart, baseEnd, asOf: today };
}

function parseWindowParam(q) {
  const window = {
    weekStart: String(q.weekStart || ''),
    weekEnd:   String(q.weekEnd   || ''),
    baseStart: String(q.baseStart || ''),
    baseEnd:   String(q.baseEnd   || '')
  };
  for (const [k, v] of Object.entries(window)) {
    if (!DATE_RE.test(v)) return { error: `${k} must be YYYY-MM-DD` };
  }
  if (daySpan(window.weekStart, window.weekEnd) !== 7) {
    return { error: 'week window must span exactly 7 days' };
  }
  if (daySpan(window.baseStart, window.baseEnd) !== 28) {
    return { error: 'baseline window must span exactly 28 days' };
  }
  if (_addDays(window.weekStart, -1) !== window.baseEnd) {
    return { error: 'baseline window must end the day before the week window starts' };
  }
  return window;
}

function daySpan(start, end) {
  const ms = new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z');
  return Math.round(ms / 86400000) + 1;
}

// ─── EVALUATE ────────────────────────────────────────────────────────────────
// Pure, so the whole cadence can be exercised offline against fixtures.
//
// Six checks. Five read only impressions, clicks and spend from the week —
// all final the day they happen. The sixth, check 1's retention gate, reads
// the 28-day baseline, which ends 8+ days before the run and is therefore
// past Amazon's 7-day attribution window and settled.
//
// Nothing in the WEEK window touches conversions. That is the property the
// whole cadence rests on, and it is worth preserving deliberately.
// Split for the same reason the bi-weekly is: reports are fetched once, by a
// cron at 4am, and the checks are re-run on every page load. Storing decisions
// is what made every stale-result bug on the other page.
//
//   rfBuildInputs  aggregates report rows, once per fetch
//   rfDecideAll    runs the six checks against them, on every read
//
// METRICS ONLY in the inputs. Budget, brand, bid and portfolio are joined from
// the census at decide time, so a budget applied since the reports were pulled
// shows up without the stored run knowing anything about it.
function rfBuildInputs({ census, rows, window }) {
  const enabled = new Set();
  for (const row of census.campaigns) {
    if (String(row.state || '').toUpperCase() !== 'ENABLED') continue;
    // Sponsored Brands is not reported here, so it must not be in the spine
    // either — a row with no report behind it looks silent and collapsed.
    if (row.adProduct !== 'SP') continue;
    enabled.add(String(row.campaignId));
  }

  const byId = new Map();
  const dayKey = new Map();
  let orphanRows = 0;
  for (const r of rows) {
    if (!enabled.has(r.campaignId)) { orphanRows++; continue; }
    let c = byId.get(r.campaignId);
    if (!c) {
      c = { campaignId: r.campaignId,
            spend7: 0, clicks7: 0, impressions7: 0,
            spend28: 0, clicks28: 0, impressions28: 0, sales28: 0,
            daily7: [] };
      byId.set(r.campaignId, c);
    }
    if (r.date >= window.weekStart && r.date <= window.weekEnd) {
      c.spend7 += r.cost; c.clicks7 += r.clicks; c.impressions7 += r.impressions;
      const k = r.campaignId + '|' + r.date;
      dayKey.set(k, (dayKey.get(k) || 0) + r.cost);
    } else if (r.date >= window.baseStart && r.date <= window.baseEnd) {
      c.spend28 += r.cost; c.clicks28 += r.clicks;
      c.impressions28 += r.impressions; c.sales28 += r.sales;
    }
  }
  for (const [k, spend] of dayKey) {
    const c = byId.get(k.slice(0, k.indexOf('|')));
    if (c) c.daily7.push(r2(spend));
  }

  // A campaign the report never mentioned still needs a row: it spent nothing,
  // which is a fact about the week and is what the silent check exists to find.
  for (const id of enabled) {
    if (!byId.has(id)) {
      byId.set(id, { campaignId: id, spend7: 0, clicks7: 0, impressions7: 0,
                     spend28: 0, clicks28: 0, impressions28: 0, sales28: 0, daily7: [] });
    }
  }

  for (const c of byId.values()) {
    c.spend7 = r2(c.spend7); c.clicks7 = Math.round(c.clicks7);
    c.impressions7 = Math.round(c.impressions7);
    c.spend28 = r2(c.spend28); c.clicks28 = Math.round(c.clicks28);
    c.impressions28 = Math.round(c.impressions28); c.sales28 = r2(c.sales28);
  }
  return { inputs: [...byId.values()], orphanRows };
}

function rfDecideAll({ inputs, census, window }) {
  // Always the window's length, never how many days Amazon returned rows for.
  const weekDays = daySpan(window.weekStart, window.weekEnd);

  // Configuration comes from the census on every read, never from the stored
  // run — so a budget or bid changed since the fetch is reflected at once.
  const config = new Map();
  for (const row of (census.campaigns || [])) config.set(String(row.campaignId), row);

  const campaigns = new Map();
  let orphanRows = 0;
  for (const i of inputs) {
    const row = config.get(String(i.campaignId));
    if (!row || String(row.state || '').toUpperCase() !== 'ENABLED' || row.adProduct !== 'SP') {
      orphanRows++;
      continue;
    }
    const brand = row.brand || null;
    const segment = brand ? rfSegment(brand, row.name) : null;
    campaigns.set(String(i.campaignId), {
      ...i,
      name: row.name || '',
      adProduct: row.adProduct || '',
      dailyBudget: typeof row.dailyBudget === 'number' ? row.dailyBudget : null,
      budgetType: row.budgetType || '',
      portfolioId: row.portfolioId || null,
      portfolio: (row.portfolioId && census.portfolioNames[row.portfolioId]) || null,
      // Only used to explain silence: an enabled campaign past its end date
      // serves nothing, and that is the whole answer rather than a lead.
      endDate: row.endDate || null,
      // The bid lever. adGroupId travels with it because the write goes to the
      // ad group, not the campaign.
      defaultBid: typeof row.defaultBid === 'number' ? row.defaultBid : null,
      adGroupId: row.adGroupId || null,
      brand,
      segment,
      grossMargin: segment ? MARGINS[segment] : null
    });
  }

  // ── derived ──
  for (const c of campaigns.values()) {
    c.baselineWeekly = r2(c.spend28 / 4);

    // Profit retention, from the BASELINE and labelled as such wherever it is
    // shown. Campaign economics are a standing property — price, cost, fees,
    // competitive conversion rate — not a weekly event, so a 28-day read is
    // both settled and a larger sample. There is no fresher retention to be
    // had; the alternative is none at all.
    c.acos28 = c.sales28 > 0 ? r4(c.spend28 / c.sales28) : null;
    // null, never 0, when it cannot be computed: an unmapped brand has no
    // margin and a campaign with no sales has no ACoS. Treating either as zero
    // retention would read as maximally unprofitable.
    c.retention28 = (c.grossMargin && c.acos28 !== null)
      ? r4((c.grossMargin - c.acos28) / c.grossMargin)
      : null;

    // Rates. Weekly and baseline, both conversion-free.
    c.ctr7  = c.impressions7  > 0 ? r4(c.clicks7  / c.impressions7)  : null;
    c.ctr28 = c.impressions28 > 0 ? r4(c.clicks28 / c.impressions28) : null;
    c.cpc7  = c.clicks7  > 0 ? r2(c.spend7  / c.clicks7)  : null;
    c.cpc28 = c.clicks28 > 0 ? r2(c.spend28 / c.clicks28) : null;

    // Days at cap. Amazon treats the daily budget as an average across the
    // month, so a campaign with real demand overshoots on some days and is
    // pulled back on others; a week total hides that. A day OVER budget counts
    // as at cap — under a lost-serving-time reading it would not, since Amazon
    // kept serving, but the question here is whether demand exceeded the
    // budget, and an overshoot is the strongest evidence that it did.
    //
    // Days with no report row had no spend, so they cannot reach the threshold
    // and are correctly absent.
    //
    // A LIFETIME budget has no daily ceiling to be at, so it is skipped rather
    // than measured wrong. An absent budgetType is treated as daily, which is
    // what Sponsored Products returns for effectively every campaign.
    const lifetime = /LIFETIME/i.test(c.budgetType);
    if (c.dailyBudget > 0 && !lifetime) {
      const atCap = c.dailyBudget * RF_CONFIG.CAP_DAY_RATIO;
      let days = 0;
      let peak = 0;
      for (const daySpend of (c.daily7 || [])) {
        if (daySpend >= atCap) days++;
        if (daySpend > peak) peak = daySpend;
      }
      c.cappedDays = days;
      c.maxDaySpend = r2(peak);
    } else {
      c.cappedDays = null;
      c.maxDaySpend = null;
    }
  }

  const flags = {
    budgetCap: [], silent: [], spendCollapse: [],
    ctrCollapse: [], cpcSpike: [], brandPacing: []
  };

  const base = (c) => ({
    campaignId: c.campaignId, campaign: c.name,
    adProduct: c.adProduct, brand: c.brand
  });

  for (const c of campaigns.values()) {

    // ── 1 · Budget cap emergencies ──
    // Current trigger, standing filter: the campaign is pressed against its
    // ceiling THIS week, and is a kind of campaign worth feeding.
    if (c.cappedDays !== null && c.cappedDays >= RF_CONFIG.CAP_DAYS_MIN &&
        c.retention28 !== null && c.retention28 >= RF_CONFIG.CAP_RETENTION_MIN) {
      flags.budgetCap.push({
        ...base(c),
        dailyBudget: c.dailyBudget,
        cappedDays: c.cappedDays, weekDays,
        maxDaySpend: c.maxDaySpend,
        recommendedBudget: rfRecommendBudget({
          dailyBudget: c.dailyBudget, cappedDays: c.cappedDays,
          weekDays, maxDaySpend: c.maxDaySpend
        }),
        spend7: r2(c.spend7),
        acos28: c.acos28, retention28: c.retention28
      });
    }

    // Checks 2, 3 and 4 are judged per portfolio, below this loop.

    // ── 5 · CPC spike ──
    // Paying materially more per click than usual: competitive pressure, or
    // bid automation reaching. It is the leading indicator for the cap and
    // collapse checks — it shows up before it becomes a spend problem.
    if (c.clicks7 >= RF_CONFIG.CPC_MIN_CLICKS &&
        c.clicks28 >= RF_CONFIG.CPC_MIN_CLICKS &&
        c.cpc28 > 0 && c.cpc7 !== null &&
        c.cpc7 >= c.cpc28 * RF_CONFIG.CPC_SPIKE_MULTIPLE) {
      flags.cpcSpike.push({
        ...base(c),
        clicks7: Math.round(c.clicks7),
        spend7: r2(c.spend7),
        cpc7: c.cpc7, cpc28: c.cpc28,
        change: r4((c.cpc7 - c.cpc28) / c.cpc28),
        defaultBid: c.defaultBid,
        adGroupId: c.adGroupId,
        recommendedBid: rfRecommendBid({ defaultBid: c.defaultBid, cpc7: c.cpc7, cpc28: c.cpc28 })
      });
    }
  }

  // ── 2, 3, 4 · Silent, spend collapse, CTR collapse — per portfolio ──
  const byPortfolio = new Map();
  let noPortfolio = 0;
  for (const c of campaigns.values()) {
    if (!c.portfolioId) { noPortfolio++; continue; }
    if (!byPortfolio.has(c.portfolioId)) {
      byPortfolio.set(c.portfolioId, { portfolio: c.portfolio, members: [] });
    }
    byPortfolio.get(c.portfolioId).members.push(c);
  }
  for (const [portfolioId, p] of byPortfolio) {
    const f = rfPortfolioFlags({ members: p.members, portfolioId, portfolio: p.portfolio, window });
    if (f.silent) flags.silent.push(f.silent);
    if (f.spendCollapse) flags.spendCollapse.push(f.spendCollapse);
    if (f.ctrCollapse) flags.ctrCollapse.push(f.ctrCollapse);
  }

  // ── 6 · Brand pacing ──
  // The only account-level check, and structurally the soundest: it aggregates
  // 30-40 campaigns, so it is the least noisy thing here. Pure spend.
  const brands = new Map();
  for (const c of campaigns.values()) {
    if (!c.brand) continue;
    let b = brands.get(c.brand);
    if (!b) { b = { brand: c.brand, spend7: 0, spend28: 0, members: [] }; brands.set(c.brand, b); }
    b.spend7 += c.spend7;
    b.spend28 += c.spend28;
    // Kept so a brand-level move can name the campaigns that caused it. A
    // deviation with no attribution is a prompt to go looking, which is the
    // thing this page exists to avoid.
    b.members.push({ campaign: c.name, adProduct: c.adProduct,
                     delta: c.spend7 - c.baselineWeekly });
  }
  for (const b of brands.values()) {
    const baselineWeekly = r2(b.spend28 / 4);
    // No baseline means no deviation to measure — a brand that spent nothing
    // for 28 days and something this week is a launch, not a pacing problem.
    if (baselineWeekly <= 0) continue;
    const deviation = r4((b.spend7 - baselineWeekly) / baselineWeekly);
    if (Math.abs(deviation) > RF_CONFIG.PACING_DEVIATION) {
      // The campaigns that account for the move, largest first, in the same
      // direction as the move. Three is enough to explain a brand.
      const drivers = b.members
        .filter(m => (deviation > 0 ? m.delta > 0 : m.delta < 0))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
        .slice(0, 3)
        .map(m => ({ campaign: m.campaign, adProduct: m.adProduct, delta: r2(m.delta) }));
      flags.brandPacing.push({
        brand: b.brand, spend7: r2(b.spend7), baselineWeekly, deviation, drivers
      });
    }
  }

  flags.budgetCap.sort((a, b) => b.spend7 - a.spend7);
  flags.silent.sort((a, b) => b.baselineWeekly - a.baselineWeekly);
  flags.spendCollapse.sort((a, b) => a.change - b.change);
  flags.ctrCollapse.sort((a, b) => a.change - b.change);
  flags.cpcSpike.sort((a, b) => b.change - a.change);
  flags.brandPacing.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

  const flagCount = Object.values(flags).reduce((n, list) => n + list.length, 0);

  // The run's own receipt. Not a report of healthy campaigns — one line saying
  // what the denominator was, so a run that silently covers half the account
  // cannot look identical to a clean week.
  const all = [...campaigns.values()];
  const enabled = all.length;
  const withSpend = all.filter(c => c.spend7 > 0).length;
  // Campaigns that have never run at all. Not flagged: dormant is a config
  // cleanup job, not a weekly emergency, and reporting the same 60 campaigns
  // every week would bury the ones that actually broke.
  const neverActive = all.filter(c => c.impressions7 === 0 && c.impressions28 === 0).length;

  // Lists are limited to campaigns that actually spent: a dormant campaign
  // with no brand cannot affect any check, and naming it is just noise.
  const unmapped = all
    .filter(c => c.spend7 > 0 && !c.brand)
    .map(c => ({ campaign: c.name, adProduct: c.adProduct, spend7: r2(c.spend7) }))
    .sort((a, b) => b.spend7 - a.spend7);
  // Campaigns check 1 could not look at: no daily budget in the snapshot, or a
  // lifetime budget, which has no daily ceiling to be capped against.
  const noBudget = all
    .filter(c => c.spend7 > 0 && c.cappedDays === null)
    .map(c => ({ campaign: c.name, adProduct: c.adProduct, spend7: r2(c.spend7),
                 reason: /LIFETIME/i.test(c.budgetType) ? 'lifetime budget' : 'no daily budget' }))
    .sort((a, b) => b.spend7 - a.spend7);

  return {
    flags,
    flagCount,
    clean: flagCount === 0,
    coverage: { enabled, evaluated: enabled, withSpend, neverActive,
                orphanRows, unmapped, noBudget,
                portfolios: byPortfolio.size, noPortfolio }
  };
}

function evaluateWeek({ census, rows, window }) {
  const { inputs, orphanRows } = rfBuildInputs({ census, rows, window });
  const result = rfDecideAll({ inputs, census, window });
  result.coverage.orphanRows += orphanRows;
  result.inputs = inputs;
  return result;
}

// ─── INVESTIGATION NOTES ─────────────────────────────────────────────────────
// What you found when you looked into a flag. The checks can say a product
// moved; only you can say it was an FBA stock-out with FBM stock still up and
// the Prime badge gone. Written down, that turns a weekly alarm into a history
// of why each product dipped.
//
// Keyed by portfolio and week, not by flag. Flags are re-decided on every read
// and have no identity of their own to hang a note on, while "this product,
// this week" is stable, and is the question a note actually answers. A stock-out
// explains a spend collapse and a CTR collapse on the same product equally.
//
// A note belongs to the week it was written. The next week's flag on the same
// portfolio shows the most recent earlier note as context rather than inheriting
// it: an ongoing stock-out needs no retyping, and a new cause on a product with
// an old note is not hidden behind the old explanation.
//
// User-authored, so it is stored as written. The run store holds measurements
// and never decisions; a note is neither, and is joined onto flags on read.

const RF_NOTES_KEY = 'weekly:notes';
const RF_NOTE_MAX = 1000;

const rfNoteKey = (portfolioId, weekStart) => `${String(portfolioId)}|${weekStart}`;

async function rfLoadNotes() {
  try {
    const stored = await kv.get(RF_NOTES_KEY);
    return (stored && stored.notes && typeof stored.notes === 'object') ? stored.notes : {};
  } catch (err) {
    // Notes are context. A failed read must not take the flags down with it.
    console.error('[REDFLAGS] notes load failed:', err.message);
    return {};
  }
}

// Pure. Adds `note`, this week's, and `priorNote`, the most recent earlier one,
// to each portfolio-level flag. Campaign-level flags are left exactly as they
// were: budget cap and CPC spike carry their own action, an apply button.
function rfAttachNotes(flags, notes, weekStart) {
  const byPortfolio = new Map();
  for (const n of Object.values(notes || {})) {
    if (!n || n.portfolioId === undefined || n.portfolioId === null || !n.weekStart) continue;
    const id = String(n.portfolioId);
    if (!byPortfolio.has(id)) byPortfolio.set(id, []);
    byPortfolio.get(id).push(n);
  }

  const attach = (row) => {
    const list = byPortfolio.get(String(row.portfolioId)) || [];
    const current = list.find(n => n.weekStart === weekStart) || null;
    // Strictly earlier weeks. A note written against a later week, which only
    // happens when an older run is read back, is not context for this one.
    const prior = list
      .filter(n => n.weekStart < weekStart)
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0] || null;
    return {
      ...row,
      note: current ? { text: current.text, updatedAt: current.updatedAt || null } : null,
      priorNote: prior
        ? { text: prior.text, weekStart: prior.weekStart, updatedAt: prior.updatedAt || null }
        : null
    };
  };

  return {
    ...flags,
    silent: (flags.silent || []).map(attach),
    spendCollapse: (flags.spendCollapse || []).map(attach),
    ctrCollapse: (flags.ctrCollapse || []).map(attach)
  };
}

// Saves, replaces or clears one note. An empty note clears it, which is how a
// note written against the wrong product is taken back.
//
// Read-modify-write on a single key. Two notes saved in the same instant could
// lose one; with notes written by hand a few times a week that is a trade worth
// making for one key instead of a key per note.
async function handleWeeklyNote(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const portfolioId = String(req.body?.portfolioId ?? '').trim();
    const weekStart = String(req.body?.weekStart || '').trim();
    const text = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    const portfolio = typeof req.body?.portfolio === 'string' ? req.body.portfolio.slice(0, 200) : null;

    if (!portfolioId) return res.status(400).json({ error: 'portfolioId required' });
    if (!DATE_RE.test(weekStart)) return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
    if (text.length > RF_NOTE_MAX) {
      return res.status(400).json({ error: `A note can be at most ${RF_NOTE_MAX} characters.` });
    }

    const stored = await kv.get(RF_NOTES_KEY);
    const notes = (stored && stored.notes && typeof stored.notes === 'object') ? { ...stored.notes } : {};
    const key = rfNoteKey(portfolioId, weekStart);

    if (!text) {
      delete notes[key];
    } else {
      notes[key] = {
        portfolioId, weekStart, text,
        // Kept for reading the log back later, if the portfolio is renamed or
        // archived. Nothing looks a note up by name.
        portfolio,
        updatedAt: new Date().toISOString()
      };
    }
    await kv.set(RF_NOTES_KEY, { notes });

    return res.status(200).json({ success: true, note: notes[key] || null });
  } catch (error) {
    console.error('[REDFLAGS NOTE] Error:', error);
    return res.status(500).json({ error: 'Weekly-note failed: ' + error.message });
  }
}

// The stored weekly run: what the reports said, nothing decided. The checks are
// re-run on every read, so a budget applied ten minutes ago or an edited
// threshold shows up without another report.
const RF_RUN_KEY = 'weekly:lastrun';

// What the weekly page shows for a stored run, decided from the census and
// notes as they are now. The page's read and the run history share it.
function rfPageResult({ run, census, logNotes }) {
  const result = rfDecideAll({ inputs: run.inputs, census, window: run.window });
  result.flags = rfAttachNotes(result.flags, logNotes, run.window.weekStart);
  return result;
}

async function rfSaveRun(window, inputs) {
  await acEnsureHistory();
  const run = { window, inputs, collectedAt: new Date().toISOString() };
  await kv.set(RF_RUN_KEY, run);
  await adHistoryRecordRun('weekly', run, async () => {
    const [census, logNotes] = await Promise.all([loadCensus(), rfLoadNotes()]);
    return {
      decisions: census.campaigns.length ? rfPageResult({ run, census, logNotes }) : null,
      context: { config: RF_CONFIG, censusSyncedAt: census.syncedAt }
    };
  });
}

// Adds a stored run to the permanent history (lib/adhistory.js) with what its
// page showed at that moment, when SQL_TABLES includes "adhistory". The pages
// never read the history: they still decide afresh on every load. decide()
// returns { decisions, context }. Never throws: a failure is logged and the
// run stays stored.
async function adHistoryRecordRun(cadence, run, decide) {
  if (!adHistory.historyEnabled()) return;
  try {
    await adHistory.recordRun(cadence, run, await decide());
  } catch (err) {
    console.error(`[AD HISTORY] ${cadence} run not recorded:`, err.message);
  }
}

async function rfLoadRun() {
  try {
    const run = await kv.get(RF_RUN_KEY);
    return (run && Array.isArray(run.inputs) && run.inputs.length) ? run : null;
  } catch (err) {
    console.error('[REDFLAGS] stored run load failed:', err.message);
    return null;
  }
}

// A capped campaign's real demand is unobservable — it was cut off before
// spending it. So this is a STEP, not a calculation, and it says so: raise in
// proportion to how often the budget bound, and never below a day the campaign
// has already proven it can spend.
//
// The floor matters because Amazon averages the daily budget across the month.
// A campaign that spent $28 on a $15 budget has demonstrated $28 of demand on
// that day; recommending $19 would be provably too low.
//
// Returns whole dollars. A recommendation of $18.73 reads as a calculation
// this cannot honestly claim to be.
// `minDays` is the day count at which the raise is its smallest. It defaults to
// the weekly threshold; the monthly Sponsored Brands check passes its own,
// since four days is nothing in a month and would put every raise near the top.
function rfRecommendBudget({ dailyBudget, cappedDays, weekDays, maxDaySpend,
                             minDays = RF_CONFIG.CAP_DAYS_MIN }) {
  if (!(dailyBudget > 0) || cappedDays === null || cappedDays === undefined) return null;
  const span = Math.max(1, weekDays - minDays);
  const over = Math.max(0, Math.min(cappedDays, weekDays) - minDays);
  const step = RF_CONFIG.RAISE_MIN +
               (RF_CONFIG.RAISE_MAX - RF_CONFIG.RAISE_MIN) * (over / span);
  const raised = Math.max(dailyBudget * (1 + step), maxDaySpend || 0);
  // Cents, because the step is meant to be the step. Rounding up to whole
  // dollars used to add up to $0.99 on top, which is nothing on a $50 budget
  // and a second raise on a $2 one — a 50% step became 100% at $1.
  const cents = Math.round(raised * 100) / 100;
  // Never return the budget it already has — an "apply" that changes nothing
  // is worse than no button.
  return cents > dailyBudget ? cents : null;
}

// The mirror of rfRecommendBudget, and a step for the same reason: what a lower
// bid will actually cost per click is an auction outcome, not arithmetic. Bids
// and CPC are not even the same quantity — dynamic bidding and placement
// modifiers let the effective bid exceed the base one, so a campaign can pay
// more per click than its bid.
//
// Cutting by the full overshoot would be the naive move and would usually
// overshoot in the other direction, dropping the campaign out of the auction
// entirely. So: 10% at the flagging threshold, rising to 25% at twice it.
//
// Returns cents. Amazon's floor is $0.02, and a recommendation equal to the
// current bid is a no-op write, which is worse than no button.
function rfRecommendBid({ defaultBid, cpc7, cpc28 }) {
  if (!(defaultBid > 0) || !(cpc28 > 0) || !(cpc7 > 0)) return null;
  const overshoot = cpc7 / cpc28;
  if (overshoot < RF_CONFIG.CPC_SPIKE_MULTIPLE) return null;
  const span = RF_CONFIG.CPC_SPIKE_MULTIPLE;   // threshold → twice threshold
  const over = Math.min(overshoot - RF_CONFIG.CPC_SPIKE_MULTIPLE, span);
  const cut = RF_CONFIG.CUT_MIN + (RF_CONFIG.CUT_MAX - RF_CONFIG.CUT_MIN) * (over / span);
  const bid = Math.max(0.02, Math.round(defaultBid * (1 - cut) * 100) / 100);
  return bid < defaultBid ? bid : null;
}

// spend = impressions × CTR × CPC. All three are attribution-free and we hold
// both windows, so a collapse can name its own cause instead of sending you to
// look. Which factor moved decides WHERE the fix is — an impressions drop is a
// listing or Buy Box problem, a CPC drop is a bidding one.
// ─── PORTFOLIO CHECKS ────────────────────────────────────────────────────────
// Silent, spend collapse and CTR collapse are judged per PORTFOLIO, and every
// campaign in a portfolio advertises the same product.
//
// That grouping is what makes their guidance true. Anything about the product
// itself, its stock, Buy Box, suppression, price, main image, reviews, or the
// competition beside it, reaches every campaign advertising it at once.
// Anything about one campaign's own bids or targets reaches only that campaign,
// and that layer is Ad Badger's until the keyword census exists. So these checks
// ask whether the PRODUCT moved. A lone campaign moving is not listed: the page
// has no data on the cause and nothing to do about it.
//
// Silent is broad by construction, every campaign at zero. Spend and
// click-through are totals, which one large campaign can drag below the line on
// its own and so put product guidance on a one-campaign problem. Those two also
// have to hold after removing whichever campaign accounts for most of the drop.

function rfPortfolioTotals(members) {
  const t = { campaigns: members.length, spend7: 0, spend28: 0,
              impressions7: 0, impressions28: 0, clicks7: 0, clicks28: 0 };
  for (const c of members) {
    t.spend7 += c.spend7;             t.spend28 += c.spend28;
    t.impressions7 += c.impressions7; t.impressions28 += c.impressions28;
    t.clicks7 += c.clicks7;           t.clicks28 += c.clicks28;
  }
  t.baselineWeekly = t.spend28 / 4;
  t.ctr7  = t.impressions7  > 0 ? t.clicks7  / t.impressions7  : null;
  t.ctr28 = t.impressions28 > 0 ? t.clicks28 / t.impressions28 : null;
  t.cpc7  = t.clicks7  > 0 ? t.spend7  / t.clicks7  : null;
  t.cpc28 = t.clicks28 > 0 ? t.spend28 / t.clicks28 : null;
  return t;
}

// The same thresholds the per-campaign checks used, applied to a total. Also
// applied to the remainder in the breadth test, so "the rest still collapsed"
// has to clear the same bar for enough data as the whole portfolio did.
function rfSpendCollapsed(t) {
  return t.baselineWeekly >= RF_CONFIG.COLLAPSE_MIN_BASELINE &&
         t.spend7 <= t.baselineWeekly * RF_CONFIG.COLLAPSE_RATIO;
}

function rfCtrCollapsed(t) {
  return t.impressions7 >= RF_CONFIG.CTR_MIN_IMPRESSIONS &&
         t.ctr28 > 0 && t.ctr7 !== null &&
         t.ctr7 <= t.ctr28 * RF_CONFIG.CTR_COLLAPSE_RATIO;
}

// Every member except the one contributing most to a fall. A one-campaign
// portfolio has no remainder, so breadth can never be shown there and nothing
// is flagged: with one campaign, product and targeting cannot be told apart.
function rfWithoutLargest(members, contribution) {
  if (members.length < 2) return [];
  let top = 0;
  for (let i = 1; i < members.length; i++) {
    if (contribution(members[i]) > contribution(members[top])) top = i;
  }
  return members.filter((_, i) => i !== top);
}

function rfPortfolioBrand(members) {
  const counts = new Map();
  for (const c of members) if (c.brand) counts.set(c.brand, (counts.get(c.brand) || 0) + 1);
  let best = null;
  let most = 0;
  for (const [b, n] of counts) if (n > most) { best = b; most = n; }
  return best;
}

// Pure. `members` are fully derived campaign rows from rfDecideAll.
function rfPortfolioFlags({ members, portfolioId, portfolio, window }) {
  const out = { silent: null, spendCollapse: null, ctrCollapse: null };
  if (!members || !members.length) return out;

  const t = rfPortfolioTotals(members);
  const head = {
    portfolioId, portfolio: portfolio || null,
    brand: rfPortfolioBrand(members), campaigns: members.length
  };

  // ── 2 · Silent ──
  // Every campaign at zero, after the product was genuinely advertising. One
  // stray impression in a month used to be enough to count as "running".
  const allZero = members.every(c => c.impressions7 === 0);
  if (allZero) {
    const funded = members.some(c => c.dailyBudget > 0);
    const wasAdvertising = t.impressions28 / 4 >= RF_CONFIG.SILENT_MIN_WEEKLY_IMPRESSIONS;
    if (funded && wasAdvertising) {
      // Every campaign past its end date explains the silence outright.
      const ends = members.map(c => c.endDate);
      const allEnded = ends.every(d => d && d < window.weekStart);
      out.silent = {
        ...head,
        baselineWeekly: r2(t.baselineWeekly),
        baselineImpressions: Math.round(t.impressions28),
        endedBefore: allEnded ? ends.slice().sort().pop() : null
      };
    }
    // A portfolio at zero is silent or too small to matter. Either way it is
    // not also a spend collapse or a CTR collapse worth a second row.
    return out;
  }

  // ── 3 · Spend collapse ──
  if (rfSpendCollapsed(t)) {
    const cause = rfDecomposeSpend(t);
    // Falling cost per click is bids, not the product, and bids are Badger's.
    const byBids = !!cause && cause.driver === 'cpc';
    const rest = rfWithoutLargest(members, c => c.spend28 / 4 - c.spend7);
    if (!byBids && rest.length && rfSpendCollapsed(rfPortfolioTotals(rest))) {
      out.spendCollapse = {
        ...head,
        spend7: r2(t.spend7),
        baselineWeekly: r2(t.baselineWeekly),
        change: r4((t.spend7 - t.baselineWeekly) / t.baselineWeekly),
        cause
      };
    }
  }

  // ── 4 · CTR collapse ──
  // A campaign's share of the drop is its click shortfall: the clicks it would
  // have had at its own usual rate, less the clicks it actually got.
  if (rfCtrCollapsed(t)) {
    const rest = rfWithoutLargest(members,
      c => (c.ctr28 !== null ? c.impressions7 * c.ctr28 : 0) - c.clicks7);
    if (rest.length && rfCtrCollapsed(rfPortfolioTotals(rest))) {
      out.ctrCollapse = {
        ...head,
        impressions7: Math.round(t.impressions7),
        clicks7: Math.round(t.clicks7),
        ctr7: r4(t.ctr7),
        ctr28: r4(t.ctr28),
        change: r4((t.ctr7 - t.ctr28) / t.ctr28)
      };
    }
  }

  return out;
}

function rfDecomposeSpend(c) {
  const weekly = (n) => n / 4;   // baseline is 28 days
  const ratio = (now, before) => (before > 0 ? r4(now / before) : null);
  const factors = [
    { factor: 'impressions', ratio: ratio(c.impressions7, weekly(c.impressions28)) },
    { factor: 'ctr',         ratio: ratio(c.ctr7, c.ctr28) },
    { factor: 'cpc',         ratio: ratio(c.cpc7, c.cpc28) }
  ].filter(f => f.ratio !== null);
  if (!factors.length) return null;
  // The biggest proportional fall is the driver. Ties do not matter: any of
  // them being this low is the thing worth looking at.
  const driver = factors.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  return { driver: driver.factor, ratio: driver.ratio, factors };
}

// ─── ROW NORMALIZATION ───────────────────────────────────────────────────────
// SP carries 7-day attribution and SB 14-day, matching what the console
// exports show and therefore what these numbers have always been read against.
// Each field reads the first present candidate: Amazon has revved column names
// before, and a silent zero is worse than a loud mismatch.
function rfNormalizeRows(rawRows, adProduct) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map(r => ({
    date:       String(rfPick(r, ['date', 'startDate']) || '').substring(0, 10),
    adProduct,
    campaignId: String(rfPick(r, ['campaignId']) || ''),
    cost:       num(rfPick(r, ['cost', 'spend'])),
    clicks:     num(rfPick(r, ['clicks'])),
    impressions: num(rfPick(r, ['impressions'])),
    orders:     num(rfPick(r, ['purchases7d', 'purchases', 'purchases14d'])),
    sales:      num(rfPick(r, ['sales7d', 'sales', 'sales14d'])),
    // Sponsored Brands only, and only when Amazon returned the columns. null
    // rather than 0 throughout: unknown is not the same as none, and the
    // Sponsored Products path simply never reads these.
    ntbOrders:  rfPick(r, ['newToBrandPurchases']) === undefined
                  ? null : num(rfPick(r, ['newToBrandPurchases'])),
    ntbSales:   rfPick(r, ['newToBrandSales']) === undefined
                  ? null : num(rfPick(r, ['newToBrandSales']))
  })).filter(r => r.date && r.campaignId);
}

function rfPick(row, keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
}

// ─── ADVERTISING API ─────────────────────────────────────────────────────────

function missingAdsCredentials() {
  return ['ADV_CLIENT_ID', 'ADV_CLIENT_SECRET', 'ADV_REFRESH_TOKEN', 'ADV_PROFILE_ID']
    .filter(k => !process.env[k]);
}

function buildReportBody(product, start, end, columns) {
  if (daySpan(start, end) > MAX_REPORT_DAYS) {
    // Caught here rather than at Amazon, where it surfaces as an opaque 4xx.
    throw new Error(`report window ${start}..${end} is ${daySpan(start, end)} days, ` +
                    `over Amazon's ${MAX_REPORT_DAYS}-day limit`);
  }
  // Past retention Amazon has nothing to give, and says so as an opaque 400
  // after the request has already cost quota. Named here instead.
  const floor = reportRetentionStart(product);
  if (floor && start < floor) {
    throw new Error(`report window ${start}..${end} starts before Amazon keeps ` +
                    `${product.toUpperCase()} report data, which reaches back ` +
                    `${REPORT_RETENTION_DAYS[product]} days to ${floor}`);
  }
  // RF_COLUMNS has no Sponsored Brands set any more, so an SB report must name
  // its own columns. Caught here rather than sending `columns: undefined`.
  const cols = columns || RF_COLUMNS[product];
  if (!Array.isArray(cols) || !cols.length) {
    throw new Error(`no column set for ${product} reports \u2014 pass one explicitly`);
  }
  return {
    name: `Ads ${product.toUpperCase()} ${start}..${end}`,
    startDate: start,
    endDate: end,
    configuration: {
      adProduct: product === 'sp' ? 'SPONSORED_PRODUCTS' : 'SPONSORED_BRANDS',
      groupBy: ['campaign'],
      columns: cols,
      reportTypeId: product === 'sp' ? 'spCampaigns' : 'sbCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON'
    }
  };
}

// One column set, no fallback. Every column here is a metric Amazon documents
// for this report type; a refusal means something changed and the run should
// say so rather than quietly proceed on less data.
async function requestCampaignReport(accessToken, { product, start, end, columns }) {
  const cols = columns || RF_COLUMNS[product];
  try {
    const reportId = await withAdsRetry(
      () => requestReport(accessToken, buildReportBody(product, start, end, cols))
    );
    return { reportId, columns: cols };
  } catch (err) {
    // 425 means an identical report is already generating. Adopting the id
    // Amazon names recovers a run that would otherwise be orphaned —
    // generating at Amazon with nothing left able to poll it, and blocking
    // every retry for as long as it lives.
    if (/\(425\)/.test(err.message)) {
      const adopted = rfDuplicateReportId(err.message);
      if (adopted) return { reportId: adopted, columns: cols, adopted: true };
    }
    throw err;
  }
}

// Amazon names the in-flight report in the 425 body, in one of two shapes:
//   {"detail":"The Request is a duplicate of : a886b6d8-62c7-4257-8a4f-..."}
//   {"reportId":"a886b6d8-..."}
// The prose form is the one production actually returns. Missing it meant
// every retry re-requested, got refused again, and left four live reports at
// Amazon that nothing could ever collect.
function rfDuplicateReportId(message) {
  const text = String(message || '');
  const m = text.match(/duplicate of\s*:?\s*([A-Za-z0-9._-]{8,80})/i) ||
            text.match(/"reportId"\s*:\s*"([^"]+)"/);
  return (m && REPORT_ID_RE.test(m[1])) ? m[1] : null;
}

// Amazon's 400 body reads "configuration columns includes invalid values:
// (x). Allowed values: (...)" and then lists a hundred columns. The answer is
// the two words before the list.
function rfInvalidColumns(message) {
  const m = String(message || '').match(/includes invalid values:\s*\(([^)]*)\)/i);
  if (!m) return [];
  return m[1].split(',').map(x => x.trim()).filter(Boolean);
}

// Retry on throttling and transient server errors only. Never on 425 —
// retrying a duplicate guarantees another rejection — nor on a validation 4xx.
async function withAdsRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      const retryable = /\(429\)|\(5\d\d\)/.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(1000 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Report IDs are interpolated into an Amazon API URL, so they are validated
// before any fetch — an ID carrying path traversal would re-target an
// authenticated request at a different endpoint using the account credentials.
function parseReportsParam(raw, allowed = REPORT_KEYS) {
  if (!raw) return { error: 'reports parameter required (key:reportId,...)' };
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { error: 'reports parameter is empty' };
  if (parts.length > allowed.length) return { error: 'too many report IDs' };

  const reports = [];
  const seen = new Set();
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 1) return { error: `malformed report entry: ${part}` };
    const key = part.slice(0, idx);
    const reportId = part.slice(idx + 1);
    if (!allowed.includes(key)) return { error: `unknown report key: ${key}` };
    if (seen.has(key)) return { error: `duplicate report key: ${key}` };
    if (!REPORT_ID_RE.test(reportId)) return { error: `invalid report id for ${key}` };
    seen.add(key);
    reports.push({ key, reportId });
  }
  return { reports };
}

// UTC instant → 'YYYY-MM-DD' in America/Los_Angeles.
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

// Derived ratios are rounded before comparison — otherwise a deviation that
// should be exactly 0.30 lands at 0.30000000000000004 and trips a ">30%" rule.
function r4(n) { return Math.round(n * 10000) / 10000; }
function r2(n) { return Math.round(n * 100) / 100; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Exported for the offline cadence tests. Vercel only invokes the default
// export, so these are inert in production.

// ═════════════════════════════════════════════════════════════════════════════
// BI-WEEKLY TACTICAL BUDGET MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════
// Implements Amazon_Ad_Management_BiWeekly.docx — the Thursday, every-other-week
// cadence. Unlike the weekly, this one ACTS: every enabled campaign gets one of
// Increase, Decrease, Hold or Cut, and the page can write them.
//
// THE WINDOW IS LAGGED BY DESIGN. Amazon credits a sale to the click date and
// leaves it incomplete for 7 days, biased downward. The weekly could live with
// that because it only observed. This cadence cuts campaigns to a $1 floor on
// "zero orders", so a fresh window would floor healthy campaigns whose orders
// simply had not landed. The 14 days evaluated therefore END 8 DAYS AGO, and
// every day in them is past its attribution window.
//
// The prior 14 days come along for "trending down", so the whole pull is 28
// contiguous days — inside Amazon's 31-day report cap, one report per ad
// product.
//
// It reads the same census as the weekly for budgets, brands and portfolios,
// and writes through the same campaign update path. It stores one key of its
// own: the per-brand monthly posture.

// Every threshold is from the doc's Decision Tree section, applied in strict
// tier order, first match wins.
const BW_CONFIG = {
  LAG_DAYS:            8,     // days between the end of the window and today
  WINDOW_DAYS:         14,
  // Statistical significance floor, applied BEFORE the tiers
  MIN_SPEND:           10,    // "no increase or decrease if spend under $10..."
  MIN_ORDERS:          3,     // "...AND orders are under 3"
  // Tier 1 — hard stops
  T1_LOSS_SPEND:       20,    // spend > $20 AND retention < 0
  T1_NOORDER_SPEND:    15,    // spend > $15 AND zero orders
  // The doc cuts straight to a $1 floor. That is a 94% reduction on one
  // fortnight of evidence, and a floored campaign generates almost no data, so
  // it can never demonstrate a recovery — the cut becomes self-reinforcing.
  // Staged instead: a bad fortnight pulls back hard, a bad MONTH pulls back
  // harder. Repeated, -70% reaches the floor anyway ($17 → $5 → $2 → $1) with
  // a chance to recover at each step.
  T1_SINGLE:           -0.40, // the problem appeared this fortnight only
  T1_CONFIRMED:        -0.70, // ... and was there the fortnight before too
  FLOOR:               1,     // no budget ever rounds below this
  // Tier 2 — scale up, capped campaigns only
  T2_HIGH:             0.75,  // >= 75% retention
  T2_MID:              0.50,  // 50-74%
  T2_LOW:              0.25,  // 25-49%; below this, Hold even when capped
  // Tier 3 — scale down
  T3_BARELY:           0.10,  // 0-10% retention
  T3_WEAK:             0.25,  // 10-25%
  T3_MEDIOCRE:         0.50,  // 25-50% AND trending down
  // "Trending down" is undefined in the doc. Retention has to fall by more than
  // this against the prior 14 days, so ordinary week-to-week noise does not
  // trip a decrease.
  TRENDING_DOWN:       0.05,
  // Capped, carried over from the weekly: the doc asks for time-in-budget,
  // which Amazon exposes only in the console Budget Report.
  CAP_DAY_RATIO:       0.95,
  CAP_DAYS_MIN:        8     // of 14, the same proportion the weekly uses
};

// The ladders the monthly posture shifts along. "Scale brands get one tier of
// additional scaling (a 25-49% campaign that would normally get +15% gets
// +30%)"; constrain brands "skip Tier 2 increases and accept more aggressive
// Tier 3 decreases".
const BW_INCREASES = [0.15, 0.30, 0.50];
const BW_DECREASES = [0.15, 0.25, 0.40];

const BW_POSTURES = ['scale', 'hold', 'constrain'];
const BW_POSTURE_KEY = 'biweekly:posture';

// Sponsored Products only, for the reasons in the weekly's REPORT_KEYS note —
// plus one specific to this cadence: SB uses a 14-DAY attribution window, so
// the 8-day lag that settles SP leaves roughly six days of SB conversions
// still arriving. Retention would be understated, and Tier 1 cuts to $1 on
// exactly that. SB is reviewed monthly.
const BW_REPORT_KEYS = ['spBw'];

// ─── WINDOW ──────────────────────────────────────────────────────────────────
// Two 14-day halves, both fully attributed, ending LAG_DAYS before today.
function resolveBiweeklyWindow(nowInstant) {
  const today = _ptDate(nowInstant);
  const end = _addDays(today, -BW_CONFIG.LAG_DAYS);
  const start = _addDays(end, -(BW_CONFIG.WINDOW_DAYS - 1));
  const priorEnd = _addDays(start, -1);
  const priorStart = _addDays(priorEnd, -(BW_CONFIG.WINDOW_DAYS - 1));
  return { start, end, priorStart, priorEnd, asOf: today };
}

function bwReportSpec(key, window) {
  return {
    product: 'sp',
    // Both halves in one request: 28 contiguous days, under the 31-day cap.
    start: window.priorStart, end: window.end
  };
}

// ─── DECISION TREE ───────────────────────────────────────────────────────────
// Pure, and the whole point of the cadence. Every branch here is a line in the
// doc; nothing is inferred.
//
// `posture` is the brand's most recent monthly priority. Hold Steady is the
// documented default and means the standard tree, so a run with no monthly
// priorities behaves exactly as specified rather than approximating.
function bwDecide(c, posture = 'hold') {
  const cfg = BW_CONFIG;
  const decide = (action, pct, tier, reason) => ({ action, pct, tier, reason });
  // Tier 1 is still a distinct action from a Tier 3 decrease — "losing money"
  // reads differently from "underperforming" — it simply no longer goes
  // straight to the floor.
  const cut = (pct, tier, reason) => ({ action: 'cut', pct, tier, reason });

  // ── significance floor, before the tiers ──
  if (c.spend < cfg.MIN_SPEND && c.orders < cfg.MIN_ORDERS) {
    return decide('hold', 0, 'floor',
      'Insufficient data — review structurally in monthly, not here');
  }

  // ── Tier 1, hard stops ──
  // Confirmation means the same problem was present in the PRIOR fortnight, so
  // these campaigns have been failing for a month rather than a bad two weeks.
  // An absent prior half is never confirmation — a campaign that was not
  // running then has proved nothing.
  if (c.spend > cfg.T1_LOSS_SPEND && c.retention !== null && c.retention < 0) {
    const confirmed = c.priorRetention !== null && c.priorRetention < 0;
    return cut(confirmed ? cfg.T1_CONFIRMED : cfg.T1_SINGLE, 1,
      confirmed
        ? 'Below break-even two fortnights running — losing money on every ad sale'
        : 'Below break-even this fortnight — losing money on every ad sale');
  }
  if (c.spend > cfg.T1_NOORDER_SPEND && c.orders === 0) {
    // Zero prior orders only counts when the campaign was actually spending
    // then; otherwise "no orders" just means "not running".
    const confirmed = c.priorOrders === 0 && c.priorSpend > cfg.T1_NOORDER_SPEND;
    return cut(confirmed ? cfg.T1_CONFIRMED : cfg.T1_SINGLE, 1,
      confirmed
        ? 'No orders for a month — burning budget with nothing to show'
        : 'No orders this fortnight — burning budget with nothing to show');
  }

  // Retention drives Tiers 2 and 3, so a campaign without one cannot be placed.
  // An unmapped brand has no margin; a campaign with no sales has no ACoS.
  // Holding is the honest answer — treating unknown as 0% would land it in the
  // most aggressive decrease band.
  if (c.retention === null) {
    return decide('hold', 0, 4, 'No profit retention available — brand unmapped or no sales');
  }

  // ── Tier 2, scale up, capped only ──
  // A constrain brand skips this tier entirely, per the doc.
  if (c.capped && posture !== 'constrain') {
    let step = null;
    if (c.retention >= cfg.T2_HIGH) step = 2;
    else if (c.retention >= cfg.T2_MID) step = 1;
    else if (c.retention >= cfg.T2_LOW) step = 0;

    if (step === null) {
      return decide('hold', 0, 2, 'Capped but under 25% retention — not worth feeding');
    }
    // Scale brands get one tier of extra aggressiveness.
    const idx = Math.min(step + (posture === 'scale' ? 1 : 0), BW_INCREASES.length - 1);
    return decide('increase', BW_INCREASES[idx], 2,
      `Capped at ${Math.round(c.retention * 100)}% retention` +
      (posture === 'scale' && idx !== step ? ' — scale brand, one tier up' : ''));
  }

  // ── Tier 3, scale down ──
  let step = null;
  if (c.retention >= 0 && c.retention < cfg.T3_BARELY) step = 2;
  else if (c.retention >= cfg.T3_BARELY && c.retention < cfg.T3_WEAK) step = 1;
  else if (c.retention >= cfg.T3_WEAK && c.retention < cfg.T3_MEDIOCRE && c.trendingDown) step = 0;
  // Retention below zero that did not clear Tier 1's spend bar still belongs in
  // the most aggressive decrease band rather than falling through to Hold.
  else if (c.retention < 0) step = 2;

  if (step !== null) {
    const idx = Math.min(step + (posture === 'constrain' ? 1 : 0), BW_DECREASES.length - 1);
    const pct = BW_DECREASES[idx];
    const why = c.retention < 0 ? 'Below break-even'
              : step === 2 ? 'Barely profitable'
              : step === 1 ? 'Weak'
              : 'Mediocre and weakening';
    return decide('decrease', -pct, 3,
      `${why} at ${Math.round(c.retention * 100)}% retention` +
      (posture === 'constrain' && idx !== step ? ' — constrain brand, one tier down' : ''));
  }

  // ── Tier 4 ──
  return decide('hold', 0, 4,
    c.capped ? 'Healthy and capped, but posture is constrain'
             : 'Healthy retention and not capped');
}

// "Round to the nearest dollar (never round below the $1 floor)."
// $17.60, $10, never $10.00 — this reads inside a sentence.
function bwDollars(n) {
  return '$' + Number(n).toFixed(2).replace(/\.00$/, '');
}

function bwNewBudget(current, decision) {
  if (!(current > 0)) return null;
  if (decision.action === 'hold' || !decision.pct) return current;
  // Cents, so the step is the step. Rounding to the nearest dollar turned a
  // -15% decrease on a $9 budget into -22%, and the smaller the budget the
  // further the result sat from what the tree decided. The $1 floor stands:
  // that is a real minimum, not a rounding artefact.
  return Math.max(BW_CONFIG.FLOOR, Math.round(current * (1 + decision.pct) * 100) / 100);
}

// ─── EVALUATE ────────────────────────────────────────────────────────────────
// Every enabled campaign gets a row — the doc's output is the whole account,
// not a flag list. Pure, so the tree can be exercised against the doc offline.
// Split in two so the decision tree can be re-run without re-fetching reports.
// Reports are the expensive half - a queue that has run half an hour - and the
// tree is the half that keeps changing as thresholds and postures are tuned.
//
//   bwBuildInputs  aggregates report rows onto the census spine, once per run
//   bwDecideAll    applies the tree to those inputs, as often as you like
//
// The inputs are compact on purpose: everything the tree reads and nothing
// else, about 200 bytes a campaign, so a whole run travels in ~30KB.
function bwBuildInputs({ census, rows, window }) {
  const campaigns = new Map();
  for (const row of census.campaigns) {
    if (String(row.state || '').toUpperCase() !== 'ENABLED') continue;
    // No SB report is pulled, so SB must not be in the spine: a campaign with
    // no report behind it shows zero spend and zero orders, which trips the
    // significance floor and reads as "insufficient data" forever.
    if (row.adProduct !== 'SP') continue;
    // METRICS ONLY. Name, brand, budget and budget type are deliberately absent:
    // they are joined from the census at decide time, so a budget applied since
    // the run, a brand override, or a margin change is picked up without the
    // stored run knowing anything about it.
    campaigns.set(String(row.campaignId), {
      campaignId: String(row.campaignId),
      spend: 0, orders: 0, sales: 0, clicks: 0, impressions: 0,
      // The prior fortnight confirms (or fails to confirm) a Tier 1 problem,
      // so it needs orders as well as money.
      priorSpend: 0, priorSales: 0, priorOrders: 0,
      // Daily spends, values only. The dates do not matter to the capped-day
      // count, and keeping the raw values means the at-cap threshold can be
      // retuned on a recompute rather than being baked in here.
      daily: []
    });
  }

  let orphanRows = 0;
  const byDate = new Map();
  for (const r of rows) {
    const c = campaigns.get(r.campaignId);
    if (!c) { orphanRows++; continue; }
    if (r.date >= window.start && r.date <= window.end) {
      c.spend += r.cost; c.orders += r.orders; c.sales += r.sales;
      c.clicks += r.clicks; c.impressions += r.impressions;
      const key = c.campaignId + '|' + r.date;
      byDate.set(key, (byDate.get(key) || 0) + r.cost);
    } else if (r.date >= window.priorStart && r.date <= window.priorEnd) {
      c.priorSpend += r.cost; c.priorSales += r.sales; c.priorOrders += r.orders;
    }
  }
  for (const [key, spend] of byDate) {
    const c = campaigns.get(key.slice(0, key.indexOf('|')));
    if (c) c.daily.push(r2(spend));
  }

  for (const c of campaigns.values()) {
    c.spend = r2(c.spend); c.sales = r2(c.sales); c.orders = Math.round(c.orders);
    c.clicks = Math.round(c.clicks); c.impressions = Math.round(c.impressions);
    c.priorSpend = r2(c.priorSpend); c.priorSales = r2(c.priorSales);
    c.priorOrders = Math.round(c.priorOrders);
  }

  return { inputs: [...campaigns.values()], orphanRows };
}

// Every enabled campaign gets a row - the doc's output is the whole account,
// not a flag list. Pure, so the tree can be exercised against the doc offline
// and re-run against stored inputs without touching Amazon.
function bwDecideAll({ inputs, census, window, postures = {}, recentRaises = {},
                      adjusted = {} }) {
  const retentionOf = (margin, spend, sales) => {
    if (!margin || !(sales > 0)) return null;
    return r4((margin - spend / sales) / margin);
  };

  // Configuration comes from the census on every read, never from the stored
  // run. That is the whole point: budgets applied since the reports were
  // pulled, brand overrides and margin changes all take effect immediately,
  // and nothing decided is ever written down to go stale.
  const config = new Map();
  for (const row of (census?.campaigns || [])) {
    config.set(String(row.campaignId), row);
  }

  const out = [];
  for (const i of inputs) {
    const cfg = config.get(String(i.campaignId));
    // A campaign that has left the census cannot be judged: no budget to
    // change, no brand, no margin.
    if (!cfg || String(cfg.state || '').toUpperCase() !== 'ENABLED') continue;

    const name = cfg.name || '';
    const brand = cfg.brand || null;
    const segment = brand ? rfSegment(brand, name) : null;
    const grossMargin = segment ? MARGINS[segment] : null;

    const c = {
      ...i, name, brand, segment, grossMargin,
      adProduct: cfg.adProduct || '',
      dailyBudget: typeof cfg.dailyBudget === 'number' ? cfg.dailyBudget : null,
      budgetType: cfg.budgetType || '',
      portfolioId: cfg.portfolioId || null
    };
    c.acos = c.sales > 0 ? r4(c.spend / c.sales) : null;
    c.retention = retentionOf(grossMargin, c.spend, c.sales);
    c.priorRetention = retentionOf(grossMargin, c.priorSpend, c.priorSales);
    c.trendingDown = (c.retention !== null && c.priorRetention !== null) &&
                     (c.priorRetention - c.retention) > BW_CONFIG.TRENDING_DOWN;

    // Capped by days rather than a period total - a campaign clipped on eight
    // days and idle on six is constrained even though the fortnight is not.
    const lifetime = /LIFETIME/i.test(c.budgetType);
    if (c.dailyBudget > 0 && !lifetime) {
      const atCap = c.dailyBudget * BW_CONFIG.CAP_DAY_RATIO;
      c.cappedDays = (c.daily || []).filter(v => v >= atCap).length;
      c.capped = c.cappedDays >= BW_CONFIG.CAP_DAYS_MIN;
    } else {
      c.cappedDays = null;
      c.capped = false;
    }

    const posture = BW_POSTURES.includes(postures[c.brand]) ? postures[c.brand] : 'hold';
    // Already adjusted since these 14 days ended. That is its own status, not a
    // hold: a hold says the numbers argue for leaving it alone, and this says
    // the numbers are from before you changed it. No budget is offered, so the
    // row cannot be applied twice on the same evidence — the run can be made
    // weekly without any campaign being cut two weeks running.
    const change = adjusted[String(c.campaignId)] || null;
    const decision = change
      ? { action: 'adjusted', pct: 0, tier: 'adjusted',
          reason: `Budget changed ${bwDollars(change.from)} to ${bwDollars(change.to)} on ` +
                  `${change.ptDate}, after this window. Every day judged here is from ` +
                  'before that change.' }
      : bwDecide(c, posture);
    const newBudget = change ? null : bwNewBudget(c.dailyBudget, decision);
    const delta = (newBudget !== null && c.dailyBudget !== null) ? r2(newBudget - c.dailyBudget) : 0;

    out.push({
      campaignId: c.campaignId, campaign: c.name, adProduct: c.adProduct,
      brand: c.brand, posture,
      dailyBudget: c.dailyBudget,
      spend: c.spend, sales: c.sales, orders: c.orders,
      acos: c.acos, retention: c.retention,
      priorRetention: c.priorRetention, trendingDown: c.trendingDown,
      cappedDays: c.cappedDays, weekDays: BW_CONFIG.WINDOW_DAYS, capped: c.capped,
      action: decision.action, pct: decision.pct, tier: decision.tier,
      reason: decision.reason,
      adjusted: change,
      newBudget, delta,
      // The weekly can raise a budget on the same campaign from a different
      // window. Applying both compounds them, so a recent raise is surfaced
      // rather than left for you to remember.
      raisedRecently: recentRaises[c.campaignId] || null
    });
  }

  // A sensible default order for anything reading this payload directly. The
  // PAGE does its own sorting at render time and does not rely on this: order
  // baked in here would be frozen into every stored run, so a cached result
  // would keep whatever rule was in force when it was collected.
  out.sort((a, b) => String(a.campaign || '').localeCompare(String(b.campaign || ''),
                                                            'en', { numeric: true }));

  const counts = { increase: 0, decrease: 0, hold: 0, cut: 0, adjusted: 0 };
  for (const r of out) counts[r.action]++;

  // Brand summary. The doc asks for an SP/SB split, but with SB reviewed
  // monthly there is nothing to split.
  const brands = new Map();
  for (const r of out) {
    if (!r.brand) continue;
    let b = brands.get(r.brand);
    if (!b) { b = { brand: r.brand, posture: r.posture, spend: 0, sales: 0, orders: 0 }; brands.set(r.brand, b); }
    b.spend += r.spend; b.sales += r.sales; b.orders += r.orders;
  }
  const brandSummary = [...brands.values()].map(b => {
    const segment = BRAND_SEGMENT[b.brand] || null;
    const margin = segment ? MARGINS[segment] : null;
    return {
      brand: b.brand, posture: b.posture,
      spend: r2(b.spend), sales: r2(b.sales), orders: b.orders,
      acos: b.sales > 0 ? r4(b.spend / b.sales) : null,
      retention: retentionOf(margin, b.spend, b.sales)
    };
  }).sort((a, b) => b.spend - a.spend);

  return {
    rows: out, counts, brandSummary,
    coverage: {
      enabled: out.length,
      orphanRows: 0,
      unmapped: out.filter(r => !r.brand && r.spend > 0).length,
      noBudget: out.filter(r => r.dailyBudget === null).length
    }
  };
}

function evaluateBiweekly({ census, rows, window, postures = {}, recentRaises = {} }) {
  const { inputs, orphanRows } = bwBuildInputs({ census, rows, window });
  const result = bwDecideAll({ inputs, census, window, postures, recentRaises });
  result.coverage.orphanRows = orphanRows;
  result.inputs = inputs;
  return result;
}

// The stored run: what the reports said, and nothing else. Recommendations are
// never written down - they are computed on every read, so there is no cached
// decision that can disagree with the current rules.
const BW_RUN_KEY = 'biweekly:lastrun';

// What the bi-weekly page shows for a stored run, decided from the census
// and postures as they are now. The page's read and the run history share it.
function bwPageResult({ run, census, postures }) {
  return bwDecideAll({
    inputs: run.inputs, census, window: run.window, postures,
    recentRaises: bwRecentRaises(census.changes, run.window),
    adjusted: bwAdjustedAfter(census.changes, run.window.end)
  });
}

async function bwSaveRun(window, inputs, collectedAt) {
  await acEnsureHistory();
  const run = {
    window, inputs,
    collectedAt: collectedAt || new Date().toISOString(),
    adoptedAt: new Date().toISOString()
  };
  await kv.set(BW_RUN_KEY, run);
  await adHistoryRecordRun('biweekly', run, async () => {
    const [census, postures] = await Promise.all([loadCensus(), bwLoadPostures()]);
    return {
      decisions: census.campaigns.length ? bwPageResult({ run, census, postures }) : null,
      context: { config: BW_CONFIG, postures, censusSyncedAt: census.syncedAt }
    };
  });
}

// The most recent fetch, which may or may not be what the page is deciding
// from. Kept apart from the adopted run so fresh data never silently changes
// recommendations mid-fortnight.
const BW_AVAILABLE_KEY = 'biweekly:available';

async function bwSaveAvailable(window, inputs) {
  await kv.set(BW_AVAILABLE_KEY, { window, inputs, fetchedAt: new Date().toISOString() });
}

async function bwLoadAvailable() {
  try {
    const a = await kv.get(BW_AVAILABLE_KEY);
    return (a && Array.isArray(a.inputs) && a.inputs.length) ? a : null;
  } catch (err) {
    console.error('[BIWEEKLY] available load failed:', err.message);
    return null;
  }
}

// Adopts the latest fetch, every time there is one. The page always decides
// from the most recent 14 days rather than from whatever was current a
// fortnight ago. Returns whether it did, which is false only when the fetch
// itself produced nothing.
async function bwAdoptLatest() {
  const available = await bwLoadAvailable();
  if (!available) return false;
  await bwSaveRun(available.window, available.inputs, available.fetchedAt);
  return true;
}

async function bwLoadRun() {
  try {
    const run = await kv.get(BW_RUN_KEY);
    return (run && Array.isArray(run.inputs) && run.inputs.length) ? run : null;
  } catch (err) {
    console.error('[BIWEEKLY] stored run load failed:', err.message);
    return null;
  }
}



// Budget changes made AFTER the last day being judged, in either direction and
// from any source — this tool, either cadence, or Amazon's console, since the
// census diff sees them all. Every day in the window predates such a change, so
// the campaign has already been acted on and its row is locked for this run.
//
// Keyed by campaign, most recent change per campaign. A change on the window's
// last day is inside the window, not after it.
function bwAdjustedAfter(changes, windowEnd) {
  const out = {};
  if (!windowEnd) return out;
  for (const r of (changes || [])) {
    if (!r || r.field !== 'dailyBudget') continue;
    if (!(String(r.ptDate || '') > windowEnd)) continue;
    const from = Number(r.from), to = Number(r.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    const prev = out[String(r.campaignId)];
    if (!prev || String(r.ptDate) > prev.ptDate) {
      out[String(r.campaignId)] = { from, to, ptDate: String(r.ptDate) };
    }
  }
  return out;
}

// Budget raises this tool made in the last fortnight, so the bi-weekly can say
// so before recommending another. Read from the census change log, which
// records dashboard edits with source 'edit'.
function bwRecentRaises(changes, window) {
  const out = {};
  for (const r of (changes || [])) {
    if (!r || r.field !== 'dailyBudget') continue;
    if (String(r.ptDate || '') < window.priorStart) continue;
    const from = Number(r.from), to = Number(r.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const prev = out[String(r.campaignId)];
    if (!prev || String(r.ptDate) > prev.ptDate) {
      out[String(r.campaignId)] = { from, to, ptDate: r.ptDate };
    }
  }
  return out;
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleBiweeklyRequest(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const window = resolveBiweeklyWindow(new Date());
    const accessToken = await getAdsAccessToken();
    const reports = [];
    const failures = [];

    for (const key of BW_REPORT_KEYS) {
      const spec = bwReportSpec(key, window);
      try {
        const r = await requestCampaignReport(accessToken, spec);
        reports.push({ key, ...r });
      } catch (err) {
        console.error(`[BIWEEKLY REQUEST] ${key} failed:`, err.message);
        failures.push({ key, error: err.message, window: `${spec.start}..${spec.end}`,
                        invalidColumns: rfInvalidColumns(err.message) });
      }
      await sleep(600);
    }

    if (!reports.length) {
      return res.status(502).json({
        error: 'No report could be requested. ' + (failures[0] ? failures[0].error : ''),
        failures
      });
    }
    return res.status(200).json({ success: true, window, reports, failures,
                                  requestedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[BIWEEKLY REQUEST] Error:', error);
    return res.status(500).json({ error: 'Biweekly-request failed: ' + error.message });
  }
}

async function handleBiweeklyStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports, BW_REPORT_KEYS);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const accessToken = await getAdsAccessToken();
    const statuses = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const norm = (status.status || '').toUpperCase();
        statuses.push({ key, reportId, status: norm,
                        done: norm === 'COMPLETED' || norm === 'SUCCESS',
                        failed: norm === 'FAILURE' || norm === 'FAILED' || norm === 'CANCELLED' });
      } catch (err) {
        statuses.push({ key, reportId, status: 'ERROR', done: false, failed: false, error: err.message });
      }
    }
    return res.status(200).json({ success: true, statuses,
      allDone: statuses.every(s => s.done || s.failed), checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[BIWEEKLY STATUS] Error:', error);
    return res.status(500).json({ error: 'Biweekly-status failed: ' + error.message });
  }
}

async function handleBiweeklyCollect(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports, BW_REPORT_KEYS);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const window = {
      start: String(req.query.start || ''), end: String(req.query.end || ''),
      priorStart: String(req.query.priorStart || ''), priorEnd: String(req.query.priorEnd || '')
    };
    for (const [k, v] of Object.entries(window)) {
      if (!DATE_RE.test(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD` });
    }
    if (daySpan(window.start, window.end) !== BW_CONFIG.WINDOW_DAYS ||
        daySpan(window.priorStart, window.priorEnd) !== BW_CONFIG.WINDOW_DAYS) {
      return res.status(400).json({ error: `both windows must span exactly ${BW_CONFIG.WINDOW_DAYS} days` });
    }

    const [census, postures] = await Promise.all([loadCensus(), bwLoadPostures()]);
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'the tree reads budgets, brands and portfolios from it.'
      });
    }

    const accessToken = await getAdsAccessToken();
    const rows = [];
    const notes = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) { notes.push({ key, note: `report not ready (${status.status || 'unknown'})` }); continue; }
        const raw = await withAdsRetry(() => downloadReport(url));
        rows.push(...rfNormalizeRows(raw, key.startsWith('sp') ? 'SP' : 'SB'));
      } catch (err) {
        console.error(`[BIWEEKLY COLLECT] ${key} failed:`, err.message);
        notes.push({ key, note: 'download failed: ' + err.message });
      }
    }
    if (!rows.length) return res.status(502).json({ error: 'No report rows could be downloaded.', notes });

    const { inputs, orphanRows } = bwBuildInputs({ census, rows, window });
    // What the reports said is stored. What to do about it is not: that is
    // decided on every read, so it can never disagree with the current rules.
    await bwSaveRun(window, inputs);

    const result = bwDecideAll({
      inputs, census, window, postures,
      recentRaises: bwRecentRaises(census.changes, window),
      adjusted: bwAdjustedAfter(census.changes, window.end)
    });
    result.coverage.orphanRows = orphanRows;

    return res.status(200).json({
      success: true, window, config: BW_CONFIG, postures,
      deviations: BW_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt, ...result, notes,
      collectedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[BIWEEKLY COLLECT] Error:', error);
    return res.status(500).json({ error: 'Biweekly-collect failed: ' + error.message });
  }
}

// The page's only read. It decides afresh every time from the stored metrics,
// the current census, and the current postures — so a budget applied a minute
// ago, a posture just changed, or a threshold edited in this file all show up
// on the next load with no report and nothing to refresh.
//
// Nothing about a recommendation is ever persisted. Every stale-result bug this
// page had came from storing decisions; storing only the reports removes the
// category.
async function handleBiweeklyGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [run, census, postures, available] = await Promise.all([
      bwLoadRun(), loadCensus(), bwLoadPostures(), bwLoadAvailable()
    ]);
    if (!run) return res.status(200).json({ success: true, empty: true });
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'budgets, brands and portfolios are read from it on every load.'
      });
    }

    const result = bwPageResult({ run, census, postures });

    // Normally null: the cron adopts what it fetches, so the stored fetch and
    // the run are the same. Non-null means a fetch was stored but not adopted,
    // and the page offers the button that finishes it.
    const newer = available && Date.parse(available.fetchedAt) > Date.parse(run.collectedAt || 0)
      ? { fetchedAt: available.fetchedAt, window: available.window }
      : null;

    return res.status(200).json({
      success: true, window: run.window, config: BW_CONFIG, postures,
      deviations: BW_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      collectedAt: run.collectedAt,
      adoptedAt: run.adoptedAt,
      newer,
      ...result
    });
  } catch (error) {
    console.error('[BIWEEKLY GET] Error:', error);
    return res.status(500).json({ error: 'Biweekly-get failed: ' + error.message });
  }
}

// Adopts the most recent fetch on demand, which is what makes an off-cycle run
// possible: during a seasonal peak the doc moves a brand to weekly budget
// review, and this is that, without a special case in the schedule.
async function handleBiweeklyImport(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const available = await bwLoadAvailable();
    if (!available) {
      return res.status(200).json({ success: false, error: 'No newer data has been fetched yet.' });
    }
    await bwSaveRun(available.window, available.inputs, available.fetchedAt);
    return res.status(200).json({ success: true, window: available.window,
                                  collectedAt: available.fetchedAt });
  } catch (error) {
    console.error('[BIWEEKLY IMPORT] Error:', error);
    return res.status(500).json({ error: 'Import failed: ' + error.message });
  }
}

// Takes a run the browser is still holding from before the store moved to KV
// and adopts it, so a move of storage does not cost a half-hour report queue.
//
// The old inputs carried name, brand and budget alongside the metrics. Those
// fields are simply ignored now - config is joined from the census - so an old
// record decides correctly without needing to be rewritten.
async function handleBiweeklyAdopt(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const inputs = req.body && req.body.inputs;
    const window = (req.body && req.body.window) || {};
    if (!Array.isArray(inputs) || !inputs.length) {
      return res.status(400).json({ error: 'Nothing to adopt' });
    }
    for (const k of ['start', 'end', 'priorStart', 'priorEnd']) {
      if (!DATE_RE.test(String(window[k] || ''))) {
        return res.status(400).json({ error: `window.${k} must be YYYY-MM-DD` });
      }
    }
    // Refuse to overwrite a real run with an older one.
    const existing = await bwLoadRun();
    if (existing) return res.status(200).json({ success: true, alreadyStored: true });

    // Keep only what a run is now: the metrics. Anything configurational in an
    // old record is dropped rather than stored and later trusted.
    const cleaned = inputs
      .filter(i => i && i.campaignId)
      .map(i => ({
        campaignId: String(i.campaignId),
        spend: num(i.spend), orders: num(i.orders), sales: num(i.sales),
        clicks: num(i.clicks), impressions: num(i.impressions),
        priorSpend: num(i.priorSpend), priorOrders: num(i.priorOrders),
        priorSales: num(i.priorSales),
        daily: Array.isArray(i.daily) ? i.daily.map(num) : []
      }));
    if (!cleaned.length) return res.status(400).json({ error: 'No usable rows to adopt' });

    await bwSaveRun(window, cleaned);
    return res.status(200).json({ success: true, adopted: cleaned.length });
  } catch (error) {
    console.error('[BIWEEKLY ADOPT] Error:', error);
    return res.status(500).json({ error: 'Adopt failed: ' + error.message });
  }
}

// The monthly posture per brand. Monthly is advisory and produces these by
// judgement, not computation, so they are set here rather than derived.
async function bwLoadPostures() {
  try {
    const stored = await kv.get(BW_POSTURE_KEY);
    const out = {};
    for (const [brand, posture] of Object.entries(stored || {})) {
      if (BW_POSTURES.includes(posture)) out[brand] = posture;
    }
    return out;
  } catch (err) {
    console.error('[BIWEEKLY] posture load failed:', err.message);
    return {};
  }
}

async function handleBiweeklyPosture(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const brand = String(req.body?.brand || '');
    const posture = String(req.body?.posture || '');
    if (!brand) return res.status(400).json({ error: 'brand required' });
    if (!BW_POSTURES.includes(posture)) {
      return res.status(400).json({ error: `posture must be one of: ${BW_POSTURES.join(', ')}` });
    }

    const current = await bwLoadPostures();
    // 'hold' IS the documented default, so storing it would only freeze a brand
    // against a later change in what the default means. Record a departure.
    const next = { ...current };
    if (posture === 'hold') delete next[brand];
    else next[brand] = posture;

    await kv.set(BW_POSTURE_KEY, next);
    return res.status(200).json({ success: true, postures: next });
  } catch (error) {
    console.error('[BIWEEKLY POSTURE] Error:', error);
    return res.status(500).json({ error: 'Posture update failed: ' + error.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MONTHLY — BRAND POSTURE REVIEW
// ═════════════════════════════════════════════════════════════════════════════
// Deliberately a fraction of what Amazon_Ad_Management_Monthly.docx describes.
// That doc was written for a chat workflow: paste reports, get back a written
// review with narrative per brand. Four of its six sections ask for prose a
// page cannot produce, and two more collapse into one another. What survives
// is the part with an action attached.
//
// This cadence does exactly two things:
//
//   1. Recommends a BRAND POSTURE, with the evidence for it on screen. The
//      posture is the only thing monthly has ever fed into another cadence:
//      the bi-weekly reads it to decide how hard to push each brand. Until
//      now it was set by hand with nothing in front of you.
//
//   2. Shows the two Sponsored Brands campaigns. We pulled SB from the weekly
//      and the bi-weekly because two campaigns out of ~142 were gating both
//      runs. That left a hole, and this is the only place it gets covered.
//
// Search term harvesting, negatives and keyword bids are the natural monthly
// work, and they are all blocked on the same thing: no report tells you what
// keywords exist or what they are bid at, so they need a keyword census the
// way campaigns needed a campaign census. That is the Ad Badger migration,
// targeted for March 2027, and this page is built to grow into it.

const MO_CONFIG = {
  // The day of the month on which the PREVIOUS calendar month is finally
  // complete. Sponsored Brands credits a purchase to its click date for 14
  // days, so a month's last day is still growing until 14 days later and is
  // settled the day after that. The arithmetic lands on the 15th every month,
  // whatever the month's length:
  //
  //   Jan 31 + 14 = Feb 14, complete Feb 15
  //   Feb 28 + 14 = Mar 14, complete Mar 15
  //   Apr 30 + 14 = May 14, complete May 15
  //
  // Calendar months rather than a rolling 30 days, because a rolling window
  // drifts and matches nothing else: not how the business thinks about a
  // month, not the month-over-month comparison, and not the order buckets,
  // which are already stored per calendar month. Every metric that drives a
  // posture is a ratio, so unequal month lengths cancel; only the raw spend
  // and sales dollars are affected, and those read as "that month" anyway.
  SETTLE_DAY: 15,

  // Below this a brand has not transacted enough in a month for a posture
  // change to be anything but noise.
  MIN_SPEND:  100,
  MIN_ORDERS: 10,

  // The doc's own retention bands: 50%+ is "healthy, grow carefully", under
  // 25% is "weak, candidate for decrease".
  SCALE_RETENTION:     0.50,
  CONSTRAIN_RETENTION: 0.25,

  // Retention points of month-over-month change worth reacting to.
  TREND_MATERIAL: 0.10,

  // Spend share minus sales share. Past this a brand is drawing more of the
  // budget than it returns.
  SHARE_GAP: 0.10,

  // Ad-attributed share of the brand's total sales. Past this, ads are not
  // supplementing organic rank, they are carrying the brand — which makes a
  // constrain riskier than the retention number alone suggests.
  AD_DEPENDENT: 0.70
};

// Target ACoS per segment, from the April 2026 program config. DISPLAY ONLY:
// profit retention is the decision metric in every cadence, and nothing in
// moRecommend reads these. They are here because the gap against target is
// what you actually think in when reading a brand row.
const TARGET_ACOS = {
  BW_PACKS:   0.15,
  BW_SETS:    0.05,
  BW_BLENDED: 0.15,
  HUBBARD:    0.10,
  MAPSHOP:    0.17,
  SOK:        0.125
};

const MO_SPEC_DEVIATIONS = [
  'Sections 1, 4 and 5 of the doc are one table here. Brand performance, budget ' +
  'share and next-month priorities all answer the same question, and the doc\'s own ' +
  'worked example states a rebalance and a posture in the same sentence.',
  'Funnel health (section 2) is not built. Campaign structure changes when you ' +
  'change it, not monthly, and its recommendations are campaign creation rather ' +
  'than anything a page can apply.',
  'Search term intelligence (section 3) is not built. It needs a keyword census ' +
  'first, for the same reason campaign budgets needed a campaign census.',
  'The Sponsored Brands review carries no purpose labels. The doc reads them from ' +
  'a catalog field that does not exist, and two campaigns do not justify building ' +
  'and maintaining one.',
  'Brand rows are Sponsored Products only. SB is 2 campaigns of ~142, it is broken ' +
  'out below, and the posture governs SP budgets in the bi-weekly. Ad-attributed ' +
  'share does include SB, because understating it there would flatter organic.',
  'BW_BLENDED has no target ACoS in the program config; it follows Packs at 15%. ' +
  'Display only, so no recommendation depends on it.'
];

const MO_REPORT_KEYS = ['spMonth', 'spPrior', 'sbMonth'];
const MO_RUN_KEY = 'monthly:lastrun';

// Sponsored Brands columns, requested nowhere else. New-to-brand is the reason
// SB is worth running at all, so it is asked for first; if Amazon refuses those
// two columns the run falls back to the base set and says so, rather than
// losing the whole report to a guess about a column name.
const MO_SB_COLUMNS = ['date', 'campaignId', 'cost', 'clicks', 'impressions',
                       'purchases', 'sales', 'newToBrandPurchases', 'newToBrandSales'];
const MO_SB_COLUMNS_BASE = ['date', 'campaignId', 'cost', 'clicks', 'impressions',
                            'purchases', 'sales'];

// First and last day of a 'YYYY-MM', timezone-free.
function moMonthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, '0')}` };
}

function moShiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The most recent COMPLETE calendar month, and the one before it. Before the
// settle day the previous month is still accumulating, so the answer is the
// month before that rather than a partially attributed one.
//
// A calendar month is at most 31 days, so each half is one report and still
// inside Amazon's cap. They are contiguous, so they cannot be one request.
function resolveMonthlyWindow(nowInstant) {
  const today = _ptDate(nowInstant);
  const day = Number(today.slice(8, 10));
  const back = day >= MO_CONFIG.SETTLE_DAY ? -1 : -2;
  const month = moShiftMonth(today.slice(0, 7), back);
  const priorMonth = moShiftMonth(month, -1);
  const t = moMonthBounds(month);
  const p = moMonthBounds(priorMonth);
  return { month, priorMonth,
           start: t.start, end: t.end, priorStart: p.start, priorEnd: p.end };
}

// A stricter check than counting days: 28, 30 and 31 are all valid spans, so
// only the endpoints can say whether a window really is a whole month.
function moIsWholeMonth(start, end) {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return false;
  if (start.slice(0, 7) !== end.slice(0, 7)) return false;
  const b = moMonthBounds(start.slice(0, 7));
  return start === b.start && end === b.end;
}

function moReportSpec(key, window) {
  if (key === 'spPrior') return { product: 'sp', start: window.priorStart, end: window.priorEnd };
  if (key === 'sbMonth') {
    return { product: 'sb', start: window.start, end: window.end,
             columns: MO_SB_COLUMNS, fallbackColumns: MO_SB_COLUMNS_BASE };
  }
  return { product: 'sp', start: window.start, end: window.end };
}

// Whether each of the three reports is still inside Amazon's retention. Pure,
// and the reason the Run button can say something useful before spending quota.
//
// The arithmetic works out cleanly on the cadence and badly off it. From the
// 15th onward both Sponsored Products months always fit, with at least four
// days to spare in the worst case. Sponsored Brands fits too, except on the
// very last day of a long month following another long month, where it is a
// single day short. Run BEFORE the 15th, though, and the target slides back an
// extra month: the prior month is then ~100 days old and gone, and so is
// Sponsored Brands.
function moAvailability(window, nowInstant) {
  const now = nowInstant || new Date();
  const out = {};
  for (const key of MO_REPORT_KEYS) {
    const spec = moReportSpec(key, window);
    const floor = reportRetentionStart(spec.product, now);
    out[key] = {
      product: spec.product,
      start: spec.start,
      floor,
      available: !floor || spec.start >= floor
    };
  }
  return out;
}

// Says what is missing and, where it is knowable, when it will not be. The
// answer is almost always "the 15th", because that is the only day on which
// both halves of the comparison are simultaneously settled and still retained.
function moUnavailableReason(availability, nowInstant) {
  const day = Number(_ptDate(nowInstant || new Date()).slice(8, 10));
  const a = availability.spPrior;
  const early = day < MO_CONFIG.SETTLE_DAY;
  return `The month before (${a.start.slice(0, 7)}) is past Amazon's ` +
         `${REPORT_RETENTION_DAYS.sp}-day retention, which now reaches back only to ${a.floor}. ` +
         (early
           ? `The monthly review runs from the ${MO_CONFIG.SETTLE_DAY}th: today is the ${day}th, ` +
             'so it is still reaching two months back for a month that has settled, and the ' +
             'comparison month before that has already aged out. Wait for the ' +
             `${MO_CONFIG.SETTLE_DAY}th and both fit comfortably.`
           : 'This is unexpected on or after the ' + MO_CONFIG.SETTLE_DAY +
             'th and worth looking at.');
}

// ─── INPUTS ──────────────────────────────────────────────────────────────────
// Metrics only, the same discipline as the other two cadences. Nothing about a
// brand, a margin or a posture is written down, so changing a threshold or a
// brand mapping is reflected on the next read with no report to re-run.

function moBuildInputs({ census, rows, window }) {
  const spEnabled = new Set();
  const sbEnabled = new Set();
  for (const row of (census.campaigns || [])) {
    if (String(row.state || '').toUpperCase() !== 'ENABLED') continue;
    if (row.adProduct === 'SP') spEnabled.add(String(row.campaignId));
    else if (row.adProduct === 'SB') sbEnabled.add(String(row.campaignId));
  }

  const sp = new Map();
  const sb = new Map();
  // Spend per day for each Sponsored Brands campaign. Days at cap depends on
  // the budget, which is configuration and joined on read, so the daily
  // amounts are stored and the counting happens at decide time.
  const sbDaily = new Map();
  let orphanRows = 0;

  const blankSp = (id) => ({
    campaignId: id,
    spend: 0, clicks: 0, impressions: 0, orders: 0, sales: 0,
    priorSpend: 0, priorClicks: 0, priorImpressions: 0, priorOrders: 0, priorSales: 0
  });
  // New-to-brand starts null and stays null unless a row actually carried it.
  // Amazon may refuse those two columns, and unknown must never read as none.
  const blankSb = (id) => ({
    campaignId: id,
    spend: 0, clicks: 0, impressions: 0, orders: 0, sales: 0,
    ntbOrders: null, ntbSales: null
  });

  for (const r of rows) {
    const id = String(r.campaignId);
    if (r.adProduct === 'SB') {
      if (!sbEnabled.has(id)) { orphanRows++; continue; }
      if (r.date < window.start || r.date > window.end) continue;
      let c = sb.get(id);
      if (!c) { c = blankSb(id); sb.set(id, c); }
      c.spend += r.cost; c.clicks += r.clicks; c.impressions += r.impressions;
      c.orders += r.orders; c.sales += r.sales;
      if (!sbDaily.has(id)) sbDaily.set(id, new Map());
      const days = sbDaily.get(id);
      days.set(r.date, (days.get(r.date) || 0) + r.cost);
      if (r.ntbOrders !== null && r.ntbOrders !== undefined) {
        c.ntbOrders = (c.ntbOrders || 0) + r.ntbOrders;
      }
      if (r.ntbSales !== null && r.ntbSales !== undefined) {
        c.ntbSales = (c.ntbSales || 0) + r.ntbSales;
      }
      continue;
    }
    if (!spEnabled.has(id)) { orphanRows++; continue; }
    let c = sp.get(id);
    if (!c) { c = blankSp(id); sp.set(id, c); }
    if (r.date >= window.start && r.date <= window.end) {
      c.spend += r.cost; c.clicks += r.clicks; c.impressions += r.impressions;
      c.orders += r.orders; c.sales += r.sales;
    } else if (r.date >= window.priorStart && r.date <= window.priorEnd) {
      c.priorSpend += r.cost; c.priorClicks += r.clicks; c.priorImpressions += r.impressions;
      c.priorOrders += r.orders; c.priorSales += r.sales;
    }
  }

  // A campaign the reports never mentioned spent nothing, which is a fact about
  // the month rather than an absence of one.
  for (const id of spEnabled) if (!sp.has(id)) sp.set(id, blankSp(id));
  for (const id of sbEnabled) if (!sb.has(id)) sb.set(id, blankSb(id));

  const round = (c) => {
    for (const k of Object.keys(c)) {
      if (k === 'campaignId' || c[k] === null || Array.isArray(c[k])) continue;
      c[k] = /clicks|impressions|orders/i.test(k) ? Math.round(c[k]) : r2(c[k]);
    }
    return c;
  };

  // Days with no row had no spend, so they cannot reach the cap and are
  // correctly absent from the list.
  for (const [id, c] of sb) {
    c.daily = [...(sbDaily.get(id) || new Map()).values()].map(r2);
  }

  return {
    inputs: { sp: [...sp.values()].map(round), sb: [...sb.values()].map(round) },
    orphanRows
  };
}

// ─── ORDERS ──────────────────────────────────────────────────────────────────
// Total sales per brand, which the ad reports cannot give: they only know sales
// they were credited for. The ratio of the two is the only number on this page
// that says whether ads are carrying a brand or supplementing it.
//
// Two caveats worth holding. Orders are dated by PURCHASE, ad sales by CLICK,
// so the two disagree slightly at the window edges. And the join is by SKU
// through the product catalog, so a SKU missing a brand there is missing from
// the denominator; that count is reported rather than absorbed.
async function moLoadBrandSales(window) {
  const sqlOrders = ordersSql.ordersInSql();
  const [products, index] = await Promise.all([
    productsSql.productsInSql() ? productsSql.getProducts() : kv.get('products'),
    sqlOrders ? null : kv.get('orders:v2:index')
  ]);
  const catalog = Array.isArray(products) ? products : [];
  if (!catalog.length || (!sqlOrders && (!Array.isArray(index) || !index.length))) {
    return { byBrand: {}, available: false, unmappedSkus: 0, unmappedSales: 0 };
  }

  const brandBySku = new Map();
  for (const p of catalog) {
    const sku = String(p?.sku || '').trim();
    const brand = String(p?.brand || '').trim();
    if (sku && brand) brandBySku.set(sku, brand);
  }

  const windowMonths = [...new Set([window.start.slice(0, 7), window.end.slice(0, 7)])];
  let buckets;
  if (sqlOrders) {
    // "Available" means the window's month has order data at all, even if
    // the window itself had no sales — same test as the index check below.
    if (!(await ordersSql.monthsWithData(windowMonths)).length) {
      return { byBrand: {}, available: false, unmappedSkus: 0, unmappedSales: 0 };
    }
    buckets = [await ordersSql.getOrders({ startDate: window.start, endDate: window.end })];
  } else {
    const months = windowMonths.filter(m => index.includes(m));
    if (!months.length) {
      return { byBrand: {}, available: false, unmappedSkus: 0, unmappedSales: 0 };
    }
    buckets = await Promise.all(months.map(m => kv.get(`orders:v2:${m}`)));
  }
  const byBrand = {};
  const unmapped = new Set();
  let unmappedSales = 0;
  for (const rows of buckets) {
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row || row.orderDate < window.start || row.orderDate > window.end) continue;
      const brand = brandBySku.get(String(row.sku || '').trim());
      const amount = Number(row.itemTotal) || 0;
      if (!brand) { unmapped.add(row.sku); unmappedSales += amount; continue; }
      byBrand[brand] = (byBrand[brand] || 0) + amount;
    }
  }
  for (const b of Object.keys(byBrand)) byBrand[b] = r2(byBrand[b]);
  return { byBrand, available: true, unmappedSkus: unmapped.size, unmappedSales: r2(unmappedSales) };
}

// The most recent daily-budget change made after the month ended. The month's
// numbers predate it, so recommending from them again would only repeat a
// change already made, and after a cut it would keep asking for another.
function moSbChangeAfter(changes, campaignId, afterDate) {
  let latest = null;
  for (const r of (changes || [])) {
    if (!r || String(r.campaignId) !== String(campaignId) || r.field !== 'dailyBudget') continue;
    if (!(String(r.ptDate || '') > afterDate)) continue;
    const key = `${r.ptDate}|${r.at || ''}`;
    if (!latest || key > latest.key) latest = { key, from: r.from, to: r.to, ptDate: r.ptDate };
  }
  return latest ? { from: latest.from, to: latest.to, ptDate: latest.ptDate } : null;
}

const pct = (n) => (n === null || n === undefined || !Number.isFinite(n))
  ? '—' : `${Math.round(n * 100)}%`;

// ─── THE RECOMMENDATION ──────────────────────────────────────────────────────
// Pure, ordered, and every branch says why in plain words. Profit retention is
// the metric, as in every other cadence — not ACoS against target.
// Every reason names its own numbers and says what the posture will do. The
// first version said things like "sits between the bands" and "the standard
// tree", which only mean something to whoever wrote them.
function moRecommend(b, config = MO_CONFIG) {
  const points = (n) => `${Math.round(n * 100)} point${Math.round(n * 100) === 1 ? '' : 's'}`;
  const scaleLine = pct(config.SCALE_RETENTION);
  const constrainLine = pct(config.CONSTRAIN_RETENTION);

  if (b.spend < config.MIN_SPEND && b.orders < config.MIN_ORDERS) {
    return { posture: 'hold', basis: 'floor',
             reason: `Under $${config.MIN_SPEND} of spend and under ${config.MIN_ORDERS} orders this ` +
                     'month, which is too little to judge, so no change to the normal budget rules.' };
  }
  if (b.retention === null) {
    return { posture: 'hold', basis: 'unknown',
             reason: b.grossMargin === null
               ? 'No gross margin on file for this brand, so retention can\'t be worked out. ' +
                 'No change to the normal budget rules.'
               : 'No ad sales this month, so retention can\'t be worked out. ' +
                 'No change to the normal budget rules.' };
  }

  // null, not 0, when there is no prior month: a brand that was not running
  // then has not improved or declined, it has simply no comparison.
  const fell = (b.priorRetention === null || b.priorRetention === undefined)
    ? null : b.priorRetention - b.retention;
  const shareGap = (b.spendShare !== null && b.salesShare !== null)
    ? b.spendShare - b.salesShare : null;

  if (b.retention < config.CONSTRAIN_RETENTION) {
    return { posture: 'constrain', basis: 'retention',
             reason: `Retention ${pct(b.retention)} is under ${constrainLine}, so hold back ` +
                     'raises and cut deeper.' };
  }
  if (fell !== null && fell >= config.TREND_MATERIAL && b.retention < config.SCALE_RETENTION) {
    return { posture: 'constrain', basis: 'trend',
             reason: `Retention fell ${points(fell)} from last month to ${pct(b.retention)}, ` +
                     `dropping under ${scaleLine}, so hold back raises and cut deeper.` };
  }
  if (shareGap !== null && shareGap > config.SHARE_GAP && b.retention < config.SCALE_RETENTION) {
    return { posture: 'constrain', basis: 'share',
             reason: `Takes ${pct(b.spendShare)} of spend but returns only ${pct(b.salesShare)} of ` +
                     `ad sales, at ${pct(b.retention)} retention, so hold back raises and cut deeper.` };
  }
  if (b.retention >= config.SCALE_RETENTION) {
    return { posture: 'scale', basis: 'retention',
             reason: `Retention ${pct(b.retention)} is ${scaleLine} or better, so raise ` +
                     'budget-capped campaigns faster.' +
                     (fell !== null && fell >= config.TREND_MATERIAL
                       ? ` It fell ${points(fell)} from last month, so it is worth watching.`
                       : '') };
  }
  return { posture: 'hold', basis: 'mediocre',
           reason: `Retention ${pct(b.retention)} is between ${constrainLine} and ${scaleLine}, ` +
                   'so no change to the normal budget rules.' };
}

// Raise, Hold or Lower one Sponsored Brands campaign's daily budget. Neither
// faster cadence covers Sponsored Brands, so this is the only place its budgets
// are managed at all.
//
// The same retention lines as the brand postures, so the page reads as one set
// of rules, and the bi-weekly's own step sizes, so an SB budget moves the way a
// Sponsored Products one would. A raise also needs the budget to have run out on
// most days, in the same four-days-in-seven proportion the weekly and bi-weekly
// use: raising a budget that is not being spent changes nothing.
function moRecommendSb(r, config = MO_CONFIG) {
  const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
  const hold = (reason) => ({ action: 'hold', recommendedBudget: null, reason });
  const scaleLine = pct(config.SCALE_RETENTION);
  const constrainLine = pct(config.CONSTRAIN_RETENTION);

  if (r.changedAfter) {
    const c = r.changedAfter;
    return hold(`Budget changed from ${money(c.from)} to ${money(c.to)} on ${c.ptDate}, after this ` +
                'month ended. Next month\'s numbers will show how it went.');
  }
  if (!(r.dailyBudget > 0) || /LIFETIME/i.test(r.budgetType || '')) {
    return hold('No daily budget on this campaign to adjust.');
  }
  if (r.spend < config.MIN_SPEND && r.orders < config.MIN_ORDERS) {
    return hold(`Under $${config.MIN_SPEND} of spend and under ${config.MIN_ORDERS} orders this month, ` +
                'which is too little to judge.');
  }
  if (r.retention === null || r.retention === undefined) {
    return hold('No ad sales this month, so retention can\'t be worked out.');
  }

  if (r.retention < config.CONSTRAIN_RETENTION) {
    const cut = r.retention < BW_CONFIG.T3_BARELY ? BW_DECREASES[2] : BW_DECREASES[1];
    const to = Math.max(BW_CONFIG.FLOOR, Math.round(r.dailyBudget * (1 - cut) * 100) / 100);
    if (!(to < r.dailyBudget)) {
      return hold(`Retention ${pct(r.retention)} is under ${constrainLine}, but the budget is already ` +
                  `at the ${money(BW_CONFIG.FLOOR)} floor.`);
    }
    return {
      action: 'lower', recommendedBudget: to,
      reason: r.retention < 0
        ? `Retention ${pct(r.retention)} is below break-even, so lower the budget ${Math.round(cut * 100)}%.`
        : `Retention ${pct(r.retention)} is under ${constrainLine}, so lower the budget ${Math.round(cut * 100)}%.`
    };
  }

  if (r.retention >= config.SCALE_RETENTION) {
    if (r.cappedDays === null || r.cappedDays === undefined) {
      return hold(`Retention ${pct(r.retention)} is ${scaleLine} or better. Whether the budget is holding ` +
                  'it back needs daily spend, which arrives with the next monthly run.');
    }
    const needed = Math.ceil(r.daysInMonth * RF_CONFIG.CAP_DAYS_MIN / 7);
    if (r.cappedDays >= needed) {
      const to = rfRecommendBudget({
        dailyBudget: r.dailyBudget, cappedDays: r.cappedDays, weekDays: r.daysInMonth,
        maxDaySpend: r.maxDaySpend, minDays: needed
      });
      if (to) {
        return {
          action: 'raise', recommendedBudget: to,
          reason: `Retention ${pct(r.retention)} is ${scaleLine} or better and the budget ran out on ` +
                  `${r.cappedDays} of ${r.daysInMonth} days, so raise it.`
        };
      }
    }
    return hold(`Retention ${pct(r.retention)} is ${scaleLine} or better, but the budget only ran out on ` +
                `${r.cappedDays} of ${r.daysInMonth} days, so a bigger one wouldn't get spent.`);
  }

  return hold(`Retention ${pct(r.retention)} is between ${constrainLine} and ${scaleLine}, ` +
              'so leave the budget as it is.');
}

// ─── DECIDE ──────────────────────────────────────────────────────────────────
// Everything is joined here, on every read: brands and margins from the census,
// total sales from orders, the current posture from its own store. Nothing
// below is ever written down.
function moDecideAll({ inputs, census, window, brandSales = {}, postures = {} }) {
  const config = new Map();
  for (const row of (census.campaigns || [])) config.set(String(row.campaignId), row);

  const brands = new Map();
  const unmapped = [];
  let orphanRows = 0;

  const blank = (brand) => ({
    brand,
    spend: 0, clicks: 0, impressions: 0, orders: 0, sales: 0,
    priorSpend: 0, priorOrders: 0, priorSales: 0,
    // Gross profit is accumulated per campaign, because BrightWay's Packs and
    // Sets carry different margins and a brand-level margin constant would be
    // method-dependent. Summing the dollars removes the question.
    grossProfit: 0, priorGrossProfit: 0, allowedSpend: 0,
    campaigns: 0, sbSales: 0, sbSpend: 0
  });

  for (const i of (inputs.sp || [])) {
    const row = config.get(String(i.campaignId));
    if (!row || String(row.state || '').toUpperCase() !== 'ENABLED' || row.adProduct !== 'SP') {
      orphanRows++;
      continue;
    }
    const brand = row.brand || null;
    if (!brand) {
      if (i.spend > 0) unmapped.push({ campaign: row.name || '', spend: i.spend });
      continue;
    }
    const segment = rfSegment(brand, row.name);
    const margin = segment ? MARGINS[segment] : null;
    const target = segment ? TARGET_ACOS[segment] : null;

    let b = brands.get(brand);
    if (!b) { b = blank(brand); brands.set(brand, b); }
    b.campaigns++;
    b.spend += i.spend; b.clicks += i.clicks; b.impressions += i.impressions;
    b.orders += i.orders; b.sales += i.sales;
    b.priorSpend += i.priorSpend; b.priorOrders += i.priorOrders; b.priorSales += i.priorSales;
    if (margin !== null && margin !== undefined) {
      b.grossProfit += i.sales * margin;
      b.priorGrossProfit += i.priorSales * margin;
    }
    if (target !== null && target !== undefined) b.allowedSpend += i.sales * target;
  }

  // Sponsored Brands rows, kept out of the brand performance columns but
  // counted into ad-attributed sales — leaving them out would flatter organic.
  const sbRows = [];
  for (const i of (inputs.sb || [])) {
    const row = config.get(String(i.campaignId));
    if (!row || String(row.state || '').toUpperCase() !== 'ENABLED' || row.adProduct !== 'SB') {
      orphanRows++;
      continue;
    }
    const brand = row.brand || null;
    const segment = brand ? rfSegment(brand, row.name) : null;
    const margin = segment ? MARGINS[segment] : null;
    const acos = i.sales > 0 ? r4(i.spend / i.sales) : null;
    const retention = (margin && acos !== null) ? r4((margin - acos) / margin) : null;
    const dailyBudget = typeof row.dailyBudget === 'number' ? row.dailyBudget : null;
    const daysInMonth = daySpan(window.start, window.end);

    // A run stored before daily spend was kept has no `daily`, so days at cap is
    // unknown rather than zero. Zero would claim the budget never ran out.
    let cappedDays = null;
    let maxDaySpend = null;
    if (Array.isArray(i.daily) && dailyBudget > 0) {
      const atCap = dailyBudget * RF_CONFIG.CAP_DAY_RATIO;
      cappedDays = i.daily.filter(d => d >= atCap).length;
      maxDaySpend = r2(i.daily.reduce((m, d) => Math.max(m, d), 0));
    }

    const rec = moRecommendSb({
      spend: i.spend, orders: i.orders, retention, dailyBudget,
      budgetType: row.budgetType || null, cappedDays, daysInMonth, maxDaySpend,
      changedAfter: moSbChangeAfter(census.changes, i.campaignId, window.end)
    });

    sbRows.push({
      campaignId: i.campaignId,
      campaign: row.name || '',
      adProduct: 'SB',
      brand,
      dailyBudget,
      budgetType: row.budgetType || null,
      cappedDays, daysInMonth, maxDaySpend,
      action: rec.action,
      recommendedBudget: rec.recommendedBudget,
      reason: rec.reason,
      spend: r2(i.spend), clicks: i.clicks, impressions: i.impressions,
      orders: i.orders, sales: r2(i.sales),
      acos,
      retention,
      // New-to-brand is the whole case for running Sponsored Brands. Null,
      // never zero, when Amazon refused the columns: unknown is not "none".
      ntbOrders: i.ntbOrders === null ? null : i.ntbOrders,
      ntbSales: i.ntbSales === null ? null : r2(i.ntbSales),
      ntbOrderShare: (i.orders > 0 && i.ntbOrders !== null) ? r4(i.ntbOrders / i.orders) : null,
      ntbSalesShare: (i.sales > 0 && i.ntbSales !== null) ? r4(i.ntbSales / i.sales) : null
    });
    if (brand) {
      let b = brands.get(brand);
      if (!b) { b = blank(brand); brands.set(brand, b); }
      b.sbSales += i.sales;
      b.sbSpend += i.spend;
    }
  }
  sbRows.sort((a, b) => String(a.campaign).localeCompare(String(b.campaign), 'en', { numeric: true }));

  // Shares are computed across the brands actually evaluated, so they always
  // total 100% of what is on screen rather than of something unseen.
  let totalSpend = 0, totalSales = 0;
  for (const b of brands.values()) { totalSpend += b.spend; totalSales += b.sales; }

  const rows = [...brands.values()].map(b => {
    const acos = b.sales > 0 ? r4(b.spend / b.sales) : null;
    const priorAcos = b.priorSales > 0 ? r4(b.priorSpend / b.priorSales) : null;
    // Retention as dollars: the share of gross margin left after ad spend.
    const retention = b.grossProfit > 0 ? r4((b.grossProfit - b.spend) / b.grossProfit) : null;
    const priorRetention = b.priorGrossProfit > 0
      ? r4((b.priorGrossProfit - b.priorSpend) / b.priorGrossProfit) : null;
    const adSales = r2(b.sales + b.sbSales);
    const brandTotal = brandSales[b.brand];
    const out = {
      brand: b.brand,
      campaigns: b.campaigns,
      spend: r2(b.spend), clicks: b.clicks, impressions: b.impressions,
      orders: b.orders, sales: r2(b.sales),
      priorSpend: r2(b.priorSpend), priorOrders: b.priorOrders, priorSales: r2(b.priorSales),
      grossMargin: b.sales > 0 && b.grossProfit > 0 ? r4(b.grossProfit / b.sales) : null,
      targetAcos: b.sales > 0 && b.allowedSpend > 0 ? r4(b.allowedSpend / b.sales) : null,
      acos, priorAcos,
      retention, priorRetention,
      retentionDelta: (retention !== null && priorRetention !== null)
        ? r4(retention - priorRetention) : null,
      spendShare: totalSpend > 0 ? r4(b.spend / totalSpend) : null,
      salesShare: totalSales > 0 ? r4(b.sales / totalSales) : null,
      sbSpend: r2(b.sbSpend), sbSales: r2(b.sbSales),
      adSales,
      totalSales: brandTotal === undefined ? null : brandTotal,
      adShare: (brandTotal > 0) ? r4(adSales / brandTotal) : null,
      posture: postures[b.brand] || 'hold'
    };
    out.gapVsTarget = (out.acos !== null && out.targetAcos !== null)
      ? r4(out.acos - out.targetAcos) : null;
    const rec = moRecommend(out);
    out.recommended = rec.posture;
    out.basis = rec.basis;
    out.reason = rec.reason;
    // Surfaced, never applied: a brand whose sales are almost entirely
    // ad-driven has no organic floor to fall back on, which is worth seeing
    // next to a constrain. The call stays yours.
    out.adDependent = out.adShare !== null && out.adShare >= MO_CONFIG.AD_DEPENDENT;
    out.changed = out.recommended !== out.posture;
    return out;
  }).sort((a, b) => b.spend - a.spend);

  return {
    rows, sbRows,
    counts: {
      brands: rows.length,
      changed: rows.filter(r => r.changed).length,
      scale: rows.filter(r => r.recommended === 'scale').length,
      constrain: rows.filter(r => r.recommended === 'constrain').length,
      hold: rows.filter(r => r.recommended === 'hold').length
    },
    totals: { spend: r2(totalSpend), sales: r2(totalSales) },
    coverage: { orphanRows, unmapped, evaluated: (inputs.sp || []).length }
  };
}

// What the monthly page shows for a stored run, decided from the census,
// postures, and brand sales as they are now. The page's read and the run
// history share it.
function moPageResult({ run, census, postures, brandSales }) {
  const result = moDecideAll({
    inputs: run.inputs, census, window: run.window,
    brandSales: brandSales.byBrand, postures
  });
  result.orders = brandSales;
  return result;
}

async function moSaveRun(window, inputs) {
  await acEnsureHistory();
  const run = { window, inputs, collectedAt: new Date().toISOString() };
  await kv.set(MO_RUN_KEY, run);
  await adHistoryRecordRun('monthly', run, async () => {
    const [census, postures, brandSales] = await Promise.all([
      loadCensus(), bwLoadPostures(), moLoadBrandSales(window)
    ]);
    return {
      decisions: census.campaigns.length ? moPageResult({ run, census, postures, brandSales }) : null,
      context: { config: MO_CONFIG, postures, censusSyncedAt: census.syncedAt }
    };
  });
}

async function moLoadRun() {
  try {
    const run = await kv.get(MO_RUN_KEY);
    return (run && run.inputs && Array.isArray(run.inputs.sp) && run.inputs.sp.length) ? run : null;
  } catch (err) {
    console.error('[MONTHLY] run load failed:', err.message);
    return null;
  }
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

// Shared by the page's Run button and by the cron, so the two cannot drift.
// Never throws: a caller needs to know which of the three reports it got.
async function moRequestReports(accessToken, window) {
  const reports = [];
  const failures = [];
  const notes = [];

  const availability = moAvailability(window);

  for (const key of MO_REPORT_KEYS) {
    const spec = moReportSpec(key, window);
    // Known to be outside retention: not requested at all, because a request
    // that cannot succeed still spends quota and comes back as a raw 400.
    if (!availability[key].available) {
      failures.push({
        key,
        error: `${spec.start} is past Amazon's ${REPORT_RETENTION_DAYS[spec.product]}-day ` +
               `retention for ${spec.product.toUpperCase()} reports, which reaches back ` +
               `to ${availability[key].floor}.`,
        window: `${spec.start}..${spec.end}`,
        retention: availability[key].floor
      });
      continue;
    }
    try {
      const r = await requestCampaignReport(accessToken, spec);
      reports.push({ key, ...r });
    } catch (err) {
      // New-to-brand is enrichment, not the report. If Amazon refuses those
      // columns the base set still answers the question SB is here for.
      const bad = rfInvalidColumns(err.message);
      if (spec.fallbackColumns && bad.length) {
        notes.push({ key, note: `Amazon refused ${bad.join(', ')} — retried without ` +
                                'new-to-brand, which will read as unknown.' });
        try {
          const r = await requestCampaignReport(accessToken,
            { ...spec, columns: spec.fallbackColumns, fallbackColumns: null });
          reports.push({ key, ...r });
          await sleep(600);
          continue;
        } catch (err2) {
          console.error(`[MONTHLY] ${key} fallback failed:`, err2.message);
          failures.push({ key, error: err2.message, window: `${spec.start}..${spec.end}`,
                          invalidColumns: rfInvalidColumns(err2.message) });
          await sleep(600);
          continue;
        }
      }
      console.error(`[MONTHLY] ${key} failed:`, err.message);
      failures.push({ key, error: err.message, window: `${spec.start}..${spec.end}`,
                      invalidColumns: bad });
    }
    await sleep(600);
  }
  return { reports, failures, notes };
}

async function handleMonthlyRequest(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const window = resolveMonthlyWindow(new Date());

    // The month-over-month comparison is half of what a posture reads, so a
    // run without the prior month is refused rather than quietly delivered
    // with every trend blank.
    const availability = moAvailability(window);
    if (!availability.spPrior.available) {
      return res.status(409).json({ error: moUnavailableReason(availability), window, availability });
    }

    const accessToken = await getAdsAccessToken();
    const { reports, failures, notes } = await moRequestReports(accessToken, window);

    if (!reports.length) {
      return res.status(502).json({
        error: 'No report could be requested. ' + (failures[0] ? failures[0].error : ''),
        failures
      });
    }
    return res.status(200).json({ success: true, window, reports, failures, notes,
                                  requestedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[MONTHLY REQUEST] Error:', error);
    return res.status(500).json({ error: 'Monthly-request failed: ' + error.message });
  }
}

async function handleMonthlyStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports, MO_REPORT_KEYS);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const accessToken = await getAdsAccessToken();
    const statuses = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const norm = (status.status || '').toUpperCase();
        statuses.push({ key, reportId, status: norm,
                        done: norm === 'COMPLETED' || norm === 'SUCCESS',
                        failed: norm === 'FAILURE' || norm === 'FAILED' || norm === 'CANCELLED' });
      } catch (err) {
        statuses.push({ key, reportId, status: 'ERROR', done: false, failed: false, error: err.message });
      }
    }
    return res.status(200).json({ success: true, statuses,
      allDone: statuses.every(s => s.done || s.failed), checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[MONTHLY STATUS] Error:', error);
    return res.status(500).json({ error: 'Monthly-status failed: ' + error.message });
  }
}

async function handleMonthlyCollect(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports, MO_REPORT_KEYS);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const window = {
      start: String(req.query.start || ''), end: String(req.query.end || ''),
      priorStart: String(req.query.priorStart || ''), priorEnd: String(req.query.priorEnd || '')
    };
    for (const [k, v] of Object.entries(window)) {
      if (!DATE_RE.test(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD` });
    }
    if (!moIsWholeMonth(window.start, window.end) ||
        !moIsWholeMonth(window.priorStart, window.priorEnd)) {
      return res.status(400).json({ error: 'both windows must be whole calendar months' });
    }
    if (moShiftMonth(window.start.slice(0, 7), -1) !== window.priorStart.slice(0, 7)) {
      return res.status(400).json({ error: 'the prior window must be the month immediately before' });
    }

    const census = await loadCensus();
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'brands and margins are read from it on every load.'
      });
    }

    const accessToken = await getAdsAccessToken();
    const rows = [];
    const notes = [];
    const got = new Set();
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) { notes.push({ key, note: `report not ready (${status.status || 'unknown'})` }); continue; }
        const raw = await withAdsRetry(() => downloadReport(url));
        rows.push(...rfNormalizeRows(raw, key === 'sbMonth' ? 'SB' : 'SP'));
        got.add(key);
      } catch (err) {
        console.error(`[MONTHLY COLLECT] ${key} failed:`, err.message);
        notes.push({ key, note: 'download failed: ' + err.message });
      }
    }
    if (!rows.length) return res.status(502).json({ error: 'No report rows could be downloaded.', notes });

    // Both Sponsored Products months or nothing, matching what the cron
    // requires. Storing the target month alone looks like a working review
    // while every month-over-month trend is silently blank, and the trend is
    // half of what a posture recommendation reads.
    if (!got.has('spMonth') || !got.has('spPrior')) {
      const missing = ['spMonth', 'spPrior'].filter(k => !got.has(k))
        .map(k => ADS_CRON_LABELS[k] || k).join(' and ');
      return res.status(502).json({
        error: `Cannot build the review without both months: the ${missing} did not arrive. ` +
               'Nothing was stored, so the previous run is untouched.',
        notes
      });
    }

    const { inputs, orphanRows } = moBuildInputs({ census, rows, window });
    await moSaveRun(window, inputs);

    const [brandSales, postures] = await Promise.all([moLoadBrandSales(window), bwLoadPostures()]);
    const result = moDecideAll({ inputs, census, window, brandSales: brandSales.byBrand, postures });
    result.coverage.orphanRows += orphanRows;
    result.orders = brandSales;

    return res.status(200).json({
      success: true, window, config: MO_CONFIG, postures,
      deviations: MO_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      ...result, notes,
      collectedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[MONTHLY COLLECT] Error:', error);
    return res.status(500).json({ error: 'Monthly-collect failed: ' + error.message });
  }
}

// The page's only read. Decided afresh every time, so a posture set a moment
// ago, a brand remapped in Campaign Overview, or a threshold edited in this
// file all show on the next load with no report to re-run.
async function handleMonthlyGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [run, census, postures] = await Promise.all([
      moLoadRun(), loadCensus(), bwLoadPostures()
    ]);
    if (!run) return res.status(200).json({ success: true, empty: true });
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'brands and margins are read from it on every load.'
      });
    }

    const brandSales = await moLoadBrandSales(run.window);
    const result = moPageResult({ run, census, postures, brandSales });

    return res.status(200).json({
      success: true, window: run.window, config: MO_CONFIG, postures,
      deviations: MO_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      collectedAt: run.collectedAt,
      ...result
    });
  } catch (error) {
    console.error('[MONTHLY GET] Error:', error);
    return res.status(500).json({ error: 'Monthly-get failed: ' + error.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TUESDAY CRON — fetches both cadences' reports before the working day
// ═════════════════════════════════════════════════════════════════════════════
// Amazon's report queue is the bottleneck, not report size: the same single
// campaign report took ~30 minutes when requested around 07:40 Eastern and ~5
// minutes later the same morning. Both reports sat PENDING, meaning queued and
// not started. So the fix is not to ask for less — it is to not be waiting.
//
// Two scheduled runs, because api/adspend.js is capped at 60 seconds and a
// queue can sit for half an hour:
//
//   cron-ads-request   resolves both windows, fires three reports, stashes ids
//   cron-ads-collect   polls, downloads, stores. Idempotent, and scheduled
//                      twice so a slow queue is picked up by the later slot.
//
// Unauthenticated, like every other cron handler in this file and in orders.js.
// The blast radius is Amazon report quota: nothing here writes a budget.
//
// Runs DAILY and checks the weekday itself rather than relying on a
// day-of-week cron expression — every existing schedule in vercel.json is
// daily or monthly, so that support is untested here and six no-op invocations
// a week cost nothing.

const ADS_CRON_KEY = 'ads:cron:pending';
const ADS_CRON_DAY = 2;   // Tuesday, in Pacific terms — see below

// Pacific, to match every window in this file. A UTC-naive weekday check would
// fire on Monday evening Pacific during the hours the cron actually runs.
function adsCronIsRunDay(nowInstant) {
  const d = new Date(_ptDate(nowInstant) + 'T00:00:00Z');
  return d.getUTCDay() === ADS_CRON_DAY;
}

// ─── SLACK ───────────────────────────────────────────────────────────────────
// ONE message per Tuesday run, sent when the run reaches a terminal state:
// everything collected, or the last attempt is over. A collect slot that still
// has a retry behind it stays silent on failure, so a slow report queue never
// sends a problem that the next slot would quietly contradict. Success is
// terminal whenever it happens, so it goes out at the earliest slot that has
// everything — which is the point of running before the working day.
//
// Reuses SLACK_WEBHOOK_URL, already set for the orders alerts. Without it the
// cron simply runs without notifying. A Slack failure is logged and never
// thrown: reporting on the run must not break the run.

const ADS_CRON_LABELS = {
  spWeek:  'weekly report (the week)',
  spBase:  'weekly report (the baseline)',
  spBw:    'bi-weekly report',
  spMonth: 'monthly report (the month)',
  spPrior: 'monthly report (the month before)',
  sbMonth: 'monthly Sponsored Brands report'
};

const RF_BUCKET_LABELS = {
  budgetCap: 'budget cap', silent: 'silent', spendCollapse: 'spend collapse',
  ctrCollapse: 'CTR collapse', cpcSpike: 'CPC spike', brandPacing: 'brand pacing'
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Pure, so the wording can be tested without a webhook. Returns the outcome
// alongside the text because the caller logs it and the tests assert on it.
function adsCronReport(s) {
  const notReady = s.notReady || [];
  const failures = s.failures || [];
  const label = (k) => ADS_CRON_LABELS[k] || k;

  // Stopped before anything could be stored, so no later slot rescues it.
  if (s.blocked) {
    return {
      outcome: 'none',
      text: '🔴 [Ad cadences] Tuesday run could not proceed\n' +
            `• ${s.blocked}\n` +
            'Nothing was stored. Both cadences can still be run from the dashboard.'
    };
  }

  const outcome = (s.weekly && s.biweekly) ? 'ok'
                : (s.weekly || s.biweekly) ? 'partial'
                : 'none';

  const head = outcome === 'ok'      ? '✅ [Ad cadences] Tuesday reports are in'
             : outcome === 'partial' ? '⚠️ [Ad cadences] Tuesday run finished short'
             :                         '🔴 [Ad cadences] Tuesday run did not finish';

  const lines = [head];

  if (s.weekly) {
    const w = s.weekly;
    const buckets = Object.entries(w.flags || {})
      .filter(([, list]) => list && list.length)
      .map(([k, list]) => `${RF_BUCKET_LABELS[k] || k} ${list.length}`);
    lines.push(`• Weekly red flags — ${plural(w.flagCount, 'flag')}, ` +
               `${w.window.weekStart} to ${w.window.weekEnd}`);
    lines.push(buckets.length ? `    ${buckets.join(' · ')}` : '    nothing flagged this week');
  }

  if (s.biweekly) {
    const b = s.biweekly;
    if (b.adopted) {
      const c = b.counts || { increase: 0, decrease: 0, cut: 0, hold: 0 };
      const changes = c.increase + c.decrease + c.cut;
      lines.push(`• Bi-weekly budgets — adopted, ${plural(changes, 'change')} ` +
                 `across ${b.evaluated} campaigns, ${b.window.start} to ${b.window.end}`);
      lines.push(`    increase ${c.increase} · decrease ${c.decrease} · ` +
                 `cut ${c.cut} · hold ${c.hold}` +
                 (c.adjusted ? ` · ${c.adjusted} already adjusted` : ''));
    } else {
      lines.push('• Bi-weekly budgets — nothing was stored for ' +
                 `${b.window.start} to ${b.window.end}`);
      lines.push('    The page is still deciding from the previous run.');
    }
  }

  // The census supplies every budget, brand and bid the checks read, so a stale
  // one is worth saying even when the reports themselves landed.
  if (s.censusError) {
    lines.push(`• Campaign snapshot did not refresh: ${s.censusError}`);
    lines.push('    Decisions were made from the previous snapshot.');
  }

  for (const n of notReady) lines.push(`• The ${label(n.key)} never arrived — ${n.status}`);
  for (const f of failures) lines.push(`• The ${label(f.key)} was never requested — ${f.error}`);

  if (outcome !== 'ok') {
    const what = outcome === 'none' ? 'both cadences' : 'that cadence';
    lines.push(notReady.length
      ? `Amazon had not finished generating them by the last attempt. Re-run ${what} from the dashboard.`
      : `Re-run ${what} from the dashboard.`);
  }

  return { outcome, text: lines.join('\n') };
}

async function adsCronSlack(text) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[ADS CRON] SLACK_WEBHOOK_URL is not set — not notifying');
    return false;
  }
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!resp.ok) {
      console.warn(`[ADS CRON] Slack POST returned ${resp.status}: ` +
                   `${await resp.text().catch(() => '')}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[ADS CRON] Slack POST failed:', err.message);
    return false;
  }
}

// Sends, and records that it sent. The flag is what stops a retried invocation
// or an extra slot from saying the same thing twice.
async function adsCronNotify(summary, pending) {
  const { outcome, text } = adsCronReport(summary);
  console.log(`[ADS CRON] ${outcome}:\n${text}`);
  await adsCronSlack(text);
  if (pending) {
    try {
      await kv.set(ADS_CRON_KEY, {
        ...pending, notified: true, notifiedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[ADS CRON] could not record the notification:', err.message);
    }
  }
  return outcome;
}

// Counts for the bi-weekly line. Adoption is the normal path, so `adopted`
// false means the fetch stored nothing — there is no recommendation to count
// and the line says so instead of printing zeroes.
async function bwCronSummary({ window, inputs, census, adopted }) {
  if (!adopted) return { window, adopted: false };
  const postures = await bwLoadPostures();
  const result = bwDecideAll({
    inputs, census, window, postures,
    recentRaises: bwRecentRaises(census.changes, window),
    adjusted: bwAdjustedAfter(census.changes, window.end)
  });
  return { window, adopted: true, counts: result.counts, evaluated: result.rows.length };
}

async function handleCronAdsRequest(req, res) {
  try {
    if (!adsCronIsRunDay(new Date())) {
      return res.status(200).json({ success: true, skipped: 'not the run day' });
    }
    const missing = missingAdsCredentials();
    if (missing.length) {
      const why = `Missing Advertising API credentials: ${missing.join(', ')}`;
      await adsCronNotify({ blocked: why }, null);
      return res.status(500).json({ error: why });
    }

    // The census decides which campaigns are evaluated and supplies every
    // budget, so it is refreshed before the reports rather than left to
    // whenever someone last opened Campaign Overview.
    let censusError = null;
    try {
      await acRunSync({});
    } catch (err) {
      censusError = err.message;
      console.error('[ADS CRON] census refresh failed:', err.message);
    }

    const weekly = resolveWindow(new Date());
    const biweekly = resolveBiweeklyWindow(new Date());
    const accessToken = await getAdsAccessToken();

    // Three reports: the two cadences use different windows, and the combined
    // span is over Amazon's 31-day cap.
    const specs = [
      { key: 'spWeek', ...reportSpec('spWeek', weekly) },
      { key: 'spBase', ...reportSpec('spBase', weekly) },
      { key: 'spBw',   ...bwReportSpec('spBw', biweekly) }
    ];

    const reports = [];
    const failures = [];
    for (const spec of specs) {
      try {
        const r = await requestCampaignReport(accessToken, spec);
        reports.push({ key: spec.key, reportId: r.reportId, adopted: !!r.adopted });
      } catch (err) {
        console.error(`[ADS CRON] ${spec.key} failed:`, err.message);
        failures.push({ key: spec.key, error: err.message,
                        window: `${spec.start}..${spec.end}` });
      }
      await sleep(600);
    }

    // Nothing to collect means no later slot can rescue this, so it is terminal
    // now rather than at the final collect. A PARTIAL failure is not terminal:
    // the collect can still store the cadence whose reports did get requested,
    // and it carries these failures into that message.
    if (!reports.length) {
      await adsCronNotify({
        blocked: 'No report could be requested. ' +
                 failures.map(f => `${ADS_CRON_LABELS[f.key] || f.key}: ${f.error}`).join('; ')
      }, null);
      return res.status(200).json({ success: false, requested: 0, failures, censusError });
    }

    await kv.set(ADS_CRON_KEY, {
      weekly, biweekly, reports, failures, censusError,
      // Stamped so a collect can tell this batch from last week's — see below.
      ptDate: _ptDate(new Date()),
      requestedAt: new Date().toISOString(), collected: false, notified: false
    });

    return res.status(200).json({ success: true, requested: reports.length, failures, censusError });
  } catch (error) {
    console.error('[ADS CRON REQUEST] Error:', error);
    await adsCronNotify({ blocked: 'Could not request the reports: ' + error.message }, null);
    return res.status(500).json({ error: 'Cron request failed: ' + error.message });
  }
}

// Safe to call repeatedly: it does nothing once a pending batch is collected,
// which is what lets a second slot exist purely as a safety net.
//
// The LAST slot carries final=1 in vercel.json, and that is the only one that
// reports a failure — every earlier slot still has a retry behind it, so a
// queue that is merely slow must not produce a message the next slot contradicts.
async function handleCronAdsCollect(req, res) {
  const final = String(req.query.final || '') === '1';
  let pending = null;
  try {
    pending = await kv.get(ADS_CRON_KEY);
    if (!pending || !Array.isArray(pending.reports) || !pending.reports.length) {
      return res.status(200).json({ success: true, skipped: 'nothing pending' });
    }
    if (pending.collected || pending.notified) {
      return res.status(200).json({ success: true, skipped: 'already finished' });
    }
    // The record outlives the day it was written. Downloading a week-old report
    // id would store a stale window as if it were this week's, so a batch from
    // another Pacific day is refused rather than collected.
    const today = _ptDate(new Date());
    if (pending.ptDate && pending.ptDate !== today) {
      return res.status(200).json({ success: true,
                                    skipped: `pending batch is from ${pending.ptDate}` });
    }

    const census = await loadCensus();
    if (!census.campaigns.length) {
      if (final) {
        await adsCronNotify({
          blocked: 'No campaign snapshot to evaluate against. Every budget, brand ' +
                   'and bid is read from it. Refresh Campaign Overview, then re-run.'
        }, pending);
      }
      return res.status(200).json({ success: false, error: 'no campaign snapshot to evaluate against' });
    }

    const accessToken = await getAdsAccessToken();
    const rowsByKey = {};
    const notReady = [];
    for (const { key, reportId } of pending.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) { notReady.push({ key, status: status.status || 'unknown' }); continue; }
        const raw = await withAdsRetry(() => downloadReport(url));
        rowsByKey[key] = rfNormalizeRows(raw, 'SP');
      } catch (err) {
        console.error(`[ADS CRON] ${key} download failed:`, err.message);
        notReady.push({ key, status: 'error: ' + err.message });
      }
    }

    // All or nothing per cadence: half a window is worse than none, because a
    // missing baseline makes every campaign look like it collapsed.
    const stored = [];
    const summary = {
      notReady,
      failures: pending.failures || [],
      censusError: pending.censusError || null
    };

    if (rowsByKey.spWeek && rowsByKey.spBase) {
      const { inputs } = rfBuildInputs({
        census, rows: [...rowsByKey.spWeek, ...rowsByKey.spBase], window: pending.weekly
      });
      await rfSaveRun(pending.weekly, inputs);
      await whIngestWeeklyRun({ rows: [...rowsByKey.spWeek, ...rowsByKey.spBase],
                                census, window: pending.weekly });
      stored.push('weekly');
      // Decided here only to say how much there is to look at. Nothing is
      // stored from it: the page re-decides on every read.
      const decided = rfDecideAll({ inputs, census, window: pending.weekly });
      summary.weekly = { window: pending.weekly, flags: decided.flags,
                         flagCount: decided.flagCount };
    }
    if (rowsByKey.spBw) {
      const { inputs } = bwBuildInputs({ census, rows: rowsByKey.spBw, window: pending.biweekly });
      await bwSaveAvailable(pending.biweekly, inputs);
      // Every Tuesday's fetch becomes what the page decides from. The cadence
      // is when you sit down and act, not how old the numbers are allowed to be.
      const adopted = await bwAdoptLatest();
      stored.push('biweekly');
      summary.biweekly = await bwCronSummary({ window: pending.biweekly, inputs, census, adopted });
    }

    const done = stored.length > 0 && !notReady.length;
    const record = { ...pending, collected: done, lastCollectAt: new Date().toISOString() };

    // Terminal: everything landed, or this was the last attempt.
    let outcome = null;
    if (done || final) outcome = await adsCronNotify(summary, record);
    else await kv.set(ADS_CRON_KEY, record);

    return res.status(200).json({ success: true, stored, notReady, collected: done,
                                  notified: outcome });
  } catch (error) {
    console.error('[ADS CRON COLLECT] Error:', error);
    if (final) {
      await adsCronNotify({ blocked: 'Could not collect the reports: ' + error.message }, pending);
    }
    return res.status(500).json({ error: 'Cron collect failed: ' + error.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MONTHLY CRON — the 15th, when the previous month finally settles
// ═════════════════════════════════════════════════════════════════════════════
// A fixed day of the month rather than a weekday, and that is the whole point.
// Once a calendar month is fully attributed it NEVER CHANGES AGAIN, so unlike
// the other two cadences there is no staleness to fight: load it once and it is
// correct forever. Which Tuesday you actually read it on is your habit, not a
// rule this code has to encode.
//
// Day-of-month scheduling is already proven here — the ad spend sync and
// several others run that way — so this uses it directly instead of running
// daily and checking the date, which is what the Tuesday cron has to do.
//
// Three reports, one of them the slow Sponsored Brands one, so the same
// request-then-collect-twice shape as the Tuesday cron.
//
// TIMING, which is fiddlier than it looks:
//
//   09:00 UTC is 01:00 PST or 02:00 PDT on the 15th, so the Pacific date the
//   window resolver reads is the 15th too. Much earlier in the UTC day would
//   still be the 14th in Pacific terms and would resolve to the wrong month.
//
//   It is also an hour AHEAD of the Tuesday cron's 10:00 request. When the 15th
//   falls on a Tuesday both would otherwise refresh the campaign census at the
//   same moment, and two concurrent syncs racing to write one snapshot would
//   double-log every change they found and eat the change-log cap.

const MO_CRON_KEY = 'monthly:cron:pending';

const MO_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];

// '2026-01' reads as 'January 2026'. Slack is prose, not a data table.
function moMonthLabel(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return String(ym || 'the month');
  const [y, m] = ym.split('-').map(Number);
  return `${MO_MONTH_NAMES[m - 1] || ym} ${y}`;
}

// Pure, so the wording is testable without a webhook.
function moCronReport(s) {
  const notReady = s.notReady || [];
  const failures = s.failures || [];
  const label = (k) => ADS_CRON_LABELS[k] || k;
  const month = moMonthLabel(s.month);

  if (s.blocked) {
    return {
      outcome: 'none',
      text: `🔴 [Monthly review] ${month} could not be loaded\n` +
            `• ${s.blocked}\n` +
            'Nothing was stored. It can still be run from the Monthly Review page.'
    };
  }

  // The brand table needs both Sponsored Products months; without them there is
  // no review. Sponsored Brands missing costs two rows, not the cadence.
  const outcome = !s.brands ? 'none' : (s.sb ? 'ok' : 'partial');

  const head = outcome === 'ok'      ? `✅ [Monthly review] ${month} is in`
             : outcome === 'partial' ? `⚠️ [Monthly review] ${month} loaded without Sponsored Brands`
             :                         `🔴 [Monthly review] ${month} did not load`;

  const lines = [head];

  if (s.brands) {
    const b = s.brands;
    lines.push(`• Brand posture — ${plural(b.count, 'brand')}, ` +
               (b.changed
                 ? `${plural(b.changed, 'recommendation')} differ${b.changed === 1 ? 's' : ''} from what is set`
                 : 'every posture already matches'));
    lines.push(`    scale ${b.scale} · hold steady ${b.hold} · constrain ${b.constrain}`);
  }

  if (s.sb) {
    const parts = [plural(s.sb.campaigns, 'campaign'), `$${Math.round(s.sb.spend)} spend`];
    if (s.sb.ntbOrderShare !== null && s.sb.ntbOrderShare !== undefined) {
      parts.push(`${Math.round(s.sb.ntbOrderShare * 100)}% of orders new to brand`);
    }
    lines.push(`• Sponsored Brands — ${parts.join(', ')}`);
  }

  if (s.censusError) {
    lines.push(`• Campaign snapshot did not refresh: ${s.censusError}`);
    lines.push('    Brands and margins came from the previous snapshot.');
  }

  for (const n of notReady) lines.push(`• The ${label(n.key)} never arrived — ${n.status}`);
  for (const f of failures) lines.push(`• The ${label(f.key)} was never requested — ${f.error}`);

  if (outcome === 'ok' && s.brands && s.brands.changed) {
    lines.push('Nothing is applied automatically. Postures are set on the Monthly Review page.');
  } else if (outcome !== 'ok') {
    lines.push('Re-run it from the Monthly Review page.');
  }

  return { outcome, text: lines.join('\n') };
}

async function moCronNotify(summary, pending) {
  const { outcome, text } = moCronReport(summary);
  console.log(`[MONTHLY CRON] ${outcome}:\n${text}`);
  await adsCronSlack(text);
  if (pending) {
    try {
      await kv.set(MO_CRON_KEY, {
        ...pending, notified: true, notifiedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[MONTHLY CRON] could not record the notification:', err.message);
    }
  }
  return outcome;
}

async function handleCronMonthlyRequest(req, res) {
  try {
    // The schedule already says the 15th. This refuses a hand-fired call
    // earlier in the month, which would quietly store a two-month-old window
    // because the previous month has not settled yet.
    const day = Number(_ptDate(new Date()).slice(8, 10));
    if (day < MO_CONFIG.SETTLE_DAY) {
      return res.status(200).json({ success: true,
        skipped: `day ${day}: the previous month does not settle until the ${MO_CONFIG.SETTLE_DAY}th` });
    }

    const missing = missingAdsCredentials();
    if (missing.length) {
      const why = `Missing Advertising API credentials: ${missing.join(', ')}`;
      await moCronNotify({ blocked: why }, null);
      return res.status(500).json({ error: why });
    }

    // Brands and margins are read from the census, and it decides which
    // campaigns are evaluated at all.
    let censusError = null;
    try {
      await acRunSync({});
    } catch (err) {
      censusError = err.message;
      console.error('[MONTHLY CRON] census refresh failed:', err.message);
    }

    const window = resolveMonthlyWindow(new Date());
    const accessToken = await getAdsAccessToken();
    const { reports, failures, notes } = await moRequestReports(accessToken, window);

    if (!reports.length) {
      await moCronNotify({
        month: window.month,
        blocked: 'No report could be requested. ' +
                 failures.map(f => `${ADS_CRON_LABELS[f.key] || f.key}: ${f.error}`).join('; ')
      }, null);
      return res.status(200).json({ success: false, requested: 0, failures, censusError });
    }

    await kv.set(MO_CRON_KEY, {
      window, reports, failures, notes, censusError,
      ptDate: _ptDate(new Date()),
      requestedAt: new Date().toISOString(), collected: false, notified: false
    });

    return res.status(200).json({ success: true, window, requested: reports.length,
                                  failures, notes, censusError });
  } catch (error) {
    console.error('[MONTHLY CRON REQUEST] Error:', error);
    await moCronNotify({ blocked: 'Could not request the reports: ' + error.message }, null);
    return res.status(500).json({ error: 'Monthly cron request failed: ' + error.message });
  }
}

// Idempotent, and scheduled twice so a slow queue is picked up by the later
// slot. Only the slot carrying final=1 reports a failure: every earlier one
// still has a retry behind it.
async function handleCronMonthlyCollect(req, res) {
  const final = String(req.query.final || '') === '1';
  let pending = null;
  try {
    pending = await kv.get(MO_CRON_KEY);
    if (!pending || !Array.isArray(pending.reports) || !pending.reports.length) {
      return res.status(200).json({ success: true, skipped: 'nothing pending' });
    }
    if (pending.collected || pending.notified) {
      return res.status(200).json({ success: true, skipped: 'already finished' });
    }
    // The record outlives the day it was written, and a month-old report id
    // would store the wrong month as if it were current.
    const today = _ptDate(new Date());
    if (pending.ptDate && pending.ptDate !== today) {
      return res.status(200).json({ success: true,
                                    skipped: `pending batch is from ${pending.ptDate}` });
    }

    const window = pending.window;
    const census = await loadCensus();
    if (!census.campaigns.length) {
      if (final) {
        await moCronNotify({
          month: window.month,
          blocked: 'No campaign snapshot to evaluate against. Every brand and margin is ' +
                   'read from it. Refresh Campaign Overview, then re-run.'
        }, pending);
      }
      return res.status(200).json({ success: false, error: 'no campaign snapshot to evaluate against' });
    }

    const accessToken = await getAdsAccessToken();
    const rowsByKey = {};
    const notReady = [];
    for (const { key, reportId } of pending.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) { notReady.push({ key, status: status.status || 'unknown' }); continue; }
        const raw = await withAdsRetry(() => downloadReport(url));
        rowsByKey[key] = rfNormalizeRows(raw, key === 'sbMonth' ? 'SB' : 'SP');
      } catch (err) {
        console.error(`[MONTHLY CRON] ${key} download failed:`, err.message);
        notReady.push({ key, status: 'error: ' + err.message });
      }
    }

    // Both Sponsored Products months or nothing: without the prior month every
    // brand's trend is missing, which is half of what the posture reads.
    const summary = {
      month: window.month,
      notReady,
      failures: pending.failures || [],
      censusError: pending.censusError || null
    };
    let stored = false;

    if (rowsByKey.spMonth && rowsByKey.spPrior) {
      const rows = [...rowsByKey.spMonth, ...rowsByKey.spPrior, ...(rowsByKey.sbMonth || [])];
      const { inputs } = moBuildInputs({ census, rows, window });
      await moSaveRun(window, inputs);
      stored = true;

      const [brandSales, postures] = await Promise.all([moLoadBrandSales(window), bwLoadPostures()]);
      const result = moDecideAll({ inputs, census, window, brandSales: brandSales.byBrand, postures });
      summary.brands = {
        count: result.counts.brands, changed: result.counts.changed,
        scale: result.counts.scale, hold: result.counts.hold, constrain: result.counts.constrain
      };
      if (rowsByKey.sbMonth) {
        const sb = result.sbRows || [];
        const orders = sb.reduce((n, r) => n + (r.orders || 0), 0);
        const ntb = sb.reduce((n, r) => n + (r.ntbOrders || 0), 0);
        summary.sb = {
          campaigns: sb.length,
          spend: sb.reduce((n, r) => n + (r.spend || 0), 0),
          // null, never 0, when Amazon refused the columns.
          ntbOrderShare: (orders > 0 && sb.some(r => r.ntbOrders !== null)) ? ntb / orders : null
        };
      }
    }

    const done = stored && !notReady.length;
    const record = { ...pending, collected: done, lastCollectAt: new Date().toISOString() };

    let outcome = null;
    if (done || final) outcome = await moCronNotify(summary, record);
    else await kv.set(MO_CRON_KEY, record);

    return res.status(200).json({ success: true, stored, notReady, collected: done,
                                  notified: outcome });
  } catch (error) {
    console.error('[MONTHLY CRON COLLECT] Error:', error);
    if (final) {
      await moCronNotify({ month: pending?.window?.month,
                           blocked: 'Could not collect the reports: ' + error.message }, pending);
    }
    return res.status(500).json({ error: 'Monthly cron collect failed: ' + error.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WEEKLY HISTORY — the continuous series the cadence pages never kept
// ═════════════════════════════════════════════════════════════════════════════
// Every other page here answers "what should I do this week". This one answers
// "what has been happening", which nothing did: the weekly, bi-weekly and
// monthly runs each store one window and overwrite it, so the series they build
// every Tuesday was discarded every Tuesday.
//
// Two feeds, both of them data already being fetched, binned into the same
// Monday-to-Sunday weeks the weekly cadence uses:
//
//   month buckets   adspend:sp:raw:YYYY-MM holds daily rows per campaign per
//                   SKU. Complete from 2026-03; spend-only before that, which
//                   is why the series starts there.
//   weekly collect  its 28-day baseline is exactly four whole settled weeks
//                   sitting immediately before the current one, so each Tuesday
//                   tops up the recent end. The month buckets cannot: September
//                   is not written until October 3rd.
//
// A WEEK IS ONLY EVER WRITTEN ONCE IT HAS SETTLED. Sponsored Products keeps
// crediting sales to a click date for seven days, so a week read straight after
// it closes is understated and nothing would ever go back to correct it. Both
// feeds are filtered to weeks lying entirely inside a covered, settled span,
// which is also why each week arrives a week later than it could.
//
// Stored per campaign rather than per brand: brand comes from the census and
// the name prefix on every read, the same discipline as everywhere else, so a
// re-mapped campaign corrects its own history instead of freezing it.

const WH_KEY = (year) => `adspend:weeks:${year}`;

// Sponsored Products only, matching every other cadence. Sponsored Brands has
// no conversion history stored at all.
const WH_SETTLE_DAYS = 7;

// Monday of the week containing this date.
function whMonday(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();                 // 0=Sun … 6=Sat
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

// The last week whose final day is far enough back to have finished attributing.
function whSettledThrough(nowInstant) {
  const cutoff = _addDays(_ptDate(nowInstant || new Date()), -WH_SETTLE_DAYS);
  let monday = whMonday(cutoff);
  // A week counts only if its Sunday is on or before the cutoff.
  if (_addDays(monday, 6) > cutoff) monday = _addDays(monday, -7);
  return monday;
}

// Daily rows to weekly per-campaign totals. `coverStart`/`coverEnd` are the
// span the rows actually came from; a week not wholly inside it would be
// counted short, so it is dropped rather than written wrong.
//
// Pure, and the reason both feeds can share one path despite arriving in
// different shapes.
function whBinWeeks(rows, coverStart, coverEnd, settledThrough) {
  const weeks = new Map();
  for (const r of (rows || [])) {
    const date = String(r.date || '').slice(0, 10);
    const campaign = String(r.campaign || '').trim();
    if (!DATE_RE.test(date) || !campaign) continue;
    if (date < coverStart || date > coverEnd) continue;

    const week = whMonday(date);
    // The WHOLE week has to sit inside the covered span. Comparing against the
    // Monday of coverStart instead of coverStart itself let through a week that
    // began in the previous, uncovered month and so was counted short.
    if (week < coverStart || _addDays(week, 6) > coverEnd) continue;
    if (settledThrough && week > settledThrough) continue;

    let byCampaign = weeks.get(week);
    if (!byCampaign) { byCampaign = new Map(); weeks.set(week, byCampaign); }
    let c = byCampaign.get(campaign);
    if (!c) {
      c = { campaign, impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 };
      byCampaign.set(campaign, c);
    }
    c.impressions += num(r.impressions);
    c.clicks += num(r.clicks);
    c.orders += num(rfPick(r, ['orders', 'purchases7d', 'purchases']));
    c.spend += num(rfPick(r, ['spend', 'cost']));
    c.sales += num(rfPick(r, ['sales', 'sales7d']));
  }

  const out = [];
  for (const [week, byCampaign] of weeks) {
    for (const c of byCampaign.values()) {
      out.push({
        week,
        campaign: c.campaign,
        impressions: Math.round(c.impressions),
        clicks: Math.round(c.clicks),
        orders: Math.round(c.orders),
        spend: r2(c.spend),
        sales: r2(c.sales)
      });
    }
  }
  return out;
}

// Upsert by (week, campaign). Every write is settled data, so a later write
// agreeing with an earlier one is the normal case rather than a conflict, and
// re-running a backfill is free.
async function whUpsert(binned) {
  if (!binned.length) return { weeks: 0, rows: 0, years: [] };
  const byYear = new Map();
  for (const row of binned) {
    const y = row.week.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(row);
  }

  const years = [];
  for (const [year, rows] of byYear) {
    const stored = await kv.get(WH_KEY(year));
    const existing = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
    const index = new Map(existing.map(r => [`${r.week}|${r.campaign}`, r]));
    for (const r of rows) index.set(`${r.week}|${r.campaign}`, r);
    const merged = [...index.values()].sort(
      (a, b) => a.week.localeCompare(b.week) || a.campaign.localeCompare(b.campaign));
    await kv.set(WH_KEY(year), { rows: merged, updatedAt: new Date().toISOString() });
    years.push(year);
  }
  return {
    weeks: new Set(binned.map(r => r.week)).size,
    rows: binned.length,
    years
  };
}

async function whLoadRange(from, to) {
  const years = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(String(y));
  const stores = await Promise.all(years.map(y => kv.get(WH_KEY(y))));
  const rows = [];
  for (const s of stores) {
    for (const r of ((s && s.rows) || [])) {
      if (r.week >= from && r.week <= to) rows.push(r);
    }
  }
  return rows;
}

// ─── DECIDE ──────────────────────────────────────────────────────────────────
// Nothing is stored but the five measured numbers. The five ratios your sheet
// tracked are arithmetic on those and are computed here on every read, so a
// corrected brand mapping or a re-pulled month shows up without a rebuild.

function whBrandOf(name, byName) {
  const known = byName.get(String(name || '').trim());
  if (known) return known;
  return acBrandFromPrefix(name);
}

function whSeries({ rows, census, brand }) {
  // The census is the authority on which campaign belongs to which brand,
  // including a manual override. The name prefix only answers for campaigns it
  // no longer carries, which is every renamed or archived one.
  const byName = new Map();
  for (const c of (census.campaigns || [])) {
    if (c.name && c.brand) byName.set(String(c.name).trim(), c.brand);
  }

  const weeks = new Map();
  const brands = new Set();
  let unmappedSpend = 0;
  const unmappedNames = new Set();

  for (const r of rows) {
    const b = whBrandOf(r.campaign, byName);
    if (b) brands.add(b);
    else { unmappedSpend += r.spend; unmappedNames.add(r.campaign); }
    if (brand && brand !== 'all' && b !== brand) continue;

    let w = weeks.get(r.week);
    if (!w) {
      w = { week: r.week, weekEnd: _addDays(r.week, 6),
            impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0, campaigns: 0 };
      weeks.set(r.week, w);
    }
    w.impressions += r.impressions;
    w.clicks += r.clicks;
    w.orders += r.orders;
    w.spend += r.spend;
    w.sales += r.sales;
    w.campaigns++;
  }

  const series = [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map(w => ({
      ...w,
      spend: r2(w.spend),
      sales: r2(w.sales),
      acos: w.sales > 0 ? r4(w.spend / w.sales) : null,
      roas: w.spend > 0 ? r2(w.sales / w.spend) : null,
      cpc: w.clicks > 0 ? r2(w.spend / w.clicks) : null,
      ctr: w.impressions > 0 ? r4(w.clicks / w.impressions) : null,
      cvr: w.clicks > 0 ? r4(w.orders / w.clicks) : null
    }));

  const totals = series.reduce((t, w) => {
    t.impressions += w.impressions; t.clicks += w.clicks; t.orders += w.orders;
    t.spend += w.spend; t.sales += w.sales;
    return t;
  }, { impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 });
  totals.spend = r2(totals.spend);
  totals.sales = r2(totals.sales);
  totals.acos = totals.sales > 0 ? r4(totals.spend / totals.sales) : null;
  totals.roas = totals.spend > 0 ? r2(totals.sales / totals.spend) : null;
  totals.cpc = totals.clicks > 0 ? r2(totals.spend / totals.clicks) : null;
  totals.ctr = totals.impressions > 0 ? r4(totals.clicks / totals.impressions) : null;
  totals.cvr = totals.clicks > 0 ? r4(totals.orders / totals.clicks) : null;

  return {
    series,
    totals,
    brands: [...brands].sort(),
    coverage: {
      unmappedCampaigns: unmappedNames.size,
      unmappedSpend: r2(unmappedSpend)
    }
  };
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleWeeksGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : whSettledThrough(new Date());
    const weeksBack = Math.min(260, Math.max(1, Number(req.query.weeks) || 52));
    const from = DATE_RE.test(String(req.query.from || ''))
      ? req.query.from : _addDays(whMonday(to), -7 * (weeksBack - 1));

    const [rows, census] = await Promise.all([whLoadRange(from, to), loadCensus()]);
    if (!rows.length) {
      return res.status(200).json({ success: true, empty: true, from, to });
    }

    const brand = String(req.query.brand || 'all');
    const result = whSeries({ rows, census, brand });

    return res.status(200).json({
      success: true, from, to, brand,
      settledThrough: whSettledThrough(new Date()),
      censusSyncedAt: census.syncedAt,
      ...result
    });
  } catch (error) {
    console.error('[WEEKS GET] Error:', error);
    return res.status(500).json({ error: 'Weeks-get failed: ' + error.message });
  }
}

// Rebuilds weeks from the stored month buckets. Idempotent: every week it
// writes is settled, so running it twice changes nothing. Months that only ever
// held spend are refused rather than written as a week with no clicks in it,
// which would read as a collapse that never happened.
async function handleWeeksRebuild(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const index = (await kv.get('adspend:sp:index')) || [];
    if (!Array.isArray(index) || !index.length) {
      return res.status(409).json({ error: 'No monthly ad spend data is stored.' });
    }
    const startMonth = /^\d{4}-\d{2}$/.test(String(req.query.startMonth || ''))
      ? req.query.startMonth : index[0];
    const endMonth = /^\d{4}-\d{2}$/.test(String(req.query.endMonth || ''))
      ? req.query.endMonth : index[index.length - 1];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    if (!months.length) return res.status(400).json({ error: 'No stored months in that range.' });

    // Read one month at a time rather than all of them at once. Most of the
    // stored months carry spend and nothing else, and pulling every bucket into
    // memory before looking at any of them was the difference between a few
    // megabytes and most of ten.
    //
    // Weeks are only trustworthy inside a CONTIGUOUS run of usable months: a gap
    // would silently halve whichever week spans it. So rows accumulate for the
    // current run, and the run is binned and written the moment it ends.
    const settled = whSettledThrough(new Date());
    const usable = [];
    const skipped = [];
    const runs = [];
    const written = { weeks: 0, rows: 0, years: [] };

    let run = [];
    let runRows = [];

    const flush = async () => {
      if (!run.length) return;
      const coverStart = moMonthBounds(run[0]).start;
      const coverEnd = moMonthBounds(run[run.length - 1]).end;
      const binned = whBinWeeks(runRows, coverStart, coverEnd, settled);
      const w = await whUpsert(binned);
      written.weeks += w.weeks;
      written.rows += w.rows;
      for (const y of w.years) if (!written.years.includes(y)) written.years.push(y);
      runs.push(`${run[0]}..${run[run.length - 1]}`);
      run = [];
      runRows = [];
    };

    for (const month of months) {
      const bucket = await readAdMonth('sp', month);
      const monthRows = ((bucket && bucket.rows) || []);
      // A month written before the API sync took over carries spend and nothing
      // else. Binning it would invent a week of zero clicks and zero orders,
      // which reads as a collapse that never happened.
      const hasMetrics = monthRows.some(r => r.clicks !== undefined && r.sales7d !== undefined);
      if (!monthRows.length || !hasMetrics) {
        skipped.push({ month, reason: monthRows.length ? 'spend only' : 'empty' });
        await flush();
        continue;
      }
      if (run.length && moShiftMonth(run[run.length - 1], 1) !== month) await flush();
      run.push(month);
      runRows.push(...monthRows);
      usable.push(month);
    }
    await flush();

    if (!usable.length) {
      return res.status(409).json({
        error: 'None of those months carry clicks and sales, only spend. ' +
               'The API sync began writing full rows in 2026-03.',
        skipped
      });
    }

    return res.status(200).json({
      success: true, months: usable, skipped, runs, ...written
    });
  } catch (error) {
    console.error('[WEEKS REBUILD] Error:', error);
    return res.status(500).json({ error: 'Weeks-rebuild failed: ' + error.message });
  }
}

// Called from the weekly collect, manual and cron alike. The baseline is four
// whole settled weeks, so this is where the recent end of the series comes
// from — the month buckets are a month behind by construction.
async function whIngestWeeklyRun({ rows, census, window }) {
  try {
    const nameById = new Map();
    for (const c of (census.campaigns || [])) {
      if (c.campaignId && c.name) nameById.set(String(c.campaignId), c.name);
    }
    // The report knows campaign ids; the month buckets know names. One key, so
    // a week can arrive from either feed without splitting in two.
    const named = [];
    for (const r of rows) {
      const name = nameById.get(String(r.campaignId));
      if (name) named.push({ ...r, campaign: name });
    }
    const binned = whBinWeeks(named, window.baseStart, window.baseEnd,
                              whSettledThrough(new Date()));
    return await whUpsert(binned);
  } catch (err) {
    // Never fails the run that produced the data.
    console.error('[WEEKS] ingest from weekly run failed:', err.message);
    return { weeks: 0, rows: 0, years: [], error: err.message };
  }
}

export { evaluateWeek, rfBuildInputs, rfDecideAll, rfSaveRun, rfLoadRun,
         rfPortfolioFlags, rfPortfolioTotals, rfAttachNotes, rfNoteKey,
         rfNormalizeRows, resolveWindow, rfSegment, rfInvalidColumns,
         reportSpec, buildReportBody, daySpan, rfDuplicateReportId, rfRecommendBudget,
         rfRecommendBid, rfDecomposeSpend,
         RF_COLUMNS, RF_CONFIG, RF_SPEC_DEVIATIONS, REPORT_KEYS, MAX_REPORT_DAYS, MARGINS,
         bwDecide, bwNewBudget, evaluateBiweekly, resolveBiweeklyWindow, bwReportSpec,
         bwRecentRaises, bwBuildInputs, bwDecideAll, bwSaveRun, bwLoadRun,
         bwSaveAvailable, bwLoadAvailable, bwAdoptLatest, bwAdjustedAfter,
         adsCronIsRunDay, adsCronReport,
         moBuildInputs, moDecideAll, moRecommend, resolveMonthlyWindow, moReportSpec,
         moLoadBrandSales, moIsWholeMonth, moShiftMonth, moMonthBounds,
         moCronReport, moMonthLabel, moAvailability, moUnavailableReason,
         moRecommendSb, moSbChangeAfter,
         whMonday, whSettledThrough, whBinWeeks, whSeries,
         reportRetentionStart, REPORT_RETENTION_DAYS,
         MO_CONFIG, MO_REPORT_KEYS, MO_SPEC_DEVIATIONS, TARGET_ACOS,
         BW_CONFIG, BW_POSTURES, BW_REPORT_KEYS, BW_SPEC_DEVIATIONS,
         BW_INCREASES, BW_DECREASES };
