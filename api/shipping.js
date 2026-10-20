import { kv } from '../lib/kv.js';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// ShipStation V1 API (ssapi.shipstation.com) with HTTP Basic auth.
//
//   GET  ?action=sync            [&month=YYYY-MM]  — pull ShipStation → KV
//   GET  ?action=get             &month=YYYY-MM    — rows for one month
//   GET  ?action=get-range       &startMonth=&endMonth=
//   GET  ?action=get-months                        — list of synced months
//   POST ?action=migrate-from-sheets               — backfill from Sheets tab
//   POST ?action=delete-sheets-rows                — cleanup helper (same
//                                                     pattern as adspend)
//
// Env vars:
//   SHIPSTATION_API_KEY
//   SHIPSTATION_API_SECRET
//
// KV layout:
//   shipping:raw:YYYY-MM           → { rows: [...] }
//   shipping:index                 → ['YYYY-MM', ...]
//   shipping:last-synced:YYYY-MM   → ISO timestamp
//
// Row shape (unified across API + Sheets backfill):
//   { shipDate, orderId, sku, qty, cost, carrier?, service? }
// API rows populate sku/qty by walking shipmentItems and allocating the
// shipment's total cost across items by quantity (so a shipment of 3×A + 2×B
// with $5 shipping produces rows A:$3.00, B:$2.00). Sheets rows have no
// sku — shipping cost for those still lands in FBM Shipping Costs totals
// but loses per-SKU drill-down.
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
    if (action === 'sync')                return handleSync(req, res);
    if (action === 'get')                 return handleGet(req, res);
    if (action === 'get-range')           return handleGetRange(req, res);
    if (action === 'get-months')          return handleGetMonths(req, res);
    if (action === 'sample-raw')          return handleSampleRaw(req, res);
    if (action === 'list-stores')         return handleListStores(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'migrate-from-sheets') return handleMigrateFromSheets(req, res);
    if (action === 'delete-sheets-rows')  return handleDeleteSheetsRows(req, res);
    if (action === 'upload-yearly-csv')   return handleUploadYearlyCsv(req, res);
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
    if (!process.env.SHIPSTATION_API_KEY || !process.env.SHIPSTATION_API_SECRET) {
      return res.status(500).json({ error: 'SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET not set' });
    }

    // Scope to one ShipStation store (= one sales channel). Default comes
    // from the SHIPSTATION_STORE_ID env var, override via &storeId=...
    // Without this filter we'd pull every channel — Amazon, Shopify, direct,
    // etc. — and the totals are meaningless for an Amazon-only P&L.
    const storeId = req.query.storeId || process.env.SHIPSTATION_STORE_ID || '';
    if (!storeId) {
      return res.status(400).json({
        error: 'storeId required. Call /api/shipping?action=list-stores to find the Amazon store\'s ID, then set SHIPSTATION_STORE_ID or pass &storeId=... on sync.'
      });
    }

    console.log(`[SHIPPING SYNC] Starting sync for ${month} (storeId=${storeId})`);
    const { start, end } = monthBoundDates(month);
    const shipments = await fetchAllShipments(start, end, storeId);
    const rows = normalizeShipments(shipments);

    await kv.set(`shipping:raw:${month}`, { rows });
    const index = (await kv.get('shipping:index')) || [];
    if (!index.includes(month)) {
      index.push(month);
      index.sort();
      await kv.set('shipping:index', index);
    }
    await kv.set(`shipping:last-synced:${month}`, new Date().toISOString());

    console.log(`[SHIPPING SYNC] ${month}: shipments=${shipments.length} rows=${rows.length}`);
    return res.status(200).json({
      success: true,
      month,
      shipmentCount: shipments.length,
      rows: rows.length,
      totalCost: round2(rows.reduce((s, r) => s + (r.cost || 0), 0)),
      message: `Synced ${shipments.length} shipments → ${rows.length} per-SKU rows for ${month}`
    });
  } catch (error) {
    console.error('[SHIPPING SYNC] Error:', error);
    return res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });

    const [stored, lastSynced] = await Promise.all([
      kv.get(`shipping:raw:${month}`),
      kv.get(`shipping:last-synced:${month}`)
    ]);
    return res.status(200).json({
      success: true,
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

    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) return res.status(400).json({ error: 'startMonth and endMonth required' });

    const index = (await kv.get('shipping:index')) || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`shipping:raw:${m}`)));
    const rows = [];
    for (const b of buckets) {
      if (b && Array.isArray(b.rows)) for (const r of b.rows) rows.push(r);
    }
    return res.status(200).json({ success: true, startMonth, endMonth, months, rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const index = (await kv.get('shipping:index')) || [];
    return res.status(200).json({ success: true, months: index });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── MIGRATE FROM SHEETS ─────────────────────────────────────────────────────
// Reads the Sheets ShippingCosts tab (Order #, Ship Date, Shipping Cost).
// Historical rows don't have SKU — stored with sku='' so the client can
// choose to lump them into the FBM total or surface as "pre-API" shipments.
async function handleMigrateFromSheets(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/ShippingCosts`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return res.status(502).json({ error: `ShippingCosts read failed (${r.status})` });
    const values = (await r.json()).values || [];
    if (values.length < 2) return res.status(200).json({ success: true, rows: 0, skippedMonths: [] });

    const headers = values[0].map(h => String(h || '').trim().toLowerCase());
    const iDate  = headers.indexOf('ship date');
    const iOrder = headers.findIndex(h => h === 'order #' || h === 'order number' || h === 'orderid');
    const iCost  = headers.indexOf('shipping cost');
    if (iDate === -1 || iCost === -1) {
      return res.status(400).json({ error: 'ShippingCosts missing required columns (Ship Date, Shipping Cost)' });
    }

    const byMonth = {};
    for (let i = 1; i < values.length; i++) {
      const row = values[i] || [];
      const shipDate = String(row[iDate] || '').trim().substring(0, 10);
      const cost = parseFloat(row[iCost]);
      if (!shipDate || !/^\d{4}-\d{2}-\d{2}$/.test(shipDate) || !Number.isFinite(cost)) continue;
      const month = shipDate.substring(0, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push({
        shipDate,
        orderId: iOrder === -1 ? '' : String(row[iOrder] || '').trim(),
        sku: '',
        qty: 0,
        cost
      });
    }

    // Same "skip if API data present" rule as ad spend. API rows have sku.
    const index = (await kv.get('shipping:index')) || [];
    let writtenRows = 0;
    const skippedMonths = [];
    for (const [month, rows] of Object.entries(byMonth)) {
      const existing = await kv.get(`shipping:raw:${month}`);
      const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
      if (existingRows.some(r => r && r.sku)) {
        skippedMonths.push(month);
        continue;
      }
      await kv.set(`shipping:raw:${month}`, { rows });
      writtenRows += rows.length;
      if (!index.includes(month)) index.push(month);
    }
    index.sort();
    await kv.set('shipping:index', index);

    return res.status(200).json({
      success: true,
      rows: writtenRows,
      skippedMonths,
      message: `Migrated ${writtenRows} rows; skipped ${skippedMonths.length} months with existing API data.`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── UPLOAD YEARLY CSV (ShipStation Shipments Export) ───────────────────────
//
// Client-parsed ShipStation export posted as JSON rows. Same KV target as
// the live ShipStation API sync (`shipping:raw:YYYY-MM`), but rows are
// stored without SKU/qty since the export doesn't include per-item
// breakdown (it has an `Items` integer for shipment count but not the
// SKU list). Total monthly shipping cost is preserved; per-SKU
// allocation isn't, which matches the Sheets-backfill row shape.
//
// Body: { rows: [{ ShipDate|shipDate, OrderNumber|orderId, CarrierFee|cost, Items|qty?, Carrier? }, ...] }
// `cost` comes from CarrierFee — what the seller paid the carrier — NOT
// ShippingPaid, which is the buyer-side amount (typically $0 for Prime
// orders) and irrelevant to FBM Shipping Costs on the seller's P&L.
// ShipDate may be an Excel serial number or an ISO/parseable date string —
// _shippingParseDateServer handles both.
async function handleUploadYearlyCsv(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rawRows) return res.status(400).json({ error: 'rows array required in body' });

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
    let skippedFree   = 0; // ShippingPaid = 0 — Amazon-paid Prime shipments
    for (const r of rawRows) {
      if (!r || typeof r !== 'object') continue;
      const shipDate = _shippingParseDateServer(pick(r, 'shipDate', 'ShipDate', 'ship date'));
      if (!shipDate) { skippedNoDate++; continue; }
      // Prefer CarrierFee. Tolerate Shipping Cost (the Sheets-migration
      // column name) and `cost` (already-normalized) for forward
      // compatibility, but DO NOT fall back to ShippingPaid — that's
      // the buyer-paid amount and would mis-attribute Prime orders as
      // free FBM shipping.
      const costRaw = pick(r, 'cost', 'CarrierFee', 'carrier fee', 'Shipping Cost', 'shipping cost');
      const cost = parseFloat(String(costRaw ?? '').replace(/[$,]/g, ''));
      if (!Number.isFinite(cost)) { skippedNoCost++; continue; }
      if (cost === 0) { skippedFree++; continue; } // 0 carrier fee → nothing to record
      const orderId = String(pick(r, 'orderId', 'OrderNumber', 'order number', 'Order #', 'OrderID') || '').trim();
      const qty = parseInt(pick(r, 'qty', 'Items', 'items'), 10) || 0;
      const carrier = String(pick(r, 'carrier', 'Carrier') || '').trim();
      const service = String(pick(r, 'service', 'Service', 'ServiceCode') || '').trim();

      const month = shipDate.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push({
        shipDate,
        orderId,
        sku: '',     // export doesn't provide line-item breakdown
        qty,
        cost,
        carrier: carrier || undefined,
        service: service || undefined
      });
    }

    // Same "skip month if API rows present" rule as migrate-from-sheets.
    // API rows have a non-empty sku; CSV-uploaded rows leave it blank.
    const index = (await kv.get('shipping:index')) || [];
    let writtenRows = 0;
    const writtenMonths = [];
    const skippedMonths = [];
    for (const [month, rows] of Object.entries(byMonth)) {
      const existing = await kv.get(`shipping:raw:${month}`);
      const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
      if (existingRows.some(rw => rw && rw.sku)) {
        skippedMonths.push(month);
        continue;
      }
      await kv.set(`shipping:raw:${month}`, { rows });
      writtenRows += rows.length;
      writtenMonths.push(month);
      if (!index.includes(month)) index.push(month);
    }
    index.sort();
    await kv.set('shipping:index', index);

    return res.status(200).json({
      success: true,
      writtenMonths: writtenMonths.sort(),
      writtenRows,
      skippedMonths,
      skippedNoDate,
      skippedNoCost,
      skippedFree,
      message: `Uploaded ${writtenRows} shipments across ${writtenMonths.length} months${skippedMonths.length ? `; skipped ${skippedMonths.length} months with API data already present` : ''}.`
    });
  } catch (error) {
    console.error('[SHIPPING UPLOAD-YEARLY] Error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}

// Accept Excel serial dates ("45628") or parseable strings ("2024-12-28",
// "Dec 28, 2024"). Returns YYYY-MM-DD or null. Excel's 1900-leap-year
// bug means serials > 59 need a -1 adjustment (Excel thinks Feb 29 1900
// exists; it doesn't).
function _shippingParseDateServer(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  // Excel serial — purely numeric (allow decimals for time-of-day; we
  // truncate). Decimals up to ~7 places appear in the user's
  // ShipStation export.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Math.floor(parseFloat(s));
    if (serial > 0 && serial < 100000) {
      const adjusted = serial > 59 ? serial - 1 : serial;
      const epoch = Date.UTC(1899, 11, 31);
      const ms = epoch + adjusted * 86400000;
      const d = new Date(ms);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    }
  }
  // Already ISO-shaped.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // "Dec 28, 2024" style.
  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m) {
    const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                     jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    const mm = months[m[1].toLowerCase().substring(0, 3)];
    if (mm) return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
  }
  // "MM/DD/YYYY" style.
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) {
    return `${m2[3]}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  }
  return null;
}

// ─── DELETE SHEETS-ONLY ROWS (same cleanup helper as adspend) ────────────────
async function handleDeleteSheetsRows(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const { month } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });

    const stored = await kv.get(`shipping:raw:${month}`);
    const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
    const before = rows.length;
    const kept = rows.filter(r => r && typeof r.sku === 'string' && r.sku.length > 0);
    await kv.set(`shipping:raw:${month}`, { rows: kept });
    return res.status(200).json({
      success: true, month,
      before: { rows: before, totalCost: round2(rows.reduce((s, r) => s + (r.cost || 0), 0)) },
      after:  { rows: kept.length, totalCost: round2(kept.reduce((s, r) => s + (r.cost || 0), 0)) },
      dropped: before - kept.length
    });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

