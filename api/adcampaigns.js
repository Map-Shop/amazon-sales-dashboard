import { kv } from '../lib/kv.js';
import * as adHistory from '../lib/adhistory.js';
import * as census from '../lib/adcensus.js';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Campaign Overview — Amazon ad campaign and portfolio CONFIGURATION.
//
//   GET ?action=get      — read the stored snapshot (never calls Amazon)
//   GET ?action=refresh  — fetch from Amazon, diff, store. ?dry=1 computes
//                          everything and returns it WITHOUT writing.
//   GET ?action=probe    — raw, unmapped Amazon responses for every endpoint
//  POST ?action=update   — edit one campaign. Brand is dashboard-local; the
//                          other fields are written to Amazon.
//
// All three are auth-gated. Nothing here is cron-driven yet.
//
// WHY THIS FILE EXISTS. The red-flag capped check asked the v3 *reporting* API
// for campaignBudgetAmount and got nothing back, three fixes running. A daily
// budget is campaign CONFIGURATION, not a performance metric — it lives on the
// campaign management endpoints, which are synchronous and return in ~300ms
// rather than the 1–5 minutes a report takes.
//
// The previous attempt (fetchCampaignBudgets in adspend.js) failed silently:
// every call was `if (res.ok) take(...)` with no else branch, so a 400/401/429
// logged nothing and returned {}. Downstream that read as "these campaigns have
// no budgets". Everything here is built to make the opposite mistake — to be
// loud about what it did not get:
//
//   * acAdsList is the ONLY place an Amazon list call happens. Non-2xx returns
//     { ok:false, status, bodyText }; it never swallows.
//   * Every mapped field records WHICH key produced it (acFieldCoverage), so
//     "resolved 3 of 142 via budget.amount" is visible on the first run.
//   * A count drop over 20% aborts the write instead of overwriting the
//     snapshot with a truncated page.
//
// KV layout:
//   adcampaigns:current     → { syncedAt, ptDate, rows: [campaign] }
//   adcampaigns:portfolios  → { syncedAt, rows: [portfolio] }
//   adcampaigns:changes     → { rows: [change] }   capped 200, human-facing
//                             (every record also goes to the uncapped
//                             campaign_changes table when SQL_TABLES includes
//                             "adhistory" — see lib/adhistory.js)
//   adcampaigns:meta        → { lastSyncAt, lastSyncOk, counts, sources,
//                               pages, coverage, warnings, lastError }
//   adcampaigns:overrides   → { [campaignId]: { brand, at } }  dashboard-only
//
// With SQL_TABLES including "adcampaigns" these live in tables instead
// (lib/adcensus.js: ad_census, ad_campaigns, ad_portfolios, ad_census_syncs,
// ad_brand_overrides), and the change log is campaign_changes
// (lib/adhistory.js), uncapped, with the page showing its latest 200. Every
// read and write goes through the census storage helpers below.
//
// The brand override deliberately does NOT live on the campaign row. acRunSync
// rebuilds rows from acMapCampaign and acMergePresence carries forward only
// firstSeenAt, so a row-resident override would be erased by the next refresh —
// silently reverting to "unmapped", the exact symptom it exists to fix.
//
// Campaigns are keyed by campaignId, never by name — a rename is a diff, not a
// new campaign. (Campaign Mapping keys by name, which is why a rename silently
// orphans a mapping over there. This page does not have that failure mode.)
//
// Env: ADV_CLIENT_ID, ADV_CLIENT_SECRET, ADV_REFRESH_TOKEN, ADV_PROFILE_ID

const ADS_HOST = 'https://advertising-api.amazon.com';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const AC_CONFIG = {
  PAGE_SIZE: 100,        // conservative; pagination covers the rest
  MAX_PAGES: 20,
  CHANGES_CAP: 200,
  COUNT_DROP_ABORT: 0.8  // abort the write below 80% of the previous count
};

// Fields compared between snapshots. Short, explicit, all scalars — no
// deep-equal helper needed or wanted.
const AC_TRACKED_FIELDS = [
  'name', 'state', 'dailyBudget', 'budgetType', 'targetingType',
  'biddingStrategy', 'portfolioId', 'startDate', 'endDate', 'placementsSummary',
  // Joined from the ad group rather than picked out of the campaign object, so
  // it is deliberately absent from AC_CAMPAIGN_KEYS and AC_FIELD_RULES — the
  // coverage tallies count key hits, and this field has none to count.
  'defaultBid'
];

const AC_PORTFOLIO_TRACKED = ['name', 'state', 'budgetAmount', 'budgetPolicy', 'budgetEnd'];

// Candidate key paths per field, tried in order. Dotted paths walk nested
// objects. Which one actually hit is recorded and reported — that is the whole
// point, so a wrong guess shows up as a coverage number rather than an empty
// column nobody can explain.
const AC_CAMPAIGN_KEYS = {
  campaignId:      ['campaignId'],
  name:            ['name', 'campaignName'],
  state:           ['state', 'campaignStatus'],
  dailyBudget:     ['budget.budget', 'budget.amount', 'dailyBudget', 'budget'],
  budgetType:      ['budget.budgetType', 'budgetType'],
  targetingType:   ['targetingType'],
  biddingStrategy: ['dynamicBidding.strategy', 'bidding.strategy', 'biddingStrategy'],
  portfolioId:     ['portfolioId'],
  startDate:       ['startDate'],
  endDate:         ['endDate']
};

const AC_PORTFOLIO_KEYS = {
  portfolioId:  ['portfolioId'],
  name:         ['name'],
  state:        ['state'],
  budgetAmount: ['budget.amount', 'budget.budget', 'budgetAmount'],
  budgetPolicy: ['budget.policy', 'budgetPolicy', 'policy'],
  budgetStart:  ['budget.startDate', 'budgetStart'],
  budgetEnd:    ['budget.endDate', 'budgetEnd'],
  inBudget:     ['inBudget']
};

// Coverage is a wrong-key detector, not an absence detector. Without these
// rules it reports legitimately-empty fields as failures and buries the one
// case it exists to catch.
//
//   optional      - absent is normal (an open-ended campaign has no end date)
//   informational - absence is a fact about the account, not a mapping error
//   appliesTo     - the field only exists for that ad product, so measuring it
//                   against the whole account understates it by design
const AC_FIELD_RULES = {
  endDate:         { optional: true },
  portfolioId:     { informational: true },
  targetingType:   { appliesTo: 'SP' },
  biddingStrategy: { appliesTo: 'SP' },
  // Informational: a campaign legitimately having no modifiers is not a wrong
  // key, so it should not turn the banner red.
  placements:      { appliesTo: 'SP', informational: true }
};

// v2 returns placements as bidding.adjustments with `predicate` names; v3 uses
// dynamicBidding.placementBidding with `placement` enums. Normalised in the
// mapper so the browser only ever sees one vocabulary.
const AC_PLACEMENT_ALIASES = {
  placementTop:          'PLACEMENT_TOP',
  placementProductPage:  'PLACEMENT_PRODUCT_PAGE',
  placementRestOfSearch: 'PLACEMENT_REST_OF_SEARCH'
};

const AC_PORTFOLIO_RULES = {
  budgetAmount: { informational: true },
  budgetPolicy: { informational: true },
  budgetStart:  { optional: true },
  budgetEnd:    { optional: true },
  inBudget:     { optional: true }
};

// Brand prefixes, longest first. MUST stay in step with PRODUCT_BRAND_SHORT in
// js/core.js — these strings are how this data would ever join to anything else
// in the dashboard. This is the third copy of this table in the repo (the
// others are in adspend.js and js/core.js); the house convention is duplication
// over a shared lib, so it needs checking when brands change.
const AC_BRAND_PREFIXES = [
  { prefix: 'MAP PACKS', brand: 'BrightWay Educational' },
  { prefix: 'BW PACK',   brand: 'BrightWay Educational' },
  { prefix: 'BW SET',    brand: 'BrightWay Educational' },
  { prefix: 'BW',        brand: 'BrightWay Educational' },
  { prefix: 'SOK',       brand: 'South of Kings' },
  { prefix: 'RR',        brand: 'Hubbard Scientific' },
  { prefix: 'STATE',     brand: 'MapShop State Maps' }
].sort((a, b) => b.prefix.length - a.prefix.length);

// ─── ENDPOINT SPECS ──────────────────────────────────────────────────────────
// v3 first, v2 as fallback. Both are probed so the fallback is not the untested
// branch discovered during an outage.

