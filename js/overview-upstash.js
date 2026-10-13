    // Profitability Overview — backed by SP-API Finances v2024-06-19
    // listTransactions.
    //
    // Storage model: /api/transactions?action=sync-v2024 stores the raw
    // listTransactions response under transactions:v2024:raw:YYYY-MM. The
    // dedup rule (skip RELEASED transactions that carry a
    // DEFERRED_TRANSACTION_ID), the breakdown-leaf → statement-line routing
    // (V2024_LEAF_HANDLER), and the FBA/FBM split (from each item's
    // ProductContext.fulfillmentNetwork: AFN→FBA, MFN→FBM) all happen on
    // the client in _deriveV2024Rows. Iterating on the routing table
    // requires no re-sync — just reload the page.
    //
    // Two tabs in the UI:
    //   showMonthlyV2024() — Monthly Profitability for a single (year, month)
    //                        with current + prev-month + YoY comparisons
    //   showYTDV2024()     — Year-to-Date Profitability for a single year
    //                        with YoY comparisons
    //
    // Statement assembly path is shared: _computeV2024Period →
    // _fetchV2024Inputs (transactions + products + ad spend + shipping +
    // mappings) → _deriveV2024Rows → _allocateAdSpend → _buildStatement →
    // extractProfitabilityMetrics → renderFinancialStatement (in
    // brand-product.js). The Sheets-backed and v0-Upstash variants were
    // retired after v2024 validated against Sheets monthly totals; ad
    // spend and shipping costs still read from their separate KV stores.

    // ─── SHARED OVERVIEW STATE ──────────────────────────────────────────
    //
    // Per-page-session report cache shared across the Overview tabs. Keyed
    // by "{view}|{year}|{month?}". Stores final rendered innerHTML so
    // switching among tabs / back to a previously-viewed range is instant.
    // Cleared on page refresh. Attached to window so it survives module
    // boundaries; the `||` keeps it idempotent if anything else also
    // initializes it.
    window._overviewReportCache = window._overviewReportCache || new Map();

    // YoY comparison helper. Both paths (Monthly and YTD) feed metrics into
    // this; renderFinancialStatement reads `comparisons.<chan>.<line>.yoy|mom`
    // to draw the small percentage arrows next to each profitability line.
    function calculateComparisons(current, previous, yoy) {
      const calcChange = (curr, prev) => {
        if (!prev || prev === 0) return null;
        return ((curr - prev) / Math.abs(prev)) * 100;
      };
      return {
        fbm: {
          income: { yoy: calcChange(current.fbm.income, yoy.fbm.income), mom: calcChange(current.fbm.income, previous.fbm.income) },
          opex: { yoy: calcChange(current.fbm.opex, yoy.fbm.opex), mom: calcChange(current.fbm.opex, previous.fbm.opex) },
          productCosts: { yoy: calcChange(current.fbm.productCosts, yoy.fbm.productCosts), mom: calcChange(current.fbm.productCosts, previous.fbm.productCosts) },
          adSpend: { yoy: calcChange(current.fbm.adSpend, yoy.fbm.adSpend), mom: calcChange(current.fbm.adSpend, previous.fbm.adSpend) },
          profit: { yoy: calcChange(current.fbm.profit, yoy.fbm.profit), mom: calcChange(current.fbm.profit, previous.fbm.profit) },
          margin: { yoy: calcChange(current.fbm.margin, yoy.fbm.margin), mom: calcChange(current.fbm.margin, previous.fbm.margin) }
        },
        fba: {
          income: { yoy: calcChange(current.fba.income, yoy.fba.income), mom: calcChange(current.fba.income, yoy.fba.income) },
          opex: { yoy: calcChange(current.fba.opex, yoy.fba.opex), mom: calcChange(current.fba.opex, previous.fba.opex) },
          productCosts: { yoy: calcChange(current.fba.productCosts, yoy.fba.productCosts), mom: calcChange(current.fba.productCosts, previous.fba.productCosts) },
          adSpend: { yoy: calcChange(current.fba.adSpend, yoy.fba.adSpend), mom: calcChange(current.fba.adSpend, previous.fba.adSpend) },
          profit: { yoy: calcChange(current.fba.profit, yoy.fba.profit), mom: calcChange(current.fba.profit, previous.fba.profit) },
          margin: { yoy: calcChange(current.fba.margin, yoy.fba.margin), mom: calcChange(current.fba.margin, previous.fba.margin) }
        },
        total: {
          income: { yoy: calcChange(current.total.income, yoy.total.income), mom: calcChange(current.total.income, previous.total.income) },
          opex: { yoy: calcChange(current.total.opex, yoy.total.opex), mom: calcChange(current.total.opex, previous.total.opex) },
          productCosts: { yoy: calcChange(current.total.productCosts, yoy.total.productCosts), mom: calcChange(current.total.productCosts, previous.total.productCosts) },
          adSpend: { yoy: calcChange(current.total.adSpend, yoy.total.adSpend), mom: calcChange(current.total.adSpend, previous.total.adSpend) },
          profit: { yoy: calcChange(current.total.profit, yoy.total.profit), mom: calcChange(current.total.profit, previous.total.profit) },
          margin: { yoy: calcChange(current.total.margin, yoy.total.margin), mom: calcChange(current.total.margin, previous.total.margin) }
        }
      };
    }

    // YTD only computes YoY (no MoM). Same structure as calculateComparisons
    // but each line just has the .yoy field.
    function calculateYTDComparisons(current, previous) {
      const calcChange = (curr, prev) => {
        if (!prev || prev === 0) return null;
        return ((curr - prev) / Math.abs(prev)) * 100;
      };
      return {
        fbm: {
          income: { yoy: calcChange(current.fbm.income, previous.fbm.income) },
          opex: { yoy: calcChange(current.fbm.opex, previous.fbm.opex) },
          productCosts: { yoy: calcChange(current.fbm.productCosts, previous.fbm.productCosts) },
          adSpend: { yoy: calcChange(current.fbm.adSpend, previous.fbm.adSpend) },
          profit: { yoy: calcChange(current.fbm.profit, previous.fbm.profit) },
          margin: { yoy: calcChange(current.fbm.margin, previous.fbm.margin) }
        },
        fba: {
          income: { yoy: calcChange(current.fba.income, previous.fba.income) },
          opex: { yoy: calcChange(current.fba.opex, previous.fba.opex) },
          productCosts: { yoy: calcChange(current.fba.productCosts, previous.fba.productCosts) },
          adSpend: { yoy: calcChange(current.fba.adSpend, previous.fba.adSpend) },
          profit: { yoy: calcChange(current.fba.profit, previous.fba.profit) },
          margin: { yoy: calcChange(current.fba.margin, previous.fba.margin) }
        },
        total: {
          income: { yoy: calcChange(current.total.income, previous.total.income) },
          opex: { yoy: calcChange(current.total.opex, previous.total.opex) },
          productCosts: { yoy: calcChange(current.total.productCosts, previous.total.productCosts) },
          adSpend: { yoy: calcChange(current.total.adSpend, previous.total.adSpend) },
          profit: { yoy: calcChange(current.total.profit, previous.total.profit) },
          margin: { yoy: calcChange(current.total.margin, previous.total.margin) }
        }
      };
    }

    // ─── VIEW SWITCHING ─────────────────────────────────────────────────
    //
    // First-view auto-load flags: when the user clicks into a tab for the
    // first time in a page session, we default the dropdowns and run a
    // report so they're not staring at an empty placeholder. On subsequent
    // visits the dropdowns (and rendered content) stay as the user left
    // them.
    let _monthlyV2024AutoLoaded = false;
    let _ytdV2024AutoLoaded = false;

    // Same months-with-data pattern as _upstashMonthsSet but populated from
    // the v2024 sync's separate index (transactions:v2024:index). Used by
    // _refreshV2024NavButtons to disable Prev/Next when the target month
    // has no synced v2024 data yet.
    let _v2024MonthsSet = null;
    let _v2024MonthsPromise = null;
    // Captured from get-months-v2024 alongside the months index. ISO
    // string (e.g. "2026-03-31T12:34:56Z") of the absolute latest
    // postedDate across all synced months — drives the "Most Recent
    // Transaction Data" label at the top of the Overview page.
    let _v2024LatestPostedDate = null;

    // Same pattern for the Sponsored-Products and Sponsored-Brands ad
    // spend months index — used to populate the "Most Recent Ad Spend
    // Data" label at the top of the page. Lazy-loaded.
    let _adSpendMonthsSet = null;
    let _adSpendMonthsPromise = null;
    // Captured from /api/adspend?action=get-months alongside the
    // sp/sb indexes. YYYY-MM-DD string of the latest daily date in
    // synced ad-spend rows.
    let _adSpendLatestPostedDate = null;


    function _hideAllOverviewViews() {
      ['monthly-v2024-view', 'ytd-v2024-view', 'charts-v2024-view', 'brandproduct-v2024-view']
        .forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
      document.querySelectorAll('#overview-page .page-header .tabs .tab')
        .forEach(t => t.classList.remove('active'));
    }


    function showMonthlyV2024() {
      _hideAllOverviewViews();
      document.getElementById('monthly-v2024-view').style.display = 'block';
      document.getElementById('monthly-v2024-tab').classList.add('active');
      _initMonthlyV2024Dropdowns();
      if (!_monthlyV2024AutoLoaded && accessToken) {
        _monthlyV2024AutoLoaded = true;
        setMonthlyV2024Date('lastMonth');
      }
      _ensureV2024Months().then(() => {
        _populateV2024YearDropdowns();
        _refreshV2024NavButtons();
        _updateOverviewDataLabels();
      });
      _ensureAdSpendMonths().then(_updateOverviewDataLabels);
      _refreshV2024NavButtons();
    }

    function _initMonthlyV2024Dropdowns() {
      // Year dropdown is populated by _populateV2024YearDropdowns once
      // _ensureV2024Months resolves so it only lists years that actually
      // have synced data. Until then it stays empty;
      // setMonthlyV2024Date('lastMonth') still works because
      // _setSelectByValue inserts the option if missing.
      const monthSel = document.getElementById('monthly-v2024-month-select');
      if (monthSel && !monthSel.value) {
        const now = new Date();
        const lastMonth = now.getMonth() - 1;
        monthSel.value = lastMonth >= 0 ? lastMonth : 11;
      }
    }

    // Replaces the year-dropdown options on both Monthly and YTD v2024 tabs
    // with the distinct years present in _v2024MonthsSet (descending —
    // newest first). Preserves the current selection if still valid;
    // otherwise picks the most recent year. Called from showMonthlyV2024 /
    // showYTDV2024 once the months index resolves.
    function _populateV2024YearDropdowns() {
      if (!_v2024MonthsSet || _v2024MonthsSet.size === 0) return;
      const years = [...new Set([..._v2024MonthsSet].map(ym => ym.split('-')[0]))]
        .sort((a, b) => b.localeCompare(a));
      for (const selectId of ['monthly-v2024-year-select', 'ytd-v2024-year-select']) {
        const sel = document.getElementById(selectId);
        if (!sel) continue;
        const cur = sel.value;
        sel.innerHTML = '';
        for (const y of years) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y;
          sel.appendChild(o);
        }
        if (years.includes(cur))      sel.value = cur;
        else if (years.length > 0)    sel.value = years[0];
      }
    }

    // Same semantics as setMonthlyUpstashDate.
    function setMonthlyV2024Date(preset) {
      const today = new Date();
      const monthSel = document.getElementById('monthly-v2024-month-select');
      const yearSel  = document.getElementById('monthly-v2024-year-select');
      const curMonth = parseInt(monthSel.value, 10);
      const curYear  = parseInt(yearSel.value, 10);

      if (preset === 'lastMonth') {
        const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValue(yearSel, d.getFullYear());
      } else if (preset === 'thisMonth') {
        monthSel.value = today.getMonth();
        _setSelectByValue(yearSel, today.getFullYear());
      } else if (preset === 'prevMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth - 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValue(yearSel, d.getFullYear());
      } else if (preset === 'nextMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth + 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValue(yearSel, d.getFullYear());
      }

      _refreshV2024NavButtons();
      generateMonthlyV2024Report();
    }

    // Lazy-load the v2024 months-with-data index. Mirrors _ensureUpstashMonths
    // but hits get-months-v2024.
    async function _ensureV2024Months() {
      if (_v2024MonthsSet) return _v2024MonthsSet;
      if (_v2024MonthsPromise) return _v2024MonthsPromise;
      if (!accessToken) return null;
      _v2024MonthsPromise = (async () => {
        try {
          const res = await fetch('/api/transactions?action=get-months-v2024', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!res.ok) return null;
          const data = await res.json();
          _v2024MonthsSet = new Set(Array.isArray(data.months) ? data.months : []);
          // latestPostedDate is the absolute latest postedDate across
          // all synced months, computed server-side. May be null on
          // first call against pre-existing data; the server lazily
          // backfills the most recent month so subsequent calls return
          // a value.
          _v2024LatestPostedDate = data.latestPostedDate || null;
          return _v2024MonthsSet;
        } catch {
          return null;
        } finally {
          _v2024MonthsPromise = null;
        }
      })();
      return _v2024MonthsPromise;
    }

    // Lazy-loads the union of synced Sponsored-Products and Sponsored-Brands
    // ad-spend month buckets. Used to populate the page-level "Most Recent
    // Ad Spend Data" label. The /api/adspend?action=get-months endpoint
    // returns { sp: [...], sb: [...], latestPostedDate } in a single call.
    async function _ensureAdSpendMonths() {
      if (_adSpendMonthsSet) return _adSpendMonthsSet;
      if (_adSpendMonthsPromise) return _adSpendMonthsPromise;
      if (!accessToken) return null;
      _adSpendMonthsPromise = (async () => {
        try {
          const res = await fetch('/api/adspend?action=get-months', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!res.ok) return null;
          const data = await res.json();
          const spMonths = Array.isArray(data.sp) ? data.sp : [];
          const sbMonths = Array.isArray(data.sb) ? data.sb : [];
          _adSpendMonthsSet = new Set([...spMonths, ...sbMonths]);
          _adSpendLatestPostedDate = data.latestPostedDate || null;
          return _adSpendMonthsSet;
        } catch {
          return null;
        } finally {
          _adSpendMonthsPromise = null;
        }
      })();
      return _adSpendMonthsPromise;
    }

    // Updates the page-level "Most Recent Transaction Data" / "Most Recent
    // Ad Spend Data" / "Next Cron Job" labels at the top of the
    // Profitability Overview. Uses the absolute latest postedDate (across
    // all synced data, not just the currently-viewed range) formatted as
    // M/D/YY — e.g. "3/31/26".
    function _updateOverviewDataLabels() {
      const txEl = document.getElementById('overview-latest-transaction');
      const adEl = document.getElementById('overview-latest-adspend');
      const cronEl = document.getElementById('overview-next-cron');
      if (txEl) {
        txEl.textContent = _v2024LatestPostedDate
          ? _formatMDY(_v2024LatestPostedDate) : '—';
      }
      if (adEl) {
        adEl.textContent = _adSpendLatestPostedDate
          ? _formatMDY(_adSpendLatestPostedDate) : '—';
      }
      if (cronEl) {
        cronEl.textContent = _formatMDY(_nextCronDateISO());
      }
    }

    // Returns the next date (as YYYY-MM-DD) on which the v2024
    // transactions + ad spend cron will run. The Vercel cron is
    // configured for the 3rd of every month (UTC) — that gives Amazon
    // a couple of days after month-end to settle deferred transactions
    // before we pull. If today is before the 3rd of this month, the
    // next run is the 3rd of this month; otherwise it rolls to the
    // 3rd of next month.
    const CRON_DAY_OF_MONTH = 3;
    function _nextCronDateISO() {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const d = now.getDate();
      const target = (d < CRON_DAY_OF_MONTH)
        ? new Date(y, m, CRON_DAY_OF_MONTH)
        : new Date(y, m + 1, CRON_DAY_OF_MONTH);
      const yy = target.getFullYear();
      const mm = String(target.getMonth() + 1).padStart(2, '0');
      const dd = String(target.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    }

    // ISO date or "YYYY-MM-DD" → "M/D/YY" (e.g. "2026-03-31T..." → "3/31/26").
    // Parses the date components literally — no timezone shifting — so a
    // postedDate that's stored as 2026-03-31 doesn't become 3/30/26 in
    // the user's local zone.
    function _formatMDY(dateStr) {
      if (!dateStr) return '—';
      const ymd = String(dateStr).slice(0, 10);
      const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return dateStr;
      const yy = m[1].slice(2);
      const mm = String(parseInt(m[2], 10));
      const dd = String(parseInt(m[3], 10));
      return `${mm}/${dd}/${yy}`;
    }

    function _v2024HasMonth(year, month) {
      if (!_v2024MonthsSet) return true; // unknown → don't block
      const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
      return _v2024MonthsSet.has(ym);
    }

    function _v2024HasYear(year) {
      if (!_v2024MonthsSet) return true; // unknown → don't block
      const prefix = `${year}-`;
      for (const ym of _v2024MonthsSet) {
        if (ym.startsWith(prefix)) return true;
      }
      return false;
    }

    function _refreshV2024NavButtons() {
      // Monthly v2024 — Prev/Next disable when target month has no synced
      // data. Targets are "selected month ± 1," rolling year at Jan/Dec.
      const mSel = document.getElementById('monthly-v2024-month-select');
      const ySel = document.getElementById('monthly-v2024-year-select');
      const mPrev = document.getElementById('monthly-v2024-prev-btn');
      const mNext = document.getElementById('monthly-v2024-next-btn');
      if (mSel && ySel && mPrev && mNext) {
        const m = parseInt(mSel.value, 10);
        const y = parseInt(ySel.value, 10);
        if (Number.isFinite(m) && Number.isFinite(y)) {
          const prev = new Date(y, m - 1, 1);
          const next = new Date(y, m + 1, 1);
          mPrev.disabled = !_v2024HasMonth(prev.getFullYear(), prev.getMonth());
          mNext.disabled = !_v2024HasMonth(next.getFullYear(), next.getMonth());
        } else {
          mPrev.disabled = false;
          mNext.disabled = false;
        }
      }

      // YTD v2024 — Prev/Next enabled if any month of the target year has
      // data (a partial year is still worth viewing).
      const yySel = document.getElementById('ytd-v2024-year-select');
      const yPrev = document.getElementById('ytd-v2024-prev-btn');
      const yNext = document.getElementById('ytd-v2024-next-btn');
      if (yySel && yPrev && yNext) {
        const y = parseInt(yySel.value, 10);
        if (Number.isFinite(y)) {
          yPrev.disabled = !_v2024HasYear(y - 1);
          yNext.disabled = !_v2024HasYear(y + 1);
        } else {
          yPrev.disabled = false;
          yNext.disabled = false;
        }
      }
    }



    // Same "insert option if missing" helper as the Sheets-side version.
    // Prev/Next let the user scroll past the pre-seeded 5-year window
    // without the dropdown silently failing to update.
    function _setSelectByValue(select, v) {
      if (!select) return;
      const str = String(v);
      if ([...select.options].some(o => o.value === str)) {
        select.value = str;
        return;
      }
      const opt = document.createElement('option');
      opt.value = str;
      opt.textContent = str;
      let inserted = false;
      for (let i = 0; i < select.options.length; i++) {
        if (parseInt(select.options[i].value, 10) < v) {
          select.insertBefore(opt, select.options[i]);
          inserted = true;
          break;
        }
      }
      if (!inserted) select.appendChild(opt);
      select.value = str;
    }

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

    // ─── INPUT FETCHING ─────────────────────────────────────────────────
    //
    // Fetches the v2024-shape transactions from KV (via get-range-v2024)
    // alongside products / ad spend / shipping mappings — everything the
    // statement builder needs. The transactions fetch is widened by
    // V2024_LOOKBACK_MONTHS months before the requested startMonth so the
    // dedup pass in _deriveV2024Rows can see DEFERRED_RELEASED parents of
    // RELEASED records that fall in the requested window. After dedup the
    // derivation filters records by postedDate so only records inside the
    // user-requested window become rows.
    async function _fetchV2024Inputs(startDate, endDate) {
      const authHeader = { Authorization: `Bearer ${accessToken}` };
      const startMonth = startDate.slice(0, 7);
      const endMonth   = endDate.slice(0, 7);
      const widenedStart = _shiftMonth(startMonth, -V2024_LOOKBACK_MONTHS);

      const [txRes, prodRes, spAdRes, sbAdRes, prodMapRes, brandMapRes, feeMapRes, shipRes] = await Promise.all([
        fetch(`/api/transactions?action=get-range-v2024&startMonth=${widenedStart}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/products?action=get', { headers: authHeader }),
        fetch(`/api/adspend?action=get-range&type=sp&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch(`/api/adspend?action=get-range&type=sb&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/mappings?action=get&type=product', { headers: authHeader }),
        fetch('/api/mappings?action=get&type=brand',   { headers: authHeader }),
        fetch('/api/mappings?action=get&type=fee',     { headers: authHeader }),
        fetch(`/api/shipping?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader })
      ]);
      if (!txRes.ok)   throw new Error(`v2024 transactions fetch failed (${txRes.status})`);
      if (!prodRes.ok) throw new Error(`Products fetch failed (${prodRes.status})`);

      const tx         = await txRes.json();
      const prod       = await prodRes.json();
      const spAd       = spAdRes.ok     ? await spAdRes.json()    : { rows: [] };
      const sbAd       = sbAdRes.ok     ? await sbAdRes.json()    : { rows: [] };
      const prodMap    = prodMapRes.ok  ? await prodMapRes.json() : { mappings: {} };
      const brandMap   = brandMapRes.ok ? await brandMapRes.json() : { mappings: {} };
      const feeMap     = feeMapRes.ok   ? await feeMapRes.json()  : { mappings: {} };
      const shipping   = shipRes.ok     ? await shipRes.json()    : { rows: [] };

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
      let lastSynced = null;
      try {
        if (latestSyncedMonth) {
          const lsRes = await fetch(`/api/transactions?action=get-v2024&month=${latestSyncedMonth}`, { headers: authHeader });
          if (lsRes.ok) lastSynced = (await lsRes.json()).lastSynced || null;
        }
      } catch { /* non-fatal */ }

      return {
        transactions: tx.transactions || [],
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

    // v2024 analog of _computeUpstashPeriod. Same downstream pipeline
    // (statement build → metrics extract) — only the input fetch and the
    // derivation differ. Returns the same bundle shape so generate
    // functions / cache / renderer all work unchanged.
    async function _computeV2024Period(startDate, endDate) {
      const inputs = await _fetchV2024Inputs(startDate, endDate);
      const feeMappings = inputs.feeMappings || {};
      const { rows: derivedRows, unmappedBreakdowns, dedupSkipped, transferSkipped, outOfWindowSkipped } =
        _deriveV2024Rows(inputs.transactions, startDate, endDate, feeMappings);
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

    async function generateMonthlyV2024Report() {
      const month = parseInt(document.getElementById('monthly-v2024-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-v2024-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;

      const container = document.getElementById('monthly-v2024-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      const cacheKey = `monthly-v2024|${year}|${month}`;
      const cached = window._overviewReportCache && window._overviewReportCache.get(cacheKey);
      if (cached) {
        container.innerHTML = cached;
        return;
      }

      _refreshV2024NavButtons();

      container.innerHTML = '<div style="padding: 4rem; text-align: center;"><div class="spinner"></div><div style="margin-top: 1rem; color: var(--text-secondary); font-size: 0.95rem;">Loading data…</div></div>';

      try {
        // Mirrors generateMonthlyUpstashReport: current + previous (MoM) +
        // YoY pulled in parallel, comparisons computed on the metrics, then
        // current period rendered with comparisons.
        const startDate = _ymd(new Date(year, month, 1));
        const endDate   = _ymd(new Date(year, month + 1, 0));
        const prevStart = _ymd(new Date(year, month - 1, 1));
        const prevEnd   = _ymd(new Date(year, month, 0));
        const yoyStart  = _ymd(new Date(year - 1, month, 1));
        const yoyEnd    = _ymd(new Date(year - 1, month + 1, 0));

        const [current, prev, yoy] = await Promise.all([
          _computeV2024Period(startDate, endDate),
          _computeV2024Period(prevStart, prevEnd),
          _computeV2024Period(yoyStart, yoyEnd)
        ]);

        const comparisons = calculateComparisons(current.metrics, prev.metrics, yoy.metrics);
        _renderV2024Statement(container, {
          statement: current.statement,
          missingSkus: current.missingSkus,
          unmappedFees: current.unmappedFees,
          unmappedBreakdowns: current.unmappedBreakdowns,
          dedupSkipped: current.dedupSkipped,
          transferSkipped: current.transferSkipped,
          outOfWindowSkipped: current.outOfWindowSkipped,
          rows: current.rows,
          lastSynced: current.lastSynced,
          latestSyncedMonth: current.latestSyncedMonth,
          startDate, endDate,
          adSpend: current.adSpend,
          shippingCosts: current.shippingCosts,
          comparisons
        });

        if (window._overviewReportCache) window._overviewReportCache.set(cacheKey, container.innerHTML);
      } catch (err) {
        console.error('v2024 monthly overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ─── YTD v2024 ──────────────────────────────────────────────────────
    function showYTDV2024() {
      _hideAllOverviewViews();
      document.getElementById('ytd-v2024-view').style.display = 'block';
      document.getElementById('ytd-v2024-tab').classList.add('active');
      _initYTDV2024Dropdown();
      if (!_ytdV2024AutoLoaded && accessToken) {
        _ytdV2024AutoLoaded = true;
        setYTDV2024Year('thisYear');
      }
      _ensureV2024Months().then(() => {
        _populateV2024YearDropdowns();
        _refreshV2024NavButtons();
        _updateOverviewDataLabels();
      });
      _ensureAdSpendMonths().then(_updateOverviewDataLabels);
      _refreshV2024NavButtons();
    }

    function _initYTDV2024Dropdown() {
      // Populated by _populateV2024YearDropdowns after _ensureV2024Months
      // resolves so the list reflects actually-synced years.
    }

    // Same semantics as setYTDUpstashYear: thisYear/lastYear are absolute
    // (relative to today), prevYear/nextYear are relative to the currently
    // selected dropdown value.
    function setYTDV2024Year(preset) {
      const today = new Date();
      const sel = document.getElementById('ytd-v2024-year-select');
      const cur = parseInt(sel.value, 10);

      if (preset === 'thisYear') {
        _setSelectByValue(sel, today.getFullYear());
      } else if (preset === 'lastYear') {
        _setSelectByValue(sel, today.getFullYear() - 1);
      } else if (preset === 'prevYear' && Number.isFinite(cur)) {
        _setSelectByValue(sel, cur - 1);
      } else if (preset === 'nextYear' && Number.isFinite(cur)) {
        _setSelectByValue(sel, cur + 1);
      }

      _refreshV2024NavButtons();
      generateYTDV2024Report();
    }

    async function generateYTDV2024Report() {
      const year = document.getElementById('ytd-v2024-year-select').value;
      if (!year) return;

      const container = document.getElementById('ytd-v2024-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      const cacheKey = `ytd-v2024|${year}`;
      const cached = window._overviewReportCache && window._overviewReportCache.get(cacheKey);
      if (cached) {
        container.innerHTML = cached;
        return;
      }

      _refreshV2024NavButtons();

      container.innerHTML = '<div style="padding: 4rem; text-align: center;"><div class="spinner"></div><div style="margin-top: 1rem; color: var(--text-secondary); font-size: 0.95rem;">Loading data…</div></div>';

      try {
        // Same date logic as generateYTDUpstashReport: current year runs
        // Jan 1 → end of last complete month; past years run Jan 1 → Dec 31.
        // Previous year matches the cutoff so YoY % comparisons are
        // apples-to-apples.
        const today = new Date();
        const selectedYear = parseInt(year, 10);
        const isCurrentYear = selectedYear === today.getFullYear();

        const startDate = `${year}-01-01`;
        let endDate;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
          endDate = _ymd(new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0));
        } else {
          endDate = `${year}-12-31`;
        }

        const prevYear = selectedYear - 1;
        const prevStart = `${prevYear}-01-01`;
        let prevEnd;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const prevLastCompleteMonthYear = today.getMonth() === 0 ? prevYear - 1 : prevYear;
          prevEnd = _ymd(new Date(prevLastCompleteMonthYear, lastCompleteMonth + 1, 0));
        } else {
          prevEnd = `${prevYear}-12-31`;
        }

        const [current, prev] = await Promise.all([
          _computeV2024Period(startDate, endDate),
          _computeV2024Period(prevStart, prevEnd)
        ]);

        const comparisons = calculateYTDComparisons(current.metrics, prev.metrics);
        _renderV2024Statement(container, {
          statement: current.statement,
          missingSkus: current.missingSkus,
          unmappedFees: current.unmappedFees,
          unmappedBreakdowns: current.unmappedBreakdowns,
          dedupSkipped: current.dedupSkipped,
          transferSkipped: current.transferSkipped,
          outOfWindowSkipped: current.outOfWindowSkipped,
          rows: current.rows,
          lastSynced: current.lastSynced,
          latestSyncedMonth: current.latestSyncedMonth,
          startDate, endDate,
          adSpend: current.adSpend,
          shippingCosts: current.shippingCosts,
          comparisons
        });

        if (window._overviewReportCache) window._overviewReportCache.set(cacheKey, container.innerHTML);
      } catch (err) {
        console.error('v2024 YTD overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ─── CHARTS v2024 ───────────────────────────────────────────────────
    //
    // 12-month rolling trend charts sourced from the same v2024 Upstash
    // pipeline that powers the Monthly / YTD profitability statements.
    // One fetch covers the whole window (12 months + 6-month dedup
    // lookback); we then derive rows per month locally so the six charts
    // stay consistent with what the tables show.
    //
    // Six charts: overall revenue, overall profit, revenue by channel
    // (FBM/FBA), profit by channel, revenue by brand, profit by brand.
    let _chartsV2024AutoLoaded = false;
    let _chartsV2024Instances = {};
    let _chartsV2024MonthlyData = null; // cached so the brand filter
                                        // doesn't re-fetch on every change

    function showChartsV2024() {
      _hideAllOverviewViews();
      document.getElementById('charts-v2024-view').style.display = 'block';
      document.getElementById('charts-v2024-tab').classList.add('active');
      _ensureV2024Months().then(_updateOverviewDataLabels);
      _ensureAdSpendMonths().then(_updateOverviewDataLabels);
      if (!_chartsV2024AutoLoaded && accessToken) {
        _chartsV2024AutoLoaded = true;
        _loadV2024Charts();
      }
    }
    window.showChartsV2024 = showChartsV2024;

    function refreshV2024Charts() {
      _chartsV2024MonthlyData = null;
      _loadV2024Charts();
    }
    window.refreshV2024Charts = refreshV2024Charts;

    // 12-month rolling window ending at the last complete month. Returns
    // [{ label, year, month, startDate, endDate }, ...] in chronological
    // order — same shape the original Sheets-backed loadChartsData built.
    function _build12MonthWindow() {
      const today = new Date();
      const lastComplete = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const start = new Date(lastComplete);
      start.setMonth(start.getMonth() - 11);
      const out = [];
      const cur = new Date(start);
      while (cur <= lastComplete) {
        const y = cur.getFullYear();
        const m = cur.getMonth();
        const lastDay = new Date(y, m + 1, 0).getDate();
        out.push({
          label: cur.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          year: y,
          month: m,
          startDate: `${y}-${String(m + 1).padStart(2, '0')}-01`,
          endDate:   `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
        });
        cur.setMonth(cur.getMonth() + 1);
      }
      return out;
    }

    async function _loadV2024Charts() {
      const container = document.getElementById('charts-v2024-content');
      if (!container) return;
      if (!accessToken) return;

      const loader = document.getElementById('charts-v2024-loader');
      const body   = document.getElementById('charts-v2024-body');
      // Show spinner, hide canvas grid. Same loader/body inverse-toggle
      // pattern as Session & CVR.
      if (loader) loader.style.display = 'block';
      if (body)   body.style.display = 'none';

      try {
        const months = _build12MonthWindow();
        const fullStart = months[0].startDate;
        const fullEnd   = months[months.length - 1].endDate;

        // One fetch covers 12 months + 6-month lookback (handled inside
        // _fetchV2024Inputs). Way cheaper than 12 separate Period calls.
        const inputs = await _fetchV2024Inputs(fullStart, fullEnd);

        const monthlyData = months.map(m => {
          const { rows: derivedRows } = _deriveV2024Rows(
            inputs.transactions, m.startDate, m.endDate, inputs.feeMappings || {}
          );
          // Same imported-row merge as _computeV2024Period — scoped to
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

        _chartsV2024MonthlyData = monthlyData;
        _populateV2024BrandFilter(monthlyData);

        // Reveal the canvas grid before instantiating Chart.js so the
        // canvases have non-zero dimensions when Chart.js measures
        // them — same fix as the Session & CVR charts.
        if (loader) loader.style.display = 'none';
        if (body)   body.style.display = 'block';
        await new Promise(r => requestAnimationFrame(r));

        _renderV2024Charts(monthlyData);
      } catch (err) {
        console.error('v2024 charts load failed:', err);
        // No popup per project preference — surface inline above the
        // (still-hidden) body, then reveal it. If charts had loaded
        // previously they're now gone since body was hidden during
        // load; that's acceptable on a hard error.
        const note = document.createElement('div');
        note.style.cssText = 'padding: 1rem; color: var(--error); margin-bottom: 1rem;';
        note.textContent = `Charts load failed: ${err.message}`;
        container.prepend(note);
        if (loader) loader.style.display = 'none';
        if (body)   body.style.display = 'block';
      }
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
          const prod = inputs.products[r.sku];
          const cost = prod ? (Number(prod.cost) || 0) : 0;
          totals[brand].productCosts += cost * Math.abs(r.quantity || 1);
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

    function _populateV2024BrandFilter(monthlyData) {
      const sel = document.getElementById('v2024-brand-chart-filter');
      if (!sel) return;
      const cur = sel.value || 'all';
      // Brands seen anywhere in the 12-month window; sorted alpha for
      // stable ordering. Drops brands that never had income or profit.
      const brandSet = new Set();
      for (const m of monthlyData) {
        for (const [b, t] of Object.entries(m.byBrand || {})) {
          if ((t.income || 0) !== 0 || (t.profit || 0) !== 0) brandSet.add(b);
        }
      }
      const brands = [...brandSet].sort();
      sel.innerHTML = '<option value="all">All Brands</option>' +
        brands.map(b => `<option value="${_escape(b)}">${_escape(b)}</option>`).join('');
      sel.value = brandSet.has(cur) || cur === 'all' ? cur : 'all';
    }

    // Brand color palette — extends if there are more brands than
    // entries by cycling through. Order roughly matches the original
    // Sheets-backed charts so a returning user sees similar colors per
    // brand.
    const _V2024_BRAND_COLORS = [
      '#10b981', '#3b82f6', '#f59e0b', '#ec4899',
      '#8b5cf6', '#14b8a6', '#ef4444', '#84cc16'
    ];

    function _renderV2024Charts(monthlyData) {
      const labels = monthlyData.map(m => m.label);
      Object.values(_chartsV2024Instances).forEach(c => { try { c.destroy(); } catch {} });
      _chartsV2024Instances = {};

      const $ = (id) => document.getElementById(id);
      const moneyTicks = {
        callback: (v) => '$' + Number(v).toLocaleString()
      };

      // Overall revenue
      _chartsV2024Instances.revenue = new Chart($('v2024-revenue-chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Revenue',
            data: monthlyData.map(m => m.metrics?.total?.income || 0),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: { responsive: true, maintainAspectRatio: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: moneyTicks } } }
      });

      // Overall profit
      _chartsV2024Instances.profit = new Chart($('v2024-profit-chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Profit',
            data: monthlyData.map(m => m.metrics?.total?.profit || 0),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: { responsive: true, maintainAspectRatio: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: moneyTicks } } }
      });

      // Revenue by channel
      _chartsV2024Instances.revenueChannel = new Chart($('v2024-revenue-channel-chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'FBM', data: monthlyData.map(m => m.metrics?.fbm?.income || 0),
              borderColor: '#60a5fa', backgroundColor: 'rgba(96, 165, 250, 0.1)', tension: 0.4 },
            { label: 'FBA', data: monthlyData.map(m => m.metrics?.fba?.income || 0),
              borderColor: '#f97316', backgroundColor: 'rgba(249, 115, 22, 0.1)', tension: 0.4 }
          ]
        },
        options: { responsive: true, maintainAspectRatio: true,
          scales: { y: { beginAtZero: true, ticks: moneyTicks } } }
      });

      // Profit by channel
      _chartsV2024Instances.profitChannel = new Chart($('v2024-profit-channel-chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'FBM', data: monthlyData.map(m => m.metrics?.fbm?.profit || 0),
              borderColor: '#60a5fa', backgroundColor: 'rgba(96, 165, 250, 0.1)', tension: 0.4 },
            { label: 'FBA', data: monthlyData.map(m => m.metrics?.fba?.profit || 0),
              borderColor: '#f97316', backgroundColor: 'rgba(249, 115, 22, 0.1)', tension: 0.4 }
          ]
        },
        options: { responsive: true, maintainAspectRatio: true,
          scales: { y: { beginAtZero: true, ticks: moneyTicks } } }
      });

      _renderV2024BrandCharts(monthlyData);
    }

    function _renderV2024BrandCharts(monthlyData) {
      const labels = monthlyData.map(m => m.label);
      const filter = document.getElementById('v2024-brand-chart-filter')?.value || 'all';
      // Pull the brand list from monthlyData (whatever brands ended up
      // in byBrand for any month) so it matches the dropdown.
      const allBrands = new Set();
      for (const m of monthlyData) {
        for (const b of Object.keys(m.byBrand || {})) allBrands.add(b);
      }
      const brands = filter === 'all' ? [...allBrands].sort() : [filter];

      const datasetsFor = (key) => brands.map((brandName, idx) => ({
        label: brandName,
        data: monthlyData.map(m => m.byBrand?.[brandName]?.[key] || 0),
        borderColor: _V2024_BRAND_COLORS[idx % _V2024_BRAND_COLORS.length],
        tension: 0.4
      }));

      const moneyTicks = { callback: (v) => '$' + Number(v).toLocaleString() };
      const legendOpts = {
        display: brands.length > 1,
        position: 'top',
        labels: { boxWidth: 12, padding: 15, font: { size: 11 } }
      };

      if (_chartsV2024Instances.revenueBrand) try { _chartsV2024Instances.revenueBrand.destroy(); } catch {}
      if (_chartsV2024Instances.profitBrand)  try { _chartsV2024Instances.profitBrand.destroy(); }  catch {}

      _chartsV2024Instances.revenueBrand = new Chart(document.getElementById('v2024-revenue-brand-chart'), {
        type: 'line',
        data: { labels, datasets: datasetsFor('income') },
        options: { responsive: true, maintainAspectRatio: true,
          plugins: { legend: legendOpts },
          scales: { y: { beginAtZero: true, ticks: moneyTicks } } }
      });

      _chartsV2024Instances.profitBrand = new Chart(document.getElementById('v2024-profit-brand-chart'), {
        type: 'line',
        data: { labels, datasets: datasetsFor('profit') },
        options: { responsive: true, maintainAspectRatio: true,
          plugins: { legend: legendOpts },
          scales: { y: { beginAtZero: true, ticks: moneyTicks } } }
      });
    }

    function updateV2024BrandCharts() {
      if (!_chartsV2024MonthlyData) return;
      _renderV2024BrandCharts(_chartsV2024MonthlyData);
    }
    window.updateV2024BrandCharts = updateV2024BrandCharts;

    // ─── BRAND & PRODUCT v2024 ──────────────────────────────────────────
    //
    // Wraps the existing brand-product.js UI (showBPYTD / showBPMonthly /
    // generateBP*Report / setBP*Date / initializeBP*Dropdowns / etc.) but
    // sources its data from the same v2024 Upstash pipeline that powers
    // the rest of the Profitability Overview. The actual data fetch +
    // derive lives in `loadBrandProductData` (rewritten in brand-product.js
    // to call _fetchV2024Inputs / _deriveV2024Rows here).
    let _brandProductV2024AutoLoaded = false;

    function showBrandProductV2024() {
      _hideAllOverviewViews();
      document.getElementById('brandproduct-v2024-view').style.display = 'block';
      document.getElementById('brandproduct-v2024-tab').classList.add('active');
      _ensureV2024Months().then(_updateOverviewDataLabels);
      _ensureAdSpendMonths().then(_updateOverviewDataLabels);
      // First view: populate dropdowns + auto-load last month's report so
      // the user lands on data instead of an empty placeholder.
      if (!_brandProductV2024AutoLoaded && accessToken) {
        _brandProductV2024AutoLoaded = true;
        // Default to the Monthly sub-tab on first view; matches the prior
        // top-level page's behaviour from the old core.js handler.
        if (typeof showBPMonthly === 'function') showBPMonthly();
        if (typeof generateBPMonthlyReport === 'function') generateBPMonthlyReport();
      }
    }
    window.showBrandProductV2024 = showBrandProductV2024;

    function refreshBrandProductV2024() {
      // Re-runs whichever sub-tab is active. The brand-product.js report
      // generators don't memoize, so this just re-fetches and re-renders.
      const ytdActive = document.getElementById('bp-ytd-tab')?.classList.contains('active');
      if (ytdActive) {
        if (typeof generateBPYTDReport === 'function') generateBPYTDReport();
      } else {
        if (typeof generateBPMonthlyReport === 'function') generateBPMonthlyReport();
      }
    }
    window.refreshBrandProductV2024 = refreshBrandProductV2024;

    // Computes a brand → products structure with FBM / FBA / Total
    // metrics in the exact shape brand-product.js's renderBrandProductTable
    // expects ({ brandName, products: [{ productName, skus, fbm, fba,
    // total }], fbm, fba, total }). Same data source as the Profitability
    // statement (v2024 Upstash transactions widened by 6-month dedup
    // lookback, then derived per the existing pipeline).
    //
    // Why per-SKU here vs the statement's FBM/FBA-only summary: the
    // brand-product table needs costs/income/fees/ads attributed to
    // individual SKUs so we can roll them up into product-level rows
    // (FBA + FBM versions of the same product collapse to one row by
    // product name, with separate FBM / FBA columns).
    async function _loadBrandProductV2024(startDate, endDate, brandFilter) {
      if (!accessToken) throw new Error('Please sign in first');

      const inputs = await _fetchV2024Inputs(startDate, endDate);
      const { rows: derivedRows } = _deriveV2024Rows(
        inputs.transactions, startDate, endDate, inputs.feeMappings || {}
      );
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
        if (r.type === 'Order') {
          const cost = skuToProduct[r.sku].cost || 0;
          skuTotals[r.sku].productCosts += cost * Math.abs(r.quantity || 1);
        }
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
    window._loadBrandProductV2024 = _loadBrandProductV2024;

    // Renders the financial statement plus any unmapped-data warnings.
    // The status strip (data-through / last-synced / dedup counters) was
    // removed — the page-header labels at the top of the Overview now
    // surface the same freshness information.
    function _renderV2024Statement(container, opts) {
      const { statement, missingSkus, unmappedFees, unmappedBreakdowns, startDate, endDate, comparisons } = opts;
      renderFinancialStatement(statement, startDate, endDate, container, comparisons || null);

      const missingWarning = missingSkus.length > 0 ? _renderMissingSkuWarning(missingSkus) : '';
      const feeWarning     = unmappedFees && unmappedFees.length > 0 ? _renderUnmappedFeeWarning(unmappedFees) : '';
      const breakdownWarning = unmappedBreakdowns && Object.keys(unmappedBreakdowns).length > 0
        ? _renderUnmappedBreakdownWarning(unmappedBreakdowns)
        : '';
      container.innerHTML = missingWarning + feeWarning + breakdownWarning + container.innerHTML;
    }

    // YYYY-MM → "Mon YYYY" (e.g. "2025-08" → "Aug 2025"). Used in the data-
    // status strip so the user sees a friendly month label rather than the
    // numeric form.
    function _formatYYYYMM(yyyyMM) {
      if (!yyyyMM) return '—';
      const [y, m] = yyyyMM.split('-').map(Number);
      if (!Number.isFinite(y) || !Number.isFinite(m)) return yyyyMM;
      const d = new Date(Date.UTC(y, m - 1, 1));
      return d.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
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
    function _v2024HasDeferredAncestor(t) {
      return (t.relatedIdentifiers || []).some(r => r?.relatedIdentifierName === 'DEFERRED_TRANSACTION_ID');
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
    // unrecognized aggregator nodes to reach handlers underneath. Tracks
    // truly-unmapped leaves (no built-in handler, no user mapping, no
    // children, non-zero amount) for the editable warning block.
    function _v2024WalkAndRoute(breakdowns, handle, unmapped, feeMappings) {
      for (const node of (breakdowns || [])) {
        const type = node?.breakdownType;
        let handler = type ? V2024_LEAF_HANDLER[type] : null;
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
          _v2024WalkAndRoute(node.breakdowns, handle, unmapped, feeMappings);
        } else if (type && unmapped) {
          const amt = node?.breakdownAmount?.currencyAmount || 0;
          if (Math.abs(amt) > 0.005) {
            unmapped[type] = (unmapped[type] || 0) + amt;
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
      // pass through this pass untouched.
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
            }, unmappedBreakdowns, feeMappings);

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
            }, unmappedBreakdowns, feeMappings);
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
            }, unmappedBreakdowns, feeMappings);
          }
        }
        // Unknown transactionType → silently skip (would surface in probe)
      }

      return { rows, unmappedBreakdowns, dedupSkipped, transferSkipped, outOfWindowSkipped };
    }

    // ─── CONSOLE VALIDATION HELPER ──────────────────────────────────────
    // Paste `await compareV2024('2026-02')` (or any month) into the
    // browser DevTools console while signed in. Fetches v2024 raw from
    // KV, runs _deriveV2024Rows, builds a statement, and console.logs
    // total counts + per-line FBM/FBA totals so you can sanity-check
    // against the existing v0 Monthly Upstash report or the Sheets data.
    // No UI changes — pure validation utility until we wire a tab.
    async function compareV2024(month) {
      if (!accessToken) { console.error('Sign in first'); return; }
      if (!/^\d{4}-\d{2}$/.test(month)) {
        console.error('month must be YYYY-MM');
        return;
      }
      const [y, m] = month.split('-').map(Number);
      const startDate = `${month}-01`;
      const endDate = _ymd(new Date(y, m, 0));

      const res = await fetch(`/api/transactions?action=get-v2024&month=${month}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) {
        console.error('get-v2024 failed', res.status, await res.text());
        return;
      }
      const data = await res.json();
      const transactions = data.transactions || [];
      console.log(`v2024 raw: ${transactions.length} transactions stored for ${month}`);

      const { rows, unmappedBreakdowns, dedupSkipped, transferSkipped } =
        _deriveV2024Rows(transactions, startDate, endDate);
      console.log(`v2024 derived: ${rows.length} rows · ${dedupSkipped} dedup-skipped · ${transferSkipped} transfers-skipped`);

      // Roll up totals without touching the catalog — purely from rows.
      const totals = {
        FBA: { sale: 0, returns: 0, other: 0, txFees: 0, fbaFees: 0, promotions: 0 },
        FBM: { sale: 0, returns: 0, other: 0, txFees: 0, fbaFees: 0, promotions: 0 },
        none: { sale: 0, returns: 0, other: 0, txFees: 0, fbaFees: 0, promotions: 0 },
        serviceFees: 0, adjustments: 0
      };
      for (const r of rows) {
        if (r.type === 'Order' || r.type === 'Refund') {
          const bucket = totals[r.fulfillment || 'none'];
          if (r.type === 'Order') bucket.sale    += r.sale;
          else                     bucket.returns += r.sale;
          bucket.other      += r.otherCharges;
          bucket.txFees     += r.transactionFees;
          bucket.fbaFees    += r.fbaFees;
          bucket.promotions += r.promotions;
        } else if (r.type === 'ServiceFee') {
          totals.serviceFees += r.feeAmount;
        } else if (r.type === 'Adjustment') {
          totals.adjustments += r.adjustmentAmount;
        }
      }
      console.table(totals);
      if (Object.keys(unmappedBreakdowns).length > 0) {
        console.warn('Unmapped breakdownTypes — may indicate schema drift:', unmappedBreakdowns);
      }
      return { rows, totals, unmappedBreakdowns, dedupSkipped, transferSkipped };
    }
    // Expose on window so it's callable from DevTools.
    window.compareV2024 = compareV2024;

    // ─── STATEMENT BUILDER ──────────────────────────────────────────────
    // Each derived row's columns flow into statement buckets based on
    // fulfillment (from the Products catalog). Positives → credit,
    // negatives → debit.

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

    // ─── RENDER ─────────────────────────────────────────────────────────


    // ServiceFee FeeTypes we don't have a rule for get bucketed into
    // "Other Expenses" and listed here as an editable warning. Each row
    // has a destination dropdown + Save button — clicking Save POSTs the
    // mapping to /api/mappings?type=fee, clears the cache, and re-runs
    // the report. Mapped fees disappear from the warning on next render.
    function _renderUnmappedFeeWarning(unmapped) {
      return _renderEditableFeeWarning(unmapped, {
        title: 'unmapped ServiceFee FeeType',
        intro: "These FeeTypes aren't recognized yet. Their amounts are bucketed into Other Expenses so nothing's lost. Pick a destination below and click Save — the mapping is stored, applied across all months, and re-applied on every report load.",
        keyHeader: 'FeeType'
      });
    }

    // Same UI as _renderUnmappedFeeWarning but for breakdown-tree leaves
    // that have no V2024_LEAF_HANDLER entry. Listed here so the user can
    // route them in-app instead of needing a code change.
    function _renderUnmappedBreakdownWarning(unmapped) {
      const entries = Object.entries(unmapped)
        .map(([feeType, total]) => ({ feeType, total }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      return _renderEditableFeeWarning(entries, {
        title: 'unmapped breakdownType',
        intro: "These appeared in the listTransactions response but aren't in V2024_LEAF_HANDLER. Their amounts are NOT making it into the statement until you route them. Pick a destination below and click Save — the mapping persists across months.",
        keyHeader: 'breakdownType'
      });
    }

    // Shared editable warning renderer. Each row has a destination
    // <select> populated with all income + expense lines plus a "Skip
    // (net-zero)" option, and a Save button that calls saveFeeMapping.
    function _renderEditableFeeWarning(entries, { title, intro, keyHeader }) {
      const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // Build dropdown <option> markup once and reuse per row. Income
      // lines come first since most fee categories that need rerouting
      // are expense-side, but income destinations exist (e.g. the
      // user might want to route a credit-style breakdown to FBM Other).
      const incomeOpts = STATEMENT_INCOME_LINES
        .map(line => `<option value="${_escape(line)}">${_escape(line)}</option>`).join('');
      const expenseOpts = STATEMENT_EXPENSE_LINES
        .map(line => `<option value="${_escape(line)}">${_escape(line)}</option>`).join('');
      const optionsMarkup = `
        <option value="">— pick a destination —</option>
        <optgroup label="Income lines">${incomeOpts}</optgroup>
        <optgroup label="Expense lines">${expenseOpts}</optgroup>
        <option value="_skip">Skip (don't include in statement)</option>
      `;

      const rows = entries.map(u => {
        const ft = _escape(u.feeType || '(empty)');
        const ftAttr = (u.feeType || '').replace(/"/g, '&quot;');
        return `
          <tr>
            <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${ft}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(u.total)}</td>
            <td style="padding: 0.5rem 0.75rem;">
              <select class="fee-mapping-select" data-fee-type="${ftAttr}" style="padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-card); color: var(--text-primary); font-size: 0.85rem; min-width: 220px;">
                ${optionsMarkup}
              </select>
            </td>
            <td style="padding: 0.5rem 0.75rem;">
              <button class="btn btn-secondary" onclick="saveFeeMapping(this)" data-fee-type="${ftAttr}" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Save</button>
            </td>
          </tr>
        `;
      }).join('');

      return `
        <div style="background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.5rem;">
            ⚠ ${entries.length} ${title}${entries.length === 1 ? '' : 's'} — needs routing
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            ${intro}
          </div>
          <table style="border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left;  padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">${keyHeader}</th>
                <th style="text-align: right; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Amount</th>
                <th style="text-align: left;  padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Map to</th>
                <th style="background: var(--bg-primary);"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // POST a single fee mapping, then clear the per-session report cache
    // (so the new mapping is applied) and re-run whichever Overview tab
    // is currently active. Called from the Save button on the editable
    // warning rows; reads the dropdown that lives in the same row.
    async function saveFeeMapping(button) {
      const feeType = button?.dataset?.feeType;
      if (!feeType) return;
      const select = button.closest('tr')?.querySelector('select.fee-mapping-select');
      if (!select) return;
      const line = select.value;
      if (!line) return; // user hit Save before picking a destination
      if (!accessToken) return;

      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        const res = await fetch('/api/mappings?action=save-one&type=fee', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({ feeType, line })
        });
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        // The mapping is global, so a stale cached statement for any
        // month wouldn't reflect it. Wipe the whole Overview cache and
        // re-render whichever tab the user is on.
        if (window._overviewReportCache) window._overviewReportCache.clear();
        const activeTabId = document.querySelector('#overview-page .page-header .tabs .tab.active')?.id;
        if (activeTabId === 'ytd-v2024-tab') generateYTDV2024Report();
        else                                  generateMonthlyV2024Report();
      } catch (err) {
        console.error('Fee mapping save failed:', err);
        button.disabled = false;
        button.textContent = original;
      }
    }
    // Expose so inline onclick="saveFeeMapping(this)" can resolve it.
    window.saveFeeMapping = saveFeeMapping;

    // Manual refresh — clears every level of in-memory cache so the next
    // render fetches fresh transactions, products, mappings, ad spend, and
    // shipping. Use after editing the Products catalog, after running a
    // sync, or any time you want to force-bust the per-session report
    // cache. Resets _v2024MonthsSet too so the Prev/Next nav-button
    // gating picks up newly-synced months.
    async function refreshV2024Report() {
      if (window._overviewReportCache) window._overviewReportCache.clear();
      _v2024MonthsSet = null;
      _v2024MonthsPromise = null;
      _v2024LatestPostedDate = null;
      _adSpendMonthsSet = null;
      _adSpendMonthsPromise = null;
      _adSpendLatestPostedDate = null;
      await Promise.all([_ensureV2024Months(), _ensureAdSpendMonths()]);
      _populateV2024YearDropdowns();
      _refreshV2024NavButtons();
      _updateOverviewDataLabels();
      const activeTabId = document.querySelector('#overview-page .page-header .tabs .tab.active')?.id;
      if (activeTabId === 'ytd-v2024-tab') generateYTDV2024Report();
      else                                  generateMonthlyV2024Report();
    }
    window.refreshV2024Report = refreshV2024Report;

    function _renderMissingSkuWarning(missing) {
      const rows = missing.map(m => `
        <tr>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${_escape(m.sku || '(empty)')}</td>
          <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${m.orderCount}</td>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.8rem; color: var(--text-secondary);">${m.sampleOrderIds.map(_escape).join(', ')}${m.orderCount > m.sampleOrderIds.length ? ', …' : ''}</td>
        </tr>
      `).join('');
      return `
        <div style="background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.5rem;">
            ⚠ ${missing.length} SKU${missing.length === 1 ? '' : 's'} not found in the Product Catalog
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            These rows were skipped — add them to the catalog (with a fulfillment and cost) and reload to include them in the statement.
          </div>
          <table style="border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">SKU</th>
                <th style="text-align: right; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Order Count</th>
                <th style="text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Sample Order IDs</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // ─── SMALL UTILITIES ────────────────────────────────────────────────

    function _ymd(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function _formatSyncTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function _escape(s) {
      if (s == null) return '';
      return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
