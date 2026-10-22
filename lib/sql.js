// Shared Neon connection for the SQL tables, and the switch that says
// which data sets use them.
//
// SQL_TABLES lists the data sets read and written through SQL tables,
// comma-separated (e.g. "orders,shipping"). A data set not listed keeps
// using its records in the kv table, so each one can be built, verified,
// and switched on independently.

import { neon } from '@neondatabase/serverless';

export function usesSql(name) {
  return String(process.env.SQL_TABLES || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .includes(name);
}

let _sql;
export function sql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('SQL_TABLES is set but DATABASE_URL is not');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}
