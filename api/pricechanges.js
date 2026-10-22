import { kv } from '../lib/kv.js';
import * as entriesSql from '../lib/entries.js';

// The log in the order entries were added, and changes to it — the
// price_changes table when SQL_TABLES includes "pricechanges", otherwise
// the pricechanges:entries kv record.
const LOG = 'pricechanges';
async function readEntries() {
  if (entriesSql.listInSql(LOG)) return entriesSql.getAll(LOG);
  return (await kv.get('pricechanges:entries')) || [];
}
async function appendEntries(added) {
  if (entriesSql.listInSql(LOG)) return entriesSql.append(LOG, added);
  const entries = (await kv.get('pricechanges:entries')) || [];
  for (const e of added) entries.push(e);
  await kv.set('pricechanges:entries', entries);
}
// Returns how many entries were removed.
async function deleteEntry(id) {
  if (entriesSql.listInSql(LOG)) return entriesSql.deleteById(LOG, id);
  const entries = (await kv.get('pricechanges:entries')) || [];
  const kept = entries.filter(e => e?.id !== id);
  if (kept.length !== entries.length) await kv.set('pricechanges:entries', kept);
  return entries.length - kept.length;
}
async function replaceEntries(entries) {
  if (entriesSql.listInSql(LOG)) return entriesSql.replaceAll(LOG, entries);
  await kv.set('pricechanges:entries', entries);
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Price-change log. Used by the Sales & Volume → Price Change Impacts
// tab. Replaces the Sheets-backed `PriceChanges!A:D` storage so anyone
// signed into the dashboard can write without needing per-Sheet share
// permissions — auth here is just "valid Google token", no sheet ACL
// involved.
//
//   GET  ?action=get                      — every entry (newest first)
//   POST ?action=add                      — one entry; body: { date, sku, oldPrice, newPrice }
//   POST ?action=bulk-add                 — many entries; body: { entries: [...] }
//   POST ?action=delete                   — by id; body: { id }
//   POST ?action=migrate-from-sheets      — one-time: read PriceChanges
//                                            tab from a Sheet and replace
//                                            Upstash contents. Requires
//                                            the user's Google bearer
//                                            token + body: { spreadsheetId }.
//
// KV layout:
//   pricechanges:entries → [{ id, createdAt, date, sku, oldPrice, newPrice }, ...]
//
// Mirrors the changelog API exactly — entries stored unsorted, sorted on
// read. Each entry has a stable `id` so the client can target a row for
// delete/edit. `date` is the user-supplied YYYY-MM-DD; `createdAt` is
// the server-side ISO timestamp when the entry was added (audit trail,
// never rendered in the table). Prices are stored as numbers.
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
    if (action === 'get') return handleGet(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'add')                 return handleAdd(req, res);
    if (action === 'bulk-add')            return handleBulkAdd(req, res);
    if (action === 'delete')              return handleDelete(req, res);
    if (action === 'migrate-from-sheets') return handleMigrateFromSheets(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const entries = await readEntries();
    // Newest first by user-supplied date, then by createdAt as a stable
    // tiebreaker for entries on the same date.
    const sorted = [...entries].sort((a, b) => {
      if ((b.date || '') !== (a.date || '')) return (b.date || '').localeCompare(a.date || '');
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    return res.status(200).json({ success: true, entries: sorted, count: sorted.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load price changes: ' + error.message });
  }
}

// ─── ADD ─────────────────────────────────────────────────────────────────────
async function handleAdd(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const cleaned = cleanEntry(req.body || {});
    if (!cleaned) {
      return res.status(400).json({ error: 'Entry must include date (YYYY-MM-DD), sku, oldPrice, newPrice' });
    }
    const entry = { id: newId(), createdAt: new Date().toISOString(), ...cleaned };

    await appendEntries([entry]);

    return res.status(200).json({ success: true, entry });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to add entry: ' + error.message });
  }
}

// ─── BULK ADD ────────────────────────────────────────────────────────────────
async function handleBulkAdd(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const incoming = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (incoming.length === 0) {
      return res.status(400).json({ error: 'entries array required' });
    }

    const accepted = [];
    const rejected = [];
    const now = new Date().toISOString();
    incoming.forEach((raw, idx) => {
      const cleaned = cleanEntry(raw);
      if (!cleaned) {
        rejected.push({ index: idx, reason: 'Missing required fields (date, sku, oldPrice, newPrice)' });
        return;
      }
      accepted.push({ id: newId(), createdAt: now, ...cleaned });
    });

    if (accepted.length === 0) {
      return res.status(400).json({ error: 'No valid entries', rejected });
    }

    await appendEntries(accepted);

    return res.status(200).json({
      success: true,
      added: accepted.length,
      rejectedCount: rejected.length,
      rejected
    });
  } catch (error) {
    return res.status(500).json({ error: 'Bulk add failed: ' + error.message });
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────
async function handleDelete(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const removed = await deleteEntry(id);
    if (removed === 0) {
      return res.status(404).json({ error: 'Entry not found', id });
    }
    return res.status(200).json({ success: true, removed });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

// ─── MIGRATE FROM SHEETS ─────────────────────────────────────────────────────
// One-time backfill: read the legacy PriceChanges tab and replace
// whatever's in Upstash with it. Idempotent (safe to re-run, but
// destructive — overwrites Upstash). Uses the caller's Google bearer
// token to read the Sheet so we don't need server-side Sheets creds.
async function handleMigrateFromSheets(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    // PriceChanges sheet schema: Date | SKU | Old Price | New Price.
    // Header row stays in the sheet (row 1); we read from row 2 down.
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/PriceChanges!A2:D`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: `Sheets read failed: ${errText}` });
    }
    const data = await r.json();
    const rows = Array.isArray(data.values) ? data.values : [];

    const now = new Date().toISOString();
    const entries = [];
    let skipped = 0;
    rows.forEach((row, idx) => {
      const [date, sku, oldPrice, newPrice] = row;
      const cleaned = cleanEntry({ date, sku, oldPrice, newPrice });
      if (!cleaned) { skipped++; return; }
      entries.push({
        // Deterministic id derived from the row index keeps re-runs
        // stable (same row → same id) so a repeat migration doesn't
        // duplicate when the user accidentally clicks twice.
        id: `migrated-${idx}`,
        createdAt: now,
        ...cleaned
      });
    });

    await replaceEntries(entries);
    return res.status(200).json({
      success: true,
      imported: entries.length,
      skipped,
      message: `Imported ${entries.length} entries from Sheets (${skipped} skipped due to missing/invalid required fields).`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Validate + normalize a raw entry. Returns the cleaned entry or null
// if any required field is missing or unparsable. Date must already
// be YYYY-MM-DD (the client normalizes before posting). Prices are
// coerced to finite numbers.
function cleanEntry(raw) {
  const date = String(raw?.date || '').trim();
  const sku  = String(raw?.sku  || '').trim();
  if (!date || !sku) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const oldPrice = parseFloat(raw?.oldPrice);
  const newPrice = parseFloat(raw?.newPrice);
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) return null;

  return { date, sku, oldPrice, newPrice };
}

// Lightweight unique id: timestamp + 6 random base-36 chars. Avoids
// pulling in crypto.randomUUID's import path; collision probability
// across realistic usage is effectively nil.
function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}
