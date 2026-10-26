// Search terms and bids: which days a daily pull asks for, and what comes back
// from Amazon's answers.
//
// The expensive mistake here is not a wrong number on screen — it is a day
// that was never pulled. Amazon keeps 65 days of search terms and nothing
// reconstructs one past that, so the rules about which days are asked for are
// worth pinning exactly.
import { loadAdspend } from './harness.mjs';

const { M, cleanup } = await loadAdspend('st');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// ─── THE DAILY WINDOW ────────────────────────────────────────────────────────

console.log('\nTHE DAILY WINDOW  — the days still changing, and the days not yet held');

{
  // Up to date: the last 8 days, every day, because a sale lands on the day
  // of its click for 7 days afterwards.
  const w = M.dailyWindow('2026-10-26', '2026-10-25', 'spSearchTerm');
  ok(w.start === '2026-10-18' && w.end === '2026-10-25',
     'an up-to-date store re-pulls the last 8 days, ending yesterday', `${w.start}..${w.end}`);
  ok(M.ST_SETTLE_DAYS === 8, 'eight, the same settling margin the bi-weekly window uses');
}

{
  // Behind: carries on from the day after the last one held.
  const w = M.dailyWindow('2026-10-26', '2026-09-30', 'spSearchTerm');
  ok(w.start === '2026-10-01' && w.end === '2026-10-25',
     'a store that stops at 30 September carries on from 1 October', `${w.start}..${w.end}`,
     );
}

{
  // Far behind: one report holds 31 days, so the oldest days go first and the
  // rest follow on the next runs — nothing skipped while it is reachable.
  const w = M.dailyWindow('2026-12-20', '2026-10-25', 'spTargeting');
  ok(w.start === '2026-10-26' && w.end === '2026-11-25',
     'a gap longer than one report closes from its oldest day, 31 days at a time', `${w.start}..${w.end}`);
}

{
  // Behind further than Amazon remembers: from the oldest day it still has.
  const w = M.dailyWindow('2026-12-20', '2026-09-01', 'spSearchTerm');
  ok(w.start === '2026-10-16',
     'a gap past retention starts from the oldest day Amazon still keeps',
     `${w.start}, which is 65 days before 20 December`);
}

{
  // Nothing held: one report's worth, ending yesterday.
  const w = M.dailyWindow('2026-10-26', null, 'spTargeting');
  ok(w.start === '2026-09-25' && w.end === '2026-10-25',
     'the first pull of an empty store takes the last 31 days', `${w.start}..${w.end}`);
}

{
  // Pulled twice in a day: the second asks for the same days, not fewer.
  const w = M.dailyWindow('2026-10-26', '2026-10-26', 'spSearchTerm');
  ok(w.start === '2026-10-18' && w.end === '2026-10-25', 'a second pull the same day asks for the same days');
}

{
  const months = M.stByMonth([{ date: '2026-09-29' }, { date: '2026-10-01' }, { date: '2026-09-30' }]);
  ok([...months.keys()].join() === '2026-09,2026-10' && months.get('2026-09').length === 2,
     'a window crossing a month end tops up both months');
}

{
  const w = M.dailyParseWindows('spSearchTerm:2026-10-18:2026-10-25,spTargeting:2026-10-18:2026-10-25,' +
                                'spCampaigns:2026-10-01:2026-10-02,spTargeting:bad:2026-10-01');
  ok(w.spSearchTerm && w.spSearchTerm.start === '2026-10-18' && w.spTargeting && w.spTargeting.end === '2026-10-25',
     'the page carries each report\'s window from request to collect');
  ok(!w.spCampaigns && Object.keys(w).length === 2,
     'a report type this pull does not make, or a malformed date, is ignored');
  ok(Object.keys(M.dailyParseWindows('spSearchTerm:2026-10-25:2026-10-18')).length === 0,
     'and so is a window that ends before it starts');
}

console.log('\nRETENTION  — 65 days of search terms, not the 95 a campaign report keeps');

// Read off Amazon itself: asked for August on 23 October it returned the 19th
// onward and called that a success. 23 October minus 65 days is 19 August.
ok(M.REPORT_RETENTION_DAYS.spSearchTerm === 65 && M.REPORT_RETENTION_DAYS.sp === 95,
   'the search term report has its own, shorter retention',
   'one number for both is what let a short month through');
ok(!M.REPORT_RETENTION_DAYS.spTargeting,
   'the targeting report keeps the campaign report\'s 95 days');

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

