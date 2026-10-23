// The Tuesday cron's judgements: whether today is a run day, whether fresh data
// should be adopted or merely offered, and what the Slack message says.
//
// Both write. Getting the run day wrong burns Amazon report quota on six extra
// days a week; adopting too eagerly replaces every recommendation on screen
// mid-fortnight, which is the thing the import button exists to prevent.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAdspend, memoryKv } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const kv = memoryKv();
const { M, cleanup } = await loadAdspend('sched', kv);

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

console.log('\nadsCronIsRunDay  — Pacific, because every window in this file is');

// The schedule fires at 10:00, 11:00 and 12:00 UTC. In August that is 03:00,
// 04:00 and 05:00 Pacific, so the calendar day is the same on both clocks and
// the only thing being tested is the weekday.
ok(M.adsCronIsRunDay(new Date('2026-09-08T10:00:00Z')) === true,
   'Tuesday is a run day');
ok(M.adsCronIsRunDay(new Date('2026-09-07T10:00:00Z')) === false, 'Monday is not');
ok(M.adsCronIsRunDay(new Date('2026-09-09T10:00:00Z')) === false, 'Wednesday is not');
ok([9, 10, 11, 12, 13].every(d => M.adsCronIsRunDay(new Date(`2026-09-${d}T11:00:00Z`)) === false),
   'and neither is any of the other five days');

// 2026-09-09 is a Wednesday. At 03:00 UTC it is still Tuesday evening Pacific,
// and a UTC-naive check would call it Wednesday and skip the run.
ok(M.adsCronIsRunDay(new Date('2026-09-09T03:00:00Z')) === true,
   'Tuesday evening Pacific is still Tuesday',
   'a UTC reading of the same instant says Wednesday');
// The mirror: Tuesday 09-08 at 01:00 UTC is Monday evening Pacific.
ok(M.adsCronIsRunDay(new Date('2026-09-08T01:00:00Z')) === false,
   'and Monday evening Pacific is still Monday',
   'the case a UTC-naive check would fire a day early on');

console.log('\nbwAdoptLatest  \u2014 every Tuesday fetch becomes what the page decides from');

const inputs = [{ campaignId: '1', spend: 100, orders: 10 }];
const win = { start: '2026-08-25', end: '2026-09-07' };
const older = { start: '2026-08-11', end: '2026-08-24' };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const reset = (avail, run) => {
  kv.store.clear();
  if (avail) kv.store.set('biweekly:available', avail);
  if (run) kv.store.set('biweekly:lastrun', run);
};

{
  reset(null, null);
  ok(await M.bwAdoptLatest() === false, 'nothing fetched, nothing to adopt');
  ok(await M.bwLoadRun() === null, 'and the page keeps whatever it had');
}

{
  reset({ window: win, inputs, fetchedAt: daysAgo(0) }, null);
  ok(await M.bwAdoptLatest() === true, 'the first fetch is adopted');
  ok((await kv.get('biweekly:lastrun')).inputs.length === 1, 'and is what the page now decides from');
}

{
  // The case the old 13-day clock refused. The cadence is when you sit down to
  // act; it is not a reason to show numbers a fortnight old in the meantime.
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: older, inputs: [{ campaignId: '9', spend: 5, orders: 0 }],
          collectedAt: daysAgo(7), adoptedAt: daysAgo(7) });
  ok(await M.bwAdoptLatest() === true, 'a fetch a week after the last one is adopted too');
  const run = await kv.get('biweekly:lastrun');
  ok(run.window.end === win.end && run.inputs[0].campaignId === '1',
     'replacing the week-old run with the new window and its rows',
     `${run.window.start} to ${run.window.end}`);
  ok(run.collectedAt === (await kv.get('biweekly:available')).fetchedAt,
     'stamped with when the reports were pulled, not when they were adopted',
     'the page dates the run by the data, which is what went stale');
}

