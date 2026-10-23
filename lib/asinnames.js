// What an ASIN actually is, so a search term reads as "World Gall" rather
// than "b07sxc739c".
//
// Roughly a sixth of this account's search term spend lands on ASIN-shaped
// terms — your ad appearing on a product's page, or a shopper pasting an ASIN
// into the search box — and unresolved they are unreadable.
//
// Two sources, cheapest first:
//   catalog  your own products table. Free, instant, never stale.
//   spapi    Amazon's Catalog Items API, for everyone else's.
//
// Names are cached because they almost never change and the API is rate
// limited. A lookup that found nothing is cached too — otherwise every page
// load would retry the same dead ASINs forever.

import { sql } from './sql.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS asin_names (
    asin       text PRIMARY KEY,
    title      text,
    brand      text,
    source     text        NOT NULL,
    found      boolean     NOT NULL DEFAULT true,
    fetched_at timestamptz NOT NULL DEFAULT now()
  )`
];

let ready = null;

export function ensure() {
  if (!ready) {
    ready = (async () => { for (const ddl of DDL) await sql().query(ddl); })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

// An ASIN is ten characters, letters and digits. Amazon's own are usually
// B0-prefixed; books keep their ISBN, which is ten digits. A lowercase word
// of ten letters is a search, not an ASIN, so it is excluded — "binoculars"
// would otherwise be looked up forever.
export const ASIN_RE = /^(?=.*[0-9])[0-9A-Za-z]{10}$/;

export const looksLikeAsin = (s) => ASIN_RE.test(String(s || ''));

export async function lookup(asins) {
  await ensure();
  const list = [...new Set((asins || []).map(a => String(a || '').toUpperCase()).filter(looksLikeAsin))];
  if (!list.length) return {};
  const rows = await sql().query(
    'SELECT asin, title, brand, source, found FROM asin_names WHERE asin = ANY($1::text[])', [list]);
  const out = {};
  for (const r of rows) {
    out[r.asin] = { asin: r.asin, title: r.title, brand: r.brand, source: r.source, found: r.found };
  }
  return out;
}

export async function record(entries) {
  await ensure();
  const list = (entries || []).filter(e => e && looksLikeAsin(e.asin));
  if (!list.length) return 0;
  await sql().query(
    `INSERT INTO asin_names (asin, title, brand, source, found, fetched_at)
     SELECT upper(a), t, b, s, f, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[]) AS v(a, t, b, s, f)
     ON CONFLICT (asin) DO UPDATE SET
       title = excluded.title, brand = excluded.brand, source = excluded.source,
       found = excluded.found, fetched_at = now()`,
    [list.map(e => e.asin), list.map(e => e.title ?? null), list.map(e => e.brand ?? null),
     list.map(e => e.source || 'spapi'), list.map(e => e.found !== false)]);
  return list.length;
}

// Your own catalog, which costs nothing to read and is always right. Run
// before any API call so the ASINs you sell are never looked up.
//
// One ASIN has several SKUs here — FBA, FBM, and the Amazon.Found. variant —
// so a name is picked rather than joined, preferring a real SKU's.
export async function fillFromCatalog() {
  await ensure();
  const res = await sql().query(
    `INSERT INTO asin_names (asin, title, brand, source, found, fetched_at)
     SELECT upper(asin), title, brand, 'catalog', true, now()
       FROM (
         SELECT DISTINCT ON (upper(asin)) asin,
                name AS title, brand
           FROM products
          WHERE asin IS NOT NULL AND asin <> ''
          ORDER BY upper(asin), (sku LIKE 'Amazon.Found.%'), sku
       ) p
     ON CONFLICT (asin) DO UPDATE SET
       title = excluded.title, brand = excluded.brand,
       source = 'catalog', found = true, fetched_at = now()
     RETURNING asin`);
  return res.length;
}

// ASINs appearing as search terms in a month that nothing has named yet,
// most expensive first — if only some get resolved, they should be the ones
// carrying the spend.
export async function unresolved(month, { adProduct = 'SP', limit = 100 } = {}) {
  await ensure();
  const rows = await sql().query(
    `SELECT upper(t.search_term) AS asin, sum(t.cost)::numeric AS cost
       FROM search_terms t
       LEFT JOIN asin_names n ON n.asin = upper(t.search_term)
      WHERE t.ad_product = $1 AND t.month = $2
        AND t.search_term ~ '^(?=.*[0-9])[0-9A-Za-z]{10}$'
        AND n.asin IS NULL
      GROUP BY 1
      ORDER BY sum(t.cost) DESC
      LIMIT $3::int`,
    [adProduct, month, Math.min(Number(limit) || 100, 500)]);
  return rows.map(r => r.asin);
}

export async function counts(month, { adProduct = 'SP' } = {}) {
  await ensure();
  const [r] = await sql().query(
    `SELECT count(*)::int AS asins,
            count(*) FILTER (WHERE n.asin IS NOT NULL)::int AS named,
            coalesce(sum(c.cost) FILTER (WHERE n.asin IS NULL), 0)::numeric AS unnamed_cost
       FROM (SELECT upper(search_term) AS asin, sum(cost) AS cost
               FROM search_terms
              WHERE ad_product = $1 AND month = $2
                AND search_term ~ '^(?=.*[0-9])[0-9A-Za-z]{10}$'
              GROUP BY 1) c
       LEFT JOIN asin_names n ON n.asin = c.asin`,
    [adProduct, month]);
  return { asins: r.asins, named: r.named, unnamedCost: Number(r.unnamed_cost) };
}
