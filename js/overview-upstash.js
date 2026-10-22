    // Profitability Overview — backed by SP-API Finances v2024-06-19
    // listTransactions.
    //
    // Storage model: /api/transactions?action=sync-v2024 stores the raw
    // listTransactions response. The dedup rule (skip RELEASED transactions
    // that carry a DEFERRED_TRANSACTION_ID), the breakdown-leaf →
    // statement-line routing (V2024_LEAF_HANDLER), and the FBA/FBM split
    // (from each item's ProductContext.fulfillmentNetwork: AFN→FBA,
    // MFN→FBM) all happen on the server, at request time, in
    // lib/profitability.js. Iterating on the routing table requires no
    // re-sync — just reload the page.
    //
    // Two tabs in the UI:
    //   showMonthlyV2024() — Monthly Profitability for a single (year, month)
    //                        with current + prev-month + YoY comparisons
    //   showYTDV2024()     — Year-to-Date Profitability for a single year
    //                        with YoY comparisons
    //
    // Statement assembly path is shared: _computeV2024Period →
    // /api/transactions?action=profit-period (the server reads
    // transactions + products + ad spend + shipping + mappings and builds
    // the statement and its metrics) → renderFinancialStatement (in
    // brand-product.js). The Sheets-backed and v0-Upstash variants were
    // retired after v2024 validated against Sheets monthly totals.

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

    // ─── STATEMENT DATA ─────────────────────────────────────────────────
    //
    // The statement math runs on the server (lib/profitability.js, served
    // by /api/transactions?action=profit-*), from the same transactions,
    // catalog, ad spend, mappings, and shipping this page used to download.
    // Each call returns finished numbers for one window.

    // A profit-* response body, or the server's error.
    async function _profitJson(res) {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Profitability request failed (${res.status})`);
      return body;
    }

    // One period's statement bundle: { statement, missingSkus, unmappedFees,
    // lastSynced, latestSyncedMonth, adSpend, shippingCosts, metrics,
    // unmappedBreakdowns, dedupSkipped, transferSkipped, outOfWindowSkipped }.
    async function _computeV2024Period(startDate, endDate) {
      const res = await fetch(`/api/transactions?action=profit-period&startDate=${startDate}&endDate=${endDate}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      return (await _profitJson(res)).period;
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
    // 12-month rolling trend charts sourced from the same server-side
    // pipeline that powers the Monthly / YTD profitability statements.
    // One request covers the whole window (profit-charts); the server
    // builds each month's statement the same way, so the six charts stay
    // consistent with what the tables show.
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

        // One request covers the whole window; the server computes each
        // month's metrics and per-brand totals.
        const res = await fetch(`/api/transactions?action=profit-charts&startMonth=${fullStart.slice(0, 7)}&endMonth=${fullEnd.slice(0, 7)}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const byStart = new Map((await _profitJson(res)).months.map(x => [x.startDate, x]));
        const monthlyData = months.map(m => {
          const computed = byStart.get(m.startDate);
          if (!computed) throw new Error(`No chart data for ${m.startDate}`);
          return { ...m, metrics: computed.metrics, byBrand: computed.byBrand };
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
    // sources its data from the same server-side pipeline that powers
    // the rest of the Profitability Overview. `loadBrandProductData` in
    // brand-product.js calls _loadBrandProductV2024 below, which asks the
    // server (profit-brand-product) for the finished table.
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

    // The brand → products table with FBM / FBA / Total metrics, in the
    // shape brand-product.js's renderBrandProductTable expects
    // ({ brandName, products: [{ productName, skus, fbm, fba, total }],
    // fbm, fba, total }), computed on the server from the same data as the
    // Profitability statement.
    async function _loadBrandProductV2024(startDate, endDate, brandFilter) {
      if (!accessToken) throw new Error('Please sign in first');
      const brandParam = brandFilter ? `&brand=${encodeURIComponent(brandFilter)}` : '';
      const res = await fetch(`/api/transactions?action=profit-brand-product&startDate=${startDate}&endDate=${endDate}${brandParam}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      return (await _profitJson(res)).brands;
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

    // ─── STATEMENT LINES ────────────────────────────────────────────────
    // The statement's lines, as lib/profitability.js builds them. The
    // fee-mapping dropdown offers these as destinations.

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