const AC_ENDPOINTS = {
  spV3: {
    label: 'sp-campaigns-v3', adProduct: 'SP', version: 'v3',
    url: `${ADS_HOST}/sp/campaigns/list`, method: 'POST',
    writeUrl: `${ADS_HOST}/sp/campaigns`,
    contentType: 'application/vnd.spCampaign.v3+json',
    accept: 'application/vnd.spCampaign.v3+json',
    listField: 'campaigns', paging: 'token'
  },
  // Ad groups exist only to carry defaultBid, which is the one bid control the
  // campaign object does not hold. This account runs one ad group per campaign,
  // so it joins 1:1 — see acJoinDefaultBids for what happens when it does not.
  spAdGroupsV3: {
    label: 'sp-adgroups-v3', adProduct: 'SP', version: 'v3',
    url: `${ADS_HOST}/sp/adGroups/list`, method: 'POST',
    writeUrl: `${ADS_HOST}/sp/adGroups`,
    contentType: 'application/vnd.spAdGroup.v3+json',
    accept: 'application/vnd.spAdGroup.v3+json',
    listField: 'adGroups', paging: 'token'
  },
  spV2: {
    label: 'sp-campaigns-v2', adProduct: 'SP', version: 'v2',
    url: `${ADS_HOST}/v2/sp/campaigns`, method: 'GET',
    listField: null, paging: 'index'
  },
  sbV4: {
    label: 'sb-campaigns-v4', adProduct: 'SB', version: 'v4',
    url: `${ADS_HOST}/sb/v4/campaigns/list`, method: 'POST',
    // Used only for a daily budget change, through acWriteSbBudget.
    writeUrl: `${ADS_HOST}/sb/v4/campaigns`,
    contentType: 'application/vnd.sbcampaignresource.v4+json',
    accept: 'application/vnd.sbcampaignresource.v4+json',
    listField: 'campaigns', paging: 'token'
  },
  pfV3: {
    label: 'portfolios-v3', version: 'v3',
    url: `${ADS_HOST}/portfolios/list`, method: 'POST',
    contentType: 'application/vnd.portfolio.v3+json',
    accept: 'application/vnd.portfolio.v3+json',
    listField: 'portfolios', paging: 'token'
  },
  pfV2: {
    label: 'portfolios-v2', version: 'v2',
    url: `${ADS_HOST}/v2/portfolios`, method: 'GET',
    listField: null, paging: 'none'
  }
};

export default async function handler(req, res) {
  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'Action parameter required' });

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    if (action === 'update') return handleUpdate(req, res);
  }

  if (req.method === 'GET') {
    if (action === 'get')     return handleGet(req, res);
    if (action === 'refresh') return handleRefresh(req, res);
    if (action === 'probe')   return handleProbe(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ─────────────────────────────────────────────────────────────────────
// Pure KV read. The page calls this on every load and it never touches Amazon.
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [current, portfolios, changes, meta] = await Promise.all([
      acReadCurrent(), acReadPortfolios(), acReadChanges(), acReadMeta()
    ]);

    return res.status(200).json({
      success: true,
      syncedAt:   current?.syncedAt || null,
      campaigns:  current?.rows || [],
      portfolios: portfolios?.rows || [],
      changes:    changes?.rows || [],
      meta:       meta || null,
      // The brands an override may be set to. Sent from here so the browser
      // does not carry a fourth copy of the prefix table, and so the options
      // match exactly what the update action will accept.
      knownBrands: acKnownBrands()
    });
  } catch (error) {
    console.error('[ADCAMPAIGNS GET] Error:', error);
    return res.status(500).json({ error: 'Get failed: ' + error.message });
  }
}

// ─── REFRESH ─────────────────────────────────────────────────────────────────
async function handleRefresh(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const result = await acRunSync({
      dry: req.query.dry === '1',
      force: req.query.force === '1'
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('[ADCAMPAIGNS REFRESH] Error:', error);
    return res.status(500).json({ error: 'Refresh failed: ' + error.message });
  }
}

// ─── PROBE ───────────────────────────────────────────────────────────────────
// Raw, unmapped, un-guessed. Every field name in this file was assumed until
// this action answered — read its output before trusting a mapped column.
async function handleProbe(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const accessToken = await getAdsAccessToken();
    const results = [];

    // ?campaignId= narrows the SP v3 probe to one campaign, which is how the
    // placement question gets answered against a campaign whose modifiers you
    // already know from Campaign Manager. It also proves campaignIdFilter
    // works, which the read-modify-write depends on.
    const onlyId = String(req.query.campaignId || '').trim();
    const specs = onlyId
      ? [AC_ENDPOINTS.spV3]
      : [AC_ENDPOINTS.spV3, AC_ENDPOINTS.spV2, AC_ENDPOINTS.sbV4,
         AC_ENDPOINTS.pfV3, AC_ENDPOINTS.pfV2];

    for (const spec of specs) {
      const bodyExtra = (onlyId && spec === AC_ENDPOINTS.spV3)
        ? { campaignIdFilter: { include: [onlyId] } }
        : null;
      const out = await acAdsList(accessToken, spec, { probeOnly: true, bodyExtra });
      const items = out.items || [];
      const keyUnion = new Set();
      for (const it of items.slice(0, 50)) {
        for (const k of Object.keys(it || {})) keyUnion.add(k);
      }
      results.push({
        endpoint: spec.label,
        requestUrl: spec.url,
        requestMethod: spec.method,
        ok: out.ok,
        status: out.status,
        itemCount: items.length,
        nextTokenPresent: !!out.nextTokenPresent,
        keyUnion: [...keyUnion].sort(),
        stateBreakdown: acTally(items.map(i => i && (i.state || i.campaignStatus))),
        // Over the WHOLE page, not the 3-item sample: "does a campaign with no
        // modifiers return an empty array or omit the key" cannot be answered
        // from three rows, and it decides whether absence means "none" or
        // "unknown" — which in turn decides whether a bidding write is safe.
        placementCensus: acPlacementCensus(items),
        sample: items.slice(0, 3),
        responseBodyHead: out.bodyText ? String(out.bodyText).slice(0, 2000) : null
      });
      await sleep(200);
    }

    return res.status(200).json({
      success: true,
      probedAt: new Date().toISOString(),
      campaignId: onlyId || null,
      results
    });
  } catch (error) {
    console.error('[ADCAMPAIGNS PROBE] Error:', error);
    return res.status(500).json({ error: 'Probe failed: ' + error.message });
  }
}

// Counts how campaigns actually carry placement modifiers, so the three
// possible shapes can be told apart before any mapper is written:
//   dynamicBidding absent        → we do not know this campaign's placements
//   dynamicBidding, no array     → ?
//   dynamicBidding, empty array  → genuinely no modifiers
function acPlacementCensus(items) {
  const census = {
    total: items.length,
    withDynamicBidding: 0,
    withPlacementArray: 0,
    withEmptyPlacementArray: 0,
    withNonEmptyPlacementArray: 0,
    withV2Adjustments: 0,
    placementTypesSeen: {},
    placementCountDistribution: {}
  };
  for (const it of items) {
    if (!it) continue;
    if (Array.isArray(it.bidding && it.bidding.adjustments)) census.withV2Adjustments++;
    const db = it.dynamicBidding;
    if (!db || typeof db !== 'object') continue;
    census.withDynamicBidding++;
    const pb = db.placementBidding;
    if (!Array.isArray(pb)) continue;
    census.withPlacementArray++;
    if (pb.length === 0) census.withEmptyPlacementArray++;
    else census.withNonEmptyPlacementArray++;
    const n = String(pb.length);
    census.placementCountDistribution[n] = (census.placementCountDistribution[n] || 0) + 1;
    for (const entry of pb) {
      const k = String((entry && (entry.placement || entry.predicate)) || '(unnamed)');
      census.placementTypesSeen[k] = (census.placementTypesSeen[k] || 0) + 1;
    }
  }
  return census;
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────
// Edits one campaign. Brand is written to the dashboard's own override map and
// never sent to Amazon; the other fields are Amazon writes.
async function handleUpdate(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const campaignId = acStr(req.body?.campaignId);
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    // Which page the edit was made from, for the change history only.
    const origin = AC_EDIT_ORIGINS.includes(req.body?.origin) ? req.body.origin : null;

    const local = (req.body && req.body.local) || {};
    const amazon = (req.body && req.body.amazon) || {};
    // The default bid lives on the AD GROUP — a different endpoint and a
    // different id — so it travels separately rather than being smuggled into
    // the campaign payload.
    const adGroup = (req.body && req.body.adGroup) || {};
    const hasLocal = Object.prototype.hasOwnProperty.call(local, 'brand');
    const hasAmazon = Object.keys(amazon).length > 0;
    const hasBid = Object.prototype.hasOwnProperty.call(adGroup, 'defaultBid');

    if (!hasLocal && !hasAmazon && !hasBid) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    // ── brand override ──────────────────────────────────────────────────────
    // A dashboard-local field must never cause an Amazon API call, so it is
    // applied first and independently of anything Amazon does.
    const requested = hasLocal ? (local.brand === null ? null : acStr(local.brand)) : undefined;
    if (requested !== undefined && requested !== null && !acKnownBrands().includes(requested)) {
      return res.status(400).json({
        error: `Unknown brand. Expected one of: ${acKnownBrands().join(', ')}`,
        stage: 'validate'
      });
    }

    const [current, overrides] = await Promise.all([
      acReadCurrent(),
      acLoadOverrides()
    ]);

    const rows = (current && current.rows) || [];
    const idx = rows.findIndex(r => String(r.campaignId) === campaignId);
    if (idx === -1) {
      return res.status(404).json({
        error: 'Campaign is not in the stored snapshot — refresh first.',
        stage: 'validate'
      });
    }

    const row = rows[idx];
    const before = row.brand || null;
    const prefixBrand = row.brandFromPrefix ?? acBrandFromPrefix(row.name);

    const next = { ...overrides };
    if (hasLocal) {
      // Storing an override equal to the prefix result would freeze this
      // campaign against a later prefix-table change, so record nothing then.
      if (requested === null || requested === prefixBrand) delete next[campaignId];
      else next[campaignId] = { brand: requested, at: new Date().toISOString() };
    }

    let updatedRow = acApplyBrandOverride(
      { ...row, brand: prefixBrand, brandSource: prefixBrand ? 'prefix' : 'none' },
      next
    );

    const writes = hasLocal ? [acWriteOverrides(next)] : [];
    const changeRecords = [];
    const result = { applied: {}, notApplied: [], collateral: [], amazonErrors: [] };

    if (hasLocal && (updatedRow.brand || null) !== before) {
      result.applied.brand = { from: before, to: updatedRow.brand || null };
      changeRecords.push(acEditRecord(campaignId, row, 'brand', before, updatedRow.brand || null));
    }

    // ── ad group default bid ─────────────────────────────────────────────────
    // A different endpoint and a different id, so it travels separately rather
    // than being smuggled into the campaign payload.
    let bidStage = null;
    if (hasBid) {
      const bidResult = await acWriteAdGroupBid({
        row, adGroupId: acStr(req.body?.adGroupId) || row.adGroupId,
        defaultBid: adGroup.defaultBid,
        expected: (req.body?.expected || {}).defaultBid
      });
      bidStage = bidResult.stage;
      if (!bidResult.ok) {
        // The brand override may still be valid; persist it rather than
        // discarding a change the user made.
        if (writes.length) await Promise.all(writes);
        return res.status(200).json({
          success: false, stage: bidResult.stage, campaignId,
          error: bidResult.error, conflicts: bidResult.conflicts || []
        });
      }
      result.applied.defaultBid = { from: bidResult.from, to: bidResult.to };
      updatedRow = { ...updatedRow, defaultBid: bidResult.to };
      changeRecords.push(acEditRecord(campaignId, row, 'defaultBid', bidResult.from, bidResult.to));
    }

    // ── Amazon fields ───────────────────────────────────────────────────────
    let stage = bidStage || 'store';
    if (hasAmazon) {
      const amazonResult = await acWriteAmazonFields({ campaignId, row, amazon, expected: req.body?.expected || {} });
      stage = amazonResult.stage;

      if (!amazonResult.ok) {
        // Nothing was written to Amazon. The brand override may still have been
        // valid, so persist that rather than discarding a change the user made.
        if (writes.length) await Promise.all(writes);
        return res.status(200).json({
          success: false, stage, campaignId,
          error: amazonResult.error,
          conflicts: amazonResult.conflicts || null,
          ...result
        });
      }

      Object.assign(result.applied, amazonResult.applied);
      result.notApplied = amazonResult.notApplied;
      result.collateral = amazonResult.collateral;
      updatedRow = acApplyBrandOverride({
        ...amazonResult.row,
        // acMapCampaign does not emit presence fields; carry them forward or the
        // row loses its history and looks brand new.
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: new Date().toISOString(),
        missingRuns: 0,
        presumedArchived: false
      }, next);

      for (const [field, d] of Object.entries(amazonResult.applied)) {
        changeRecords.push(acEditRecord(campaignId, row, field, d.from, d.to));
      }
    }

    if (Object.keys(result.applied).length) {
      const nextRows = rows.slice();
      nextRows[idx] = updatedRow;
      writes.push(acWriteCurrent({ ...current, rows: nextRows }));
    }

    if (changeRecords.length) {
      // History first, so it copies in the log before this append can push
      // the oldest record past the cap.
      await acEnsureHistory();
      writes.push(acAppendToLog(changeRecords, origin));
    }

    await Promise.all(writes);
    await acRecordHistory(changeRecords, origin);

    return res.status(200).json({
      success: true, stage, campaignId, ...result, row: updatedRow
    });
  } catch (error) {
    console.error('[ADCAMPAIGNS UPDATE] Error:', error);
    return res.status(500).json({ error: 'Update failed: ' + error.message });
  }
}

