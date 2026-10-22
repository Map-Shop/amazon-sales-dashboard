    // ─── AD RED FLAGS ────────────────────────────────────────────────────────
    // Weekly Red Flag Monitor. Six fixed threshold checks over the most
    // recent complete Mon–Sun week, computed server-side by the red-flag
    // section of /api/adspend (it lives there because Vercel's Hobby plan
    // caps a deployment at 12 serverless functions).
    //
    // Amazon's report generation is asynchronous and takes minutes, so this
    // module drives the request → poll → collect cycle from the browser and
    // keeps the in-flight report IDs in localStorage so a manual run survives a
    // reload.
    //
    // THE RESULT IS NEVER CACHED. The server stores what the reports said and
    // re-runs the checks on every read, so a budget or bid applied since the
    // reports were pulled is reflected at once. A cron fetches before the
    // working day, so the usual path is reading what is already there.
    //
    // loadAdRedFlags() NEVER starts a run — it reads and waits for
    // the user. showPage() and triggerCurrentPageLoad() both fire on restore
    // and after sign-in, and auto-running there would burn Amazon report quota
    // and earn a 425 duplicate rejection on the next real run.

    const ARF_RUN_KEY = 'arfRunState';
    const ARF_POLL_MS = 20000;
    const ARF_POLL_SLOW_MS = 30000;
    const ARF_MAX_WAIT_MS = 45 * 60 * 1000;

    let arfPollTimer = null;
    let arfBusy = false;
    // In memory for the life of the page, never written to storage.
    let arfData = null;

    function loadAdRedFlags() {
      const container = document.getElementById('adredflags-content');
      if (!container) return;

      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view ad red flags.</div>';
        return;
      }

      arfFetch();

      // Resume a run that was in flight when the tab closed.
      const state = arfRunLoad();
      if (state && !arfPollTimer) {
        arfSetStatus('Resuming report run started ' + _svTimeAgo(state.startedAt) + '…');
        arfSchedulePoll(0);
      }
    }

    // Decisions are made server-side on every read, so this is the only way the
    // page gets a result. There is nothing to invalidate.
    async function arfFetch(after) {
      try {
        const res = await fetch('/api/adspend?action=weekly-get', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        if (data.empty) {
          arfData = null;
          return arfRenderIdle();
        }
        arfData = data;
        arfRender(data);
        if (after) arfSetStatus(after);
      } catch (err) {
        console.error('[ARF] load failed:', err);
        arfSetStatus('', err.message);
      }
    }

    // The run button is a dispatcher. While a run is in flight it resumes
    // polling instead of requesting again — Amazon rejects an identical report
    // while the prior one is still generating (425), so re-requesting kills the
    // reports you are waiting on and silently restarts the clock on whatever
    // slipped through.
    function arfButtonClick() {
      if (arfRunLoad()) arfResume();
      else arfRun();
    }

    function arfResume() {
      const state = arfRunLoad();
      if (!state) return arfRun();
      state.pollUntil = Date.now() + ARF_MAX_WAIT_MS;
      arfRunSave(state);
      arfSetBusy(true);
      arfSetStatus('Checking report status…');
      arfSchedulePoll(0);
    }

    // Abandons the in-flight report IDs and requests a fresh set. Only correct
    // once Amazon has finished (or failed) the previous ones — otherwise the
    // new requests are duplicates.
    function arfStartOver() {
      arfRunClear();
      arfSetStatus('');
      arfSetBusy(false);
      arfRun();
    }

    async function arfRun() {
      if (arfBusy) return;
      if (!accessToken) return;
      if (arfRunLoad()) return arfResume();
      arfBusy = true;
      arfSetBusy(true);

      try {
        // Step 0 — freshen the campaign configuration snapshot. The checks read
        // daily budget, brand and portfolio from it, and it decides WHICH
        // campaigns get evaluated at all, so a stale census silently shrinks
        // the run. It is a config call, not a report: a second or two.
        arfSetStatus('Refreshing campaign configuration…');
        const sync = await fetch('/api/adcampaigns?action=refresh', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const syncData = await sync.json().catch(() => ({}));
        if (!sync.ok) {
          throw new Error('Could not refresh campaign configuration: ' +
                          (syncData.error || `HTTP ${sync.status}`));
        }

        arfSetStatus('Requesting reports from Amazon…');
        const res = await fetch('/api/adspend?action=weekly-request', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) {
          // The reason Amazon gave is in `failures`; throwing only `error`
          // reduces a specific answer to a generic sentence.
          const detail = (data.failures || [])
            .map(f => `${f.key}${f.window ? ` (${f.window})` : ''}: ${f.error}`).join(' | ');
          throw new Error(detail || data.error || `Request failed (${res.status})`);
        }

        const good = (data.reports || []).filter(r => r.reportId);
        if (!good.length) {
          const first = (data.failures || [])[0];
          if (first && (first.invalidColumns || []).length) {
            throw new Error(`Amazon refused the column ${first.invalidColumns.join(', ')}. ${first.error}`);
          }
          throw new Error((first && first.error) || 'No reports were accepted.');
        }

        const state = {
          window: data.window,
          reports: good.map(r => ({ key: r.key, reportId: r.reportId })),
          // Reported so a partial run is never mistaken for a complete one.
          failures: data.failures || [],
          startedAt: new Date().toISOString(),
          pollUntil: Date.now() + ARF_MAX_WAIT_MS
        };
        arfRunSave(state);
        arfSetStatus(`Amazon is generating ${good.length} report${good.length === 1 ? '' : 's'}. This usually takes 2–5 minutes.`);
        arfSchedulePoll(ARF_POLL_MS);
      } catch (err) {
        console.error('[ARF] run failed:', err);
        arfSetStatus('', err.message);
        arfSetBusy(false);
      } finally {
        arfBusy = false;
      }
    }

    function arfSchedulePoll(delay) {
      clearTimeout(arfPollTimer);
      arfPollTimer = setTimeout(arfPoll, delay);
    }

    async function arfPoll() {
      const state = arfRunLoad();
      if (!state) { arfSetBusy(false); return; }
      if (!accessToken) return;

      const elapsed = Date.now() - new Date(state.startedAt).getTime();
      if (Date.now() > (state.pollUntil || 0)) {
        arfSetStatus('',
          `Still waiting after ${Math.round(elapsed / 60000)} minutes. Amazon is generating these ` +
          `— press Check again to keep waiting. Do not start over until they finish or fail, ` +
          `or the new requests come back as duplicates.`,
          state.lastStatuses);
        arfSetBusy(false, 'Check again');
        return;
      }

      try {
        const res = await fetch(`/api/adspend?action=weekly-status&reports=${encodeURIComponent(arfReportsParam(state))}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Status check failed (${res.status})`);

        const ready = (data.statuses || []).filter(s => s.done).length;
        const total = (data.statuses || []).length;

        if (data.allDone) {
          arfSetStatus('Reports ready — computing checks…');
          await arfCollect(state);
          return;
        }

        state.lastStatuses = data.statuses || [];
        arfRunSave(state);
        arfSetStatus(`${ready} of ${total} reports ready — ${Math.round(elapsed / 60000)} min elapsed…`,
                     null, state.lastStatuses);
        arfSchedulePoll(elapsed > 4 * 60 * 1000 ? ARF_POLL_SLOW_MS : ARF_POLL_MS);
      } catch (err) {
        console.error('[ARF] poll failed:', err);
        // Transient failures shouldn't kill a run that Amazon is still
        // working on — keep polling and let the elapsed cap end it.
        arfSetStatus(`Status check failed (${err.message}) — retrying…`);
        arfSchedulePoll(ARF_POLL_SLOW_MS);
      }
    }

    async function arfCollect(state) {
      try {
        const w = state.window;
        const qs = `reports=${encodeURIComponent(arfReportsParam(state))}` +
                   `&weekStart=${w.weekStart}&weekEnd=${w.weekEnd}` +
                   `&baseStart=${w.baseStart}&baseEnd=${w.baseEnd}`;
        const res = await fetch(`/api/adspend?action=weekly-collect&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Collect failed (${res.status})`);

        // A report that never got requested is a hole in the run, and only the
        // request step knows about it.
        data.notes = [...(data.notes || []),
          ...(state.failures || []).map(f => ({ key: f.key, note: 'report not requested: ' + f.error }))];
        arfRunClear();
        arfSetStatus('');
        arfSetBusy(false);
        arfData = data;
        arfRender(data);
      } catch (err) {
        console.error('[ARF] collect failed:', err);
        // The download URLs are short-lived, so a failed collect usually means
        // the run has to start over rather than be retried.
        arfRunClear();
        arfSetStatus('', err.message);
        arfSetBusy(false);
      }
    }

    function arfReportsParam(state) {
      return state.reports.map(r => `${r.key}:${r.reportId}`).join(',');
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────
    // The cadence doc specifies the output precisely: "A single short note
    // identifying any triggered red flags. No spreadsheets, no tables of
    // healthy campaigns... organized as four sections — one per red flag check
    // — with 'No flags' written for any check that did not trigger. A clean
    // week produces a note one paragraph long."
    //
    // So this renders prose, not a dashboard. Each flagged item gets exactly
    // the fields the doc's "Report format" line names for its check, and
    // nothing else.

    function arfRenderIdle() {
      const container = document.getElementById('adredflags-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">🚩</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            Six checks over every enabled Sponsored Products campaign, for the most
            recent complete Monday&ndash;Sunday week: budget cap emergencies, silent
            campaigns, spend collapse, CTR collapse, CPC spike, and brand pacing.
            Everything but the budget cap&rsquo;s retention gate reads only impressions,
            clicks and spend, which are final the day they happen &mdash; conversions stay
            incomplete for a week after the click. Sponsored Brands is reviewed monthly.
            Amazon generates the report on request, which takes a few minutes.
          </div>
        </div>`;
    }

    function arfRender(data) {
      const container = document.getElementById('adredflags-content');
      if (!container) return;

      const w = data.window || {};
      arfSetBlurb(`Week of ${w.weekStart} to ${w.weekEnd} · generated ${
        data.generatedAt ? _svTimeAgo(data.generatedAt) : 'just now'}`);

      // "If no check triggers anywhere, write a single sentence."
      const body = data.clean
        ? `<p class="arf-clean">No flags this week &mdash; all brands and campaigns within normal range.</p>`
        : arfSections(data);

      container.innerHTML = `
        <div class="card arf-note">
          <div class="arf-note-head">
            <h3>Red Flag Monitor</h3>
            <div class="arf-note-window">
              Week of ${escapeHtml(w.weekStart)} &ndash; ${escapeHtml(w.weekEnd)}
              · baseline ${escapeHtml(w.baseStart)} &ndash; ${escapeHtml(w.baseEnd)}
            </div>
          </div>
          ${body}
          ${arfFooter(data)}
        </div>`;

      arfBindActions();
    }

    // Each check is a table. Anything identical on every row — what to do
    // about the flag, where to look first — belongs in the section header, not
    // repeated down a column.
    //
    // Five of the six checks read only impressions, clicks and spend, which
    // are final the day they happen. The exception is check 1's retention
    // gate, which reads the settled 28-day baseline and is labelled "28d"
    // wherever it appears so it is never mistaken for a weekly number.
    function arfSections(data) {
      const f = data.flags || {};
      return [
        arfSection('1 · Budget cap emergencies', f.budgetCap,
          'Profitable campaigns whose daily budget is routinely the binding constraint. ' +
          'A day counts as at cap when spend reaches 95% of the daily budget — including ' +
          'days over it, since Amazon averages across the month and an overshoot means ' +
          'demand exceeded the budget. Retention is the settled 28-day figure. The ' +
          'suggested raise is a step: 25% at four days at cap rising to 50% at seven, ' +
          'never below the best single day it already managed. Applying it writes to Amazon.',
          [C('Campaign'), C('Brand'), R('Budget/day'), R('7-day spend', 'rf.spend7'),
           R('At cap', 'rf.atCap'), R('ACoS 28d', 'rf.acos28'), R('Retention 28d', 'rf.retention28'),
           R('Raise to', 'rf.raiseTo')],
          arfBudgetCapRow),

        // Checks 2 to 4 are per portfolio, and a portfolio is one product. Their
        // causes are the product and its competition, which reach every campaign
        // at once. One campaign moving on its own is its bids or targets, which
        // Badger manages, and is deliberately not listed.
        arfSection('2 · Silent portfolios', f.silent,
          'Every campaign for the product served nothing this week, after it averaged at ' +
          'least 100 impressions a week over the four before. When a whole product goes ' +
          'dark the cause is the product: check stock, listing suppression and Buy Box. ' +
          'One campaign going quiet while the others serve is a bid or a target, and is ' +
          'not listed.',
          [C('Portfolio'), C('Brand'), R('Campaigns', 'rf.campaigns'),
           R('Typical spend/wk', 'rf.typicalSpend'), R('Impressions 28d', 'rf.impressions28')],
          arfSilentRow),

        arfSection('3 · Spend collapse', f.spendCollapse,
          'The product spent at or below half its normal rate, across its campaigns ' +
          'rather than in just one. Spend is impressions × click-through × cost per click, ' +
          'so each row names which fell. A fall in cost per click is bids rather than the ' +
          'product, and is not listed.',
          [C('Portfolio'), C('Brand'), R('7-day spend', 'rf.spend7'),
           R('Typical spend/wk', 'rf.typicalSpend'), R('Change', 'rf.change')],
          arfSpendCollapseRow),

        arfSection('4 · CTR collapse', f.ctrCollapse,
          'Across the product’s campaigns, impressions are turning into clicks at half the ' +
          'usual rate or worse. That points at the listing or what sits beside it: price, ' +
          'main image, reviews, or a cheaper competitor. A drop confined to one campaign ' +
          'is targeting drift, and is not listed.',
          [C('Portfolio'), C('Brand'), R('Impressions', 'rf.impressions7'), R('Clicks'),
           R('CTR', 'ctr'), R('Typical CTR', 'rf.typicalCtr'), R('Change', 'rf.change')],
          arfCtrRow),

        arfSection('5 · CPC spike', f.cpcSpike,
          'Paying at least half again as much per click as usual: competitive pressure, or ' +
          'bid automation reaching. The suggested cut is a step — 10% at the flagging ' +
          'threshold rising to 25% at twice it — because what a lower bid actually costs ' +
          'per click is an auction outcome, not arithmetic. Applying it writes to Amazon.',
          [C('Campaign'), C('Brand'), R('Clicks'), R('7-day spend', 'rf.spend7'),
           R('CPC', 'cpc'), R('Typical CPC', 'rf.typicalCpc'), R('Change', 'rf.change'),
           R('Bid', 'rf.bid'), R('Lower to', 'rf.lowerTo')],
          arfCpcRow),

        arfSection('6 · Brand pacing', f.brandPacing,
          'Brand spend against its trailing weekly average — the account-level sanity ' +
          'check. Each row names the campaigns that account for the move, so a brand-level ' +
          'deviation resolves to specific campaigns rather than a prompt to go looking.',
          [C('Brand'), R('7-day spend', 'rf.spend7'), R('Trailing avg', 'rf.trailingAvg'),
           R('Change', 'rf.change')],
          arfPacingRow)
      ].join('');
    }

    // Column definitions. Numbers right-align so they can be compared down the
    // column, which is the only reason to use a table here at all. `tip` is a
    // glossary key, for a column whose meaning is not obvious from its name.
    function C(label, tip) { return { label, align: 'left', tip }; }
    function R(label, tip) { return { label, align: 'right', tip }; }

    // "with 'No flags' written for any check that did not trigger"
    function arfSection(title, rows, guidance, cols, rowFn) {
      const list = rows || [];
      if (!list.length) {
        return `<section class="arf-section">
          <h4>${title}</h4>
          <p class="arf-none">No flags this week.</p>
        </section>`;
      }
      return `<section class="arf-section">
        <h4>${title}</h4>
        <p class="arf-blurb">${guidance}</p>
        <div class="arf-table-wrap">
          <table class="table-fill arf-table">
            <thead><tr>${cols.map(c =>
              `<th${c.align === 'right' ? ' class="arf-r"' : ''}>${c.label}${
                c.tip ? adTip(c.tip) : ''}</th>`).join('')}</tr></thead>
            <tbody>${list.map(rowFn).join('')}</tbody>
          </table>
        </div>
      </section>`;
    }

    // The first three cells are the same on every check, so they are written
    // once rather than five times. `explain` is the optional second argument:
    // the row's own diagnosis, sitting under the name as prose rather than
    // taking a column it could never fill consistently.
    function arfWho(r, explain) {
      const note = explain || '';
      return `<td class="arf-name">${escapeHtml(r.campaign)}
          ${note ? `<div class="arf-sub">${note}</div>` : ''}
        </td>
        <td>${escapeHtml(r.brand || '—')}</td>`;
    }

    // spend = impressions x CTR x CPC. Naming which factor fell is the whole
    // action item: it says whether the fix is in the ad account or on the
    // listing, which is the difference between a click and an afternoon.
    // Worded for a whole product, since that is the only case these checks now
    // list. There is no cost-per-click entry: a spend fall driven by cheaper
    // clicks is bids, which the server does not flag.
    const ARF_CAUSE = {
      impressions: { label: 'Impressions', fix: 'serving less often — check stock and Buy Box, then whether a competitor is outbidding you on the product’s searches' },
      ctr:         { label: 'Click-through', fix: 'shown and passed over — check price, main image and reviews, or a cheaper competitor beside you' }
    };

    function arfCauseNote(cause) {
      if (!cause || !ARF_CAUSE[cause.driver]) return '';
      const c = ARF_CAUSE[cause.driver];
      const drop = Math.round((1 - cause.ratio) * 100);
      return `${escapeHtml(c.label)} down ${drop}% — ${escapeHtml(c.fix)}`;
    }

    // The campaigns that account for a brand-level move. A deviation with no
    // attribution is a prompt to go looking, which is what this page exists to
    // avoid.
    function arfDriversNote(drivers) {
      if (!drivers || !drivers.length) return '';
      return drivers.map(d =>
        `${escapeHtml(d.campaign)} ${d.delta > 0 ? '+' : ''}${arfMoney(d.delta)}`).join(' · ');
    }

    // 'Aug 19' — the year is always this one and the line is already long.
    function arfShortDate(ptDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ptDate || ''))) return escapeHtml(String(ptDate || ''));
      const d = new Date(ptDate + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    // "5 of 7" rather than a percentage: the column counts days, and a
    // percentage here would read as time-in-budget, which this is not.
    function arfBudgetCapRow(r) {
      return `<tr>${arfWho(r)}
        <td class="arf-r">${arfMoney(r.dailyBudget)}</td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r arf-em">${r.cappedDays} of ${r.weekDays}</td>
        <td class="arf-r">${arfPct(r.acos28)}</td>
        <td class="arf-r arf-em">${arfPct(r.retention28)}</td>
        <td class="arf-r arf-action">${arfRecommendCell(r)}</td>
      </tr>`;
    }

    // The row label for the portfolio-level checks. Same two columns as a
    // campaign row, so the tables line up down the page. Carries the
    // investigation note, since a note is about the product, not the metric.
    function arfWhere(r, explain) {
      const note = explain || '';
      return `<td class="arf-name">${escapeHtml(r.portfolio || 'Unnamed portfolio')}
          ${note ? `<div class="arf-sub">${note}</div>` : ''}
          ${arfLogBlock(r)}
        </td>
        <td>${escapeHtml(r.brand || '—')}</td>`;
    }

    // What you found when you looked into it. This week's note is shown as
    // written. With none yet, the most recent earlier note on the same product
    // is shown as context, clearly dated, and never as if it were this week's:
    // an ongoing stock-out needs no retyping, and a new cause is not hidden
    // behind an old explanation.
    function arfLogBlock(r) {
      if (r.portfolioId === undefined || r.portfolioId === null) return '';
      const id = escapeHtml(String(r.portfolioId));
      const st = arfLogEdit[String(r.portfolioId)];

      if (st && (st.stage === 'edit' || st.stage === 'busy' || st.stage === 'error')) {
        const busy = st.stage === 'busy';
        return `<div class="arf-log arf-log-editing">
          <textarea class="arf-log-input" data-arf-log-input="${id}" maxlength="1000" rows="2"
                    placeholder="What did you find? e.g. FBA stock-out; FBM stock up but Prime badge gone"
                    ${busy ? 'disabled' : ''}>${escapeHtml(st.draft || '')}</textarea>
          <div class="arf-log-actions">
            <button class="arf-btn arf-btn-go" data-arf-log-save="${id}" ${busy ? 'disabled' : ''}>${
              busy ? 'Saving…' : 'Save note'}</button>
            <button class="arf-btn" data-arf-log-cancel="${id}" ${busy ? 'disabled' : ''}>Cancel</button>
            ${r.note ? `<button class="arf-btn" data-arf-log-clear="${id}" ${busy ? 'disabled' : ''}
                         title="Remove this week's note">Remove</button>` : ''}
          </div>
          ${st.stage === 'error' ? `<div class="arf-warn">${escapeHtml(st.message || 'Could not save.')}</div>` : ''}
        </div>`;
      }

      if (r.note) {
        return `<div class="arf-log">
          <span class="arf-log-text">${escapeHtml(r.note.text)}</span>
          <button class="arf-log-link" data-arf-log-edit="${id}">Edit</button>
        </div>`;
      }

      const prior = r.priorNote
        ? `<div class="arf-log-prior">Noted week of ${arfShortDate(r.priorNote.weekStart)}: ${
            escapeHtml(r.priorNote.text)}</div>`
        : '';
      return `<div class="arf-log">
          ${prior}
          <button class="arf-log-link" data-arf-log-edit="${id}">${
            r.priorNote ? 'Add a note for this week' : 'Add note'}</button>
        </div>`;
    }

    // Every portfolio row on screen, across the three portfolio checks. A
    // product can appear in more than one, and they share one note.
    function arfPortfolioRow(portfolioId) {
      const f = (arfData && arfData.flags) || {};
      return [...(f.silent || []), ...(f.spendCollapse || []), ...(f.ctrCollapse || [])]
        .find(r => String(r.portfolioId) === String(portfolioId)) || null;
    }

    function arfLogOpen(portfolioId) {
      const row = arfPortfolioRow(portfolioId);
      arfLogEdit[String(portfolioId)] = {
        stage: 'edit',
        // Editing starts from this week's note, or from the earlier one when
        // there is none yet, so an ongoing issue can be confirmed in one click.
        draft: (row && row.note && row.note.text) || (row && row.priorNote && row.priorNote.text) || ''
      };
      if (arfData) arfRender(arfData);
      const el = document.querySelector(`[data-arf-log-input="${CSS.escape(String(portfolioId))}"]`);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }

    function arfLogClose(portfolioId) {
      delete arfLogEdit[String(portfolioId)];
      if (arfData) arfRender(arfData);
    }

    async function arfLogSave(portfolioId, clear) {
      const key = String(portfolioId);
      const st = arfLogEdit[key];
      const row = arfPortfolioRow(portfolioId);
      const weekStart = arfData && arfData.window && arfData.window.weekStart;
      if (!st || !row || !weekStart || !accessToken) return;

      // Read the textarea directly: the draft in state only updates on input,
      // and a paste-then-save must not lose what was pasted.
      const el = document.querySelector(`[data-arf-log-input="${CSS.escape(key)}"]`);
      const text = clear ? '' : (el ? el.value : st.draft || '').trim();

      arfLogEdit[key] = { ...st, draft: el ? el.value : st.draft, stage: 'busy' };
      if (arfData) arfRender(arfData);
      try {
        const res = await fetch('/api/adspend?action=weekly-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ portfolioId: key, weekStart, note: text, portfolio: row.portfolio || null })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || `Save failed (${res.status})`);
        delete arfLogEdit[key];
        // Re-read rather than patching what is on screen: notes are joined onto
        // the flags on the server, which is the only place that decides them.
        await arfFetch();
      } catch (err) {
        console.error('[ARF] note save failed:', err);
        arfLogEdit[key] = { ...arfLogEdit[key], stage: 'error', message: err.message };
        if (arfData) arfRender(arfData);
      }
    }

    function arfSilentRow(r) {
      // Every campaign past its end date is the complete answer, not a lead.
      const explain = r.endedBefore
        ? `<span class="arf-quiet">Every campaign ended by ${arfShortDate(r.endedBefore)}</span>`
        : undefined;
      return `<tr>${arfWhere(r, explain)}
        <td class="arf-r">${formatCount(r.campaigns)}</td>
        <td class="arf-r arf-em">${arfMoney(r.baselineWeekly)}</td>
        <td class="arf-r">${formatCount(r.baselineImpressions)}</td>
      </tr>`;
    }

    function arfSpendCollapseRow(r) {
      return `<tr>${arfWhere(r, arfCauseNote(r.cause))}
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r">${arfMoney(r.baselineWeekly)}</td>
        <td class="arf-r arf-em arf-down">${arfPct(r.change)}</td>
      </tr>`;
    }

    function arfCtrRow(r) {
      return `<tr>${arfWhere(r)}
        <td class="arf-r">${formatCount(r.impressions7)}</td>
        <td class="arf-r">${formatCount(r.clicks7)}</td>
        <td class="arf-r arf-em">${arfRate(r.ctr7)}</td>
        <td class="arf-r">${arfRate(r.ctr28)}</td>
        <td class="arf-r arf-em arf-down">${arfPct(r.change)}</td>
      </tr>`;
    }

    function arfCpcRow(r) {
      return `<tr>${arfWho(r)}
        <td class="arf-r">${formatCount(r.clicks7)}</td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r arf-em">${arfMoney(r.cpc7)}</td>
        <td class="arf-r">${arfMoney(r.cpc28)}</td>
        <td class="arf-r arf-em arf-up">+${arfPct(r.change)}</td>
        <td class="arf-r">${arfMoney(r.defaultBid)}</td>
        <td class="arf-r arf-action">${arfRecommendCell(r, 'bid')}</td>
      </tr>`;
    }

    function arfPacingRow(r) {
      const up = r.deviation > 0;
      const drivers = arfDriversNote(r.drivers);
      return `<tr>
        <td class="arf-name">${escapeHtml(r.brand)}
          ${drivers ? `<div class="arf-sub">${drivers}</div>` : ''}
        </td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r">${arfMoney(r.baselineWeekly)}</td>
        <td class="arf-r arf-em ${up ? 'arf-up' : 'arf-down'}">${up ? '+' : ''}${arfPct(r.deviation)}</td>
      </tr>`;
    }


    // The run's own receipt — one line, so a run that covered half the account
    // cannot look identical to a clean week. Not a report of healthy campaigns.
    function arfFooter(data) {
      const c = data.coverage || {};
      const bits = [
        `all ${c.enabled} enabled campaigns evaluated`,
        typeof c.withSpend === 'number' ? `${c.withSpend} spent anything this week` : null,
        // Not flagged anywhere: a campaign that has never run is a config
        // cleanup job, not a weekly emergency. Counted so it is not invisible.
        c.neverActive ? `${c.neverActive} have never run` : null,
        c.unmapped && c.unmapped.length ? `${c.unmapped.length} unmapped to a brand` : null,
        c.noBudget && c.noBudget.length ? `${c.noBudget.length} with no usable daily budget` : null,
        c.orphanRows ? `${c.orphanRows} report rows for campaigns not in the snapshot` : null,
        typeof c.portfolios === 'number' ? `${c.portfolios} portfolios checked for silence and collapse` : null
      ].filter(Boolean);

      const warn = [];
      // An unmapped campaign has no margin, so it has no profit retention and
      // silently cannot pass check 1's gate. Saying so is the difference
      // between "nothing wrong" and "not looked at".
      if (c.unmapped && c.unmapped.length) {
        warn.push(`No brand, so no margin and no retention — cannot be checked for budget cap: ${
          c.unmapped.map(x => `${escapeHtml(x.campaign)} (${arfMoney(x.spend7)})`).join(', ')}`);
      }
      if (c.noBudget && c.noBudget.length) {
        // The server distinguishes a missing budget from a lifetime one; they
        // are different facts and lumping them loses the reason.
        warn.push(`Not evaluated for budget cap: ${c.noBudget
          .map(x => `${escapeHtml(x.campaign)} (${escapeHtml(x.reason || 'no daily budget')})`)
          .join(', ')}`);
      }
      if (c.orphanRows) {
        warn.push('Some report rows belong to campaigns missing from the snapshot — refresh Campaign Overview.');
      }
      // Every campaign belongs to a portfolio, so this should never show. If it
      // does, those campaigns were invisible to checks 2 to 4.
      if (c.noPortfolio) {
        warn.push(`${c.noPortfolio} campaign${c.noPortfolio === 1 ? ' has' : 's have'} no portfolio, ` +
                  'so silence, spend collapse and CTR collapse could not be checked for them.');
      }

      return `
        <div class="arf-footer">
          <div>${escapeHtml(bits.join(' · '))}</div>
          ${warn.map(w => `<div class="arf-warn">${w}</div>`).join('')}
          ${(data.notes || []).map(n =>
            `<div class="arf-warn">${escapeHtml(n.key)}: ${escapeHtml(n.note)}</div>`).join('')}
          ${(data.deviations || []).map(d =>
            `<div class="arf-muted">Deviation from the cadence doc: ${escapeHtml(d)}</div>`).join('')}
          ${data.censusSyncedAt
            ? `<div class="arf-muted">Campaign configuration synced ${escapeHtml(_svTimeAgo(data.censusSyncedAt))}</div>`
            : ''}
        </div>`;
    }

    // ─── APPLY A RECOMMENDATION ──────────────────────────────────────────────
    // The cadence is observational and stays that way — nothing here changes
    // unless you press the button. It is a deliberate exception, not a drift
    // into acting: one campaign, one field, one confirmation.
    //
    // State lives here rather than in the DOM because arfRender replaces the
    // container wholesale; a confirm prompt or a result would otherwise vanish
    // on the next render.
    let arfApply = {};      // { [campaignId]: { stage, message, applied } }
    let arfBound = false;
    // Investigation notes being edited or saved, keyed by portfolio id. A note
    // belongs to a portfolio and a week; the week is always the run on screen.
    let arfLogEdit = {};    // { [portfolioId]: { stage: 'edit'|'busy'|'error', draft, message } }

    // The recommended budget and its button share a cell: the number is the
    // thing you are agreeing to, so putting it anywhere else invites agreeing
    // to something you did not read.
    // One control, two levers. `kind` is 'budget' (raise, on check 1) or 'bid'
    // (lower, on check 5). They write to different Amazon endpoints, so the
    // apply state is keyed by both to keep two flags on the same campaign from
    // sharing a spinner.
    function arfRecommendCell(r, kind = 'budget') {
      const target = kind === 'bid' ? r.recommendedBid : r.recommendedBudget;
      const key = `${r.campaignId}:${kind}`;
      const st = arfApply[key] || {};
      const id = escapeHtml(key);
      const unit = kind === 'bid' ? '' : '/day';

      // Before the no-recommendation guard: applying CLEARS the recommendation,
      // so checking that first would report a successful raise as a dash.
      if (st.stage === 'done') {
        return `<span class="arf-applied">&#10003; now ${arfMoney(st.applied)}${unit}</span>`;
      }
      if (!target) return '<span class="arf-muted">—</span>';
      if (st.stage === 'busy') {
        return `<span class="loading"></span>`;
      }
      if (st.stage === 'confirm') {
        return `<span class="arf-confirm">
          <span>${arfMoney(target)}${unit}?</span>
          <button class="arf-btn arf-btn-go" data-arf-confirm="${id}">Confirm</button>
          <button class="arf-btn" data-arf-cancel="${id}">Cancel</button>
        </span>`;
      }
      const verb = kind === 'bid' ? 'Lower the default bid on Amazon to'
                                  : 'Raise the daily budget on Amazon to';
      // Money through the formatter, never raw: a cents recommendation
      // interpolates as "$13.5", and a bid as "$1.2".
      return `<button class="arf-btn" data-arf-apply="${id}"
                title="${verb} ${arfMoney(target)}"
              >${arfMoney(target)}${unit}</button>${
        st.stage === 'error' ? `<div class="arf-warn">${escapeHtml(st.message)}</div>` : ''}`;
    }

    function arfBindActions() {
      // The container element persists across renders — only its innerHTML is
      // replaced — so binding on every render would stack duplicate handlers.
      if (arfBound) return;
      const c = document.getElementById('adredflags-content');
      if (!c) return;
      c.addEventListener('click', e => {
        const btn = e.target.closest(
          '[data-arf-apply], [data-arf-confirm], [data-arf-cancel], ' +
          '[data-arf-log-edit], [data-arf-log-save], [data-arf-log-cancel], [data-arf-log-clear]');
        if (!btn) return;
        const d = btn.dataset;
        if (d.arfApply)             arfSetApplyStage(d.arfApply, 'confirm');
        else if (d.arfCancel)       arfSetApplyStage(d.arfCancel, null);
        else if (d.arfConfirm)      arfApplyBudget(d.arfConfirm);
        else if (d.arfLogEdit)      arfLogOpen(d.arfLogEdit);
        else if (d.arfLogSave)      arfLogSave(d.arfLogSave, false);
        else if (d.arfLogCancel)    arfLogClose(d.arfLogCancel);
        else if (d.arfLogClear)     arfLogSave(d.arfLogClear, true);
      });
      // Keep the draft as it is typed. The table re-renders whenever anything
      // else on the page changes, and a note half-written must survive that.
      c.addEventListener('input', e => {
        const el = e.target.closest('[data-arf-log-input]');
        if (!el) return;
        const st = arfLogEdit[el.dataset.arfLogInput];
        if (st) st.draft = el.value;
      });
      arfBound = true;
    }

    function arfSetApplyStage(campaignId, stage, extra) {
      if (!stage) delete arfApply[campaignId];
      else arfApply[campaignId] = { stage, ...(extra || {}) };
      if (arfData) arfRender(arfData);
    }

    async function arfApplyBudget(key) {
      const [campaignId, kind] = String(key).split(':');
      const bucket = kind === 'bid' ? 'cpcSpike' : 'budgetCap';
      const row = ((arfData && arfData.flags && arfData.flags[bucket]) || [])
        .find(r => String(r.campaignId) === String(campaignId));
      if (!row || !accessToken) return;

      arfSetApplyStage(key, 'busy');
      try {
        // The Campaign Overview write path, unchanged: it re-reads the campaign
        // from Amazon, refuses if the budget has moved since this page loaded,
        // and verifies the change by reading it back.
        const res = await fetch('/api/adcampaigns?action=update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          // What this page displayed goes in `expected`. Reports take minutes
          // to generate, so the value really can move between run and button.
          // `origin` tells the change history which review the edit came from.
          body: JSON.stringify(kind === 'bid'
            ? { campaignId: row.campaignId, adProduct: row.adProduct, local: {},
                adGroupId: row.adGroupId,
                adGroup: { defaultBid: row.recommendedBid },
                expected: { defaultBid: row.defaultBid }, origin: 'weekly' }
            : { campaignId: row.campaignId, adProduct: row.adProduct, local: {},
                amazon: { dailyBudget: row.recommendedBudget },
                expected: { dailyBudget: row.dailyBudget }, origin: 'weekly' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          if (data.conflicts && data.conflicts.length) {
            const c0 = data.conflicts[0];
            throw new Error(`Amazon now has ${c0.field} = ${c0.amazonHasNow ?? '—'} ` +
                            `(this page saw ${c0.youSaw ?? '—'}). Re-run the check.`);
          }
          throw new Error(data.error || `Failed (${res.status})`);
        }

        // Re-read rather than patching what is on screen: the update handler
        // writes the new value back into the census, and the server decides
        // from the census, so the row comes back correct without this page
        // having to fake it.
        arfApply[key] = { stage: 'done',
                          applied: kind === 'bid' ? row.recommendedBid : row.recommendedBudget };
        await arfFetch();
      } catch (err) {
        console.error('[ARF] apply failed:', err);
        arfSetApplyStage(key, 'error', { message: err.message });
      }
    }

    // Counts, not money: impressions and clicks are whole numbers and reading
    // "12,400" beside "$12.40" should never be ambiguous.
    function formatCount(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n).toLocaleString('en-US');
    }

    // CTR sits around 0.4%, so two decimals or it reads as a flat 0%.
    function arfRate(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return (n * 100).toFixed(2) + '%';
    }

    function arfMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return '$' + formatNumber(Math.round(n * 100) / 100);
    }

    // Ratios arrive as fractions; retention and deviation can both be negative.
    function arfPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n * 100) + '%';
    }

    function arfSetStatus(message, error, details) {
      const el = document.getElementById('arf-status');
      if (!el) return;
      const parts = [];
      if (error) parts.push(`<div style="color: var(--error);">${escapeHtml(error)}</div>`);
      else if (message) parts.push(`<div>${escapeHtml(message)}</div>`);

      if (details && details.length) {
        parts.push('<div style="margin-top: 0.4rem; font-family: monospace; font-size: 0.75rem;">' +
          details.map(d => `${escapeHtml(d.key)}: ${escapeHtml(d.status || '—')}`).join('  ·  ') +
          '</div>');
      }
      // Only offered while a run is stored — starting over mid-generation is
      // what produces the duplicate rejections.
      if (arfRunLoad()) {
        parts.push('<div style="margin-top: 0.4rem;">' +
          '<a onclick="arfStartOver()" style="cursor: pointer; text-decoration: underline;">' +
          'Abandon these and request fresh reports</a></div>');
      }
      el.innerHTML = parts.join('');
      el.style.display = parts.length ? 'block' : 'none';
    }

    function arfSetBlurb(text) {
      const el = document.getElementById('adredflags-blurb');
      if (el) el.textContent = text;
    }

    function arfSetBusy(busy, label) {
      const btn = document.getElementById('arf-run-btn');
      if (!btn) return;
      btn.disabled = !!busy;
      btn.textContent = busy ? 'Running…' : (label || 'Run weekly check');
    }

    // ─── IN-FLIGHT RUN STATE ─────────────────────────────────────────────────
    // Report IDs only. A manual run takes minutes and has to survive a reload;
    // the result it produces is stored server-side, not here.

    function arfRunSave(state) {
      try { localStorage.setItem(ARF_RUN_KEY, JSON.stringify(state)); } catch { /* quota */ }
    }

    function arfRunLoad() {
      try {
        const raw = localStorage.getItem(ARF_RUN_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }

    function arfRunClear() {
      clearTimeout(arfPollTimer);
      arfPollTimer = null;
      try { localStorage.removeItem(ARF_RUN_KEY); } catch { /* ignore */ }
    }
