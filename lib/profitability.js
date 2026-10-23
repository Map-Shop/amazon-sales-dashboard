// The profitability math behind the Profitability statement, its 12-month
// charts, and Brand & Product: dedup of Amazon's deferred/released records,
// routing of each breakdown to a statement line, fee mappings, ad-spend
// allocation, and the statement itself. Moved here from overview-upstash.js
// (and extractProfitabilityMetrics from brand-product.js) unchanged, so the
// pages receive finished numbers instead of every raw transaction.
// api/transactions.js gathers the inputs and serves the results
// (profit-period, profit-charts, profit-brand-product). Fee mappings are read
// per request, so a saved mapping applies on the next load.
//
// With SQL_TABLES including "transactionrows", each transaction's rows are
// derived once (deriveTransaction) and stored, the database runs the dedup,
// and the statement is built from the stored rows (inputs.derived) instead
// of from every raw transaction in the widened window. Same rows, same
// order, same numbers; lib/transactionrows.js keeps them current.
//
// Pure functions: no storage access here.

import { createHash } from 'crypto';

// Shift a YYYY-MM string by a number of months (positive forward,
// negative backward). Returns YYYY-MM. Used to widen the transactions
// fetch window so cross-month deferred parents are visible to dedup.
function _shiftMonth(yyyymm, deltaMonths) {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// How many months before the requested startMonth we widen the
// transactions fetch. NET 90 B2B is the realistic max deferral term —
// 6 months gives that plus a buffer so SHIPMENT_ID-based dedup can see
// a parent DEFERRED_RELEASED record even when the release-side
// companion lands many months later.
const V2024_LOOKBACK_MONTHS = 6;

// ─── INPUTS ─────────────────────────────────────────────────────────

// Everything the statement builder needs, from the bodies of the reads the
// page used to fetch: tx is get-range-v2024 over the requested months widened
// by V2024_LOOKBACK_MONTHS (so the dedup pass in _deriveV2024Rows can see
// DEFERRED_RELEASED parents of RELEASED records in the window); prod, spAd /
// sbAd, prodMap / brandMap / feeMap, and shipping are the products, ad spend,
// mappings, and shipping reads; lastSynced is the latest month's sync time.
// After dedup the derivation keeps only records posted inside the window.
// tx.derived, when present, stands in for tx.transactions: the stored rows
// of the window's surviving records (see _storedDerivation).
export function buildInputs({ tx, prod, spAd, sbAd, prodMap, brandMap, feeMap, shipping, lastSynced }) {
  const products = {};
  const brandToSkus = {};
  for (const p of (prod.products || [])) {
    if (!p?.sku) continue;
    products[p.sku] = p;
    const brand = (p.brand || '').trim();
    if (brand) {
      if (!brandToSkus[brand]) brandToSkus[brand] = [];
      brandToSkus[brand].push(p.sku);
    }
  }

  const productCampaignToSkus = {};
  for (const [campaign, data] of Object.entries(prodMap.mappings || {})) {
    if (Array.isArray(data?.skus) && data.skus.length > 0) {
      productCampaignToSkus[campaign] = data.skus.slice();
    }
  }
  const brandCampaignToBrand = {};
  for (const [campaign, brand] of Object.entries(brandMap.mappings || {})) {
    if (brand) brandCampaignToBrand[campaign] = brand;
  }

  const monthsInRange = Array.isArray(tx.months) ? tx.months : [];
  const latestSyncedMonth = monthsInRange.length > 0
    ? monthsInRange[monthsInRange.length - 1]
    : null;
  return {
    transactions: tx.transactions || [],
    derived: tx.derived || null,
    // CSV-uploaded rows for older years (e.g. 2024 backfill). Already
    // in the derived `_v2024BlankRow` shape — _deriveV2024Rows skips
    // them; the compute pipeline concatenates them with the derived
    // rows before _buildStatement runs. See handleUploadYearlyCsv in
    // api/transactions.js for the row shape and bucket-mapping rules.
    importedRows: Array.isArray(tx.importedRows) ? tx.importedRows : [],
    products,
    brandToSkus,
    spAdRows: spAd.rows || [],
    sbAdRows: sbAd.rows || [],
    shippingRows: shipping.rows || [],
    productCampaignToSkus,
    brandCampaignToBrand,
    feeMappings: feeMap.mappings || {},
    lastSynced,
    latestSyncedMonth,
    monthsInRange
  };
}

// ─── PERIOD STATEMENT ───────────────────────────────────────────────

// One period's statement bundle, the shape the page's Monthly and YTD
// views render (derive → ad-spend allocation → statement → metrics).
// `rows` is every derived row; profit-period doesn't send it.
export function computePeriod(inputs, startDate, endDate) {
  const feeMappings = inputs.feeMappings || {};
  const { rows: derivedRows, unmappedBreakdowns, dedupSkipped, transferSkipped, outOfWindowSkipped } =
    _rowsFor(inputs, startDate, endDate);
  // Concat CSV-imported rows that fall in the period. They're already
  // in the derived shape, so they bypass _deriveV2024Rows entirely.
  // _buildStatement and _buildSkuSales treat them identically to live
  // SP-API-derived rows.
  const importedInRange = (inputs.importedRows || []).filter(r => {
    const d = r && r.date;
    return d && d >= startDate && d <= endDate;
  });
  const rows = derivedRows.concat(importedInRange);

  const skuSales = _buildSkuSales(rows, inputs.products);
  const adSpend = _allocateAdSpend({
    spAdRows: inputs.spAdRows,
    sbAdRows: inputs.sbAdRows,
    products: inputs.products,
    brandToSkus: inputs.brandToSkus,
    productCampaignToSkus: inputs.productCampaignToSkus,
    brandCampaignToBrand: inputs.brandCampaignToBrand,
    skuSales,
    startDate,
    endDate
  });
  const shippingCosts = _sumShippingInRange(inputs.shippingRows, startDate, endDate);

  const { statement, missingSkus, unmappedFees } = _buildStatement(rows, inputs.products, adSpend, shippingCosts, feeMappings);
  const metrics = extractProfitabilityMetrics(statement);

  return {
    statement, missingSkus, unmappedFees, rows,
    lastSynced: inputs.lastSynced,
    latestSyncedMonth: inputs.latestSyncedMonth,
    adSpend, shippingCosts, metrics,
    // v2024-only diagnostics (rendered in the warning area below the
    // statement so a schema drift doesn't get swallowed silently)
    unmappedBreakdowns, dedupSkipped, transferSkipped, outOfWindowSkipped
  };
}

// ─── 12-MONTH CHARTS ────────────────────────────────────────────────

// One entry per month of the window, each { ...month, metrics, byBrand },
// as _loadV2024Charts built them.
export function computeChartMonths(inputs, months) {
  return months.map(m => {
    const { rows: derivedRows } = _rowsFor(inputs, m.startDate, m.endDate);
    // Same imported-row merge as computePeriod — scoped to
    // this month so the per-month bars include CSV-uploaded data.
    const importedInRange = (inputs.importedRows || []).filter(r => {
      const d = r && r.date;
      return d && d >= m.startDate && d <= m.endDate;
    });
    const rows = derivedRows.concat(importedInRange);
    const skuSales = _buildSkuSales(rows, inputs.products);
    const adSpend = _allocateAdSpend({
      spAdRows: inputs.spAdRows,
      sbAdRows: inputs.sbAdRows,
      products: inputs.products,
      brandToSkus: inputs.brandToSkus,
      productCampaignToSkus: inputs.productCampaignToSkus,
      brandCampaignToBrand: inputs.brandCampaignToBrand,
      skuSales,
      startDate: m.startDate,
      endDate: m.endDate
    });
    const shippingCosts = _sumShippingInRange(inputs.shippingRows, m.startDate, m.endDate);
    const { statement } = _buildStatement(
      rows, inputs.products, adSpend, shippingCosts, inputs.feeMappings || {}
    );
    const metrics = extractProfitabilityMetrics(statement);
    const byBrand = _computeBrandTotalsForMonth(rows, inputs, m.startDate, m.endDate);
    return { ...m, metrics, byBrand };
  });
}

// Per-brand income + profit for a single month. Walks rows once,
// attributes Order/Refund principal + fees + product costs to the
// brand whose SKU set contains the row's SKU, then layers ad spend
// on top: SB campaign → brand directly, SP campaign → brand if all
// mapped SKUs belong to the same brand (proportional split if not).
function _computeBrandTotalsForMonth(rows, inputs, startDate, endDate) {
  const brandToSkus = inputs.brandToSkus || {};
  const brands = Object.keys(brandToSkus);

  const skuToBrand = {};
  for (const [brand, skus] of Object.entries(brandToSkus)) {
    for (const sku of skus) skuToBrand[sku] = brand;
  }

  const totals = {};
  for (const b of brands) totals[b] = { income: 0, opex: 0, productCosts: 0, adSpend: 0 };

  // Walk rows
  for (const r of rows) {
    const brand = r.sku && skuToBrand[r.sku];
    if (!brand || !totals[brand]) continue;
    // Order/Refund: principal + other charges + promotions are income
    // (signs already preserved in row). FBA/transaction fees go to
    // opex (abs of negatives).
    if (r.type === 'Order' || r.type === 'Refund') {
      const income = (r.sale || 0) + (r.otherCharges || 0) + (r.promotions || 0);
      const fees   = Math.abs(r.fbaFees || 0) + Math.abs(r.transactionFees || 0);
      totals[brand].income += income;
      totals[brand].opex   += fees;
      // Units × unit cost, as the statement counts it: a shipped unit
      // adds its cost, a refunded unit (negative qty) takes it back.
      const prod = inputs.products[r.sku];
      const cost = prod ? (Number(prod.cost) || 0) : 0;
      totals[brand].productCosts += cost * (r.qty || 0);
    }
  }

  // Ad spend allocation (date-windowed). SB rows attribute by
  // campaign→brand; SP rows attribute by SKU when present, else by
  // campaign mapping, splitting across brands if a campaign spans
  // multiple brands' SKUs.
  const inWindow = (d) => d && d >= startDate && d <= endDate;

  for (const ad of (inputs.sbAdRows || [])) {
    if (!inWindow(ad.date)) continue;
    const b = inputs.brandCampaignToBrand?.[ad.campaign];
    if (b && totals[b]) totals[b].adSpend += Number(ad.cost) || 0;
  }

  for (const ad of (inputs.spAdRows || [])) {
    if (!inWindow(ad.date)) continue;
    const cost = Number(ad.cost) || 0;
    if (cost <= 0) continue;
    if (ad.sku && skuToBrand[ad.sku]) {
      totals[skuToBrand[ad.sku]].adSpend += cost;
      continue;
    }
    const skus = inputs.productCampaignToSkus?.[ad.campaign] || [];
    if (skus.length === 0) continue;
    const brandHits = {};
    for (const s of skus) {
      const b = skuToBrand[s];
      if (b) brandHits[b] = (brandHits[b] || 0) + 1;
    }
    const hitBrands = Object.keys(brandHits);
    if (hitBrands.length === 0) continue;
    const totalHits = hitBrands.reduce((sum, b) => sum + brandHits[b], 0);
    for (const b of hitBrands) {
      if (totals[b]) totals[b].adSpend += cost * (brandHits[b] / totalHits);
    }
  }

  const out = {};
  for (const b of brands) {
    const t = totals[b];
    out[b] = {
      income: t.income,
      profit: t.income - t.opex - t.productCosts - t.adSpend
    };
  }
  return out;
}

// ─── BRAND & PRODUCT ────────────────────────────────────────────────

// Computes a brand → products structure with FBM / FBA / Total
// metrics in the exact shape brand-product.js's renderBrandProductTable
// expects ({ brandName, products: [{ productName, skus, fbm, fba,
// total }], fbm, fba, total }). Same data source as the Profitability
// statement (v2024 transactions widened by 6-month dedup lookback, then
// derived per the same pipeline).
//
// Why per-SKU here vs the statement's FBM/FBA-only summary: the
// brand-product table needs costs/income/fees/ads attributed to
// individual SKUs so we can roll them up into product-level rows
// (FBA + FBM versions of the same product collapse to one row by
// product name, with separate FBM / FBA columns).
export function computeBrandProduct(inputs, startDate, endDate, brandFilter) {
  const { rows: derivedRows } = _rowsFor(inputs, startDate, endDate);
  // Merge in CSV-uploaded rows for the period so the Brand & Product
  // breakdown reflects 2024 backfilled data identically to live months.
  const importedInRange = (inputs.importedRows || []).filter(r => {
    const d = r && r.date;
    return d && d >= startDate && d <= endDate;
  });
  const rows = derivedRows.concat(importedInRange);

  // Build per-SKU lookups from the products catalog. Brands list
  // honors the brandFilter; "all" lets every brand through.
  const productByBrand = {}; // brand → { productName → { name, skus[] } }
  const skuToProduct   = {}; // sku → { name, brand, fulfillment, cost }
  for (const sku of Object.keys(inputs.products)) {
    const p = inputs.products[sku];
    const brand = (p.brand || '').trim();
    if (!brand) continue;
    if (brandFilter && brandFilter !== 'all' && brand !== brandFilter) continue;
    const fulfillment = _isFbaProduct(p) ? 'FBA' : 'FBM';
    const cost = Number(p.cost) || 0;
    skuToProduct[sku] = { name: p.name || '', brand, fulfillment, cost };
    if (!productByBrand[brand]) productByBrand[brand] = {};
    const pname = p.name || '(unnamed)';
    if (!productByBrand[brand][pname]) {
      productByBrand[brand][pname] = { name: pname, skus: [] };
    }
    productByBrand[brand][pname].skus.push({ sku, fulfillmentType: fulfillment, cost });
  }

  // Walk derived rows once → per-SKU income / opex / productCosts.
  // Income definition mirrors the statement's "FBM/FBA Sales + Returns
  // + Other": principal + otherCharges + promotions. Refunds are
  // already negative in the row's sale field so they net out
  // automatically. OpEx is FBA fees + transaction fees (abs of
  // negatives), matching extractProfitabilityMetrics' channel buckets.
  const skuTotals = {}; // sku → { income, opex, productCosts }
  for (const r of rows) {
    if (!r.sku || !skuToProduct[r.sku]) continue;
    if (r.type !== 'Order' && r.type !== 'Refund') continue;
    if (!skuTotals[r.sku]) skuTotals[r.sku] = { income: 0, opex: 0, productCosts: 0 };
    const income = (r.sale || 0) + (r.otherCharges || 0) + (r.promotions || 0);
    const fees   = Math.abs(r.fbaFees || 0) + Math.abs(r.transactionFees || 0);
    skuTotals[r.sku].income += income;
    skuTotals[r.sku].opex   += fees;
    // Units × unit cost, as the statement counts it: a shipped unit adds
    // its cost, a refunded unit (negative qty) takes it back.
    skuTotals[r.sku].productCosts += (skuToProduct[r.sku].cost || 0) * (r.qty || 0);
  }

  // FBM shipping costs: per-SKU when a SKU is on the row, else
  // attributed to the brand's FBM aggregate (handled below).
  const skuShipping = {};
  let unattributedShipping = 0;
  for (const s of (inputs.shippingRows || [])) {
    const d = s.shipDate || '';
    if (d && (d < startDate || d > endDate)) continue;
    const cost = Number(s.cost) || 0;
    if (cost <= 0) continue;
    if (s.sku && skuToProduct[s.sku]) {
      skuShipping[s.sku] = (skuShipping[s.sku] || 0) + cost;
    } else {
      unattributedShipping += cost;
    }
  }

  // Per-SKU SP ad spend. Direct sku attribution wins; otherwise the
  // campaign mapping splits cost across mapped SKUs proportional to
  // their period sales (falls back to even split if none of the
  // mapped SKUs sold in the period).
  const skuAdSpend = {};
  const inWin = (d) => d && d >= startDate && d <= endDate;
  for (const ad of (inputs.spAdRows || [])) {
    if (!inWin(ad.date)) continue;
    const cost = Number(ad.cost) || 0;
    if (cost <= 0) continue;
    if (ad.sku && skuToProduct[ad.sku]) {
      skuAdSpend[ad.sku] = (skuAdSpend[ad.sku] || 0) + cost;
      continue;
    }
    const mapped = inputs.productCampaignToSkus?.[ad.campaign] || [];
    const eligible = mapped.filter(s => skuToProduct[s]);
    if (eligible.length === 0) continue;
    // Split by period sales contribution; if no sales, even split.
    let totalSales = 0;
    for (const s of eligible) totalSales += (skuTotals[s]?.income || 0);
    if (totalSales > 0) {
      for (const s of eligible) {
        const share = (skuTotals[s]?.income || 0) / totalSales;
        if (share > 0) skuAdSpend[s] = (skuAdSpend[s] || 0) + cost * share;
      }
    } else {
      const portion = cost / eligible.length;
      for (const s of eligible) skuAdSpend[s] = (skuAdSpend[s] || 0) + portion;
    }
  }

  // Build the brand list. Empty metric stub used when a channel has
  // no SKUs (so renderBrandProductTable can still draw "--" cells).
  const emptyMetrics = () =>
    ({ income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 });

  const brandData = {};
  for (const [brand, productMap] of Object.entries(productByBrand)) {
    const brandObj = {
      brandName: brand,
      products: [],
      fbm: emptyMetrics(),
      fba: emptyMetrics(),
      total: emptyMetrics()
    };

    for (const product of Object.values(productMap)) {
      const productObj = {
        productName: product.name,
        skus: product.skus,
        fbm: emptyMetrics(),
        fba: emptyMetrics(),
        total: emptyMetrics()
      };

      for (const skuObj of product.skus) {
        const t = skuTotals[skuObj.sku] || { income: 0, opex: 0, productCosts: 0 };
        const ad = skuAdSpend[skuObj.sku] || 0;
        const ship = skuShipping[skuObj.sku] || 0;
        const ch = skuObj.fulfillmentType === 'FBA' ? 'fba' : 'fbm';
        productObj[ch].income       += t.income;
        productObj[ch].opex         += t.opex;
        productObj[ch].productCosts += t.productCosts;
        productObj[ch].adSpend      += ad;
        // Shipping is FBM only — Amazon-fulfilled shipping is wrapped
        // into FBA Fees on the SP-API side and already counted in opex.
        if (ch === 'fbm') productObj[ch].opex += ship;
      }

      for (const ch of ['fbm', 'fba']) {
        productObj[ch].profit = productObj[ch].income - productObj[ch].opex
                              - productObj[ch].productCosts - productObj[ch].adSpend;
        productObj[ch].margin = productObj[ch].income > 0
          ? (productObj[ch].profit / productObj[ch].income * 100) : 0;
      }
      productObj.total.income       = productObj.fbm.income + productObj.fba.income;
      productObj.total.opex         = productObj.fbm.opex   + productObj.fba.opex;
      productObj.total.productCosts = productObj.fbm.productCosts + productObj.fba.productCosts;
      productObj.total.adSpend      = productObj.fbm.adSpend + productObj.fba.adSpend;
      productObj.total.profit       = productObj.total.income - productObj.total.opex
                                    - productObj.total.productCosts - productObj.total.adSpend;
      productObj.total.margin       = productObj.total.income > 0
        ? (productObj.total.profit / productObj.total.income * 100) : 0;

      brandObj.products.push(productObj);

      for (const ch of ['fbm', 'fba', 'total']) {
        brandObj[ch].income       += productObj[ch].income;
        brandObj[ch].opex         += productObj[ch].opex;
        brandObj[ch].productCosts += productObj[ch].productCosts;
        brandObj[ch].adSpend      += productObj[ch].adSpend;
      }
    }

    // SB ad spend is brand-targeted; allocate by income ratio across
    // FBM / FBA. If a brand had zero income in the period the SB spend
    // attaches to FBM (the catch-all channel) so it doesn't disappear.
    let sbBrandSpend = 0;
    for (const ad of (inputs.sbAdRows || [])) {
      if (!inWin(ad.date)) continue;
      const mapped = inputs.brandCampaignToBrand?.[ad.campaign];
      if (mapped !== brand) continue;
      sbBrandSpend += Number(ad.cost) || 0;
    }
    if (sbBrandSpend > 0) {
      const totalIncome = brandObj.fbm.income + brandObj.fba.income;
      if (totalIncome > 0) {
        const fbmRatio = brandObj.fbm.income / totalIncome;
        brandObj.fbm.adSpend += sbBrandSpend * fbmRatio;
        brandObj.fba.adSpend += sbBrandSpend * (1 - fbmRatio);
      } else {
        brandObj.fbm.adSpend += sbBrandSpend;
      }
      brandObj.total.adSpend += sbBrandSpend;
    }

    // Brand-level profit/margin (final, after SB ad spend layered on).
    for (const ch of ['fbm', 'fba', 'total']) {
      brandObj[ch].profit = brandObj[ch].income - brandObj[ch].opex
                          - brandObj[ch].productCosts - brandObj[ch].adSpend;
      brandObj[ch].margin = brandObj[ch].income > 0
        ? (brandObj[ch].profit / brandObj[ch].income * 100) : 0;
    }

    brandData[brand] = brandObj;
  }

  // unattributedShipping is brand-agnostic — we don't show it in the
  // brand/product table. The Profitability statement does include it
  // (under FBM Shipping Costs), so the statement total is the source
  // of truth for that piece. Logged here so a non-zero value surfaces
  // in the console when reconciling.
  if (unattributedShipping > 0) {
    console.log(`[BP v2024] ${unattributedShipping.toFixed(2)} of shipping costs not attributable to a brand SKU; not shown in table.`);
  }

  return Object.values(brandData).sort((a, b) => a.brandName.localeCompare(b.brandName));
}

// ─── TRANSACTION DERIVE — v2024 ──────────────────────────────────────

// Route an Adjustment row to the right Expense line. Checks the four
// explicit sets first, then the "Other" special case, then falls back
// to the "has SKU?" rule. Used by _buildStatement on Adjustment-type
// rows emitted from _deriveV2024Rows.
function _adjustmentLine(r) {
  if (ADJUSTMENT_INVENTORY_TYPES.has(r.adjustmentType))   return 'FBA Inventory Adjustment';
  if (ADJUSTMENT_RETURNS_FEE_TYPES.has(r.adjustmentType)) return 'FBA Returns Fees';
  if (r.adjustmentType === 'Other')                       return 'Other Expenses';
  return r.sku ? 'FBA Inventory Adjustment' : 'Other Expenses';
}

function _v2024RidValue(t, name) {
  const found = (t.relatedIdentifiers || []).find(r => r?.relatedIdentifierName === name);
  return found?.relatedIdentifierValue || '';
}

function _v2024FindContext(item, contextType) {
  return (item?.contexts || []).find(c => c?.contextType === contextType) || null;
}

function _v2024NormalizeFulfillment(fn) {
  const s = String(fn || '').trim().toUpperCase();
  if (s === 'AFN') return 'FBA';
  if (s === 'MFN') return 'FBM';
  return '';
}

// Maps each breakdownType string Amazon emits in listTransactions to the
// statement-line bucket it should land in. Built empirically from the
// probe-v2024 month dump and validated against Sheets monthly totals.
//
// Handler kinds:
//   item       — Order/Refund per-item bucket. Adds amount to one of
//                {sale, otherCharges, fbaFees, transactionFees, promotions}
//                on the Order/Refund row being built.
//   serviceFee — emit a ServiceFee row with feeType = breakdownType,
//                feeAmount = the leaf's currencyAmount. _buildStatement
//                routes through SERVICE_FEE_LINE_MAP.
//   adjustment — emit an Adjustment row with adjustmentType =
//                breakdownType, adjustmentAmount = the leaf's amount.
//                _buildStatement routes through _adjustmentLine.
//   skip       — recognized but intentionally not added (taxes net to
//                zero for the seller; aggregator nodes like 'Sales' /
//                'Expenses' / 'AmazonFees' / 'Base' are handled by
//                recursing through them when they have no handler).
//
// Anything not in this map AND not an aggregator we recurse through is
// surfaced in unmappedBreakdowns so we don't silently lose money on a
// future Amazon schema change.
const V2024_LEAF_HANDLER = {
  // Item-level Order/Refund leaves
  'OurPricePrincipal':         { kind: 'item', bucket: 'sale' },
  // Plain 'Principal' is the item price on FBAToAmazonTitleTransfer
  // shipments (Amazon taking title to FBA units), in place of
  // OurPricePrincipal.
  'Principal':                 { kind: 'item', bucket: 'sale' },
  'Shipping':                  { kind: 'item', bucket: 'otherCharges' },
  'ShippingPrincipal':         { kind: 'item', bucket: 'otherCharges' },
  'Promo':                     { kind: 'item', bucket: 'promotions' },
  'PromoRebates':              { kind: 'item', bucket: 'promotions' },
  'ShippingDiscount':          { kind: 'item', bucket: 'promotions' },
  'Commission':                { kind: 'item', bucket: 'transactionFees' },
  'VariableClosingFee':        { kind: 'item', bucket: 'transactionFees' },
  'FixedClosingFee':           { kind: 'item', bucket: 'transactionFees' },
  'RefundCommission':          { kind: 'item', bucket: 'transactionFees' },
  'FBAPerUnitFulfillmentFee':  { kind: 'item', bucket: 'fbaFees' },
  'FBAPerOrderFulfillmentFee': { kind: 'item', bucket: 'fbaFees' },
  'FBAWeightBasedFee':         { kind: 'item', bucket: 'fbaFees' },

  // ServiceFee leaves (names match SERVICE_FEE_LINE_MAP keys so emitted
  // rows route through the existing _buildStatement logic)
  'FBADisposalFee':              { kind: 'serviceFee' },
  'CustomerReturnHRRUnitFee':    { kind: 'serviceFee' },
  'HRRNonApparelRollup':         { kind: 'serviceFee' },
  'FBAStorageFee':               { kind: 'serviceFee' },
  'FBALongTermStorageFee':       { kind: 'serviceFee' },
  'LongTermStorageFee':          { kind: 'serviceFee' },
  'StorageBillingFee':           { kind: 'serviceFee' },
  'FBAInboundTransportationFee': { kind: 'serviceFee' },
  'InboundTransportationFee':    { kind: 'serviceFee' },

  // Adjustment / Reimbursement leaves — names match the adjustment maps
  // _adjustmentLine uses.
  'COMPENSATED_CLAWBACK':                   { kind: 'adjustment' },
  'FBAInventoryReimbursement':              { kind: 'adjustment' },
  'FBAReversedReimbursement':               { kind: 'adjustment' },
  'WAREHOUSE_LOST':                         { kind: 'adjustment' },
  'MISSING_FROM_INBOUND':                   { kind: 'adjustment' },
  'MISSING_FROM_INBOUND_CLAWBACK':          { kind: 'adjustment' },
  'PostageBilling_Postage':                 { kind: 'adjustment' },
  'PostageBilling_FuelSurcharge':           { kind: 'adjustment' },
  'PostageBilling_Other':                   { kind: 'adjustment' },
  'PostageBilling_PostageAdjustment':       { kind: 'adjustment' },
  'CarrierPackagingCharge':                 { kind: 'adjustment' },
  'CustomerPackagingCharge':                { kind: 'adjustment' },
  'ReturnPostageBilling_Tracking':          { kind: 'adjustment' },
  'ReturnPostageBilling_Postage':           { kind: 'adjustment' },
  'ReturnPostageBilling_TransactionFee':    { kind: 'adjustment' },
  'ReturnPostageBilling_FuelSurcharge':     { kind: 'adjustment' },
  'ReturnPostageBilling_OversizeSurcharge': { kind: 'adjustment' },
  'ReturnPostageBilling_DeliveryAreaSurcharge': { kind: 'adjustment' },
  'ShippingChargeback':                     { kind: 'adjustment' },
  'ShippingHB':                             { kind: 'adjustment' },
  'ShippingServiceChargebacks':             { kind: 'adjustment' },
  'RestockingDeductionPrincipal':           { kind: 'adjustment' },
  'ReturnShippingDeductionPrincipal':       { kind: 'adjustment' },

  // Tax types — net-zero for the seller, explicitly skipped (don't
  // recurse, don't track as unmapped).
  'OurPriceTax':                          { kind: 'skip' },
  'ShippingTax':                          { kind: 'skip' },
  'MarketplaceFacilitatorTax-Principal':  { kind: 'skip' },
  'MarketplaceFacilitatorTax-Shipping':   { kind: 'skip' },
  'MarketplaceFacilitatorTax-Other':      { kind: 'skip' },
  'MarketplaceFacilitatorVAT-Principal':  { kind: 'skip' },
  'MarketplaceFacilitatorVAT-Shipping':   { kind: 'skip' },
  'MarketplaceFacilitatorVAT-Other':      { kind: 'skip' },

  // Fallback — Amazon's catch-all "Other" bucket maps to Other Expenses
  // (via _adjustmentLine).
  'Other': { kind: 'adjustment' }
};

// Walk a breakdown tree, calling `handle` for each node whose
// breakdownType is in V2024_LEAF_HANDLER OR in the user's feeMappings
// override. User mappings take a leaf with no built-in handler and treat
// it as kind='serviceFee' (so it emits a ServiceFee row that
// _buildStatement routes to the user-chosen line) — or kind='skip' if
// the user mapped to '_skip' (drop entirely). Recurses through
// unrecognized aggregator nodes to reach handlers underneath. Reports
// truly-unmapped leaves (no built-in handler, no user mapping, no
// children, non-zero amount) for the editable warning block through
// trace.unmapped(type, amount); trace.visit(type), when given, hears every
// type reached that has no built-in handler (the nodes fee mappings decide).
function _v2024WalkAndRoute(breakdowns, handle, trace, feeMappings) {
  for (const node of (breakdowns || [])) {
    const type = node?.breakdownType;
    let handler = type ? V2024_LEAF_HANDLER[type] : null;
    if (!handler && type && trace.visit) trace.visit(type);
    if (!handler && type && feeMappings && feeMappings[type]) {
      handler = feeMappings[type] === '_skip'
        ? { kind: 'skip' }
        : { kind: 'serviceFee' };
    }
    if (handler) {
      if (handler.kind !== 'skip') handle(type, node, handler);
      continue; // consume this node — don't descend further
    }
    // No handler. Recurse if there are children.
    if (Array.isArray(node?.breakdowns) && node.breakdowns.length > 0) {
      _v2024WalkAndRoute(node.breakdowns, handle, trace, feeMappings);
    } else if (type && trace) {
      const amt = node?.breakdownAmount?.currencyAmount || 0;
      if (Math.abs(amt) > 0.005) {
        trace.unmapped(type, amt);
      }
    }
  }
}

// Empty-shaped row template so every emitted row has every field the
// existing _buildStatement / CSV-export code expects.
function _v2024BlankRow(extra) {
  return {
    type: '', orderId: '', date: '', sku: '', qty: 0,
    fulfillment: '',
    sale: 0, otherCharges: 0, fbaFees: 0, transactionFees: 0, promotions: 0,
    feeType: '', feeAmount: 0,
    adjustmentType: '', adjustmentAmount: 0,
    _src: 'v2024', _transactionId: '', _transactionStatus: '',
    ...(extra || {})
  };
}

// Status priority for SHIPMENT_ID/REFUND_ID-keyed dedup. Lower = preferred.
// DEFERRED_RELEASED and DEFERRED both carry postedDate = invoice date,
// which is what we want for invoice-date allocation. RELEASED carries
// postedDate = release date, which we only want when there's no
// deferred sibling at all (genuinely non-deferred orders, where release
// date ≈ order date).
const _V2024_STATUS_PRIORITY = { DEFERRED_RELEASED: 0, DEFERRED: 1, RELEASED: 2 };

function _deriveV2024Rows(transactions, startDate, endDate, feeMappings) {
  const rows = [];
  const unmappedBreakdowns = {}; // breakdownType → cumulative amount
  let dedupSkipped = 0;
  let transferSkipped = 0;
  let outOfWindowSkipped = 0;

  // ─── PRE-PASS: SHIPMENT_ID/REFUND_ID-keyed dedup ──────────────────
  //
  // Amazon emits separate records for the deferred-side (postedDate =
  // invoice date) and the release-side (postedDate = release date) of
  // the same logical sale. The DEFERRED_TRANSACTION_ID linking that
  // would let us detect this pair-wise was unreliable in early-2025
  // data (Amazon's transition to the new "include deferred" report
  // format), so we instead group records by their stable identifiers:
  //   - Shipment: SHIPMENT_ID
  //   - Refund:   REFUND_ID
  // For each group keep one record, preferring DEFERRED_RELEASED >
  // DEFERRED > RELEASED. Lookback window in _fetchV2024Inputs ensures
  // cross-month parents are visible (NET-30/60/90 B2B all covered by
  // the 6-month default). Records without a stable identifier (rare)
  // pass through this pass untouched. lib/transactionrows.js runs this
  // same dedup in SQL for stored rows (KEPT_SQL); change the two together.
  const dedupGroups = new Map();
  const passThrough = [];
  for (const t of (transactions || [])) {
    const tType = t.transactionType;
    if (tType !== 'Shipment' && tType !== 'Refund') {
      passThrough.push(t);
      continue;
    }
    const sid = _v2024RidValue(t, 'SHIPMENT_ID');
    const rid = _v2024RidValue(t, 'REFUND_ID');
    const key = tType === 'Refund'
      ? (rid ? `Refund|${rid}` : null)
      : (sid ? `Shipment|${sid}` : null);
    if (!key) {
      passThrough.push(t);
      continue;
    }
    if (!dedupGroups.has(key)) dedupGroups.set(key, []);
    dedupGroups.get(key).push(t);
  }
  const dedupKept = [];
  for (const group of dedupGroups.values()) {
    if (group.length === 1) {
      dedupKept.push(group[0]);
      continue;
    }
    group.sort((a, b) => {
      const pa = _V2024_STATUS_PRIORITY[a.transactionStatus] ?? 99;
      const pb = _V2024_STATUS_PRIORITY[b.transactionStatus] ?? 99;
      if (pa !== pb) return pa - pb;
      return (a.postedDate || '').localeCompare(b.postedDate || '');
    });
    dedupKept.push(group[0]);
    dedupSkipped += group.length - 1;
  }
  const deduped = [...dedupKept, ...passThrough];

  // ─── MAIN PASS ────────────────────────────────────────────────────
  const trace = {
    unmapped: (type, amt) => { unmappedBreakdowns[type] = (unmappedBreakdowns[type] || 0) + amt; }
  };
  for (const t of deduped) {
    // Transfers are bank disbursements — not P&L.
    if (t.transactionType === 'Transfer') {
      transferSkipped++;
      continue;
    }

    // Drop records whose postedDate is outside the user-requested
    // window. The lookback months were fetched only so the dedup pass
    // above could see cross-month parents — they shouldn't render.
    const date = (t.postedDate || '').substring(0, 10);
    if (date && (date < startDate || date > endDate)) {
      outOfWindowSkipped++;
      continue;
    }

    for (const row of _deriveTransaction(t, feeMappings, trace)) rows.push(row);
  }

  return { rows, unmappedBreakdowns, dedupSkipped, transferSkipped, outOfWindowSkipped };
}

// The rows one transaction contributes: the main pass's work for a record
// that survived dedup and lies in the window. It depends only on the
// transaction and the fee mappings, so a transaction's rows can be derived
// once and stored (deriveTransaction, lib/transactionrows.js). Unmapped
// leaves go to trace.unmapped as they are met.
function _deriveTransaction(t, feeMappings, trace) {
  const rows = [];
  const date = (t.postedDate || '').substring(0, 10);
  const orderId = _v2024RidValue(t, 'ORDER_ID');
  const tType = t.transactionType || '';
  const tStatus = t.transactionStatus || '';

  if (tType === 'Shipment' || tType === 'Refund') {
    const isRefund = tType === 'Refund';
    for (const item of (t.items || [])) {
      const ctx = _v2024FindContext(item, 'ProductContext');
      const sku = _normalizeSku(ctx?.sku);
      const qty = (parseInt(ctx?.quantityShipped, 10) || 0) * (isRefund ? -1 : +1);
      const fulfillment = _v2024NormalizeFulfillment(ctx?.fulfillmentNetwork);

      const baseRow = _v2024BlankRow({
        type: isRefund ? 'Refund' : 'Order',
        orderId, date, sku, qty, fulfillment,
        _transactionId: t.transactionId || '',
        _transactionStatus: tStatus
      });

      _v2024WalkAndRoute(item.breakdowns, (type, node, handler) => {
        const amt = node?.breakdownAmount?.currencyAmount || 0;
        if (handler.kind === 'item') {
          baseRow[handler.bucket] += amt;
        } else if (handler.kind === 'serviceFee') {
          rows.push(_v2024BlankRow({
            type: 'ServiceFee',
            orderId, date,
            feeType: type, feeAmount: amt,
            _transactionId: t.transactionId || '',
            _transactionStatus: tStatus
          }));
        } else if (handler.kind === 'adjustment') {
          rows.push(_v2024BlankRow({
            type: 'Adjustment',
            orderId, date, sku, fulfillment,
            adjustmentType: type, adjustmentAmount: amt,
            _transactionId: t.transactionId || '',
            _transactionStatus: tStatus
          }));
        }
      }, trace, feeMappings);

      rows.push(baseRow);
    }
  } else if (tType === 'ServiceFee') {
    // Per-item walk; if the transaction has no items (rare), fall
    // back to the top-level breakdowns so nothing is lost.
    const sources = (t.items && t.items.length > 0) ? t.items : [{ breakdowns: t.breakdowns || [] }];
    for (const item of sources) {
      _v2024WalkAndRoute(item.breakdowns, (type, node, handler) => {
        const amt = node?.breakdownAmount?.currencyAmount || 0;
        if (handler.kind === 'serviceFee' || handler.kind === 'item') {
          rows.push(_v2024BlankRow({
            type: 'ServiceFee',
            orderId, date,
            feeType: type, feeAmount: amt,
            _transactionId: t.transactionId || '',
            _transactionStatus: tStatus
          }));
        } else if (handler.kind === 'adjustment') {
          rows.push(_v2024BlankRow({
            type: 'Adjustment',
            orderId, date,
            adjustmentType: type, adjustmentAmount: amt,
            _transactionId: t.transactionId || '',
            _transactionStatus: tStatus
          }));
        }
      }, trace, feeMappings);
    }
  } else if (tType === 'Adjustment' || tType === 'FBAInventoryReimbursement') {
    // Item-level breakdowns when present, otherwise top-level. The
    // FBAInventoryReimbursement transactions in the Feb sample had
    // empty item.breakdowns and the actual data at the top level.
    const hasItemBreakdowns = (t.items || []).some(
      i => Array.isArray(i.breakdowns) && i.breakdowns.length > 0
    );
    const sources = hasItemBreakdowns
      ? t.items
      : [{ contexts: [], breakdowns: t.breakdowns || [] }];
    for (const item of sources) {
      const ctx = _v2024FindContext(item, 'ProductContext');
      const itemSku = _normalizeSku(ctx?.sku);
      const itemFulfillment = _v2024NormalizeFulfillment(ctx?.fulfillmentNetwork);
      _v2024WalkAndRoute(item.breakdowns, (type, node, handler) => {
        const amt = node?.breakdownAmount?.currencyAmount || 0;
        if (handler.kind === 'adjustment' || handler.kind === 'serviceFee') {
          rows.push(_v2024BlankRow({
            type: 'Adjustment',
            orderId, date,
            sku: itemSku,
            fulfillment: itemFulfillment,
            adjustmentType: type, adjustmentAmount: amt,
            _transactionId: t.transactionId || '',
            _transactionStatus: tStatus
          }));
        }
      }, trace, feeMappings);
    }
  }
  // Unknown transactionType → silently skip (would surface in probe)
  return rows;
}

// ─── STORED ROWS ────────────────────────────────────────────────────
// With SQL_TABLES including "transactionrows", rows are derived once per
// transaction and stored (lib/transactionrows.js); requests read them back
// instead of deriving from every raw transaction in the widened window.

// One transaction's rows for storage, plus what the main pass needs besides
// them: its unmapped leaves as [type, amount] pairs in walk order (a request
// sums them in pass order, as the pass does) and the types it reached that
// have no built-in handler. Only fee mappings for those types can change its
// rows, so only those transactions are re-derived when the mappings change.
export function deriveTransaction(t, feeMappings) {
  const unmapped = [];
  const mappedTypes = new Set();
  const rows = _deriveTransaction(t, feeMappings || {}, {
    unmapped: (type, amt) => { unmapped.push([type, amt]); },
    visit: (type) => { mappedTypes.add(type); }
  });
  return { rows, unmapped, mappedTypes: [...mappedTypes] };
}

// How fee mappings steer the derivation, by type: a type mapped to '_skip'
// is dropped, any other mapping makes it a ServiceFee row. The statement
// line a 'fee' type lands on is applied per request (_buildStatement), so
// it isn't part of this. Keys sorted, so equal classes compare equal as JSON.
export function feeClasses(feeMappings) {
  const out = {};
  for (const type of Object.keys(feeMappings || {}).sort()) {
    const v = feeMappings[type];
    if (v) out[type] = v === '_skip' ? 'skip' : 'fee';
  }
  return out;
}

// Changes whenever the per-transaction derivation does (any of its
// functions or the handler table), so rows stored by older code are
// re-derived. Line endings are normalized so a Windows checkout and the
// deployed code agree.
export const DERIVE_FINGERPRINT = createHash('sha256')
  .update([
    _deriveTransaction, _v2024WalkAndRoute, _v2024BlankRow, _v2024RidValue,
    _v2024FindContext, _v2024NormalizeFulfillment, _normalizeSku
  ].map(String).join('\n').replace(/\r\n/g, '\n') + JSON.stringify(V2024_LEAF_HANDLER))
  .digest('hex').slice(0, 16);

// The derived rows for a window: from stored rows when the loader supplied
// them, otherwise derived here from the raw transactions.
function _rowsFor(inputs, startDate, endDate) {
  return inputs.derived
    ? _storedDerivation(inputs.derived, startDate, endDate)
    : _deriveV2024Rows(inputs.transactions, startDate, endDate, inputs.feeMappings || {});
}

// What _deriveV2024Rows returns, built from stored rows. The database ran
// the dedup over the same widened months and returned the surviving records
// that lie in the loaded window, in pass order (derived.rows, and
// derived.unmapped as { date, pairs } per record with unmapped leaves), so
// this only narrows to [startDate, endDate], one chart month say. Every row
// carries its transaction's date, so narrowing rows by date is the pass's
// window check. The skip counts are the loaded window's; only the period
// statement reports them, and its window is the loaded one.
function _storedDerivation(derived, startDate, endDate) {
  const inWindow = (d) => !d || (d >= startDate && d <= endDate);
  const unmappedBreakdowns = {};
  for (const { date, pairs } of derived.unmapped) {
    if (!inWindow(date)) continue;
    for (const [type, amt] of pairs) {
      unmappedBreakdowns[type] = (unmappedBreakdowns[type] || 0) + amt;
    }
  }
  return {
    rows: derived.rows.filter(r => inWindow(r.date)),
    unmappedBreakdowns,
    dedupSkipped: derived.dedupSkipped,
    transferSkipped: derived.transferSkipped,
    outOfWindowSkipped: derived.outOfWindowSkipped
  };
}

// ─── STATEMENT BUILDER ──────────────────────────────────────────────

const STATEMENT_INCOME_LINES = [
  'FBM Sales', 'FBM Returns', 'FBM Other',
  'FBA Sales', 'FBA Returns', 'FBA Other'
];

const STATEMENT_EXPENSE_LINES = [
  'FBM Product Costs', 'FBM Transaction Fees', 'FBM Shipping Costs', 'FBM Ad Spend',
  'FBA Product Costs', 'FBA Transaction Fees', 'FBA Fees',
  'FBA Returns Fees',
  'FBA Inbound Placement Fees', 'FBA Inbound Shipping Costs',
  'FBA Inventory Storage Fees', 'FBA Inventory Adjustment', 'FBA Ad Spend',
  'Other Expenses', 'Unallocated Ad Spend'
];

// ServiceFeeEvent FeeType → Expense line item.
// Anything not in this map falls into "Other Expenses" so nothing is
// silently lost; unmapped types surface in a warning block.
const SERVICE_FEE_LINE_MAP = {
  FBADisposalFee:               'FBA Returns Fees',
  CustomerReturnHRRUnitFee:     'FBA Returns Fees',
  FBAInboundConvenienceFee:     'FBA Inbound Placement Fees',
  FBAInboundTransportationFee:  'FBA Inbound Shipping Costs',
  FBAStorageFee:                'FBA Inventory Storage Fees',
  FBALongTermStorageFee:        'FBA Inventory Storage Fees',
  Subscription:                 'Other Expenses'
};

// AdjustmentEvent AdjustmentType → Expense line item. Unlike service
// fees, adjustments have a fallback that depends on whether the row
// carries a SKU: SKU-bearing adjustments land in FBA Inventory
// Adjustment, SKU-less ones in Other Expenses. See _adjustmentLine.
const ADJUSTMENT_INVENTORY_TYPES = new Set([
  'WAREHOUSE_LOST',
  'COMPENSATED_CLAWBACK',
  'MISSING_FROM_INBOUND',
  'MISSING_FROM_INBOUND_CLAWBACK'
]);

const ADJUSTMENT_RETURNS_FEE_TYPES = new Set([
  'PostageBilling_PostageAdjustment',
  'ReturnPostageBilling_Tracking',
  'ReturnPostageBilling_Postage',
  'ReturnPostageBilling_TransactionFee',
  'ReturnPostageBilling_FuelSurcharge',
  'ReturnPostageBilling_OversizeSurcharge',
  'ReturnPostageBilling_DeliveryAreaSurcharge'
]);

// Decode HTML-entity-encoded ampersands that SP-API sometimes returns
// in SellerSKU strings ("&amp;" → "&"). The Products catalog stores
// the real character, so normalizing the incoming value at the edge
// lets all downstream code do plain string lookups against the catalog.
function _normalizeSku(sku) {
  return String(sku || '').replace(/&amp;/g, '&');
}

// Sum the `cost` field of shipping rows whose shipDate falls inside
// [startDate, endDate]. Handles both API rows (sku-bearing, cost
// already allocated per SKU) and Sheets-backfilled rows (sku-less,
// cost is the shipment total) — both contribute to the period total.
function _sumShippingInRange(shippingRows, startDate, endDate) {
  let total = 0;
  for (const r of (shippingRows || [])) {
    const d = r.shipDate || '';
    if (d && (d < startDate || d > endDate)) continue;
    total += Number(r.cost) || 0;
  }
  return total;
}

// Is this SKU's fulfillment field one of the "Amazon/FBA" spellings?
// Seen in the wild: "Amazon", "AFN", "FBA", various casings/whitespace.
function _isFbaProduct(product) {
  const f = String(product?.fulfillment || '').trim().toLowerCase();
  return f === 'amazon' || f === 'afn' || f === 'fba';
}

// Walk the derived Order rows and sum Principal revenue per SKU, split
// by the channel each SKU is actually sold through. Used by the ad
// allocator to proportionally split campaign-level spend across a
// campaign's / brand's SKUs by actual sales contribution.
function _buildSkuSales(rows, products) {
  const skuSales = {}; // { sku: { fba, fbm } }
  for (const r of rows) {
    if (r.type !== 'Order') continue;
    if (!r.sku) continue;
    const prod = products[r.sku];
    if (!prod) continue;
    if (!skuSales[r.sku]) skuSales[r.sku] = { fba: 0, fbm: 0 };
    const amount = r.sale || 0;
    if (amount <= 0) continue; // ignore zero/negative principal on orders
    if (_isFbaProduct(prod)) skuSales[r.sku].fba += amount;
    else                      skuSales[r.sku].fbm += amount;
  }
  return skuSales;
}

// Allocate Sponsored Products + Sponsored Brands spend to FBA / FBM /
// Unallocated. Three paths:
//   1. SP row with sku (API-sourced)  → direct lookup: product.fulfillment
//   2. SP row without sku (historical) → campaign → SKUs via product
//                                         mapping; split by sales ratio
//                                         across that campaign's SKUs.
//   3. SB row (always sku-less)       → campaign → brand via brand
//                                         mapping; split by sales ratio
//                                         across that brand's SKUs (from
//                                         the Products catalog by brand).
// In all cases, anything we can't attribute lands in Unallocated so no
// spend disappears silently.
function _allocateAdSpend({ spAdRows, sbAdRows, products, brandToSkus, productCampaignToSkus, brandCampaignToBrand, skuSales, startDate, endDate }) {
  let fba = 0, fbm = 0, unallocated = 0;
  const unallocatedProductCampaigns = {};
  const unallocatedBrandCampaigns = {};

  const bumpUnallocatedProduct = (campaign, amount) => {
    const key = campaign || '(blank)';
    unallocatedProductCampaigns[key] = (unallocatedProductCampaigns[key] || 0) + amount;
  };
  const bumpUnallocatedBrand = (campaign, amount) => {
    const key = campaign || '(blank)';
    unallocatedBrandCampaigns[key] = (unallocatedBrandCampaigns[key] || 0) + amount;
  };

  const splitBySales = (skus, spend) => {
    let totalFba = 0, totalFbm = 0;
    for (const sku of skus) {
      const s = skuSales[sku];
      if (!s) continue;
      totalFba += s.fba;
      totalFbm += s.fbm;
    }
    const total = totalFba + totalFbm;
    if (total === 0) return null; // caller sends to unallocated
    return { fba: spend * (totalFba / total), fbm: spend * (totalFbm / total) };
  };

  // ── Sponsored Products ───────────────────────────────────────────
  for (const row of (spAdRows || [])) {
    const d = row.date || '';
    if (d && (d < startDate || d > endDate)) continue;
    const spend = Number(row.cost) || 0;
    if (spend <= 0) continue;

    if (row.sku) {
      // Direct SKU attribution — no mapping needed.
      const sku = _normalizeSku(row.sku);
      const prod = products[sku];
      if (!prod) {
        unallocated += spend;
        bumpUnallocatedProduct(row.campaign, spend);
        continue;
      }
      if (_isFbaProduct(prod)) fba += spend;
      else                      fbm += spend;
      continue;
    }

    // Historical SP (no sku) — fall back to campaign → SKUs mapping.
    const mapped = productCampaignToSkus[row.campaign] || [];
    if (mapped.length === 0) {
      unallocated += spend;
      bumpUnallocatedProduct(row.campaign, spend);
      continue;
    }
    const split = splitBySales(mapped, spend);
    if (!split) {
      unallocated += spend;
      bumpUnallocatedProduct(row.campaign, spend);
    } else {
      fba += split.fba;
      fbm += split.fbm;
    }
  }

  // ── Sponsored Brands ─────────────────────────────────────────────
  for (const row of (sbAdRows || [])) {
    const d = row.date || '';
    if (d && (d < startDate || d > endDate)) continue;
    const spend = Number(row.cost) || 0;
    if (spend <= 0) continue;

    const brand = brandCampaignToBrand[row.campaign];
    if (!brand) {
      unallocated += spend;
      bumpUnallocatedBrand(row.campaign, spend);
      continue;
    }
    const brandSkus = brandToSkus[brand] || [];
    if (brandSkus.length === 0) {
      unallocated += spend;
      bumpUnallocatedBrand(row.campaign, spend);
      continue;
    }
    const split = splitBySales(brandSkus, spend);
    if (!split) {
      unallocated += spend;
      bumpUnallocatedBrand(row.campaign, spend);
    } else {
      fba += split.fba;
      fbm += split.fbm;
    }
  }

  return { fba, fbm, unallocated, unallocatedProductCampaigns, unallocatedBrandCampaigns };
}

function _buildStatement(rows, products, adSpend = null, shippingCosts = 0, feeMappings = {}) {
  const statement = {
    income: Object.fromEntries(STATEMENT_INCOME_LINES.map(k => [k, { debit: 0, credit: 0 }])),
    expenses: Object.fromEntries(STATEMENT_EXPENSE_LINES.map(k => [k, { debit: 0, credit: 0 }]))
  };

  // Ad spend is computed outside this function (it needs both the ad
  // data and the sku-sales derived here-ish). If provided, drop it
  // straight onto the debit side of the three Ad Spend lines; ad spend
  // is always money out, so signs are simple.
  if (adSpend) {
    if (adSpend.fba > 0)          statement.expenses['FBA Ad Spend'].debit += adSpend.fba;
    if (adSpend.fbm > 0)          statement.expenses['FBM Ad Spend'].debit += adSpend.fbm;
    if (adSpend.unallocated > 0)  statement.expenses['Unallocated Ad Spend'].debit += adSpend.unallocated;
  }

  // Shipping costs are always FBM — seller-fulfilled shipments have
  // costs we paid out-of-pocket. FBA shipping is wrapped into Amazon's
  // FBA Fees on the SP-API side and doesn't flow through here.
  if (shippingCosts > 0) {
    statement.expenses['FBM Shipping Costs'].debit += shippingCosts;
  }

  const missing = new Map(); // sku → Set of orderIds using it

  const add = (line, section, amount) => {
    if (amount > 0) statement[section][line].credit += amount;
    else if (amount < 0) statement[section][line].debit += Math.abs(amount);
  };

  const unmappedServiceFeeTypes = new Map(); // feeType → running total

  for (const r of rows) {
    // ServiceFee rows route by FeeType → statement line. User mappings
    // (from /api/mappings?type=fee) win over the hardcoded
    // SERVICE_FEE_LINE_MAP so the user can fix categorization in-app
    // without a code change. '_skip' drops the amount entirely (used
    // for fees the user explicitly wants excluded).
    if (r.type === 'ServiceFee') {
      const userLine = feeMappings && feeMappings[r.feeType];
      if (userLine === '_skip') continue;
      const line = userLine || SERVICE_FEE_LINE_MAP[r.feeType];
      if (!line) {
        // Unknown FeeType and no user mapping: bucket into Other
        // Expenses so the money isn't lost, but keep a running tally
        // for the editable warning block.
        add('Other Expenses', 'expenses', r.feeAmount);
        unmappedServiceFeeTypes.set(
          r.feeType || '(empty)',
          (unmappedServiceFeeTypes.get(r.feeType || '(empty)') || 0) + r.feeAmount
        );
      } else {
        // User-mapped destinations can be income or expense lines —
        // pick the right section so add() doesn't undefined-crash.
        const section = STATEMENT_INCOME_LINES.includes(line) ? 'income' : 'expenses';
        add(line, section, r.feeAmount);
      }
      continue;
    }

    // Adjustment rows route by AdjustmentType via _adjustmentLine,
    // with a "has SKU?" fallback for types not in the explicit maps.
    // No Products-catalog lookup needed.
    if (r.type === 'Adjustment') {
      add(_adjustmentLine(r), 'expenses', r.adjustmentAmount);
      continue;
    }

    // Chargeback / GuaranteeClaim / Retrocharge rows dump their entire
    // net amount into Other Expenses. Per-item detail is preserved in
    // the CSV but collapses here since these event types are rare
    // enough not to warrant a dedicated statement line.
    if (r.type === 'Chargeback' || r.type === 'GuaranteeClaim' || r.type === 'Retrocharge') {
      const net = (r.sale || 0) + (r.otherCharges || 0) +
                  (r.fbaFees || 0) + (r.transactionFees || 0) +
                  (r.promotions || 0);
      add('Other Expenses', 'expenses', net);
      continue;
    }

    const prod = products[r.sku];

    // v2024 rows arrive with `fulfillment` already set from the API's
    // ProductContext (AFN→FBA, MFN→FBM). Trust that hint when present;
    // it's authoritative per-transaction and avoids the catalog-shift
    // bug where a SKU's current fulfillment differs from its at-order
    // fulfillment. Fall back to catalog lookup for v0 rows.
    let prefix;
    if (r.fulfillment === 'FBA' || r.fulfillment === 'FBM') {
      prefix = r.fulfillment;
      // Still flag missing-from-catalog so product cost (below) can
      // surface the gap. Don't `continue` — the API knows fulfillment.
      if (!prod) {
        if (!missing.has(r.sku)) missing.set(r.sku, new Set());
        missing.get(r.sku).add(r.orderId);
      }
    } else {
      if (!prod) {
        if (!missing.has(r.sku)) missing.set(r.sku, new Set());
        missing.get(r.sku).add(r.orderId);
        continue; // Can't categorize without knowing fulfillment.
      }
      // Accept common spellings of the fulfillment value rather than
      // relying on one exact string. Seen in the wild: "Amazon", "AFN",
      // "FBA", sometimes lower/title-cased, sometimes with whitespace.
      const f = String(prod.fulfillment || '').trim().toLowerCase();
      const isFba = f === 'amazon' || f === 'afn' || f === 'fba';
      prefix = isFba ? 'FBA' : 'FBM';
    }

    // Sale routing depends on event type: Orders go to Sales,
    // Refunds go to Returns. Everything else routes the same way
    // regardless of type — positives credit, negatives debit.
    const saleLine = r.type === 'Refund' ? 'Returns' : 'Sales';
    add(`${prefix} ${saleLine}`, 'income', r.sale);
    add(`${prefix} Other`, 'income', r.otherCharges);
    add(`${prefix} Other`, 'income', r.promotions);
    add(`${prefix} Transaction Fees`, 'expenses', r.transactionFees);
    add('FBA Fees', 'expenses', r.fbaFees);

    // Product cost = quantity × unit cost. Positive qty on a shipment
    // is a sold unit — debit to the channel's Product Costs line. If
    // the SKU isn't in the catalog (v2024 path may pass through with a
    // fulfillment hint but no catalog match), skip product cost.
    if (prod) {
      const unitCost = parseFloat(prod.cost) || 0;
      if (unitCost > 0 && r.qty !== 0) {
        const cost = unitCost * r.qty;
        if (cost > 0) statement.expenses[`${prefix} Product Costs`].debit += cost;
        else if (cost < 0) statement.expenses[`${prefix} Product Costs`].credit += Math.abs(cost);
      }
    }
  }

  const missingSkus = [...missing.entries()].map(([sku, orders]) => ({
    sku,
    orderCount: orders.size,
    sampleOrderIds: [...orders].slice(0, 3)
  }));
  const unmappedFees = [...unmappedServiceFeeTypes.entries()]
    .map(([feeType, total]) => ({ feeType, total }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return { statement, missingSkus, unmappedFees };
}

// Extract profitability metrics from a financial statement
function extractProfitabilityMetrics(statement) {
  // Calculate FBM totals
  const fbmIncome = (statement.income['FBM Sales']?.credit || 0) - (statement.income['FBM Sales']?.debit || 0) +
                    (statement.income['FBM Returns']?.credit || 0) - (statement.income['FBM Returns']?.debit || 0) +
                    (statement.income['FBM Other']?.credit || 0) - (statement.income['FBM Other']?.debit || 0);
  
  const fbmOpEx = (statement.expenses['FBM Shipping Costs']?.debit || 0) - (statement.expenses['FBM Shipping Costs']?.credit || 0) +
                  (statement.expenses['FBM Transaction Fees']?.debit || 0) - (statement.expenses['FBM Transaction Fees']?.credit || 0);
  
  const fbmProductCosts = (statement.expenses['FBM Product Costs']?.debit || 0) - (statement.expenses['FBM Product Costs']?.credit || 0);
  const fbmAdSpend = (statement.expenses['FBM Ad Spend']?.debit || 0) - (statement.expenses['FBM Ad Spend']?.credit || 0);
  const fbmProfit = fbmIncome - fbmOpEx - fbmProductCosts - fbmAdSpend;
  const fbmMargin = fbmIncome > 0 ? (fbmProfit / fbmIncome * 100) : 0;
  
  // Calculate FBA totals
  const fbaIncome = (statement.income['FBA Sales']?.credit || 0) - (statement.income['FBA Sales']?.debit || 0) +
                    (statement.income['FBA Returns']?.credit || 0) - (statement.income['FBA Returns']?.debit || 0) +
                    (statement.income['FBA Other']?.credit || 0) - (statement.income['FBA Other']?.debit || 0);
  
  const fbaOpEx = (statement.expenses['FBA Fees']?.debit || 0) - (statement.expenses['FBA Fees']?.credit || 0);
  
  const fbaProductCosts = (statement.expenses['FBA Product Costs']?.debit || 0) - (statement.expenses['FBA Product Costs']?.credit || 0);
  const fbaAdSpend = (statement.expenses['FBA Ad Spend']?.debit || 0) - (statement.expenses['FBA Ad Spend']?.credit || 0);
  const fbaProfit = fbaIncome - fbaOpEx - fbaProductCosts - fbaAdSpend;
  const fbaMargin = fbaIncome > 0 ? (fbaProfit / fbaIncome * 100) : 0;
  
  // Calculate Total
  const totalIncome = fbmIncome + fbaIncome;
  const totalOpEx = fbmOpEx + fbaOpEx;
  const totalProductCosts = fbmProductCosts + fbaProductCosts;
  const totalAdSpend = fbmAdSpend + fbaAdSpend;
  const totalProfit = fbmProfit + fbaProfit;
  const totalMargin = totalIncome > 0 ? (totalProfit / totalIncome * 100) : 0;
  
  return {
    fbm: {
      income: fbmIncome,
      opex: fbmOpEx,
      productCosts: fbmProductCosts,
      adSpend: fbmAdSpend,
      profit: fbmProfit,
      margin: fbmMargin
    },
    fba: {
      income: fbaIncome,
      opex: fbaOpEx,
      productCosts: fbaProductCosts,
      adSpend: fbaAdSpend,
      profit: fbaProfit,
      margin: fbaMargin
    },
    total: {
      income: totalIncome,
      opex: totalOpEx,
      productCosts: totalProductCosts,
      adSpend: totalAdSpend,
      profit: totalProfit,
      margin: totalMargin
    }
  };
}

export { _shiftMonth as shiftMonth, V2024_LOOKBACK_MONTHS };
