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
          sort: stSort, dir: stDir, limit: String(ST_PAGE_SIZE), offset: String(stOffset),
          minClicks: String(stMinClicks)
        });
        if (stMonth) qs.set('month', stMonth);
        if (stQuery) qs.set('q', stQuery);
        const res = await fetch(`/api/adspend?action=searchterms-get&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        stData = data;
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
                      `${stPct(s.zeroClick, s.rows)} of them never got a click.`);
      } catch (err) {
        console.error('[ST] collect failed:', err);
        // The download URL is short-lived, so a failed collect means re-running.
        stRunClear();
        stSetStatus('', err.message);
        stSetBusy(false);
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
              Pick a month and pull it. Amazon keeps 95 days of Sponsored Products
              reporting, so the months below are everything still reachable — once one
              drops off that list it cannot be recovered.
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
      container.innerHTML =
        stControls(data) + stStats(data) + stTable(data) + stFooter(data);
      stBindActions();
    }

    function stControls(data) {
      const months = (data.pulls || []).map(p => p.month);
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
          <span class="wk-spacer"></span>
          ${stMonthPicker(data)}
        </div>`;
    }

    // The pull control, shown both on the idle page and beside a stored month.
    function stMonthPicker(data) {
      const pullable = data.pullable || [];
      const stored = new Set((data.pulls || []).map(p => p.month));
      if (!pullable.length) {
        return '<span class="arf-muted">No month is both settled and inside Amazon\'s 95 days.</span>';
      }
      return `
        <label class="wk-field">
          <span>Pull a month</span>
          <select data-st-pull>
            ${pullable.map(p => `<option value="${escapeHtml(p.month)}"${
              p.month === stPullMonth ? ' selected' : ''}>${escapeHtml(stMonthLabel(p.month))}${
              stored.has(p.month) ? ' (stored)' : ''} · expires ${escapeHtml(p.expires)}</option>`).join('')}
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
      return `
        <div class="card card-flat wk-stats">
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

    function stTable(data) {
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
        <td class="arf-name">${escapeHtml(r.searchTerm || '—')}</td>
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
            pulled again later to collect the conversions that had not landed yet.</div>
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