// Change-log record for a dashboard-initiated edit. The |w suffix keeps it
// distinct from the drift record the next refresh generates for the same
// campaign/field/day — without it acAppendChanges would dedupe them and the
// edit would silently vanish from the log.
function acEditRecord(campaignId, row, field, from, to) {
  return {
    id: `${campaignId}|${field}|${_ptDate(new Date())}|w${Date.now()}`,
    campaignId, name: row.name, adProduct: row.adProduct,
    field, from, to,
    ptDate: _ptDate(new Date()), at: new Date().toISOString(),
    source: 'edit'
  };
}

// Read → conflict-check → write → verify, for one campaign.
//
// The bid write. Same read-check-write-verify shape as acWriteAmazonFields, but
// against the ad group: the campaign object has no bid, and there is nothing on
// the ad group that can be clobbered by a partial write, so this is the simpler
// of the two.
//
// The 1:1 ad-group assumption is enforced rather than trusted — if the snapshot
// has no adGroupId, the sync found zero or several and refuses to guess which
// one the bid belongs to.
async function acWriteAdGroupBid({ row, adGroupId, defaultBid, expected }) {
  if (row.adProduct !== 'SP') {
    return { ok: false, stage: 'validate', error: 'Only Sponsored Products bids can be edited here.' };
  }
  if (!adGroupId) {
    return { ok: false, stage: 'validate',
             error: 'No single ad group is on record for this campaign, so there is no bid to change. ' +
                    'Refresh Campaign Overview; if it still says this, the campaign has more than one ad group.' };
  }
  const bid = acNum(defaultBid);
  // Amazon's floor is $0.02. The ceiling is a fat-finger guard, not an API limit.
  if (!Number.isFinite(bid) || bid < 0.02 || bid > 100) {
    return { ok: false, stage: 'validate', error: 'Bid must be between $0.02 and $100.' };
  }

  const accessToken = await getAdsAccessToken();

  const read = await acAdsList(accessToken, AC_ENDPOINTS.spAdGroupsV3, {
    probeOnly: true,
    bodyExtra: { adGroupIdFilter: { include: [adGroupId] } }
  });
  if (!read.ok) {
    return { ok: false, stage: 'read',
             error: `Could not read the ad group from Amazon (${read.status}): ${String(read.bodyText || '').slice(0, 300)}` };
  }
  const live = (read.items || []).find(g => String(g.adGroupId) === String(adGroupId));
  if (!live) {
    return { ok: false, stage: 'read',
             error: 'Amazon no longer returns this ad group. Refresh Campaign Overview.' };
  }

  const liveBid = acNum(live.defaultBid);
  // acSame, not ===, or 0.75 vs 0.750 from a JSON round-trip false-conflicts.
  if (expected !== undefined && expected !== null && !acSame(expected, liveBid)) {
    return { ok: false, stage: 'conflict',
             conflicts: [{ field: 'defaultBid', youSaw: expected, amazonHasNow: liveBid }],
             error: 'The bid has changed since this page loaded — refresh and try again.' };
  }

  const put = await acAdsWrite(accessToken, AC_ENDPOINTS.spAdGroupsV3, {
    adGroups: [{ adGroupId: acStr(adGroupId), defaultBid: bid }]
  });
  if (!put.ok) {
    return { ok: false, stage: 'write',
             error: `Amazon rejected the bid change (${put.status}): ${String(put.bodyText || '').slice(0, 300)}` };
  }

  // Verify by re-reading. A 200 does not prove it applied.
  const after = await acAdsList(accessToken, AC_ENDPOINTS.spAdGroupsV3, {
    probeOnly: true,
    bodyExtra: { adGroupIdFilter: { include: [adGroupId] } }
  });
  const confirmed = after.ok
    ? acNum((after.items || []).find(g => String(g.adGroupId) === String(adGroupId))?.defaultBid)
    : null;
  if (after.ok && Number.isFinite(confirmed) && !acSame(confirmed, bid)) {
    return { ok: false, stage: 'verify',
             error: `Amazon accepted the change but still reports $${confirmed}.` };
  }

  // Store what Amazon confirms, never what was requested.
  return { ok: true, stage: 'verify', from: liveBid, to: Number.isFinite(confirmed) ? confirmed : bid };
}