// Built without a database, so every statement can be checked here rather
// than in production. Postgres refuses a statement carrying a parameter it
// never mentions, and the page went down once on exactly that:
//   "could not determine data type of parameter $3"
// So every query the page runs is checked, not only the one that failed.
const ST = await import('../lib/searchterms.js');

// $1, $2 … actually written in the statement.
const refs = (text) => new Set([...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));

function checkStatement(label, { text, params }) {
  const used = refs(text);
  const highest = Math.max(0, ...used);
  const unmentioned = params.map((_, i) => i + 1).filter(n => !used.has(n));
  const missing = [...used].filter(n => n > params.length);
  ok(unmentioned.length === 0 && missing.length === 0 && highest === params.length,
     `${label}: parameters line up`,
     unmentioned.length ? `$${unmentioned.join(', $')} never appear`
       : missing.length ? `$${missing.join(', $')} beyond the ${params.length} supplied`
       : highest !== params.length ? `highest $${highest}, ${params.length} params` : '');
}

const OPTIONS = [
  ['default', { month: '2026-09' }],
  ['term filter', { month: '2026-09', q: 'laminated' }],
  ['click floor', { month: '2026-09', minClicks: 15 }],
  ['no orders yet', { month: '2026-09', onlyDead: true }],
  ['shared terms', { month: '2026-09', minProducts: 2 }],
  ['sorted ascending', { month: '2026-09', sort: 'clicks', dir: 'asc' }],
  ['sorted by ROAS', { month: '2026-09', sort: 'roas', dir: 'desc' }],
  ['paged', { month: '2026-09', limit: 50, offset: 400 }]
];

// The paged queries: a rows statement and a count statement each.
for (const [name, build] of [
  ['daily rows', (o) => ST.monthQueries(o)],
  ['all terms', (o) => ST.termQueries(o)],
  ['one product', (o) => ST.productTermQueries({ portfolioId: 'pf1', ...o })]
]) {
  for (const [label, opts] of OPTIONS) {
    const q = build(opts);
    checkStatement(`${name}, rows, ${label}`, q.rows);
    checkStatement(`${name}, count, ${label}`, q.count);
  }
}

// The single statements.
checkStatement('products', ST.productQuery({ month: '2026-09' }));
checkStatement('one term by product', ST.termProductQuery({ month: '2026-09', searchTerm: 'world map' }));
checkStatement('one term by campaign', ST.termDetailQuery({ month: '2026-09', searchTerm: 'world map' }));

{
  const q = ST.monthQueries({ month: '2026-09', q: 'laminated', minClicks: 5, limit: 50, offset: 100 });
  ok(q.count.params.every((v, i) => v === q.rows.params[i]),
     'a page and its total are filtered the same way');
  ok(q.rows.params[4] === 50 && q.rows.params[5] === 100, 'page size and offset are passed, not interpolated');
  const bare = ST.monthQueries({ month: '2026-09' });
  ok(bare.count.params[3] === null && /\$4::text IS NULL/.test(bare.count.text),
     'with no term filter the parameter is null and typed in the statement',
     'an untyped null is the other half of the same Postgres refusal');
}

{
  // The sort column is interpolated, so it is the one value that must never be
  // free text. Every table's sort goes through a whitelist.
  const evil = 'cost; DROP TABLE search_terms --';
  const texts = [
    ST.monthQueries({ month: '2026-09', sort: evil }).rows.text,
    ST.termQueries({ month: '2026-09', sort: evil }).rows.text,
    ST.productTermQueries({ month: '2026-09', portfolioId: 'pf1', sort: evil }).rows.text
  ];
  ok(texts.every(t => !/DROP/.test(t)),
     'a sort key outside the whitelist never reaches the statement, on any table');
}

console.log('\nROAS  — sortable on every table, and safe on zero spend');

