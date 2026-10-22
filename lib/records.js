// Records stored as table rows that read back exactly as written: same keys,
// same order, same values and types, null kept distinct from an absent key.
//
// A spec lists a record's fields as typed columns: [[field, column, type]],
// type one of text | numeric | boolean | json. Each table built from a spec
// also has
//   fields  text[]  the record's keys in order;
//   extra   json    any field the spec doesn't list, or whose value isn't the
//                   column's type (a number where text was expected, say),
//                   so nothing is ever coerced or dropped.
// A field whose value is null is in `fields` with a NULL column.

const JSON_TYPE = { text: 'string', numeric: 'number', boolean: 'boolean' };

// The spec's column names, then fields and extra, for an INSERT column list.
export function recordColumns(spec) {
  return [...spec.map(([, col]) => col), 'fields', 'extra'].join(', ');
}

// SQL expressions turning the json record `e` into the spec's columns, then
// fields, then extra, in recordColumns order. aliased names each one after
// its column (for a SELECT whose rows are compared by column).
export function recordValues(spec, e, { aliased = false } = {}) {
  const exprs = recordExprs(spec, e);
  if (!aliased) return exprs.join(',\n    ');
  const names = recordColumns(spec).split(', ');
  return exprs.map((x, i) => `${x} AS ${names[i]}`).join(',\n    ');
}

function recordExprs(spec, e) {
  const values = spec.map(([field, , type]) => {
    if (type === 'json') return `${e}->'${field}'`;
    const cast = type === 'text' ? `${e}->>'${field}'` : `(${e}->>'${field}')::${type}`;
    return `CASE WHEN json_typeof(${e}->'${field}') = '${JSON_TYPE[type]}' THEN ${cast} END`;
  });
  const named = spec.map(([field]) => `'${field}'`).join(', ');
  const mistyped = spec.filter(([, , type]) => type !== 'json')
    .map(([field, , type]) => `(x.k = '${field}' AND json_typeof(x.v) NOT IN ('${JSON_TYPE[type]}', 'null'))`);
  values.push(`ARRAY(SELECT json_object_keys(${e}))`);
  values.push(`(SELECT json_object_agg(x.k, x.v) FROM json_each(${e}) AS x(k, v)
     WHERE x.k <> ALL(ARRAY[${named}]::text[])${mistyped.length ? ' OR ' + mistyped.join(' OR ') : ''})`);
  return values;
}

// recordColumns with json columns as text, for EXCEPT comparisons (json has
// no equality operator; its exact text does).
export function recordCompareColumns(spec) {
  return [...spec.map(([, col, type]) => (type === 'json' ? `${col}::text AS ${col}` : col)),
    'fields', 'extra::text AS extra'].join(', ');
}

// The SELECT list that reads the columns back for toRecord.
export function recordSelect(spec) {
  return recordColumns(spec);
}

// A row read with recordSelect, as the record it was written from.
export function toRecord(row, spec) {
  const extra = row.extra || {};
  const byField = new Map(spec.map(s => [s[0], s]));
  const out = {};
  for (const field of row.fields) {
    if (Object.prototype.hasOwnProperty.call(extra, field)) { out[field] = extra[field]; continue; }
    const [, col, type] = byField.get(field);
    const v = row[col];
    out[field] = v === null ? null : type === 'numeric' ? Number(v) : v;
  }
  return out;
}