{
  // An off-cycle run earlier today, then the cron. Same data either way.
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(0), adoptedAt: daysAgo(0) });
  ok(await M.bwAdoptLatest() === true,
     'adopting again over the same window is allowed',
     'it writes the same numbers, so there is nothing to protect against');
}

console.log('\nbwSaveAvailable / bwLoadAvailable  — the fetch is kept apart from the run');

{
  kv.store.clear();
  await M.bwSaveAvailable(win, inputs);
  ok(await M.bwLoadRun() === null,
     'storing a fetch does not by itself touch what the page is deciding from',
     'the cron stores then adopts, so a fetch holding nothing cannot blank the page');
  const a = await M.bwLoadAvailable();
  ok(!!a && !!a.fetchedAt, 'and the fetch is timestamped, which is what dates the run');
}

{
  kv.store.clear();
  await M.bwSaveAvailable(win, []);
  ok(await M.bwLoadAvailable() === null,
     'an empty fetch reads back as nothing rather than as an empty result',
     'a collect that returned no rows must not replace a run that has some');
}

console.log('\nadsCronReport  \u2014 what the Tuesday message actually says');

const WIN = { weekStart: '2026-08-31', weekEnd: '2026-09-06',
              baseStart: '2026-08-03', baseEnd: '2026-08-30' };
const BWIN = { start: '2026-08-25', end: '2026-09-07' };

const weeklyPart = (over = {}) => ({
  window: WIN,
  flagCount: over.flagCount === undefined ? 9 : over.flagCount,
  flags: over.flags || {
    budgetCap: [1, 2], silent: [1], spendCollapse: [1, 2, 3],
    ctrCollapse: [1, 2], cpcSpike: [1], brandPacing: []
  }
});
const bwAdopted = { window: BWIN, adopted: true, evaluated: 138,
                    counts: { increase: 9, decrease: 11, cut: 3, hold: 115 } };
const bwOffered = { window: BWIN, adopted: false };

{
  const r = M.adsCronReport({ weekly: weeklyPart(), biweekly: bwAdopted });
  ok(r.outcome === 'ok', 'both cadences landing is a clean run');
  ok(r.text.startsWith('\u2705'), 'and leads with the verdict, not the detail');
  ok(r.text.includes('9 flags') && r.text.includes('2026-08-31 to 2026-09-06'),
     'the weekly line carries the count and the week');
  ok(r.text.includes('budget cap 2') && r.text.includes('spend collapse 3'),
     'broken down by check, so the message says where the work is');
  ok(!r.text.includes('brand pacing'),
     'an empty bucket is left out rather than printed as zero');
  ok(r.text.includes('23 changes across 138 campaigns'),
     'the bi-weekly line counts what would actually be changed',
     'increases plus decreases plus cuts, never holds');
  ok(!/Re-run/.test(r.text), 'and a clean run asks for nothing');
}

{
  const r = M.adsCronReport({ weekly: weeklyPart(), biweekly: bwOffered });
  ok(r.outcome === 'ok', 'a bi-weekly that stored nothing is still a complete run');
  ok(r.text.includes('nothing was stored') && r.text.includes('previous run'),
     'and says the page is still on the run before it');
  ok(!/increase \d/.test(r.text),
     'without action counts for data that was never stored',
     'those numbers would describe a page nobody is looking at');
}

{
  const r = M.adsCronReport({ weekly: weeklyPart({ flagCount: 0, flags: {} }),
                              biweekly: bwAdopted });
  ok(r.text.includes('0 flags') && r.text.includes('nothing flagged this week'),
     'a quiet week says so plainly rather than printing an empty list');
}