{
  // ROAS divides by spend, and Postgres stops the whole statement on a
  // division by zero rather than leaving that one row blank. One term with no
  // spend would take the page down.
  const sorts = {
    'daily rows': ST.monthQueries({ month: '2026-09', sort: 'roas' }).rows.text,
    'all terms': ST.termQueries({ month: '2026-09', sort: 'roas' }).rows.text,
    'one product': ST.productTermQueries({ month: '2026-09', portfolioId: 'pf1', sort: 'roas' }).rows.text
  };
  for (const [name, text] of Object.entries(sorts)) {
    const order = text.slice(text.lastIndexOf('ORDER BY'));
    ok(/roas|sales7d \/ NULLIF|sales \/ NULLIF/.test(order) && !/ORDER BY cost DESC/.test(order),
       `${name}: ROAS is a sort of its own, not the fallback to spend`);
  }
  const unguarded = Object.entries(sorts)
    .filter(([, t]) => /\/ (?!NULLIF)/.test(t.replace(/--.*$/gm, '')))
    .map(([k]) => k);
  ok(unguarded.length === 0, 'every ROAS division guards against zero spend', unguarded.join(', '));
}

console.log('\nTHE CAMPAIGN LIST  — a campaign that leaves it keeps its history');

{
  // Every view joins search terms to TODAY's campaign list. An inner join would
  // drop a campaign that has since left it from every total, while the stored
  // figures at the foot of the page still counted it.
  const views = {
    products: ST.productQuery({ month: '2026-09' }).text,
    'all terms': ST.termQueries({ month: '2026-09' }).rows.text,
    'one term by product': ST.termProductQuery({ month: '2026-09', searchTerm: 'x' }).text,
    'one term by campaign': ST.termDetailQuery({ month: '2026-09', searchTerm: 'x' }).text
  };
  const inner = Object.entries(views)
    .filter(([, t]) => /(^|[^T]\s)JOIN ad_campaigns/m.test(t.replace(/LEFT JOIN ad_campaigns/g, '')))
    .map(([k]) => k);
  ok(inner.length === 0, 'every account-wide view outer-joins the campaign list', inner.join(', '));
  ok(Object.values(views).filter(t => /not in campaign list/.test(t)).length === 3,
     'and names the rows of a campaign that has left it',
     'products, and both breakdowns of a term');
}

console.log('\nHOW IT MATCHED  — from Amazon\'s match type, not the campaign\'s name');

{
  const t = ST.termQueries({ month: '2026-09' }).rows.text;
  ok(/upper\(t\.match_type\) = 'EXACT'/.test(t) && !/campaign_type = 'Exact'/.test(t),
     'a term is marked exact from the match type Amazon reports',
     'the campaign name marked one September term exact that a broad keyword had caught');
}

{
  ok(ST.MATCH_FUNNEL.join(' > ') === 'Auto > Broad > Keyword group > Phrase > Exact > ASIN > Category',
     'the funnel runs Auto, Broad, keyword groups, Phrase, Exact, then product targets',
     ST.MATCH_FUNNEL.join(' > '));
  ok(ST.funnelSort(['Exact', 'ASIN', 'Auto', 'Broad']).join(',') === 'Auto,Broad,Exact,ASIN',
     'match types are listed in funnel order', 'not alphabetically, which would lead with ASIN');
  ok(ST.funnelSort(['Exact', 'Something new', 'Auto']).join(',') === 'Auto,Exact,Something new',
     'an unrecognised match type sorts last rather than disappearing');
  ok(ST.funnelSort([null, 'Auto', undefined]).join(',') === 'Auto' && ST.funnelSort(null).length === 0,
     'and nothing is listed for a row with no match type');
}

console.log('\nONE PRODUCT  — paged by term, so a term is never split across pages');

{
  const q = ST.productTermQueries({ month: '2026-09', portfolioId: 'pf1', limit: 50, offset: 100 });
  const pageCte = q.rows.text.slice(q.rows.text.indexOf('page AS ('));
  ok(/LIMIT \$7::int OFFSET \$8::int/.test(pageCte.slice(0, pageCte.indexOf(')\n'))),
     'the page size applies to terms, inside the step that picks them',
     'a limit on match rows could cut a term with four matches in half');
  ok(/count\(\*\)::int AS n FROM picked/.test(q.count.text),
     'and the count is of terms, so the pager agrees with what is shown');
}

console.log('\nTHE BREAKDOWN  — one term, by product');

{
  const d = ST.termDetailQuery({ month: '2026-09', searchTerm: 'new world map' });
  ok(d.params[2] === 'new world map', 'the term is a parameter, not interpolated');
  ok(!/portfolio_id = \$/.test(d.text),
     'it is never narrowed to one product',
     'the other products paying for the same search are the point of it');
  const order = d.text.slice(d.text.lastIndexOf('ORDER BY'));
  const at = (needle) => order.indexOf(needle);
  ok(at('not in campaign list') > 0 && at("WHEN 'Auto' THEN 1") > at('not in campaign list') &&
     at('sum(t.cost) DESC') > at("WHEN 'Auto' THEN 1"),
     'ordered by product, then funnel stage, then biggest line first');
}

