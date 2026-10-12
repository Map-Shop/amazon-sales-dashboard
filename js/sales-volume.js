    // SALES & VOLUME PAGE
    let svAllProducts = [];
    let svOrdersData = [];
    let svSalesChart = null;
    let svVolumeChart = null;
    let svSalesPerDayChart = null;
    let svVolumePerDayChart = null;
    
    async function loadSalesVolumeData() {
      if (!accessToken) return;

      // Show the spinner from the moment the page is opened — covers
      // the entire orders + products fetch + render pipeline so the
      // user sees activity instead of an empty page during the
      // initial load. Loader/body inverse-toggle, same pattern as
      // Session & CVR.
      const svLoader = document.getElementById('sv-monthly-loader');
      const svBody   = document.getElementById('sv-monthly-body');
      if (svLoader) svLoader.style.display = 'block';
      if (svBody)   svBody.style.display = 'none';

      try {
        // Single fetch — full orders array. Used for both YTD/MTD
        // calculations and the rolling 13-month chart/list (which
        // aggregates client-side in renderSalesVolumeData).
        //
        // Reads from the `orders:v2:*` keyspace (Amazon flat-file "All
        // Orders" report data, ingested via the Orders Report upload
        // tab on the Data Upload page). This replaces the old
        // ?action=get read that pulled from the getOrders/getOrderItems
        // cron output — that path systematically undercounted revenue
        // due to Pending-order and business-buyer-discount handling
        // issues. See plan file mossy-pondering-music.md (Phase 1).
        // Rollback: change back to ?action=get.
        const ordersRes = await fetch('/api/orders?action=get-v2', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (ordersRes.ok) {
          const data = await ordersRes.json();
          svOrdersData = data.orders || [];
          updateSVDataBlurb(svOrdersData);
        }

        // Phase 3: fetch alerts + heartbeat and render the banner.
        // Non-blocking — a failure here shouldn't break the main data
        // load. Renders "Last sync: X ago" text in the data blurb and
        // fills the alert banner if any alerts are undismissed.
        _svLoadAlertsAndHeartbeat().catch(err => {
          console.warn('Alerts load failed:', err.message);
        });


        // Load products from the Upstash catalog. Sales & Volume needs
        // sellable units, so the Child/Non-Variable filter (parents
        // are display rollups whose own ASINs don't actually sell on
        // Amazon) is preserved exactly as before — only the data
        // source changed.
        const productsResponse = await fetch('/api/products?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!productsResponse.ok) {
          console.error('Failed to load products from Upstash:', productsResponse.status);
          return;
        }
        const productsPayload = await productsResponse.json();
        const products = Array.isArray(productsPayload.products) ? productsPayload.products : [];

        svAllProducts = products
          .filter(p => {
            const asin = (p.asin || '').toString().trim();
            const productType = (p.type || '').toString().trim();
            return asin
                && asin.toUpperCase() !== 'N/A'
                && (productType === 'Child' || productType === 'Non-Variable');
          })
          .map(p => ({
            sku: p.sku,
            name: p.name || p.sku,
            brand: p.brand || 'Unknown',
            asin: p.asin,
            productType: p.type || '',
            // Captured for the product dropdown's FBA/FBM disambiguation
            // when two products share the same name + brand.
            fulfillment: p.fulfillment || ''
          }));

        // Populate brand dropdown
        const brands = [...new Set(svAllProducts.map(p => p.brand))].sort();
        const brandSelect = document.getElementById('sv-brand-filter');
        brandSelect.innerHTML = '<option value="">All Brands</option>';
        brands.forEach(brand => {
          brandSelect.innerHTML += `<option value="${brand}">${brand}</option>`;
        });

        // Populate products (the body is still hidden but the DOM
        // elements exist, so getElementById works fine).
        filterSVProducts();

        // Populate the Year + Month nav dropdowns now that we know
        // the earliest synced month. Defaults to the latest navigable
        // month so the page lands on current-month-MTD by default.
        // renderSalesVolumeData below reads from these dropdowns.
        _svPopulateNavDropdowns();

        // Reveal the body before rendering — Chart.js needs the
        // canvases laid out (non-zero dimensions) when it instantiates
        // them, otherwise it latches onto 0×0 forever (same bug we
        // hit on Session & CVR).
        if (svLoader) svLoader.style.display = 'none';
        if (svBody)   svBody.style.display = 'block';
        await new Promise(r => requestAnimationFrame(r));

        // Render data
        renderSalesVolumeData();

        // Populate export brand list now that svAllProducts is loaded
        populatePCIExportBrands();

        // Pre-load PCI data in background so it's ready when tab is clicked
        initPCI();

      } catch (error) {
        console.error('Error loading sales & volume data:', error);
        // Reveal the body even on failure so the user isn't stuck on
        // the spinner — the page may have stale content or empty
        // dropdowns, but that's a clearer state than a stuck loader.
        if (svLoader) svLoader.style.display = 'none';
        if (svBody)   svBody.style.display = 'block';
      }
    }
    
    function filterSVProducts() {
      const selectedBrand = document.getElementById('sv-brand-filter').value;
      const productSelect = document.getElementById('sv-product-filter');

      let filteredProducts = selectedBrand
        ? svAllProducts.filter(p => p.brand === selectedBrand)
        : svAllProducts;

      filteredProducts.sort((a, b) => a.name.localeCompare(b.name));

      // Disambiguation runs against the *visible* set so when the brand
      // filter is set to one brand, we don't bother adding brand-short
      // suffixes that would just be redundant. Helper is shared with
      // the Listing Optimization dropdowns — see core.js.
      const labels = buildDisambiguatedProductLabels(filteredProducts, 'sku');

      productSelect.innerHTML = '<option value="">All Products</option>';
      filteredProducts.forEach(product => {
        const label = labels.get(product.sku) || product.name;
        productSelect.innerHTML += `<option value="${product.sku}">${label}</option>`;
      });

      renderSalesVolumeData();
    }

    // ── MONTH NAVIGATION ─────────────────────────────────────────────────────
    // Year + Month dropdowns plus Prev/Next buttons drive the anchor
    // for every card / chart / table on the Monthly Overview tab.
    // Range: earliest navigable month = oldest synced month + 12
    // (a full year of prior data is required for YoY comparisons),
    // latest = the current month (yesterday's month-of-year). Buttons
    // disable at the bounds.

    const SV_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Computes { firstY, firstM, lastY, lastM } (months 1-indexed) or
    // null if there's not enough data for any navigable month yet.
    function _svComputeNavRange() {
      if (!svOrdersData || svOrdersData.length === 0) return null;
      let earliest = null;
      for (const o of svOrdersData) {
        const ym = (o.orderDate || '').slice(0, 7);
        if (!ym) continue;
        if (earliest === null || ym < earliest) earliest = ym;
      }
      if (!earliest) return null;

      const [ey, em] = earliest.split('-').map(Number);
      // Earliest navigable = earliest synced + 12 months. Carry into next year as needed.
      let firstY = ey;
      let firstM = em + 12;
      while (firstM > 12) { firstM -= 12; firstY++; }

      // Latest navigable = yesterday's month (the most current data we have).
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const lastY = yesterday.getFullYear();
      const lastM = yesterday.getMonth() + 1;

      // If the earliest-navigable boundary is later than yesterday,
      // there's nothing to navigate yet (catalog-young store).
      if (firstY > lastY || (firstY === lastY && firstM > lastM)) return null;

      return { firstY, firstM, lastY, lastM };
    }

    // Picks the months that should appear in the Month dropdown for a
    // given selected year — clamped to the navigable range so January
    // disappears for 2026 if the range starts in March 2026, etc.
    function _svMonthRangeForYear(year, range) {
      const startM = year === range.firstY ? range.firstM : 1;
      const endM   = year === range.lastY  ? range.lastM  : 12;
      return { startM, endM };
    }

    // Populates the Year + Month dropdowns. If a current selection is
    // already set, preserve it (clamped to range); otherwise default
    // to the latest navigable month.
    function _svPopulateNavDropdowns() {
      const range = _svComputeNavRange();
      const yearSel  = document.getElementById('sv-nav-year');
      const monthSel = document.getElementById('sv-nav-month');
      if (!yearSel || !monthSel) return;

      if (!range) {
        // Not enough data — disable everything.
        yearSel.innerHTML  = '';
        monthSel.innerHTML = '';
        yearSel.disabled = monthSel.disabled = true;
        document.getElementById('sv-nav-prev').disabled = true;
        document.getElementById('sv-nav-next').disabled = true;
        return;
      }
      yearSel.disabled = monthSel.disabled = false;

      const curY = parseInt(yearSel.value, 10);
      const curM = parseInt(monthSel.value, 10);

      // Year list
      yearSel.innerHTML = '';
      for (let y = range.firstY; y <= range.lastY; y++) {
        yearSel.innerHTML += `<option value="${y}">${y}</option>`;
      }

      // Default to most recent navigable month if no valid prior pick.
      const validCur = Number.isFinite(curY) && Number.isFinite(curM)
        && curY >= range.firstY && curY <= range.lastY
        && (() => {
          const { startM, endM } = _svMonthRangeForYear(curY, range);
          return curM >= startM && curM <= endM;
        })();

      if (validCur) {
        yearSel.value = curY;
        _svPopulateMonthsForYear(curY, curM, range);
      } else {
        yearSel.value = range.lastY;
        _svPopulateMonthsForYear(range.lastY, range.lastM, range);
      }

      _svUpdateNavButtons();
    }

    function _svPopulateMonthsForYear(year, defaultMonth, range) {
      const monthSel = document.getElementById('sv-nav-month');
      if (!monthSel) return;
      const { startM, endM } = _svMonthRangeForYear(year, range);
      monthSel.innerHTML = '';
      for (let m = startM; m <= endM; m++) {
        monthSel.innerHTML += `<option value="${m}">${SV_MONTH_NAMES[m - 1]}</option>`;
      }
      // Clamp default to valid range for this year.
      const m = Math.min(Math.max(defaultMonth || endM, startM), endM);
      monthSel.value = m;
    }

    // Greys out Prev/Next at the navigable bounds.
    function _svUpdateNavButtons() {
      const range = _svComputeNavRange();
      const prevBtn = document.getElementById('sv-nav-prev');
      const nextBtn = document.getElementById('sv-nav-next');
      if (!range || !prevBtn || !nextBtn) return;
      const y = parseInt(document.getElementById('sv-nav-year').value, 10);
      const m = parseInt(document.getElementById('sv-nav-month').value, 10);
      if (!Number.isFinite(y) || !Number.isFinite(m)) {
        prevBtn.disabled = nextBtn.disabled = true;
        return;
      }
      prevBtn.disabled = (y === range.firstY && m === range.firstM);
      nextBtn.disabled = (y === range.lastY  && m === range.lastM);
    }

    function svNavYearChange() {
      const range = _svComputeNavRange();
      if (!range) return;
      const y = parseInt(document.getElementById('sv-nav-year').value, 10);
      // Pick the latest valid month for the newly-selected year so
      // jumping years lands on the most recent data for that year.
      const { endM } = _svMonthRangeForYear(y, range);
      _svPopulateMonthsForYear(y, endM, range);
      _svUpdateNavButtons();
      renderSalesVolumeData();
    }
    window.svNavYearChange = svNavYearChange;

    function svNavMonthChange() {
      _svUpdateNavButtons();
      renderSalesVolumeData();
    }
    window.svNavMonthChange = svNavMonthChange;

    // Step the selection by ±1 month within the navigable range.
    // Year rolls when crossing Dec/Jan; clamp at bounds.
    function _svNavStep(delta) {
      const range = _svComputeNavRange();
      if (!range) return;
      let y = parseInt(document.getElementById('sv-nav-year').value, 10);
      let m = parseInt(document.getElementById('sv-nav-month').value, 10);
      if (!Number.isFinite(y) || !Number.isFinite(m)) return;
      m += delta;
      while (m < 1)  { m += 12; y--; }
      while (m > 12) { m -= 12; y++; }
      // Clamp to range
      if (y < range.firstY || (y === range.firstY && m < range.firstM)) {
        y = range.firstY; m = range.firstM;
      }
      if (y > range.lastY || (y === range.lastY && m > range.lastM)) {
        y = range.lastY; m = range.lastM;
      }
      // Apply: rebuild months for the (possibly new) year, then set m
      _svPopulateMonthsForYear(y, m, range);
      document.getElementById('sv-nav-year').value = y;
      document.getElementById('sv-nav-month').value = m;
      _svUpdateNavButtons();
      renderSalesVolumeData();
    }
    function svNavPrev() { _svNavStep(-1); }
    function svNavNext() { _svNavStep(+1); }
    window.svNavPrev = svNavPrev;
    window.svNavNext = svNavNext;

    function renderSalesVolumeData() {
      const selectedSKU         = document.getElementById('sv-product-filter').value;
      const selectedBrand       = document.getElementById('sv-brand-filter').value;
      // Anchor month comes from the dedicated nav widget. Always
      // specifies a full year+month — no "all years" / "all months"
      // states since the new nav widget always picks a concrete month.
      const navYearVal  = parseInt(document.getElementById('sv-nav-year').value, 10);
      const navMonthVal = parseInt(document.getElementById('sv-nav-month').value, 10);
      const selectedMonth = (Number.isFinite(navYearVal) && Number.isFinite(navMonthVal))
        ? `${navYearVal}-${String(navMonthVal).padStart(2, '0')}`
        : '';
      const selectedFulfillment = document.getElementById('sv-fulfillment-filter').value; // 'AFN','MFN', or ''

      // Build SKU set for brand filtering (when brand selected but no specific product)
      const brandSKUs = selectedBrand && !selectedSKU
        ? new Set(svAllProducts.filter(p => p.brand === selectedBrand).map(p => p.sku))
        : null;

      // For YTD/MTD cards we need individual order records (date-level filtering)
      let orders = svOrdersData;
      if (selectedSKU)         orders = orders.filter(o => o.sku === selectedSKU);
      else if (brandSKUs)      orders = orders.filter(o => brandSKUs.has(o.sku));
      // The flat file writes 'Amazon'/'Merchant'; the dropdown uses the
      // AFN/MFN codes. Map both spellings to the codes before comparing.
      if (selectedFulfillment) {
        const toCode = (v) => {
          const s = String(v || '').trim().toLowerCase();
          if (s === 'amazon' || s === 'afn') return 'AFN';
          if (s === 'merchant' || s === 'mfn') return 'MFN';
          return '';
        };
        orders = orders.filter(o => toCode(o.fulfillmentChannel) === selectedFulfillment);
      }

      // For the rolling 13-month chart/list, always aggregate from the
      // full orders array (already filtered by SKU / brand /
      // fulfillment above). The pre-aggregated summary cache
      // (`orders:monthly-summary` in KV) is rebuilt fire-and-forget at
      // the end of each daily sync, but a silent rebuild failure
      // leaves the cache stale and the most recent month invisible
      // — using orders directly avoids that whole class of bug. The
      // single-pass aggregation below is plenty fast even at our
      // record volume (one walk per render, no per-month filter).
      const monthlySource = orders;

      // Determine the anchor: the last day of the selected month, or yesterday
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      let anchor; // always 1st of the "current" month for the rolling window
      let anchorLastDay; // last day of that month (for YTD/MTD end dates)

      if (selectedMonth) {
        // e.g. '2026-04' → anchor = Apr 1 2026. anchorLastDay caps at
        // yesterday when the selected month is the current month so
        // partial-month MTD math doesn't reach into days that have
        // no data yet (data only flows in through yesterday's sync).
        const [y, m] = selectedMonth.split('-').map(Number);
        anchor = new Date(y, m - 1, 1);
        const monthEnd = new Date(y, m, 0);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        anchorLastDay = monthEnd > yesterday ? yesterday : monthEnd;
      } else {
        // Defensive fallback: nav not initialized yet → use yesterday.
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        anchor = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);
        anchorLastDay = yesterday;
      }

      const anchorYear = anchor.getFullYear();
      const anchorMonth = anchor.getMonth(); // 0-indexed
      const previousYear = anchorYear - 1;

      // Format a date as YYYY-MM-DD
      const fmt = d => d.toISOString().split('T')[0];

      // YTD: Jan 1 → anchorLastDay, both years
      const ytdPrevStart = `${previousYear}-01-01`;
      const ytdPrevEnd = `${previousYear}-${String(anchorLastDay.getMonth() + 1).padStart(2, '0')}-${String(anchorLastDay.getDate()).padStart(2, '0')}`;
      const ytdCurrStart = `${anchorYear}-01-01`;
      const ytdCurrEnd = fmt(anchorLastDay);

      // MTD: 1st of anchor month → anchorLastDay, both years
      const mtdMonthStr = String(anchorMonth + 1).padStart(2, '0');
      const mtdPrevStart = `${previousYear}-${mtdMonthStr}-01`;
      const mtdPrevEnd = ytdPrevEnd;
      const mtdCurrStart = `${anchorYear}-${mtdMonthStr}-01`;
      const mtdCurrEnd = ytdCurrEnd;

      // MTD-MoM: same DAY range, prior month within the anchor year.
      // E.g. on May 3 → compare May 1–3 to Apr 1–3. Capped at the
      // prior month's last day so a 31st in the current month doesn't
      // try to query a non-existent Feb 31.
      const prevMonthIdx     = anchorMonth === 0 ? 11 : anchorMonth - 1;
      const prevMonthYear    = anchorMonth === 0 ? anchorYear - 1 : anchorYear;
      const prevMonthLastDay = new Date(prevMonthYear, prevMonthIdx + 1, 0).getDate();
      const anchorDay        = anchorLastDay.getDate();
      const momDayCap        = Math.min(anchorDay, prevMonthLastDay);
      const prevMonthStr     = String(prevMonthIdx + 1).padStart(2, '0');
      const mtdMomPrevStart  = `${prevMonthYear}-${prevMonthStr}-01`;
      const mtdMomPrevEnd    = `${prevMonthYear}-${prevMonthStr}-${String(momDayCap).padStart(2, '0')}`;

      // Calculate YTD
      const ytdPrevOrders = orders.filter(o => o.orderDate >= ytdPrevStart && o.orderDate <= ytdPrevEnd);
      const ytdCurrOrders = orders.filter(o => o.orderDate >= ytdCurrStart && o.orderDate <= ytdCurrEnd);

      const ytdPrevSales = ytdPrevOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const ytdCurrSales = ytdCurrOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const ytdPrevVolume = ytdPrevOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);
      const ytdCurrVolume = ytdCurrOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);

      const ytdSalesChange = ytdPrevSales > 0 ? ((ytdCurrSales - ytdPrevSales) / ytdPrevSales) * 100 : 0;
      const ytdVolumeChange = ytdPrevVolume > 0 ? ((ytdCurrVolume - ytdPrevVolume) / ytdPrevVolume) * 100 : 0;

      // Calculate MTD
      const mtdPrevOrders = orders.filter(o => o.orderDate >= mtdPrevStart && o.orderDate <= mtdPrevEnd);
      const mtdCurrOrders = orders.filter(o => o.orderDate >= mtdCurrStart && o.orderDate <= mtdCurrEnd);

      const mtdPrevSales = mtdPrevOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const mtdCurrSales = mtdCurrOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const mtdPrevVolume = mtdPrevOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);
      const mtdCurrVolume = mtdCurrOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);

      const mtdSalesChange = mtdPrevSales > 0 ? ((mtdCurrSales - mtdPrevSales) / mtdPrevSales) * 100 : 0;
      const mtdVolumeChange = mtdPrevVolume > 0 ? ((mtdCurrVolume - mtdPrevVolume) / mtdPrevVolume) * 100 : 0;

      // MTD-MoM totals — current side reuses the MTD numbers above
      // (same window: 1st of anchor month → anchor day). Prior side
      // is the matching slice of the previous month.
      const mtdMomPrevOrders   = orders.filter(o => o.orderDate >= mtdMomPrevStart && o.orderDate <= mtdMomPrevEnd);
      const mtdMomPrevSales    = mtdMomPrevOrders.reduce((s, o) => s + (o.itemTotal || 0), 0);
      const mtdMomPrevVolume   = mtdMomPrevOrders.reduce((s, o) => s + (o.quantity  || 0), 0);
      const mtdMomCurrSales    = mtdCurrSales;
      const mtdMomCurrVolume   = mtdCurrVolume;
      const mtdMomSalesChange  = mtdMomPrevSales  > 0 ? ((mtdMomCurrSales  - mtdMomPrevSales)  / mtdMomPrevSales)  * 100 : 0;
      const mtdMomVolumeChange = mtdMomPrevVolume > 0 ? ((mtdMomCurrVolume - mtdMomPrevVolume) / mtdMomPrevVolume) * 100 : 0;

      // Update YTD cards
      document.getElementById('ytd-sales-prev-label').textContent = `${previousYear}`;
      document.getElementById('ytd-sales-curr-label').textContent = `${anchorYear}`;
      document.getElementById('ytd-sales-prev').textContent = '$' + ytdPrevSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('ytd-sales-curr').textContent = '$' + ytdCurrSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('ytd-sales-change').textContent = (ytdSalesChange >= 0 ? '+' : '') + ytdSalesChange.toFixed(1) + '%';
      document.getElementById('ytd-sales-change').style.color = ytdSalesChange >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('ytd-volume-prev').textContent = ytdPrevVolume.toLocaleString();
      document.getElementById('ytd-volume-curr').textContent = ytdCurrVolume.toLocaleString();
      document.getElementById('ytd-volume-change').textContent = (ytdVolumeChange >= 0 ? '+' : '') + ytdVolumeChange.toFixed(1) + '%';
      document.getElementById('ytd-volume-change').style.color = ytdVolumeChange >= 0 ? 'var(--success)' : 'var(--error)';

      // Update MTD cards
      const anchorMonthName = monthNames[anchorMonth];
      document.getElementById('mtd-sales-prev-label').textContent = `${anchorMonthName} ${previousYear.toString().slice(2)}`;
      document.getElementById('mtd-sales-curr-label').textContent = `${anchorMonthName} ${anchorYear.toString().slice(2)}`;
      document.getElementById('mtd-sales-prev').textContent = '$' + mtdPrevSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('mtd-sales-curr').textContent = '$' + mtdCurrSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('mtd-sales-change').textContent = (mtdSalesChange >= 0 ? '+' : '') + mtdSalesChange.toFixed(1) + '%';
      document.getElementById('mtd-sales-change').style.color = mtdSalesChange >= 0 ? 'var(--success)' : 'var(--error)';

      // mtd-volume-*-label IDs are no longer rendered in the table — the
      // label cells are shared with the sales row. Guard the updates so the
      // function stays safe if these elements are ever restored.
      const mtdVolPrev = document.getElementById('mtd-volume-prev-label');
      const mtdVolCurr = document.getElementById('mtd-volume-curr-label');
      if (mtdVolPrev) mtdVolPrev.textContent = `${anchorMonthName} ${previousYear.toString().slice(2)}`;
      if (mtdVolCurr) mtdVolCurr.textContent = `${anchorMonthName} ${anchorYear.toString().slice(2)}`;
      document.getElementById('mtd-volume-prev').textContent = mtdPrevVolume.toLocaleString();
      document.getElementById('mtd-volume-curr').textContent = mtdCurrVolume.toLocaleString();
      document.getElementById('mtd-volume-change').textContent = (mtdVolumeChange >= 0 ? '+' : '') + mtdVolumeChange.toFixed(1) + '%';
      document.getElementById('mtd-volume-change').style.color = mtdVolumeChange >= 0 ? 'var(--success)' : 'var(--error)';

      // Update Month-over-Month MTD card. Labels show the full day
      // range (e.g. "Apr 1–3" / "May 1–3") so the user can tell at a
      // glance which calendar slice each row is summing.
      const prevMonthName  = monthNames[prevMonthIdx];
      const momPrevLabel   = `${prevMonthName} 1–${momDayCap}`;
      const momCurrLabel   = `${anchorMonthName} 1–${anchorDay}`;
      document.getElementById('mtd-mom-prev-label').textContent = momPrevLabel;
      document.getElementById('mtd-mom-curr-label').textContent = momCurrLabel;
      document.getElementById('mtd-mom-sales-prev').textContent  = '$' + mtdMomPrevSales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      document.getElementById('mtd-mom-sales-curr').textContent  = '$' + mtdMomCurrSales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      document.getElementById('mtd-mom-volume-prev').textContent = mtdMomPrevVolume.toLocaleString();
      document.getElementById('mtd-mom-volume-curr').textContent = mtdMomCurrVolume.toLocaleString();
      const momSalesEl  = document.getElementById('mtd-mom-sales-change');
      const momVolumeEl = document.getElementById('mtd-mom-volume-change');
      momSalesEl.textContent  = (mtdMomSalesChange  >= 0 ? '+' : '') + mtdMomSalesChange.toFixed(1)  + '%';
      momSalesEl.style.color  = mtdMomSalesChange  >= 0 ? 'var(--success)' : 'var(--error)';
      momVolumeEl.textContent = (mtdMomVolumeChange >= 0 ? '+' : '') + mtdMomVolumeChange.toFixed(1) + '%';
      momVolumeEl.style.color = mtdMomVolumeChange >= 0 ? 'var(--success)' : 'var(--error)';

      // Generate rolling 13 months ending at anchor month
      const months = [];
      for (let i = 12; i >= 0; i--) {
        const d = new Date(anchorYear, anchorMonth - i, 1);
        months.push({
          year: d.getFullYear(),
          month: d.getMonth() + 1,
          label: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
        });
      }

      // Single-pass aggregation: bucket orders by year-month string
      // (e.g. "2026-04"), then look each rolling month up. O(N) over
      // orders + O(13) over the rolling window — much cheaper than
      // 13 separate filter passes the previous code did.
      const byYearMonth = {};
      for (const o of monthlySource) {
        const ym = (o.orderDate || '').slice(0, 7);
        if (!ym) continue;
        if (!byYearMonth[ym]) byYearMonth[ym] = { sales: 0, volume: 0 };
        byYearMonth[ym].sales  += o.itemTotal || 0;
        byYearMonth[ym].volume += o.quantity  || 0;
      }

      // For per-day metrics: full-month days for past months, partial
      // days for the anchor month if it's still in progress (i.e. the
      // user is looking at the current month and we only have data
      // through anchorLastDay). Future months get 0 → per-day stays 0.
      const anchorKey = anchorLastDay.getFullYear() * 100 + (anchorLastDay.getMonth() + 1);
      const daysInMonthCovered = (year, month1) => {
        const ymKey = year * 100 + month1;
        if (ymKey < anchorKey)  return new Date(year, month1, 0).getDate(); // full month
        if (ymKey === anchorKey) return anchorLastDay.getDate();             // partial
        return 0;                                                            // future
      };

      const monthlyData = months.map(m => {
        const ym = `${m.year}-${String(m.month).padStart(2, '0')}`;
        const totals = byYearMonth[ym] || { sales: 0, volume: 0 };
        const days   = daysInMonthCovered(m.year, m.month);
        const salesPerDay  = days > 0 ? totals.sales  / days : 0;
        const volumePerDay = days > 0 ? totals.volume / days : 0;
        return {
          ...m,
          sales: totals.sales,
          volume: totals.volume,
          days,
          salesPerDay,
          volumePerDay
        };
      });

      // Render monthly breakdown as table rows (styled like Profitability Overview tables).
      // Per-day cells use the same color treatment as the cumulative
      // cells so the eye reads each pair (Sales / Sales/Day,
      // Volume / Volume/Day) as related.
      const monthlyList = document.getElementById('monthly-list');
      monthlyList.innerHTML = monthlyData.map(m => `
        <tr>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: center; font-weight: 500;">${m.label}</td>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: center; font-family: 'Roboto Mono', monospace;">$${m.sales.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</td>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: center; font-family: 'Roboto Mono', monospace;">$${m.salesPerDay.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</td>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: center; font-family: 'Roboto Mono', monospace; color: var(--text-secondary);">${m.volume.toLocaleString()}</td>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: center; font-family: 'Roboto Mono', monospace; color: var(--text-secondary);">${m.volumePerDay.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1})}</td>
        </tr>
      `).join('');

      // Render charts. Four total: Sales / Sales-per-Day on the top
      // row, Volume / Volume-per-Day on the bottom (matches the 2×2
      // grid in the HTML).
      if (svSalesChart)        svSalesChart.destroy();
      if (svVolumeChart)       svVolumeChart.destroy();
      if (svSalesPerDayChart)  svSalesPerDayChart.destroy();
      if (svVolumePerDayChart) svVolumePerDayChart.destroy();

      const salesCtx = document.getElementById('sales-chart-sv').getContext('2d');
      svSalesChart = new Chart(salesCtx, {
        type: 'line',
        data: {
          labels: monthlyData.map(m => m.label),
          datasets: [{
            label: 'Sales ($)',
            data: monthlyData.map(m => m.sales),
            borderColor: 'rgb(34, 197, 94)',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          // false so Chart.js fills both dimensions of its flex
          // container instead of squashing to a fixed 2:1 aspect
          // ratio. Container height is now driven by the parent
          // grid row (1fr 1fr) which sizes to match the Monthly
          // Breakdown table's natural height.
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: value => '$' + value.toLocaleString() }
            }
          }
        }
      });

      const volumeCtx = document.getElementById('volume-chart-sv').getContext('2d');
      svVolumeChart = new Chart(volumeCtx, {
        type: 'line',
        data: {
          labels: monthlyData.map(m => m.label),
          datasets: [{
            label: 'Volume (Units)',
            data: monthlyData.map(m => m.volume),
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          // false so Chart.js fills both dimensions of its flex
          // container instead of squashing to a fixed 2:1 aspect
          // ratio. Container height is now driven by the parent
          // grid row (1fr 1fr) which sizes to match the Monthly
          // Breakdown table's natural height.
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: value => value.toLocaleString() }
            }
          }
        }
      });

      // Per-day variants — same colors as the cumulative versions so
      // the eye groups Sales↔Sales/Day and Volume↔Volume/Day, with
      // dollar / number formatting on the y-axis to match.
      const salesPerDayCtx = document.getElementById('sales-per-day-chart-sv').getContext('2d');
      svSalesPerDayChart = new Chart(salesPerDayCtx, {
        type: 'line',
        data: {
          labels: monthlyData.map(m => m.label),
          datasets: [{
            label: 'Sales/Day ($)',
            data: monthlyData.map(m => m.salesPerDay),
            borderColor: 'rgb(34, 197, 94)',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          // false so Chart.js fills both dimensions of its flex
          // container instead of squashing to a fixed 2:1 aspect
          // ratio. Container height is now driven by the parent
          // grid row (1fr 1fr) which sizes to match the Monthly
          // Breakdown table's natural height.
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: value => '$' + value.toLocaleString() }
            }
          }
        }
      });

      const volumePerDayCtx = document.getElementById('volume-per-day-chart-sv').getContext('2d');
      svVolumePerDayChart = new Chart(volumePerDayCtx, {
        type: 'line',
        data: {
          labels: monthlyData.map(m => m.label),
          datasets: [{
            label: 'Volume/Day (Units)',
            data: monthlyData.map(m => m.volumePerDay),
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          // false so Chart.js fills both dimensions of its flex
          // container instead of squashing to a fixed 2:1 aspect
          // ratio. Container height is now driven by the parent
          // grid row (1fr 1fr) which sizes to match the Monthly
          // Breakdown table's natural height.
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: value => value.toLocaleString() }
            }
          }
        }
      });
    }


    function shortenBrandName(brandName) {
      const brandMap = {
        'South of Kings': 'SOK',
        'BrightWay Educational': 'BrightWay',
        'Hubbard Scientific': 'Hubbard',
        'MapShop State Maps': 'State Maps',
        'Kappa': 'Kappa',
        'Other': 'Other'
      };
      return brandMap[brandName] || brandName;
    }

    // ── SALES & VOLUME SUBTABS ────────────────────────────────────────────────

    function showSVTab(tab) {
      document.querySelectorAll('.sv-subtab').forEach(el => el.style.display = 'none');
      document.querySelectorAll('#salesvolume-page .tab').forEach(btn => btn.classList.remove('active'));
      document.getElementById('sv-' + tab).style.display = 'block';
      document.getElementById('sv-tab-' + tab).classList.add('active');

      if (tab === 'priceimpact' && svAllProducts.length > 0) {
        initPCI();
      }
    }

    // ── PRICE CHANGE IMPACTS ──────────────────────────────────────────────────

    // PCI charts stored on window (pciRollingRevChart, pciRollingUnitsChart, pciRollingProfitChart)
    let pciPriceChanges = []; // entries from /api/pricechanges
    let pciSkuMap = {};       // sku -> { brand, productName, transactionFees, fbaFees, avgShipping }
    let pciAllProducts = [];  // full Upstash product list for the Log
                              // form's brand/product dropdowns

    // Centered 7-day rolling average. Used by both PCDA aggregate charts
    // and the Individual Analysis single-SKU charts so the smoothing
    // approach is identical across sub-tabs. Window edges average over
    // fewer than `w` points (the half-window is clipped), so early /
    // late points are smoothed less aggressively — visually unobtrusive
    // and avoids artificial dips at the start/end of the series.
    function _pciRollingAvg(arr, w) {
      const half = Math.floor(w / 2);
      return arr.map((_, i) => {
        const slice = arr.slice(Math.max(0, i - half),
                                Math.min(arr.length, i + half + 1));
        return slice.reduce((a, b) => a + b, 0) / slice.length;
      });
    }

    // Pagination state for the Individual Analysis Summary Table.
    // Reset to page 1 whenever the user changes brand/product filters
    // since the dataset shrinks.
    let _pciPage = 1;
    const _PCI_PAGE_SIZE = 25;

    async function initPCI() {
      if (!accessToken) return;

      try {
        // Both endpoints are Upstash-backed. PriceChanges replaces the
        // legacy Sheets read; Products is the same catalog the rest
        // of the dashboard uses. Always re-fetch on init so an entry
        // added since last load shows up immediately.
        const [pcRes, productsRes] = await Promise.all([
          fetch('/api/pricechanges?action=get', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          }),
          fetch('/api/products?action=get', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          })
        ]);

        if (!pcRes.ok) {
          document.getElementById('pci-table-content').innerHTML =
            '<div style="padding:4rem;text-align:center;color:var(--error);">Failed to load price changes.</div>';
          return;
        }

        const pcData = await pcRes.json();
        // Server returns entries already sorted newest-first with the
        // same fields the rest of the PCI code expects: date, sku,
        // oldPrice, newPrice (plus id for the delete buttons).
        pciPriceChanges = Array.isArray(pcData.entries) ? pcData.entries : [];

        const productsPayload = productsRes.ok ? await productsRes.json() : { products: [] };
        const products = Array.isArray(productsPayload.products) ? productsPayload.products : [];
        pciAllProducts = products;
        pciSkuMap = {};
        for (const p of products) {
          if (!p?.sku) continue;
          // Pull the per-unit cost components out of the catalog so the
          // Avg Profit/Day cards (in both PCDA and Individual Analysis)
          // can compute profit without re-fetching products. Missing /
          // unparseable values default to 0, matching the catalog's
          // normalize behavior — an unfilled product just contributes
          // revenue with no fee deduction.
          pciSkuMap[p.sku] = {
            brand: p.brand || 'Unknown',
            productName: p.name || p.sku,
            transactionFees: Number(p.transactionFees) || 0,
            fbaFees: Number(p.fbaFees) || 0,
            avgShipping: Number(p.avgShipping) || 0
          };
        }

        // Populate the Log Price Change form's brand/product dropdowns.
        _populatePriceChangeForm();

        // Populate the Price Change Day Analysis filter dropdowns. The
        // brand list re-derives from whatever date is selected, so a
        // bare init only needs the date dropdown filled here.
        _populatePCDADateDropdown();
        _populatePCDABrandDropdown();
        // If a date was already picked from a prior session/refresh,
        // re-render with the latest data.
        _renderPCDA();

        renderPCIFilters();
        loadPCITable();

      } catch (err) {
        console.error('PCI init error:', err);
        document.getElementById('pci-table-content').innerHTML =
          `<div style="padding:4rem;text-align:center;color:var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ── LOG PRICE CHANGE FORM ─────────────────────────────────────────────────

    function _populatePriceChangeForm() {
      const brandSel = document.getElementById('pricechange-brand');
      if (!brandSel) return;
      // Brand dropdown: every distinct brand in the catalog. Default
      // option is "All Brands" (no brand filter on the product list).
      const brands = [...new Set(pciAllProducts.map(p => (p.brand || '').trim()).filter(Boolean))].sort();
      brandSel.innerHTML = '<option value="">All Brands</option>' +
        brands.map(b => `<option value="${_pcEsc(b)}">${_pcEsc(b)}</option>`).join('');
      // Trigger product list rebuild (also sets the date picker default).
      filterPriceChangeProducts();

      const dateInput = document.getElementById('pricechange-date');
      if (dateInput && !dateInput.value) {
        dateInput.valueAsDate = new Date();
      }
    }

    function filterPriceChangeProducts() {
      const brandSel = document.getElementById('pricechange-brand');
      const productSel = document.getElementById('pricechange-product');
      if (!brandSel || !productSel) return;
      const brand = brandSel.value;

      // Each option is a single SKU (price-change entries are stored
      // per-SKU). Display label is "Product Name (SKU)" so a user can
      // distinguish FBA vs FBM versions of the same product. Filter by
      // brand if one is selected.
      const filtered = pciAllProducts
        .filter(p => p?.sku && (!brand || (p.brand || '') === brand))
        .filter(p => {
          const asin = (p.asin || '').toString().trim();
          return asin && asin.toUpperCase() !== 'N/A';
        })
        .sort((a, b) => (a.name || a.sku).localeCompare(b.name || b.sku));

      productSel.innerHTML = '<option value="">Select Product...</option>' +
        filtered.map(p => {
          const label = `${p.name || p.sku} (${p.sku})`;
          return `<option value="${_pcEsc(p.sku)}">${_pcEsc(label)}</option>`;
        }).join('');
    }
    window.filterPriceChangeProducts = filterPriceChangeProducts;

    async function savePriceChange() {
      const feedback = document.getElementById('pricechange-save-feedback');
      const showError = (msg) => _pcShowFeedback(feedback, 'error', msg);
      const showSuccess = (msg) => _pcShowFeedback(feedback, 'success', msg);

      if (!accessToken) { showError('⚠ Please sign in to save changes'); return; }

      const sku       = document.getElementById('pricechange-product').value;
      const date      = document.getElementById('pricechange-date').value;
      const oldPrice  = parseFloat(document.getElementById('pricechange-old-price').value);
      const newPrice  = parseFloat(document.getElementById('pricechange-new-price').value);

      if (!sku)                     { showError('⚠ Please select a product'); return; }
      if (!date)                    { showError('⚠ Please select a date');    return; }
      if (!Number.isFinite(oldPrice)) { showError('⚠ Old Price is required'); return; }
      if (!Number.isFinite(newPrice)) { showError('⚠ New Price is required'); return; }

      try {
        const res = await fetch('/api/pricechanges?action=add', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ date, sku, oldPrice, newPrice })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showError('⚠ Failed to save: ' + (err.error || res.status));
          return;
        }
        showSuccess('✓ Price change saved');
        setTimeout(() => { feedback.style.display = 'none'; }, 4000);

        // Clear the form (keep brand/product so the user can quickly
        // log a follow-up for the same SKU). Reset prices + date.
        document.getElementById('pricechange-old-price').value = '';
        document.getElementById('pricechange-new-price').value = '';
        document.getElementById('pricechange-date').valueAsDate = new Date();

        // Reload the data + re-render the table.
        pciPriceChanges = [];
        await initPCI();
      } catch (err) {
        console.error('Save price change failed:', err);
        showError('⚠ Save failed: ' + err.message);
      }
    }
    window.savePriceChange = savePriceChange;

    async function deletePriceChange(id, btn) {
      if (!id || !accessToken) return;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '…';
      }
      try {
        const res = await fetch('/api/pricechanges?action=delete', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Reload + re-render.
        pciPriceChanges = [];
        await initPCI();
      } catch (err) {
        console.error('Delete price change failed:', err);
        if (btn) {
          btn.disabled = false;
          btn.textContent = '×';
        }
      }
    }
    window.deletePriceChange = deletePriceChange;

    // One-time backfill from the legacy PriceChanges Sheet tab. Same
    // pattern as the Listing Change Log's import button — overwrites
    // Upstash with whatever's in the Sheet.
    async function migratePriceChangesFromSheets() {
      const feedback = document.getElementById('pricechange-save-feedback');
      if (!accessToken) { _pcShowFeedback(feedback, 'error', '⚠ Please sign in first'); return; }
      if (typeof SPREADSHEET_ID === 'undefined' || !SPREADSHEET_ID) {
        _pcShowFeedback(feedback, 'error', '⚠ SPREADSHEET_ID is not set');
        return;
      }

      _pcShowFeedback(feedback, 'success', '⏳ Importing from Google Sheet…');
      try {
        const res = await fetch('/api/pricechanges?action=migrate-from-sheets', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          _pcShowFeedback(feedback, 'error', '⚠ Import failed: ' + (err.error || res.status));
          return;
        }
        const data = await res.json();
        _pcShowFeedback(feedback, 'success',
          `✓ Imported ${data.imported} price changes${data.skipped > 0 ? ` (${data.skipped} skipped)` : ''}.`);
        setTimeout(() => { feedback.style.display = 'none'; }, 6000);

        pciPriceChanges = [];
        await initPCI();
      } catch (err) {
        console.error('Migrate price changes failed:', err);
        _pcShowFeedback(feedback, 'error', '⚠ Import failed: ' + err.message);
      }
    }
    window.migratePriceChangesFromSheets = migratePriceChangesFromSheets;

    // ── BULK UPLOAD MODAL ────────────────────────────────────────────────────
    // Mirrors the Listing Change Log bulk-upload flow: drop-zone +
    // CSV parser + preview + post to /api/pricechanges?action=bulk-add.

    let _pcBulkRows = null;

    function openPriceChangeBulkUpload() {
      const modal = document.getElementById('pc-bulk-upload-modal');
      if (!modal) return;
      modal.style.display = 'flex';
      _pcBulkRows = null;
      document.getElementById('pc-bulk-upload-filename').textContent = 'No file selected';
      document.getElementById('pc-bulk-upload-preview').innerHTML = '';
      const fb = document.getElementById('pc-bulk-upload-feedback');
      if (fb) fb.style.display = 'none';
      const file = document.getElementById('pc-bulk-upload-file');
      if (file) file.value = '';
    }
    window.openPriceChangeBulkUpload = openPriceChangeBulkUpload;

    function closePriceChangeBulkUpload() {
      const modal = document.getElementById('pc-bulk-upload-modal');
      if (modal) modal.style.display = 'none';
    }
    window.closePriceChangeBulkUpload = closePriceChangeBulkUpload;

    // Wire up drop-zone + file picker once the page loads. The modal
    // exists in the DOM from the start (display: none); the listeners
    // attach once and don't need to be re-bound when the modal opens.
    document.addEventListener('DOMContentLoaded', () => {
      const dropzone = document.getElementById('pc-bulk-upload-dropzone');
      const fileInput = document.getElementById('pc-bulk-upload-file');
      if (!dropzone || !fileInput) return;

      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--accent-orange)';
        dropzone.style.background = 'rgba(255,255,255,0.02)';
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.style.borderColor = 'var(--border)';
        dropzone.style.background = '';
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--border)';
        dropzone.style.background = '';
        if (e.dataTransfer.files.length > 0) _pcHandleBulkFile(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) _pcHandleBulkFile(e.target.files[0]);
      });
    });

    function _pcHandleBulkFile(file) {
      document.getElementById('pc-bulk-upload-filename').textContent = file.name;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const rows = _pcParseCsv(text);
          if (rows.length < 2) {
            _pcShowFeedback(document.getElementById('pc-bulk-upload-feedback'),
              'error', '⚠ CSV is empty or has only a header row');
            return;
          }
          const header = rows[0].map(c => c.trim().toLowerCase());
          const dateIdx     = header.findIndex(h => h === 'date');
          const skuIdx      = header.findIndex(h => h === 'sku');
          const oldPriceIdx = header.findIndex(h => h === 'old price' || h === 'oldprice');
          const newPriceIdx = header.findIndex(h => h === 'new price' || h === 'newprice');
          if (dateIdx < 0 || skuIdx < 0 || oldPriceIdx < 0 || newPriceIdx < 0) {
            _pcShowFeedback(document.getElementById('pc-bulk-upload-feedback'),
              'error', '⚠ CSV must have columns: Date, SKU, Old Price, New Price');
            return;
          }

          const parsed = [];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.every(c => !c || !c.trim())) continue; // skip blank lines
            const date     = _pcNormalizeDate(row[dateIdx]);
            const sku      = (row[skuIdx] || '').trim();
            const oldPrice = parseFloat((row[oldPriceIdx] || '').replace(/[$,]/g, ''));
            const newPrice = parseFloat((row[newPriceIdx] || '').replace(/[$,]/g, ''));
            if (!date || !sku || !Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) continue;
            parsed.push({ date, sku, oldPrice, newPrice });
          }

          _pcBulkRows = parsed;
          _pcRenderBulkPreview(parsed);
        } catch (err) {
          console.error('CSV parse failed:', err);
          _pcShowFeedback(document.getElementById('pc-bulk-upload-feedback'),
            'error', '⚠ Failed to parse CSV: ' + err.message);
        }
      };
      reader.readAsText(file);
    }

    function _pcRenderBulkPreview(rows) {
      const preview = document.getElementById('pc-bulk-upload-preview');
      if (!preview) return;
      if (rows.length === 0) {
        preview.innerHTML = '<div style="padding: 1rem; color: var(--text-secondary);">No valid rows found</div>';
        return;
      }
      const sample = rows.slice(0, 5);
      let html = `<div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Preview (${rows.length} row${rows.length === 1 ? '' : 's'}, showing first ${sample.length}):</div>`;
      html += '<table style="border-collapse: collapse; font-size: 0.85rem;">';
      html += '<thead><tr style="border-bottom: 1px solid var(--border);"><th style="text-align: left; padding: 0.5rem;">Date</th><th style="text-align: left; padding: 0.5rem;">SKU</th><th style="text-align: right; padding: 0.5rem;">Old</th><th style="text-align: right; padding: 0.5rem;">New</th></tr></thead><tbody>';
      for (const r of sample) {
        html += `<tr style="border-bottom: 1px solid var(--border);"><td style="padding: 0.5rem;">${_pcEsc(r.date)}</td><td style="padding: 0.5rem; font-family: 'Roboto Mono', monospace;">${_pcEsc(r.sku)}</td><td style="padding: 0.5rem; text-align: right;">$${r.oldPrice.toFixed(2)}</td><td style="padding: 0.5rem; text-align: right;">$${r.newPrice.toFixed(2)}</td></tr>`;
      }
      html += '</tbody></table>';
      preview.innerHTML = html;
    }

    async function processPriceChangeBulkUpload() {
      const feedback = document.getElementById('pc-bulk-upload-feedback');
      if (!_pcBulkRows || _pcBulkRows.length === 0) {
        _pcShowFeedback(feedback, 'error', '⚠ No rows to upload');
        return;
      }
      try {
        const res = await fetch('/api/pricechanges?action=bulk-add', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ entries: _pcBulkRows })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          _pcShowFeedback(feedback, 'error', '⚠ Upload failed: ' + (err.error || res.status));
          return;
        }
        const result = await res.json();
        const tail = result.rejectedCount > 0 ? ` (${result.rejectedCount} rejected by server)` : '';
        _pcShowFeedback(feedback, 'success', `✓ Uploaded ${result.added} price change${result.added === 1 ? '' : 's'}${tail}`);
        setTimeout(() => {
          closePriceChangeBulkUpload();
          pciPriceChanges = [];
          initPCI();
        }, 1500);
      } catch (err) {
        console.error('Bulk upload failed:', err);
        _pcShowFeedback(feedback, 'error', '⚠ Upload failed: ' + err.message);
      }
    }
    window.processPriceChangeBulkUpload = processPriceChangeBulkUpload;

    // ── Helper utilities used by the form / bulk / table render ──────────────

    function _pcShowFeedback(el, kind, msg) {
      if (!el) return;
      el.style.display = 'block';
      el.style.padding = '1rem';
      el.style.borderRadius = '6px';
      if (kind === 'error') {
        el.style.background = 'rgba(239, 68, 68, 0.1)';
        el.style.border = '1px solid var(--error)';
        el.style.color = 'var(--error)';
      } else {
        el.style.background = 'rgba(6, 214, 160, 0.1)';
        el.style.border = '1px solid var(--success)';
        el.style.color = 'var(--success)';
      }
      el.textContent = msg;
    }

    function _pcEsc(s) {
      return (s == null ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Lightweight CSV parser — handles quoted fields with embedded
    // commas / newlines / escaped quotes. Plenty for Excel-exported
    // CSVs of price changes.
    function _pcParseCsv(text) {
      const rows = [];
      let row = [];
      let field = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else {
            field += c;
          }
        } else {
          if (c === '"') inQuotes = true;
          else if (c === ',') { row.push(field); field = ''; }
          else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++; // CRLF
            row.push(field); field = '';
            rows.push(row); row = [];
          } else {
            field += c;
          }
        }
      }
      if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
      return rows;
    }

    // Date normalizer: accepts YYYY-MM-DD, M/D/YY, M/D/YYYY, "Apr 30 2026",
    // "Apr 30, 2026", etc. Returns YYYY-MM-DD or null. Mirrors the
    // change-log bulk uploader so the UX is consistent.
    function _pcNormalizeDate(raw) {
      const s = String(raw || '').trim();
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      // M/D/YY or M/D/YYYY
      let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) {
        let y = parseInt(m[3], 10);
        if (y < 100) y += y < 70 ? 2000 : 1900; // 2-digit pivot
        return `${y}-${String(parseInt(m[1], 10)).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
      }
      // "Apr 30, 2026" or "Apr 30 2026"
      m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
      if (m) {
        const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
        const mo = months[m[1].toLowerCase().slice(0, 3)];
        if (mo) return `${m[3]}-${mo}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
      }
      // Fallback to Date parser
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${mo}-${dd}`;
      }
      return null;
    }

    function renderPCIFilters() {
      const brands = [...new Set(
        pciPriceChanges.map(pc => pciSkuMap[pc.sku]?.brand).filter(Boolean)
      )].sort();

      const brandSelect = document.getElementById('pci-brand-filter');
      brandSelect.innerHTML = '<option value="all">All Brands</option>';
      brands.forEach(b => brandSelect.innerHTML += `<option value="${b}">${b}</option>`);

      filterPCIProducts();
    }

    function filterPCIProducts() {
      const selectedBrand = document.getElementById('pci-brand-filter').value;
      const productSelect = document.getElementById('pci-product-filter');

      const productNames = [...new Set(
        pciPriceChanges
          .filter(pc => selectedBrand === 'all' || pciSkuMap[pc.sku]?.brand === selectedBrand)
          .map(pc => pciSkuMap[pc.sku]?.productName)
          .filter(Boolean)
      )].sort();

      productSelect.innerHTML = '<option value="all">All Products</option>';
      productNames.forEach(n => productSelect.innerHTML += `<option value="${n}">${n}</option>`);

      _pciPage = 1; // brand changed → reset Summary Table to page 1
      filterPCIChanges();
    }

    // Pager click for the Individual Summary Table — clamps +
    // re-renders the table only (no chart re-render needed since the
    // data set is unchanged).
    function pciGoToPage(page) {
      const list = window._pciResults || [];
      const totalPages = Math.max(1, Math.ceil(list.length / _PCI_PAGE_SIZE));
      _pciPage = Math.min(Math.max(1, page), totalPages);
      loadPCITable();
    }
    window.pciGoToPage = pciGoToPage;

    // Populates the "Change to Analyze" dropdown filtered by current product selection
    function filterPCIChanges() {
      const productFilter = document.getElementById('pci-product-filter').value;
      const changeSelect = document.getElementById('pci-change-select');
      const windowDays = parseInt(document.getElementById('pci-window').value);

      _pciPage = 1; // dataset will change → reset to page 1

      const filtered = pciPriceChanges.filter(pc => {
        const info = pciSkuMap[pc.sku];
        if (!info) return false;
        if (productFilter !== 'all' && info.productName !== productFilter) return false;
        return true;
      });

      changeSelect.innerHTML = '<option value="">Select a price change...</option>';
      // Store filtered results on window so loadPCITable can use same set
      window._pciFilteredForSelect = filtered;
      filtered.forEach((pc, i) => {
        const name = pciSkuMap[pc.sku]?.productName || pc.sku;
        changeSelect.innerHTML += `<option value="${i}">${pc.date} — ${name} ($${pc.oldPrice.toFixed(2)} → $${pc.newPrice.toFixed(2)})</option>`;
      });

      // Default to the most recent change (index 0 — list is sorted newest first)
      if (filtered.length > 0) changeSelect.value = '0';

      loadPCITable();
    }

    function loadPCITable() {
      const windowDays = parseInt(document.getElementById('pci-window').value);
      const container = document.getElementById('pci-table-content');

      if (!svOrdersData.length) {
        container.innerHTML = '<div style="padding:4rem;text-align:center;color:var(--text-secondary);">No orders data loaded yet. Run a backfill first.</div>';
        return;
      }

      // Use the same filtered+ordered list that the dropdown was built from
      // so that dropdown index i always matches _pciResults[i]
      const changes = window._pciFilteredForSelect || [];

      // Calculate before/after metrics from orders data
      const yesterday = offsetDate(new Date().toISOString().split('T')[0], -1);

      // Build a per-SKU list of all change dates (sorted ascending) for next-change lookup
      const skuChangeDates = {};
      pciPriceChanges.forEach(pc => {
        if (!skuChangeDates[pc.sku]) skuChangeDates[pc.sku] = [];
        skuChangeDates[pc.sku].push(pc.date);
      });
      Object.values(skuChangeDates).forEach(dates => dates.sort());

      const results = changes.map(pc => {
        const changeDate = pc.date;

        // Find the next change for this SKU after this change date
        const nextChange = (skuChangeDates[pc.sku] || []).find(d => d > changeDate) || null;
        // afterEnd = day before next change, or yesterday — whichever is earlier
        const afterEnd = nextChange
          ? (offsetDate(nextChange, -1) < yesterday ? offsetDate(nextChange, -1) : yesterday)
          : yesterday;

        const beforeStart = offsetDate(changeDate, -windowDays);
        const beforeEnd   = offsetDate(changeDate, -1);
        const afterStart  = changeDate;

        const before = calcOrderMetrics(svOrdersData, pc.sku, beforeStart, beforeEnd, windowDays);
        const after  = calcOrderMetrics(svOrdersData, pc.sku, afterStart, afterEnd, windowDays);
        const daysAfter = daysBetween(changeDate, offsetDate(afterEnd, 1)); // exclusive end

        return {
          id: pc.id, // threaded through so the delete button can target it
          date: pc.date,
          sku: pc.sku,
          brand: pciSkuMap[pc.sku]?.brand || 'Unknown',
          productName: pciSkuMap[pc.sku]?.productName || pc.sku,
          oldPrice: pc.oldPrice,
          newPrice: pc.newPrice,
          changePercent: pc.oldPrice > 0 ? ((pc.newPrice - pc.oldPrice) / pc.oldPrice * 100) : 0,
          nextChange,
          afterEnd,
          daysAfter,
          before,
          after
        };
      });

      // Do NOT sort — order must stay identical to _pciFilteredForSelect so dropdown indices match
      window._pciResults = results;

      if (results.length === 0) {
        container.innerHTML = '<div style="padding:4rem;text-align:center;color:var(--text-secondary);">No price changes found for selected filters.</div>';
        return;
      }

      // Pagination — clamp page if the dataset shrunk and slice the
      // results to render. The row's onclick passes `start + i` so it
      // resolves to the full-list index in _pciFilteredForSelect that
      // selectPCIChange / renderPCICharts expect.
      const total      = results.length;
      const totalPages = Math.max(1, Math.ceil(total / _PCI_PAGE_SIZE));
      if (_pciPage > totalPages) _pciPage = totalPages;
      const start      = (_pciPage - 1) * _PCI_PAGE_SIZE;
      const pageRows   = results.slice(start, start + _PCI_PAGE_SIZE);

      // Render table (Revenue + Units only, no Margin/Profit)
      let html = `
        <div style="overflow-x: auto;">
          <table class="data-table" style="font-family:'Roboto Mono',monospace; font-size:0.85rem;">
            <thead>
              <tr>
                <th colspan="6" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">Price Change</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">Before (${windowDays}d)</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">After (since change)</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;">Impact</th>
                <th rowspan="2"></th>
              </tr>
              <tr style="background:var(--bg-secondary);">
                <th style="text-align:left;padding:0.5rem;">Date</th>
                <th style="text-align:left;padding:0.5rem;">Brand</th>
                <th style="text-align:left;padding:0.5rem;">Product</th>
                <th style="text-align:center;padding:0.5rem;">Old $</th>
                <th style="text-align:center;padding:0.5rem;">New $</th>
                <th style="text-align:center;padding:0.5rem;border-right:2px solid var(--border);">Δ%</th>
                <th style="text-align:center;padding:0.5rem;">Revenue/Day</th>
                <th style="text-align:center;padding:0.5rem;border-right:2px solid var(--border);">Units/Day</th>
                <th style="text-align:center;padding:0.5rem;">Revenue/Day</th>
                <th style="text-align:center;padding:0.5rem;border-right:2px solid var(--border);">Units/Day</th>
                <th style="text-align:center;padding:0.5rem;">Revenue Δ</th>
                <th style="text-align:center;padding:0.5rem;">Units Δ</th>
              </tr>
            </thead>
            <tbody>`;

      pageRows.forEach((r, pageIdx) => {
        // `i` is the full-list index in `results` (and equivalently in
        // _pciFilteredForSelect) so the row click resolves correctly
        // even after pagination slicing.
        const i = start + pageIdx;
        // Per-day metrics — windowDays is fixed for the Before period
        // (configured via the Comparison Window dropdown); daysAfter
        // varies per row (1 day if just changed, up to whatever
        // happened until the next change or yesterday).
        const revBeforeDaily   = windowDays > 0  ? r.before.revenue / windowDays : 0;
        const unitsBeforeDaily = windowDays > 0  ? r.before.units   / windowDays : 0;
        const revAfterDaily    = r.daysAfter > 0 ? r.after.revenue  / r.daysAfter : 0;
        const unitsAfterDaily  = r.daysAfter > 0 ? r.after.units    / r.daysAfter : 0;

        // Δ% compares the per-day rates so a 5-day "after" window vs
        // a 30-day "before" window is apples-to-apples (the cumulative
        // ratio would always read negative just because the windows
        // are different lengths).
        const revChange = revBeforeDaily > 0
          ? ((revAfterDaily - revBeforeDaily) / revBeforeDaily * 100) : 0;
        const unitsChange = unitsBeforeDaily > 0
          ? ((unitsAfterDaily - unitsBeforeDaily) / unitsBeforeDaily * 100) : 0;
        const revColor = revChange > 0 ? 'var(--success)' : revChange < 0 ? 'var(--error)' : 'inherit';
        const unitsColor = unitsChange > 0 ? 'var(--success)' : unitsChange < 0 ? 'var(--error)' : 'inherit';
        const rowStyle = `cursor:pointer; transition: background 0.15s;`;

        // Per-row delete button uses event.stopPropagation so clicking
        // it doesn't fire the row's selectPCIChange handler. id is
        // threaded from the API response.
        const deleteBtn = r.id
          ? `<button class="pci-delete-btn" data-id="${_pcEsc(r.id)}" title="Delete this price change" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1.1rem; padding: 0 0.25rem;" onclick="event.stopPropagation(); deletePriceChange('${_pcEsc(r.id)}', this);">×</button>`
          : '';

        html += `
          <tr style="${rowStyle}" onclick="selectPCIChange(${i})" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
            <td style="padding:0.75rem;white-space:nowrap;">${r.date}</td>
            <td style="padding:0.75rem;">${shortenBrandName(r.brand)}</td>
            <td style="padding:0.75rem;">${r.productName}</td>
            <td style="text-align:center;padding:0.75rem;">$${r.oldPrice.toFixed(2)}</td>
            <td style="text-align:center;padding:0.75rem;">$${r.newPrice.toFixed(2)}</td>
            <td style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">${r.changePercent > 0 ? '+' : ''}${r.changePercent.toFixed(1)}%</td>
            <td style="text-align:center;padding:0.75rem;">$${formatNumber(revBeforeDaily)}</td>
            <td style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">${unitsBeforeDaily.toFixed(1)}</td>
            <td style="text-align:center;padding:0.75rem;">$${formatNumber(revAfterDaily)}</td>
            <td style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">${unitsAfterDaily.toFixed(1)}</td>
            <td style="text-align:center;padding:0.75rem;color:${revColor};font-weight:500;">${revChange > 0 ? '+' : ''}${revChange.toFixed(1)}%</td>
            <td style="text-align:center;padding:0.75rem;color:${unitsColor};font-weight:500;">${unitsChange > 0 ? '+' : ''}${unitsChange.toFixed(1)}%</td>
            <td style="text-align:center;padding:0.75rem;">${deleteBtn}</td>
          </tr>`;
      });

      html += `</tbody></table></div>`;

      // Pager — same shape as the Day Analysis list and the Change Log.
      // Hidden when everything fits on one page.
      if (totalPages > 1) {
        const showFrom = total === 0 ? 0 : start + 1;
        const showTo   = Math.min(start + _PCI_PAGE_SIZE, total);
        const btn = (disabled) => `padding: 0.5rem 1rem; background: ${disabled ? 'var(--bg-secondary)' : 'var(--bg-card)'}; border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); cursor: ${disabled ? 'not-allowed' : 'pointer'}; opacity: ${disabled ? '0.5' : '1'};`;
        html += `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 1rem; font-size: 0.875rem; color: var(--text-secondary);">
            <span>Showing ${showFrom}–${showTo} of ${total.toLocaleString()}</span>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <button onclick="pciGoToPage(${_pciPage - 1})" style="${btn(_pciPage <= 1)}" ${_pciPage <= 1 ? 'disabled' : ''}>◀ Prev</button>
              <span>Page ${_pciPage} of ${totalPages}</span>
              <button onclick="pciGoToPage(${_pciPage + 1})" style="${btn(_pciPage >= totalPages)}" ${_pciPage >= totalPages ? 'disabled' : ''}>Next ▶</button>
            </div>
          </div>
        `;
      }

      container.innerHTML = html;

      // If a change was already selected, re-render its charts with the new window
      const currentIdx = document.getElementById('pci-change-select').value;
      if (currentIdx !== '') renderPCICharts();
    }

    function selectPCIChange(index) {
      const changeSelect = document.getElementById('pci-change-select');
      changeSelect.value = index;
      renderPCICharts();
    }

    function renderPCICharts() {
      const index = parseInt(document.getElementById('pci-change-select').value);
      if (isNaN(index) || index === '') return;

      const r = window._pciResults[index];
      const windowDays = parseInt(document.getElementById('pci-window').value);
      if (!r) return;

      // Recalculate metrics fresh using current windowDays
      // "before" = windowDays back; "after" = change date → min(yesterday, day before next change)
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterdayStr = offsetDate(todayStr, -1);
      const beforeStart = offsetDate(r.date, -windowDays);
      const beforeEnd   = offsetDate(r.date, -1);
      const afterStart  = r.date;
      // Re-derive afterEnd using the cached nextChange (window has no effect on after)
      const afterEnd = r.nextChange
        ? (offsetDate(r.nextChange, -1) < yesterdayStr ? offsetDate(r.nextChange, -1) : yesterdayStr)
        : yesterdayStr;

      const freshBefore = calcOrderMetrics(svOrdersData, r.sku, beforeStart, beforeEnd, windowDays);
      const freshAfter  = calcOrderMetrics(svOrdersData, r.sku, afterStart, afterEnd, windowDays);

      // Update summary cards
      const daysBefore = windowDays;
      const daysAfter = r.daysAfter;

      const revBefore   = daysBefore > 0 ? freshBefore.revenue / daysBefore : 0;
      const revAfter    = daysAfter  > 0 ? freshAfter.revenue  / daysAfter  : 0;
      const unitsBefore = daysBefore > 0 ? freshBefore.units   / daysBefore : 0;
      const unitsAfter  = daysAfter  > 0 ? freshAfter.units    / daysAfter  : 0;

      // Profit per day = (period revenue − units × (txFees + fbaFees + avgShipping)) / period days.
      // Fee components pulled from the product catalog via pciSkuMap.
      // FBA-zero avgShipping and FBM-zero fbaFees make this one formula
      // work for both fulfillment channels.
      const info = pciSkuMap[r.sku] || {};
      const feePerUnit = (info.transactionFees || 0) + (info.fbaFees || 0) + (info.avgShipping || 0);
      const profitBeforePeriod = freshBefore.revenue - freshBefore.units * feePerUnit;
      const profitAfterPeriod  = freshAfter.revenue  - freshAfter.units  * feePerUnit;
      const profitBefore = daysBefore > 0 ? profitBeforePeriod / daysBefore : 0;
      const profitAfter  = daysAfter  > 0 ? profitAfterPeriod  / daysAfter  : 0;

      const revChangePct   = revBefore   > 0 ? ((revAfter   - revBefore)   / revBefore   * 100) : 0;
      const unitsChangePct = unitsBefore > 0 ? ((unitsAfter - unitsBefore) / unitsBefore * 100) : 0;
      // Absolute denominator so a swing through zero produces a sane sign.
      const profitChangePct = profitBefore !== 0
        ? ((profitAfter - profitBefore) / Math.abs(profitBefore) * 100) : 0;

      // Price elasticity = (% Δ units) / (% Δ price). Null when no price
      // change. r.changePercent was computed at price-change ingest time
      // (oldPrice → newPrice), so it's safe to consume directly here.
      const elasticity = r.changePercent !== 0 ? (unitsChangePct / r.changePercent) : null;

      // Revenue / profit decomposition. Same math as PCDA but scalar —
      // single SKU, no weighting needed. fees stay constant across the
      // change so priceEffect on profit equals priceEffect on revenue.
      const dUnits = unitsAfter - unitsBefore;
      const priceEffectRev    = (r.newPrice - r.oldPrice) * unitsBefore;
      const volumeEffectRev   = r.newPrice * dUnits;
      const totalRevDelta     = revAfter - revBefore;
      const newMargin = r.newPrice - feePerUnit;
      const priceEffectProfit  = (r.newPrice - r.oldPrice) * unitsBefore;  // = priceEffectRev
      const volumeEffectProfit = newMargin * dUnits;
      const totalProfitDelta   = profitAfter - profitBefore;

      // Self-check parallel to PCDA's.
      const revSelfCheck    = Math.abs(priceEffectRev    + volumeEffectRev    - totalRevDelta);
      const profitSelfCheck = Math.abs(priceEffectProfit + volumeEffectProfit - totalProfitDelta);
      if (revSelfCheck > 0.01 || profitSelfCheck > 0.01) {
        console.warn(`[PCI] Decomposition self-check failed: rev Δ=${revSelfCheck.toFixed(4)}, profit Δ=${profitSelfCheck.toFixed(4)}`);
      }

      document.getElementById('pci-summary-rev-before').textContent = '$' + revBefore.toFixed(2);
      document.getElementById('pci-summary-rev-after').textContent = '$' + revAfter.toFixed(2);
      document.getElementById('pci-summary-rev-change').textContent = (revChangePct >= 0 ? '+' : '') + revChangePct.toFixed(1) + '%';
      document.getElementById('pci-summary-rev-change').style.color = revChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pci-summary-profit-before').textContent = '$' + profitBefore.toFixed(2);
      document.getElementById('pci-summary-profit-after').textContent = '$' + profitAfter.toFixed(2);
      document.getElementById('pci-summary-profit-change').textContent = (profitChangePct >= 0 ? '+' : '') + profitChangePct.toFixed(1) + '%';
      document.getElementById('pci-summary-profit-change').style.color = profitChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pci-summary-units-before').textContent = unitsBefore.toFixed(1);
      document.getElementById('pci-summary-units-after').textContent = unitsAfter.toFixed(1);
      document.getElementById('pci-summary-units-change').textContent = (unitsChangePct >= 0 ? '+' : '') + unitsChangePct.toFixed(1) + '%';
      document.getElementById('pci-summary-units-change').style.color = unitsChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pci-summary-price').textContent = `$${r.oldPrice.toFixed(2)} → $${r.newPrice.toFixed(2)}`;
      document.getElementById('pci-summary-price-pct').textContent = (r.changePercent >= 0 ? '+' : '') + r.changePercent.toFixed(1) + '%';

      // Elasticity card. Same interpretation logic as PCDA's aggregate
      // version; reads cleanly because we have a single SKU's actual
      // % Δ price (r.changePercent) instead of a revenue-weighted avg.
      const pciElasticityEl = document.getElementById('pci-summary-elasticity-value');
      const pciElasticityLabel = document.getElementById('pci-summary-elasticity-label');
      if (elasticity === null) {
        pciElasticityEl.textContent = '—';
        pciElasticityLabel.textContent = 'No price change';
      } else {
        const abs = Math.abs(elasticity);
        pciElasticityEl.textContent = (elasticity >= 0 ? '+' : '') + elasticity.toFixed(2) + '×';
        if (Math.abs(r.changePercent) < 1) {
          pciElasticityLabel.textContent = 'Price moved < 1% — number not reliable';
        } else if (abs < 0.9) {
          pciElasticityLabel.textContent = 'Small volume reaction to price';
        } else if (abs <= 1.1) {
          pciElasticityLabel.textContent = 'Volume tracks price 1:1';
        } else {
          pciElasticityLabel.textContent = 'Big volume reaction to price';
        }
      }

      // Decomposition table — same formatter pattern as PCDA.
      const pciFmtSigned = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
      const pciColorFor = (n) => n >= 0 ? 'var(--success)' : 'var(--error)';
      const setPciBreakdownCell = (id, val) => {
        const el = document.getElementById(id);
        el.textContent = pciFmtSigned(val);
        el.style.color = pciColorFor(val);
      };
      setPciBreakdownCell('pci-summary-breakdown-price-rev',    priceEffectRev);
      setPciBreakdownCell('pci-summary-breakdown-price-profit', priceEffectProfit);
      setPciBreakdownCell('pci-summary-breakdown-vol-rev',      volumeEffectRev);
      setPciBreakdownCell('pci-summary-breakdown-vol-profit',   volumeEffectProfit);
      setPciBreakdownCell('pci-summary-breakdown-total-rev',    totalRevDelta);
      setPciBreakdownCell('pci-summary-breakdown-total-profit', totalProfitDelta);

      document.getElementById('pci-summary-days').textContent = r.daysAfter;
      // Direct id lookup on the label — the stat box no longer wraps
      // in `.card`, so the old `closest('.card').querySelector('div:first-child')`
      // returned null and threw, killing the chart render.
      const daysLabel = document.getElementById('pci-summary-days-label');
      if (r.nextChange) {
        if (daysLabel) daysLabel.textContent = 'Days to Next Change';
        document.getElementById('pci-summary-change-date').textContent = `${r.date} → ${r.nextChange}`;
      } else {
        if (daysLabel) daysLabel.textContent = 'Days Since Change';
        document.getElementById('pci-summary-change-date').textContent = `Changed ${r.date}`;
      }

      // Build daily data series: windowDays before + symmetric after.
      // Daily profit = sum(itemTotal) − feePerUnit × sum(quantity); the
      // feePerUnit was already computed above for the profit card and
      // is reused here so chart and card share one source of truth.
      const startDate = offsetDate(r.date, -windowDays);
      // Symmetric chart: clip the after-period at `windowDays` past the
      // change so the chart's after region is at most as wide as the
      // before region. Cards above still average over the full
      // `afterEnd` (yesterday or pre-next-change), so card numbers
      // don't shift — only the chart visual range narrows for old
      // changes. If `afterEnd` is already closer than the symmetric
      // cap (recent change, or nextChange clipping), the cap is a
      // no-op and the chart shows everything available.
      const endDate = afterEnd <= offsetDate(r.date, windowDays)
                      ? afterEnd
                      : offsetDate(r.date, windowDays);
      const dailyLabels = [];
      const dailyRevenue = [];
      const dailyUnits = [];
      const dailyProfit = [];

      let cursor = startDate;
      while (cursor <= endDate) {
        const dayOrders = svOrdersData.filter(o => o.sku === r.sku && o.orderDate === cursor);
        const dayRev   = dayOrders.reduce((s, o) => s + (o.itemTotal || 0), 0);
        const dayUnits = dayOrders.reduce((s, o) => s + (o.quantity  || 0), 0);
        dailyLabels.push(cursor.slice(5)); // MM-DD
        dailyRevenue.push(dayRev);
        dailyUnits.push(dayUnits);
        dailyProfit.push(dayRev - feePerUnit * dayUnits);
        cursor = offsetDate(cursor, 1);
      }

      const changeIdx = windowDays; // index of change date in the series

      // 7-day centered rolling average via the shared helper. The PCDA
      // chart uses the same function, so smoothing is identical across
      // sub-tabs.
      const rollingRev    = _pciRollingAvg(dailyRevenue, 7);
      const rollingUnits  = _pciRollingAvg(dailyUnits,   7);
      const rollingProfit = _pciRollingAvg(dailyProfit,  7);

      // Counterfactual = before-period daily average extended across
      // the after-period. Null before the change date so Chart.js
      // doesn't draw a misleading slope. Values match the cards'
      // `Before` lines exactly — chart and card visually agree.
      const cfFor = (avg) => dailyLabels.map((_, i) => i >= changeIdx ? avg : null);
      const cfRev    = cfFor(revBefore);
      const cfUnits  = cfFor(unitsBefore);
      const cfProfit = cfFor(profitBefore);

      // Annotation: subtle white dashed vertical line at change date
      const annotationLine = {
        type: 'line',
        xMin: changeIdx - 0.5,
        xMax: changeIdx - 0.5,
        borderColor: 'rgba(255, 255, 255, 0.35)',
        borderWidth: 1.5,
        borderDash: [4, 4]
      };

      const mkOpts = (isCurrency) => ({
        responsive: true,
        plugins: {
          legend: { display: false },
          annotation: { annotations: { changeDay: annotationLine } }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: v => isCurrency ? '$' + v.toLocaleString() : v.toLocaleString() }
          }
        }
      });

      // Two datasets per chart: actual rolling series + counterfactual
      // reference (dashed gray, after-period only).
      const mkDatasets = (rolling, color, counterfactual) => ([
        { data: rolling, borderColor: color, backgroundColor: color.replace('rgb', 'rgba').replace(')', ', 0.1)'), tension: 0.4, pointRadius: 0, borderWidth: 2 },
        { data: counterfactual, borderColor: 'rgba(160, 160, 160, 0.7)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0, tension: 0, spanGaps: false }
      ]);

      // Destroy old charts (now three of them).
      ['pciRollingRevChart','pciRollingUnitsChart','pciRollingProfitChart'].forEach(k => {
        if (window[k]) { window[k].destroy(); window[k] = null; }
      });

      window.pciRollingRevChart = new Chart(document.getElementById('pci-rolling-rev-chart').getContext('2d'), {
        type: 'line',
        data: { labels: dailyLabels, datasets: mkDatasets(rollingRev, 'rgb(34, 197, 94)', cfRev) },
        options: mkOpts(true)
      });

      window.pciRollingUnitsChart = new Chart(document.getElementById('pci-rolling-units-chart').getContext('2d'), {
        type: 'line',
        data: { labels: dailyLabels, datasets: mkDatasets(rollingUnits, 'rgb(59, 130, 246)', cfUnits) },
        options: mkOpts(false)
      });

      window.pciRollingProfitChart = new Chart(document.getElementById('pci-rolling-profit-chart').getContext('2d'), {
        type: 'line',
        data: { labels: dailyLabels, datasets: mkDatasets(rollingProfit, 'rgb(168, 85, 247)', cfProfit) },
        options: mkOpts(true)
      });
    }

    // ── PCI SUB-TABS ─────────────────────────────────────────────────────────
    // The Price Change Impacts tab has two analysis modes — "Price Change
    // Day Analysis" (date-first aggregate) and "Individual Price Change
    // Analysis" (single-change drill-in). Bulk Export sits above as a
    // separate concern. Switching sub-tabs re-renders the now-visible
    // panel so any chart whose canvas was 0×0 at instantiation (because
    // the parent was hidden) picks up real dimensions.
    function showPCISubtab(name) {
      const dayView = document.getElementById('pci-day-view');
      const indView = document.getElementById('pci-individual-view');
      const dayBtn  = document.getElementById('pci-subtab-day');
      const indBtn  = document.getElementById('pci-subtab-individual');
      if (!dayView || !indView) return;

      const showingDay = name === 'day';
      dayView.style.display = showingDay ? 'block' : 'none';
      indView.style.display = showingDay ? 'none'  : 'block';
      if (dayBtn) dayBtn.classList.toggle('active', showingDay);
      if (indBtn) indBtn.classList.toggle('active', !showingDay);

      // Re-render whichever view we just revealed. If the user switched
      // to Individual and a change is already selected, re-fire
      // renderPCICharts so the rolling-avg chart canvases (which may
      // have been 0×0 while the view was hidden) draw against fresh
      // dimensions. Same for Day → re-run _renderPCDA if a date is
      // picked.
      if (showingDay) {
        _renderPCDA();
      } else {
        const sel = document.getElementById('pci-change-select');
        if (sel && sel.value !== '') renderPCICharts();
      }
    }
    window.showPCISubtab = showPCISubtab;

    // ── PRICE CHANGE DAY ANALYSIS ────────────────────────────────────────────
    // "What was the aggregate impact of all the price changes we made on
    // this date?" Sits between Bulk Export (range, CSV out) and
    // Individual Analysis (single-change drill-in). Pick a date → brand
    // dropdown narrows to brands with changes on that date → stats +
    // chart + compact list aggregate across the matched SKUs.

    // Two separate Chart.js instances — Revenue and Units shown
    // side-by-side rather than dual-axis on a single canvas (matches
    // the Individual Analysis presentation).
    let _pcdaRevChart = null;
    let _pcdaUnitsChart = null;
    let _pcdaProfitChart = null;

    // Pagination state for the Day Analysis compact list. 25/page
    // matches the Listing Change History pager. Reset to page 1 on
    // any filter change so the user doesn't get stranded on an empty
    // page when the filtered set shrinks.
    let _pcdaPage = 1;
    const _PCDA_PAGE_SIZE = 25;

    function _populatePCDADateDropdown() {
      const sel = document.getElementById('pcda-date');
      if (!sel) return;
      // Distinct change dates, newest first. Empty if no entries yet.
      const dates = [...new Set(pciPriceChanges.map(pc => pc.date))]
        .filter(Boolean)
        .sort()
        .reverse();
      const current = sel.value;
      sel.innerHTML = '<option value="">Select a date…</option>' +
        dates.map(d => `<option value="${_pcEsc(d)}">${_pcEsc(d)}</option>`).join('');
      // Preserve a valid prior selection; otherwise default to the
      // most recent change date so the user lands on a populated view
      // instead of an empty dropdown.
      if (dates.includes(current))    sel.value = current;
      else if (dates.length > 0)      sel.value = dates[0];
    }

    function _populatePCDABrandDropdown() {
      const dateSel  = document.getElementById('pcda-date');
      const brandSel = document.getElementById('pcda-brand');
      if (!dateSel || !brandSel) return;
      const date = dateSel.value;
      const current = brandSel.value;
      if (!date) {
        brandSel.innerHTML = '<option value="all">All Brands</option>';
        return;
      }
      // Only brands that actually had a change on the picked date —
      // otherwise the dropdown lists brands the user can't usefully
      // pick (would yield zero matches).
      const brands = [...new Set(
        pciPriceChanges
          .filter(pc => pc.date === date)
          .map(pc => pciSkuMap[pc.sku]?.brand)
          .filter(Boolean)
      )].sort();
      brandSel.innerHTML = '<option value="all">All Brands</option>' +
        brands.map(b => `<option value="${_pcEsc(b)}">${_pcEsc(b)}</option>`).join('');
      if (current !== 'all' && brands.includes(current)) brandSel.value = current;
      else                                               brandSel.value = 'all';
    }

    function pcdaOnDateChange() {
      _populatePCDABrandDropdown();
      _pcdaPage = 1; // filter changed → start at page 1
      _renderPCDA();
    }
    window.pcdaOnDateChange = pcdaOnDateChange;

    function pcdaOnFilterChange() {
      _pcdaPage = 1;
      _renderPCDA();
    }
    window.pcdaOnFilterChange = pcdaOnFilterChange;

    // Pager click — clamps to valid range and re-renders the list only
    // (no need to recompute aggregates or re-fire charts since the
    // filter set didn't change).
    function pcdaGoToPage(page) {
      const list = window._pcdaMatched || [];
      const totalPages = Math.max(1, Math.ceil(list.length / _PCDA_PAGE_SIZE));
      _pcdaPage = Math.min(Math.max(1, page), totalPages);
      _renderPCDAList(list);
    }
    window.pcdaGoToPage = pcdaGoToPage;

    async function _renderPCDA() {
      const date  = document.getElementById('pcda-date').value;
      const brand = document.getElementById('pcda-brand').value;
      const windowDays = parseInt(document.getElementById('pcda-window').value, 10) || 30;
      const stats = document.getElementById('pcda-stats');
      const chartWrap = document.getElementById('pcda-chart-wrapper');
      const list  = document.getElementById('pcda-list');

      // Empty state — hide everything if no date is picked. The
      // breakdown lives inside #pcda-stats now, so hiding stats also
      // hides it; no separate breakdown toggle needed.
      if (!date) {
        stats.style.display = 'none';
        chartWrap.style.display = 'none';
        list.innerHTML = '';
        if (_pcdaChart) { _pcdaChart.destroy(); _pcdaChart = null; }
        return;
      }

      const matched = pciPriceChanges.filter(pc => {
        if (pc.date !== date) return false;
        if (brand !== 'all' && pciSkuMap[pc.sku]?.brand !== brand) return false;
        return true;
      });
      // Cache the filtered set so the pager click handler can re-render
      // the list without recomputing aggregates.
      window._pcdaMatched = matched;

      if (matched.length === 0) {
        stats.style.display = 'none';
        chartWrap.style.display = 'none';
        list.innerHTML = '<div style="padding: 1rem; color: var(--text-secondary);">No price changes match these filters.</div>';
        if (_pcdaChart) { _pcdaChart.destroy(); _pcdaChart = null; }
        return;
      }

      // Compute aggregates. Before/After windows are uniform here since
      // every matched change has the same date.
      const yesterday = offsetDate(new Date().toISOString().split('T')[0], -1);
      const beforeStart = offsetDate(date, -windowDays);
      const beforeEnd   = offsetDate(date, -1);
      const afterStart  = date;
      const afterEnd    = yesterday;
      const daysAfter   = daysBetween(date, offsetDate(afterEnd, 1));

      let revBefore = 0, unitsBefore = 0, revAfter = 0, unitsAfter = 0;
      // Profit aggregates. Per-SKU per-period profit =
      //   revenue − units × (transactionFees + fbaFees + avgShipping)
      // Fee totals come from the product catalog. avgShipping is FBA-zero
      // and fbaFees is FBM-zero (per user catalog convention), so the
      // single formula works regardless of fulfillment channel.
      let profitBefore = 0, profitAfter = 0;
      // Net price change %, weighted by before-period revenue so a
      // dead-stock SKU doesn't drown the average. Falls back to equal
      // weighting if nothing sold in the before window.
      let oldWeighted = 0, newWeighted = 0, weights = 0;
      // Weighted-average fee across matched SKUs — used by the profit
      // decomposition below so the aggregate margin reflects the actual
      // SKU mix rather than an unweighted average.
      let feeWeighted = 0;

      for (const pc of matched) {
        const before = calcOrderMetrics(svOrdersData, pc.sku, beforeStart, beforeEnd, windowDays);
        const after  = calcOrderMetrics(svOrdersData, pc.sku, afterStart,  afterEnd,  windowDays);
        revBefore   += before.revenue;
        unitsBefore += before.units;
        revAfter    += after.revenue;
        unitsAfter  += after.units;

        const info = pciSkuMap[pc.sku] || {};
        const feePerUnit = (info.transactionFees || 0) + (info.fbaFees || 0) + (info.avgShipping || 0);
        profitBefore += before.revenue - before.units * feePerUnit;
        profitAfter  += after.revenue  - after.units  * feePerUnit;

        const w = before.revenue > 0 ? before.revenue : 1;
        oldWeighted += pc.oldPrice * w;
        newWeighted += pc.newPrice * w;
        feeWeighted += feePerUnit  * w;
        weights     += w;
      }

      const revBeforeDaily    = windowDays > 0  ? revBefore    / windowDays : 0;
      const unitsBeforeDaily  = windowDays > 0  ? unitsBefore  / windowDays : 0;
      const profitBeforeDaily = windowDays > 0  ? profitBefore / windowDays : 0;
      const revAfterDaily     = daysAfter  > 0  ? revAfter     / daysAfter  : 0;
      const unitsAfterDaily   = daysAfter  > 0  ? unitsAfter   / daysAfter  : 0;
      const profitAfterDaily  = daysAfter  > 0  ? profitAfter  / daysAfter  : 0;
      const revChangePct = revBeforeDaily > 0
        ? ((revAfterDaily - revBeforeDaily) / revBeforeDaily * 100) : 0;
      const unitsChangePct = unitsBeforeDaily > 0
        ? ((unitsAfterDaily - unitsBeforeDaily) / unitsBeforeDaily * 100) : 0;
      // Profit % change uses absolute denominator so a swing through zero
      // (e.g. before = -$5, after = +$10) doesn't produce a weird sign.
      const profitChangePct = profitBeforeDaily !== 0
        ? ((profitAfterDaily - profitBeforeDaily) / Math.abs(profitBeforeDaily) * 100) : 0;

      const oldAvg = weights > 0 ? oldWeighted / weights : 0;
      const newAvg = weights > 0 ? newWeighted / weights : 0;
      const feeAvg = weights > 0 ? feeWeighted / weights : 0;
      const netChangePct = oldAvg > 0 ? ((newAvg - oldAvg) / oldAvg * 100) : 0;

      // Price elasticity = (% Δ units) / (% Δ price). Null when the
      // denominator is zero (no net price change → elasticity undefined).
      // Tiny price changes (<1%) produce wildly amplified elasticities
      // from noise; flag those in the sub-label rather than hide them.
      const elasticity = netChangePct !== 0 ? (unitsChangePct / netChangePct) : null;

      // Revenue / profit decomposition.
      //   priceEffect  = (Δprice) × old daily units    (revenue-side; for
      //                  profit it's (Δmargin) × old daily units, but
      //                  Δmargin == Δprice since fees are constant)
      //   volumeEffect = new price × (Δ daily units)   (revenue-side)
      //                = new margin × (Δ daily units)  (profit-side)
      // Together they should sum to (afterDaily − beforeDaily) within
      // floating-point noise. We compute the observed totals separately
      // and self-check at the bottom.
      const dUnitsDaily = unitsAfterDaily - unitsBeforeDaily;
      const priceEffectRev    = (newAvg - oldAvg) * unitsBeforeDaily;
      const volumeEffectRev   = newAvg * dUnitsDaily;
      const totalRevDelta     = revAfterDaily - revBeforeDaily;
      const newMargin = newAvg - feeAvg;
      const priceEffectProfit  = (newAvg - oldAvg) * unitsBeforeDaily;  // = priceEffectRev (fees constant)
      const volumeEffectProfit = newMargin * dUnitsDaily;
      const totalProfitDelta   = profitAfterDaily - profitBeforeDaily;

      // Self-check: warn (don't throw) if decomposition doesn't sum to
      // observed delta within a penny per day. Either side is suspect
      // when this fires.
      const revSelfCheck    = Math.abs(priceEffectRev    + volumeEffectRev    - totalRevDelta);
      const profitSelfCheck = Math.abs(priceEffectProfit + volumeEffectProfit - totalProfitDelta);
      if (revSelfCheck > 0.01 || profitSelfCheck > 0.01) {
        console.warn(`[PCDA] Decomposition self-check failed: rev Δ=${revSelfCheck.toFixed(4)}, profit Δ=${profitSelfCheck.toFixed(4)}`);
      }

      // Stats
      document.getElementById('pcda-rev-before').textContent  = '$' + formatNumber(revBeforeDaily);
      document.getElementById('pcda-rev-after').textContent   = '$' + formatNumber(revAfterDaily);
      const revChangeEl = document.getElementById('pcda-rev-change');
      revChangeEl.textContent = (revChangePct >= 0 ? '+' : '') + revChangePct.toFixed(1) + '%';
      revChangeEl.style.color = revChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pcda-profit-before').textContent = '$' + formatNumber(profitBeforeDaily);
      document.getElementById('pcda-profit-after').textContent  = '$' + formatNumber(profitAfterDaily);
      const profitChangeEl = document.getElementById('pcda-profit-change');
      profitChangeEl.textContent = (profitChangePct >= 0 ? '+' : '') + profitChangePct.toFixed(1) + '%';
      profitChangeEl.style.color = profitChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pcda-units-before').textContent = unitsBeforeDaily.toFixed(1);
      document.getElementById('pcda-units-after').textContent  = unitsAfterDaily.toFixed(1);
      const unitsChangeEl = document.getElementById('pcda-units-change');
      unitsChangeEl.textContent = (unitsChangePct >= 0 ? '+' : '') + unitsChangePct.toFixed(1) + '%';
      unitsChangeEl.style.color = unitsChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pcda-skus-count').textContent  = matched.length;
      document.getElementById('pcda-skus-detail').textContent =
        `${daysAfter} day${daysAfter === 1 ? '' : 's'} of after-data`;

      const netEl = document.getElementById('pcda-net-change');
      netEl.textContent = (netChangePct >= 0 ? '+' : '') + netChangePct.toFixed(1) + '%';
      netEl.style.color = netChangePct >= 0 ? 'var(--accent-orange)' : 'var(--accent-blue)';
      document.getElementById('pcda-net-change-detail').textContent =
        `$${oldAvg.toFixed(2)} → $${newAvg.toFixed(2)} (revenue-weighted)`;

      // Days Since Change — straightforward calendar-day count from
      // the picked change date to today. `daysAfter` (used in stats
      // above) caps at yesterday for "days of after-data"; this card
      // shows the human-meaningful "how long ago was this".
      const today = new Date().toISOString().split('T')[0];
      const daysSince = daysBetween(date, today);
      document.getElementById('pcda-days-since').textContent = daysSince;
      document.getElementById('pcda-days-since-detail').textContent = `Changed ${date}`;

      // Elasticity card. `—` when undefined (no price change). Sub-label
      // translates the number for non-analysts. When the price change
      // is tiny (<1%), the elasticity is signal-vs-noise unreliable —
      // surface that explicitly rather than show a misleading "−12.4×".
      const elasticityEl = document.getElementById('pcda-elasticity-value');
      const elasticityLabel = document.getElementById('pcda-elasticity-label');
      if (elasticity === null) {
        elasticityEl.textContent = '—';
        elasticityLabel.textContent = 'No net price change';
      } else {
        const abs = Math.abs(elasticity);
        elasticityEl.textContent = (elasticity >= 0 ? '+' : '') + elasticity.toFixed(2) + '×';
        if (Math.abs(netChangePct) < 1) {
          elasticityLabel.textContent = 'Price moved < 1% — number not reliable';
        } else if (abs < 0.9) {
          elasticityLabel.textContent = 'Small volume reaction to price';
        } else if (abs <= 1.1) {
          elasticityLabel.textContent = 'Volume tracks price 1:1';
        } else {
          elasticityLabel.textContent = 'Big volume reaction to price';
        }
      }

      // Decomposition table. Color each cell by sign.
      const fmtSigned = (n) => (n >= 0 ? '+$' : '-$') + formatNumber(Math.abs(n));
      const colorFor = (n) => n >= 0 ? 'var(--success)' : 'var(--error)';
      const setBreakdownCell = (id, val) => {
        const el = document.getElementById(id);
        el.textContent = fmtSigned(val);
        el.style.color = colorFor(val);
      };
      setBreakdownCell('pcda-breakdown-price-rev',     priceEffectRev);
      setBreakdownCell('pcda-breakdown-price-profit',  priceEffectProfit);
      setBreakdownCell('pcda-breakdown-vol-rev',       volumeEffectRev);
      setBreakdownCell('pcda-breakdown-vol-profit',    volumeEffectProfit);
      setBreakdownCell('pcda-breakdown-total-rev',     totalRevDelta);
      setBreakdownCell('pcda-breakdown-total-profit',  totalProfitDelta);
      // The breakdown lives inside #pcda-stats now (analytics row), so
      // showing/hiding #pcda-stats also shows/hides the breakdown — no
      // separate toggle needed.

      // #pcda-stats wraps two flex rows; set its display to `block`
      // (not `flex`) so the rows stack normally and each row's own
      // `display: flex` handles its inner card layout.
      stats.style.display = 'block';

      // Compact list (drives drill-through to Individual Analysis).
      _renderPCDAList(matched);

      // Chart — needs the wrapper visible BEFORE Chart.js measures the
      // canvas (otherwise it latches onto 0×0). One rAF for layout to
      // settle after the display flip; same trick used on Sessions.
      chartWrap.style.display = 'block';
      await new Promise(r => requestAnimationFrame(r));
      // Symmetric chart: cap the after-period at `windowDays` past the
      // change so both sides of the change line get equal visual weight.
      // Cards above still use the full `afterEnd` (yesterday) for their
      // averages — that's unchanged. Picking a wider window expands both
      // the baseline AND the post-change comparison horizon.
      const chartAfterEnd = afterEnd <= offsetDate(date, windowDays)
                            ? afterEnd
                            : offsetDate(date, windowDays);
      // Pass the before-period daily averages so the chart can draw the
      // counterfactual reference line at the exact same value the cards
      // show as "Before" — chart and cards visually agree.
      _renderPCDAChart(matched, date, beforeStart, chartAfterEnd, {
        revBeforeDaily, unitsBeforeDaily, profitBeforeDaily
      });
    }

    function _renderPCDAChart(matched, changeDate, startDate, endDate, beforeAvgs) {
      // Build summed daily series across all matched SKUs over the
      // symmetric chart window (startDate..endDate, capped at
      // change_date + windowDays by the caller). One pass over
      // svOrdersData filtered to the matched SKUs — much cheaper
      // than per-day queries when there are many SKUs.
      const skuSet = new Set(matched.map(pc => pc.sku));

      // Pre-build per-SKU fee lookup so the profit series can be summed
      // in the same pass as revenue and units. avgShipping is FBA-zero
      // and fbaFees is FBM-zero per the catalog convention, so this
      // single formula covers both fulfillment channels.
      const feeBySku = {};
      for (const pc of matched) {
        const info = pciSkuMap[pc.sku] || {};
        feeBySku[pc.sku] = (info.transactionFees || 0)
                         + (info.fbaFees || 0)
                         + (info.avgShipping || 0);
      }

      const dailyRev    = {};
      const dailyUnits  = {};
      const dailyProfit = {};
      let cursor = startDate;
      while (cursor <= endDate) {
        dailyRev[cursor] = 0;
        dailyUnits[cursor] = 0;
        dailyProfit[cursor] = 0;
        cursor = offsetDate(cursor, 1);
      }
      for (const o of svOrdersData) {
        if (!skuSet.has(o.sku)) continue;
        if (o.orderDate < startDate || o.orderDate > endDate) continue;
        if (dailyRev[o.orderDate] != null) {
          const rev = o.itemTotal || 0;
          const qty = o.quantity  || 0;
          dailyRev[o.orderDate]    += rev;
          dailyUnits[o.orderDate]  += qty;
          dailyProfit[o.orderDate] += rev - (feeBySku[o.sku] || 0) * qty;
        }
      }

      const dates = Object.keys(dailyRev).sort();
      const labels = dates.map(d => d.slice(5)); // MM-DD
      // Apply honest 7-day rolling smoothing (matches the Individual
      // Analysis charts). The previous version used Chart.js's
      // `tension: 0.4` which is just visual curve-fitting through noisy
      // daily points — looked smooth but lied about the underlying data.
      const revDataDaily    = dates.map(d => dailyRev[d]);
      const unitsDataDaily  = dates.map(d => dailyUnits[d]);
      const profitDataDaily = dates.map(d => dailyProfit[d]);
      const revData    = _pciRollingAvg(revDataDaily,    7);
      const unitsData  = _pciRollingAvg(unitsDataDaily,  7);
      const profitData = _pciRollingAvg(profitDataDaily, 7);

      // Counterfactual = the before-period average extended across the
      // after-period. Null before the change date so the line only
      // appears on the after side, where its visual gap from the actual
      // series is the price change's impact. Uses the same averages the
      // cards show, so chart and cards visually agree.
      const changeIdx = dates.indexOf(changeDate);
      const cfFor = (avg) => dates.map((_, i) => (changeIdx >= 0 && i >= changeIdx) ? avg : null);
      const cfRev    = cfFor((beforeAvgs && beforeAvgs.revBeforeDaily)    || 0);
      const cfUnits  = cfFor((beforeAvgs && beforeAvgs.unitsBeforeDaily)  || 0);
      const cfProfit = cfFor((beforeAvgs && beforeAvgs.profitBeforeDaily) || 0);

      // Mark the change date with a vertical dashed line. The label
      // uses MM-DD form (matching the axis labels). Same annotation
      // shape applied to all three charts.
      const annotations = {
        changeLine: {
          type: 'line',
          xMin: changeDate.slice(5),
          xMax: changeDate.slice(5),
          borderColor: 'rgba(255, 99, 132, 0.8)',
          borderWidth: 2,
          borderDash: [5, 5]
        }
      };

      const mkOpts = (isCurrency) => ({
        responsive: true,
        plugins: {
          legend: { display: false },
          annotation: { annotations }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: v => isCurrency ? '$' + Number(v).toLocaleString() : Number(v).toLocaleString()
            }
          }
        }
      });

      // Two datasets per chart: the actual rolling-avg series and the
      // counterfactual reference line (dashed gray). Counterfactual is
      // a flat horizontal line over the after-period; nulls before the
      // change date keep Chart.js from drawing a misleading slope.
      const mkDatasets = (data, color, counterfactual) => [
        {
          data,
          borderColor: color,
          backgroundColor: color.replace('rgb', 'rgba').replace(')', ', 0.1)'),
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2
        },
        {
          data: counterfactual,
          borderColor: 'rgba(160, 160, 160, 0.7)',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0,
          spanGaps: false
        }
      ];

      if (_pcdaRevChart)    { _pcdaRevChart.destroy();    _pcdaRevChart = null; }
      if (_pcdaUnitsChart)  { _pcdaUnitsChart.destroy();  _pcdaUnitsChart = null; }
      if (_pcdaProfitChart) { _pcdaProfitChart.destroy(); _pcdaProfitChart = null; }

      _pcdaRevChart = new Chart(
        document.getElementById('pcda-rev-chart').getContext('2d'),
        { type: 'line', data: { labels, datasets: mkDatasets(revData, 'rgb(255, 159, 64)', cfRev) }, options: mkOpts(true) }
      );
      _pcdaUnitsChart = new Chart(
        document.getElementById('pcda-units-chart').getContext('2d'),
        { type: 'line', data: { labels, datasets: mkDatasets(unitsData, 'rgb(54, 162, 235)', cfUnits) }, options: mkOpts(false) }
      );
      _pcdaProfitChart = new Chart(
        document.getElementById('pcda-profit-chart').getContext('2d'),
        { type: 'line', data: { labels, datasets: mkDatasets(profitData, 'rgb(168, 85, 247)', cfProfit) }, options: mkOpts(true) }
      );
    }

    function _renderPCDAList(matched) {
      const container = document.getElementById('pcda-list');
      if (!container) return;
      // Sort by absolute price change %, biggest movement first — most
      // interesting to see at the top.
      const sorted = [...matched].sort((a, b) => {
        const ap = a.oldPrice > 0 ? Math.abs((a.newPrice - a.oldPrice) / a.oldPrice) : 0;
        const bp = b.oldPrice > 0 ? Math.abs((b.newPrice - b.oldPrice) / b.oldPrice) : 0;
        return bp - ap;
      });

      // Pagination — clamp page if the dataset shrunk (e.g., user
      // narrowed the brand filter and now there are fewer rows).
      const total      = sorted.length;
      const totalPages = Math.max(1, Math.ceil(total / _PCDA_PAGE_SIZE));
      if (_pcdaPage > totalPages) _pcdaPage = totalPages;
      const start      = (_pcdaPage - 1) * _PCDA_PAGE_SIZE;
      const pageRows   = sorted.slice(start, start + _PCDA_PAGE_SIZE);

      let html = '<div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Changes included (' + total + '):</div>';
      html += '<table style="border-collapse: collapse; font-size: 0.85rem;">';
      html += '<thead><tr style="background: var(--bg-secondary);">';
      html += '<th style="text-align: left;  padding: 0.5rem 0.75rem;">Brand</th>';
      html += '<th style="text-align: left;  padding: 0.5rem 0.75rem;">Product</th>';
      html += '<th style="text-align: right; padding: 0.5rem 0.75rem;">Old → New</th>';
      html += '<th style="text-align: right; padding: 0.5rem 0.75rem;">Δ%</th>';
      html += '</tr></thead><tbody>';

      for (const pc of pageRows) {
        const info = pciSkuMap[pc.sku] || {};
        const pct  = pc.oldPrice > 0 ? ((pc.newPrice - pc.oldPrice) / pc.oldPrice * 100) : 0;
        const color = pct >= 0 ? 'var(--success)' : 'var(--error)';
        html += '<tr style="border-bottom: 1px solid var(--border);">';
        html += `<td style="padding: 0.5rem 0.75rem;">${_pcEsc(shortenBrandName(info.brand || 'Unknown'))}</td>`;
        html += `<td style="padding: 0.5rem 0.75rem;">${_pcEsc(info.productName || pc.sku)}</td>`;
        html += `<td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; white-space: nowrap;">$${pc.oldPrice.toFixed(2)} → $${pc.newPrice.toFixed(2)}</td>`;
        html += `<td style="padding: 0.5rem 0.75rem; text-align: right; color: ${color}; font-weight: 500;">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</td>`;
        html += '</tr>';
      }
      html += '</tbody></table>';

      // Prev / "Page X of Y · Showing N–M of T" / Next. Hidden when
      // everything fits on one page. Same shape as the Listing Change
      // Log pager.
      if (totalPages > 1) {
        const showFrom = total === 0 ? 0 : start + 1;
        const showTo   = Math.min(start + _PCDA_PAGE_SIZE, total);
        const btn = (disabled) => `padding: 0.5rem 1rem; background: ${disabled ? 'var(--bg-secondary)' : 'var(--bg-card)'}; border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); cursor: ${disabled ? 'not-allowed' : 'pointer'}; opacity: ${disabled ? '0.5' : '1'};`;
        html += `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 1rem; font-size: 0.875rem; color: var(--text-secondary);">
            <span>Showing ${showFrom}–${showTo} of ${total.toLocaleString()}</span>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <button onclick="pcdaGoToPage(${_pcdaPage - 1})" style="${btn(_pcdaPage <= 1)}" ${_pcdaPage <= 1 ? 'disabled' : ''}>◀ Prev</button>
              <span>Page ${_pcdaPage} of ${totalPages}</span>
              <button onclick="pcdaGoToPage(${_pcdaPage + 1})" style="${btn(_pcdaPage >= totalPages)}" ${_pcdaPage >= totalPages ? 'disabled' : ''}>Next ▶</button>
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
    }

    // Returns { revenue, units } for a SKU within a date range from orders data
    function calcOrderMetrics(orders, sku, startDate, endDate, windowDays) {
      const filtered = orders.filter(o => o.sku === sku && o.orderDate >= startDate && o.orderDate <= endDate);
      return {
        revenue: filtered.reduce((s, o) => s + (o.itemTotal || 0), 0),
        units: filtered.reduce((s, o) => s + (o.quantity || 0), 0)
      };
    }

    // Returns a YYYY-MM-DD string offset by N days from a YYYY-MM-DD string
    function offsetDate(dateStr, days) {
      const d = new Date(dateStr + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().split('T')[0];
    }

    function daysBetween(dateStrA, dateStrB) {
      const a = new Date(dateStrA + 'T12:00:00Z');
      const b = new Date(dateStrB + 'T12:00:00Z');
      return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
    }


    // ── PCI EXPORT ────────────────────────────────────────────────────────────

    function togglePCIBrandDropdown(e) {
      e.stopPropagation();
      const menu = document.getElementById('pci-export-brand-menu');
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      const menu = document.getElementById('pci-export-brand-menu');
      if (menu) menu.style.display = 'none';
    });

    function populatePCIExportBrands() {
      const container = document.getElementById('pci-export-brand-checkboxes');
      if (!container) return;
      // Use svAllProducts (loaded on page open) so brands are available immediately
      const brands = [...new Set(svAllProducts.map(p => p.brand).filter(Boolean))].sort();
      container.innerHTML = brands.map(b => `
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.875rem;">
          <input type="checkbox" class="pci-export-brand-cb" value="${b}" checked onchange="updatePCIBrandLabel()">
          ${b}
        </label>`).join('');
      updatePCIBrandLabel();
    }

    function updatePCIBrandLabel() {
      const total = document.querySelectorAll('.pci-export-brand-cb').length;
      const checked = document.querySelectorAll('.pci-export-brand-cb:checked').length;
      document.getElementById('pci-export-brand-label').textContent =
        checked === total ? 'All brands' : checked === 0 ? 'No brands' : `${checked} brand${checked > 1 ? 's' : ''}`;
    }

    function pciSelectAllBrands() {
      document.querySelectorAll('.pci-export-brand-cb').forEach(cb => cb.checked = true);
      updatePCIBrandLabel();
    }

    function pciSelectNoBrands() {
      document.querySelectorAll('.pci-export-brand-cb').forEach(cb => cb.checked = false);
      updatePCIBrandLabel();
    }

    function exportPCIAnalysis() {
      const feedback = document.getElementById('pci-export-feedback');
      feedback.style.display = 'none';

      const startDate = document.getElementById('pci-export-start').value;
      const endDate   = document.getElementById('pci-export-end').value;
      const windowDays = parseInt(document.getElementById('pci-export-window').value);

      if (!startDate || !endDate) {
        showFeedback(feedback, 'error', '⚠ Please select both a start and end date');
        return;
      }

      const selectedBrands = new Set(
        Array.from(document.querySelectorAll('.pci-export-brand-cb:checked')).map(cb => cb.value)
      );
      if (selectedBrands.size === 0) {
        showFeedback(feedback, 'error', '⚠ Please select at least one brand');
        return;
      }

      if (!pciPriceChanges.length) {
        showFeedback(feedback, 'error', '⚠ Price change data not loaded yet — open the Price Change Impacts tab first');
        return;
      }

      // Build per-SKU sorted change dates for next-change lookup
      const skuChangeDates = {};
      pciPriceChanges.forEach(pc => {
        if (!skuChangeDates[pc.sku]) skuChangeDates[pc.sku] = [];
        skuChangeDates[pc.sku].push(pc.date);
      });
      Object.values(skuChangeDates).forEach(dates => dates.sort());

      const yesterday = offsetDate(new Date().toISOString().split('T')[0], -1);

      // Filter price changes to the requested date range + brands
      const rows = pciPriceChanges
        .filter(pc => {
          const info = pciSkuMap[pc.sku];
          if (!info) return false;
          if (!selectedBrands.has(info.brand)) return false;
          if (pc.date < startDate || pc.date > endDate) return false;
          return true;
        })
        .map(pc => {
          const info = pciSkuMap[pc.sku] || {};
          const nextChange = (skuChangeDates[pc.sku] || []).find(d => d > pc.date) || null;
          const afterEnd = nextChange
            ? (offsetDate(nextChange, -1) < yesterday ? offsetDate(nextChange, -1) : yesterday)
            : yesterday;

          const beforeStart = offsetDate(pc.date, -windowDays);
          const beforeEnd   = offsetDate(pc.date, -1);

          const before = calcOrderMetrics(svOrdersData, pc.sku, beforeStart, beforeEnd, windowDays);
          const after  = calcOrderMetrics(svOrdersData, pc.sku, pc.date, afterEnd, windowDays);
          const daysAfter = daysBetween(pc.date, offsetDate(afterEnd, 1));

          const revChange   = before.revenue > 0 ? ((after.revenue   - before.revenue)   / before.revenue   * 100) : 0;
          const unitsChange = before.units   > 0 ? ((after.units     - before.units)     / before.units     * 100) : 0;
          const changePercent = pc.oldPrice > 0 ? ((pc.newPrice - pc.oldPrice) / pc.oldPrice * 100) : 0;

          return [
            pc.date,
            info.brand || '',
            info.productName || pc.sku,
            pc.sku,
            pc.oldPrice.toFixed(2),
            pc.newPrice.toFixed(2),
            changePercent.toFixed(1) + '%',
            windowDays,
            daysAfter,
            before.revenue.toFixed(2),
            before.units,
            after.revenue.toFixed(2),
            after.units,
            revChange.toFixed(1) + '%',
            unitsChange.toFixed(1) + '%',
            nextChange || ''
          ];
        });

      if (rows.length === 0) {
        showFeedback(feedback, 'error', '⚠ No price changes found for the selected criteria');
        return;
      }

      const headers = [
        'Change Date', 'Brand', 'Product', 'SKU',
        'Old Price', 'New Price', 'Price Change %',
        'Before Window (days)', 'After Window (days)',
        'Before Revenue', 'Before Units',
        'After Revenue', 'After Units',
        'Revenue Change %', 'Units Change %',
        'Next Change Date'
      ];

      const csv = [headers, ...rows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `price-change-analysis-${startDate}-to-${endDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      showFeedback(feedback, 'success', `✓ Exported ${rows.length} price change${rows.length !== 1 ? 's' : ''}`);
    }


    // ── ORDERS BACKFILL + SYNC ────────────────────────────────────────────────
    //
    // Rewired to the same SP-API flat-file All Orders report the daily
    // cron pulls (request → Amazon generates → poll-collect). Ranges are
    // split into ≤30-day chunks (one report each) and results MERGE into
    // existing month buckets (dedupe by orderId+sku) — a partial range
    // never clobbers days it doesn't cover. The server pending queue is
    // the source of truth: closing the tab mid-run is safe; the next
    // scheduled cron-collect (or re-clicking the button) finishes the job.

    const BF_POLL_INTERVAL_MS = 20000;
    const BF_POLL_MAX_TICKS = 45; // ~15 min before handing off to the cron

    function _bfLogger() {
      const log = document.getElementById('backfill-log');
      log.style.display = 'block';
      log.innerHTML = '';
      return (msg, color) => {
        const el = document.createElement('div');
        el.style.color = color || 'var(--text-primary)';
        el.textContent = msg;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
      };
    }

    // Poll the shared pending queue until none of `tags` remain, logging
    // per-tag outcomes as they land. Returns the set of tags still
    // pending at timeout (Amazon occasionally takes longer than we wait).
    async function _bfPollUntilDone(tags, addLine) {
      const waiting = new Set(tags);
      for (let tick = 0; tick < BF_POLL_MAX_TICKS && waiting.size > 0; tick++) {
        await new Promise(r => setTimeout(r, BF_POLL_INTERVAL_MS));
        let data;
        try {
          const res = await fetch('/api/orders?action=poll-flat-file-report', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
        } catch (err) {
          addLine(`… poll hiccup (${err.message}) — retrying`, 'var(--text-secondary)');
          continue;
        }
        for (const c of (data.collected || [])) {
          if (!waiting.delete(c.month)) continue;
          if (String(c.month).startsWith('upd:')) {
            const removed = c.removedCancelled ? `, ${c.removedCancelled} cancelled removed` : '';
            addLine(`✓ ${c.month} — ${c.rowCount || 0} stored row${c.rowCount === 1 ? '' : 's'} refreshed${removed}`, 'var(--success)');
          } else if (c.rawRowCount === 0) {
            addLine(`⚠ ${c.month} — Amazon returned no rows for this range`, 'var(--warning)');
          } else {
            addLine(`✓ ${c.month} — ${c.rowCount} line items merged`, 'var(--success)');
          }
        }
        for (const f of (data.failed || [])) {
          if (waiting.delete(f.month)) addLine(`✗ ${f.month} — ${f.error}`, 'var(--error)');
        }
        // A concurrent collector (e.g. cron-collect) may have landed one
        // of ours — anything absent from the remaining queue is done.
        const stillTags = new Set((data.stillPending || []).map(p => p.month));
        for (const t of [...waiting]) {
          if (!stillTags.has(t)) {
            waiting.delete(t);
            addLine(`✓ ${t} — collected`, 'var(--success)');
          }
        }
      }
      return waiting;
    }

    async function runOrdersBackfill() {
      const addLine = _bfLogger();
      if (!accessToken) { addLine('Please sign in first.', 'var(--error)'); return; }

      const startDate = document.getElementById('backfill-start').value;
      const endDate   = document.getElementById('backfill-end').value;
      if (!startDate || !endDate) { addLine('Please select a start and end date.', 'var(--error)'); return; }
      if (startDate > endDate)    { addLine('Start date must be before end date.', 'var(--error)'); return; }

      const btn = document.getElementById('backfill-btn');
      btn.disabled = true;
      btn.textContent = 'Running…';

      // ≤30-day chunks — the All Orders report caps the range per request.
      const DAY = 86400000;
      const chunks = [];
      let cur = Date.parse(startDate + 'T00:00:00Z');
      const stop = Date.parse(endDate + 'T00:00:00Z');
      while (cur <= stop) {
        const chunkEnd = Math.min(cur + 29 * DAY, stop);
        chunks.push([new Date(cur).toISOString().slice(0, 10), new Date(chunkEnd).toISOString().slice(0, 10)]);
        cur = chunkEnd + DAY;
      }

      addLine(`Requesting ${chunks.length} report(s): ${startDate} → ${endDate}`, 'var(--text-secondary)');

      const tags = [];
      for (const [s, e] of chunks) {
        try {
          const res = await fetch('/api/orders?action=request-flat-file-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({ start: s, end: e })
          });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { throw new Error(text.slice(0, 120)); }
          if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
          tags.push(...(data.tags || [data.tag]));
          const notes = [
            data.alreadyPending ? 'already pending — resuming' : null,
            data.clamped ? `end clamped to ${data.effectiveEnd} (yesterday)` : null
          ].filter(Boolean).join('; ');
          addLine(`→ ${data.tag} requested${notes ? ` (${notes})` : ''}`, 'var(--text-secondary)');
        } catch (err) {
          addLine(`✗ ${s} → ${e} — ${err.message}`, 'var(--error)');
        }
      }

      if (tags.length > 0) {
        addLine('Waiting for Amazon to generate the report(s) — typically a few minutes…', 'var(--text-secondary)');
        const leftover = await _bfPollUntilDone(tags, addLine);
        if (leftover.size > 0) {
          addLine(`Still generating: ${[...leftover].join(', ')} — the next scheduled collect will land them automatically, or click Fetch Orders again to resume.`, 'var(--warning)');
        } else {
          addLine('COMPLETE — reloading page data…', 'var(--success)');
        }
        await loadSalesVolumeData();
      }

      btn.disabled = false;
      btn.textContent = 'Fetch Orders';
    }

    // "Sync Yesterday" — fires the exact request the daily cron makes
    // (cron-daily-request: yesterday only, merge-mode), then polls the
    // queue until it lands.
    async function testOrdersSync() {
      const addLine = _bfLogger();
      if (!accessToken) { addLine('Please sign in first.', 'var(--error)'); return; }

      addLine("Requesting yesterday's reports — same pull the daily cron runs…", 'var(--text-secondary)');
      try {
        const res = await fetch('/api/orders?action=cron-daily-request');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
        const tags = data.tags || [data.date];
        addLine(`→ ${data.date} requested (new orders + updates/cancellations)`, 'var(--text-secondary)');

        const leftover = await _bfPollUntilDone(tags, addLine);
        if (leftover.size > 0) {
          addLine('Still generating — the next scheduled collect will land it automatically.', 'var(--warning)');
        } else {
          addLine('COMPLETE — reloading page data…', 'var(--success)');
        }
        await loadSalesVolumeData();
      } catch (err) {
        addLine(`✗ ${err.message}`, 'var(--error)');
      }
    }

    // ── MONTHLY SUMMARY CACHE ─────────────────────────────────────────────────
    // The pre-aggregated `orders:monthly-summary` KV cache is still
    // maintained server-side (`/api/orders?action=rebuild-summary`,
    // also fired automatically at the end of each daily sync), but
    // Monthly Overview no longer reads it — the rolling 13-month
    // aggregation in renderSalesVolumeData walks the full orders
    // array instead, since that's already loaded and stale-cache
    // bugs were leaving recent months invisible. Nothing calls the
    // rebuild helper below anymore (the backfill card now writes to
    // the v2 keyspace) — it stays until the old orders:* keyspace
    // is retired.


    async function rebuildMonthlySummaryCache() {
      try {
        await fetch('/api/orders?action=rebuild-summary', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
      } catch (err) {
        console.warn('Could not rebuild summary cache:', err.message);
      }
    }

    // Update the persistent info blurb with the most recent order date
    function updateSVDataBlurb(orders) {
      const el = document.getElementById('sv-latest-date');
      if (!el) return;
      if (!orders || orders.length === 0) { el.textContent = 'No data loaded'; return; }
      const latest = orders.reduce((max, o) => o.orderDate > max ? o.orderDate : max, '');
      el.textContent = latest || '—';
    }

    // ── PHASE 3: ALERTS + HEARTBEAT ──────────────────────────────────────────
    // Fetches undismissed alerts and cron heartbeat from the server,
    // renders the banner + "Last sync: X ago" text in the data blurb.
    // Also computes a client-side "sync-stale" alert when the newest
    // heartbeat is > 30h old — that's the backstop for when a server-
    // side cron stops firing entirely (no code runs → no server-side
    // alert gets emitted → only client-side check can catch it).

    async function _svLoadAlertsAndHeartbeat() {
      if (!accessToken) return;
      const res = await fetch('/api/orders?action=get-alerts', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!res.ok) throw new Error(`get-alerts failed (${res.status})`);
      const data = await res.json();
      const alerts = Array.isArray(data.alerts) ? [...data.alerts] : [];
      const heartbeat = (data.heartbeat && typeof data.heartbeat === 'object') ? data.heartbeat : {};

      _svRenderHeartbeat(heartbeat);

      // Client-side stale check: newest heartbeat > 30h old = something's
      // wrong. Prepend to alerts so it sorts first in the banner. Not
      // persisted server-side — derived each load.
      const staleAlert = _svBuildStaleAlert(heartbeat);
      if (staleAlert) alerts.unshift(staleAlert);

      _svRenderAlertBanner(alerts);
    }

    function _svRenderHeartbeat(heartbeat) {
      const el = document.getElementById('sv-last-sync');
      if (!el) return;
      // Newest of the cron stamps plus lastSync.at — manual pulls and
      // backfills update lastSync too, so the blurb reflects whichever
      // sync actually landed data most recently.
      const stamps = [heartbeat.checkAt, heartbeat.collectAt, heartbeat.requestAt,
                      heartbeat.lastSync && heartbeat.lastSync.at].filter(Boolean);
      if (stamps.length === 0) {
        el.textContent = '(no automatic sync yet — waiting for the first cron run)';
        return;
      }
      const newest = stamps.sort()[stamps.length - 1];
      let text = `Last sync: ${_svTimeAgo(newest)}.`;
      const ls = heartbeat.lastSync;
      if (ls && ls.start && ls.end) {
        const fmtD = (s) => { const [y, m, d] = s.split('-'); return `${+m}/${+d}/${y.slice(2)}`; };
        const rev = (ls.revenue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        text += ` ${fmtD(ls.start)}-${fmtD(ls.end)}. ${ls.orders || 0} Order${ls.orders === 1 ? '' : 's'} Loaded. $${rev} Revenue.`;
      }
      el.textContent = text;
    }

    function _svBuildStaleAlert(heartbeat) {
      const stamps = [heartbeat.checkAt, heartbeat.collectAt, heartbeat.requestAt].filter(Boolean);
      if (stamps.length === 0) return null; // No heartbeat yet — different UI (see above)
      const newest = stamps.sort()[stamps.length - 1];
      const ageHours = (Date.now() - new Date(newest).getTime()) / 3.6e6;
      if (ageHours < 30) return null;
      return {
        id: '__client__sync-stale',
        severity: 'warn',
        category: 'sync-stale',
        message: `Last automatic sync was ${Math.floor(ageHours)} hours ago. The daily cron may have stopped — click Pull manually or check Vercel logs.`,
        createdAt: new Date().toISOString(),
        dismissed: false,
        __clientOnly: true
      };
    }

    function _svRenderAlertBanner(alerts) {
      const banner = document.getElementById('sv-alert-banner');
      if (!banner) return;
      if (!alerts || alerts.length === 0) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
      }
      const escHtml = (s) => String(s || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      const rowHtml = alerts.map(a => {
        const bg = a.severity === 'error' ? 'rgba(239, 71, 111, 0.1)' : 'rgba(255, 165, 0, 0.1)';
        const border = a.severity === 'error' ? 'var(--error)' : 'var(--accent-orange)';
        const icon = a.severity === 'error' ? '🔴' : '⚠️';
        // Client-only alerts (like sync-stale) can't be dismissed via
        // the server — they'll reappear on next load until the
        // underlying condition resolves. Hide the button in that case.
        const dismissBtn = a.__clientOnly
          ? ''
          : `<button class="btn btn-secondary" data-alert-dismiss="${escHtml(a.id)}" style="font-size: 0.75rem; padding: 0.25rem 0.75rem;">Dismiss</button>`;
        return `
          <div style="display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.75rem 1rem; background: ${bg}; border-left: 3px solid ${border}; border-radius: 4px; margin-bottom: 0.5rem;">
            <div style="font-size: 1rem; line-height: 1;">${icon}</div>
            <div style="flex: 1; font-size: 0.875rem;">${escHtml(a.message)}</div>
            ${dismissBtn}
          </div>
        `;
      }).join('');
      banner.innerHTML = rowHtml;
      banner.style.display = 'block';

      // Wire dismiss buttons. Delegate via banner (rebuilt each render
      // so listeners on individual buttons get cleared naturally).
      banner.addEventListener('click', _svHandleAlertDismiss);
    }

    async function _svHandleAlertDismiss(evt) {
      const btn = evt.target.closest('[data-alert-dismiss]');
      if (!btn) return;
      const id = btn.getAttribute('data-alert-dismiss');
      if (!id || !accessToken) return;
      btn.disabled = true;
      btn.textContent = 'Dismissing…';
      try {
        const res = await fetch('/api/orders?action=dismiss-alert', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id })
        });
        if (!res.ok) throw new Error(`dismiss failed (${res.status})`);
        // Re-fetch to re-render (also picks up any newly-arrived alerts).
        await _svLoadAlertsAndHeartbeat();
      } catch (err) {
        console.warn('Dismiss failed:', err.message);
        btn.disabled = false;
        btn.textContent = 'Dismiss';
      }
    }

    function _svTimeAgo(iso) {
      const ms = Date.now() - new Date(iso).getTime();
      if (ms < 0) return 'just now';
      const min = Math.round(ms / 60000);
      if (min < 60) return `${min} min ago`;
      const hr = Math.round(min / 60);
      if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
      const days = Math.round(hr / 24);
      return `${days} days ago`;
    }
