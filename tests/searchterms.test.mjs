// Search term reporting, phase 1: which month can be asked for, and what comes
// back from Amazon's answer.
//
// The expensive mistake here is not a wrong number on screen — it is a month
// that was never pulled. Amazon keeps 95 days of Sponsored Products reporting
// and nothing reconstructs a month past that, so the rules about which months
// are still reachable are worth pinning exactly.
import { loadAdspend } from './harness.mjs';

const { M, cleanup } = await loadAdspend('st');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// ─── SETTLING ────────────────────────────────────────────────────────────────

console.log('\nSETTLING  — a month is complete a week after it ends');

{
  // September ends on the 30th; Sponsored Products keeps crediting a click for
  // 7 days, so the month is whole on 8 October.
  ok(M.stMonthSettled('2026-09', '2026-10-08') === true, 'September is settled on 8 October');
  ok(M.stMonthSettled('2026-09', '2026-10-07') === false,
     'and not on the 7th', 'the last day of the month is still collecting');
  ok(M.stMonthSettled('2026-02', '2026-03-08') === true,
     'a short month settles on its own length', 'February ends on the 28th in 2026');
}

{
  ok(M.stDefaultMonth('2026-10-23') === '2026-09', 'late October offers September');
  ok(M.stDefaultMonth('2026-10-05') === '2026-08',
     'early October still offers August',
     'September has not finished crediting, and a part-attributed month would read as a bad one');
}

// ─── WHAT CAN STILL BE ASKED FOR ─────────────────────────────────────────────

console.log('\nRETENTION  \u2014 65 days of search terms, not the 95 a campaign report keeps');

// Read off Amazon itself: asked for August on 23 October it returned the 19th
// onward and called that a success. 23 October minus 65 days is 19 August.
ok(M.REPORT_RETENTION_DAYS.spSearchTerm === 65 && M.REPORT_RETENTION_DAYS.sp === 95,
   'the search term report has its own, shorter retention',
   'one number for both is what let a short month through');

{
  const months = M.stPullableMonths('2026-10-23');
  const by = Object.fromEntries(months.map(m => [m.month, m]));

  ok(!!by['2026-09'] && by['2026-09'].partial === false,
     'on 23 October September is whole');
  ok(by['2026-09'].clipsAt === '2026-11-05' && by['2026-09'].expires === '2026-12-04',
     'and is dated with when it starts losing days and when the last of it goes',
     `${by['2026-09'].clipsAt} / ${by['2026-09'].expires}`);

  ok(!!by['2026-08'] && by['2026-08'].partial === true,
     'August is still offered, and marked short',
     'half a month is worth capturing, so it is clamped rather than hidden');
  ok(by['2026-08'].start === '2026-08-19' && by['2026-08'].monthStart === '2026-08-01',
     'clamped to the oldest day Amazon still has', by['2026-08'].start);
  ok(by['2026-08'].expires === '2026-11-04', 'with the day the rest of it goes', by['2026-08'].expires);

  ok(!by['2026-07'], 'July is gone entirely and is not offered');
  ok(!by['2026-10'], 'and October has not finished crediting');
}

{
  // Two weeks later, August has gone entirely.
  const by = Object.fromEntries(M.stPullableMonths('2026-11-06').map(m => [m.month, m]));
  ok(!by['2026-08'], 'after 4 November, August is no longer offered at all');
  ok(!!by['2026-09'] && by['2026-09'].partial === true,
     'and September has started losing its own first days',
     'which is five weeks earlier than the 95-day number implied');
}

console.log('\nstResolveMonth  \u2014 the refusals, and the clamp');

{
  const r = M.stResolveMonth('2026-09', '2026-10-23');
  ok(!r.error && r.start === '2026-09-01' && r.end === '2026-09-30' && r.partial === false,
     'a month Amazon holds whole resolves to its calendar bounds');
  ok(M.stResolveMonth('', '2026-10-23').month === '2026-09',
     'no month given falls back to the most recent settled one');
}

{
  const r = M.stResolveMonth('2026-08', '2026-10-23');
  ok(!r.error && r.start === '2026-08-19' && r.monthStart === '2026-08-01' && r.partial === true,
     'a month Amazon holds only part of is CLAMPED, not refused',
     'asking for days it has already dropped is how a short month passes for a whole one');
}

{
  const r = M.stResolveMonth('2026-13', '2026-10-23');
  ok(!!r.error && /YYYY-MM/.test(r.error), 'a malformed month is refused', r.error);
}

{
  const r = M.stResolveMonth('2026-10', '2026-10-23');
  ok(!!r.error && /2026-11-08/.test(r.error),
     'a month still collecting is refused, and says when it will be ready', r.error);
}