console.log('\nSHARED TERMS  \u2014 the terms two or more products pay for');

{
  const q = ST.termQueries({ month: '2026-09', minProducts: 2 });
  ok(q.rows.params[6] === 2 && q.count.params[6] === 2,
     'the product floor is a parameter of both the page and its total');
  ok(/spread\.products, 0\) >= \$7::int/.test(q.count.text) && /JOIN spread/.test(q.count.text),
     'and the total counts only shared terms',
     'counted without the spread, the pager would promise five thousand terms and show seven hundred');
  ok(ST.termQueries({ month: '2026-09' }).rows.params[6] === 0,
     'with no floor every term qualifies');
}

console.log('\nBIDS  \u2014 Amazon\'s keywords and targets, in the stored shape');

{
  const kw = M.tgNormalizeKeyword({ keywordId: 111, campaignId: 'c1', adGroupId: 'g1', state: 'enabled',
                                    matchType: 'EXACT', keywordText: 'pull down world map', bid: 0.85 });
  ok(kw.targetId === '111' && kw.kind === 'keyword' && kw.state === 'ENABLED' && kw.matchLabel === 'Exact',
     'a keyword keeps its id, ad group, state and match type');
  ok(kw.bid === 0.85 && kw.recExpr.type === 'KEYWORD_EXACT_MATCH' && kw.recExpr.value === 'pull down world map',
     'with its own bid, and the expression Amazon\'s suggestion is asked with');
  const dflt = M.tgNormalizeKeyword({ keywordId: 112, matchType: 'BROAD', keywordText: 'world map' });
  ok(dflt.bid === null && dflt.recExpr.type === 'KEYWORD_BROAD_MATCH',
     'a keyword with no bid field bids its ad group\'s default, and says so with no bid',
     'Amazon leaves the field out rather than repeating the default');
}

{
  const t = (expression, extra = {}) => M.tgNormalizeTarget({
    targetId: 't1', campaignId: 'c1', adGroupId: 'g1', state: 'PAUSED', expression, ...extra });
  const close = t([{ type: 'QUERY_HIGH_REL_MATCHES' }], { expressionType: 'AUTO', bid: 0.4 });
  ok(close.text === 'close-match' && close.matchLabel === 'Auto' && close.recExpr.type === 'CLOSE_MATCH',
     'an Auto group reads the way the search term report writes it', close.text);
  ok(['QUERY_BROAD_REL_MATCHES', 'ASIN_SUBSTITUTE_RELATED', 'ASIN_ACCESSORY_RELATED']
       .map(type => t([{ type }]).text).join(',') === 'loose-match,substitutes,complements',
     'all four Auto groups do');
  const asin = t([{ type: 'ASIN_SAME_AS', value: 'B07SXC739C' }]);
  ok(asin.text === 'asin="B07SXC739C"' && asin.matchLabel === 'ASIN' &&
     asin.recExpr.type === 'PAT_ASIN' && asin.recExpr.value === 'B07SXC739C',
     'an ASIN target keeps the report\'s form, so it is named like an ASIN search term');
  const cat = t([{ type: 'ASIN_CATEGORY_SAME_AS', value: '1069242' }],
                { resolvedExpression: [{ type: 'ASIN_CATEGORY_SAME_AS', value: 'Wall Maps' }] });
  ok(cat.text === 'category="Wall Maps"' && cat.recExpr.value === '1069242',
     'a category is shown by its name and asked about by its id');
  const refined = t([{ type: 'ASIN_CATEGORY_SAME_AS', value: '1069242' }, { type: 'ASIN_BRAND_SAME_AS', value: '42' }]);
  ok(refined.recExpr === null && /category=.* brand=/.test(refined.text),
     'a category narrowed by brand is listed, with no suggestion asked for',
     'a refined target is a different request, not the plain category one');
  const group = t([{ type: 'KEYWORD_GROUP_SAME_AS', value: 'Keywords related to your product category' }]);
  ok(group.matchLabel === 'Keyword group' && group.recExpr === null,
     'a keyword group is listed with no suggestion asked for');
  const odd = t([{ type: 'SOMETHING_NEW', value: 'x' }]);
  ok(odd.matchLabel === 'Other' && odd.text === 'something-new="x"' && odd.recExpr === null,
     'an expression type Amazon adds later is kept and labelled, not dropped');
  ok(close.state === 'PAUSED' && close.bid === 0.4 && t([]).text === null,
     'a target keeps its state and bid; one with no expression has no text');
}

