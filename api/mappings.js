import { kv } from '../lib/kv.js';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Single endpoint serving product, brand, and fee mappings via ?type=.
//
//   GET  ?action=get          &type=product|brand|fee       — read full dict
//   GET  ?action=last-updated &type=product|brand|fee       — ISO timestamp
//   POST ?action=save-one     &type=product|brand|fee       — replace one entry
//   POST ?action=delete-one   &type=product|brand|fee       — remove one entry
//   POST ?action=bulk-upsert  &type=product|brand           — merge a CSV-style array
//   POST ?action=migrate      &type=product|brand           — one-time from Sheets
//
// KV layout:
//   mappings:product           → { [campaign]: { brand: str, skus: string[] } }
//   mappings:brand             → { [campaign]: string (brand) }
//   mappings:fee               → { [feeType]: '<statement line>' | '_skip' }
//                                  used by overview-upstash.js to override
//                                  SERVICE_FEE_LINE_MAP / V2024_LEAF_HANDLER
//                                  for fee/breakdown types Amazon adds. Save
//                                  body is { feeType, line }; '_skip' means
//                                  drop the amount entirely (net-zero).
//   mappings:<type>:updated-at → ISO timestamp of most recent write
export default async function handler(req, res) {
  const { action, type } = req.query;
  if (!action) return res.status(400).json({ error: 'Action parameter required' });
  if (!type || !['product', 'brand', 'fee'].includes(type)) {
    return res.status(400).json({ error: 'type must be "product", "brand", or "fee"' });
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (action === 'get')          return handleGet(req, res, type);
    if (action === 'last-updated') return handleLastUpdated(req, res, type);
  }
  if (req.method === 'POST') {
    if (action === 'save-one')    return handleSaveOne(req, res, type);
    if (action === 'delete-one')  return handleDeleteOne(req, res, type);
    if (action === 'bulk-upsert') return handleBulkUpsert(req, res, type);
    if (action === 'migrate')     return handleMigrate(req, res, type);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res, type) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const [mappings, updatedAt] = await Promise.all([
      kv.get(kvKey(type)),
      kv.get(`${kvKey(type)}:updated-at`)
    ]);
    return res.status(200).json({
      success: true,
      type,
      mappings: mappings || (type === 'product' ? {} : {}),
      updatedAt: updatedAt || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load mappings: ' + error.message });
  }
}

async function handleLastUpdated(req, res, type) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const updatedAt = await kv.get(`${kvKey(type)}:updated-at`);
    return res.status(200).json({ success: true, updatedAt: updatedAt || null });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── SAVE ONE ────────────────────────────────────────────────────────────────
// Replaces a single campaign's mapping. Saving with empty brand+skus (product)
// or empty brand (brand) deletes the key — matches the old Sheets "no brand
// and no skus means unmapped" semantics.
async function handleSaveOne(req, res, type) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    // Fee mappings are keyed differently — by feeType (a Finances-API
    // breakdownType / FeeType string) rather than campaign name. Body is
    // { feeType, line } where line is one of the statement line names or
    // '_skip' to drop the amount.
    if (type === 'fee') {
      const feeType = String(req.body?.feeType || '').trim();
      if (!feeType) return res.status(400).json({ error: 'feeType required' });
      const line = String(req.body?.line || '').trim();
      const current = (await kv.get(kvKey(type))) || {};
      if (!line) delete current[feeType];
      else        current[feeType] = line;
      await kv.set(kvKey(type), current);
      await kv.set(`${kvKey(type)}:updated-at`, new Date().toISOString());
      return res.status(200).json({ success: true, total: Object.keys(current).length });
    }

    const campaign = String(req.body?.campaign || '').trim();
    if (!campaign) return res.status(400).json({ error: 'campaign required' });

    const current = (await kv.get(kvKey(type))) || {};

    if (type === 'product') {
      const brand = String(req.body?.brand || '').trim();
      const skus  = Array.isArray(req.body?.skus)
        ? [...new Set(req.body.skus.map(s => String(s || '').trim()).filter(Boolean))]
        : [];
      if (!brand && skus.length === 0) delete current[campaign];
      else                              current[campaign] = { brand, skus };
    } else {
      const brand = String(req.body?.brand || '').trim();
      if (!brand) delete current[campaign];
      else         current[campaign] = brand;
    }

    await kv.set(kvKey(type), current);
    await kv.set(`${kvKey(type)}:updated-at`, new Date().toISOString());
    return res.status(200).json({ success: true, total: Object.keys(current).length });
  } catch (error) {
    return res.status(500).json({ error: 'Save failed: ' + error.message });
  }
}

// ─── DELETE ONE ──────────────────────────────────────────────────────────────
async function handleDeleteOne(req, res, type) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    // Fee mappings key by feeType; product/brand by campaign.
    const keyField = type === 'fee' ? 'feeType' : 'campaign';
    const key = String(req.body?.[keyField] || '').trim();
    if (!key) return res.status(400).json({ error: `${keyField} required` });
    const current = (await kv.get(kvKey(type))) || {};
    const existed = Object.prototype.hasOwnProperty.call(current, key);
    delete current[key];
    await kv.set(kvKey(type), current);
    await kv.set(`${kvKey(type)}:updated-at`, new Date().toISOString());
    return res.status(200).json({ success: true, existed, total: Object.keys(current).length });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

