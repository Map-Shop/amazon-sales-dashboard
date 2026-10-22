import { kv } from '../lib/kv.js';
import * as productsSql from '../lib/products.js';
import * as stamps from '../lib/stamps.js';

// The catalog and its replacement — the products table when SQL_TABLES
// includes "products", otherwise the `products` kv record. The
// products:updated-at timestamp stays in kv either way. readProducts is
// also used by the profitability statement (api/transactions.js).
export async function readProducts() {
  if (productsSql.productsInSql()) return productsSql.getProducts();
  return kv.get('products');
}
async function writeProducts(products) {
  if (productsSql.productsInSql()) return productsSql.replaceProducts(products);
  return kv.set('products', products);
}
// When the catalog was last written: edit_stamps when SQL_TABLES includes
// "stamps" (lib/stamps.js), otherwise the products:updated-at kv record.
function readProductsStamp() {
  return stamps.stampsInSql() ? stamps.getEditStamp('products') : kv.get('products:updated-at');
}
function writeProductsStamp(at) {
  return stamps.stampsInSql() ? stamps.setEditStamp('products', at) : kv.set('products:updated-at', at);
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//  GET  ?action=get                          — read full catalog
//  POST ?action=bulk-upsert                  — upsert an array of products by SKU
//  POST ?action=replace                      — wholesale replace (used by migration)
//  POST ?action=migrate                      — one-time: copy from Sheets Products tab
//  GET  ?action=last-updated                 — when was the catalog last written
//
// Schema per product:
//   { sku, name, brand, fulfillment, cost, asin, type, status,
//     transactionFees, fbaFees, avgShipping }
// The three trailing dollar-amount fields feed the estimated-profit
// calculation on the Price Change Impacts tab:
//   transactionFees — Amazon referral / variable closing fees per unit
//                     (applies to both FBA and FBM)
//   fbaFees         — FBA pick/pack/ship per unit (FBA-only; leave 0 for FBM)
//   avgShipping     — average outbound carrier cost per shipment (FBM-only;
//                     leave 0 for FBA — Amazon handles shipping out of the
//                     FBA fee on those)
// All three default to 0 so products that pre-date this column addition
// (and any product whose fees the user hasn't filled in yet) just don't
// contribute to estimated profit until the value is set.
// KV layout:
//   products            → array of product objects (source of truth)
//   products:updated-at → ISO timestamp of the last write
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
    if (action === 'get')          return handleGet(req, res);
    if (action === 'last-updated') return handleLastUpdated(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'bulk-upsert') return handleBulkUpsert(req, res);
    if (action === 'replace')     return handleReplace(req, res);
    if (action === 'migrate')     return handleMigrate(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ─────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [products, updatedAt] = await Promise.all([
      readProducts(),
      readProductsStamp()
    ]);

    return res.status(200).json({
      success: true,
      products: products || [],
      updatedAt: updatedAt || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load products: ' + error.message });
  }
}

async function handleLastUpdated(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const updatedAt = await readProductsStamp();
    return res.status(200).json({ success: true, updatedAt: updatedAt || null });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── BULK UPSERT ─────────────────────────────────────────────────────────────
// Merges the provided products into the existing catalog keyed by SKU.
// Same semantics as the current Sheets-based flow (update-or-add-by-SKU).
async function handleBulkUpsert(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const incoming = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!incoming) return res.status(400).json({ error: 'products array required' });

    const existing = (await readProducts()) || [];
    const bySku = {};
    for (const p of existing) if (p?.sku) bySku[p.sku] = p;

    let addedCount = 0;
    let updatedCount = 0;
    for (const p of incoming) {
      const sku = p?.sku;
      if (!sku) continue;
      // Partial normalization: only fields present on the incoming object
      // end up in the merged result. This way an upload CSV that's missing
      // a column (e.g. status) doesn't clobber existing values for that
      // field on already-stored products.
      const partial = normalizeProduct(p, { partial: true });
      if (bySku[sku]) {
        bySku[sku] = { ...defaultsFor(bySku[sku]), ...bySku[sku], ...partial };
        updatedCount++;
      } else {
        bySku[sku] = { ...defaultsFor(partial), ...partial };
        addedCount++;
      }
    }

    const merged = Object.values(bySku).sort((a, b) => a.sku.localeCompare(b.sku));
    await writeProducts(merged);
    await writeProductsStamp(new Date().toISOString());

    return res.status(200).json({
      success: true,
      addedCount,
      updatedCount,
      total: merged.length
    });
  } catch (error) {
    return res.status(500).json({ error: 'Bulk upsert failed: ' + error.message });
  }
}

// ─── REPLACE ─────────────────────────────────────────────────────────────────
// Nukes the catalog and writes the provided array wholesale. Use with care.
async function handleReplace(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const incoming = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!incoming) return res.status(400).json({ error: 'products array required' });

    const normalized = incoming
      .filter(p => p?.sku)
      .map(normalizeProduct)
      .sort((a, b) => a.sku.localeCompare(b.sku));

    await writeProducts(normalized);
    await writeProductsStamp(new Date().toISOString());

    return res.status(200).json({ success: true, total: normalized.length });
  } catch (error) {
    return res.status(500).json({ error: 'Replace failed: ' + error.message });
  }
}