{
  const kw = M.tgNormalizeKeyword({ keywordId: 1, matchType: 'EXACT', keywordText: 'x',
    extendedData: { creationDateTime: '2025-03-04T17:20:00Z', lastUpdateDateTime: 1761000000000, servingStatus: 'TARGETING_CLAUSE_STATUS_LIVE' } });
  ok(kw.createdAt === '2025-03-04T17:20:00.000Z' && kw.updatedAt === new Date(1761000000000).toISOString() &&
     kw.servingStatus === 'TARGETING_CLAUSE_STATUS_LIVE',
     'Amazon\'s creation and last-change dates are kept, as ISO strings or epoch milliseconds',
     'an exact keyword\'s creation date is the day its term was graduated');
  ok(M.tgNormalizeKeyword({ keywordId: 2 }).createdAt === null && M.tgDate('not a date') === null,
     'a list that sent no dates, or a date that is not one, stores none');
}

console.log('\nNEGATIVES AND PRODUCTS  \u2014 the rest of the morning snapshot');

{
  const [agKw, campKw, agTg, campTg] = M.NEG_LISTS;
  ok(M.NEG_LISTS.map(s => `${s.level}/${s.kind}`).join(',') ===
     'ad_group/keyword,campaign/keyword,ad_group/target,campaign/target',
     'all four places a negative can live are pulled');
  ok(M.NEG_LISTS.every(s => s.states.join() === 'ENABLED'), 'enabled only: an archived negative negates nothing');
  const a = M.negNormalize(agKw, { keywordId: 9, campaignId: 1, adGroupId: 2, state: 'enabled',
                                   matchType: 'NEGATIVE_EXACT', keywordText: 'free world map' });
  ok(a.negativeId === '9' && a.adGroupId === '2' && a.matchType === 'NEGATIVE_EXACT' && a.text === 'free world map' &&
     a.state === 'ENABLED', 'an ad group negative keyword keeps its ad group and match type');
  const c = M.negNormalize(campKw, { keywordId: 10, campaignId: 1, adGroupId: 2, keywordText: 'cheap' });
  ok(c.level === 'campaign' && c.adGroupId === null,
     'a campaign negative belongs to no ad group, whatever Amazon sends');
  const t = M.negNormalize(campTg, { targetId: 11, campaignId: 1,
    expression: [{ type: 'ASIN_SAME_AS', value: 'B07SXC739C' }] });
  ok(t.negativeId === '11' && t.text === 'asin="B07SXC739C"' && t.kind === 'target' && t.expression.length === 1,
     'a negative product target reads like the targets it blocks');
  ok(agTg.kind === 'target' && agTg.level === 'ad_group', 'and the ad group one is a product target too');
}

{
  const p = M.productAdNormalize({ adId: 5, campaignId: 1, adGroupId: 2, asin: 'b07sxc739c', sku: 'SOK-PET', state: 'enabled' });
  ok(p.adId === '5' && p.asin === 'B07SXC739C' && p.sku === 'SOK-PET' && p.state === 'ENABLED',
     'an advertised product keeps its ASIN, upper-cased to match the catalog, and its SKU');
}

console.log('\nTHE TARGETING REPORT  \u2014 each keyword and target\'s own day');

{
  const rows = M.tdNormalizeRows([
    { date: '2026-10-20', keywordId: 777, campaignId: 1, adGroupId: 2, keyword: 'world map', matchType: 'EXACT',
      keywordBid: 0.85, impressions: 1200, clicks: 9, cost: 6.3, purchases7d: 1, sales7d: 34.99,
      topOfSearchImpressionShare: 0.12, adKeywordStatus: 'ENABLED' },
    { date: '2026-10-20', keywordId: null, impressions: 5 },
    { date: 'nope', keywordId: 778, impressions: 5 }
  ]);
  ok(rows.length === 1 && rows[0].targetId === '777',
     'a row is kept by the keyword or target it belongs to; one without either id or day is dropped');
  ok(rows[0].impressions === 1200 && rows[0].topOfSearchIs === 0.12 && rows[0].keywordBid === 0.85,
     'with its impressions, top-of-search share and the bid Amazon reports for the day');
}