// The whole shape of this function is dictated by one hazard: dynamicBidding
// holds BOTH the bidding strategy and the placement percentages. A partial
// write of one can clear the other, so the live object is always read first and
// sent back whole.
async function acWriteAmazonFields({ campaignId, row, amazon, expected }) {
  // Sponsored Brands can change its daily budget and nothing else. It goes
  // through its own function rather than branches threaded through this one, so
  // the Sponsored Products path below stays exactly as it was proven.
  if (row.adProduct === 'SB') {
    const fields = Object.keys(amazon);
    if (fields.length !== 1 || fields[0] !== 'dailyBudget') {
      return { ok: false, stage: 'validate',
               error: 'Only the daily budget can be changed on a Sponsored Brands campaign.' };
    }
    return acWriteSbBudget({ campaignId, amazon, expected });
  }
  if (row.adProduct !== 'SP') {
    return { ok: false, stage: 'validate', error: 'Only Sponsored Products campaigns can be edited here.' };
  }
  const invalid = acValidateAmazonFields(amazon);
  if (invalid) return { ok: false, stage: 'validate', error: invalid };

  const accessToken = await getAdsAccessToken();

  // ── read ──
  // v3 only. Reading v2's bidding.adjustments and writing a v3 dynamicBidding
  // is another way placements end up cleared.
  const read = await acAdsList(accessToken, AC_ENDPOINTS.spV3, {
    probeOnly: true,
    bodyExtra: { campaignIdFilter: { include: [campaignId] } }
  });
  if (!read.ok) {
    return { ok: false, stage: 'read',
             error: `Could not read the campaign from Amazon (${read.status}): ${String(read.bodyText || '').slice(0, 300)}` };
  }
  const live = (read.items || []).find(i => String(i.campaignId) === campaignId);
  if (!live) {
    // This, not the stored snapshot, is what "the campaign is gone" means.
    return { ok: false, stage: 'read',
             error: 'Amazon no longer returns this campaign, so it cannot be edited. ' +
                    'It may have been archived or deleted in Campaign Manager — refresh to update this page.' };
  }

  const liveRow = acMapCampaign(live, 'SP', {});

  // ── conflict ──
  // acSame, not ===, or 25 vs 25.0 from a JSON round-trip false-conflicts on
  // every budget edit.
  const conflicts = [];
  for (const field of Object.keys(amazon)) {
    if (!(field in expected)) continue;
    const key = field === 'placements' ? 'placementsSummary' : field;
    const wasShown = field === 'placements' ? expected.placementsSummary : expected[field];
    if (!acSame(wasShown ?? null, liveRow[key] ?? null)) {
      conflicts.push({ field, youSaw: wasShown ?? null, amazonHasNow: liveRow[key] ?? null });
    }
  }
  if (conflicts.length) {
    return { ok: false, stage: 'conflict', conflicts,
             error: 'Amazon has changed since this page loaded — refresh and try again.' };
  }

  // ── build the payload ──
  const payload = { campaignId };
  if ('name' in amazon)  payload.name = acStr(amazon.name);
  if ('state' in amazon) payload.state = acStr(amazon.state).toUpperCase();

  if ('dailyBudget' in amazon) {
    // Refuse rather than guess DAILY: sending a budget without its type is how
    // the type gets cleared.
    if (!liveRow.budgetType) {
      return { ok: false, stage: 'write',
               error: 'Amazon did not return this campaign\'s budget type, so the budget cannot be changed safely.' };
    }
    payload.budget = { budget: acNum(amazon.dailyBudget), budgetType: liveRow.budgetType };
  }

  if ('biddingStrategy' in amazon || 'placements' in amazon) {
    // If Amazon never showed us dynamicBidding we do not know the placement
    // percentages, and writing a strategy would wipe values we never saw.
    if (!live.dynamicBidding || typeof live.dynamicBidding !== 'object') {
      return { ok: false, stage: 'write',
               error: 'Amazon did not return this campaign\'s bidding details, so bidding and placements cannot be changed safely.' };
    }
    payload.dynamicBidding = {
      ...live.dynamicBidding,
      strategy: 'biddingStrategy' in amazon ? acStr(amazon.biddingStrategy) : live.dynamicBidding.strategy,
      // Requested placements, or the live array echoed back VERBATIM. This is
      // what makes a strategy-only change safe.
      placementBidding: 'placements' in amazon
        ? (amazon.placements || []).map(p => ({
            placement: acStr(p.placement),
            percentage: acNum(p.percentage)
          }))
        : (Array.isArray(live.dynamicBidding.placementBidding) ? live.dynamicBidding.placementBidding : [])
    };
  }

  // ── write ──
  const put = await acAdsWrite(accessToken, AC_ENDPOINTS.spV3, { campaigns: [payload] });
  if (!put.ok) {
    return { ok: false, stage: 'write',
             error: `Amazon rejected the change (${put.status}): ${String(put.bodyText || '').slice(0, 400)}` };
  }

  // ── verify ──
  // Store what Amazon confirms, never what was requested: a 200 does not prove
  // the value was applied.
  const reread = await acAdsList(accessToken, AC_ENDPOINTS.spV3, {
    probeOnly: true,
    bodyExtra: { campaignIdFilter: { include: [campaignId] } }
  });
  const after = reread.ok ? (reread.items || []).find(i => String(i.campaignId) === campaignId) : null;
  if (!after) {
    return { ok: false, stage: 'verify',
             error: 'Amazon accepted the change but it could not be confirmed. Refresh to see the current values.' };
  }
  const afterRow = acMapCampaign(after, 'SP', {});

  const applied = {};
  const notApplied = [];
  for (const field of Object.keys(amazon)) {
    const key = field === 'placements' ? 'placementsSummary' : field;
    const from = liveRow[key] ?? null;
    const to = afterRow[key] ?? null;
    if (acSame(from, to)) notApplied.push({ field, value: from });
    else applied[key] = { from, to };
  }

  // Anything that changed but was not asked for. Ten lines, and it is the alarm
  // that would catch a PUT turning out to be full-replace rather than partial.
  const requestedKeys = new Set(Object.keys(amazon).map(f => f === 'placements' ? 'placementsSummary' : f));
  const collateral = [];
  for (const field of AC_TRACKED_FIELDS) {
    if (requestedKeys.has(field)) continue;
    if (!acSame(liveRow[field] ?? null, afterRow[field] ?? null)) {
      collateral.push({ field, from: liveRow[field] ?? null, to: afterRow[field] ?? null });
    }
  }

  return { ok: true, stage: 'store', applied, notApplied, collateral, row: afterRow };
}

// A Sponsored Brands daily budget, and nothing else. The same four steps as the
// Sponsored Products write: read the live campaign, refuse on a conflict,
// write, then read it back and confirm. A 200 is not proof a value was applied;
// only Amazon reporting the new value back is.
//
// Two differences, both about SB v4's shape:
//
//   - The budget is FLAT, a number with budgetType beside it. SP v3 nests it as
//     { budget, budgetType }. The census reader already documents this, and the
//     write mirrors what the read returns.
//   - The read lists every Sponsored Brands campaign rather than filtering by
//     id. There are two, and an id-filter body never exercised against SB would
//     be one more guess inside a write path.
async function acWriteSbBudget({ campaignId, amazon, expected }) {
  const invalid = acValidateAmazonFields({ dailyBudget: amazon.dailyBudget });
  if (invalid) return { ok: false, stage: 'validate', error: invalid };

  const accessToken = await getAdsAccessToken();
  const find = async () => {
    const res = await acAdsList(accessToken, AC_ENDPOINTS.sbV4, {});
    const live = res.ok ? (res.items || []).find(i => String(i.campaignId) === String(campaignId)) : null;
    return { res, live: live || null };
  };

  // ── read ──
  const before = await find();
  if (!before.res.ok) {
    return { ok: false, stage: 'read',
             error: `Could not read the campaign from Amazon (${before.res.status}): ${
               String(before.res.bodyText || '').slice(0, 300)}` };
  }
  if (!before.live) {
    return { ok: false, stage: 'read',
             error: 'Amazon no longer returns this campaign, so it cannot be edited. ' +
                    'It may have been archived in Campaign Manager.' };
  }
  const liveRow = acMapCampaign(before.live, 'SB', {});

  // ── conflict ──
  // What the page showed goes in `expected`. The monthly numbers take minutes to
  // pull, so the budget really can move between reading them and pressing apply.
  const exp = expected || {};
  if ('dailyBudget' in exp && !acSame(exp.dailyBudget ?? null, liveRow.dailyBudget ?? null)) {
    return { ok: false, stage: 'conflict',
             conflicts: [{ field: 'dailyBudget', youSaw: exp.dailyBudget ?? null,
                           amazonHasNow: liveRow.dailyBudget ?? null }],
             error: 'Amazon has changed since this page loaded — refresh and try again.' };
  }

  // Refuse rather than guess: sending a budget without its type is how the type
  // gets cleared, and a lifetime budget is not a daily one.
  if (!liveRow.budgetType) {
    return { ok: false, stage: 'write',
             error: 'Amazon did not return this campaign\'s budget type, so the budget cannot be changed safely.' };
  }
  if (!/^DAILY$/i.test(liveRow.budgetType)) {
    return { ok: false, stage: 'write',
             error: `This campaign has a ${String(liveRow.budgetType).toLowerCase()} budget, not a daily one.` };
  }

  // ── write ──
  const payload = { campaignId: String(campaignId), budget: acNum(amazon.dailyBudget),
                    budgetType: liveRow.budgetType };
  const put = await acAdsWrite(accessToken, AC_ENDPOINTS.sbV4, { campaigns: [payload] });
  if (!put.ok) {
    return { ok: false, stage: 'write',
             error: `Amazon rejected the change (${put.status}): ${String(put.bodyText || '').slice(0, 400)}` };
  }

  // ── verify ──
  const after = await find();
  if (!after.res.ok || !after.live) {
    return { ok: false, stage: 'verify',
             error: 'Amazon accepted the change but it could not be confirmed. Refresh to see the current values.' };
  }
  const afterRow = acMapCampaign(after.live, 'SB', {});

  const applied = {};
  const notApplied = [];
  if (acSame(liveRow.dailyBudget ?? null, afterRow.dailyBudget ?? null)) {
    notApplied.push({ field: 'dailyBudget', value: liveRow.dailyBudget ?? null });
  } else {
    applied.dailyBudget = { from: liveRow.dailyBudget ?? null, to: afterRow.dailyBudget ?? null };
  }

  // Anything else that moved. The alarm that would catch a PUT turning out to
  // replace the whole campaign rather than patch one field.
  const collateral = [];
  for (const field of AC_TRACKED_FIELDS) {
    if (field === 'dailyBudget') continue;
    if (!acSame(liveRow[field] ?? null, afterRow[field] ?? null)) {
      collateral.push({ field, from: liveRow[field] ?? null, to: afterRow[field] ?? null });
    }
  }

  return { ok: true, stage: 'store', applied, notApplied, collateral, row: afterRow };
}