// ─── BULK UPSERT ─────────────────────────────────────────────────────────────
// Accepts CSV-shape rows: each row has Campaign Name, Brand, (SKU for product).
// Groups by campaign, merges into existing KV dict — existing campaigns not
// present in the upload are preserved. Headers matched case-insensitively.
async function handleBulkUpsert(req, res, type) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows array required' });

    const current = (await kv.get(kvKey(type))) || {};
    let addedCount = 0;
    let updatedCount = 0;

    if (type === 'product') {
      // Group the incoming flat rows back into { campaign: { brand, skus } }.
      const grouped = {};
      for (const row of rows) {
        const campaign = readField(row, 'Campaign Name');
        if (!campaign) continue;
        if (!grouped[campaign]) grouped[campaign] = { brand: '', skus: new Set() };
        const brand = readField(row, 'Brand');
        const sku   = readField(row, 'SKU');
        if (brand && !grouped[campaign].brand) grouped[campaign].brand = brand;
        if (sku) grouped[campaign].skus.add(sku);
      }
      for (const [campaign, data] of Object.entries(grouped)) {
        const wasExisting = !!current[campaign];
        current[campaign] = { brand: data.brand, skus: [...data.skus] };
        if (wasExisting) updatedCount++;
        else             addedCount++;
      }
    } else {
      for (const row of rows) {
        const campaign = readField(row, 'Campaign Name');
        const brand    = readField(row, 'Brand');
        if (!campaign || !brand) continue;
        const wasExisting = !!current[campaign];
        current[campaign] = brand;
        if (wasExisting) updatedCount++;
        else             addedCount++;
      }
    }

    await kv.set(kvKey(type), current);
    await kv.set(`${kvKey(type)}:updated-at`, new Date().toISOString());
    return res.status(200).json({
      success: true,
      addedCount,
      updatedCount,
      total: Object.keys(current).length
    });
  } catch (error) {
    return res.status(500).json({ error: 'Bulk upsert failed: ' + error.message });
  }
}

// ─── MIGRATE ─────────────────────────────────────────────────────────────────
// One-time: pull ProductAdMapping or BrandAdMapping from a Google Sheet and
// write the KV dict. Replaces the existing KV state for that type.
async function handleMigrate(req, res, type) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const sheetName = type === 'product' ? 'ProductAdMapping' : 'BrandAdMapping';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}`;
    const sheetsRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!sheetsRes.ok) {
      return res.status(502).json({ error: `Failed to read ${sheetName}: ${sheetsRes.status}` });
    }
    const body = await sheetsRes.json();
    const rows = body.values || [];
    if (rows.length < 2) {
      await kv.set(kvKey(type), {});
      await kv.set(`${kvKey(type)}:updated-at`, new Date().toISOString());
      return res.status(200).json({ success: true, total: 0, message: `${sheetName} was empty` });
    }

    const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = {
      campaign: headers.indexOf('campaign name'),
      brand:    headers.indexOf('brand'),
      sku:      headers.indexOf('sku')
    };
    if (idx.campaign === -1) {
      return res.status(400).json({ error: `${sheetName} missing "Campaign Name" column` });
    }

    const out = {};
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const campaign = String(row[idx.campaign] || '').trim();
      if (!campaign) continue;
      const brand = idx.brand !== -1 ? String(row[idx.brand] || '').trim() : '';

      if (type === 'product') {
        if (!out[campaign]) out[campaign] = { brand: '', skus: [] };
        if (brand && !out[campaign].brand) out[campaign].brand = brand;
        const sku = idx.sku !== -1 ? String(row[idx.sku] || '').trim() : '';
        if (sku && !out[campaign].skus.includes(sku)) out[campaign].skus.push(sku);
      } else {
        if (!brand) continue;
        out[campaign] = brand;
      }
    }

    await kv.set(kvKey(type), out);
    await kv.set(`${kvKey(type)}:updated-at`, new Date().toISOString());
    return res.status(200).json({
      success: true,
      total: Object.keys(out).length,
      message: `Migrated ${Object.keys(out).length} ${type} mappings from ${sheetName}`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function kvKey(type) {
  return `mappings:${type}`;
}

// Case-insensitive field lookup so the CSV's "Campaign Name" / "campaign name"
// / "CAMPAIGN NAME" all match.
function readField(row, name) {
  if (row && Object.prototype.hasOwnProperty.call(row, name)) {
    const v = row[name];
    return v == null ? '' : String(v).trim();
  }
  const target = name.toLowerCase();
  for (const k of Object.keys(row || {})) {
    if (k.toLowerCase() === target) {
      const v = row[k];
      return v == null ? '' : String(v).trim();
    }
  }
  return '';
}

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}
