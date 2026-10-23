    // ─── CAMPAIGN OVERVIEW ───────────────────────────────────────────────────
    // Amazon ad campaign and portfolio CONFIGURATION, grouped by portfolio.
    // Reads a stored snapshot from /api/adcampaigns; refreshing is an explicit
    // user action.
    //
    // loadAdCampaigns() renders the cache and NEVER triggers a refresh —
    // showPage() and triggerCurrentPageLoad() both fire on restore and after
    // sign-in, so auto-syncing there would hammer Amazon on every navigation.
    //
    // Everything is prefixed `aco`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined — and
    // note filterDropdown() belongs to catalog.js and closes over its own
    // state, so shadowing it would silently break Product Catalog's filter row.

    const ACO_COLUMNS = [
      { field: 'name',            label: 'Campaign',      editable: 'text' },
      { field: 'campaignType',    label: 'Type',          filter: true, tip: 'aco.type' },
      { field: 'adProduct',       label: 'Ad',            filter: true, tip: 'aco.ad' },
      { field: 'state',           label: 'State',         filter: true, editable: 'state' },
      { field: 'brand',           label: 'Brand',         filter: true, editable: 'brand', tip: 'aco.brand' },
      { field: 'dailyBudget',     label: 'Daily budget',  align: 'right', mono: true, format: 'money', editable: 'money', tip: 'aco.dailyBudget' },
      { field: 'biddingStrategy', label: 'Bidding',       editable: 'bidding', tip: 'aco.bidding' },
      { field: 'placements',      label: 'Placements',    format: 'placements', editable: 'placements', tip: 'aco.placements' },
      // Hidden rather than deleted: gone from the table, still in the CSV.
      { field: 'startDate',       label: 'Started',       hidden: true },
      // Present in the CSV, absent from the table. Without ids an export can't
      // be joined back to anything after the first rename.
      { field: 'portfolio',       label: 'Portfolio',     hidden: true },
      { field: 'portfolioId',     label: 'Portfolio ID',  hidden: true },
      { field: 'campaignId',      label: 'Campaign ID',   hidden: true }
    ];

    // Amazon's API enums translated to the wording Campaign Manager shows.
    // Strings verified against the console's own SP Campaign Report export.
    // LEGACY_FOR_SALES is "legacy" only in the sense that down-only bidding
    // predates up-and-down — the enum was kept for backwards compatibility and
    // says nothing about the campaign being outdated.
    const ACO_LABELS = {
      biddingStrategy: {
        LEGACY_FOR_SALES: 'Dynamic bids - down only',
        AUTO_FOR_SALES:   'Dynamic bids - up and down',
        MANUAL:           'Fixed bids'
      },
      targetingType: {
        AUTO:   'Automatic targeting',
        MANUAL: 'Manual targeting'
      },
      state: {
        ENABLED:  'Enabled',
        PAUSED:   'Paused',
        ARCHIVED: 'Archived'
      },
      placement: {
        PLACEMENT_TOP:            'Top of search',
        PLACEMENT_PRODUCT_PAGE:   'Product pages',
        PLACEMENT_REST_OF_SEARCH: 'Rest of search'
      }
    };

    const ACO_PLACEMENT_TYPES = ['PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH'];

    // The change log stores raw field names. Anything not listed prints as-is,
    // which is the right default — a new tracked field should show up rather
    // than silently render as blank.
    const ACO_FIELD_LABELS = {
      name: 'Name', state: 'State', dailyBudget: 'Daily budget',
      budgetType: 'Budget type', targetingType: 'Targeting',
      biddingStrategy: 'Bidding', portfolioId: 'Portfolio',
      startDate: 'Start date', endDate: 'End date',
      placementsSummary: 'Placements', defaultBid: 'Default bid',
      _created: 'Created', _missing: 'Missing', _returned: 'Returned'
    };

    // Short forms for the table cell; the full names go in the title.
    const ACO_PLACEMENT_SHORT = {
      PLACEMENT_TOP:            'TOS',
      PLACEMENT_PRODUCT_PAGE:   'PP',
      PLACEMENT_REST_OF_SEARCH: 'ROS'
    };

    // null means Amazon did not tell us, which is a different fact from "none"
    // and is rendered differently — same treatment as an unknown daily budget.
    function acoPlacementsText(placements) {
      if (placements === null || placements === undefined) return null;
      if (!placements.length) return '';
      return placements
        .map(p => `${ACO_PLACEMENT_SHORT[p.placement] || p.placement} ${p.percentage}%`)
        .join(' · ');
    }

    // Unknown values fall through to the raw string rather than rendering
    // blank — a new Amazon enum should look unfamiliar, not disappear.
    function acoLabel(field, value) {
      if (value === null || value === undefined || value === '') return '';
      const map = ACO_LABELS[field];
      return (map && map[String(value).toUpperCase()]) || String(value);
    }

    const ACO_VISIBLE = ACO_COLUMNS.filter(c => !c.hidden);

    let acoData = { campaigns: [], portfolios: [], meta: null, syncedAt: null };
    let acoFilters = {};
    let acoSearch = '';
    let acoOnlyEnabled = true;   // most of the time you only care about what's running
    let acoCollapsed = new Set();
    let acoBusy = false;

    // ── EDITOR STATE ─────────────────────────────────────────────────────────
    // Every editable cell is a live control; there is no edit mode to enter.
    // Changes accumulate in acoPending and are committed together from the save
    // bar. acoRenderTable replaces the whole table on every keystroke, filter
    // change and collapse toggle, so pending edits cannot live in the DOM —
    // controls render FROM acoPending, which is what makes them survive.
    //
    //   acoPending = { [campaignId]: { brand: 'Hubbard Scientific' } }
    // A field is only present here when it DIFFERS from the stored row, so
    // "is anything pending" is just a key count.
    let acoPending = {};
    let acoSaveBusy = false;
    let acoRowErrors = {};   // { [campaignId]: message }
    let acoFlash = null;
    // Name is the one field behind a click. It is rarely the thing you came to
    // change, a full-width text box in the first column crowds out everything
    // else, and renaming orphans this campaign's row on the Campaign Mapping
    // page — which keys by name. Every other field is live on sight.
    let acoNameEditing = new Set();

    function loadAdCampaigns() {
      const container = document.getElementById('adcampaigns-content');
      if (!container) return;
      acoShowTab(acoTabSaved());

      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view campaigns.</div>';
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading campaigns…</div>';

      fetch('/api/adcampaigns?action=get', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(async res => {
          // Parse defensively: an error page is HTML, and res.json() throwing
          // first would surface "Unexpected token '<'" instead of the status.
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Failed to load (${res.status})`);
          acoData = {
            campaigns: data.campaigns || [], portfolios: data.portfolios || [],
            meta: data.meta || null, syncedAt: data.syncedAt || null,
            knownBrands: data.knownBrands || []
          };
          acoRender();
        })
        .catch(err => {
          console.error('[ACO] load failed:', err);
          container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${escapeHtml(err.message)}</div>`;
        });
    }

    async function acoRefresh(dry) {
      if (acoBusy || !accessToken) return;
      acoBusy = true;
      acoSetBusy(true, dry ? 'Dry run…' : 'Refreshing…');
      try {
        const res = await fetch(`/api/adcampaigns?action=refresh${dry ? '&dry=1' : ''}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Refresh failed (${res.status})`);

        if (data.aborted) {
          acoShowDiagnostic('Refresh aborted', data);
          return;
        }
        if (dry) {
          acoShowDiagnostic('Dry run — nothing was written', data);
          return;
        }
        loadAdCampaigns();
      } catch (err) {
        console.error('[ACO] refresh failed:', err);
        acoShowDiagnostic('Refresh failed', { error: err.message });
      } finally {
        acoBusy = false;
        acoSetBusy(false);
      }
    }

    async function acoProbe() {
      if (acoBusy || !accessToken) return;
      acoBusy = true;
      acoSetBusy(true, 'Probing…');
      try {
        const res = await fetch('/api/adcampaigns?action=probe', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        acoShowDiagnostic('Raw API probe', data);
      } catch (err) {
        acoShowDiagnostic('Probe failed', { error: err.message });
      } finally {
        acoBusy = false;
        acoSetBusy(false);
      }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────

    function acoRender() {
      const container = document.getElementById('adcampaigns-content');
      if (!container) return;

      if (!acoData.campaigns.length) {
        container.innerHTML = `
          <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
            <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">📋</div>
            <div style="color: var(--text-secondary); max-width: 40rem; margin: 0 auto; line-height: 1.6;">
              No campaign data stored yet. Press <strong>Refresh from Amazon</strong> to fetch
              campaigns and portfolios. This reads campaign settings directly, so it takes a
              second or two rather than the minutes a performance report needs.
            </div>
          </div>
          <div id="aco-diagnostic"></div>`;
        acoSetBlurb('No data yet');
        return;
      }

      acoSetBlurb(
        `${acoData.campaigns.length} campaigns · ${acoData.portfolios.length} portfolios · ` +
        `synced ${acoData.syncedAt ? _svTimeAgo(acoData.syncedAt) : 'never'}`
      );

      container.innerHTML =
        acoFlashBlock() + acoStats() + acoSyncProblems() + acoCoverageNotes() + acoCoverageBanner() + acoToolbar() +
        '<div id="aco-table-wrap"></div>' +
        '<div id="aco-save-bar" style="display: none;"></div>' +
        acoCoverageDetails() + '<div id="aco-diagnostic"></div>';

      acoRenderTable();
      acoRenderSaveBar();
      acoBindControls();
    }

    // acoRender rebuilds the container, so a success message has to be rendered
    // by it and then cleared — otherwise a successful save looks like nothing
    // happened at all.
    function acoFlashBlock() {
      if (!acoFlash) return '';
      const msg = acoFlash;
      acoFlash = null;
      return `<div class="card" style="margin-bottom: 1.5rem; border-left: 3px solid var(--success);">
        <div style="color: var(--success);">${escapeHtml(msg)}</div>
      </div>`;
    }

    function acoStats() {
      const c = acoData.campaigns;
      const enabled = c.filter(x => x.state === 'ENABLED');
      const budgeted = enabled.filter(x => typeof x.dailyBudget === 'number');
      const total = budgeted.reduce((s, x) => s + x.dailyBudget, 0);
      return `
        <div class="stats-bar" style="margin-bottom: 1.5rem;">
          <div class="stat-item"><span class="stat-label">Campaigns</span><span class="stat-value">${c.length}</span></div>
          <div class="stat-item"><span class="stat-label">Portfolios</span><span class="stat-value">${acoData.portfolios.length}</span></div>
          <div class="stat-item"><span class="stat-label">Enabled</span><span class="stat-value">${enabled.length}</span></div>
          <div class="stat-item"><span class="stat-label">Daily budget (enabled)</span><span class="stat-value">$${formatNumber(total)}</span></div>
        </div>`;
    }

    // Warns about WRONG KEYS, not absent values. A field that is legitimately
    // empty — an open-ended campaign has no end date, Sponsored Brands has no
    // targetingType — is not a failure, and reporting it as one buried the
    // single case this exists to catch. Coverage counts enabled campaigns only.
    function acoCoverageBanner() {
      const cov = acoCoverage();
      if (!cov) return '';
      const wrong = Object.entries(cov.fields).filter(([, v]) => v.looksWrong);
      if (!wrong.length) return '';

      return `
        <div class="card" style="margin-bottom: 1.5rem; border-left: 3px solid var(--error);">
          <div style="font-weight: 600; color: var(--error); margin-bottom: 0.5rem;">
            ${wrong.length} field${wrong.length === 1 ? ' looks' : 's look'} like the wrong key
          </div>
          <div style="color: var(--text-secondary); font-size: 0.8125rem; margin-bottom: 0.75rem;">
            These are missing on campaigns that should have them, or resolving through more than one
            key — which means the shape varies and at least one guess is wrong. Run the raw probe to
            see the real field names.
          </div>
          <div style="font-family: monospace; font-size: 0.75rem; line-height: 1.7;">
            ${wrong.map(([f, v]) => {
              return `<div>${escapeHtml(f)}: ${v.resolved} of ${v.applicable}${v.appliesTo ? ` ${escapeHtml(v.appliesTo)}` : ''} enabled — ${acoViaKeyText(v)}</div>`;
            }).join('')}
          </div>
        </div>`;
    }

    // Grouped by ad product, because "SP via one key, SB via another" is an
    // explanation whereas a bare merged list reads as ambiguity.
    function acoViaKeyText(v) {
      const byProduct = v.viaKeyByProduct || {};
      const products = Object.keys(byProduct);
      if (!products.length) return 'no key resolved';
      return products.map(p => {
        const keys = Object.entries(byProduct[p]).map(([k, n]) => `${k}×${n}`).join(', ');
        return products.length > 1 ? `${p} via ${keys}` : `via ${keys}`;
      }).join(' · ');
    }

    function acoCoverage() {
      const cov = acoData.meta && acoData.meta.coverage && acoData.meta.coverage.campaigns;
      // Snapshots written before coverage gained its rules have the old flat
      // shape; skip rather than render nonsense until the next refresh.
      return cov && cov.fields ? cov : null;
    }

    // Every sync records warnings and errors into adcampaigns:meta, and until
    // now nothing displayed them — so a whole endpoint could fail on the normal
    // refresh path and the only symptom was a field quietly staying empty.
    // acoRefresh only opens the diagnostic panel on abort, dry run or throw,
    // which are the three cases where the sync did NOT quietly half-succeed.
    function acoSyncProblems() {
      const meta = acoData.meta;
      if (!meta) return '';
      const errors = meta.errors || [];
      const warnings = meta.warnings || [];
      if (!errors.length && !warnings.length) return '';

      return `
        <div class="card" style="margin-bottom: 1.5rem; border-left: 3px solid var(--${errors.length ? 'error' : 'warning'});">
          <div style="font-weight: 600; color: var(--${errors.length ? 'error' : 'warning'}); margin-bottom: 0.5rem;">
            Last sync reported ${errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : ''}${
              errors.length && warnings.length ? ' and ' : ''}${
              warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}
          </div>
          ${errors.map(e => `<div style="font-size: 0.75rem; font-family: monospace; word-break: break-word; margin-bottom: 0.4rem;">
            ${escapeHtml(e.endpoint || '')} (${escapeHtml(String(e.status ?? ''))}): ${escapeHtml(String(e.body || '').slice(0, 300))}
          </div>`).join('')}
          ${warnings.map(w => `<div style="font-size: 0.8125rem; color: var(--text-secondary);">
            ${escapeHtml(String(w))}
          </div>`).join('')}
        </div>`;
    }

    // Absences that are facts about the account rather than mapping errors.
    // Worth knowing, not worth a warning.
    function acoCoverageNotes() {
      const cov = acoCoverage();
      if (!cov) return '';
      const notes = Object.entries(cov.fields)
        .filter(([, v]) => v.informational && v.applicable && v.resolved < v.applicable)
        .map(([f, v]) => `${v.applicable - v.resolved} of ${v.applicable} without ${escapeHtml(f === 'portfolioId' ? 'a portfolio' : f)}`);
      if (!notes.length) return '';
      return `<div style="color: var(--text-secondary); font-size: 0.8125rem; margin: -0.75rem 0 1.25rem 0;">
        Across ${cov.scope.counted} enabled campaigns: ${notes.join(' · ')}.
      </div>`;
    }

    // The full picture, for when you want it rather than in your face.
    function acoCoverageDetails() {
      const cov = acoCoverage();
      if (!cov) return '';
      const rows = Object.entries(cov.fields).map(([f, v]) => {
        const note = v.optional ? 'optional' : v.informational ? 'informational'
                   : v.appliesTo ? `${v.appliesTo} only` : '';
        const via = acoViaKeyText(v);
        const colour = v.looksWrong ? 'var(--error)'
                     : v.resolved === v.applicable ? 'var(--success)' : 'var(--text-secondary)';
        return `<tr>
          <td>${escapeHtml(f)}</td>
          <td style="color: ${colour};">${v.resolved} of ${v.applicable}</td>
          <td style="color: var(--text-secondary);">${escapeHtml(note)}</td>
          <td style="font-family: monospace; font-size: 0.7rem; color: var(--text-secondary);">${escapeHtml(via)}</td>
        </tr>`;
      }).join('');
      return `
        <div class="card card-flat" style="margin-top: 1.5rem;">
          <details>
            <summary style="cursor: pointer; font-weight: 600;">Field coverage (${cov.scope.counted} enabled of ${cov.scope.of})</summary>
            <div style="margin-top: 1rem; overflow-x: auto;">
              <table><thead><tr><th>Field</th><th>Resolved</th><th></th><th>Read from</th></tr></thead>
              <tbody>${rows}</tbody></table>
            </div>
          </details>
        </div>`;
    }

    function acoToolbar() {
      const filters = ACO_COLUMNS.filter(c => c.filter).map(col => {
        const values = [...new Set(acoData.campaigns.map(c => c[col.field]).filter(v => v !== null && v !== ''))].sort();
        return `
          <select class="catalog-filter-select" data-aco-filter="${col.field}">
            <option value="">${escapeHtml(col.label)}: all</option>
            ${values.map(v => `<option value="${escapeHtml(v)}"${acoFilters[col.field] === v ? ' selected' : ''}>${escapeHtml(acoLabel(col.field, v))}</option>`).join('')}
          </select>`;
      }).join('');

      return `
        <div class="catalog-toolbar" style="flex-wrap: wrap; gap: 0.75rem;">
          <div class="aco-filter-row">
            <input type="search" id="aco-search" placeholder="Search campaigns…" value="${escapeHtml(acoSearch)}">
            ${filters}
            <label class="catalog-active-toggle">
              <input type="checkbox" id="aco-only-enabled"${acoOnlyEnabled ? ' checked' : ''}> Only enabled
            </label>
          </div>
          <div class="aco-toolbar-actions">
            <button class="btn btn-secondary" id="aco-toggle-all" type="button">Collapse all</button>
            <button class="btn btn-secondary" id="aco-export" type="button">Export CSV</button>
          </div>
        </div>`;
    }

    function acoFiltered() {
      const q = acoSearch.trim().toLowerCase();
      return acoData.campaigns.filter(c => {
        // A row with unsaved changes outranks every filter, or a search
        // keystroke would hide edits the save bar still says are pending.
        if (acoPending[c.campaignId]) return true;
        if (acoOnlyEnabled && c.state !== 'ENABLED') return false;
        for (const [field, val] of Object.entries(acoFilters)) {
          if (val && c[field] !== val) return false;
        }
        if (q && !String(c.name || '').toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function acoRenderTable() {
      const wrap = document.getElementById('aco-table-wrap');
      if (!wrap) return;

      const pfById = new Map(acoData.portfolios.map(p => [p.portfolioId, p]));
      const groups = new Map();
      for (const c of acoFiltered()) {
        const key = c.portfolioId || '(none)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      // Unfiltered, so the portfolio summary stays a fact about the portfolio
      // rather than a restatement of the filter.
      const allByPf = new Map();
      for (const c of acoData.campaigns) {
        const key = c.portfolioId || '(none)';
        if (!allByPf.has(key)) allByPf.set(key, []);
        allByPf.get(key).push(c);
      }

      if (!groups.size) {
        wrap.innerHTML = '<div style="padding: 3rem; text-align: center; color: var(--text-secondary);">No campaigns match these filters.</div>';
        return;
      }

      const ordered = [...groups.entries()].sort((a, b) => {
        const an = pfById.get(a[0])?.name || '(no portfolio)';
        const bn = pfById.get(b[0])?.name || '(no portfolio)';
        return an.localeCompare(bn);
      });

      const head = `<thead><tr>${ACO_VISIBLE.map(c =>
        `<th style="text-align: ${c.align === 'right' ? 'right' : 'left'};">${escapeHtml(c.label)}${
          c.tip ? adTip(c.tip) : ''}</th>`).join('')}</tr></thead>`;

      const body = ordered.map(([pfId, rows]) => {
        const pf = pfById.get(pfId);
        const collapsed = acoCollapsed.has(pfId);
        return `<tbody class="aco-group">
          ${acoPortfolioRow(pfId, pf, allByPf.get(pfId) || rows, rows.length, collapsed)}
          ${rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
                .map(c => acoCampaignRow(c, pfId, collapsed)).join('')}
        </tbody>`;
      }).join('');

      wrap.innerHTML = `<div class="aco-table-wrapper"><table class="aco-table">${head}${body}</table></div>`;
      acoRenderSaveBar();

      // Sticky group rows pin below the real thead, whose height is only known
      // after layout.
      requestAnimationFrame(() => {
        const table = wrap.querySelector('.aco-table');
        const thead = table && table.querySelector('thead');
        if (table && thead) table.style.setProperty('--aco-thead-height', `${thead.offsetHeight}px`);
      });
    }

    function acoPortfolioRow(pfId, pf, allRows, shownCount, collapsed) {
      const rows = allRows;
      const enabled = rows.filter(r => r.state === 'ENABLED');
      const total = enabled.reduce((s, r) => s + (typeof r.dailyBudget === 'number' ? r.dailyBudget : 0), 0);
      const name = pf ? pf.name : '(no portfolio)';

      // Portfolio budgets are PERIOD TOTALS with a policy, not daily caps.
      // Shown with the policy spelled out and never divided against the daily
      // sum beside it — they are different units, and "$500 cap vs $60/day"
      // reads as over-provisioned when it means the portfolio starves in 8 days.
      const cap = pf && typeof pf.budgetAmount === 'number'
        ? `<span title="Portfolio budget is a period total, not a daily cap">cap $${formatNumber(pf.budgetAmount)}${pf.budgetPolicy ? ` / ${escapeHtml(String(pf.budgetPolicy).toLowerCase().replace(/_/g, ' '))}` : ''}</span>`
        : '<span style="color: var(--text-secondary);">no cap</span>';

      return `
        <tr class="aco-portfolio-row${collapsed ? '' : ' expanded'}" data-aco-pf="${escapeHtml(pfId)}">
          <td><span class="expand-icon">▶</span><strong>${escapeHtml(name)}</strong></td>
          <td>${acoTypeChips(rows)}</td>
          <td></td>
          <td style="color: var(--text-secondary);">${enabled.length} of ${rows.length} on${
            shownCount < rows.length ? ` <span style="opacity: 0.6;">(${shownCount} shown)</span>` : ''
          }</td>
          <td style="color: var(--text-secondary);">${escapeHtml(rows[0]?.brand || '—')}</td>
          <td style="text-align: right; font-family: monospace;">$${formatNumber(total)}</td>
          <td colspan="${ACO_VISIBLE.length - 6}" style="color: var(--text-secondary); font-size: 0.75rem;">${cap}</td>
        </tr>`;
    }

    // Labelled "campaign types in this portfolio" deliberately — 42 portfolios
    // against 43 SKUs means this is not SKU coverage, and reading it that way
    // would miss exactly the SKU that has no portfolio.
    function acoTypeChips(rows) {
      const present = new Set(rows.filter(r => r.state !== 'ARCHIVED').map(r => r.campaignType));
      const live = new Set(rows.filter(r => r.state === 'ENABLED').map(r => r.campaignType));
      return ['Auto', 'Broad', 'Exact', 'ASIN'].map(t => {
        const exists = present.has(t);
        const running = live.has(t);
        const title = running ? `${t}: running`
                    : exists ? `${t}: exists but not enabled`
                    : `${t}: no campaign of this type in this portfolio`;
        // Three states, because "paused" and "absent" are different findings —
        // one is a campaign to switch on, the other is a gap to fill.
        const color = running ? 'var(--success)' : exists ? 'var(--warning)' : 'var(--text-secondary)';
        return `<span title="${escapeHtml(title)}" style="display: inline-block; margin-right: 0.35rem; font-size: 0.7rem; color: ${color}; opacity: ${exists ? 1 : 0.4};">${t}</span>`;
      }).join('');
    }

    function acoCampaignRow(c, pfId, collapsed) {
      const dirty = !!acoPending[c.campaignId];
      const rowError = acoRowErrors[c.campaignId];
      const cells = ACO_VISIBLE.map(col => {
        // Editable columns are always controls — there is no edit mode.
        if (col.editable) {
          const err = col.field === 'name' && rowError
            ? `<div class="aco-row-error">${escapeHtml(rowError)}</div>` : '';
          return `<td class="aco-cell-editing">${acoEditCell(col, c)}${err}</td>`;
        }
        const align = col.align === 'right' ? 'text-align: right;' : '';
        const mono = col.mono ? "font-family: 'Roboto Mono', monospace;" : '';
        let value;
        if (col.format === 'placements') {
          const text = acoPlacementsText(c.placements);
          if (text === null) {
            value = '<span style="color: var(--warning);" title="Amazon did not return placement modifiers for this campaign">unknown</span>';
          } else if (text === '') {
            value = '<span style="color: var(--text-secondary);">—</span>';
          } else {
            const full = (c.placements || [])
              .map(p => `${acoLabel('placement', p.placement)}: ${p.percentage}%`).join(', ');
            value = `<span title="${escapeHtml(full)}">${escapeHtml(text)}</span>`;
          }
        } else if (col.format === 'money') {
          value = typeof c[col.field] === 'number'
            ? '$' + formatNumber(c[col.field])
            : '<span style="color: var(--warning);">unknown</span>';
        } else if (col.field === 'state') {
          value = acoStateCell(c.state);
        } else if (col.field === 'campaignType') {
          value = c.typeSource === 'conflict'
            ? `<span style="color: var(--warning);" title="Campaign name and Amazon's targetingType disagree">${escapeHtml(c.campaignType || '—')} ⚠</span>`
            : escapeHtml(c.campaignType || '—');
        } else if (col.field === 'brand') {
          const label = c.brand
            ? escapeHtml(c.brand)
            : '<span style="color: var(--warning);">unmapped</span>';
          value = c.brandSource === 'override'
            ? `${label} <span title="Set in the dashboard, not derived from the campaign name" style="color: var(--text-secondary); font-size: 0.7rem;">·set</span>`
            : label;
        } else if (ACO_LABELS[col.field]) {
          // Raw enum kept on hover — the label is for reading, the enum is what
          // Amazon actually returned.
          value = `<span title="${escapeHtml(c[col.field] || '')}">${escapeHtml(acoLabel(col.field, c[col.field]) || '—')}</span>`;
        } else {
          value = escapeHtml(c[col.field] === null || c[col.field] === undefined ? '—' : c[col.field]);
        }
        if (col.field === 'name' && rowError) {
          // The failure message belongs next to the row that failed, not in a
          // banner somewhere else on the page.
          value += `<div class="aco-row-error">${escapeHtml(rowError)}</div>`;
        }
        return `<td style="${align} ${mono}">${value}</td>`;
      }).join('');

      const archived = c.presumedArchived ? ' title="Absent from recent syncs — presumed archived"' : '';
      // A collapsed group must not hide a row with unsaved changes.
      const hidden = collapsed && !dirty;
      return `<tr class="aco-campaign-row${dirty ? ' aco-row-dirty' : ''}${rowError ? ' aco-row-failed' : ''}" data-aco-pf="${escapeHtml(pfId)}" data-aco-id="${escapeHtml(c.campaignId)}"${archived}
                  style="display: ${hidden ? 'none' : 'table-row'};${c.presumedArchived ? ' opacity: 0.5;' : ''}">${cells}</tr>`;
    }

    // ── EDITOR ───────────────────────────────────────────────────────────────
    // No edit mode: editable cells are always controls. Changing one records a
    // pending edit and reveals the save bar.

    function acoEditCell(col, c) {
      const pending = acoPending[c.campaignId] || {};
      const dirty = (f) => f in pending;
      const cls = (f) => 'aco-cell-input' + (dirty(f) ? ' aco-dirty' : '');
      const idAttr = `data-aco-id="${escapeHtml(c.campaignId)}"`;

      // Only Sponsored Products can be written here; SB uses a different
      // endpoint and body shape entirely. Archived campaigns are locked for the
      // same practical reason — Amazon will not take the write.
      const archived = String(c.state).toUpperCase() === 'ARCHIVED' || !!c.presumedArchived;
      const sbLocked = c.adProduct !== 'SP' || archived;
      const lockReason = archived
        ? 'Archived campaigns cannot be changed here'
        : 'Sponsored Brands campaigns are read-only here';

      if (col.editable === 'text') {
        if (sbLocked) return `${escapeHtml(c.name)}${acoLockNote(lockReason)}`;
        // A pending rename keeps its box open regardless, so the unsaved value
        // stays visible and correctable.
        if (!acoNameEditing.has(c.campaignId) && !('name' in pending)) {
          return `${escapeHtml(c.name)}<span class="aco-edit-affordance" role="button" tabindex="0"
                    data-aco-editname="${escapeHtml(c.campaignId)}" title="Rename this campaign"
                    aria-label="Rename ${escapeHtml(c.name)}">&#9998;</span>`;
        }
        const value = 'name' in pending ? pending.name : (c.name || '');
        return `<input type="text" class="${cls('name')}" data-aco-input="name" ${idAttr}
                       value="${escapeHtml(value)}" spellcheck="false">`;
      }

      if (col.editable === 'state') {
        // ARCHIVED is deliberately absent from the options: it is irreversible
        // on Amazon and would sit one option away from the other two. Archive
        // in Campaign Manager instead.
        if (sbLocked) return acoStateCell(c.state);
        const value = 'state' in pending ? pending.state : (c.state || '');
        return `<select class="${cls('state')}" data-aco-input="state" ${idAttr}>
          ${['ENABLED', 'PAUSED'].map(v =>
            `<option value="${v}"${value === v ? ' selected' : ''}>${escapeHtml(acoLabel('state', v))}</option>`).join('')}
        </select>`;
      }

      if (col.editable === 'money') {
        if (sbLocked) return typeof c.dailyBudget === 'number' ? '$' + formatNumber(c.dailyBudget) : '—';
        // The API needs budgetType alongside the amount; the server refuses the
        // write without it, so do not offer the box.
        if (typeof c.dailyBudget === 'number' && !c.budgetType) {
          return `$${formatNumber(c.dailyBudget)}${acoLockNote('Amazon did not return a budget type for this campaign, so the budget cannot be changed safely')}`;
        }
        if (typeof c.dailyBudget !== 'number') {
          // null means UNKNOWN. Pre-filling an input from unknown is how you
          // send a number Amazon never told you.
          return `<span style="color: var(--warning);">unknown</span>${acoLockNote('Amazon did not return a budget for this campaign')}`;
        }
        const value = 'dailyBudget' in pending ? pending.dailyBudget : c.dailyBudget;
        return `<input type="number" step="0.01" min="0" class="${cls('dailyBudget')} aco-cell-num"
                       data-aco-input="dailyBudget" ${idAttr} value="${escapeHtml(String(value))}">`;
      }

      if (col.editable === 'bidding') {
        if (sbLocked) return escapeHtml(acoLabel('biddingStrategy', c.biddingStrategy) || '—');
        // Strategy and placements share one object on Amazon's side. Unknown
        // placements means the server will refuse a strategy write too, so the
        // control is locked here rather than failing at save time.
        if (c.placements === null || c.placements === undefined) {
          return `${escapeHtml(acoLabel('biddingStrategy', c.biddingStrategy) || '—')}${acoLockNote('Amazon did not return bidding details for this campaign, so bidding and placements cannot be changed safely')}`;
        }
        const value = 'biddingStrategy' in pending ? pending.biddingStrategy : (c.biddingStrategy || '');
        // The current value is included even when it is not one of the three
        // known strategies, so an unfamiliar one cannot be silently replaced
        // just by the cell rendering.
        const known = Object.keys(ACO_LABELS.biddingStrategy);
        const options = known.includes(value) || !value ? known : [value, ...known];
        return `<select class="${cls('biddingStrategy')}" data-aco-input="biddingStrategy" ${idAttr}>
          ${options.map(v =>
            `<option value="${escapeHtml(v)}"${value === v ? ' selected' : ''}>${escapeHtml(acoLabel('biddingStrategy', v))}</option>`).join('')}
        </select>`;
      }

      if (col.editable === 'placements') {
        if (sbLocked) {
          const text = acoPlacementsText(c.placements);
          if (text === null) return '<span style="color: var(--warning);">unknown</span>';
          return text === ''
            ? '<span style="color: var(--text-secondary);">—</span>'
            : escapeHtml(text);
        }
        if (c.placements === null || c.placements === undefined) {
          // Mirrors the server's refusal: without knowing the current
          // percentages, writing bidding at all could wipe them.
          return `<span style="color: var(--warning);">unknown</span>${acoLockNote('Amazon did not return placement modifiers, so these cannot be changed safely')}`;
        }
        const pendingList = 'placements' in pending ? pending.placements : null;
        const byType = {};
        for (const p of (pendingList || c.placements || [])) byType[p.placement] = p.percentage;
        return `<span class="aco-placement-inputs">${ACO_PLACEMENT_TYPES.map(t => `
          <label title="${escapeHtml(acoLabel('placement', t))}">
            <span>${escapeHtml(ACO_PLACEMENT_SHORT[t] || t)}</span>
            <input type="number" min="0" max="900" step="1"
                   class="${cls('placements')} aco-cell-pct"
                   data-aco-input="placements" data-aco-placement="${t}" ${idAttr}
                   value="${byType[t] === undefined ? '' : escapeHtml(String(byType[t]))}">
          </label>`).join('')}</span>`;
      }

      if (col.editable === 'brand') {
        // '' is the "use the name prefix" option, which is how an override is
        // cleared. Distinct from a brand that happens to equal the prefix.
        const value = 'brand' in pending
          ? (pending.brand ?? '')
          : (c.brandSource === 'override' ? c.brand : '');
        const dirty = 'brand' in pending;
        return `<select class="aco-cell-input${dirty ? ' aco-dirty' : ''}" data-aco-input="brand"
                        data-aco-id="${escapeHtml(c.campaignId)}"
                        title="Stored in the dashboard only — Amazon has no brand field">
          <option value=""${value === '' ? ' selected' : ''}>${c.brandFromPrefix ? escapeHtml(c.brandFromPrefix) : 'unmapped'}</option>
          ${acoBrandOptions()
            // The prefix-derived brand is already the first option; listing it
            // again would be two identical labels doing the same thing.
            .filter(b => b !== c.brandFromPrefix)
            .map(b => `<option value="${escapeHtml(b)}"${value === b ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>`;
      }
      return '';
    }

    function acoLockNote(reason) {
      return ` <span class="aco-lock" title="${escapeHtml(reason)}">&#128274;</span>`;
    }

    function acoBrandOptions() {
      // Server-supplied, so the options always match what the update action
      // accepts. Falling back to the loaded data would silently offer fewer
      // brands whenever a filter or a sparse account hid one.
      if (Array.isArray(acoData.knownBrands) && acoData.knownBrands.length) return acoData.knownBrands;
      return [...new Set(acoData.campaigns.map(c => c.brandFromPrefix).filter(Boolean))].sort();
    }

    // Records a change only when it differs from what is stored, so setting a
    // field back to its original value clears the pending edit rather than
    // queueing a no-op write.
    function acoSetPending(campaignId, field, rawValue) {
      const c = acoData.campaigns.find(x => x.campaignId === campaignId);
      if (!c) return;

      const setOrClear = (unchanged, value) => {
        if (unchanged) {
          if (acoPending[campaignId]) delete acoPending[campaignId][field];
        } else {
          acoPending[campaignId] = acoPending[campaignId] || {};
          acoPending[campaignId][field] = value;
        }
      };

      if (field === 'brand') {
        const value = rawValue === '' ? null : rawValue;
        const effective = value === null ? (c.brandFromPrefix || null) : value;
        setOrClear((effective || null) === (c.brand || null), value);

      } else if (field === 'name') {
        const value = String(rawValue);
        setOrClear(value.trim() === String(c.name || '').trim(), value);

      } else if (field === 'state') {
        setOrClear(rawValue === c.state, rawValue);

      } else if (field === 'dailyBudget') {
        const value = parseFloat(rawValue);
        // An unparseable box is left pending so the save bar can refuse it,
        // rather than silently discarding what was typed.
        const unchanged = Number.isFinite(value) &&
                          Math.round(value * 100) === Math.round((c.dailyBudget || 0) * 100);
        setOrClear(unchanged, Number.isFinite(value) ? value : rawValue);

      } else if (field === 'biddingStrategy') {
        setOrClear(rawValue === c.biddingStrategy, rawValue);

      } else if (field === 'placements') {
        // Read every placement box in this row, not just the one that changed —
        // placements are written as a whole array.
        const list = acoReadPlacementInputs(campaignId);
        setOrClear(acoPlacementsKey(list) === acoPlacementsKey(c.placements || []), list);
      }

      if (acoPending[campaignId] && !Object.keys(acoPending[campaignId]).length) {
        delete acoPending[campaignId];
      }
      delete acoRowErrors[campaignId];
      acoSyncRowMarkers(campaignId);
      acoRenderSaveBar();
    }

    // Re-renders nothing: repaints the dirty highlighting for one row in place,
    // so typing never destroys the element being typed into.
    function acoSyncRowMarkers(campaignId) {
      const pending = acoPending[campaignId] || {};
      const row = document.querySelector(`tr.aco-campaign-row[data-aco-id="${CSS.escape(campaignId)}"]`);
      if (!row) return;
      row.classList.toggle('aco-row-dirty', Object.keys(pending).length > 0);
      row.classList.remove('aco-row-failed');
      const err = row.querySelector('.aco-row-error');
      if (err) err.remove();
      row.querySelectorAll('[data-aco-input]').forEach(el => {
        el.classList.toggle('aco-dirty', el.dataset.acoInput in pending);
      });
    }

    // The row's placement boxes, as the array the API expects. Blank means "no
    // adjustment for this placement" and is omitted rather than sent as 0.
    function acoReadPlacementInputs(campaignId) {
      const inputs = document.querySelectorAll(
        `[data-aco-input="placements"][data-aco-id="${CSS.escape(campaignId)}"]`);
      const out = [];
      inputs.forEach(el => {
        const raw = el.value.trim();
        if (raw === '') return;
        const pct = parseFloat(raw);
        out.push({ placement: el.dataset.acoPlacement, percentage: Number.isFinite(pct) ? pct : raw });
      });
      return out.sort((a, b) => a.placement.localeCompare(b.placement));
    }

    // Same canonical form the server uses, so the two agree about what changed.
    function acoPlacementsKey(list) {
      return (list || []).slice()
        .sort((a, b) => a.placement.localeCompare(b.placement))
        .map(p => `${p.placement}:${p.percentage}`).join('|');
    }

    function acoPendingList() {
      return Object.entries(acoPending).map(([campaignId, fields]) => {
        const c = acoData.campaigns.find(x => x.campaignId === campaignId);
        const diffs = [];
        if ('brand' in fields) {
          const effective = fields.brand === null ? (c?.brandFromPrefix || null) : fields.brand;
          diffs.push({ field: 'brand', label: 'Brand', scope: 'local', from: c?.brand || null, to: effective });
        }
        if ('name' in fields) diffs.push({ field: 'name', label: 'Name', scope: 'amazon', from: c?.name, to: fields.name });
        if ('state' in fields) diffs.push({ field: 'state', label: 'State', scope: 'amazon',
          from: acoLabel('state', c?.state), to: acoLabel('state', fields.state) });
        if ('dailyBudget' in fields) diffs.push({ field: 'dailyBudget', label: 'Budget', scope: 'amazon',
          from: typeof c?.dailyBudget === 'number' ? '$' + formatNumber(c.dailyBudget) : '—',
          to: typeof fields.dailyBudget === 'number' ? '$' + formatNumber(fields.dailyBudget) : String(fields.dailyBudget) });
        if ('biddingStrategy' in fields) diffs.push({ field: 'biddingStrategy', label: 'Bidding', scope: 'amazon',
          from: acoLabel('biddingStrategy', c?.biddingStrategy), to: acoLabel('biddingStrategy', fields.biddingStrategy) });
        if ('placements' in fields) diffs.push({ field: 'placements', label: 'Placements', scope: 'amazon',
          from: acoPlacementsText(c?.placements) || 'none', to: acoPlacementsText(fields.placements) || 'none' });
        return { campaignId, name: c?.name || campaignId, fields, diffs, campaign: c };
      });
    }

    function acoRenderSaveBar() {
      const bar = document.getElementById('aco-save-bar');
      if (!bar) return;
      const list = acoPendingList();

      if (!list.length) {
        bar.innerHTML = '';
        bar.style.display = 'none';
        return;
      }

      const failed = list.filter(p => acoRowErrors[p.campaignId]);
      const problems = acoPendingProblems(list);
      const warnings = acoPendingWarnings(list);
      const n = list.length;

      bar.style.display = 'block';
      bar.innerHTML = `
        <div class="aco-save-bar-inner">
          <div class="aco-save-bar-summary">
            <strong>${n} unsaved change${n === 1 ? '' : 's'}</strong>
            <span class="aco-save-bar-detail">${list.slice(0, 3).map(p =>
              `${escapeHtml(p.name)}: ${p.diffs.map(d =>
                `${d.label} ${acoDiffText(d.from)} → ${acoDiffText(d.to)}`).join(', ')}`
            ).join(' · ')}${n > 3 ? ` · and ${n - 3} more` : ''}</span>
            ${failed.length ? `<span class="aco-save-bar-failed">${failed.length} failed — still unsaved</span>` : ''}
            ${problems.map(w => `<span class="aco-save-bar-failed">${escapeHtml(w)}</span>`).join('')}
            ${warnings.map(w => `<span class="aco-save-bar-warn">${escapeHtml(w)}</span>`).join('')}
          </div>
          <div class="aco-save-bar-actions">
            <button class="btn btn-secondary" data-aco-bar="discard"${acoSaveBusy ? ' disabled' : ''}>Discard</button>
            <button class="btn btn-primary" data-aco-bar="save"${acoSaveBusy || problems.length ? ' disabled' : ''}>${
              acoSaveBusy ? 'Saving<span class="loading"></span>' : 'Save changes'}</button>
          </div>
        </div>`;
    }

    // One side of a diff, short enough that three campaigns still fit on the bar.
    function acoDiffText(v) {
      if (v === null || v === undefined || v === '') return '—';
      const t = String(v);
      return escapeHtml(t.length > 28 ? t.slice(0, 27) + '…' : t);
    }

    // Hard stops — the save button is disabled while any of these hold.
    function acoPendingProblems(list) {
      const out = [];
      for (const item of list) {
        const f = item.fields;
        if ('dailyBudget' in f && !(Number.isFinite(f.dailyBudget) && f.dailyBudget > 0)) {
          out.push(`${item.name}: budget must be a number above zero`);
        }
        if ('name' in f && !String(f.name).trim()) {
          out.push(`${item.name}: name cannot be empty`);
        }
        if ('placements' in f) {
          for (const p of f.placements) {
            const pct = p.percentage;
            if (!Number.isFinite(pct) || pct < 0 || pct > 900 || Math.round(pct) !== pct) {
              out.push(`${item.name}: placement percentages must be whole numbers 0–900`);
              break;
            }
          }
        }
      }
      return out;
    }

    // Soft warnings — shown, but they do not block the save.
    function acoPendingWarnings(list) {
      const out = [];
      for (const item of list) {
        const f = item.fields;
        const c = item.campaign || {};
        if (f.state === 'ENABLED' && c.state !== 'ENABLED') {
          const budget = 'dailyBudget' in f ? f.dailyBudget : c.dailyBudget;
          out.push(`${item.name} will start spending${typeof budget === 'number' ? ` up to $${formatNumber(budget)}/day` : ''}`);
        }
        if ('dailyBudget' in f && typeof c.dailyBudget === 'number' && c.dailyBudget > 0 &&
            Number.isFinite(f.dailyBudget) && f.dailyBudget >= c.dailyBudget * 3) {
          out.push(`${item.name}: budget ${Math.round(f.dailyBudget / c.dailyBudget)}× higher than now`);
        }
      }
      return out;
    }

    // Opening and closing the name box repaints only that cell. Re-rendering
    // the table here would drop focus the instant it was granted, and on the
    // way out would destroy whatever element is being tabbed to.
    function acoOpenNameEdit(campaignId) {
      acoNameEditing.add(campaignId);
      acoRepaintNameCell(campaignId);
      const el = document.querySelector(
        `[data-aco-input="name"][data-aco-id="${CSS.escape(campaignId)}"]`);
      if (el) { el.focus(); el.select(); }
    }

    function acoCloseNameEdit(campaignId) {
      // An unsaved rename has nowhere else to live, so the box stays.
      if (acoPending[campaignId] && 'name' in acoPending[campaignId]) return;
      acoNameEditing.delete(campaignId);
      acoRepaintNameCell(campaignId);
    }

    function acoRepaintNameCell(campaignId) {
      const c = acoData.campaigns.find(x => x.campaignId === campaignId);
      const row = document.querySelector(
        `tr.aco-campaign-row[data-aco-id="${CSS.escape(campaignId)}"]`);
      if (!c || !row) return;
      const col = ACO_VISIBLE.find(x => x.field === 'name');
      const td = row.cells[ACO_VISIBLE.indexOf(col)];
      if (!td) return;
      const err = acoRowErrors[campaignId]
        ? `<div class="aco-row-error">${escapeHtml(acoRowErrors[campaignId])}</div>` : '';
      td.innerHTML = acoEditCell(col, c) + err;
    }

    function acoDiscardPending() {
      acoPending = {};
      acoRowErrors = {};
      acoNameEditing.clear();
      acoRenderTable();
      acoRenderSaveBar();
    }

    async function acoSavePending() {
      if (acoSaveBusy || !accessToken) return;
      const list = acoPendingList();
      if (!list.length) return;
      if (acoPendingProblems(list).length) return;

      acoSaveBusy = true;
      acoRowErrors = {};
      acoRenderSaveBar();

      const saved = [];
      // Sequential, so a failure is attributable to one campaign and the ones
      // that already succeeded are not re-sent on a retry.
      for (const item of list) {
        try {
          const res = await fetch('/api/adcampaigns?action=update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({
              campaignId: item.campaignId,
              adProduct: (item.campaign || {}).adProduct,
              local: 'brand' in item.fields ? { brand: item.fields.brand } : {},
              amazon: acoAmazonPayload(item.fields),
              // What the row displayed. The server compares this against
              // Amazon's current values and refuses rather than silently
              // reverting a change made in Campaign Manager since the sync.
              expected: acoExpectedFor(item.campaign, item.fields),
              // For the change history: which page the edit came from.
              origin: 'campaigns'
            })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            if (data.conflicts && data.conflicts.length) {
              const c0 = data.conflicts[0];
              throw new Error(`Amazon now has ${c0.field} = ${c0.amazonHasNow ?? '—'} (you saw ${c0.youSaw ?? '—'}). Refresh and try again.`);
            }
            throw new Error(data.error || `Save failed (${res.status})`);
          }
          if (data.notApplied && data.notApplied.length) {
            console.warn('[ACO] Amazon accepted but did not apply:', data.notApplied);
          }
          if (data.collateral && data.collateral.length) {
            console.warn('[ACO] fields changed that were not requested:', data.collateral);
          }
          saved.push(item);
          delete acoPending[item.campaignId];
        } catch (err) {
          console.error('[ACO] save failed for', item.campaignId, err);
          acoRowErrors[item.campaignId] = err.message;
        }
      }

      acoSaveBusy = false;
      for (const item of saved) acoNameEditing.delete(item.campaignId);

      if (saved.length) {
        acoFlash = saved.length === 1
          ? `Saved ${saved[0].name}: ${saved[0].diffs.map(d => `${d.label} ${d.from ?? '—'} → ${d.to ?? '—'}`).join(', ')}`
          : `Saved ${saved.length} changes.`;
      }

      if (Object.keys(acoPending).length) {
        // Some failed: keep them pending so a retry is one click, and leave the
        // successful ones out of the queue.
        acoRenderTable();
        acoRenderSaveBar();
        if (saved.length) acoRenderFlashOnly();
      } else {
        // No optimistic update — the rows come back from the server.
        loadAdCampaigns();
      }
    }

    function acoAmazonPayload(fields) {
      const out = {};
      for (const k of ['name', 'state', 'dailyBudget', 'biddingStrategy', 'placements']) {
        if (k in fields) out[k] = fields[k];
      }
      return out;
    }

    function acoExpectedFor(c, fields) {
      const out = {};
      if (!c) return out;
      for (const k of ['name', 'state', 'dailyBudget', 'biddingStrategy']) {
        if (k in fields) out[k] = c[k] ?? null;
      }
      if ('placements' in fields) out.placementsSummary = c.placementsSummary ?? null;
      return out;
    }

    // Shows the flash without a full re-render, for the partial-failure case
    // where the save bar and the failed rows must stay exactly as they are.
    function acoRenderFlashOnly() {
      const container = document.getElementById('adcampaigns-content');
      if (!container || !acoFlash) return;
      const msg = acoFlash;
      acoFlash = null;
      const div = document.createElement('div');
      div.className = 'card';
      div.style.cssText = 'margin-bottom: 1.5rem; border-left: 3px solid var(--success);';
      div.innerHTML = `<div style="color: var(--success);">${escapeHtml(msg)}</div>`;
      container.insertBefore(div, container.firstChild);
    }

    function acoStateCell(state) {
      const color = state === 'ENABLED' ? 'var(--success)'
                  : state === 'PAUSED' ? 'var(--warning)'
                  : 'var(--text-secondary)';
      return `<span style="color: ${color};" title="${escapeHtml(state || '')}">${escapeHtml(acoLabel('state', state) || '—')}</span>`;
    }

    // ─── TABS ────────────────────────────────────────────────────────────────
    // Campaigns (the table) and Change log. The table loads with the page
    // either way; the log loads whenever its tab is shown. The tab is
    // remembered per browser, as the Cadences page remembers its own.
    function acoShowTab(tab) {
      if (tab !== 'changes') tab = 'campaigns';
      document.querySelectorAll('.aco-subtab').forEach(el => { el.style.display = 'none'; });
      document.querySelectorAll('#adcampaigns-page .tab').forEach(b => b.classList.remove('active'));
      const panel = document.getElementById(`aco-panel-${tab}`);
      const button = document.getElementById(`aco-tab-${tab}`);
      if (panel) panel.style.display = 'block';
      if (button) button.classList.add('active');
      try { localStorage.setItem('currentAcoTab', tab); } catch (e) { /* storage unavailable */ }
      if (tab === 'changes') acoLoadChanges();
    }

    function acoTabSaved() {
      try {
        return localStorage.getItem('currentAcoTab') === 'changes' ? 'changes' : 'campaigns';
      } catch (e) { return 'campaigns'; }
    }

    // ─── CHANGE LOG ──────────────────────────────────────────────────────────
    // Every recorded change, newest first, searched on the server
    // (/api/adcampaigns?action=changes). The controls render once; typing or
    // picking a filter re-fetches and redraws only the results, so the search
    // box keeps its focus.

    // Where a change was made. Edits from the dashboard carry the page they
    // came from (recorded since 2026-10-22; earlier ones say only
    // "Dashboard"); a change with no source was found by a refresh, so it was
    // made somewhere else — the Ads Console, say.
    const ACO_MADE_FROM = {
      weekly: 'Weekly review', biweekly: 'Bi-weekly review', monthly: 'Monthly review',
      campaigns: 'Campaign Overview', dashboard: 'Dashboard', detected: 'Detected at refresh'
    };
    const ACO_LOG_MONEY = new Set(['dailyBudget', 'defaultBid']);

    let acoLog = { q: '', field: '', madeFrom: '', from: '', to: '' };
    let acoLogPage = 1;      // 25 to a page (the server's page size); a new search starts at 1
    let acoLogFields = [];
    let acoLogRequest = 0;   // only the latest search's answer is drawn
    let acoLogTimer = null;

    function acoMadeFrom(r) {
      if (r.source !== 'edit') return ACO_MADE_FROM.detected;
      return ACO_MADE_FROM[r.origin] || ACO_MADE_FROM.dashboard;
    }

    function acoLogValue(field, value) {
      if (value === null || value === undefined || value === '') return '—';
      if (ACO_LOG_MONEY.has(field) && typeof value === 'number') return '$' + formatNumber(value);
      return acoLabel(field, value);
    }

    // The day it was recorded, and for a dashboard edit the time it was made.
    // A refresh only knows the day it noticed the change, so no time is shown.
    function acoLogWhen(r) {
      const day = r.ptDate || '';
      if (r.source !== 'edit' || !r.at) return day;
      const time = new Date(r.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `${day} · ${time}`;
    }

    function acoLoadChanges() {
      const container = document.getElementById('aco-changes-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view the change log.</div>';
        return;
      }
      if (!document.getElementById('aco-log-results')) {
        container.innerHTML = acoLogControls() + '<div id="aco-log-results"></div>';
        acoBindLogControls();
      }
      acoFetchChanges();
    }

    function acoLogFieldOptions() {
      const fields = acoLogFields.includes(acoLog.field) || !acoLog.field ? acoLogFields : [...acoLogFields, acoLog.field];
      return `<option value="">Change: any</option>` + fields.map(f =>
        `<option value="${escapeHtml(f)}"${acoLog.field === f ? ' selected' : ''}>${escapeHtml(ACO_FIELD_LABELS[f] || f)}</option>`).join('');
    }

    function acoLogControls() {
      const made = ['weekly', 'biweekly', 'monthly', 'campaigns', 'dashboard', 'detected'].map(k =>
        `<option value="${k}"${acoLog.madeFrom === k ? ' selected' : ''}>${
          escapeHtml(k === 'dashboard' ? 'Dashboard (page not recorded)' : ACO_MADE_FROM[k])}</option>`).join('');
      return `
        <div class="catalog-toolbar" style="flex-wrap: wrap; gap: 0.75rem;">
          <div class="aco-filter-row">
            <input type="search" id="aco-log-q" placeholder="Search campaign name or ID…" value="${escapeHtml(acoLog.q)}">
            <select class="catalog-filter-select" id="aco-log-field">${acoLogFieldOptions()}</select>
            <select class="catalog-filter-select" id="aco-log-made">
              <option value="">Made from: anywhere</option>${made}
            </select>
            <label class="aco-log-date">From <input type="date" id="aco-log-from" value="${escapeHtml(acoLog.from)}"></label>
            <label class="aco-log-date">To <input type="date" id="aco-log-to" value="${escapeHtml(acoLog.to)}"></label>
          </div>
          <div class="aco-toolbar-actions">
            <button class="btn btn-secondary" id="aco-log-clear" type="button">Clear</button>
          </div>
        </div>`;
    }

    function acoBindLogControls() {
      const searchBox = document.getElementById('aco-log-q');
      searchBox.addEventListener('input', e => {
        acoLog.q = e.target.value;
        acoLogPage = 1;
        clearTimeout(acoLogTimer);
        acoLogTimer = setTimeout(acoFetchChanges, 250);
      });
      [['aco-log-field', 'field'], ['aco-log-made', 'madeFrom'], ['aco-log-from', 'from'], ['aco-log-to', 'to']].forEach(([id, key]) => {
        document.getElementById(id).addEventListener('change', e => { acoLog[key] = e.target.value; acoLogPage = 1; acoFetchChanges(); });
      });
      document.getElementById('aco-log-clear').addEventListener('click', () => {
        acoLog = { q: '', field: '', madeFrom: '', from: '', to: '' };
        acoLogPage = 1;
        document.getElementById('aco-changes-content').innerHTML = acoLogControls() + '<div id="aco-log-results"></div>';
        acoBindLogControls();
        acoFetchChanges();
      });
    }

    function acoFetchChanges() {
      const results = document.getElementById('aco-log-results');
      if (!results || !accessToken) return;
      const request = ++acoLogRequest;
      const params = new URLSearchParams({ action: 'changes' });
      for (const [key, value] of Object.entries(acoLog)) if (value.trim()) params.set(key, value.trim());
      if (acoLogPage > 1) params.set('page', String(acoLogPage));
      if (!results.innerHTML) results.innerHTML = '<div style="padding: 3rem; text-align: center; color: var(--text-secondary);">Loading the change log…</div>';

      fetch(`/api/adcampaigns?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Failed to load (${res.status})`);
          if (request !== acoLogRequest) return;
          // Past the last page (the log or the matches shrank): show the last one.
          const lastPage = Math.max(1, Math.ceil((data.total || 0) / (data.limit || 25)));
          if (acoLogPage > lastPage) { acoLogPage = lastPage; acoFetchChanges(); return; }
          acoLogFields = data.fields || [];
          const fieldSelect = document.getElementById('aco-log-field');
          if (fieldSelect) fieldSelect.innerHTML = acoLogFieldOptions();
          acoRenderChanges(data);
        })
        .catch(err => {
          if (request !== acoLogRequest) return;
          console.error('[ACO] change log failed:', err);
          results.innerHTML = `<div style="padding: 3rem; text-align: center; color: var(--error);">Error: ${escapeHtml(err.message)}</div>`;
        });
    }

    function acoRenderChanges(data) {
      const results = document.getElementById('aco-log-results');
      if (!results) return;
      const rows = data.rows || [];
      const searching = Object.values(acoLog).some(v => v.trim());
      if (!rows.length) {
        results.innerHTML = `<div style="padding: 3rem; text-align: center; color: var(--text-secondary);">${
          searching ? 'No changes match.' : 'No changes recorded yet.'}</div>`;
        return;
      }
      const first = (data.offset || 0) + 1;
      const pages = Math.max(1, Math.ceil(data.total / (data.limit || 25)));
      const count = pages > 1
        ? `Showing ${first}–${first + rows.length - 1} of ${data.total} changes`
        : `${data.total} change${data.total === 1 ? '' : 's'}`;
      const pager = pages > 1 ? `
        <div class="aco-log-pager">
          <button class="btn btn-secondary" type="button" data-aco-log-page="${acoLogPage - 1}"${acoLogPage <= 1 ? ' disabled' : ''}>‹ Previous</button>
          <span>Page ${acoLogPage} of ${pages}</span>
          <button class="btn btn-secondary" type="button" data-aco-log-page="${acoLogPage + 1}"${acoLogPage >= pages ? ' disabled' : ''}>Next ›</button>
        </div>` : '';
      results.innerHTML = `
        <div class="aco-log-summary">
          <span>${escapeHtml(count)}</span>${pager}
        </div>
        <div class="card card-flat" style="overflow-x: auto;">
          <table style="width: 100%;">
            <thead><tr><th>When</th><th>Campaign</th><th>Type</th><th>Change</th><th>From</th><th>To</th><th>Made from</th></tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td style="white-space: nowrap;">${escapeHtml(acoLogWhen(r))}</td>
                <td title="${escapeHtml(r.campaignId || '')}">${escapeHtml(r.name || r.campaignId || '')}</td>
                <td>${escapeHtml(r.adProduct || '')}</td>
                <td>${escapeHtml(ACO_FIELD_LABELS[r.field] || r.field || '')}</td>
                <td>${escapeHtml(acoLogValue(r.field, r.from))}</td>
                <td>${escapeHtml(acoLogValue(r.field, r.to))}</td>
                <td style="white-space: nowrap;">${escapeHtml(acoMadeFrom(r))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${pager ? `<div class="aco-log-summary aco-log-summary-bottom">${pager}</div>` : ''}`;
      results.querySelectorAll('[data-aco-log-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          acoLogPage = Number(btn.dataset.acoLogPage);
          // From the pager under the table, go back up to where the page starts.
          if (btn.closest('.aco-log-summary-bottom')) results.scrollIntoView({ block: 'start' });
          acoFetchChanges();
        });
      });
    }

    // ─── CONTROLS ────────────────────────────────────────────────────────────

    function acoBindControls() {
      const search = document.getElementById('aco-search');
      if (search) search.addEventListener('input', e => { acoSearch = e.target.value; acoRenderTable(); });

      document.querySelectorAll('[data-aco-filter]').forEach(sel => {
        sel.addEventListener('change', e => {
          acoFilters[e.target.dataset.acoFilter] = e.target.value;
          acoRenderTable();
        });
      });

      const only = document.getElementById('aco-only-enabled');
      if (only) only.addEventListener('change', e => { acoOnlyEnabled = e.target.checked; acoRenderTable(); });

      const exp = document.getElementById('aco-export');
      if (exp) exp.addEventListener('click', acoExportCSV);

      const toggleAll = document.getElementById('aco-toggle-all');
      if (toggleAll) toggleAll.addEventListener('click', () => {
        const anyOpen = acoCollapsed.size < acoData.portfolios.length;
        acoCollapsed = anyOpen ? new Set(acoData.portfolios.map(p => p.portfolioId).concat('(none)')) : new Set();
        toggleAll.textContent = anyOpen ? 'Expand all' : 'Collapse all';
        acoRenderTable();
      });

      // Delegated so it survives every re-render of the table.
      const wrap = document.getElementById('aco-table-wrap');
      // Delegated, so controls survive every table re-render. Both events:
      // `input` keeps the save bar live while typing, `change` catches the
      // number spinners and any programmatic set.
      if (wrap) ['input', 'change'].forEach(evt => wrap.addEventListener(evt, e => {
        const el = e.target;
        const field = el && el.dataset && el.dataset.acoInput;
        if (!field) return;
        acoSetPending(el.dataset.acoId, field, el.value);
      }));

      // focusout, not blur: blur does not bubble, so a delegated handler on the
      // wrapper would never see it.
      if (wrap) wrap.addEventListener('focusout', e => {
        const el = e.target;
        if (!el.dataset || el.dataset.acoInput !== 'name') return;
        acoCloseNameEdit(el.dataset.acoId);
      });

      if (wrap) wrap.addEventListener('keydown', e => {
        const el = e.target;
        if (!el.dataset) return;

        // Tab lands on the pencil; Enter or Space opens it, the same as a click.
        if (el.dataset.acoEditname && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          acoOpenNameEdit(el.dataset.acoEditname);
          return;
        }

        if (el.dataset.acoInput !== 'name') return;
        if (e.key === 'Enter') { el.blur(); }
        else if (e.key === 'Escape') {
          // Escape abandons the rename outright rather than leaving a pending
          // edit that only Discard — which drops every other row too — clears.
          const c = acoData.campaigns.find(x => x.campaignId === el.dataset.acoId);
          el.value = c ? (c.name || '') : el.value;
          acoSetPending(el.dataset.acoId, 'name', el.value);
          acoCloseNameEdit(el.dataset.acoId);
        }
      });

      const bar = document.getElementById('aco-save-bar');
      if (bar) bar.addEventListener('click', e => {
        const btn = e.target.closest('[data-aco-bar]');
        if (!btn) return;
        if (btn.dataset.acoBar === 'save') acoSavePending();
        else if (btn.dataset.acoBar === 'discard') acoDiscardPending();
      });

      if (wrap) wrap.addEventListener('click', e => {
        const pencil = e.target.closest('[data-aco-editname]');
        if (pencil) { acoOpenNameEdit(pencil.dataset.acoEditname); return; }

        const row = e.target.closest('.aco-portfolio-row');
        if (!row) return;
        const pfId = row.dataset.acoPf;
        if (acoCollapsed.has(pfId)) acoCollapsed.delete(pfId);
        else acoCollapsed.add(pfId);
        acoRenderTable();
      });
    }

    function acoExportCSV() {
      const pfById = new Map(acoData.portfolios.map(p => [p.portfolioId, p]));
      const fields = ACO_COLUMNS.map(c => c.field);
      const rows = acoFiltered().map(c => {
        const enriched = { ...c, portfolio: pfById.get(c.portfolioId)?.name || '' };
        return fields.map(f => {
          const v = enriched[f];
          // Placements first: null means UNKNOWN, and an empty cell would read
          // as "no modifiers", which is a different fact.
          if (f === 'placements') return csvEscape(acoPlacementsText(v) ?? 'unknown');
          if (v === null || v === undefined) return csvEscape('');
          return csvEscape(ACO_LABELS[f] ? acoLabel(f, v) : v);
        }).join(',');
      });
      const csv = [ACO_COLUMNS.map(c => csvEscape(c.label)).join(','), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ad-campaigns-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function acoShowDiagnostic(title, payload) {
      const el = document.getElementById('aco-diagnostic');
      if (!el) return;
      el.innerHTML = `
        <div class="card card-flat" style="margin-top: 1.5rem; border-left: 3px solid var(--accent-orange);">
          <details open>
            <summary style="cursor: pointer; font-weight: 600;">${escapeHtml(title)}</summary>
            <pre style="margin-top: 1rem; max-height: 26rem; overflow: auto; font-size: 0.7rem; white-space: pre-wrap; word-break: break-word; color: var(--text-secondary);">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
          </details>
        </div>`;
    }

    function acoSetBlurb(text) {
      const el = document.getElementById('adcampaigns-blurb');
      if (el) el.textContent = text;
    }

    function acoSetBusy(busy, label) {
      ['aco-refresh-btn', 'aco-dry-btn', 'aco-probe-btn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = !!busy;
      });
      const main = document.getElementById('aco-refresh-btn');
      if (main) main.textContent = busy ? (label || 'Working…') : 'Refresh from Amazon';
    }
