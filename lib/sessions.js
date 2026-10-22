// SQL storage for daily traffic rows (the `session_traffic` table), used
// when SQL_TABLES includes "sessions" (see lib/sql.js). Otherwise rows stay
// in the single session_data kv record, as before.
//
// The data is an append-only list: rows come from the child-ASIN Sales &
// Traffic report but are stored under the parent ASIN, so a parent can have
// several rows for one day, and a re-synced day appears again. The table
// keeps that list exactly, repeats included, in append order (the identity
// column). Rows come out in the shape the rest of the code uses:
//   { date, asin, sessions, sessionPercentage, pageViews,
//     unitSessionPercentage, buyBoxPercentage }
//
// Table (created by tools/to-sql.mjs):
//   session_traffic (id identity primary key) plus an index on date.

import { sql, usesSql } from './sql.js';

export function sessionsInSql() {
  return usesSql('sessions');
}

// A missing date or asin was dropped from the kv JSON; keep it absent here.
const toRow = (r) => {
  const row = {};
  if (r.date !== null) row.date = r.date;
  if (r.asin !== null) row.asin = r.asin;
  row.sessions = r.sessions;
  row.sessionPercentage = Number(r.session_percentage);
  row.pageViews = r.page_views;
  row.unitSessionPercentage = Number(r.unit_session_percentage);
  row.buyBoxPercentage = Number(r.buy_box_percentage);
  return row;
};

// The whole list, in append order.
export async function getAll() {
  const rows = await sql().query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, asin, sessions,
      session_percentage, page_views, unit_session_percentage, buy_box_percentage
    FROM session_traffic ORDER BY id`);
  return rows.map(toRow);
}

export async function count() {
  const [{ n }] = await sql().query('SELECT count(*)::int AS n FROM session_traffic');
  return n;
}

// Append rows in the given order; returns the list's new length.
export async function append(rows) {
  const s = sql();
  if (rows.length) {
    await s.query(`INSERT INTO session_traffic (date, asin, sessions, session_percentage,
        page_views, unit_session_percentage, buy_box_percentage)
      SELECT v.date, v.asin, v.sessions, v.sp, v.pv, v.usp, v.bbp
      FROM unnest($1::date[], $2::text[], $3::int[], $4::numeric[], $5::int[], $6::numeric[], $7::numeric[])
        WITH ORDINALITY AS v(date, asin, sessions, sp, pv, usp, bbp, ord)
      ORDER BY v.ord`,
      [rows.map(r => r.date ?? null), rows.map(r => r.asin ?? null), rows.map(r => r.sessions),
       rows.map(r => r.sessionPercentage), rows.map(r => r.pageViews),
       rows.map(r => r.unitSessionPercentage), rows.map(r => r.buyBoxPercentage)]);
  }
  return count();
}
