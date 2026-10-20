import { kv } from '../lib/kv.js';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Listing-optimization Change Log. Used by the Listing Optimizations →
// Change Log tab on the dashboard. Replaces the Sheets-backed storage
// (ListingChangeLog!A:E) so anyone signed into the dashboard can write
// without needing per-Sheet share permissions — auth here is just
// "valid Google token", no sheet ACL involved.
//
//   GET  ?action=get                      — every entry (newest first)
//   POST ?action=add                      — one entry; body: { date, productName, asin, changes, notes }
//   POST ?action=bulk-add                 — many entries; body: { entries: [...] }
//   POST ?action=delete                   — by id; body: { id }
//   POST ?action=migrate-from-sheets      — one-time: read ListingChangeLog
//                                            tab from a Sheet and replace
//                                            Upstash contents. Requires
//                                            the user's Google bearer
//                                            token + body: { spreadsheetId }.
//
// KV layout:
//   changelog:entries → [{ id, createdAt, date, productName, asin, changes, notes }, ...]
//
// Entries are stored unsorted (insertion order) and sorted on read so we
// can keep adds O(1) without rewriting the whole array on every save.
// Each entry has a stable `id` (timestamp + random suffix) so the client
// can reference a specific row for delete/edit. `date` is the user-
// supplied YYYY-MM-DD; `createdAt` is server-side ISO when the entry
// was added (audit trail, never rendered in the table).
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

    const entries = (await kv.get('changelog:entries')) || [];
    // Newest first by user-supplied date, then by createdAt as a stable
    // tiebreaker for entries on the same date.
    const sorted = [...entries].sort((a, b) => {
      if ((b.date || '') !== (a.date || '')) return (b.date || '').localeCompare(a.date || '');
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    return res.status(200).json({ success: true, entries: sorted, count: sorted.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load change log: ' + error.message });
  }
}

// ─── ADD ─────────────────────────────────────────────────────────────────────
async function handleAdd(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const body = req.body || {};
    const cleaned = cleanEntry(body);
    if (!cleaned) {
      return res.status(400).json({ error: 'Entry must include date (YYYY-MM-DD), asin, and changes' });
    }
    const entry = { id: newId(), createdAt: new Date().toISOString(), ...cleaned };

    const entries = (await kv.get('changelog:entries')) || [];
    entries.push(entry);
    await kv.set('changelog:entries', entries);

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

    const body = req.body || {};
    const incoming = Array.isArray(body.entries) ? body.entries : [];
    if (incoming.length === 0) {
      return res.status(400).json({ error: 'entries array required' });
    }

    const accepted = [];
    const rejected = [];
    const now = new Date().toISOString();
    incoming.forEach((raw, idx) => {
      const cleaned = cleanEntry(raw);
      if (!cleaned) {
        rejected.push({ index: idx, reason: 'Missing required fields (date, asin, changes)' });
        return;
      }
      accepted.push({ id: newId(), createdAt: now, ...cleaned });
    });

    if (accepted.length === 0) {
      return res.status(400).json({ error: 'No valid entries', rejected });
    }

    const entries = (await kv.get('changelog:entries')) || [];
    for (const e of accepted) entries.push(e);
    await kv.set('changelog:entries', entries);

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

    const entries = (await kv.get('changelog:entries')) || [];
    const before = entries.length;
    const kept = entries.filter(e => e?.id !== id);
    if (kept.length === before) {
      return res.status(404).json({ error: 'Entry not found', id });
    }
    await kv.set('changelog:entries', kept);
    return res.status(200).json({ success: true, removed: before - kept.length });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

// ─── MIGRATE FROM SHEETS ─────────────────────────────────────────────────────
// One-time backfill: read the legacy ListingChangeLog tab and replace
// whatever's in Upstash with it. Idempotent — safe to re-run, but
// destructive (overwrites Upstash). Uses the caller's Google bearer
// token to read the Sheet so we don't need server-side Sheets creds.
async function handleMigrateFromSheets(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/ListingChangeLog!A2:E`;
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
      // Sheet column order: Date | Product Name | ASIN | Changes | Notes
      const [date, productName, asin, changes, notes] = row;
      const cleaned = cleanEntry({ date, productName, asin, changes, notes });
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

    await kv.set('changelog:entries', entries);
    return res.status(200).json({
      success: true,
      imported: entries.length,
      skipped,
      message: `Imported ${entries.length} entries from Sheets (${skipped} skipped due to missing required fields).`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Validate + normalize a raw entry. Returns the cleaned entry or null
// if required fields are missing. ASIN is uppercased; date must already
// be YYYY-MM-DD (the client `_normalizeBulkDate` handles that before
// posting). Notes / productName are optional.
function cleanEntry(raw) {
  const date = String(raw?.date || '').trim();
  const asin = String(raw?.asin || '').trim().toUpperCase();
  const changes = String(raw?.changes || '').trim();
  if (!date || !asin || !changes) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    productName: String(raw?.productName || '').trim(),
    asin,
    changes,
    notes: String(raw?.notes || '').trim()
  };
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