{
  const r = M.adsCronReport({ weekly: weeklyPart(),
                              notReady: [{ key: 'spBw', status: 'PENDING' }] });
  ok(r.outcome === 'partial', 'one cadence landing is a short run, not a failure');
  ok(r.text.startsWith('\u26a0'), 'flagged as such');
  ok(r.text.includes('bi-weekly report never arrived') && r.text.includes('PENDING'),
     'naming the report and what Amazon last said about it');
  ok(/Re-run that cadence/.test(r.text), 'and what to do about it');
  ok(!/both cadences/.test(r.text),
     'asking only for the one that is missing');
}

{
  const r = M.adsCronReport({ notReady: [{ key: 'spWeek', status: 'PENDING' },
                                         { key: 'spBase', status: 'PROCESSING' },
                                         { key: 'spBw', status: 'PENDING' }] });
  ok(r.outcome === 'none' && r.text.startsWith('\ud83d\udd34'),
     'nothing landing is a failure');
  ok((r.text.match(/never arrived/g) || []).length === 3, 'and every report is named');
  ok(/Re-run both cadences/.test(r.text),
     'asking for both, since neither landed');
}

{
  const r = M.adsCronReport({
    weekly: weeklyPart(), biweekly: bwAdopted,
    censusError: 'Amazon returned 429'
  });
  ok(r.outcome === 'ok' && r.text.includes('Campaign snapshot did not refresh'),
     'a stale census is reported even when the reports themselves landed',
     'every budget, brand and bid the checks read comes from it');
}

{
  const r = M.adsCronReport({ blocked: 'Missing Advertising API credentials: ADS_CLIENT_ID' });
  ok(r.outcome === 'none' && r.text.includes('could not proceed'),
     'a run stopped before it stored anything reads differently from a slow one');
  ok(r.text.includes('ADS_CLIENT_ID'), 'and names the reason');
  ok(!/never arrived/.test(r.text), 'without listing reports it never got as far as');
}

{
  const one = M.adsCronReport({ weekly: { window: WIN, flagCount: 1, flags: { silent: [1] } },
                                biweekly: { window: BWIN, adopted: true, evaluated: 1,
                                            counts: { increase: 1, decrease: 0, cut: 0, hold: 0 } } });
  ok(one.text.includes('1 flag,') && one.text.includes('1 change across'),
     'singulars read as singulars');
}

console.log('\nTHE SCHEDULE ITSELF  \u2014 only the last attempt is allowed to complain');

// The rule the user asked for lives half in the handler and half in
// vercel.json: a collect slot reports a failure only when it carries final=1.
// Adding a slot without moving that flag would report a failure an hour before
// the last attempt, which is exactly the message that must never be sent.
const vercel = JSON.parse(fs.readFileSync(path.join(here, '..', 'vercel.json'), 'utf8'));
const adsCrons = (vercel.crons || []).filter(c => /action=cron-ads-/.test(c.path));
const minuteOfDay = (schedule) => {
  const [min, hour] = schedule.split(' ');
  return Number(hour) * 60 + Number(min);
};

const request = adsCrons.filter(c => /cron-ads-request/.test(c.path));
const collects = adsCrons.filter(c => /cron-ads-collect/.test(c.path))
  .sort((a, b) => minuteOfDay(a.schedule) - minuteOfDay(b.schedule));

ok(request.length === 1, 'exactly one request slot', 'a second would collide as a 425 duplicate');
ok(collects.length >= 2, `${collects.length} collect slots`, 'a slow queue needs more than one try');

const finals = collects.filter(c => /final=1/.test(c.path));
ok(finals.length === 1, 'exactly one collect slot is marked final');
ok(finals[0] === collects[collects.length - 1],
   'and it is the LAST one by clock time',
   'any earlier still has a retry behind it, so it must stay quiet on failure');
ok(collects.slice(0, -1).every(c => !/final=1/.test(c.path)),
   'no earlier slot can report a failure');

ok(minuteOfDay(request[0].schedule) < minuteOfDay(collects[0].schedule),
   'the request runs before the first collect');

