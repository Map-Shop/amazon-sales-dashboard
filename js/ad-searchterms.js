    // ─── SEARCH TERMS ────────────────────────────────────────────────────────
    // What shoppers actually typed, a calendar month at a time.
    //
    // Phase 1 is a reader: pull a month, store it, look at it. No lists, no
    // recommendations, nothing written to Amazon. The negative and graduation
    // lists come later and will be built from the stored rows.
    //
    // Pulling is a deliberate click, never something a page load does — this is
    // the slowest report Amazon generates, and a month that is already stored
    // would be re-fetched for nothing.
    //
    // Everything is prefixed `st`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined.

    const ST_RUN_KEY = 'stRunState';
    const ST_POLL_MS = 20000;
    const ST_MAX_WAIT_MS = 45 * 60 * 1000;
    const ST_PAGE_SIZE = 200;

    let stPollTimer = null;
    let stBusy = false;
    let stBound = false;
    let stData = null;
    let stMonth = '';          // the stored month on screen
    let stPullMonth = '';      // the month the picker is set to
    let stSort = 'cost';
    let stDir = 'desc';
    let stQuery = '';
    let stMinClicks = 0;
    let stOffset = 0;
    let stView = 'products';   // products | terms | rows
    let stPortfolio = null;    // { id, name } when drilled into one product
    let stOnlyDead = false;
    let stDetail = null;       // { term, rows, loading, error } for the open term
    let stNames = {};          // ASIN -> { title, brand, found } for what is on screen
    let stNaming = false;

    function loadAdSearchTerms() {
      const container = document.getElementById('adsearchterms-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view search terms.</div>';
        return;
      }
      stFetch();

      const state = stRunLoad();
      if (state && !stPollTimer) {
        stSetStatus(stStatusLine(state.startedAt));
        stSchedulePoll(0);
      }
    }

    async function stFetch(after) {
      try {
        const qs = new URLSearchParams({
          view: stView, sort: stSort, dir: stDir,
          limit: String(ST_PAGE_SIZE), offset: String(stOffset),
          minClicks: String(stMinClicks)
        });
        if (stMonth) qs.set('month', stMonth);
        if (stQuery) qs.set('q', stQuery);
        if (stPortfolio) qs.set('portfolio', stPortfolio.id);
        if (stOnlyDead) qs.set('onlyDead', '1');
        const res = await fetch(`/api/adspend?action=searchterms-get&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        stData = data;
        stNames = data.names || {};
        if (data.empty) {
          stPullMonth = stPullMonth || data.suggested || '';
          stRenderIdle(data);
        } else {
          stMonth = data.month;
          stPullMonth = stPullMonth || data.month;
          stRender(data);
        }
        if (after) stSetStatus(after);
      } catch (err) {
        console.error('[ST] load failed:', err);
        stSetStatus('', err.message);
      }
    }

    // ── PULLING ──────────────────────────────────────────────────────────────

    function stButtonClick() {
      if (stRunLoad()) stResume(); else stRun();
    }

    function stResume() {
      const state = stRunLoad();
      if (!state) return stRun();
      state.pollUntil = Date.now() + ST_MAX_WAIT_MS;
      state.pollErrors = 0;
      stRunSave(state);
      stSetBusy(true);
      stSetStatus(stStatusLine(state.startedAt));
      stSchedulePoll(0);
    }

    async function stRun() {
      if (stBusy || !accessToken) return;
      if (stRunLoad()) return stResume();
      const month = stPullMonth;
      if (!month) return;
      stBusy = true;
      stSetBusy(true);
      try {
        stSetStatus(`Asking Amazon for ${month}…`);
        const res = await fetch(`/api/adspend?action=searchterms-request&month=${encodeURIComponent(month)}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const cols = (data.invalidColumns || []).join(', ');
          throw new Error((data.error || `Request failed (${res.status})`) +
                          (cols ? ` — Amazon rejected these columns: ${cols}` : ''));
        }
        const report = (data.reports || [])[0];
        if (!report || !report.reportId) throw new Error('Amazon accepted no report.');

        stRunSave({
          month: data.month, window: data.window,
          reports: [{ key: report.key, reportId: report.reportId }],
          startedAt: new Date().toISOString(),
          pollUntil: Date.now() + ST_MAX_WAIT_MS
        });
        stSetStatus('Amazon is generating the report. Search term reports are the ' +
                    'slowest it produces — 10 to 20 minutes is normal.');
        stSchedulePoll(ST_POLL_MS);
      } catch (err) {
        console.error('[ST] run failed:', err);
        stSetStatus('', err.message);
        stSetBusy(false);
      } finally {
        stBusy = false;
      }
    }

    function stSchedulePoll(delay) {
      clearTimeout(stPollTimer);
      stPollTimer = setTimeout(stPoll, delay);
    }

    async function stPoll() {
      const state = stRunLoad();
      if (!state) return;
      if (Date.now() > state.pollUntil) {
        stSetStatus('', 'Gave up waiting after 45 minutes. Press Check again to keep ' +
                        'waiting — the report is still queued at Amazon.');
        stSetBusy(false);
        return;
      }
      try {
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}`;
        const res = await fetch(`/api/adspend?action=searchterms-status&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Status failed (${res.status})`);

        if (data.allDone) return stCollect(state);
        state.lastStatus = (data.statuses || [])[0] || null;
        state.pollErrors = 0;
        stRunSave(state);
        stSetStatus(stStatusLine(state.startedAt, state.lastStatus));
        stSchedulePoll(ST_POLL_MS);
      } catch (err) {
        console.error('[ST] poll failed:', err);
        state.pollErrors = (state.pollErrors || 0) + 1;
        stRunSave(state);
        if (state.pollErrors >= 5) {
          stSetStatus('', `Could not reach the status endpoint after 5 tries: ${err.message}. ` +
                          'Press Check again when your connection is back.');
          stSetBusy(false);
          return;
        }
        stSetStatus(`Status check failed (attempt ${state.pollErrors} of 5), retrying…`);
        stSchedulePoll(ST_POLL_MS * state.pollErrors);
      }
    }

    async function stCollect(state) {
      stSetStatus('Downloading and storing the report…');
      try {
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}` +
                   `&month=${encodeURIComponent(state.month)}`;
        const res = await fetch(`/api/adspend?action=searchterms-collect&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Collect failed (${res.status})`);

        stRunClear();
        stSetBusy(false);
        stMonth = data.month;
        stOffset = 0;
        const s = data.stats || {};
        await stFetch(`Stored ${formatCount(s.rows || 0)} rows for ${stMonthLabel(data.month)} — ` +
                      `${stPct(s.zeroClick, s.rows)} of them never got a click.` +
                      (data.shortNote ? ` ${data.shortNote}` : ''));
      } catch (err) {
        console.error('[ST] collect failed:', err);
        // The download URL is short-lived, so a failed collect means re-running.
        stRunClear();
        stSetStatus('', err.message);
        stSetBusy(false);
      }
    }

    // An ASIN is unreadable; the product it belongs to is not. Your own come
    // from the catalog, everyone else's from Amazon's, and both are cached —
    // so this reads a stored name and never waits on a lookup.
    function stAsinName(asin) {
      const n = stNames[String(asin || '').toUpperCase()];
      return n && n.title ? n.title : null;
    }

    // The search term is what was typed or where the ad ran — that is the
    // fact, so it stays plain. The product name is an annotation on it and is
    // set back, never the other way round.
    function stTermLabel(term) {
      return escapeHtml(term || '—');
    }

    // The name alone, for the column beside the term.
    function stProductCell(term) {
      const name = stAsinName(term);
      return name ? `<span class="arf-muted">${escapeHtml(name)}</span>` : '';
    }

    // A targeting expression, which carries its ASIN inside quotes. One cell
    // rather than two: the breakdown is already wide, and the same rule holds
    // — the expression first, the name set back behind it.
    function stMatchedLabel(matched) {
      const s = String(matched || '—');
      const m = s.match(/asin="([^"]+)"/i);
      const name = m ? stAsinName(m[1]) : null;
      return name
        ? `${escapeHtml(s)} <span class="arf-muted">${escapeHtml(name)}</span>`
        : escapeHtml(s);
    }

    async function stNameAsins() {
      if (stNaming || !accessToken || !stMonth) return;
      stNaming = true;
      stSetStatus('Naming ASINs — your catalog first, then Amazon\'s…');
      try {
        const res = await fetch(`/api/adspend?action=searchterms-names&month=${encodeURIComponent(stMonth)}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Naming failed (${res.status})`);
        const done = `${formatCount(data.counts.named)} of ${formatCount(data.counts.asins)} ASINs named`;
        stNaming = false;
        await stFetch(data.error
          ? `${done}. Amazon's catalog refused the rest: ${data.error}`
          : (data.remaining ? `${done} — press again for the next batch.` : `${done}.`));
      } catch (err) {
        console.error('[ST] naming failed:', err);
        stNaming = false;
        stSetStatus('', err.message);
      }
    }

    // ── RENDER ───────────────────────────────────────────────────────────────

    function stRenderIdle(data) {
      const container = document.getElementById('adsearchterms-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">🔎</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            What shoppers actually typed, a calendar month at a time, kept day by day.
            Nothing has been pulled yet.
            <div style="margin-top: 1rem;">
              Pick a month and pull it. Amazon keeps about 65 days of search term history
              — less than the 95 days its campaign reports keep — so the months below are
              everything still reachable, and one that drops off that list cannot be
              recovered.
            </div>
          </div>
          <div style="margin-top: 1.5rem;">${stMonthPicker(data)}</div>
        </div>`;
      stBindActions();
    }

    function stRender(data) {
      const container = document.getElementById('adsearchterms-content');
      if (!container) return;
      const pull = data.pull || {};
      stSetBlurb(`${stMonthLabel(data.month)} · ${formatCount(pull.rows || 0)} rows · pulled ${
        pull.collectedAt ? _svTimeAgo(pull.collectedAt) : 'just now'}`);
      const body = data.view === 'products' ? stProductTable(data) : stTable(data);
      container.innerHTML =
        stControls(data) + stStats(data) + body + stFooter(data);
      stBindActions();
    }

    function stControls(data) {
      const months = (data.pulls || []).map(p => p.month);
      const tab = (key, label) =>
        `<button class="arf-btn${stView === key ? ' arf-btn-go' : ''}" data-st-view="${key}">${label}</button>`;
      const terms = data.view !== 'products';
      return `
        <div class="card card-flat wk-controls">
          <label class="wk-field">
            <span>Stored month</span>
            <select data-st-month>
              ${months.map(m => `<option value="${escapeHtml(m)}"${
                m === data.month ? ' selected' : ''}>${escapeHtml(stMonthLabel(m))}</option>`).join('')}
            </select>
          </label>
          <label class="wk-field">
            <span>View</span>
            <span class="bw-filter" style="margin: 0;">
              ${tab('products', 'Products')}${tab('terms', 'Terms')}${tab('rows', 'Daily rows')}
            </span>
          </label>
          ${terms ? `
          <label class="wk-field">
            <span>Search term contains</span>
            <input type="search" data-st-q value="${escapeHtml(stQuery)}" placeholder="any">
          </label>
          <label class="wk-field">
            <span>Minimum clicks</span>
            <select data-st-clicks>
              ${[0, 1, 5, 15].map(n => `<option value="${n}"${
                stMinClicks === n ? ' selected' : ''}>${n === 0 ? 'none' : n}</option>`).join('')}
            </select>
          </label>` : ''}
          ${data.view === 'terms' ? `
          <label class="wk-field">
            <span>Orders</span>
            <select data-st-dead>
              <option value="0"${stOnlyDead ? '' : ' selected'}>any</option>
              <option value="1"${stOnlyDead ? ' selected' : ''}>none yet</option>
            </select>
          </label>` : ''}
          <span class="wk-spacer"></span>
          ${stNameButton(data)}
          ${stMonthPicker(data)}
        </div>
        ${stPortfolio && terms ? `
        <div class="bw-filter" style="margin-bottom: 1rem;">
          <span class="arf-muted">Showing one product:</span>
          <strong>${escapeHtml(stPortfolio.name)}</strong>
          <button class="arf-btn" data-st-clear-portfolio>All products</button>
        </div>` : ''}`;
    }

    // ── PRODUCTS ─────────────────────────────────────────────────────────────
    // A portfolio is one product, the same unit the weekly checks judge by.
    // Terms with nothing to show are counted two ways on purpose: all of them,
    // and the few with enough clicks for the silence to mean anything. The
    // first is mostly one-click terms and says little; the second is the list
    // worth acting on.
    function stProductTable(data) {
      const rows = data.products || [];
      if (!rows.length) {
        return '<div class="card arf-section"><p class="arf-none">No products in this month.</p></div>';
      }
      return `
        <div class="card arf-section">
          <h4>By product</h4>
          <p class="arf-blurb">
            Every search term this month, grouped by the product that paid for it. A term matched
            by three campaigns counts once. "No orders" counts terms that returned nothing this
            month — mostly single-click terms, where silence is not yet evidence. "Worth negating"
            applies the monthly rule: ${ST_NEGATE_CLICKS} clicks or more and still nothing.
          </p>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead><tr>
                <th>Product</th><th>Brand</th>
                <th class="arf-r">Terms</th><th class="arf-r">Clicks</th>
                <th class="arf-r">Spend</th><th class="arf-r">Orders</th>
                <th class="arf-r">Sales</th><th class="arf-r">ACoS</th>
                <th class="arf-r">No orders</th><th class="arf-r">Worth negating</th>
              </tr></thead>
              <tbody>${rows.map(stProductRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
    }

    function stProductRow(r) {
      const id = r.portfolioId ? escapeHtml(r.portfolioId) : '';
      const name = escapeHtml(r.portfolio || '(no portfolio)');
      return `<tr>
        <td class="arf-name">${id
          ? `<button class="arf-btn" data-st-product="${id}" data-st-product-name="${name}">${name}</button>`
          : name}</td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td class="arf-r">${formatCount(r.terms || 0)}</td>
        <td class="arf-r">${formatCount(r.clicks || 0)}</td>
        <td class="arf-r arf-em">${stMoney(r.cost)}</td>
        <td class="arf-r">${formatCount(r.orders || 0)}</td>
        <td class="arf-r">${stMoney(r.sales)}</td>
        <td class="arf-r ${r.acos !== null && r.acos > 0.5 ? 'arf-down' : ''}">${
          r.acos === null ? '—' : Math.round(r.acos * 100) + '%'}</td>
        <td class="arf-r">${formatCount(r.deadTerms || 0)} <span class="arf-muted">${stMoney(r.deadCost)}</span></td>
        <td class="arf-r arf-em">${r.negateTerms
          ? `${formatCount(r.negateTerms)} <span class="arf-muted">${stMoney(r.negateCost)}</span>`
          : '<span class="arf-muted">—</span>'}</td>
      </tr>`;
    }

    // Naming is a press rather than something a page load does: it calls
    // Amazon for ASINs that are not yours, and a page should never wait on
    // that. It says how much is left so the next press has a reason.
    function stNameButton(data) {
      const a = data.asins || {};
      if (!a.asins) return '';
      const left = a.asins - a.named;
      if (!left) {
        return `<span class="arf-muted">all ${formatCount(a.asins)} ASINs named</span>`;
      }
      return `
        <label class="wk-field">
          <span>ASIN names</span>
          <button class="arf-btn" data-st-name${stNaming ? ' disabled' : ''}>${
            stNaming ? 'Naming…' : `Name ${formatCount(left)} ASINs`}</button>
        </label>`;
    }

    // The pull control, shown both on the idle page and beside a stored month.
    function stMonthPicker(data) {
      const pullable = data.pullable || [];
      const stored = new Set((data.pulls || []).map(p => p.month));
      if (!pullable.length) {
        return '<span class="arf-muted">No month is both settled and still inside Amazon\'s ' +
               'search term history.</span>';
      }
      return `
        <label class="wk-field">
          <span>Pull a month</span>
          <select data-st-pull>
            ${pullable.map(p => `<option value="${escapeHtml(p.month)}"${
              p.month === stPullMonth ? ' selected' : ''}>${escapeHtml(stMonthLabel(p.month))}${
              stored.has(p.month) ? ' (stored)' : ''} · ${escapeHtml(stReachLabel(p))}</option>`).join('')}
          </select>
        </label>`;
    }

    // The measurement the first pull exists to produce.
    function stStats(data) {
      const s = data.pull;
      if (!s) return '';
      const size = data.size || {};
      const cell = (label, value, hint) =>
        `<div class="wk-stat"><span class="wk-stat-label">${label}</span>
           <span class="wk-stat-value">${value}</span>${
             hint ? `<span class="arf-muted" style="font-size: 0.7rem;">${hint}</span>` : ''}</div>`;
      const covers = s.coveredStart && s.coveredEnd
        ? `${s.coveredStart} to ${s.coveredEnd}` : '—';
      return `
        ${s.partial ? `<div class="card bw-newer" style="margin-bottom: 1.25rem;">
          <div><strong>This month is short.</strong>
            <span class="arf-muted">Amazon had it only from ${escapeHtml(s.coveredStart)}.
            Its search term history reaches back about 65 days, and the earlier days of
            ${escapeHtml(stMonthLabel(s.month))} were already gone when it was pulled.</span></div>
        </div>` : ''}
        <div class="card card-flat wk-stats">
          ${cell('Covers', covers, s.partial ? 'short of the month' : 'the whole month')}
          ${cell('Rows', formatCount(s.rows || 0))}
          ${cell('Distinct terms', formatCount(s.terms || 0))}
          ${cell('Never clicked', stPct(s.zeroClick, s.rows), `${formatCount(s.zeroClick || 0)} rows`)}
          ${cell('Clicks', formatCount(s.clicks || 0))}
          ${cell('Spend', stMoney(s.cost))}
          ${cell('This month on disk', stBytes(s.dataBytes))}
          ${cell('Table total', stBytes(size.total), `${stBytes(size.indexes)} of it indexes`)}
        </div>`;
    }

    const ST_COLS = [
      { key: 'searchTerm', label: 'Search term', sortable: true },
      { key: 'matched', label: 'Matched by' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'brand', label: 'Brand' },
      { key: 'date', label: 'Date', sortable: true, right: true },
      { key: 'impressions', label: 'Impr.', sortable: true, right: true },
      { key: 'clicks', label: 'Clicks', sortable: true, right: true },
      { key: 'cost', label: 'Spend', sortable: true, right: true },
      { key: 'orders', label: 'Orders', sortable: true, right: true },
      { key: 'sales', label: 'Sales', sortable: true, right: true }
    ];

    const ST_NEGATE_CLICKS = 15;

    const ST_TERM_COLS = [
      { key: 'searchTerm', label: 'Search term', sortable: true },
      { key: 'product', label: 'Product' },
      { key: 'types', label: 'Matched in' },
      { key: 'clicks', label: 'Clicks', sortable: true, right: true },
      { key: 'cost', label: 'Spend', sortable: true, right: true },
      { key: 'orders', label: 'Orders', sortable: true, right: true },
      { key: 'sales', label: 'Sales', sortable: true, right: true },
      { key: 'acos', label: 'ACoS', right: true }
    ];

    function stTermTable(data) {
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="card arf-section"><p class="arf-none">No terms match these filters.</p></div>';
      }
      const head = ST_TERM_COLS.map(c => {
        const cls = c.right ? ' class="arf-r"' : '';
        if (!c.sortable) return `<th${cls}>${c.label}</th>`;
        const active = stSort === c.key;
        return `<th${cls}><button class="arf-btn${active ? ' arf-btn-go' : ''}" data-st-sort="${c.key}">${
          c.label}${active ? (stDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <div class="card arf-section">
          <h4>Terms${stPortfolio ? ` · ${escapeHtml(stPortfolio.name)}` : ''}</h4>
          <p class="arf-blurb">
            One row per search term for the month, however many campaigns matched it. Open a
            term to see each campaign and target separately — an exact keyword earning its
            place and an auto close-match that is not are two different facts, and this row
            adds them together. <strong>exact</strong> means the term is already targeted as
            its own keyword; one of those with clicks and no orders is a candidate to stop
            targeting rather than to block. <strong>N products</strong> means that many of
            your own products bid on the same search, and the breakdown shows all of them
            even while you are looking at one.
          </p>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead><tr>${head}</tr></thead>
              <tbody>${rows.map(stTermRow).join('')}</tbody>
            </table>
          </div>
          ${stPager(data)}
        </div>`;
    }

    function stTermRow(r) {
      const open = !!stDetail && stDetail.term === r.searchTerm;
      const term = escapeHtml(r.searchTerm || '');
      // Contested by more than one of your own products. Counted across the
      // whole account even here, where the list may be narrowed to one.
      const spread = r.products > 1
        ? ` <span class="bw-tag st-contested" title="${r.products} of your products bid on this search">${
            r.products} products</span>` : '';
      return `<tr${open ? ' class="st-open"' : ''}>
        <td class="arf-name">
          <button class="arf-btn st-expand" data-st-expand="${term}">${open ? '▾' : '▸'} ${
            stTermLabel(r.searchTerm)}</button>${
          r.targetedExact ? ' <span class="bw-tag bw-adjusted" title="already targeted as its own exact keyword">exact</span>' : ''}${spread}</td>
        <td>${stProductCell(r.searchTerm)}</td>
        <td>${escapeHtml(r.types || '—')}</td>
        <td class="arf-r arf-em">${formatCount(r.clicks || 0)}</td>
        <td class="arf-r">${stMoney(r.cost)}</td>
        <td class="arf-r arf-em">${formatCount(r.orders || 0)}</td>
        <td class="arf-r">${stMoney(r.sales)}</td>
        <td class="arf-r">${r.acos === null || r.acos === undefined ? '—' : Math.round(r.acos * 100) + '%'}</td>
      </tr>${open ? stTermDetailRow() : ''}`;
    }

    // One line per campaign and target: an exact keyword earning its place and
    // an auto close-match that is not are two different facts, and the term row
    // adds them together.
    function stTermDetailRow() {
      const cols = ST_TERM_COLS.length;
      if (stDetail.loading) {
        return `<tr class="st-detail"><td colspan="${cols}"><span class="loading"></span></td></tr>`;
      }
      if (stDetail.error) {
        return `<tr class="st-detail"><td colspan="${cols}"><span class="arf-warn">${
          escapeHtml(stDetail.error)}</span></td></tr>`;
      }
      const rows = stDetail.rows || [];
      if (!rows.length) {
        return `<tr class="st-detail"><td colspan="${cols}"><span class="arf-muted">Nothing matched.</span></td></tr>`;
      }
      const here = stPortfolio ? stPortfolio.id : null;
      return `<tr class="st-detail"><td colspan="${cols}">
        <table class="table-fill arf-table st-detail-table">
          <thead><tr>
            <th>Product</th><th>Campaign</th><th>Type</th><th>Matched by</th>
            <th class="arf-r">Clicks</th><th class="arf-r">Spend</th>
            <th class="arf-r">Orders</th><th class="arf-r">Sales</th>
          </tr></thead>
          <tbody>${rows.map(d => {
            const elsewhere = here && d.portfolioId !== here;
            return `<tr${elsewhere ? ' class="st-elsewhere"' : ''}>
              <td class="arf-name">${escapeHtml(d.portfolio || '—')}${
                elsewhere ? ' <span class="arf-muted">· another product</span>' : ''}</td>
              <td>${escapeHtml(d.campaign || '—')}</td>
              <td>${escapeHtml(d.campaignType || '—')}</td>
              <td>${stMatchedLabel(d.matched)}</td>
              <td class="arf-r">${formatCount(d.clicks || 0)}</td>
              <td class="arf-r">${stMoney(d.cost)}</td>
              <td class="arf-r arf-em">${formatCount(d.orders || 0)}</td>
              <td class="arf-r">${stMoney(d.sales)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </td></tr>`;
    }

    // Opens one term at a time. The list itself is not re-fetched — only the
    // breakdown is — so opening a term cannot shuffle the page under you.
    async function stExpand(term) {
      // Re-rendering needs the list that is already on screen. Without it the
      // open term would be left stuck on its spinner.
      if (!stData) return;
      if (stDetail && stDetail.term === term) {
        stDetail = null;
        return stRender(stData);
      }
      stDetail = { term, loading: true };
      stRender(stData);
      try {
        const qs = new URLSearchParams({ view: 'term', term, month: stMonth });
        const res = await fetch(`/api/adspend?action=searchterms-get&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        stDetail = { term, rows: data.detail || [] };
        stNames = { ...stNames, ...(data.names || {}) };
      } catch (err) {
        console.error('[ST] term detail failed:', err);
        stDetail = { term, rows: [], error: err.message };
      }
      stRender(stData);
    }

    function stTable(data) {
      if (data.view === 'terms') return stTermTable(data);
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="card arf-section"><p class="arf-none">No rows match these filters.</p></div>';
      }
      const head = ST_COLS.map(c => {
        const cls = c.right ? ' class="arf-r"' : '';
        if (!c.sortable) return `<th${cls}>${c.label}</th>`;
        const active = stSort === c.key;
        return `<th${cls}><button class="arf-btn${active ? ' arf-btn-go' : ''}" data-st-sort="${c.key}">${
          c.label}${active ? (stDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <div class="card arf-section">
          <h4>Search terms</h4>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead><tr>${head}</tr></thead>
              <tbody>${rows.map(stRow).join('')}</tbody>
            </table>
          </div>
          ${stPager(data)}
        </div>`;
    }

    function stRow(r) {
      // Keyword targeting carries the keyword text; an Auto or product-target
      // row carries a targeting expression instead. Showing whichever exists
      // keeps the column honest rather than blank for a third of the account.
      const matched = r.keyword || r.targeting || '—';
      const type = r.matchType ? ` <span class="arf-muted">${escapeHtml(r.matchType.toLowerCase())}</span>` : '';
      return `<tr>
        <td class="arf-name">${stTermLabel(r.searchTerm)} ${stProductCell(r.searchTerm)}</td>
        <td>${escapeHtml(matched)}${type}</td>
        <td>${escapeHtml(r.campaign || '—')}${
          r.campaignType ? ` <span class="arf-muted">${escapeHtml(r.campaignType)}</span>` : ''}</td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td class="arf-r">${escapeHtml(r.date || '')}</td>
        <td class="arf-r">${formatCount(r.impressions || 0)}</td>
        <td class="arf-r arf-em">${formatCount(r.clicks || 0)}</td>
        <td class="arf-r">${stMoney(r.cost)}</td>
        <td class="arf-r">${formatCount(r.orders || 0)}</td>
        <td class="arf-r">${stMoney(r.sales)}</td>
      </tr>`;
    }

    function stPager(data) {
      const total = data.total || 0;
      const from = total ? stOffset + 1 : 0;
      const to = Math.min(stOffset + ST_PAGE_SIZE, total);
      return `
        <div class="bw-filter" style="margin-top: 0.75rem;">
          <button class="arf-btn" data-st-page="prev"${stOffset <= 0 ? ' disabled' : ''}>Previous</button>
          <button class="arf-btn" data-st-page="next"${to >= total ? ' disabled' : ''}>Next</button>
          <span class="arf-muted">${formatCount(from)}–${formatCount(to)} of ${formatCount(total)}</span>
        </div>`;
    }

    function stFooter(data) {
      const pulls = data.pulls || [];
      return `
        <div class="card card-flat arf-footer">
          <div class="arf-muted">Sponsored Products only. Rows are kept per day, because Amazon
            credits a sale to the day of the click for 7 days afterwards — so a month can be
            pulled again later to collect the conversions that had not landed yet. A second pull
            rewrites only the days it brings back, so one made after Amazon has dropped the start
            of a month tops it up rather than trimming it.</div>
          ${pulls.length > 1
            ? `<div class="arf-muted">Stored: ${pulls.map(p =>
                `${escapeHtml(stMonthLabel(p.month))} (${formatCount(p.rows)})`).join(' · ')}</div>`
            : ''}
        </div>`;
    }

    // ── ACTIONS ──────────────────────────────────────────────────────────────

    function stBindActions() {
      if (stBound) return;
      const el = document.getElementById('adsearchterms-content');
      if (!el) return;

      el.addEventListener('click', e => {
        const view = e.target.closest('[data-st-view]');
        if (view) {
          stView = view.dataset.stView;
          stOffset = 0;
          stDetail = null;
          if (stView === 'products') stPortfolio = null;
          return stFetch();
        }
        const product = e.target.closest('[data-st-product]');
        if (product) {
          stPortfolio = { id: product.dataset.stProduct, name: product.dataset.stProductName };
          stView = 'terms';
          stOffset = 0;
          return stFetch();
        }
        if (e.target.closest('[data-st-clear-portfolio]')) {
          stPortfolio = null;
          stOffset = 0;
          return stFetch();
        }
        if (e.target.closest('[data-st-name]')) return stNameAsins();
        const expand = e.target.closest('[data-st-expand]');
        if (expand) return stExpand(expand.dataset.stExpand);
        const sort = e.target.closest('[data-st-sort]');
        if (sort) {
          const key = sort.dataset.stSort;
          if (stSort === key) stDir = stDir === 'asc' ? 'desc' : 'asc';
          else { stSort = key; stDir = 'desc'; }
          stOffset = 0;
          return stFetch();
        }
        const page = e.target.closest('[data-st-page]');
        if (page) {
          stOffset = page.dataset.stPage === 'next'
            ? stOffset + ST_PAGE_SIZE : Math.max(0, stOffset - ST_PAGE_SIZE);
          return stFetch();
        }
      });

      el.addEventListener('change', e => {
        const month = e.target.closest('[data-st-month]');
        if (month) { stMonth = month.value; stOffset = 0; return stFetch(); }
        const pull = e.target.closest('[data-st-pull]');
        if (pull) { stPullMonth = pull.value; return stSetBusy(false); }
        const clicks = e.target.closest('[data-st-clicks]');
        if (clicks) { stMinClicks = Number(clicks.value) || 0; stOffset = 0; return stFetch(); }
        const dead = e.target.closest('[data-st-dead]');
        if (dead) { stOnlyDead = dead.value === '1'; stOffset = 0; return stFetch(); }
      });

      // Typing filters on Enter rather than per keystroke: each one is a query
      // against six figures of rows.
      el.addEventListener('keydown', e => {
        const q = e.target.closest('[data-st-q]');
        if (q && e.key === 'Enter') { stQuery = q.value.trim(); stOffset = 0; stFetch(); }
      });

      stBound = true;
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────
    // Counts go through formatCount (ad-redflags.js) and money through
    // stMoney: formatNumber always prints two decimals, which turns 84,120
    // rows into "84,120.00".

    function stStatusLine(startedAt, status) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 60000));
      const state = status && status.status ? status.status.toLowerCase() : 'waiting';
      let line = `${state} — ${mins} min elapsed.`;
      if (state === 'pending' && mins >= 10) {
        line += ' Amazon has not started it yet; its report queue is backed up.';
      }
      return line;
    }

    // How much of a month Amazon can still answer for. `clipsAt` is the day it
    // starts losing its first days; `expires` the day the last of it goes.
    function stReachLabel(p) {
      return p.partial
        ? `only from ${p.start} · all gone ${p.expires}`
        : `complete until ${p.clipsAt}`;
    }

    function stMonthLabel(ym) {
      if (!ym) return '—';
      const [y, m] = String(ym).split('-').map(Number);
      const names = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];
      return `${names[(m || 1) - 1]} ${y}`;
    }

    function stMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return '$' + formatNumber(Math.round(n * 100) / 100);
    }

    function stPct(part, whole) {
      if (!whole) return '—';
      return Math.round((100 * (part || 0)) / whole) + '%';
    }

    function stBytes(n) {
      if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '—';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
      if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
      return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function stSetStatus(message, error) {
      const el = document.getElementById('st-status');
      if (!el) return;
      if (!message && !error) { el.style.display = 'none'; el.innerHTML = ''; return; }
      el.style.display = 'block';
      el.innerHTML = error
        ? `<span style="color: var(--error);">${escapeHtml(error)}</span>`
        : escapeHtml(message);
    }

    function stSetBlurb(text) {
      const el = document.getElementById('adsearchterms-blurb');
      if (el) el.textContent = text;
    }

    function stSetBusy(busy) {
      const btn = document.getElementById('st-run-btn');
      if (!btn) return;
      btn.disabled = busy || !stPullMonth;
      btn.innerHTML = busy ? 'Pulling<span class="loading"></span>'
                           : (stRunLoad() ? 'Check again'
                                          : `Pull ${stPullMonth ? stMonthLabel(stPullMonth) : 'a month'}`);
    }

    function stRunSave(state) {
      try { localStorage.setItem(ST_RUN_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
    }

    function stRunLoad() {
      try {
        const raw = localStorage.getItem(ST_RUN_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function stRunClear() {
      try { localStorage.removeItem(ST_RUN_KEY); } catch (e) { /* ignore */ }
    }