{
  const r = M.stResolveMonth('2026-06', '2026-10-23');
  ok(!!r.error && /65/.test(r.error) && /no longer be pulled/.test(r.error),
     'a month past retention is refused in those words, with the right number', r.error);
}

console.log('\nTHE REQUEST  — what is actually asked of Amazon');

{
  const body = M.buildReportBody('sp', '2026-09-01', '2026-09-30', M.ST_REPORT_COLUMNS, {
    name: 'Search terms', groupBy: ['searchTerm'], reportTypeId: M.ST_REPORT_KEY
  });
  const c = body.configuration;
  ok(c.reportTypeId === 'spSearchTerm' && c.groupBy.join() === 'searchTerm',
     'the search term report, grouped by search term');
  ok(c.timeUnit === 'DAILY' && M.ST_REPORT_COLUMNS.includes('date'),
     'at daily grain, with the date column that requires',
     'a daily row cannot be stored without the day it belongs to');
  ok(c.columns.includes('keyword') && c.columns.includes('targeting'),
     'asking for both the keyword and the targeting expression',
     'an Auto row carries one and a keyword row the other');
  ok(c.columns.includes('purchases7d') && c.columns.includes('sales7d'),
     'and the conversion columns the later phases judge on');
}

{
  // The campaign reports must be untouched by the shape argument.
  const body = M.buildReportBody('sp', '2026-09-01', '2026-09-07', ['date', 'campaignId', 'cost']);
  ok(body.configuration.reportTypeId === 'spCampaigns' &&
     body.configuration.groupBy.join() === 'campaign',
     'with no shape given it is still the per-campaign report the cadences use');
}

{
  let threw = '';
  try {
    M.buildReportBody('sp', '2026-08-01', '2026-09-30', M.ST_REPORT_COLUMNS,
                      { groupBy: ['searchTerm'], reportTypeId: M.ST_REPORT_KEY });
  } catch (e) { threw = e.message; }
  ok(/31-day limit/.test(threw),
     'a window over 31 days is refused here rather than at Amazon', threw);
}

{
  // Relative to today, so this holds whenever it runs: 80 days back is inside
  // the campaign report's 95 and outside the search term report's 65.
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const shape = { groupBy: ['searchTerm'], reportTypeId: M.ST_REPORT_KEY };
  const tryBody = (start, end, sh) => {
    try { M.buildReportBody('sp', start, end, M.ST_REPORT_COLUMNS, sh); return ''; }
    catch (e) { return e.message; }
  };

  ok(tryBody(daysAgo(80), daysAgo(60)) === '',
     'a campaign report may still reach back 80 days');
  const clipped = tryBody(daysAgo(80), daysAgo(60), shape);
  ok(/65/.test(clipped) && /spSearchTerm/.test(clipped),
     'the same window as a search term report is refused, naming its own retention',
     clipped);
  ok(tryBody(daysAgo(50), daysAgo(40), shape) === '',
     'and 50 days back is fine for either');
}

// ─── THE ANSWER ──────────────────────────────────────────────────────────────

console.log('\nstNormalizeRows  — Amazon\'s rows in the stored shape');

const raw = (o = {}) => ({
  date: '2026-09-04', campaignId: 123456789, campaignName: 'SOK World Peters (Broad)',
  adGroupId: 987654321, adGroupName: 'Peters', keywordId: 555, keyword: 'world map',
  searchTerm: 'world map laminated', matchType: 'BROAD', targeting: '',
  impressions: 40, clicks: 2, cost: 1.4, purchases7d: 0, sales7d: 0, ...o
});

{
  const [r] = M.stNormalizeRows([raw()]);
  ok(r.campaignId === '123456789' && r.adGroupId === '987654321' && r.keywordId === '555',
     'ids come back as text, which is what joins to the census');
  ok(r.searchTerm === 'world map laminated' && r.matchType === 'BROAD', 'the term and its match type');
  ok(r.impressions === 40 && r.clicks === 2 && r.cost === 1.4, 'the metrics as numbers');
  ok(r.targeting === null, 'an empty string is stored as nothing, not as an empty value');
}

{
  const rows = M.stNormalizeRows([raw({ clicks: 0, cost: 0, impressions: 3 })]);
  ok(rows.length === 1,
     'a term that drew impressions and never a click is KEPT',
     'most of the report is these, and whether they earn their space is what the first pull measures');
}