// 11:30 UTC is 07:30 EDT, the start of the working day. The final slot may sit
// after it - it is the safety net - but a successful run has to land before.
ok(minuteOfDay(collects[0].schedule) <= 11 * 60 + 30,
   'the first collect lands by 07:30 Eastern in summer',
   `first collect at ${collects[0].schedule} UTC`);
ok(adsCrons.every(c => c.schedule.endsWith('* * *')),
   'every ad cron runs daily and checks the weekday itself',
   'day-of-week cron expressions are untested in this project');

console.log('\nmoCronReport  \u2014 what the 15th-of-the-month message says');

const brands = (o = {}) => ({
  count: o.count === undefined ? 4 : o.count,
  changed: o.changed === undefined ? 2 : o.changed,
  scale: o.scale === undefined ? 1 : o.scale,
  hold: o.hold === undefined ? 2 : o.hold,
  constrain: o.constrain === undefined ? 1 : o.constrain
});
const sbPart = { campaigns: 2, spend: 410.4, ntbOrderShare: 0.31 };

{
  const r = M.moCronReport({ month: '2026-01', brands: brands(), sb: sbPart });
  ok(r.outcome === 'ok', 'both halves landing is a clean load');
  ok(r.text.includes('January 2026'),
     'the month is named, not printed as 2026-01',
     'Slack is prose, not a data table');
  ok(r.text.includes('2 recommendations differ'),
     'and the actionable number leads: how many postures would change');
  ok(r.text.includes('31% of orders new to brand'),
     'the Sponsored Brands line carries the one metric that justifies running it');
  ok(/Postures are set on the Monthly Review page/.test(r.text),
     'with a reminder that nothing was applied',
     'monthly recommends; it never writes a posture on its own');
}

{
  const r = M.moCronReport({ month: '2026-01', brands: brands({ changed: 0, scale: 0, hold: 4, constrain: 0 }),
                             sb: sbPart });
  ok(r.text.includes('every posture already matches'),
     'a month with nothing to change says so plainly');
  ok(!/Monthly Review page/.test(r.text),
     'and does not ask you to go and look',
     'a message that always ends in a task stops being read');
}

{
  const r = M.moCronReport({ month: '2026-01', brands: brands(),
                             sb: { campaigns: 2, spend: 410, ntbOrderShare: null } });
  ok(!/new to brand/.test(r.text),
     'new-to-brand is left out rather than printed as 0% when Amazon refused it');
}

{
  const r = M.moCronReport({ month: '2026-01', brands: brands(),
                             notReady: [{ key: 'sbMonth', status: 'PENDING' }] });
  ok(r.outcome === 'partial' && r.text.startsWith('\u26a0'),
     'the brand table without Sponsored Brands is a partial load',
     'two campaigns missing is not the cadence failing');
  ok(r.text.includes('monthly Sponsored Brands report never arrived'),
     'naming the report in words rather than by its key');
}

{
  const r = M.moCronReport({ month: '2026-01',
                             notReady: [{ key: 'spMonth', status: 'PENDING' },
                                        { key: 'spPrior', status: 'PROCESSING' }] });
  ok(r.outcome === 'none' && r.text.startsWith('\ud83d\udd34'),
     'without both Sponsored Products months there is no review at all',
     'a missing prior month removes the trend, which is half of what a posture reads');
}

{
  const r = M.moCronReport({ month: '2026-01', brands: brands(), sb: sbPart,
                             censusError: 'Amazon returned 429' });
  ok(r.outcome === 'ok' && r.text.includes('Campaign snapshot did not refresh'),
     'a stale census is reported even when the reports landed',
     'every brand and margin the table reads comes from it');
}

{
  const r = M.moCronReport({ month: '2026-01', blocked: 'Missing Advertising API credentials: ADV_CLIENT_ID' });
  ok(r.outcome === 'none' && r.text.includes('could not be loaded') && r.text.includes('ADV_CLIENT_ID'),
     'a run stopped before it stored anything names the reason');
  ok(!/never arrived/.test(r.text), 'without listing reports it never got as far as');
}