function acValidateAmazonFields(amazon) {
  if ('name' in amazon) {
    const n = acStr(amazon.name);
    if (!n) return 'Campaign name cannot be empty.';
    if (n.length > 255) return 'Campaign name is too long.';
  }
  if ('state' in amazon) {
    // ARCHIVED is irreversible on Amazon and is deliberately not offered.
    if (!['ENABLED', 'PAUSED'].includes(acStr(amazon.state).toUpperCase())) {
      return 'State must be Enabled or Paused.';
    }
  }
  if ('dailyBudget' in amazon) {
    const b = acNum(amazon.dailyBudget);
    if (b === null || !(b > 0)) return 'Daily budget must be greater than zero.';
    if (b > 100000) return 'Daily budget looks implausibly large.';
  }
  if ('biddingStrategy' in amazon) {
    if (!acStr(amazon.biddingStrategy)) return 'Bidding strategy cannot be empty.';
  }
  if ('placements' in amazon) {
    if (!Array.isArray(amazon.placements)) return 'Placements must be a list.';
    for (const p of amazon.placements) {
      const pct = acNum(p && p.percentage);
      if (!acStr(p && p.placement)) return 'A placement is missing its name.';
      if (pct === null || pct < 0 || pct > 900 || Math.round(pct) !== pct) {
        return 'Placement percentages must be whole numbers between 0 and 900.';
      }
    }
  }
  return null;
}

// The one place a mutating Amazon call happens. Like acAdsList it never
// swallows: a non-2xx comes back with the status and body.
async function acAdsWrite(accessToken, spec, body) {
  // Explicit rather than falling back to spec.url: the list and write URLs
  // differ by a path segment, and PUTting to the list one fails as a 403 about
  // Authorization parsing, which sends you looking at credentials for an hour.
  if (!spec.writeUrl) {
    return { ok: false, status: 0, bodyText: `no write endpoint configured for ${spec.label}` };
  }
  try {
    const headers = adsAuthHeaders(accessToken, {
      'Content-Type': spec.contentType,
      'Accept': spec.accept
    });
    // Retries only on 429. withAdsRetry also retries 5xx, which is wrong for a
    // mutating request: a 500 may mean the write landed, and retrying could
    // apply it twice.
    let res = await fetch(spec.writeUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (res.status === 429) {
      await sleep(2000);
      res = await fetch(spec.writeUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, bodyText: text };

    // 207 is res.ok, so per-item errors must be inspected rather than assumed
    // away — otherwise a partial failure reads as complete success.
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON success */ }
    const errs = acCollectItemErrors(parsed);
    if (errs.length) {
      return { ok: false, status: res.status, bodyText: JSON.stringify(errs).slice(0, 400) };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, bodyText: 'write threw: ' + err.message };
  }
}

function acCollectItemErrors(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const out = [];
  for (const value of Object.values(parsed)) {
    if (!value || typeof value !== 'object') continue;
    const list = Array.isArray(value.error) ? value.error
               : Array.isArray(value.errors) ? value.errors : null;
    if (list && list.length) out.push(...list);
  }
  return out;
}

// ─── SYNC CORE ───────────────────────────────────────────────────────────────
// Build the whole snapshot in memory, validate it, THEN write. A timeout
// mid-build costs nothing; a timeout mid-write would leave a corrupt source of
// truth.
async function acRunSync({ dry = false, force = false } = {}) {
  const startedAt = Date.now();
  const accessToken = await getAdsAccessToken();
  const warnings = [];
  const errors = [];

  const [sp, sb, pf, ag] = [
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.spV3, AC_ENDPOINTS.spV2, warnings, errors),
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.sbV4, null, warnings, errors),
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.pfV3, AC_ENDPOINTS.pfV2, warnings, errors),
    // No fallback: there is no v2 shape worth reading here, and a failure costs
    // one annotation rather than the sync.
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.spAdGroupsV3, null, warnings, errors)
  ];

  // Map, recording which key produced each field.
  const hits = {};
  const campaigns = [
    ...sp.items.map(r => acMapCampaign(r, 'SP', hits)),
    ...sb.items.map(r => acMapCampaign(r, 'SB', hits))
  ].filter(c => c.campaignId);

  // defaultBid is joined AFTER mapping, so it never enters the key-hit tallies.
  const bidJoin = acJoinDefaultBids(campaigns, ag.items);
  if (bidJoin.multiAdGroup.length) {
    // The 1:1 assumption is the whole reason this is a campaign-level field.
    // If it stops holding, say so rather than quietly reporting one ad group's
    // bid as though it were the campaign's.
    warnings.push(`defaultBid: ${bidJoin.multiAdGroup.length} campaigns have more than one ad group ` +
                  `and were left unknown (${bidJoin.multiAdGroup.slice(0, 3).join(', ')}` +
                  `${bidJoin.multiAdGroup.length > 3 ? '…' : ''})`);
  }

  const pfHits = {};
  const portfolios = pf.items.map(r => acMapPortfolio(r, pfHits)).filter(p => p.portfolioId);

  const coverage = {
    campaigns:  acFieldCoverage(campaigns, AC_CAMPAIGN_KEYS, hits),
    portfolios: acFieldCoverage(portfolios, AC_PORTFOLIO_KEYS, pfHits, AC_PORTFOLIO_RULES)
  };

  for (const [field, c] of Object.entries(coverage.campaigns.fields)) {
    if (acCoverageLooksWrong(c)) {
      warnings.push(`campaigns.${field}: resolved ${c.resolved} of ${c.applicable} enabled` +
                    (c.multiKeyWithinProduct ? ' via inconsistent keys within one ad product' : ''));
    }
  }

  const [prevCurrent, prevPortfolios, prevChanges, overrides] = await Promise.all([
    acReadCurrent(),
    acReadPortfolios(),
    acReadChanges(),
    acLoadOverrides()
  ]);
  const prevRows = prevCurrent?.rows || [];
  const isBaseline = prevRows.length === 0;

  // A truncated page must never overwrite the snapshot. Without this, one bad
  // fetch silently redefines what "the account" is.
  const aborted = !force && prevRows.length > 0 &&
                  campaigns.length < prevRows.length * AC_CONFIG.COUNT_DROP_ABORT;

  const now = new Date().toISOString();
  const ptDate = _ptDate(new Date());

  const merged = acMergePresence(prevRows, campaigns, now)
    .map(row => acApplyBrandOverride(row, overrides));
  const mergedPortfolios = acMergePresence(prevPortfolios?.rows || [], portfolios, now, 'portfolioId');

  // First run emits no per-field records. Diffing 142 new campaigns field by
  // field would write ~1,100 entries and evict the entire capped log on run one.
  const changeRecords = isBaseline
    ? []
    : acDiffSnapshot(prevRows, merged, ptDate, now);

  const result = {
    success: !aborted,
    aborted,
    dry,
    baseline: isBaseline,
    syncedAt: now,
    ptDate,
    counts: {
      sp: campaigns.filter(c => c.adProduct === 'SP').length,
      sb: campaigns.filter(c => c.adProduct === 'SB').length,
      portfolios: portfolios.length,
      previous: prevRows.length,
      states: acTally(campaigns.map(c => c.state))
    },
    sources: { sp: sp.source, sb: sb.source, portfolios: pf.source },
    pages:   { sp: sp.pages, sb: sb.pages, portfolios: pf.pages },
    coverage,
    warnings,
    errors,
    changes: changeRecords,
    durationMs: Date.now() - startedAt
  };

  if (aborted) {
    result.error = `Campaign count dropped ${prevRows.length} → ${campaigns.length}; ` +
                   `refusing to overwrite. Re-run with force=1 if this is real.`;
    await acWriteMeta({
      lastSyncAt: now, lastSyncOk: false, lastError: result.error,
      counts: result.counts, sources: result.sources, pages: result.pages,
      coverage, warnings
    });
    return result;
  }

  if (dry) {
    result.wouldWrite = { campaigns: merged.length, portfolios: mergedPortfolios.length,
                          changes: changeRecords.length };
    return result;
  }

  // History first, so it copies in the log before this append can push the
  // oldest records past the cap.
  if (changeRecords.length) await acEnsureHistory();

  await acStoreRefresh({
    current:    { syncedAt: now, ptDate, rows: merged },
    portfolios: { syncedAt: now, rows: mergedPortfolios },
    prevChanges, changeRecords,
    meta: {
      lastSyncAt: now, lastSyncOk: true, lastSyncDurationMs: result.durationMs,
      counts: result.counts, sources: result.sources, pages: result.pages,
      coverage, warnings, lastError: null
    }
  });
  await acRecordHistory(changeRecords, null);

  return result;
}