// ─── MIGRATE ─────────────────────────────────────────────────────────────────
// One-time: pull the Products tab from a Google Sheet and write to KV.
// POST body: { spreadsheetId }    (the user's Google token comes via header)
async function handleMigrate(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Products`;
    const sheetsRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!sheetsRes.ok) {
      return res.status(502).json({ error: `Failed to read Products tab: ${sheetsRes.status}` });
    }

    const body = await sheetsRes.json();
    const rows = body.values || [];
    if (rows.length < 2) {
      return res.status(200).json({ success: true, total: 0, message: 'Products tab was empty' });
    }

    // Normalize header names (case-insensitive) so we accept the exact Sheet
    // columns the user described. "status" is optional — it was added later
    // and the legacy Sheet may not have it yet.
    const headerRow = rows[0].map(h => String(h || '').trim().toLowerCase());
    // Map each known field to its column index. PRODUCT_FIELDS may contain
    // camelCase names; the legacy Sheet has all lowercase headers, so
    // lowercase both sides for the match.
    const FIELDS = PRODUCT_FIELDS;
    const colIdx = {};
    for (const f of FIELDS) colIdx[f] = headerRow.indexOf(f.toLowerCase());

    if (colIdx.sku === -1) {
      return res.status(400).json({ error: 'Products tab missing a "sku" column' });
    }

    const products = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sku = (row[colIdx.sku] ?? '').toString().trim();
      if (!sku) continue;
      const p = { sku };
      for (const f of FIELDS) {
        if (f === 'sku' || colIdx[f] === -1) continue;
        p[f] = (row[colIdx[f]] ?? '').toString().trim();
      }
      products.push(normalizeProduct(p));
    }

    products.sort((a, b) => a.sku.localeCompare(b.sku));
    await writeProducts(products);
    await writeProductsStamp(new Date().toISOString());

    return res.status(200).json({
      success: true,
      total: products.length,
      message: `Migrated ${products.length} products from Sheets to Upstash`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Known product fields. Order matters for CSV/migration.
const PRODUCT_FIELDS = [
  'sku', 'name', 'brand', 'fulfillment', 'cost', 'asin', 'type', 'status',
  // Numeric per-unit / per-shipment cost components used for estimated
  // profit. See the schema comment at the top of this file.
  'transactionFees', 'fbaFees', 'avgShipping'
];

// Fields that should be parsed and stored as numbers (defaulting to 0 when
// missing / unparseable). Anything not in this set is treated as a string.
const NUMERIC_FIELDS = new Set(['cost', 'transactionFees', 'fbaFees', 'avgShipping']);

// Shape each incoming product consistently. In { partial: true } mode we
// only emit fields that were actually present on the input — useful for
// bulk-upsert so a CSV that omits a column doesn't wipe that field on
// existing products. In full mode every known field is emitted, defaulting
// strings to '' and numerics to 0.
//
// Numeric fields (cost, transactionFees, fbaFees, avgShipping) accept
// strings with currency symbols / commas so a CSV with "$1.25" or "1,234.56"
// parses correctly — anything that fails parseFloat becomes 0.
function normalizeProduct(p, { partial = false } = {}) {
  const str = (v) => (v == null ? '' : String(v).trim());
  const num = (v) => {
    if (v == null || v === '') return 0;
    const n = parseFloat(String(v).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const out = {};
  for (const f of PRODUCT_FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(p, f);
    if (partial && !present) continue;
    out[f] = NUMERIC_FIELDS.has(f) ? num(p[f]) : str(p[f]);
  }
  return out;
}

// Fill any missing known fields with sensible defaults (empty string / 0).
// Used by bulk-upsert to guarantee stored products always have every field,
// even if an upload only set a subset.
function defaultsFor(_partial) {
  return {
    sku: '', name: '', brand: '', fulfillment: '',
    cost: 0, asin: '', type: '', status: '',
    transactionFees: 0, fbaFees: 0, avgShipping: 0
  };
}

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}