{
  const rows = M.stNormalizeRows([raw({ date: '' }), raw({ date: 'not-a-date' }), raw()]);
  ok(rows.length === 1,
     'a row without a usable date is dropped rather than stored at the wrong grain',
     'it would double-count in every window built from these rows');
}

{
  const auto = M.stNormalizeRows([raw({ keyword: '', targeting: 'loose-match', matchType: '' })])[0];
  ok(auto.targeting === 'loose-match' && auto.keyword === null,
     'an Auto row keeps its targeting expression', 'a third of this account\'s clicks are Auto');
}

ok(M.stNormalizeRows(null).length === 0 && M.stNormalizeRows({}).length === 0,
   'anything that is not a list of rows reads as no rows');

// ─── THE QUERIES ─────────────────────────────────────────────────────────────
// Built without a database, so the statements can be checked here rather than
// in production. Postgres refuses a statement carrying a parameter it never
// mentions — it cannot infer a type for one — and the page's count query used
// to be handed the two paging parameters it has no use for:
//   "could not determine data type of parameter $3"

console.log('\nTHE QUERIES  — every parameter is referenced, and every reference is supplied');

const { monthQueries } = await import('../lib/searchterms.js');

// $1, $2 … actually written in the statement.
const refs = (text) => new Set([...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));

function checkStatement(label, { text, params }) {
  const used = refs(text);
  const highest = Math.max(0, ...used);
  const unmentioned = params.map((_, i) => i + 1).filter(n => !used.has(n));
  const missing = [...used].filter(n => n > params.length);
  ok(unmentioned.length === 0,
     `${label}: every parameter it is given is used`,
     unmentioned.length ? `$${unmentioned.join(', $')} never appear in the statement` : '');
  ok(missing.length === 0,
     `${label}: every parameter it uses is given`,
     missing.length ? `$${missing.join(', $')} beyond the ${params.length} supplied` : '');
  ok(highest === params.length,
     `${label}: the numbering has no gaps`, `highest $${highest}, ${params.length} params`);
}

for (const [label, opts] of [
  ['default', { month: '2026-09' }],
  ['with a term filter', { month: '2026-09', q: 'laminated' }],
  ['with a click floor', { month: '2026-09', minClicks: 15 }],
  ['sorted ascending', { month: '2026-09', sort: 'clicks', dir: 'asc' }],
  ['paged', { month: '2026-09', limit: 50, offset: 400 }]
]) {
  const q = monthQueries(opts);
  checkStatement(`rows, ${label}`, q.rows);
  checkStatement(`count, ${label}`, q.count);
}

{
  const q = monthQueries({ month: '2026-09', q: 'laminated', minClicks: 5, limit: 50, offset: 100 });
  ok(q.count.params.length === 4 && q.rows.params.length === 6,
     'the count statement takes the filters only, and the rows statement those plus paging');
  ok(q.count.params.every((v, i) => v === q.rows.params[i]),
     'and the two agree on the filters, so a page and its total describe the same rows');
  ok(q.rows.params[4] === 50 && q.rows.params[5] === 100, 'the page size and offset are passed, not interpolated');
}

{
  const injected = monthQueries({ month: '2026-09', sort: 'cost; DROP TABLE search_terms --' });
  ok(/ORDER BY cost DESC/.test(injected.rows.text) && !/DROP/.test(injected.rows.text),
     'a sort key outside the whitelist falls back to spend',
     'the column name is interpolated, so this is the one place that must not take free text');
  ok(/ORDER BY clicks ASC/.test(monthQueries({ month: '2026-09', sort: 'clicks', dir: 'asc' }).rows.text),
     'and a known one is used as asked');
}

{
  const q = monthQueries({ month: '2026-09' });
  ok(q.count.params[3] === null && /\$4::text IS NULL/.test(q.count.text),
     'with no term filter the parameter is null and typed in the statement',
     'an untyped null is the other half of the same Postgres refusal');
}

console.log('\nCOVERAGE  \u2014 what a pull actually brought back');

{
  const { coveredRange } = await import('../lib/searchterms.js');
  const r = coveredRange([{ date: '2026-08-24' }, { date: '2026-08-19' }, { date: '2026-08-31' }]);
  ok(r.from === '2026-08-19' && r.to === '2026-08-31',
     'the first and last day present in the rows',
     'which is what says a month came back short, since Amazon does not');
  ok(coveredRange([]).from === null, 'no rows cover nothing');
  ok(coveredRange([{ clicks: 1 }, { date: '2026-09-02' }]).from === '2026-09-02',
     'a row with no date does not drag the range to nothing');
}

cleanup();
console.log(fails === 0 ? '\nsearchterms: all assertions pass\n' : `\nsearchterms: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
