    // ─── SEARCH TERMS ────────────────────────────────────────────────────────
    // What shoppers actually typed, a calendar month at a time.
    //
    // Phase 1 is a reader: pull a month, store it, look at it. No lists, no
    // recommendations, nothing written to Amazon. The negative and graduation
    // lists come later and will be built from the stored rows.
    //
    // Pulling is a deliberate click, never something a page load does — this is
    // the slowest report Amazon generates, and a month that is already stored
    // would be re-fetched for nothing. Bids are the same: Pull bids fetches
    // every keyword and target with its bid and Amazon's suggested range, for
    // the Targets tab, until the daily cron takes that over.
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
    let stView = 'products';   // products | targets | terms | rows
    let stPortfolio = null;    // { id, name } when drilled into one product
    let stOnlyDead = false;

    // The product list arrives whole — one row per product, a few dozen of
    // them — so it is sorted and filtered here rather than asked for again.
    // Its state is its own: a sort or filter set on Products survives opening
    // a product and coming back, and never leaks into the term tables, whose
    // keys mean something else.
    let stProdSort = 'name';
    let stProdDir = 'asc';
    let stProdQuery = '';
    let stProdBrand = 'all';
    let stProdOrders = 'any';
    let stDetail = null;       // { term, rows, loading, error } for the open term

    // The Targets tab's filters. Its own, like the product list's: a product
    // picked here is a filter on targets, not a drill-down, and its search box
    // looks in keywords rather than in what shoppers typed.
    let stTgProduct = '';
    let stTgQuery = '';
    let stTgMatch = '';
    let stTgState = '';
    let stTgPosition = '';
    let stBidsBusy = false;

    // Every click fires a request and they can come back out of order; the
    // slowest query is the one inside a product. Each request takes a number,
    // and only the latest may draw — otherwise a slow answer to an earlier
    // click paints the wrong table under whatever tab is open now.
    let stFetchSeq = 0;
    let stDetailSeq = 0;

    // Each table starts from its own default order. A sort key carried in from
    // another tab may not exist here, and would quietly fall back to spend —
    // possibly ascending, with no arrow showing it.
    function stResetSort() {
      stSort = 'cost';
      stDir = 'desc';
    }
    let stNames = {};          // ASIN -> { title, brand, found } for what is on screen
    let stNaming = false;

    // The Products tab has two states: the rollup, and one product's terms.
    // They are different tables answering different questions, so they are
    // different views on the wire too.
    function stWhich() {
      if (stView === 'products') return stPortfolio ? 'product-terms' : 'products';
      return stView;
    }

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
      const seq = ++stFetchSeq;
      try {
        const qs = new URLSearchParams({
          view: stWhich(), sort: stSort, dir: stDir,
          limit: String(ST_PAGE_SIZE), offset: String(stOffset),
          minClicks: String(stMinClicks)
        });
        if (stMonth) qs.set('month', stMonth);
        if (stView === 'targets') {
          if (stTgQuery) qs.set('q', stTgQuery);
          if (stTgProduct) qs.set('portfolio', stTgProduct);
          if (stTgMatch) qs.set('match', stTgMatch);
          if (stTgState) qs.set('state', stTgState);
          if (stTgPosition) qs.set('position', stTgPosition);
        } else {
          if (stQuery) qs.set('q', stQuery);
          if (stPortfolio) qs.set('portfolio', stPortfolio.id);
          if (stOnlyDead) qs.set('onlyDead', '1');
        }
        const res = await fetch(`/api/adspend?action=searchterms-get&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (seq !== stFetchSeq) return;   // a later click has already asked again
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
        if (seq !== stFetchSeq) return;
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
    // Amazon's own page for an ASIN. Every product has one at /dp/, so this
    // works for any ASIN — yours or anyone's — whether or not it has been named.
    const ST_ASIN_RE = /^(?=.*[0-9])[0-9A-Za-z]{10}$/;

    function stAsinUrl(asin) {
      return `https://www.amazon.com/dp/${String(asin).toUpperCase()}`;
    }

    // The product an ASIN search term is, as a link to it. In the Product
    // column it is one line cut short with an ellipsis, the full title on
    // hover; elsewhere (`inline`) it sits beside the term at its full length.
    // An ASIN Amazon's catalogue has not named still gets the link.
    function stProductCell(term, inline) {
      if (!ST_ASIN_RE.test(String(term || ''))) return '';
      const name = stAsinName(term);
      const label = name || 'view on Amazon';
      return `<a class="${inline ? 'st-asin-inline' : 'st-asin-link'}" href="${stAsinUrl(term)}"
                 target="_blank" rel="noopener noreferrer"
                 title="${escapeHtml(name ? `${name} — open on Amazon` : 'Open on Amazon')}">${escapeHtml(label)}</a>`;
    }

    // The keyword or targeting expression exactly as Amazon reports it. The
    // product name lives in its own column, so it is not repeated here.
    function stMatchedLabel(matched) {
      return escapeHtml(String(matched || '—'));
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

    // ── BIDS ─────────────────────────────────────────────────────────────────
    // Pull bids is two steps behind one button. The keyword and target lists
    // come back in a few calls; Amazon's suggested ranges take a call per ad
    // group, so they are asked for in rounds until none are left. A round that
    // stops — a closed tab, a refusal — picks up from the Targets tab.

    async function stPullBids() {
      if (stBidsBusy || !accessToken) return;
      stBidsBusy = true;
      stSetBidsBusy(true);
      try {
        stSetStatus('Fetching every keyword and target, with its bid, from Amazon…');
        const res = await fetch('/api/adspend?action=searchterms-bids', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Pulling bids failed (${res.status})`);
        stSetStatus(`Stored ${formatCount(data.stored)} keywords and targets. ` +
                    'Asking Amazon for its suggested bids…');
        await stSuggestRounds();
      } catch (err) {
        console.error('[ST] bids failed:', err);
        stSetStatus('', err.message);
      } finally {
        stBidsBusy = false;
        stSetBidsBusy(false);
      }
    }

    async function stSuggestBids() {
      if (stBidsBusy || !accessToken) return;
      stBidsBusy = true;
      stSetBidsBusy(true);
      try {
        await stSuggestRounds();
      } catch (err) {
        console.error('[ST] suggestions failed:', err);
        stSetStatus('', err.message);
      } finally {
        stBidsBusy = false;
        stSetBidsBusy(false);
      }
    }

    // Rounds until Amazon has been asked about every ad group, it refuses, or
    // a round gets nothing done — the last so a stuck round cannot loop.
    async function stSuggestRounds() {
      for (;;) {
        const res = await fetch('/api/adspend?action=searchterms-suggest', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Suggested bids failed (${res.status})`);
        const s = data.status || {};
        const progress = `Amazon's suggested bids: ${formatCount(s.suggested || 0)} of ${
          formatCount(s.askable || 0)} targets it can suggest for`;
        if (data.error) {
          stBidsBusy = false;
          await stFetch();
          stSetStatus('', `${progress}. Amazon stopped answering: ${data.error}`);
          return;
        }
        if (!data.remaining || !data.asked) {
          stBidsBusy = false;
          await stFetch(`${progress}.${data.remaining
            ? ` ${formatCount(data.remaining)} ad groups are still to ask — use the button on the Targets tab.` : ''}`);
          return;
        }
        stSetStatus(`${progress} · ${formatCount(data.remaining)} ad groups to go…`);
      }
    }

    function stSetBidsBusy(busy) {
      const btn = document.getElementById('st-bids-btn');
      if (!btn) return;
      btn.disabled = busy;
      btn.innerHTML = busy ? 'Pulling bids<span class="loading"></span>' : 'Pull bids';
    }

    // How Amazon says a row matched. When that differs from what the campaign's
    // name says it is for — a broad keyword inside an "(Exact)" campaign — both
    // are shown, because both are facts and the label alone would hide one.
    function stMatchCell(matchLabel, campaignType) {
      const label = escapeHtml(matchLabel || '—');
      return campaignType && matchLabel && campaignType !== matchLabel
        ? `${label} <span class="arf-muted">in ${escapeHtml(campaignType)} campaign</span>`
        : label;
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
      const body = data.view === 'products' ? stProductTable(data)
                 : data.view === 'product-terms' ? stProductTermTable(data)
                 : data.view === 'targets' ? stTargetTable(data)
                 : stTable(data);
      container.innerHTML =
        stControls(data) + body + stStats(data) + stFooter(data);
      stPullControl(data);
      stSetBidsBusy(stBidsBusy);
      stBindActions();
    }

    function stControls(data) {
      const months = (data.pulls || []).map(p => p.month);
      const tab = (key, label) =>
        `<button class="tab${stView === key ? ' active' : ''}" data-st-view="${key}">${label}</button>`;
      // The term tables filter on the server; the product rollup filters here.
      const filtering = data.view === 'terms' || data.view === 'product-terms';
      const brands = data.view === 'products'
        ? [...new Set((data.products || []).map(r => r.brand || '—'))].sort() : [];
      return `
        <div class="tabs">
          ${tab('products', 'Products')}${tab('targets', 'Targets')}${tab('terms', 'Shared terms')}${tab('rows', 'Daily rows')}
        </div>
        ${stPortfolio && data.view === 'product-terms' ? `
        <div class="st-crumb">
          <button class="arf-btn" data-st-clear-portfolio>&larr; All products</button>
          <strong>${escapeHtml(stPortfolio.name)}</strong>
        </div>` : ''}
        <div class="card card-flat wk-controls">
          <label class="wk-field">
            <span>Stored month</span>
            <select data-st-month>
              ${months.map(m => `<option value="${escapeHtml(m)}"${
                m === data.month ? ' selected' : ''}>${escapeHtml(stMonthLabel(m))}</option>`).join('')}
            </select>
          </label>
          ${data.view === 'products' ? `
          <label class="wk-field">
            <span>Product contains</span>
            <input type="search" data-st-pq value="${escapeHtml(stProdQuery)}" placeholder="any">
          </label>
          <label class="wk-field">
            <span>Brand</span>
            <select data-st-pbrand>
              <option value="all"${stProdBrand === 'all' ? ' selected' : ''}>All brands</option>
              ${brands.map(b => `<option value="${escapeHtml(b)}"${
                stProdBrand === b ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
            </select>
          </label>
          <label class="wk-field">
            <span>Orders</span>
            <select data-st-porders>
              <option value="any"${stProdOrders === 'any' ? ' selected' : ''}>any</option>
              <option value="none"${stProdOrders === 'none' ? ' selected' : ''}>none yet</option>
            </select>
          </label>` : ''}
          ${data.view === 'targets' ? stTargetFilters(data) : ''}
          ${filtering ? `
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
          </label>
          <label class="wk-field">
            <span>Orders</span>
            <select data-st-dead>
              <option value="0"${stOnlyDead ? '' : ' selected'}>any</option>
              <option value="1"${stOnlyDead ? ' selected' : ''}>none yet</option>
            </select>
          </label>` : ''}
          <span class="wk-spacer"></span>
          ${stNameButton(data)}
        </div>`;
    }

    // ── ONE PRODUCT'S TERMS ──────────────────────────────────────────────────
    // A row per way this product matched a term. Rows for one term sit
    // together, ordered by what that term costs this product, then down the
    // funnel — Auto found it, Broad widened it, Exact targets it.
    const ST_PRODUCT_TERM_COLS = [
      { key: 'searchTerm', label: 'Search term', sortable: true },
      { key: 'type', label: 'Match type' },
      { key: 'matched', label: 'Matched by' },
      { key: 'clicks', label: 'Clicks', sortable: true, right: true },
      { key: 'cost', label: 'Spend', sortable: true, right: true },
      { key: 'orders', label: 'Orders', sortable: true, right: true },
      { key: 'sales', label: 'Sales', sortable: true, right: true },
      { key: 'roas', label: 'ROAS', sortable: true, right: true },
      // Reference rather than data, so it sits after the numbers.
      { key: 'product', label: 'Product', cls: 'st-col-product' }
    ];

    function stProductTermTable(data) {
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="arf-section"><p class="arf-none">No terms match these filters.</p></div>';
      }
      const head = ST_PRODUCT_TERM_COLS.map(c => {
        const names = [c.right && 'arf-r', c.cls].filter(Boolean).join(' ');
        const cls = names ? ` class="${names}"` : '';
        if (!c.sortable) return `<th${cls}>${c.label}</th>`;
        const active = stSort === c.key;
        return `<th${cls}><button class="arf-btn${active ? ' arf-btn-go' : ''}" data-st-sort="${c.key}">${
          c.label}${active ? (stDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <div class="arf-section">
          <h4>${escapeHtml(stPortfolio ? stPortfolio.name : 'Product')}</h4>
          <p class="arf-blurb">
            What each search term did <strong>for this product</strong>, one row per way the
            product matched it. Sorting and filtering work on the term's total here, so a
            term's rows stay together. Open one to see what the whole term costs across the
            account and which other products are paying for the same search.
          </p>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead><tr>${head}</tr></thead>
              <tbody>${rows.map((r, i) => stProductTermRow(r, rows[i - 1])).join('')}</tbody>
            </table>
          </div>
          ${stPager(data)}
        </div>`;
    }

    function stProductTermRow(r, prev) {
      // The term is printed once per group; the rows under it are its matches.
      const first = !prev || prev.searchTerm !== r.searchTerm;
      const open = !!stDetail && stDetail.term === r.searchTerm;
      const term = escapeHtml(r.searchTerm || '');
      const spread = r.products > 1
        ? ` <span class="st-contested" title="${r.products} of your products bid on this search">${
            r.products} products</span>` : '';
      return `<tr${first ? ' class="st-group"' : ''}>
        <td class="arf-name">${first ? `
          <button class="arf-btn st-expand" data-st-expand="${term}">${open ? '▾' : '▸'} ${
            stTermLabel(r.searchTerm)}</button>${spread}` : ''}</td>
        <td>${stMatchCell(r.matchLabel, r.campaignType)}</td>
        <td>${stMatchedLabel(r.matched)}</td>
        <td class="arf-r arf-em">${formatCount(r.clicks || 0)}</td>
        <td class="arf-r">${stMoney(r.cost)}</td>
        <td class="arf-r arf-em">${formatCount(r.orders || 0)}</td>
        <td class="arf-r">${stMoney(r.sales)}</td>
        <td class="arf-r">${stRoas(r.sales, r.cost)}</td>
        <td class="st-col-product">${first ? stProductCell(r.searchTerm) : ''}</td>
      </tr>${open && stIsLastOfTerm(r) ? stSpreadRow() : ''}`;
    }

    // The breakdown goes under the LAST match row of a term, so it does not
    // split the group it belongs to.
    function stIsLastOfTerm(r) {
      const rows = (stData && stData.rows) || [];
      const last = rows.filter(x => x.searchTerm === r.searchTerm).pop();
      return last === r;
    }

    // What the opened term costs everywhere: its own total first, then every
    // other product paying for the same search.
    //
    // These are rows of the table above, not a table inside it, so every
    // number lands in the same column as the figure it is compared with. The
    // label goes where the search term goes; the two descriptive columns
    // between have nothing to say about a product total and stay blank.
    function stSpreadRow() {
      const cols = ST_PRODUCT_TERM_COLS.length;
      if (stDetail.loading) return stSubNote(cols, '<span class="loading"></span>');
      if (stDetail.error) {
        return stSubNote(cols, `<span class="arf-warn">${escapeHtml(stDetail.error)}</span>`);
      }
      const total = stDetail.total || {};
      const here = stPortfolio ? stPortfolio.id : null;
      const others = (stDetail.products || []).filter(p => p.portfolioId !== here);
      const line = (label, m, cls) => `<tr class="st-sub${cls ? ' ' + cls : ''}">
        <td class="st-sub-label">${label}</td>
        <td></td><td></td>
        ${stMetricCells(m)}
        <td class="arf-r">${stRoas(m.sales, m.cost)}</td>
        <td></td>
      </tr>`;
      return line('All products &middot; the whole search term', total, 'st-total') +
        (others.length
          ? others.map(p => line(`&#8627; ${escapeHtml(p.portfolio || '—')}`, p)).join('')
          : stSubNote(cols, '<span class="arf-muted">No other product bids on this search.</span>'));
    }

    // The four counted figures, in the order every table on this page uses.
    function stMetricCells(m) {
      return `<td class="arf-r arf-em">${formatCount(m.clicks || 0)}</td>
        <td class="arf-r">${stMoney(m.cost)}</td>
        <td class="arf-r arf-em">${formatCount(m.orders || 0)}</td>
        <td class="arf-r">${stMoney(m.sales)}</td>`;
    }

    // A loading, error or empty line inside an opened term, across the table.
    function stSubNote(cols, html) {
      return `<tr class="st-sub"><td colspan="${cols}" class="st-sub-label">${html}</td></tr>`;
    }

    // ── PRODUCTS ─────────────────────────────────────────────────────────────
    // A portfolio is one product, the same unit the weekly checks judge by.
    // Counts and money only: which terms returned nothing is a fact, whether
    // that makes one worth negating is a judgement, and this page does not
    // make judgements.
    // Every column sorts. Text sorts A to Z on the first press, numbers largest
    // first. A ratio that cannot be worked out — no spend, no sales — always
    // sorts last, whichever way the column is turned.
    const ST_PRODUCT_COLS = [
      { key: 'name', label: 'Product', text: true, of: r => r.portfolio || '' },
      { key: 'brand', label: 'Brand', text: true, of: r => r.brand || '' },
      { key: 'terms', label: 'Terms', of: r => r.terms },
      { key: 'clicks', label: 'Clicks', of: r => r.clicks },
      { key: 'cost', label: 'Spend', of: r => r.cost },
      { key: 'orders', label: 'Orders', of: r => r.orders },
      { key: 'sales', label: 'Sales', of: r => r.sales },
      { key: 'acos', label: 'ACoS', of: r => (r.sales > 0 ? r.cost / r.sales : null) },
      { key: 'roas', label: 'ROAS', of: r => (r.cost > 0 ? (r.sales || 0) / r.cost : null) },
      { key: 'dead', label: 'No orders', of: r => r.deadTerms }
    ];

    function stProductRowsShown(rows) {
      const q = stProdQuery.trim().toLowerCase();
      const col = ST_PRODUCT_COLS.find(c => c.key === stProdSort) || ST_PRODUCT_COLS[0];
      const dir = stProdDir === 'asc' ? 1 : -1;
      return rows
        .filter(r => !q || String(r.portfolio || '').toLowerCase().includes(q))
        .filter(r => stProdBrand === 'all' || (r.brand || '—') === stProdBrand)
        .filter(r => stProdOrders === 'any' || !(r.orders > 0))
        .slice()
        .sort((a, b) => {
          const x = col.of(a), y = col.of(b);
          const xNone = x === null || x === undefined, yNone = y === null || y === undefined;
          if (xNone || yNone) return xNone === yNone ? 0 : xNone ? 1 : -1;
          const cmp = col.text
            ? String(x).localeCompare(String(y), 'en', { sensitivity: 'base', numeric: true })
            : x - y;
          return cmp * dir || String(a.portfolio || '').localeCompare(String(b.portfolio || ''));
        });
    }

    function stProductTable(data) {
      return `<div class="arf-section" id="st-products">${stProductTableBody(data)}</div>`;
    }

    // The part a filter or a sort redraws. The controls sit outside it, so the
    // search box keeps its cursor while the list narrows under it.
    function stProductTableBody(data) {
      const all = data.products || [];
      if (!all.length) return '<p class="arf-none">No products in this month.</p>';
      const rows = stProductRowsShown(all);
      const head = ST_PRODUCT_COLS.map(c => {
        const active = stProdSort === c.key;
        const names = [!c.text && 'arf-r', c.cls].filter(Boolean).join(' ');
        return `<th${names ? ` class="${names}"` : ''}><button class="arf-btn${
          active ? ' arf-btn-go' : ''}" data-st-psort="${c.key}">${c.label}${
          active ? (stProdDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <h4>By product</h4>
        <p class="arf-blurb">
          Every search term this month, grouped by the product that paid for it. A term matched
          by three campaigns counts once. "No orders" counts the terms with no orders this
          month, and what they cost.
        </p>
        <p class="arf-muted st-shown">${rows.length === all.length
          ? `${formatCount(all.length)} products`
          : `${formatCount(rows.length)} of ${formatCount(all.length)} products`}</p>
        <div class="arf-table-wrap">
          <table class="table-fill arf-table">
            <thead><tr>${head}</tr></thead>
            <tbody>${rows.length
              ? rows.map(stProductRow).join('')
              : `<tr><td colspan="${ST_PRODUCT_COLS.length}"><span class="arf-muted">No products match these filters.</span></td></tr>`}</tbody>
          </table>
        </div>`;
    }

    function stRedrawProducts() {
      const el = document.getElementById('st-products');
      if (el && stData && stData.view === 'products') el.innerHTML = stProductTableBody(stData);
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
        <td class="arf-r">${stAcos(r.cost, r.sales)}</td>
        <td class="arf-r">${stRoas(r.sales, r.cost)}</td>
        <td class="arf-r">${formatCount(r.deadTerms || 0)} <span class="arf-muted">${stMoney(r.deadCost)}</span></td>
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

    // The month to pull sits beside the button that pulls it, in the header.
    // It is about getting data rather than reading it, so it does not belong
    // among the filters.
    function stPullControl(data) {
      const el = document.getElementById('st-pull-month');
      if (el) el.innerHTML = stMonthPicker(data);
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
        <h4 class="st-storage-head">Stored data</h4>
        ${s.partial ? `<div class="bw-newer" style="margin-bottom: 1.25rem;">
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

    // ── TARGETS ──────────────────────────────────────────────────────────────
    // One row per keyword or target: its bid, Amazon's suggested range, and
    // what it did in the stored month. A bid belongs to a target, not to a
    // search term — one target matches many terms and one term is matched by
    // many targets — so this is the table bids live in.
    //
    // Two times on one row: the bid and the range are as of the last Pull
    // bids, the figures are the month on screen. The heading says both.
    const ST_TARGET_COLS = [
      { key: 'target', label: 'Target', sortable: true, text: true },
      { key: 'match', label: 'Match type', sortable: true, text: true },
      { key: 'state', label: 'Status', sortable: true, text: true },
      { key: 'bid', label: 'Bid', sortable: true, right: true },
      { key: 'low', label: 'Low', sortable: true, right: true },
      { key: 'mid', label: 'Suggested', sortable: true, right: true },
      { key: 'high', label: 'High', sortable: true, right: true },
      { key: 'clicks', label: 'Clicks', sortable: true, right: true },
      { key: 'cost', label: 'Spend', sortable: true, right: true },
      { key: 'cpc', label: 'CPC', sortable: true, right: true },
      { key: 'orders', label: 'Orders', sortable: true, right: true },
      { key: 'sales', label: 'Sales', sortable: true, right: true },
      { key: 'roas', label: 'ROAS', sortable: true, right: true },
      // Reference rather than data, so it sits after the numbers. Campaign
      // names here are the product's short name and the campaign's type —
      // "SOK World Peters (Broad)" — so the product's full name is on hover
      // rather than in a column of its own that would push the row past the
      // page. The Product filter above narrows by it.
      { key: 'campaign', label: 'Campaign', sortable: true, text: true }
    ];

    const ST_POSITION_LABELS = {
      below: 'below Amazon\'s range', within: 'within Amazon\'s range',
      above: 'above Amazon\'s range', none: 'no suggestion'
    };

    function stTargetFilters(data) {
      const positions = data.positions || {};
      const opt = (value, label, current) =>
        `<option value="${escapeHtml(value)}"${current === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      return `
        <label class="wk-field">
          <span>Target contains</span>
          <input type="search" data-st-tq value="${escapeHtml(stTgQuery)}" placeholder="any">
        </label>
        <label class="wk-field">
          <span>Product</span>
          <select data-st-tg="product">
            ${opt('', 'All products', stTgProduct)}
            ${(data.filterProducts || []).map(p => opt(p.id, p.name || p.id, stTgProduct)).join('')}
          </select>
        </label>
        <label class="wk-field">
          <span>Match type</span>
          <select data-st-tg="match">
            ${opt('', 'any', stTgMatch)}
            ${(data.filterMatches || []).map(m => opt(m, m, stTgMatch)).join('')}
          </select>
        </label>
        <label class="wk-field">
          <span>Status</span>
          <select data-st-tg="state">
            ${opt('', 'any', stTgState)}${opt('ENABLED', 'enabled', stTgState)}${opt('PAUSED', 'paused', stTgState)}
          </select>
        </label>
        <label class="wk-field">
          <span>Bid against Amazon's range</span>
          <select data-st-tg="position">
            ${opt('', 'any', stTgPosition)}
            ${['below', 'within', 'above', 'none'].map(k => {
              const p = positions[k];
              const count = p ? ` (${formatCount(p.targets)} · ${stMoney(p.cost)} spend)` : ' (0)';
              return opt(k, ST_POSITION_LABELS[k] + count, stTgPosition);
            }).join('')}
          </select>
        </label>`;
    }

    function stTargetTable(data) {
      const bids = data.bids;
      if (!bids) {
        return `<div class="arf-section"><p class="arf-none">No bids pulled yet. Press
          <strong>Pull bids</strong> at the top of the page to fetch every keyword and target
          with its bid, and Amazon's suggested range for each.</p></div>`;
      }
      const rows = data.rows || [];
      const head = ST_TARGET_COLS.map(c => {
        const names = [c.right && 'arf-r', c.cls].filter(Boolean).join(' ');
        const cls = names ? ` class="${names}"` : '';
        if (!c.sortable) return `<th${cls}>${c.label}</th>`;
        const active = stSort === c.key;
        return `<th${cls}><button class="arf-btn${active ? ' arf-btn-go' : ''}" data-st-sort="${c.key}">${
          c.label}${active ? (stDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <div class="arf-section">
          <h4>Targets · every keyword and target</h4>
          <p class="arf-blurb">
            Each keyword and target with the bid it carries, Amazon's suggested range for it, and
            what it did in ${escapeHtml(stMonthLabel(data.month))}. The bid and the range are as of the
            last pull, ${escapeHtml(_svTimeAgo(bids.pulledAt))}; the clicks and spend are the month's.
            Low, Suggested and High are Amazon's. "default" marks a target bidding its ad group's
            default rather than a bid of its own.
          </p>
          ${stSuggestLine(bids)}
          ${rows.length ? `
          <div class="arf-table-wrap">
            <table class="table-fill arf-table st-targets">
              <thead><tr>${head}</tr></thead>
              <tbody>${rows.map(stTargetRow).join('')}</tbody>
            </table>
          </div>
          ${stPager(data)}` : '<p class="arf-none">No targets match these filters.</p>'}
        </div>`;
    }

    // How far Amazon's suggestions have got. They come an ad group at a time,
    // so a round can stop part way — a closed tab, a refusal — and pick up here.
    function stSuggestLine(bids) {
      const counts = `${formatCount(bids.targets)} targets (${formatCount(bids.enabled)} enabled, ${
        formatCount(bids.paused)} paused) · ${formatCount(bids.ownBid)} with a bid of their own · ` +
        `Amazon's range for ${formatCount(bids.suggested)}`;
      const left = bids.groupsLeft || 0;
      return `<p class="arf-muted st-shown">${counts}${left ? ` · ${formatCount(left)} ad groups still to ask
        <button class="arf-btn" data-st-suggest${stBidsBusy ? ' disabled' : ''}>${
          stBidsBusy ? 'Asking…' : 'Ask Amazon for the rest'}</button>` : ''}</p>`;
    }

    function stTargetRow(r) {
      const paused = r.state === 'PAUSED';
      const campaignOff = r.campaignState && r.campaignState !== 'ENABLED';
      const note = r.note ? ` title="${escapeHtml(r.note)}"` : '';
      return `<tr>
        <td class="arf-name">${stCut(stTargetLabel(r), stTargetTitle(r), 'st-cut-target')}</td>
        <td>${escapeHtml(r.matchLabel || '—')}</td>
        <td>${paused ? 'Paused' : r.state === 'ENABLED' ? 'Enabled' : escapeHtml(r.state || '—')}${
          campaignOff ? ` <span class="arf-muted">campaign ${escapeHtml(String(r.campaignState).toLowerCase())}</span>` : ''}</td>
        <td class="arf-r arf-em">${stBidCell(r)}</td>
        <td class="arf-r"${note}>${stMoneyOrDash(r.low)}</td>
        <td class="arf-r"${note}>${stMoneyOrDash(r.mid)}</td>
        <td class="arf-r"${note}>${stMoneyOrDash(r.high)}</td>
        <td class="arf-r arf-em">${formatCount(r.clicks || 0)}</td>
        <td class="arf-r">${stMoney(r.cost || 0)}</td>
        <td class="arf-r">${r.clicks > 0 ? stMoney(r.cost / r.clicks) : '—'}</td>
        <td class="arf-r arf-em">${formatCount(r.orders || 0)}</td>
        <td class="arf-r">${stMoney(r.sales || 0)}</td>
        <td class="arf-r">${stRoas(r.sales, r.cost)}</td>
        <td>${stCut(escapeHtml(r.campaign || '—'),
                    [r.campaign, r.portfolio].filter(Boolean).join(' · '))}</td>
      </tr>`;
    }

    // One line per row, always: a long keyword, campaign or product name is
    // cut short with an ellipsis and given in full on hover, rather than
    // wrapping the row onto two lines.
    function stCut(html, full, cls) {
      return `<span class="st-cut${cls ? ' ' + cls : ''}"${
        full ? ` title="${escapeHtml(full)}"` : ''}>${html}</span>`;
    }

    function stTargetTitle(r) {
      const m = String(r.text || '').match(/^asin="([^"]+)"$/i);
      const name = m ? stAsinName(m[1]) : null;
      return name ? `${m[1].toUpperCase()} — ${name}` : (r.text || '');
    }

    // The bid doing the work: the target's own, or its ad group's default,
    // said as such. Where it sits against the range is left to the columns
    // beside it and the filter above.
    function stBidCell(r) {
      if (r.liveBid === null || r.liveBid === undefined) return '—';
      const which = r.bid === null || r.bid === undefined
        ? ' <span class="arf-muted">default</span>' : '';
      return `${stMoney(r.liveBid)}${which}`;
    }

    // A keyword as typed; an Auto group or keyword group as the search term
    // report writes it; an ASIN with the product it is, linked.
    function stTargetLabel(r) {
      const m = String(r.text || '').match(/^asin="([^"]+)"$/i);
      if (m) return `${escapeHtml(m[1].toUpperCase())} ${stProductCell(m[1], true)}`;
      return escapeHtml(r.text || '—');
    }

    function stMoneyOrDash(n) {
      return typeof n === 'number' && isFinite(n) ? stMoney(n) : '—';
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
      { key: 'sales', label: 'Sales', sortable: true, right: true },
      { key: 'roas', label: 'ROAS', sortable: true, right: true }
    ];

    const ST_TERM_COLS = [
      { key: 'searchTerm', label: 'Search term', sortable: true },
      { key: 'types', label: 'Match types' },
      { key: 'clicks', label: 'Clicks', sortable: true, right: true },
      { key: 'cost', label: 'Spend', sortable: true, right: true },
      { key: 'orders', label: 'Orders', sortable: true, right: true },
      { key: 'sales', label: 'Sales', sortable: true, right: true },
      { key: 'acos', label: 'ACoS', right: true },
      { key: 'roas', label: 'ROAS', sortable: true, right: true },
      // Reference rather than data, so it sits after the numbers.
      { key: 'product', label: 'Product', cls: 'st-col-product' }
    ];

    function stTermTable(data) {
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="arf-section"><p class="arf-none">No terms match these filters.</p></div>';
      }
      const head = ST_TERM_COLS.map(c => {
        const names = [c.right && 'arf-r', c.cls].filter(Boolean).join(' ');
        const cls = names ? ` class="${names}"` : '';
        if (!c.sortable) return `<th${cls}>${c.label}</th>`;
        const active = stSort === c.key;
        return `<th${cls}><button class="arf-btn${active ? ' arf-btn-go' : ''}" data-st-sort="${c.key}">${
          c.label}${active ? (stDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <div class="arf-section">
          <h4>Shared terms · bid on by two or more products</h4>
          <p class="arf-blurb">
            The searches more than one of your products paid for this month, one row per term
            across the whole account. "N products" is how many. Open a term to see each product,
            campaign and target that matched it. A term only one product pays for is in that
            product, on the Products tab.
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
        ? ` <span class="st-contested" title="${r.products} of your products bid on this search">${
            r.products} products</span>` : '';
      return `<tr${open ? ' class="st-open"' : ''}>
        <td class="arf-name">
          <button class="arf-btn st-expand" data-st-expand="${term}">${open ? '▾' : '▸'} ${
            stTermLabel(r.searchTerm)}</button>${spread}</td>
        <td>${escapeHtml((r.matchTypes || []).join(', ') || '—')}</td>
        <td class="arf-r arf-em">${formatCount(r.clicks || 0)}</td>
        <td class="arf-r">${stMoney(r.cost)}</td>
        <td class="arf-r arf-em">${formatCount(r.orders || 0)}</td>
        <td class="arf-r">${stMoney(r.sales)}</td>
        <td class="arf-r">${stAcos(r.cost, r.sales)}</td>
        <td class="arf-r">${stRoas(r.sales, r.cost)}</td>
        <td class="st-col-product">${stProductCell(r.searchTerm)}</td>
      </tr>${open ? stTermDetailRow() : ''}`;
    }

    // One line per campaign and target: an exact keyword earning its place and
    // an auto close-match that is not are two different facts, and the term row
    // adds them together.
    //
    // Rows of the table above, so each figure sits under the one it adds up
    // to. A line has four things to say and the term row has two columns to
    // say them in, so each holds two: the product with its campaign under the
    // search term, and the match type with what it matched on under the match
    // types.
    function stTermDetailRow() {
      const cols = ST_TERM_COLS.length;
      if (stDetail.loading) return stSubNote(cols, '<span class="loading"></span>');
      if (stDetail.error) {
        return stSubNote(cols, `<span class="arf-warn">${escapeHtml(stDetail.error)}</span>`);
      }
      const rows = stDetail.rows || [];
      if (!rows.length) return stSubNote(cols, '<span class="arf-muted">Nothing matched.</span>');
      return rows.map(d => `<tr class="st-sub">
        <td class="st-sub-label">&#8627; ${escapeHtml(d.portfolio || '—')}
          <span class="st-sub-line">${escapeHtml(d.campaign || '—')}</span></td>
        <td>${stMatchCell(d.matchLabel, d.campaignType)}
          <span class="st-sub-line">${stMatchedLabel(d.matched)}</span></td>
        ${stMetricCells(d)}
        <td class="arf-r">${stAcos(d.cost, d.sales)}</td>
        <td class="arf-r">${stRoas(d.sales, d.cost)}</td>
        <td></td>
      </tr>`).join('');
    }

    // Opens one term at a time. The list itself is not re-fetched — only the
    // breakdown is — so opening a term cannot shuffle the page under you.
    async function stExpand(term) {
      // Re-rendering needs the list that is already on screen. Without it the
      // open term would be left stuck on its spinner.
      if (!stData) return;
      if (stDetail && stDetail.term === term) {
        stDetailSeq++;
        stDetail = null;
        return stRender(stData);
      }
      const seq = ++stDetailSeq;
      stDetail = { term, loading: true };
      stRender(stData);
      try {
        // Inside a product the question is "what does this cost everywhere";
        // across the account it is "which campaigns matched it".
        const inProduct = stWhich() === 'product-terms';
        const qs = new URLSearchParams({
          view: inProduct ? 'term-products' : 'term', term, month: stMonth
        });
        const res = await fetch(`/api/adspend?action=searchterms-get&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        // Another term was opened, or this one closed, while it loaded.
        if (seq !== stDetailSeq || !stDetail || stDetail.term !== term) return;
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        stDetail = { term, rows: data.detail || [],
                     total: data.total || null, products: data.products || null };
        stNames = { ...stNames, ...(data.names || {}) };
      } catch (err) {
        if (seq !== stDetailSeq || !stDetail || stDetail.term !== term) return;
        console.error('[ST] term detail failed:', err);
        stDetail = { term, rows: [], error: err.message };
      }
      stRender(stData);
    }

    function stTable(data) {
      if (data.view === 'terms') return stTermTable(data);
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="arf-section"><p class="arf-none">No rows match these filters.</p></div>';
      }
      const head = ST_COLS.map(c => {
        const names = [c.right && 'arf-r', c.cls].filter(Boolean).join(' ');
        const cls = names ? ` class="${names}"` : '';
        if (!c.sortable) return `<th${cls}>${c.label}</th>`;
        const active = stSort === c.key;
        return `<th${cls}><button class="arf-btn${active ? ' arf-btn-go' : ''}" data-st-sort="${c.key}">${
          c.label}${active ? (stDir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
      }).join('');
      return `
        <div class="arf-section">
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
        <td class="arf-name">${stTermLabel(r.searchTerm)} ${stProductCell(r.searchTerm, true)}</td>
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
        <td class="arf-r">${stRoas(r.sales, r.cost)}</td>
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
          stResetSort();
          // A drill-down belongs to the Products tab. Carrying it into Terms
          // labelled account-wide numbers with one product's name.
          stPortfolio = null;
          return stFetch();
        }
        const product = e.target.closest('[data-st-product]');
        if (product) {
          // Stays on the Products tab: opening a product is a drill-down into
          // it, not a jump to the account-wide term list. Sending this to
          // 'terms' is what made a product show everyone's numbers.
          stPortfolio = { id: product.dataset.stProduct, name: product.dataset.stProductName };
          stView = 'products';
          stDetail = null;
          stOffset = 0;
          stResetSort();
          return stFetch();
        }
        if (e.target.closest('[data-st-clear-portfolio]')) {
          stPortfolio = null;
          stDetail = null;
          stOffset = 0;
          stResetSort();
          return stFetch();
        }
        if (e.target.closest('[data-st-name]')) return stNameAsins();
        if (e.target.closest('[data-st-suggest]')) return stSuggestBids();
        const expand = e.target.closest('[data-st-expand]');
        if (expand) return stExpand(expand.dataset.stExpand);
        const psort = e.target.closest('[data-st-psort]');
        if (psort) {
          const key = psort.dataset.stPsort;
          const col = ST_PRODUCT_COLS.find(c => c.key === key);
          if (stProdSort === key) stProdDir = stProdDir === 'asc' ? 'desc' : 'asc';
          else { stProdSort = key; stProdDir = col && col.text ? 'asc' : 'desc'; }
          return stRedrawProducts();
        }
        const sort = e.target.closest('[data-st-sort]');
        if (sort) {
          const key = sort.dataset.stSort;
          const textCol = stView === 'targets' && (ST_TARGET_COLS.find(c => c.key === key) || {}).text;
          if (stSort === key) stDir = stDir === 'asc' ? 'desc' : 'asc';
          else { stSort = key; stDir = textCol ? 'asc' : 'desc'; }
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
        const tg = e.target.closest('[data-st-tg]');
        if (tg) {
          const v = tg.value;
          const which = tg.dataset.stTg;
          if (which === 'product') stTgProduct = v;
          if (which === 'match') stTgMatch = v;
          if (which === 'state') stTgState = v;
          if (which === 'position') stTgPosition = v;
          stOffset = 0;
          return stFetch();
        }
        const pbrand = e.target.closest('[data-st-pbrand]');
        if (pbrand) { stProdBrand = pbrand.value; return stRedrawProducts(); }
        const porders = e.target.closest('[data-st-porders]');
        if (porders) { stProdOrders = porders.value; return stRedrawProducts(); }
      });

      // The product list is already here, so it narrows as you type; the term
      // search below waits for Enter because each of those is a query.
      el.addEventListener('input', e => {
        const pq = e.target.closest('[data-st-pq]');
        if (pq) { stProdQuery = pq.value; stRedrawProducts(); }
      });

      // Typing filters on Enter rather than per keystroke: each one is a query
      // against six figures of rows.
      el.addEventListener('keydown', e => {
        const q = e.target.closest('[data-st-q]');
        if (q && e.key === 'Enter') { stQuery = q.value.trim(); stOffset = 0; stFetch(); }
        const tq = e.target.closest('[data-st-tq]');
        if (tq && e.key === 'Enter') { stTgQuery = tq.value.trim(); stOffset = 0; stFetch(); }
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

    // Spend as a share of the sales it was credited with. Blank, not infinite,
    // when nothing sold.
    function stAcos(cost, sales) {
      return sales > 0 ? Math.round((cost / sales) * 100) + '%' : '—';
    }

    // Sales for each dollar spent, the inverse of ACoS. Blank, not zero, when
    // nothing was spent — the same two decimals Weekly Trends uses.
    function stRoas(sales, cost) {
      return cost > 0 ? ((sales || 0) / cost).toFixed(2) : '—';
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