{
  const body = M.buildReportBody('sp', '2026-10-01', '2026-10-25', M.TD_REPORT_COLUMNS, {
    name: 'Targets', groupBy: ['targeting'], reportTypeId: M.TD_REPORT_KEY });
  ok(body.configuration.reportTypeId === 'spTargeting' && body.configuration.groupBy.join() === 'targeting' &&
     body.configuration.timeUnit === 'DAILY', 'the targeting report, by target, by day');
  ok(M.TD_OPTIONAL_COLUMNS.every(c => M.TD_REPORT_COLUMNS.includes(c)) &&
     !M.TD_OPTIONAL_COLUMNS.includes('impressions') && !M.TD_OPTIONAL_COLUMNS.includes('keywordId'),
     'only the newer columns may be dropped; the ones the table is for may not');
}

{
  // A refused optional column is dropped and the report asked for again; a
  // refused column the report needs is not.
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.configuration.columns);
    const refuse = body.configuration.columns.filter(c => /topOfSearch|madeUp/.test(c));
    if (refuse.length) {
      return new Response(JSON.stringify({ code: '400', detail: `configuration columns includes invalid values: (${refuse.join(', ')}). Allowed values: (date, clicks)` }), { status: 400 });
    }
    return new Response(JSON.stringify({ reportId: 'rep-12345678' }), { status: 200 });
  };
  const plan = { key: 'spTargeting', window: { start: '2026-10-18', end: '2026-10-25' },
                 columns: M.TD_REPORT_COLUMNS, optional: M.TD_OPTIONAL_COLUMNS,
                 shape: { groupBy: ['targeting'], reportTypeId: 'spTargeting' } };
  const r = await M.dailyRequestOne('token', plan);
  ok(r.reportId === 'rep-12345678' && r.dropped.join() === 'topOfSearchImpressionShare' && sent.length === 2 &&
     !sent[1].includes('topOfSearchImpressionShare') && sent[1].includes('impressions'),
     'a refused newer column is dropped and the report asked for again without it', r.dropped.join());
  let threw = '';
  try {
    await M.dailyRequestOne('token', { ...plan, columns: [...M.TD_REPORT_COLUMNS, 'madeUpColumn'] });
  } catch (e) { threw = e.message; }
  ok(/madeUpColumn/.test(threw), 'a refusal that includes a column it needs is not worked around', threw.slice(0, 80));
  globalThis.fetch = realFetch;
}

console.log('\nWHAT CHANGED  \u2014 between one morning\'s bids and the next');

{
  const { diffTargets } = await import('../lib/targets.js');
  const before = [
    { targetId: 'a', state: 'ENABLED', bid: 0.85, matchLabel: 'Exact', text: 'world map' },
    { targetId: 'b', state: 'ENABLED', bid: null, text: 'close-match' },
    { targetId: 'c', state: 'ENABLED', bid: 0.5 },
    { targetId: 'd', state: 'PAUSED', bid: 0.4 },
    { targetId: 'e', state: 'ENABLED', bid: 1.2 }
  ];
  const after = [
    { targetId: 'a', state: 'ENABLED', bid: 0.62, matchLabel: 'Exact', text: 'world map' },
    { targetId: 'b', state: 'ENABLED', bid: 0.3 },
    { targetId: 'c', state: 'PAUSED', bid: 0.5 },
    { targetId: 'e', state: 'ENABLED', bid: 1.2000001 },
    { targetId: 'f', state: 'ENABLED', bid: 0.75 }
  ];
  const d = diffTargets(before, after);
  const by = (id, field) => d.find(x => x.targetId === id && x.field === field);
  ok(by('a', 'bid') && by('a', 'bid').from === '0.85' && by('a', 'bid').to === '0.62' && by('a', 'bid').text === 'world map',
     'a moved bid is logged with both values and what the target is');
  ok(by('b', 'bid') && by('b', 'bid').from === 'default' && by('b', 'bid').to === '0.30',
     'a target taken off its ad group\'s default is a bid change too');
  ok(by('c', 'state') && by('c', 'state').to === 'PAUSED' && !by('c', 'bid'), 'a pause is a state change, and only that');
  ok(by('d', 'removed') && by('f', 'added'), 'a target gone and a target new are both logged');
  ok(!d.some(x => x.targetId === 'e'), 'a bid the same to the cent is not a change');
  ok(diffTargets([], after).length === 5 && diffTargets(after, after).length === 0,
     'identical pulls log nothing');
}