// v3 first; fall back to v2 only when v3 genuinely failed or returned nothing.
// The previous implementation fell back only on TOTAL failure, so a truncated
// page counted as success forever.
async function acFetchWithFallback(accessToken, primary, fallback, warnings, errors) {
  const first = await acAdsList(accessToken, primary);
  if (first.ok && first.items.length) {
    if (first.truncated) warnings.push(`${primary.label}: hit the page cap, results may be incomplete`);
    return { items: first.items, source: primary.version, pages: first.pages, truncated: first.truncated };
  }

  if (!first.ok) {
    errors.push({ endpoint: primary.label, status: first.status, body: String(first.bodyText || '').slice(0, 400) });
  } else {
    warnings.push(`${primary.label}: returned 0 items`);
  }

  if (!fallback) return { items: first.items || [], source: primary.version, pages: first.pages, truncated: false };

  const second = await acAdsList(accessToken, fallback);
  if (!second.ok) {
    errors.push({ endpoint: fallback.label, status: second.status, body: String(second.bodyText || '').slice(0, 400) });
    return { items: [], source: null, pages: 0, truncated: false };
  }
  warnings.push(`${primary.label} unusable; fell back to ${fallback.label}`);
  return { items: second.items, source: fallback.version, pages: second.pages, truncated: second.truncated };
}

// ─── THE ONE PLACE AMAZON LIST CALLS HAPPEN ──────────────────────────────────
// Non-2xx returns { ok:false, status, bodyText } — it never swallows, and it
// never converts an HTTP failure into an empty result set. That conversion is
// exactly what made the previous three attempts undiagnosable.
async function acAdsList(accessToken, spec, { probeOnly = false, bodyExtra = null } = {}) {
  const items = [];
  let pages = 0;
  let nextToken = null;
  let truncated = false;
  let nextTokenPresent = false;
  const maxPages = probeOnly ? 1 : AC_CONFIG.MAX_PAGES;

  try {
    do {
      const { url, init } = acBuildRequest(accessToken, spec, nextToken, items.length, bodyExtra);
      const res = await withAdsRetry(() => fetch(url, init));
      const text = await res.text();

      if (!res.ok) {
        return { ok: false, status: res.status, bodyText: text, items, pages };
      }

      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch { return { ok: false, status: res.status, bodyText: 'non-JSON body: ' + text.slice(0, 400), items, pages }; }

      const page = spec.listField ? (body[spec.listField] || []) : (Array.isArray(body) ? body : []);
      items.push(...page);
      pages++;

      nextToken = spec.paging === 'token' ? (body.nextToken || null) : null;
      if (nextToken) nextTokenPresent = true;

      if (spec.paging === 'index') {
        // v2 pages by startIndex/count — stop on a short page.
        nextToken = page.length === AC_CONFIG.PAGE_SIZE ? 'more' : null;
      }
      if (spec.paging === 'none') nextToken = null;

      if (pages >= maxPages && nextToken) { truncated = true; break; }
    } while (nextToken && !probeOnly);

    return { ok: true, status: 200, items, pages, truncated, nextTokenPresent, bodyText: null };
  } catch (err) {
    return { ok: false, status: 0, bodyText: 'fetch threw: ' + err.message, items, pages };
  }
}

