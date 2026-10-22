// SQL storage for the product catalog (the `products` table), used when
// SQL_TABLES includes "products" (see lib/sql.js). Otherwise the catalog
// stays in the single `products` kv record, as before.
//
// Every write rebuilds the whole catalog in code (merge by SKU, then sort
// with localeCompare), so the table stores the catalog as written, in
// position order, rather than re-sorting it: database collation can order
// hyphens and case differently from localeCompare. A field the stored
// product didn't have (older products predate the three fee fields) is NULL
// and comes back absent. Products come out in the shape the APIs store:
//   { sku, name, brand, fulfillment, cost, asin, type, status,
//     transactionFees, fbaFees, avgShipping }
//
// Table (created by tools/to-sql.mjs): products (position) primary key,
// plus an index on sku.

import { sql, usesSql } from './sql.js';

// [field, column, sql type], in the catalog's field order.
export const PRODUCT_COLUMNS = [
  ['sku', 'sku', 'text'], ['name', 'name', 'text'], ['brand', 'brand', 'text'],
  ['fulfillment', 'fulfillment', 'text'], ['cost', 'cost', 'numeric'], ['asin', 'asin', 'text'],
  ['type', 'type', 'text'], ['status', 'status', 'text'],
  ['transactionFees', 'transaction_fees', 'numeric'], ['fbaFees', 'fba_fees', 'numeric'],
  ['avgShipping', 'avg_shipping', 'numeric']
];

export function productsInSql() {
  return usesSql('products');
}

const toProduct = (r) => {
  const p = {};
  for (const [field, , type] of PRODUCT_COLUMNS) {
    if (r[field] === null) continue;
    p[field] = type === 'numeric' ? Number(r[field]) : r[field];
  }
  return p;
};

// The whole catalog, in stored order.
export async function getProducts() {
  const select = PRODUCT_COLUMNS.map(([field, col]) => `${col} AS "${field}"`).join(', ');
  const rows = await sql().query(`SELECT ${select} FROM products ORDER BY position`);
  return rows.map(toProduct);
}

// Replace the catalog with exactly the given products, in order.
export async function replaceProducts(products) {
  const s = sql();
  const statements = [s.query('DELETE FROM products')];
  if (products.length) {
    const cols = PRODUCT_COLUMNS.map(([, col]) => col).join(', ');
    const unnest = PRODUCT_COLUMNS.map(([, , type], i) => `$${i + 1}::${type}[]`).join(', ');
    statements.push(s.query(
      `INSERT INTO products (position, ${cols})
       SELECT ord - 1, ${cols} FROM unnest(${unnest}) WITH ORDINALITY AS v(${cols}, ord)`,
      PRODUCT_COLUMNS.map(([field]) => products.map(p => (p[field] === undefined ? null : p[field])))));
  }
  await s.transaction(statements);
}
