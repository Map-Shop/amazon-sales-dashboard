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

console.log('\nRETENTION  — the months Amazon will still answer for');

{
  const months = M.stPullableMonths('2026-10-23');
  const names = months.map(m => m.month);
  ok(names.includes('2026-09') && names.includes('2026-08'),
     'on 23 October, September and August are both reachable', names.join(', '));
  ok(!names.includes('2026-07'),
     'July is not — it starts before the 95-day floor',
     'and nothing can bring it back');
  ok(!names.includes('2026-10'), 'nor is October, which has not ended');

  const aug = months.find(m => m.month === '2026-08');
  ok(aug.expires === '2026-11-04',
     'August is dated with the day it falls out of reach', aug.expires);
  ok(aug.start === '2026-08-01' && aug.end === '2026-08-31',
     'and carries the whole calendar month as its window');
}

{
  // One day later than August's expiry.
  const names = M.stPullableMonths('2026-11-05').map(m => m.month);
  ok(!names.includes('2026-08'), 'the day after it expires, August is gone from the list');
  ok(names.includes('2026-09'), 'while September still is', names.join(', '));
  ok(!names.includes('2026-10'),
     'and October is not offered yet, four days before it finishes crediting',
     'settling and expiry are different clocks, and a month can be outside both');
}

console.log('\nstResolveMonth  — the refusals that would otherwise cost a report request');

{
  const r = M.stResolveMonth('2026-09', '2026-10-23');
  ok(!r.error && r.start === '2026-09-01' && r.end === '2026-09-30',
     'a settled month inside retention resolves to its calendar bounds');
  ok(M.stResolveMonth('', '2026-10-23').month === '2026-09',
     'no month given falls back to the most recent settled one');
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
  ok(!!r.error && /95/.test(r.error) && /no longer be pulled/.test(r.error),
     'a month past retention is refused in those words',
     'the alternative is an opaque 400 from Amazon after the request has cost quota');
}

// ─── THE REPORT ──────────────────────────────────────────────────────────────

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

cleanup();
console.log(fails === 0 ? '\nsearchterms: all assertions pass\n' : `\nsearchterms: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