function acBuildRequest(accessToken, spec, nextToken, offset, bodyExtra) {
  const headers = adsAuthHeaders(accessToken, {});
  if (spec.accept) headers['Accept'] = spec.accept;

  if (spec.method === 'POST') {
    headers['Content-Type'] = spec.contentType;
    const body = { maxResults: AC_CONFIG.PAGE_SIZE, ...(bodyExtra || {}) };
    if (nextToken && nextToken !== 'more') body.nextToken = nextToken;
    return { url: spec.url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  let url = spec.url;
  if (spec.paging === 'index') {
    // stateFilter is explicit: without it some accounts omit PAUSED/ARCHIVED,
    // and a campaign missing from a response is indistinguishable from one
    // that was deleted.
    url += `?stateFilter=enabled,paused,archived&count=${AC_CONFIG.PAGE_SIZE}&startIndex=${offset}`;
  }
  return { url, init: { method: 'GET', headers } };
}

// ─── MAPPING ─────────────────────────────────────────────────────────────────

function acMapCampaign(raw, adProduct, hits) {
  // State is read first because it decides which bucket the key-hits land in.
  // Coverage counts enabled campaigns only, so the viaKey tally has to be
  // measured over that same population or the two numbers disagree.
  const stateHits = {};
  const state = acStr(acPick(raw, AC_CAMPAIGN_KEYS.state, stateHits, 'state')).toUpperCase() || null;
  // A campaign with no state counts as enabled in acFieldCoverage, so it has to
  // bucket the same way here or viaKey would disagree with the resolved count.
  const bucket = (!state || state === 'ENABLED') ? 'enabled' : 'other';
  hits[bucket] = hits[bucket] || {};
  // Also bucketed by ad product: SP v3 nests the budget as { budget: { budget,
  // budgetType } } while SB v4 returns it flat, so one field legitimately
  // resolves through different keys for different products. That is the
  // candidate-key list doing its job, not an ambiguity worth warning about.
  const scope = hits[bucket][adProduct] = hits[bucket][adProduct] || {};
  acMergeHits(scope, stateHits);

  const name = acStr(acPick(raw, AC_CAMPAIGN_KEYS.name, scope, 'name'));
  // Read once and reused. Picking it twice - once here, once for the field -
  // double-counted every hit and made the tally disagree with the resolved
  // count, which is the fastest way to make a diagnostic untrustworthy.
  const targeting = acStr(acPick(raw, AC_CAMPAIGN_KEYS.targetingType, scope, 'targetingType'));
  const type = acCampaignType(name, targeting);
  const placements = acReadPlacements(raw, scope);
  const prefixBrand = acBrandFromPrefix(name);

  return {
    campaignId:      acStr(acPick(raw, AC_CAMPAIGN_KEYS.campaignId, scope, 'campaignId')),
    adProduct,
    name,
    state,
    // null means UNKNOWN, never 0 — a zero budget is a real and different fact.
    dailyBudget:     acNum(acPick(raw, AC_CAMPAIGN_KEYS.dailyBudget, scope, 'dailyBudget')),
    budgetType:      acStr(acPick(raw, AC_CAMPAIGN_KEYS.budgetType, scope, 'budgetType')) || null,
    targetingType:   targeting || null,
    biddingStrategy: acStr(acPick(raw, AC_CAMPAIGN_KEYS.biddingStrategy, scope, 'biddingStrategy')) || null,
    portfolioId:     acStr(acPick(raw, AC_CAMPAIGN_KEYS.portfolioId, scope, 'portfolioId')) || null,
    startDate:       acDate(acPick(raw, AC_CAMPAIGN_KEYS.startDate, scope, 'startDate')),
    endDate:         acDate(acPick(raw, AC_CAMPAIGN_KEYS.endDate, scope, 'endDate')),
    // brand is the EFFECTIVE brand and may be replaced by an override in
    // acApplyBrandOverride; brandFromPrefix always shows what the name implies,
    // so the two can be compared in the UI.
    brand:           prefixBrand,
    brandFromPrefix: prefixBrand,
    brandSource:     prefixBrand ? 'prefix' : 'none',
    campaignType:    type.type,
    typeSource:      type.source,
    // null means UNKNOWN, [] means genuinely none. Never conflate them: writing
    // a bidding strategy for a campaign whose placements we never saw is how
    // the percentages get wiped.
    placements,
    placementsSummary: acPlacementsSummary(placements)
  };
}

function acMapPortfolio(raw, hits) {
  const stateHits = {};
  const state = acStr(acPick(raw, AC_PORTFOLIO_KEYS.state, stateHits, 'state'));
  const bucket = (String(state).toUpperCase() === 'ENABLED' || state === '') ? 'enabled' : 'other';
  hits[bucket] = hits[bucket] || {};
  const scope = hits[bucket].PF = hits[bucket].PF || {};
  acMergeHits(scope, stateHits);
  return {
    portfolioId:  acStr(acPick(raw, AC_PORTFOLIO_KEYS.portfolioId, scope, 'portfolioId')),
    name:         acStr(acPick(raw, AC_PORTFOLIO_KEYS.name, scope, 'name')),
    state:        state || null,
    budgetAmount: acNum(acPick(raw, AC_PORTFOLIO_KEYS.budgetAmount, scope, 'budgetAmount')),
    // Policy is load-bearing: a portfolio budget is a PERIOD TOTAL, not a daily
    // cap. Dropping it invites comparing it against a sum of daily budgets,
    // which are different units.
    budgetPolicy: acStr(acPick(raw, AC_PORTFOLIO_KEYS.budgetPolicy, scope, 'budgetPolicy')) || null,
    budgetStart:  acDate(acPick(raw, AC_PORTFOLIO_KEYS.budgetStart, scope, 'budgetStart')),
    budgetEnd:    acDate(acPick(raw, AC_PORTFOLIO_KEYS.budgetEnd, scope, 'budgetEnd')),
    inBudget:     acPick(raw, AC_PORTFOLIO_KEYS.inBudget, scope, 'inBudget') ?? null
  };
}

// Reads placement bid adjustments, recording which shape produced them so the
// coverage table shows it like every other field.
//
// The three cases are deliberately distinguished:
//   dynamicBidding present + array   -> those modifiers   (known)
//   dynamicBidding present, no array -> []                (known: none)
//   dynamicBidding absent entirely   -> null              (UNKNOWN)
function acReadPlacements(raw, hits) {
  const record = (path) => {
    if (!hits) return;
    hits.placements = hits.placements || {};
    hits.placements[path] = (hits.placements[path] || 0) + 1;
  };

  const db = raw && raw.dynamicBidding;
  if (db && typeof db === 'object') {
    if (Array.isArray(db.placementBidding)) {
      record('dynamicBidding.placementBidding');
      return acNormalizePlacements(db.placementBidding);
    }
    // Strategy came back but no placement array: Amazon reports campaigns with
    // no adjustments this way.
    record('dynamicBidding (no placements)');
    return [];
  }

  const v2 = raw && raw.bidding;
  if (v2 && Array.isArray(v2.adjustments)) {
    record('bidding.adjustments');
    return acNormalizePlacements(v2.adjustments);
  }

  return null;
}

function acNormalizePlacements(list) {
  return (list || [])
    .map(e => {
      const rawName = acStr(e && (e.placement || e.predicate));
      const pct = acNum(e && e.percentage);
      if (!rawName || pct === null) return null;
      return { placement: AC_PLACEMENT_ALIASES[rawName] || rawName.toUpperCase(), percentage: pct };
    })
    .filter(Boolean)
    .sort((a, b) => a.placement.localeCompare(b.placement));
}

// Deterministic, or it manufactures phantom diffs. '' = none, null = unknown.
function acPlacementsSummary(placements) {
  if (placements === null || placements === undefined) return null;
  if (!placements.length) return '';
  return placements.map(p => `${p.placement}:${p.percentage}`).join('|');
}

// Type comes from the name suffix, cross-checked against the API's own
// targetingType. A campaign named "(Auto)" reporting MANUAL is a real finding,
// not something to silently resolve in either direction.
function acCampaignType(name, targetingType) {
  const m = String(name || '').match(/\(([^)]+)\)\s*$/);
  const fromName = m ? m[1].trim() : '';
  const norm = fromName.toLowerCase();
  // Explicit labels rather than title-casing — ASIN is an acronym and
  // "Asin" would look like a typo everywhere it rendered.
  const TYPE_LABELS = {
    auto: 'Auto', broad: 'Broad', exact: 'Exact', phrase: 'Phrase',
    asin: 'ASIN', 'product targeting': 'ASIN', pt: 'ASIN'
  };
  const named = TYPE_LABELS[norm] || null;

  const tt = String(targetingType || '').toUpperCase();
  if (!named) return { type: tt ? (tt === 'AUTO' ? 'Auto' : 'Manual') : null, source: tt ? 'targeting' : 'none' };
  if (tt === 'AUTO' && named !== 'Auto') return { type: named, source: 'conflict' };
  if (tt === 'MANUAL' && named === 'Auto') return { type: named, source: 'conflict' };
  return { type: named, source: 'name' };
}

// The distinct brands the prefix table can produce. An override is validated
// against these — free text would create a phantom brand that then pollutes the
// Brand filter dropdown permanently.
function acKnownBrands() {
  return [...new Set(AC_BRAND_PREFIXES.map(e => e.brand))].sort();
}

// Applies a stored override on top of the prefix-derived brand. Called from
// exactly two places: acRunSync after mapping, and the update action for the
// row it just edited.
function acApplyBrandOverride(row, overrides) {
  const o = overrides && overrides[String(row.campaignId || '')];
  if (!o || !o.brand) return row;
  return { ...row, brand: o.brand, brandSource: 'override' };
}

async function acLoadOverrides() {
  const stored = census.censusInSql() ? await census.getOverrides() : await kv.get('adcampaigns:overrides');
  return (stored && typeof stored === 'object') ? stored : {};
}

// ─── CENSUS STORAGE ──────────────────────────────────────────────────────────
// The census and its change log, from the tables when SQL_TABLES includes
// "adcampaigns" (lib/adcensus.js; the log is campaign_changes in
// lib/adhistory.js), otherwise from the adcampaigns:* kv records. Reads
// return each kv record's shape; null when there is none.
function acReadCurrent() {
  return census.censusInSql() ? census.getCampaigns() : kv.get('adcampaigns:current');
}
function acReadPortfolios() {
  return census.censusInSql() ? census.getPortfolios() : kv.get('adcampaigns:portfolios');
}
function acReadMeta() {
  return census.censusInSql() ? census.getStatus() : kv.get('adcampaigns:meta');
}
// { rows } — the capped log, oldest first.
async function acReadChanges() {
  if (!census.censusInSql()) return kv.get('adcampaigns:changes');
  return { rows: await adHistory.getRecentChanges(AC_CONFIG.CHANGES_CAP) };
}
function acWriteCurrent(current) {
  return census.censusInSql() ? census.replaceCampaigns(current) : kv.set('adcampaigns:current', current);
}
function acWriteMeta(meta) {
  return census.censusInSql() ? census.recordStatus(meta) : kv.set('adcampaigns:meta', meta);
}
function acWriteOverrides(overrides) {
  return census.censusInSql() ? census.replaceOverrides(overrides) : kv.set('adcampaigns:overrides', overrides);
}
// Appends records to the change log. In SQL they join campaign_changes (the
// log uncapped, with the page an edit came from); the page still sees the
// latest 200.
async function acAppendToLog(records, origin) {
  if (census.censusInSql()) return adHistory.recordChanges(records, origin);
  const stored = await kv.get('adcampaigns:changes');
  return kv.set('adcampaigns:changes', {
    rows: acAppendChanges((stored && stored.rows) || [], records)
  });
}
// A refresh's writes: both snapshots, the change log, and the status.
async function acStoreRefresh({ current, portfolios, prevChanges, changeRecords, meta }) {
  if (census.censusInSql()) {
    await census.storeRefresh(current, portfolios, meta);
    await adHistory.recordChanges(changeRecords, null);
    return;
  }
  await Promise.all([
    kv.set('adcampaigns:current',    current),
    kv.set('adcampaigns:portfolios', portfolios),
    kv.set('adcampaigns:changes',    { rows: acAppendChanges(prevChanges?.rows || [], changeRecords) }),
    kv.set('adcampaigns:meta',       meta)
  ]);
}
// The census for the review pages (api/adspend.js loadCensus).
async function acReadCensus() {
  const [current, portfolios, changes] = await Promise.all([acReadCurrent(), acReadPortfolios(), acReadChanges()]);
  return { current, portfolios, changes };
}

function acBrandFromPrefix(name) {
  const up = String(name || '').trim().toUpperCase();
  for (const e of AC_BRAND_PREFIXES) {
    if (!up.startsWith(e.prefix)) continue;
    const next = up.charAt(e.prefix.length);
    if (next === '' || !/[A-Z0-9]/.test(next)) return e.brand;
  }
  return null;
}

// ─── COVERAGE ────────────────────────────────────────────────────────────────
// "resolved 3 of 142 via budget.amount" on run one beats discovering a week
// later that a check has quietly been evaluating nothing.
function acFieldCoverage(rows, keySpec, hits, rules) {
  const ruleSet = rules || AC_FIELD_RULES;
  // Enabled only. A paused campaign with no portfolio is not a finding, and a
  // wrong key would fail across every state anyway - so enabled is a valid
  // sample and a far quieter one.
  const enabled = rows.filter(r => !r.state || String(r.state).toUpperCase() === 'ENABLED');
  const byProduct = (hits && hits.enabled) || {};

  const fields = {};
  for (const field of Object.keys(keySpec)) {
    const rule = ruleSet[field] || {};
    const applicableRows = rule.appliesTo
      ? enabled.filter(r => r.adProduct === rule.appliesTo)
      : enabled;
    const resolved = applicableRows.filter(
      r => r[field] !== null && r[field] !== undefined && r[field] !== ''
    ).length;
    // Per product, then merged for display. A field resolving through two keys
    // where each product uses exactly one of them is two API shapes; two keys
    // WITHIN a product means at least one guess is wrong.
    const viaKeyByProduct = {};
    const viaKey = {};
    let multiKeyWithinProduct = false;
    for (const [product, scope] of Object.entries(byProduct)) {
      const forField = (scope && scope[field]) || {};
      if (!Object.keys(forField).length) continue;
      viaKeyByProduct[product] = forField;
      if (Object.keys(forField).length > 1) multiKeyWithinProduct = true;
      for (const [k, n] of Object.entries(forField)) viaKey[k] = (viaKey[k] || 0) + n;
    }

    fields[field] = {
      resolved,
      applicable: applicableRows.length,
      viaKey,
      viaKeyByProduct,
      multiKeyWithinProduct,
      optional: !!rule.optional,
      informational: !!rule.informational,
      appliesTo: rule.appliesTo || null
    };
    // Stamped here rather than recomputed in the browser, so there is one
    // definition of "this looks like a wrong key" instead of two.
    fields[field].looksWrong = acCoverageLooksWrong(fields[field]);
  }

  return { scope: { basis: 'enabled', counted: enabled.length, of: rows.length }, fields };
}

// A wrong key looks like: a required field missing on a tenth or more of the
// campaigns it applies to, or one field resolving through several keys WITHIN
// a single ad product. Different keys across different products is just SP and
// SB returning different shapes, which the candidate-key list exists to absorb.
function acCoverageLooksWrong(c) {
  if (c.optional || c.informational) return false;
  if (c.multiKeyWithinProduct) return true;
  return c.applicable > 0 && c.resolved < c.applicable * 0.9;
}

function acMergeHits(target, source) {
  for (const [field, byKey] of Object.entries(source || {})) {
    target[field] = target[field] || {};
    for (const [k, n] of Object.entries(byKey)) target[field][k] = (target[field][k] || 0) + n;
  }
}

// ─── PRESENCE ────────────────────────────────────────────────────────────────
// Absence from a response is never evidence of deletion. Amazon archives rather
// than deletes; a missing row far more often means a state filter that wasn't
// set, a page that wasn't fetched, or a 429 that got swallowed.
function acMergePresence(prevRows, nextRows, now, idField = 'campaignId') {
  const prevById = new Map(prevRows.map(r => [r[idField], r]));
  const nextById = new Map(nextRows.map(r => [r[idField], r]));
  const out = [];

  for (const row of nextRows) {
    const prev = prevById.get(row[idField]);
    out.push({
      ...row,
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
      missingRuns: 0,
      presumedArchived: false
    });
  }

  for (const prev of prevRows) {
    if (nextById.has(prev[idField])) continue;
    const missingRuns = (prev.missingRuns || 0) + 1;
    out.push({
      ...prev,
      missingRuns,
      presumedArchived: missingRuns >= 3
    });
  }

  return out;
}

// The one bid control the campaign object does not carry. This account runs one
// ad group per campaign, which makes defaultBid a campaign attribute — but the
// code does not assume it holds.
//
// null means UNKNOWN, never "no bid", exactly as with placements: a campaign
// with two ad groups has two bids and neither is the campaign's, so reporting
// either would be a fabrication. Sponsored Brands is never joined at all; its
// ad groups have a different shape and there are two of them.
//
// Mutates the rows in place because it runs inside acRunSync between mapping
// and the presence merge, where the rows are still local.
function acJoinDefaultBids(campaigns, adGroups) {
  const byCampaign = new Map();
  for (const g of (adGroups || [])) {
    const campaignId = acStr(g.campaignId);
    if (!campaignId) continue;
    // An archived ad group is not the live one; counting it would make a
    // perfectly ordinary campaign look ambiguous.
    if (String(g.state || '').toUpperCase() === 'ARCHIVED') continue;
    if (!byCampaign.has(campaignId)) byCampaign.set(campaignId, []);
    byCampaign.get(campaignId).push(g);
  }

  const multiAdGroup = [];
  let resolved = 0;
  for (const row of campaigns) {
    if (row.adProduct !== 'SP') { row.defaultBid = null; row.adGroupId = null; continue; }
    const groups = byCampaign.get(String(row.campaignId)) || [];
    if (groups.length === 1) {
      const bid = acNum(groups[0].defaultBid);
      row.defaultBid = Number.isFinite(bid) && bid > 0 ? bid : null;
      // The bid write targets the ad group, so its id travels with the bid.
      // Not tracked for diffing: an ad group id changing means a different ad
      // group, not a change to this one.
      row.adGroupId = acStr(groups[0].adGroupId) || null;
      if (row.defaultBid !== null) resolved++;
    } else {
      row.defaultBid = null;
      row.adGroupId = null;
      if (groups.length > 1) multiAdGroup.push(row.name || row.campaignId);
    }
  }
  return { resolved, multiAdGroup };
}

// ─── DIFF ────────────────────────────────────────────────────────────────────
function acDiffSnapshot(prevRows, nextRows, ptDate, now) {
  const prevById = new Map(prevRows.map(r => [r.campaignId, r]));
  const records = [];

  for (const row of nextRows) {
    const prev = prevById.get(row.campaignId);

    if (!prev) {
      records.push(acChange(row, '_created', null, row.name, ptDate, now));
      continue;
    }
    if (row.presumedArchived && !prev.presumedArchived) {
      records.push(acChange(row, '_missing', null, `absent for ${row.missingRuns} runs`, ptDate, now));
      continue;
    }
    if (!row.presumedArchived && prev.presumedArchived) {
      records.push(acChange(row, '_returned', null, row.name, ptDate, now));
    }
    // A row that is currently missing carries forward its old values — there is
    // nothing new to compare, and diffing stale-against-stale would be noise.
    if (row.missingRuns > 0) continue;

    for (const field of AC_TRACKED_FIELDS) {
      // A field that did not exist in the previous snapshot's schema is not a
      // change. Without this, the first refresh after adding a tracked field
      // diffs undefined -> value on every campaign and can flush the capped
      // change log with self-inflicted noise.
      if (!(field in prev)) continue;

      const from = prev[field] ?? null;
      const to = row[field] ?? null;

      // Never log a transition INTO unknown. A read that omits dynamicBidding
      // for one run would otherwise report every campaign changing, then
      // changing back. A real removal arrives as '', not null.
      if (field === 'placementsSummary' && to === null) continue;

      if (acSame(from, to)) continue;
      records.push(acChange(row, field, from, to, ptDate, now));
    }
  }

  return records;
}

function acChange(row, field, from, to, ptDate, at) {
  return {
    id: `${row.campaignId}|${field}|${ptDate}`,
    campaignId: row.campaignId,
    name: row.name,
    adProduct: row.adProduct,
    field, from, to, ptDate, at
  };
}

// Cents tolerance so 25 vs 25.0 isn't a change.
function acSame(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.round(a * 100) === Math.round(b * 100);
  }
  return a === b;
}