// ─── DIAGNOSTIC: sample-raw ──────────────────────────────────────────────────
// Returns the first page of ShipStation's /shipments response unchanged so
// you can inspect the raw field names and values. Doesn't touch KV.
async function handleSampleRaw(req, res) {
  try {
    if (!process.env.SHIPSTATION_API_KEY || !process.env.SHIPSTATION_API_SECRET) {
      return res.status(500).json({ error: 'ShipStation credentials not set' });
    }
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const { start, end } = monthBoundDates(month);

    const url = `https://ssapi.shipstation.com/shipments?shipDateStart=${start}&shipDateEnd=${end}&pageSize=5&page=1&includeShipmentItems=true`;
    const r = await fetch(url, { headers: ssAuthHeader() });
    const body = await r.json();
    return res.status(200).json({
      success: r.ok,
      status: r.status,
      urlRequested: url,
      body
    });
  } catch (error) {
    return res.status(500).json({ error: 'Sample failed: ' + error.message });
  }
}

// ─── DIAGNOSTIC: list-stores ─────────────────────────────────────────────────
// Pull all connected sales channels from ShipStation so you can find the
// Amazon store's ID. Set that as SHIPSTATION_STORE_ID (or pass &storeId=...
// to sync) to scope shipments to Amazon only.
async function handleListStores(req, res) {
  try {
    if (!process.env.SHIPSTATION_API_KEY || !process.env.SHIPSTATION_API_SECRET) {
      return res.status(500).json({ error: 'ShipStation credentials not set' });
    }
    const r = await fetch('https://ssapi.shipstation.com/stores', { headers: ssAuthHeader() });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'list-stores failed', body });
    // Trim down to just the fields that actually help identify the store.
    const trimmed = (Array.isArray(body) ? body : []).map(s => ({
      storeId: s.storeId,
      storeName: s.storeName,
      marketplaceId: s.marketplaceId,
      marketplaceName: s.marketplaceName,
      active: s.active
    }));
    return res.status(200).json({ success: true, stores: trimmed });
  } catch (error) {
    return res.status(500).json({ error: 'List stores failed: ' + error.message });
  }
}