console.log('\nSUGGESTED BIDS  \u2014 reading Amazon\'s answer');

{
  const body = { bidRecommendations: [
    { theme: 'PRIME_DAY', bidRecommendationsForTargetingExpressions: [
      { targetingExpression: { type: 'CLOSE_MATCH' }, bidValues: [{ suggestedBid: 9 }, { suggestedBid: 10 }, { suggestedBid: 11 }] }] },
    { theme: 'CONVERSION_OPPORTUNITIES', bidRecommendationsForTargetingExpressions: [
      { targetingExpression: { type: 'CLOSE_MATCH' }, bidValues: [{ suggestedBid: 1.1 }, { suggestedBid: 0.62 }, { suggestedBid: 0.85 }] },
      { targetingExpression: { type: 'KEYWORD_EXACT_MATCH', value: 'Pull Down World Map' }, bidValues: [{ suggestedBid: 1.4 }] }] }
  ] };
  const r = M.tgParseRecommendations(body);
  ok(r.theme === 'CONVERSION_OPPORTUNITIES', 'the everyday suggestion is used, not an event\'s',
     'a Prime Day range would read as Amazon wanting triple the bid');
  ok(r.items[0].low === 0.62 && r.items[0].mid === 0.85 && r.items[0].high === 1.1,
     'three values become a low, the suggestion and a high, whatever order they arrive in');
  ok(r.items[1].low === null && r.items[1].mid === 1.4 && r.items[1].high === null,
     'a single value is the suggestion alone, with no range to sit inside');
  ok(M.tgParseRecommendations({}).items.length === 0 && M.tgParseRecommendations(null).theme === null,
     'an answer with no recommendations reads as none');
  ok(M.tgRange([0.3, 0.9]).low === 0.3 && M.tgRange([0.3, 0.9]).mid === null && M.tgRange([0.3, 0.9]).high === 0.9,
     'two values are a range with no suggestion between them');

  const asked = [
    { targetId: 'a', rec: { type: 'KEYWORD_EXACT_MATCH', value: 'pull down world map ' } },
    { targetId: 'b', rec: { type: 'CLOSE_MATCH' } },
    { targetId: 'c', rec: { type: 'PAT_ASIN', value: 'B000000001' } }
  ];
  const m = M.tgMatchRecommendations(asked, r.items);
  ok(m[0].found && m[0].mid === 1.4, 'a keyword is matched to its answer whatever case Amazon hands it back in');
  ok(m[1].found && m[1].low === 0.62, 'an Auto group is matched by type');
  ok(!m[2].found && m[2].low === null, 'a target Amazon did not answer for is recorded as no suggestion');
  const swapped = M.tgMatchRecommendations(
    [{ targetId: 'x', rec: { type: 'PAT_ASIN', value: 'B0AAAAAAA1' } }],
    [{ type: 'CLOSE_MATCH', value: null, low: 1, mid: 2, high: 3 }]);
  ok(!swapped[0].found,
     'an answer in the same position but for another kind of target is not taken as this one');
}

{
  const e = (status, body) => Object.assign(new Error('x'), { status, body });
  ok(M.tgVersionRefused(e(415, '')) && M.tgVersionRefused(e(406, '')),
     'an unsupported media type moves on to the next version');
  ok(M.tgVersionRefused(e(400, '{"message":"Invalid Content-Type header"}')),
     'and so does a 400 that names the content type');
  ok(!M.tgVersionRefused(e(400, '{"message":"targetingExpressions[0].value is invalid"}')) &&
     !M.tgVersionRefused(e(422, '')) && !M.tgVersionRefused(e(429, '')),
     'a refusal of the request itself does not, nor does throttling');
  ok(M.TG_REC_VERSIONS[0] === 'v4' && !M.TG_REC_VERSIONS.includes('v3'),
     'v4 is asked first and the retired v3 not at all');
  ok(M.tgShortError(e(422, '{"code":"UNSUPPORTED","message":"PAT_ASIN is not supported"}')) === '422 PAT_ASIN is not supported',
     'a refusal is recorded in Amazon\'s own words');
}