// The pages that send edits, as the change history records them.
const AC_EDIT_ORIGINS = ['weekly', 'biweekly', 'monthly', 'campaigns'];

// The permanent change history (lib/adhistory.js), when SQL_TABLES includes
// "adhistory". acEnsureHistory runs before the capped log is appended to, so
// the history copies in every record before any can be evicted;
// acRecordHistory adds the new records after. Neither ever throws: a history
// failure is logged and the edit or refresh goes ahead.
async function acEnsureHistory() {
  if (!adHistory.historyEnabled()) return;
  try {
    await adHistory.ensure(k => kv.get(k));
  } catch (err) {
    console.error('[AD HISTORY] setup failed:', err.message);
  }
}
async function acRecordHistory(records, origin) {
  // With the census in SQL the log write already put them in the table.
  if (!adHistory.historyEnabled() || census.censusInSql() || !records.length) return;
  try {
    await adHistory.ensure(k => kv.get(k));
    await adHistory.recordChanges(records, origin);
  } catch (err) {
    console.error('[AD HISTORY] changes not recorded:', err.message);
  }
}

// Capped, dedupe by stable id so a same-day re-run replaces rather than stacks.
// Eviction here is harmless: this log is human-facing only, never the substrate
// anything is reconstructed from. (The uncapped copy is campaign_changes.)
function acAppendChanges(existing, incoming) {
  if (!incoming.length) return existing;
  const incomingIds = new Set(incoming.map(r => r.id));
  const kept = existing.filter(r => r && !incomingIds.has(r.id));
  const combined = [...kept, ...incoming];
  return combined.slice(-AC_CONFIG.CHANGES_CAP);
}

// ─── ADVERTISING API CLIENT ──────────────────────────────────────────────────

function missingAdsCredentials() {
  return ['ADV_CLIENT_ID', 'ADV_CLIENT_SECRET', 'ADV_REFRESH_TOKEN', 'ADV_PROFILE_ID']
    .filter(k => !process.env[k]);
}

async function getAdsAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.ADV_REFRESH_TOKEN,
    client_id: process.env.ADV_CLIENT_ID,
    client_secret: process.env.ADV_CLIENT_SECRET
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(body));
  }
  return body.access_token;
}

function adsAuthHeaders(accessToken, extra = {}) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Amazon-Advertising-API-ClientId': process.env.ADV_CLIENT_ID,
    'Amazon-Advertising-API-Scope': process.env.ADV_PROFILE_ID,
    ...extra
  };
}

// Retry throttling and transient server errors only. A 4xx is a real answer and
// retrying it just wastes time.
async function withAdsRetry(fn, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fn();
      if (res && (res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Walks the candidate paths in order and records which one produced a value.
function acPick(obj, paths, hits, field) {
  for (const path of paths) {
    const v = acGetPath(obj, path);
    if (v === undefined || v === null || v === '') continue;
    // A nested budget object must not satisfy a scalar lookup.
    if (typeof v === 'object') continue;
    if (hits) {
      hits[field] = hits[field] || {};
      hits[field][path] = (hits[field][path] || 0) + 1;
    }
    return v;
  }
  return undefined;
}

function acGetPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function acStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function acNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// v3 gives YYYY-MM-DD, v2 gave YYYYMMDD. A silent mismatch sorts wrong.
function acDate(v) {
  const s = acStr(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function acTally(values) {
  const out = {};
  for (const v of values) {
    const k = v === null || v === undefined || v === '' ? '(none)' : String(v);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

// UTC instant → 'YYYY-MM-DD' in America/Los_Angeles. Vercel runs UTC; Amazon ad
// dates are marketplace-local. Phase 2's dated history keys off this, and the
// red-flag window is Pacific, so keeping the two in step matters.
function _ptDate(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export { acRunSync, acBrandFromPrefix, acWriteSbBudget, acWriteAmazonFields, acMapCampaign, acCampaignType, acDiffSnapshot, acMergePresence, acFieldCoverage,
         acCoverageLooksWrong, acPlacementCensus, acReadPlacements,
         acPlacementsSummary, acApplyBrandOverride, acKnownBrands,
         acValidateAmazonFields, acCollectItemErrors, acAdsWrite, acJoinDefaultBids,
         acWriteAdGroupBid, acEnsureHistory, acReadCensus,
         AC_ENDPOINTS, AC_CONFIG };
