    // ─── MONTHLY REVIEW ──────────────────────────────────────────────────────
    // Brand posture, with the evidence for it. The posture is the only thing
    // monthly feeds into another cadence: the bi-weekly reads it to decide how
    // hard to push each brand. Until now it was set by hand with nothing in
    // front of you, which is the problem this page exists to fix.
    //
    // Underneath, the two Sponsored Brands campaigns. They were pulled from the
    // weekly and the bi-weekly because they gated both runs, so this is the
    // only place they get looked at.
    //
    // Whole calendar months, the most recent one that is fully attributed. A
    // month's last day keeps crediting Sponsored Brands sales for 14 days, so
    // the previous month settles on the 15th, every month. A cron loads it
    // then, and because a settled month never changes again there is nothing
    // to refresh: which day you read it on is entirely up to you.
    //
    // RUNNING it, though, only works from the 15th. Before that the target
    // slides back an extra month to find one that has settled, and Amazon has
    // already dropped the comparison month: it keeps 95 days of Sponsored
    // Products reporting and 60 of Sponsored Brands. The server refuses that
    // case and says so rather than returning a half-built review.
    //
    // Everything is prefixed `mo`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined.
    //
    // loadAdMonthly() NEVER starts a run: showPage() and triggerCurrentPageLoad()
    // both fire on restore and after sign-in, and a run costs report quota.

    // Report IDs only. THE RESULT IS NEVER CACHED: the server stores what the
    // reports said and decides afresh on every read, so a posture just saved or
    // a brand remapped in Campaign Overview shows up on the next load.
    const MO_RUN_KEY = 'moRunState';
    const MO_POLL_MS = 20000;
    const MO_MAX_WAIT_MS = 45 * 60 * 1000;

    let moPollTimer = null;
    let moBusy = false;
    let moBound = false;
    // Posture choices are staged and saved together on Confirm. Saving on every
    // dropdown change meant a decision was already live at Amazon's next
    // bi-weekly before the other brands had even been looked at.
    let moPending = {};        // { [brand]: posture } staged, not yet saved
    let moConfirming = false;
    let moConfirmErrors = {};  // { [brand]: message } from the last Confirm
    // Sponsored Brands budget writes, keyed by campaign id.
    let moSbApply = {};        // { [campaignId]: { stage: 'confirm'|'busy'|'done'|'error', applied, message } }
    // In memory for the life of the page, never written to storage.
    let moData = null;

    function loadAdMonthly() {
      const container = document.getElementById('admonthly-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view the monthly review.</div>';
        return;
      }
      moFetch();

      const state = moRunLoad();
      if (state && !moPollTimer) {
        moSetStatus(moStatusLine(state.lastStatuses, state.startedAt));
        moSchedulePoll(0);
      }
    }

    // Decisions are made server-side on every read, so this is the only way the
    // page gets a result. There is nothing to invalidate.
    async function moFetch(after) {
      try {
        const res = await fetch('/api/adspend?action=monthly-get', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        if (data.empty) { moData = null; return moRenderIdle(); }
        moData = data;
        // A staged choice that now matches what is saved is not a change any more.
        for (const brand of Object.keys(moPending)) {
          const row = (data.rows || []).find(r => r.brand === brand);
          if (!row || row.posture === moPending[brand]) delete moPending[brand];
        }
        moRender(data);
        if (after) moSetStatus(after);
      } catch (err) {
        console.error('[MO] load failed:', err);
        moSetStatus('', err.message);
      }
    }

    // While a run is in flight the button resumes rather than re-requesting:
    // Amazon rejects an identical report while the prior one is generating.
    function moButtonClick() {
      if (moRunLoad()) moResume(); else moRun();
    }

    function moResume() {
      const state = moRunLoad();
      if (!state) return moRun();
      state.pollUntil = Date.now() + MO_MAX_WAIT_MS;
      state.pollErrors = 0;
      moRunSave(state);
      moSetBusy(true);
      moSetStatus(moStatusLine(state.lastStatuses, state.startedAt));
      moSchedulePoll(0);
    }

    async function moRun() {
      if (moBusy || !accessToken) return;
      if (moRunLoad()) return moResume();
      moBusy = true;
      moSetBusy(true);
      try {
        // Brands and margins are read from the census, and it decides which
        // campaigns are evaluated at all, so a stale one shrinks the run.
        moSetStatus('Refreshing campaign configuration…');
        const sync = await fetch('/api/adcampaigns?action=refresh', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const syncData = await sync.json().catch(() => ({}));
        if (!sync.ok) throw new Error('Could not refresh campaign configuration: ' +
                                      (syncData.error || `HTTP ${sync.status}`));

        moSetStatus('Requesting reports from Amazon…');
        const res = await fetch('/api/adspend?action=monthly-request', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) {
          const detail = (data.failures || [])
            .map(f => `${f.key}${f.window ? ` (${f.window})` : ''}: ${f.error}`).join(' | ');
          throw new Error(detail || data.error || `Request failed (${res.status})`);
        }
        const good = (data.reports || []).filter(r => r.reportId);
        if (!good.length) throw new Error((data.failures || [])[0]?.error || 'No reports were accepted.');

        moRunSave({
          window: data.window,
          reports: good.map(r => ({ key: r.key, reportId: r.reportId })),
          failures: data.failures || [],
          requestNotes: data.notes || [],
          startedAt: new Date().toISOString(),
          pollUntil: Date.now() + MO_MAX_WAIT_MS
        });
        moSetStatus(`Amazon is generating ${good.length} report${good.length === 1 ? '' : 's'}. ` +
                    'Three reports, one of them Sponsored Brands, so this is the slowest of the three cadences.');
        moSchedulePoll(MO_POLL_MS);
      } catch (err) {
        console.error('[MO] run failed:', err);
        moSetStatus('', err.message);
        moSetBusy(false);
      } finally {
        moBusy = false;
      }
    }

    function moSchedulePoll(delay) {
      clearTimeout(moPollTimer);
      moPollTimer = setTimeout(moPoll, delay);
    }

    async function moPoll() {
      const state = moRunLoad();
      if (!state) return;
      if (Date.now() > state.pollUntil) {
        moSetStatus('', 'Gave up waiting after 45 minutes. ' +
          moStatusLine(state.lastStatuses, state.startedAt) +
          ' Press Check again to keep waiting — the reports are still queued at Amazon.');
        moSetBusy(false);
        return;
      }
      try {
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}`;
        const res = await fetch(`/api/adspend?action=monthly-status&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Status failed (${res.status})`);

        if (data.allDone) return moCollect(state);
        state.lastStatuses = data.statuses || [];
        state.pollErrors = 0;
        moRunSave(state);
        moSetStatus(moStatusLine(state.lastStatuses, state.startedAt));
        moSchedulePoll(MO_POLL_MS);
      } catch (err) {
        console.error('[MO] poll failed:', err);
        state.pollErrors = (state.pollErrors || 0) + 1;
        moRunSave(state);
        if (state.pollErrors >= 5) {
          moSetStatus('', `Could not reach the status endpoint after 5 tries: ${err.message}. ` +
                          'Press Check again when your connection is back.');
          moSetBusy(false);
          return;
        }
        moSetStatus(`Status check failed (attempt ${state.pollErrors} of 5), retrying…`);
        moSchedulePoll(MO_POLL_MS * state.pollErrors);
      }
    }

    // What Amazon is actually doing, rather than a count of what is finished.
    // PENDING means queued and not yet started; PROCESSING means generating.
    function moStatusLine(statuses, startedAt) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 60000));
      const list = statuses || [];
      if (!list.length) return `Waiting on Amazon — ${mins} min elapsed.`;
      const byState = {};
      for (const s of list) byState[s.status || 'UNKNOWN'] = (byState[s.status || 'UNKNOWN'] || 0) + 1;
      const parts = Object.entries(byState).map(([k, n]) => `${n} ${k.toLowerCase()}`);
      let line = `${parts.join(' · ')} — ${mins} min elapsed.`;
      if (list.every(s => s.status === 'PENDING') && mins >= 10) {
        line += ' Amazon has not started these yet; its report queue is backed up.';
      }
      return line;
    }

    async function moCollect(state) {
      try {
        const w = state.window;
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}` +
                   `&start=${w.start}&end=${w.end}&priorStart=${w.priorStart}&priorEnd=${w.priorEnd}`;
        const res = await fetch(`/api/adspend?action=monthly-collect&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Collect failed (${res.status})`);

        // A report that was never requested, or that fell back to fewer
        // columns, is a hole in the run only the request step knows about.
        data.notes = [...(data.notes || []),
          ...(state.requestNotes || []),
          ...(state.failures || []).map(f => ({ key: f.key, note: 'report not requested: ' + f.error }))];
        moData = data;
        moRunClear();
        moSetStatus('');
        moSetBusy(false);
        moRender(data);
      } catch (err) {
        console.error('[MO] collect failed:', err);
        // Download URLs are short-lived, so a failed collect means starting over.
        moRunClear();
        moSetStatus('', err.message);
        moSetBusy(false);
      }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────

    function moRenderIdle() {
      const container = document.getElementById('admonthly-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">📅</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            The most recent complete calendar month per brand, against the month before it.
            A month settles on the 15th of the next one, once Sponsored Brands has finished
            crediting its last day. Each brand gets a recommended posture &mdash; Scale, Hold
            Steady or Constrain &mdash; which is what the bi-weekly reads to decide how hard to
            push that brand. The two Sponsored Brands campaigns are shown underneath, since
            neither faster cadence covers them.
            <div style="margin-top: 1rem; opacity: 0.8;">
              Runs from the 15th of the month onward. Before then it would have to reach two
              months back, and Amazon only keeps 95 days of Sponsored Products reporting and
              60 of Sponsored Brands, so the comparison month is already gone.
            </div>
          </div>
        </div>`;
    }

    function moRender(data) {
      const container = document.getElementById('admonthly-content');
      if (!container) return;
      const w = data.window || {};
      moSetBlurb(`${moMonthLabel(w.month)} · collected ${
        data.collectedAt ? _svTimeAgo(data.collectedAt) : 'just now'}`);

      container.innerHTML =
        moCounts(data) + moBrandTable(data) + moSbTable(data) + moFooter(data);
      moBindActions();
    }

    function moCounts(data) {
      const c = data.counts || {};
      const w = data.window || {};
      const pill = (n, label, cls) =>
        `<span class="bw-pill ${cls}">${n} ${label}</span>`;
      return `
        <div class="bw-head">
          <div class="bw-pills">
            ${pill(c.scale || 0, 'scale', 'bw-up')}
            ${pill(c.hold || 0, 'hold steady', 'bw-hold')}
            ${pill(c.constrain || 0, 'constrain', 'bw-down')}
            ${c.changed ? pill(c.changed, 'differ from current', 'bw-tag') : ''}
          </div>
          <div class="bw-window">
            ${escapeHtml(moMonthLabel(w.month))}
            <span class="bw-muted">against ${escapeHtml(moMonthLabel(w.priorMonth))}</span>
          </div>
        </div>`;
    }

    // One table, because brand performance, budget share and next-month
    // priorities are one decision. The posture control is the action; every
    // other column is the evidence for it.
    function moBrandTable(data) {
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="card arf-section"><p class="arf-none">' +
               'No brand had an enabled Sponsored Products campaign in this window.</p></div>';
      }
      return `
        <div class="card arf-section">
          <h4>Brand posture</h4>
          <p class="arf-blurb">
            Sponsored Products, one calendar month against the one before. Profit retention
            is the decision metric; ACoS against target is shown because it is what you think
            in. Every column that drives a posture is a ratio, so unequal month lengths
            cancel &mdash; only the spend and sales dollars read as "that month". Ad share
            counts Sponsored Brands too, and comes from orders rather than the ad reports.
          </p>
          ${moLegend(data)}
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead>
                <tr>
                  <th>Brand</th>
                  <th>Spend</th>
                  <th>Ad sales${adTip('mo.adSales')}</th>
                  <th>ACoS${adTip('acos')}</th>
                  <th>vs target${adTip('mo.vsTarget')}</th>
                  <th>Retention${adTip('mo.retention')}</th>
                  <th>vs last month${adTip('mo.vsLastMonth')}</th>
                  <th>Spend / sales share${adTip('mo.share')}</th>
                  <th>Ad share${adTip('mo.adShare')}</th>
                  <th>Recommended${adTip('mo.recommended')}</th>
                  <th>Posture${adTip('mo.posture')}</th>
                </tr>
              </thead>
              <tbody>${rows.map(moBrandRow).join('')}</tbody>
            </table>
          </div>
          ${moPostureBar(data)}
        </div>`;
    }

    // What the recommendation is based on and what each posture actually does,
    // built from the live config so the numbers cannot drift from the rules.
    function moLegend(data) {
      const c = data.config || {};
      const p = (n) => (typeof n === 'number' ? Math.round(n * 100) + '%' : '—');
      const pts = (n) => (typeof n === 'number' ? Math.round(n * 100) : '—');
      return `
        <div class="mo-legend">
          <div>
            <div class="mo-legend-head">How a posture is recommended</div>
            <ul>
              <li><strong>Scale</strong> at ${p(c.SCALE_RETENTION)} profit retention or better.</li>
              <li><strong>Hold Steady</strong> between ${p(c.CONSTRAIN_RETENTION)} and ${p(c.SCALE_RETENTION)}.</li>
              <li><strong>Constrain</strong> under ${p(c.CONSTRAIN_RETENTION)}. Also when retention fell
                ${pts(c.TREND_MATERIAL)} points or more from last month and is now under
                ${p(c.SCALE_RETENTION)}, or when a brand's share of spend runs more than
                ${pts(c.SHARE_GAP)} points above its share of ad sales and it is under ${p(c.SCALE_RETENTION)}.</li>
              <li>Always <strong>Hold Steady</strong> with under $${c.MIN_SPEND ?? '—'} of spend and under
                ${c.MIN_ORDERS ?? '—'} orders, or when retention can't be worked out.</li>
            </ul>
          </div>
          <div>
            <div class="mo-legend-head">What it changes in the bi-weekly</div>
            <ul>
              <li><strong>Scale</strong>: raises on budget-capped campaigns go one step larger.</li>
              <li><strong>Hold Steady</strong>: the normal budget rules, unchanged.</li>
              <li><strong>Constrain</strong>: budget-capped campaigns get no raise, and cuts go one step deeper.</li>
            </ul>
          </div>
        </div>`;
    }

    // The staged changes and the one control that saves them. A single slim line
    // inside the card: it only needs to say what is waiting and offer the two
    // buttons, not float over the page like Campaign Overview's save bar.
    function moPostureBar(data) {
      const rows = data.rows || [];
      const changes = Object.entries(moPending)
        .map(([brand, posture]) => ({ brand, posture, row: rows.find(r => r.brand === brand) }))
        .filter(x => x.row);
      if (!changes.length) return '';

      const detail = changes
        .map(x => `${x.brand} \u2192 ${moPostureLabel(x.posture)}`)
        .join(', ');
      const failed = changes.filter(x => moConfirmErrors[x.brand]).length;

      return `
        <div class="mo-confirm">
          <span class="mo-confirm-detail">${escapeHtml(detail)}${
            failed ? ` <span class="arf-warn">\u00b7 ${failed} not saved</span>` : ''}</span>
          ${moConfirming
            ? '<span class="loading"></span>'
            : `<button class="arf-btn" data-mo-discard>Discard</button>
               <button class="arf-btn arf-btn-go" data-mo-confirm>Confirm posture changes</button>`}
        </div>`;
    }

    function moBrandRow(r) {
      const delta = r.retentionDelta;
      const deltaCell = delta === null || delta === undefined
        ? '<span class="arf-muted">—</span>'
        : `<span class="${delta >= 0 ? 'bw-up' : 'bw-down'}">${
             delta >= 0 ? '+' : ''}${moPct(delta)}</span>`;
      const gap = r.gapVsTarget;
      const gapCell = gap === null || gap === undefined
        ? '<span class="arf-muted">—</span>'
        : `<span class="${gap <= 0 ? 'bw-up' : 'bw-down'}">${gap >= 0 ? '+' : ''}${moPct(gap)}</span>`;
      return `
        <tr${moPending[r.brand] !== undefined ? ' class="mo-row-pending"' : ''}>
          <td class="arf-name">${escapeHtml(r.brand)}
            <div class="arf-sub">${escapeHtml(r.reason || '')}${
              r.adDependent
                ? ' <span class="bw-warn">· ads carry this brand, so a constrain has no organic floor under it</span>'
                : ''}</div>
          </td>
          <td>${moMoney(r.spend)}</td>
          <td>${moMoney(r.sales)}</td>
          <td>${moPct(r.acos)}</td>
          <td>${gapCell}</td>
          <td>${moPct(r.retention)}</td>
          <td>${deltaCell}</td>
          <td>${moPct(r.spendShare)} / ${moPct(r.salesShare)}</td>
          <td>${r.adShare === null ? '<span class="arf-muted">—</span>' : moPct(r.adShare)}</td>
          <td><span class="bw-pill ${moPostureClass(r.recommended)}">${escapeHtml(moPostureLabel(r.recommended))}</span></td>
          <td>${moPostureSelect(r)}</td>
        </tr>`;
    }

    // Changing the dropdown or pressing "Use" only STAGES a posture. Nothing is
    // saved until Confirm. Saves go through the bi-weekly's posture endpoint on
    // purpose: it is the same stored object, read by the same decision tree.
    function moPostureSelect(r) {
      const brand = escapeHtml(r.brand);
      const staged = moPending[r.brand];
      const shown = staged !== undefined ? staged : r.posture;
      const opts = [['scale', 'Scale'], ['hold', 'Hold Steady'], ['constrain', 'Constrain']]
        .map(([v, label]) => `<option value="${v}"${shown === v ? ' selected' : ''}>${label}</option>`)
        .join('');
      const err = moConfirmErrors[r.brand];
      return `<select class="${staged !== undefined ? 'aco-dirty' : ''}" data-mo-posture="${brand}"${
          moConfirming ? ' disabled' : ''}>${opts}</select>${
        shown !== r.recommended && !moConfirming
          ? `<button class="arf-btn" data-mo-adopt="${brand}" title="Stage ${brand} as ${
              escapeHtml(moPostureLabel(r.recommended))}">Use ${
              escapeHtml(moPostureLabel(r.recommended))}</button>`
          : ''}${
        staged !== undefined ? `<div class="arf-sub">was ${escapeHtml(moPostureLabel(r.posture))}</div>` : ''}${
        err ? `<div class="arf-warn">${escapeHtml(err)}</div>` : ''}`;
    }

    const MO_POSTURE_LABELS = { scale: 'Scale', hold: 'Hold Steady', constrain: 'Constrain' };
    function moPostureLabel(p) { return MO_POSTURE_LABELS[p] || p || '—'; }
    function moPostureClass(p) {
      return p === 'scale' ? 'bw-up' : (p === 'constrain' ? 'bw-down' : 'bw-hold');
    }

    // Two rows. No purpose labels and no diagnostic framework: the doc reads
    // those from a catalog field that does not exist, and two campaigns do not
    // justify building one. New-to-brand is the case for running SB at all, so
    // it is the column that matters here.
    // The only place Sponsored Brands budgets are managed: neither faster cadence
    // covers them. Each campaign gets Raise, Hold or Lower with a plain reason,
    // and a recommended budget can be written to Amazon from here.
    function moSbTable(data) {
      const rows = data.sbRows || [];
      if (!rows.length) {
        return `
          <div class="card arf-section">
            <h4>Sponsored Brands</h4>
            <p class="arf-none">No enabled Sponsored Brands campaign reported in this month.</p>
          </div>`;
      }
      const noNtb = rows.every(r => r.ntbOrders === null);
      const c = data.config || {};
      const p = (n) => (typeof n === 'number' ? Math.round(n * 100) + '%' : '—');
      return `
        <div class="card arf-section">
          <h4>Sponsored Brands</h4>
          <p class="arf-blurb">
            Neither faster cadence covers these two, so this is where their budgets are set.
            Each uses the same retention lines as the brands above: under ${p(c.CONSTRAIN_RETENTION)}
            lowers the budget, and ${p(c.SCALE_RETENTION)} or better raises it, but only when the
            budget ran out on most days. A budget that isn't being spent gains nothing from a raise.
          </p>
          <p class="arf-blurb">
            <strong>Days at cap</strong> counts the days spend reached 95% of the daily budget.
            <strong>New to brand</strong> is the share of orders from shoppers who hadn't bought from
            the brand in the past year: high means the campaign is finding new customers, low means it
            mostly reaches people who would have found you anyway.${
              noNtb ? ' <span class="bw-warn">Amazon did not return new-to-brand for this month.</span>' : ''}
          </p>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Budget/day${adTip('mo.sbBudget')}</th>
                  <th>Spend</th>
                  <th>Sales${adTip('mo.sbSales')}</th>
                  <th>ACoS${adTip('acos')}</th>
                  <th>Retention${adTip('retention')}</th>
                  <th>Days at cap${adTip('mo.sbDaysAtCap')}</th>
                  <th>New to brand${adTip('mo.ntb')}</th>
                  <th>Recommended${adTip('mo.sbRecommended')}</th>
                </tr>
              </thead>
              <tbody>${rows.map(moSbRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
    }

    function moSbRow(r) {
      const cap = (r.cappedDays === null || r.cappedDays === undefined)
        ? '<span class="arf-muted">—</span>'
        : `${r.cappedDays} of ${r.daysInMonth}`;
      return `
        <tr>
          <td class="arf-name">${escapeHtml(r.campaign)}
            <div class="arf-sub">${escapeHtml(r.brand || 'No brand')} \u00b7 ${escapeHtml(r.reason || '')}</div>
          </td>
          <td>${moMoney(r.dailyBudget)}</td>
          <td>${moMoney(r.spend)}</td>
          <td>${moMoney(r.sales)}</td>
          <td>${moPct(r.acos)}</td>
          <td>${moPct(r.retention)}</td>
          <td>${cap}</td>
          <td>${r.ntbOrderShare === null || r.ntbOrderShare === undefined
                ? '<span class="arf-muted">—</span>'
                : moPct(r.ntbOrderShare)}</td>
          <td class="mo-sb-action">${moSbActionCell(r)}</td>
        </tr>`;
    }

    // The label, then the write. The recommended number sits on the button
    // itself, so there is nothing to agree to that wasn't read.
    function moSbActionCell(r) {
      const st = moSbApply[r.campaignId] || {};
      const id = escapeHtml(String(r.campaignId));

      // Before the no-recommendation check: once applied, the re-read shows the
      // campaign as held, and that would hide the confirmation.
      if (st.stage === 'done') {
        return `<span class="arf-applied">&#10003; now $${escapeHtml(String(st.applied))}/day</span>`;
      }

      const label = r.action === 'raise' ? 'Raise' : r.action === 'lower' ? 'Lower' : 'Hold';
      const cls = r.action === 'raise' ? 'bw-up' : r.action === 'lower' ? 'bw-down' : 'bw-hold';
      const pill = `<span class="bw-pill ${cls}">${label}</span>`;
      if (!r.recommendedBudget) return pill;

      const to = moMoney(r.recommendedBudget);
      if (st.stage === 'busy') return `${pill} <span class="loading"></span>`;
      if (st.stage === 'confirm') {
        return `${pill} <span class="arf-confirm">
          <span>${moMoney(r.dailyBudget)} \u2192 ${to}/day?</span>
          <button class="arf-btn arf-btn-go" data-mo-sb-confirm="${id}">Confirm</button>
          <button class="arf-btn" data-mo-sb-cancel="${id}">Cancel</button>
        </span>`;
      }
      return `${pill} <button class="arf-btn" data-mo-sb-apply="${id}"
                title="${label} the daily budget on Amazon to ${to}">${to}/day</button>${
        st.stage === 'error' ? `<div class="arf-warn">${escapeHtml(st.message || 'Could not apply.')}</div>` : ''}`;
    }

    function moSbSetStage(campaignId, stage, extra) {
      if (!stage) delete moSbApply[campaignId];
      else moSbApply[campaignId] = { stage, ...(extra || {}) };
      if (moData) moRender(moData);
    }

    // The Campaign Overview write path: it re-reads the campaign from Amazon,
    // refuses if the budget has moved since this page loaded, writes, and reads
    // it back. Sponsored Brands is a new path through it, so success here means
    // Amazon reported the new budget back, not merely that the request returned.
    async function moSbApplyBudget(campaignId) {
      const row = (moData?.sbRows || []).find(r => String(r.campaignId) === String(campaignId));
      if (!row || !row.recommendedBudget || !accessToken) return;

      moSbSetStage(campaignId, 'busy');
      try {
        const res = await fetch('/api/adcampaigns?action=update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            campaignId: row.campaignId, adProduct: 'SB', local: {},
            amazon: { dailyBudget: row.recommendedBudget },
            // What this page showed. The budget can move between loading the
            // month and pressing the button.
            expected: { dailyBudget: row.dailyBudget },
            // For the change history: which review the edit came from.
            origin: 'monthly'
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          if (data.conflicts && data.conflicts.length) {
            const c0 = data.conflicts[0];
            throw new Error(`Amazon now has a $${c0.amazonHasNow ?? '—'} budget (this page showed ` +
                            `$${c0.youSaw ?? '—'}). Reload and try again.`);
          }
          throw new Error(data.error || `Failed (${res.status})`);
        }
        const applied = data.applied && data.applied.dailyBudget;
        if (!applied) {
          throw new Error('Amazon accepted the request, but reading the campaign back shows the budget ' +
                          'unchanged. Nothing was applied.');
        }
        moSbApply[campaignId] = { stage: 'done', applied: applied.to };
        // Re-read: the write is recorded in the change log, which the server
        // uses to stop recommending the same change again from this month.
        await moFetch(`${row.campaign}: daily budget is now $${applied.to}.`);
      } catch (err) {
        console.error('[MO] SB budget write failed:', err);
        moSbSetStage(campaignId, 'error', { message: err.message });
      }
    }

    function moFooter(data) {
      const cov = data.coverage || {};
      const orders = data.orders || {};
      const bits = [];
      if (cov.evaluated) bits.push(`${cov.evaluated} campaigns evaluated`);
      if (cov.orphanRows) bits.push(`${cov.orphanRows} report rows had no enabled campaign behind them`);
      if ((cov.unmapped || []).length) {
        bits.push(`${cov.unmapped.length} campaigns spent without a brand mapping`);
      }
      if (!orders.available) {
        bits.push('Ad share is unavailable: no order data covers this window');
      } else if (orders.unmappedSkus) {
        bits.push(`${orders.unmappedSkus} SKUs have no brand in the catalog, ` +
                  `so ${moMoney(orders.unmappedSales)} of sales is missing from ad share`);
      }
      return `
        <div class="card card-flat arf-footer">
          ${bits.length ? `<div>${escapeHtml(bits.join(' · '))}</div>` : ''}
          ${(data.notes || []).map(n =>
            `<div class="arf-warn">${escapeHtml(n.key)}: ${escapeHtml(n.note)}</div>`).join('')}
          ${(data.deviations || []).map(d =>
            `<div class="arf-muted">Deviation from the cadence doc: ${escapeHtml(d)}</div>`).join('')}
          ${data.censusSyncedAt
            ? `<div class="arf-muted">Campaign configuration synced ${escapeHtml(_svTimeAgo(data.censusSyncedAt))}</div>`
            : ''}
        </div>`;
    }

    // ─── ACTIONS ─────────────────────────────────────────────────────────────

    function moBindActions() {
      // The container persists across renders — only innerHTML is replaced —
      // so binding per render would stack duplicate handlers.
      if (moBound) return;
      const el = document.getElementById('admonthly-content');
      if (!el) return;
      el.addEventListener('click', e => {
        const adopt = e.target.closest('[data-mo-adopt]');
        if (adopt) {
          const brand = adopt.dataset.moAdopt;
          const row = (moData?.rows || []).find(r => r.brand === brand);
          if (row) moStage(brand, row.recommended);
          return;
        }
        if (e.target.closest('[data-mo-confirm]')) return moConfirmPostures();
        const sbApply = e.target.closest('[data-mo-sb-apply]');
        if (sbApply) return moSbSetStage(sbApply.dataset.moSbApply, 'confirm');
        const sbConfirm = e.target.closest('[data-mo-sb-confirm]');
        if (sbConfirm) return moSbApplyBudget(sbConfirm.dataset.moSbConfirm);
        const sbCancel = e.target.closest('[data-mo-sb-cancel]');
        if (sbCancel) return moSbSetStage(sbCancel.dataset.moSbCancel, null);
        if (e.target.closest('[data-mo-discard]')) {
          moPending = {};
          moConfirmErrors = {};
          if (moData) moRender(moData);
        }
      });
      el.addEventListener('change', e => {
        const sel = e.target.closest('[data-mo-posture]');
        if (sel) moStage(sel.dataset.moPosture, sel.value);
      });
      moBound = true;
    }

    // Choosing the posture a brand already has un-stages it, so the bar only
    // ever lists real changes.
    function moStage(brand, posture) {
      if (moConfirming) return;
      const row = (moData?.rows || []).find(r => r.brand === brand);
      if (!row || !posture) return;
      if (posture === row.posture) delete moPending[brand];
      else moPending[brand] = posture;
      delete moConfirmErrors[brand];
      if (moData) moRender(moData);
    }

    // Saves every staged change, one brand at a time. A brand that fails stays
    // staged with its error beside it, and the ones that saved are not undone.
    // The endpoint takes one brand per call, and there are only four brands.
    async function moConfirmPostures() {
      if (moConfirming || !accessToken) return;
      const changes = Object.entries(moPending);
      if (!changes.length) return;

      moConfirming = true;
      moConfirmErrors = {};
      if (moData) moRender(moData);

      const saved = [];
      for (const [brand, posture] of changes) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetch('/api/adspend?action=biweekly-posture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ brand, posture })
          });
          // eslint-disable-next-line no-await-in-loop
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
          delete moPending[brand];
          saved.push(`${brand} to ${moPostureLabel(posture)}`);
        } catch (err) {
          console.error('[MO] posture save failed:', err);
          moConfirmErrors[brand] = `Not saved: ${err.message}`;
        }
      }
      moConfirming = false;

      const failed = Object.keys(moConfirmErrors).length;
      const summary = saved.length
        ? `Saved ${saved.join(', ')}. The bi-weekly reads this on its next load.`
        : '';
      // Re-read rather than patching locally: the server decides from the
      // stored postures, so this shows exactly what was saved.
      await moFetch(failed
        ? `${summary}${summary ? ' ' : ''}${failed} change${failed === 1 ? '' : 's'} could not be saved and ${
            failed === 1 ? 'is' : 'are'} still staged.`
        : summary);
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    function moMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      const v = Math.round(n * 100) / 100;
      return (v < 0 ? '-$' : '$') + formatNumber(Math.abs(v));
    }

    const MO_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                            'July', 'August', 'September', 'October', 'November', 'December'];

    function moMonthLabel(ym) {
      if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return String(ym || '');
      const [y, m] = ym.split('-').map(Number);
      return `${MO_MONTH_NAMES[m - 1] || ym} ${y}`;
    }

    function moPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n * 100) + '%';
    }

    function moSetStatus(message, error) {
      const el = document.getElementById('mo-status');
      if (!el) return;
      if (!message && !error) { el.style.display = 'none'; el.innerHTML = ''; return; }
      el.style.display = 'block';
      el.innerHTML = error
        ? `<span style="color: var(--error);">${escapeHtml(error)}</span>`
        : escapeHtml(message);
    }

    function moSetBlurb(text) {
      const el = document.getElementById('admonthly-blurb');
      if (el) el.textContent = text;
    }

    function moSetBusy(busy) {
      const btn = document.getElementById('mo-run-btn');
      if (!btn) return;
      btn.disabled = busy;
      btn.innerHTML = busy ? 'Running<span class="loading"></span>'
                           : (moRunLoad() ? 'Check again' : 'Run monthly');
    }

    function moRunSave(state) {
      try { localStorage.setItem(MO_RUN_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
    }

    function moRunLoad() {
      try {
        const raw = localStorage.getItem(MO_RUN_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function moRunClear() {
      try { localStorage.removeItem(MO_RUN_KEY); } catch (e) { /* ignore */ }
    }