{
  const many = Array.from({ length: 230 }, (_, i) => ({ targetId: `k${i}`, rec: { type: 'KEYWORD_EXACT_MATCH', value: `t${i}` } }));
  const work = M.tgSuggestionWork([
    { campaignId: 'c1', adGroupId: 'g1', targets: [{ targetId: 'p1', rec: { type: 'PAT_ASIN', value: 'B0' } },
                                                    { targetId: 'a1', rec: { type: 'CLOSE_MATCH' } }] },
    { campaignId: 'c2', adGroupId: 'g2', targets: many }
  ]);
  ok(work.map(w => w.targets.length).join(',') === '1,100,100,30,1',
     'requests carry at most 100 targets, from one ad group each', work.map(w => w.targets.length).join(','));
  ok(work[work.length - 1].targets[0].targetId === 'p1' &&
     work.slice(0, -1).every(w => w.targets.every(t => !/^PAT_/.test(t.rec.type))),
     'product targets are asked about last, after keywords and Auto groups in every ad group',
     'by then an answer has shown the request is sound, so a refusal is about the target');
}

console.log('\nTHE TARGETS TABLE  \u2014 every parameter lines up, every sort is whitelisted');

{
  const TG = await import('../lib/targets.js');
  const TG_OPTIONS = [
    ['default', { month: '2026-09' }],
    ['one product', { month: '2026-09', portfolioId: 'pf1' }],
    ['target filter', { month: '2026-09', q: 'world map' }],
    ['match type', { month: '2026-09', match: 'Exact' }],
    ['paused only', { month: '2026-09', state: 'PAUSED' }],
    ['below the range', { month: '2026-09', position: 'below' }],
    ['every filter', { month: '2026-09', portfolioId: 'pf1', q: 'map', match: 'Auto', state: 'ENABLED', position: 'within' }],
    ['by CPC', { month: '2026-09', sort: 'cpc', dir: 'asc' }],
    ['by ROAS', { month: '2026-09', sort: 'roas' }],
    ['paged', { month: '2026-09', limit: 50, offset: 400 }]
  ];
  for (const [label, opts] of TG_OPTIONS) {
    const q = TG.targetQueries(opts);
    checkStatement(`targets, rows, ${label}`, q.rows);
    checkStatement(`targets, count, ${label}`, q.count);
    checkStatement(`targets, positions, ${label}`, q.positions);
    checkStatement(`targets, facets, ${label}`, q.facets);
  }

  const q = TG.targetQueries({ month: '2026-09', position: 'below', limit: 50, offset: 100 });
  ok(q.count.params.every((v, i) => v === q.rows.params[i]) && q.rows.params[7] === 50 && q.rows.params[8] === 100,
     'a page and its total are filtered the same way, and the paging is passed, not interpolated');
  ok(!/position = \$/.test(q.positions.text) && q.positions.params.length === 6,
     'the tally by position ignores the position filter',
     'so each choice says what picking it would show');
  ok(TG.targetQueries({ month: '2026-09', position: 'sideways' }).rows.params[6] === null,
     'a position outside the four is no filter at all');

  const evil = 'cost; DROP TABLE sp_targets --';
  ok(!/DROP/.test(TG.targetQueries({ month: '2026-09', sort: evil }).rows.text),
     'a sort key outside the whitelist never reaches the statement');
  const order = (sort) => { const t = TG.targetQueries({ month: '2026-09', sort }).rows.text; return t.slice(t.lastIndexOf('ORDER BY')); };
  ok(/cost \/ NULLIF\(clicks, 0\)/.test(order('cpc')) && /sales \/ NULLIF\(cost, 0\)/.test(order('roas')),
     'CPC and ROAS sort by their own ratios, guarded against nothing to divide by',
     'a paused target with no clicks would otherwise stop the whole statement');
  const unguarded = TG_OPTIONS.map(([, o]) => TG.targetQueries(o).rows.text)
    .filter(t => /\/ (?!NULLIF)/.test(t));
  ok(unguarded.length === 0, 'no division anywhere in the statement is unguarded');
  ok(/LEFT JOIN ad_campaigns/.test(q.rows.text) && /LEFT JOIN perf/.test(q.rows.text),
     'a target outside the campaign list, or with nothing in the month, is still listed');
  ok(/CASE WHEN c\.ad_group_id = g\.ad_group_id THEN c\.default_bid END/.test(q.rows.text),
     'a default bid is only credited to a target in the ad group it belongs to');
  ok(TG.TG_COLUMNS.map(([, c]) => c).includes('target_text') && !TG.TG_COLUMNS.some(([, c]) => c === 'text'),
     'the text column is not named after a Postgres type');
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