// ─── SHIPSTATION API CLIENT ──────────────────────────────────────────────────

function ssAuthHeader() {
  const basic = Buffer.from(
    `${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`
  ).toString('base64');
  return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
}

// Walks ShipStation's /shipments endpoint with pagination and returns every
// shipment in [start, end]. includeShipmentItems=true attaches the items
// array so we can do per-SKU cost allocation.
async function fetchAllShipments(shipDateStart, shipDateEnd, storeId) {
  const all = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `https://ssapi.shipstation.com/shipments?` +
                `shipDateStart=${shipDateStart}&shipDateEnd=${shipDateEnd}` +
                `&storeId=${encodeURIComponent(storeId)}` +
                `&pageSize=500&page=${page}&includeShipmentItems=true`;
    const res = await fetch(url, { headers: ssAuthHeader() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ShipStation ${res.status}: ${text}`);
    }
    const body = await res.json();
    const shipments = body.shipments || [];
    all.push(...shipments);
    totalPages = Number(body.pages) || 1;

    // ShipStation rate limit is 40/min. Light throttle between pages keeps
    // us well under even with a busy month.
    if (page < totalPages) await sleep(500);
    page++;
  } while (page <= totalPages && page < 200);

  return all;
}

// Expand each shipment into one row per SKU, allocating the shipment's total
// cost across items by quantity. A 3×A + 2×B shipment at $5.00 gets split
// A:$3.00, B:$2.00. Shipments with no itemized detail emit one sku-less row
// carrying the full cost so the monthly total still reconciles.
function normalizeShipments(shipments) {
  const rows = [];
  for (const s of shipments) {
    const shipDate = (s.shipDate || '').substring(0, 10);
    if (!shipDate) continue;
    const orderId = s.orderNumber || String(s.orderId || '') || '';
    const cost = Number(s.shipmentCost) || 0;
    const carrier = s.carrierCode || '';
    const service = s.serviceCode || '';
    const items = Array.isArray(s.shipmentItems) ? s.shipmentItems : [];

    if (items.length === 0) {
      rows.push({ shipDate, orderId, sku: '', qty: 0, cost: round2(cost), carrier, service });
      continue;
    }
    const totalQty = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    if (totalQty === 0) {
      // Items present but qty zero — treat as sku-less to not lose the cost.
      rows.push({ shipDate, orderId, sku: '', qty: 0, cost: round2(cost), carrier, service });
      continue;
    }
    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      if (qty === 0) continue;
      const allocated = cost * (qty / totalQty);
      rows.push({
        shipDate,
        orderId,
        sku: String(item.sku || '').trim(),
        qty,
        cost: round2(allocated),
        carrier,
        service
      });
    }
  }
  return rows;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
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

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