{
  const r = M.moCronReport({ month: '2026-01', brands: brands({ count: 1, changed: 1, scale: 1, hold: 0, constrain: 0 }),
                             sb: { campaigns: 1, spend: 10, ntbOrderShare: 0.5 } });
  ok(r.text.includes('1 brand,') && r.text.includes('1 recommendation differs'),
     'singulars read as singulars');
}

ok(M.moMonthLabel('2026-12') === 'December 2026', 'month labels are plain English');
ok(M.moMonthLabel('') === '' || typeof M.moMonthLabel('') === 'string',
   'and a missing month never throws');

console.log('\nTHE MONTHLY SCHEDULE  \u2014 a fixed date, because a settled month never changes');

const moCrons = (vercel.crons || []).filter(c => /action=cron-monthly-/.test(c.path));
const moRequest = moCrons.filter(c => /cron-monthly-request/.test(c.path));
const moCollects = moCrons.filter(c => /cron-monthly-collect/.test(c.path))
  .sort((a, b) => minuteOfDay(a.schedule) - minuteOfDay(b.schedule));

ok(moRequest.length === 1 && moCollects.length >= 2,
   `one request slot and ${moCollects.length} collect slots`);

const dayOfMonth = (schedule) => schedule.split(' ')[2];
ok(moCrons.every(c => dayOfMonth(c.schedule) === '15'),
   'every monthly cron runs on the 15th',
   'the day the previous month finishes attributing, whatever its length');
ok(moCrons.every(c => c.schedule.split(' ')[4] === '*'),
   'and on no particular weekday',
   'day-of-month is proven in this project; day-of-week is not');

const moFinals = moCollects.filter(c => /final=1/.test(c.path));
ok(moFinals.length === 1 && moFinals[0] === moCollects[moCollects.length - 1],
   'exactly one collect slot is final, and it is the last by clock time');

ok(minuteOfDay(moRequest[0].schedule) < minuteOfDay(moCollects[0].schedule),
   'the request runs before the first collect');
ok(minuteOfDay(moRequest[0].schedule) >= 8 * 60,
   'and late enough in the UTC day that Pacific is also the 15th',
   `request at ${moRequest[0].schedule} UTC`);
// The 15th falls on a Tuesday about one month in seven, and on those days both
// crons run. Only the two REQUEST slots refresh the campaign census, and two
// concurrent syncs racing to write one snapshot would double-log every change
// they found and eat the 200-record change-log cap.
ok(minuteOfDay(moRequest[0].schedule) !== minuteOfDay(request[0].schedule),
   'the two census-refreshing slots never share a minute',
   `monthly ${moRequest[0].schedule} vs Tuesday ${request[0].schedule}`);
ok(Math.abs(minuteOfDay(moRequest[0].schedule) - minuteOfDay(request[0].schedule)) >= 60,
   'and are at least an hour apart, which is longer than either takes');

// The daily campaign refresh (adcampaigns cron-refresh) also writes the
// census, every day, so it must keep clear of both request slots for the same
// reason.
const dailyRefresh = (vercel.crons || []).filter(c => /adcampaigns\?action=cron-refresh/.test(c.path));
ok(dailyRefresh.length === 1, 'one daily campaign refresh', `found ${dailyRefresh.length}`);
for (const [name, slot] of [['Tuesday', request[0]], ['monthly', moRequest[0]]]) {
  ok(Math.abs(minuteOfDay(dailyRefresh[0].schedule) - minuteOfDay(slot.schedule)) >= 60,
     `the daily campaign refresh is at least an hour from the ${name} request`,
     `${dailyRefresh[0].schedule} vs ${slot.schedule}`);
}

cleanup();
console.log(fails === 0 ? '\nschedule: all assertions pass\n' : `\nschedule: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
