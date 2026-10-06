(function () {
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const n = value => Number(value || 0).toLocaleString();
  const pct = value => value == null ? '—' : Number(value).toFixed(2) + '%';
  const params = new URLSearchParams(location.search);
  let view = ['ended','historical'].includes(params.get('source')) ? params.get('source') : Number(params.get('run')) < 0 ? 'historical' : 'active';
  let detailOpen = params.get('detail') === '1' || params.has('page') || Number(params.get('run')) < 0;
  let data, requestId = 0;
  const date = ms => ms ? new Date(ms).toLocaleString('en-US', { timeZone: data.timezone, dateStyle: 'medium', timeStyle: 'short' }) : 'Running';
  const shortDate = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: data.timezone, month:'short',day:'numeric',year:'numeric' });
  function presetDates(value, today) {
    if (value === 'all') return ['', ''];
    const days = value === 'today' ? 0 : value === '7d' ? 6 : 29;
    return [new Date(Date.parse(today + 'T12:00:00Z') - days * 86400000).toISOString().slice(0, 10), today];
  }
  function selected() { return data?.runs.find(r => r.id === data.selectedId); }
  function historical() { return selected()?.source === 'historical'; }
  function runLabel(run) { return run.source === 'historical' ? 'Historical period ' + Math.abs(run.id) : 'Run #' + run.id; }
  function status(run) { return run.source === 'historical' ? 'Historical' : run.ended_at ? 'Ended' : 'Active'; }
  function splitLabel(run) { return run.config.split == null ? 'Not recorded' : (100 - Number(run.config.split)) + '% / ' + Number(run.config.split) + '%'; }
  function attributionLabel(value) { return value === 'tagged' ? 'URL + variant tag' : value === 'inferred_source' ? 'Matched source page' : value === 'inferred_origin' ? 'Inferred test origin' : 'Unassigned'; }
  function dateLabel() {
    if (!data.from && !data.to) return 'All time';
    return `${data.from || 'Beginning'} — ${data.to || 'Today'}`;
  }
  const chance = value => value >= .9995 ? '>99.9%' : value <= .0005 ? '<0.1%' : (value * 100).toFixed(1) + '%';
  function verdict(run, detailed = false) {
    const model = run.inference;
    if (run.source === 'historical' || !model) return `<section class="ab-verdict is-unavailable"><span class="ab-model-label">Lead conversion verdict</span><h4>${run.source === 'historical' ? 'Historical estimates only' : 'Model unavailable'}</h4><p>${run.source === 'historical' ? 'Estimated visitor counts cannot establish a reliable winner.' : 'Refresh to load the statistical model.'}</p></section>`;
    const titles = {waiting:'Waiting for data',collecting:'Collecting data',inconclusive:'No clear winner',winner:'Variant ' + model.winner + ' is winning',unavailable:'Cannot compare yet'};
    const checks = model.checks || [];
    const remaining = checks.filter(c => !c.met).map(c => c.key === 'days' ? Math.ceil(c.target-c.current) + ' more day' + (Math.ceil(c.target-c.current) === 1 ? '' : 's') : n(c.target-c.current) + ' more ' + (c.key === 'visitorsA' ? 'A visitors' : c.key === 'visitorsB' ? 'B visitors' : 'converted visitors'));
    const leader = model.leadingVariant;
    const probability = model.probability;
    const explanation = model.status === 'winner' ? `${chance(probability[model.winner])} probability of a higher conversion rate. All minimum requirements met.` : model.status === 'unavailable' ? model.reason : model.status === 'waiting' ? model.reason : leader ? `Variant ${leader} has a ${chance(probability[leader])} chance of being better.` : 'Both variants have a 50% chance of being better.';
    const progress = leader ? probability[leader] * 100 : probability ? 50 : 0;
    return `<section class="ab-verdict is-${esc(model.status)}" aria-label="Statistical verdict for ${esc(run.name)}">
      <div class="ab-verdict-top"><span class="ab-model-label">Lead conversion verdict</span><span class="ab-model-scope">Full run · Bayesian</span></div>
      <h4>${esc(titles[model.status] || 'Model unavailable')}</h4><p>${esc(explanation)}</p>
      ${probability ? `<div class="ab-evidence-track" role="meter" aria-label="${leader || 'Each variant'} probability of being better; winner threshold 95 percent" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.toFixed(2)}"><span style="width:${progress}%;--evidence-color:var(--${leader === 'A' ? 'a' : 'b'})"></span><i title="95% winner threshold"></i></div><div class="ab-evidence-labels"><span>A ${chance(probability.A)} <span aria-hidden="true">·</span> B ${chance(probability.B)}</span><span>95% to win</span></div>` : ''}
      ${remaining.length && model.status !== 'unavailable' ? `<p class="ab-next-step">${run.ended_at ? 'Ended before minimums were met: ' : 'Minimums remaining: '}${esc(remaining.join(' · '))}.</p>` : model.status === 'inconclusive' ? `<p class="ab-next-step">${run.ended_at ? 'This run ended without enough evidence for a winner.' : 'Keep running to gather stronger evidence. The minimum sample alone does not guarantee a winner.'}</p>` : ''}
      ${detailed ? `<div class="ab-model-counts"><span>A: <strong>${n(model.stats?.A?.converted)} / ${n(model.stats?.A?.visitors)}</strong> converted</span><span>B: <strong>${n(model.stats?.B?.converted)} / ${n(model.stats?.B?.visitors)}</strong> converted</span></div>
      <div class="ab-model-checks">${checks.map(c => `<div class="${c.met ? 'met' : ''}"><span aria-label="${c.met ? 'Met' : 'Pending'}">${c.met ? '✓' : '○'}</span><div>${esc(c.label)}<strong>${c.key === 'days' ? c.current.toFixed(1) : n(c.current)} / ${n(c.target)}</strong></div></div>`).join('')}</div>
      <p class="ab-model-footnote">Uses the entire run, regardless of the date filter above. One conversion per visitor. A verdict updates as results arrive and does not change traffic allocation.</p>
      <details class="ab-model-method"><summary>How the winner is decided</summary><p>Each variant uses a Beta(1, 1) prior, updated with converted and non-converted visitors. A winner needs a ${model.policy.probability * 100}% probability of a higher conversion rate, at least ${model.policy.visitorsPerVariant} visitors per variant, ${model.policy.conversions} converted visitors overall, and ${model.policy.days} elapsed days. These minimums are safeguards, not a sample-size guarantee.</p><p>This is a model-based probability, not a 95% frequentist confidence claim or a guarantee. It assumes comparable randomly allocated traffic and stable conversion rates. It tests any improvement, not a preset business-value threshold. ${run.ended_at ? 'Later conversions from visitors in this ended run can still update its result.' : 'Delayed conversions can change the verdict.'} <a href="https://www.evanmiller.org/bayesian-ab-testing.html" target="_blank" rel="noopener">Model reference ↗</a></p></details>` : ''}
    </section>`;
  }
  const outcomeValue = value => value == null ? '—' : n(value);
  function outcomeCoverage(o) {
    if (!o) return 'Not available for historical estimates';
    return `${n(o.matched)} of ${n(o.leads)} submissions matched${o.unmatched ? ' · ' + n(o.unmatched) + ' awaiting a match' : ''}${o.repeated ? ' · ' + n(o.repeated) + ' repeats counted once' : ''}`;
  }
  function businessResults(run) {
    if (!run.outcomes) return '';
    return `<section class="ab-business" aria-label="Business outcomes for ${esc(run.name)}"><div class="ab-business-heading"><strong>Sales outcomes</strong><span>Trakkit</span></div><table><thead><tr><th>Variant</th><th>Opportunities</th><th>Closed Won</th></tr></thead><tbody>${['A','B'].map(v => { const o=run.outcomes[v]; return `<tr><td><span class="ab-letter ${v==='B'?'ab-letter-b':''}">${v}</span></td><td>${outcomeValue(o.opportunities)}</td><td class="ab-won">${outcomeValue(o.closedWon)}</td></tr>`; }).join('')}</tbody></table><p>${['A','B'].map(v=>v+': '+outcomeCoverage(run.outcomes[v])).join('<br>')}</p></section>`;
  }
  function drawOutcomeSync() {
    const node=el('outcomeSync'), sync=data.outcomeSync;
    node.hidden=view==='historical';
    if (node.hidden) return;
    node.classList.toggle('is-stale',!sync?.available || sync.stale);
    node.textContent=!sync?.connected ? 'Trakkit connection is not configured. Sales outcomes are unavailable.' : !sync.available ? 'Trakkit outcomes are waiting for their first successful update.' :
      `Trakkit connected · Checked ${date(sync.lastSuccess)}. ${sync.sourceUpdatedAt ? `Salesforce feed: ${date(sync.sourceUpdatedAt)}. ` : ''}${sync.stale ? 'Source updates are delayed; counts may be incomplete. ' : ''}Sales counts reflect matched leads from the selected visitor dates, including later outcomes.`;
  }
  function drawTests() {
    const search = el('testSearch').value.trim().toLowerCase();
    const runs = data.runs.filter(r => (r.name + ' ' + r.slug + ' ' + r.b_name).toLowerCase().includes(search));
    const isHistory = view === 'historical';
    const totals = runs.reduce((a,r) => { for (const v of ['A','B']) { a.visitors += r.stats[v].visitors; a.leads += r.stats[v].leads; a.converted += r.stats[v].converted; } return a; }, {visitors:0,leads:0,converted:0});
    el('periodCountLabel').textContent = isHistory ? 'Historical periods' : view === 'ended' ? 'Ended tests' : 'Active tests';
    el('activeTotal').textContent = n(runs.length);
    el('countCaption').textContent = search ? 'Matching your search' : isHistory ? 'Recovered test history' : view === 'ended' ? 'Completed test runs' : 'Currently running';
    el('summaryScope').textContent = search ? 'Across matching tests' : 'Across ' + (isHistory ? 'historical periods' : view + ' tests');
    el('visitorTotal').textContent = n(totals.visitors);
    el('leadTotal').textContent = n(totals.leads);
    el('rateTotal').textContent = pct(totals.visitors ? (isHistory ? totals.leads : totals.converted) / totals.visitors * 100 : null);
    for (const [id,key] of [['oppTotal','opportunities'],['wonTotal','closedWon']]) { const values=runs.flatMap(r=>r.outcomes?[r.outcomes.A[key],r.outcomes.B[key]]:[]); el(id).textContent=values.length&&values.every(v=>v!=null)?n(values.reduce((a,b)=>a+b,0)):'—'; }
    el('salesTotals').hidden=isHistory; el('wonTotals').hidden=isHistory;
    el('totalRateLabel').textContent = isHistory ? 'Estimated lead rate' : 'Conversion rate';
    el('rateCaption').textContent = isHistory ? 'Based on recovered records' : 'Visitors who became leads';
    el('listTitle').textContent = isHistory ? 'Historical results' : view === 'ended' ? 'Ended experiments' : 'Active experiments';
    el('testCount').textContent = `${runs.length} ${isHistory ? (runs.length === 1 ? 'saved period' : 'saved periods') : (view === 'ended' ? 'completed' : 'running') + (runs.length === 1 ? ' test' : ' tests')} · ${dateLabel()}`;
    el('historyNotice').hidden = !isHistory;
    el('testCards').innerHTML = runs.map(r => {
      const allocation = r.config.split == null ? null : Math.max(0,Math.min(100,Number(r.config.split)));
      return `<article class="ab-test-card">
        <div class="ab-card-head"><div><h3><button class="ab-card-title" data-run="${r.id}">${esc(r.name)}</button></h3><span class="ab-card-url" title="/lp/${esc(r.slug)}/">/lp/${esc(r.slug)}/</span></div><span class="ab-status ${status(r) === 'Active' ? 'active' : ''}">${status(r)}</span></div>
        <div class="ab-card-results"><table class="ab-mini-table" aria-label="${esc(r.name)} variant results"><thead><tr><th>Variant</th><th>Visitors</th><th title="${isHistory ? 'Attributed lead submissions' : 'Visitors with at least one lead; repeat submissions count once'}">${isHistory ? 'Leads' : 'Converted'}</th><th>${isHistory ? 'Est. rate' : 'Conversion'}</th></tr></thead><tbody>${['A','B'].map(v => { const s=r.stats[v]; return `<tr><td><div class="ab-variant-name"><span class="ab-letter ${v === 'B' ? 'ab-letter-b' : ''}">${v}</span><span title="${esc(v === 'A' ? r.name : r.b_name)}">${esc(v === 'A' ? 'Control' : r.b_name)}</span></div></td><td>${n(s.visitors)}</td><td>${n(isHistory ? s.leads : s.converted)}</td><td class="ab-card-rate">${pct(s.visitors ? s.rate : null)}</td></tr>`; }).join('')}</tbody></table></div>
        ${businessResults(r)}
        ${verdict(r)}
        <div class="ab-card-footer"><div><div class="ab-traffic">${allocation == null ? 'Traffic split not recorded' : `<span class="ab-split-bar" aria-hidden="true"><i style="width:${100-allocation}%"></i><i style="width:${allocation}%"></i></span>A ${100-allocation}% <span aria-hidden="true">·</span> B ${allocation}%`}</div><small title="${esc(date(r.started_at))}${r.ended_at ? ' — '+esc(date(r.ended_at)) : ''}">${r.ended_at ? shortDate(r.started_at)+' – '+shortDate(r.ended_at) : 'Started '+shortDate(r.started_at)}</small></div><button class="ab-view-button" data-run="${r.id}" aria-label="View results for ${esc(r.name)}">View results <span aria-hidden="true">→</span></button></div>
      </article>`;
    }).join('') || `<div class="ab-empty"><strong>${search ? 'No matching tests' : view === 'active' ? 'No active tests yet' : view === 'ended' ? 'No ended tests yet' : 'No historical results'}</strong><p>${search ? 'Try another test name or page URL.' : view === 'active' ? 'Enable an A/B test from your landing page settings to start comparing.' : view === 'ended' ? 'Completed runs will appear here when a test ends or its configuration changes.' : 'Recovered test periods will appear here when available.'}</p>${!search && view === 'active' ? '<a href="/admin/pages.html">Go to landing pages →</a>' : ''}</div>`;
  }
  function drawChart() {
    const metric = el('chartMetric').value;
    if (!data.daily.length) { el('dailyChart').innerHTML = '<div class="ab-empty">No records in this date range.</div>'; return; }
    const days = data.daily;
    const max = Math.max(1, ...days.flatMap(d => [d.A[metric], d.B[metric]]).filter(Number.isFinite));
    const w = 880, h = 180, left = 44, right = 15, top = 12, bottom = 30;
    const x = i => left + (days.length === 1 ? (w - left - right) / 2 : i / (days.length - 1) * (w - left - right));
    const y = v => h - bottom - v / max * (h - top - bottom);
    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily ${esc(metric)} by variant. Exact values are in the table below.">`;
    for (let i = 0; i < 3; i++) {
      const value = max * i / 2;
      svg += `<line x1="${left}" x2="${w-right}" y1="${y(value)}" y2="${y(value)}" stroke="#e8edf4"/><text x="${left - 8}" y="${y(value)+4}" text-anchor="end" fill="#718198" font-size="11">${metric === 'rate' ? value.toFixed(1)+'%' : Number(value.toFixed(1))}</text>`;
    }
    for (const [v, color] of [['A','#3052ff'],['B','#7952ba']]) {
      let connected = false;
      const line = days.map((d,i) => { if (d[v][metric] == null) { connected=false; return ''; } const point=(connected ? 'L' : 'M') + x(i) + ',' + y(d[v][metric]); connected=true; return point; }).join(' ');
      svg += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
      if (days.length < 60) svg += days.map((d,i) => d[v][metric] == null ? '' : `<circle cx="${x(i)}" cy="${y(d[v][metric])}" r="3.5" fill="${color}"><title>${d.date} · ${v}: ${metric === 'rate' ? pct(d[v][metric]) : n(d[v][metric])}</title></circle>`).join('');
    }
    const labels = [...new Set([0, Math.floor((days.length - 1)/2), days.length - 1])];
    svg += labels.map(i => `<text x="${x(i)}" y="${h-7}" text-anchor="${i === 0 ? 'start' : i === days.length-1 ? 'end' : 'middle'}" fill="#718198" font-size="11">${days[i].date}</text>`).join('') + '</svg>';
    el('dailyChart').innerHTML = svg;
  }
  function render() {
    const run = selected();
    const showingDetail = detailOpen && !!run;
    el('overview').hidden = showingDetail;
    el('viewTabs').hidden = showingDetail;
    el('runDetail').hidden = !showingDetail;
    el('backToTests').hidden = !showingDetail;
    el('backToTests').textContent = '← Back to ' + (view === 'historical' ? 'historical results' : view + ' tests');
    el('activeBadge').textContent = n(data.activeCount);
    el('endedBadge').textContent = n(data.endedCount);
    el('historyBadge').textContent = n(data.historicalCount);
    el('viewTabs').querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.view === view)));
    el('timezone').textContent = 'Timezone: ' + data.timezone.replace(/_/g,' ');
    el('coverage').textContent = view === 'historical' ? `Historical coverage through ${data.trackingSince ? shortDate(data.trackingSince) : 'the live tracking cutoff'}` : 'Converted visitors count once per run. Statistical verdicts always use the full run.';
    el('exportResults').disabled = !showingDetail;
    drawTests(); drawOutcomeSync();
    if (!showingDetail) return;
    el('dailyRateA').textContent = historical() ? 'A est. rate' : 'A conversion';
    el('dailyRateB').textContent = historical() ? 'B est. rate' : 'B conversion';
    el('chartMetric').querySelector('[value=rate]').textContent = historical() ? 'Estimated lead rate' : 'Conversion rate';
    el('dailyDescription').textContent = historical() ? 'Visitors by last saved visit; leads by submission date. Daily rates are estimates.' : 'Grouped by the visitor’s first measured date in this run.';
    el('recentDescription').textContent = historical() ? 'Latest 50 historical leads submitted within the selected dates.' : 'Latest 50 leads from visitors in the selected date range.';
    el('leadContextHeader').textContent = historical() ? 'Attribution' : 'First test visit';
    el('methodology').textContent = historical() ? 'Historical method: periods begin/end at recorded test saves. Each visitor appears once, on their last saved visit before live tracking began; earlier visits were not retained as separate events. For tests with a separate B source page, untagged visitors on the test URL are estimated as A. Lead submission URLs distinguish test traffic from direct source-page traffic. Lead dates are actual submission dates. Estimated lead rate = attributed leads ÷ recorded visitors; it is not a visitor-cohort conversion rate. Historical splits not preserved in records are shown as “Not recorded”. Records with unresolved attribution remain unassigned. The imported snapshot remains stable as live tracking continues.' : 'Live method: one visitor per browser per run, first seen within the selected dates. Leads include later submissions from those visitors. Conversion rate = visitors with at least one lead ÷ visitors. Direct B-source traffic is excluded. Clearing cookies or switching browsers counts as a new visitor. Sales outcomes use Trakkit click events or its Salesforce feed matched by contact identity and submission time. Each matched opportunity is assigned to its earliest attributed submission within a run, across both variants. Repeated submissions do not increase sales counts. Closed Won is included in Opportunities. Unmatched submissions are not treated as confirmed zero outcomes. The statistical verdict remains based on lead conversion.';
    el('runName').textContent = run.name;
    el('runMeta').textContent = `${runLabel(run)} · ${historical() ? 'From' : status(run) + ' · Started'} ${date(run.started_at)}${run.ended_at ? (historical() ? ' · Through ' : ' · Ended ') + date(run.ended_at) : ''}`;
    el('runSelect').hidden = data.runs.filter(r => r.page_id === run.page_id).length < 2;
    el('runSelect').innerHTML = data.runs.filter(r => r.page_id === run.page_id).map(r => `<option value="${r.id}" ${r.id === run.id ? 'selected' : ''}>${runLabel(r)} · ${esc(date(r.started_at))} · ${status(r)}</option>`).join('');
    el('pageLink').href = '/lp/' + encodeURIComponent(run.slug) + '/';
    el('configureLink').href = '/admin/pages.html?ab=' + run.page_id;
    el('variantCards').innerHTML = ['A','B'].map(v => { const s = run.stats[v]; return `<section class="ab-variant variant-${v.toLowerCase()}">
      <h3><span class="ab-letter ${v === 'B' ? 'ab-letter-b' : ''}">${v}</span>${v === 'A' ? 'Control' : 'Variant B'}</h3><div class="ab-muted">${esc(v === 'A' ? run.name + (historical() ? '' : ' · ' + run.template) : run.b_name)} · ${run.config.split == null ? 'Split not recorded' : (v === 'A' ? 100 - Number(run.config.split) : Number(run.config.split)) + '% allocated'}</div>
      <strong class="ab-rate">${pct(s.visitors ? s.rate : null)}</strong><span class="ab-muted">${historical() ? 'estimated lead rate' : 'visitor conversion rate'}</span>
      <div class="ab-variant-stats"><div><strong>${n(s.visitors)}</strong><span>Visitors</span></div><div><strong>${n(s.leads)}</strong><span>Leads</span></div><div><strong>${n(historical() ? s.taggedLeads : s.converted)}</strong><span>${historical() ? 'Tagged leads' : 'Converted visitors'}</span></div></div>${run.outcomes ? `<div class="ab-variant-sales"><div><strong>${outcomeValue(run.outcomes[v].opportunities)}</strong><span>Opportunities</span></div><div><strong>${outcomeValue(run.outcomes[v].closedWon)}</strong><span>Closed Won</span></div></div><p class="ab-match-note">${outcomeCoverage(run.outcomes[v])}</p>` : ''}</section>`; }).join('');
    const a = run.stats.A, b = run.stats.B;
    el('statisticalVerdict').innerHTML = verdict(run, true);
    el('attributionDetails').hidden = !historical();
    if (historical()) {
      const u = run.stats.U;
      el('attributionNote').textContent = `Attribution in this range — A: ${n(a.taggedVisitors)} tagged + ${n(a.inferredVisitors)} inferred visitors; ${n(a.taggedLeads)} tagged + ${n(a.inferredLeads)} source-matched/inferred leads. B: ${n(b.taggedVisitors)} tagged + ${n(b.inferredVisitors)} inferred visitors; ${n(b.taggedLeads)} tagged + ${n(b.inferredLeads)} source-matched/inferred leads. Unassigned: ${n(u.visitors)} visitors and ${n(u.leads)} leads, excluded from A/B totals. ${run.excluded_updated_visitors ? n(run.excluded_updated_visitors) + ' older visitor records were updated after the cutoff and could not be reconstructed (whole test period).' : ''}`;
    }
    el('insight').textContent = historical() ? `Historical results: A generated ${n(a.leads)} leads; B generated ${n(b.leads)} leads in the selected dates. Estimated lead rates are ${pct(a.rate)} and ${pct(b.rate)}. Review inferred attribution below before drawing a conclusion.` : a.visitors && b.visitors && a.rate ? `Selected dates: B's observed conversion rate is ${Math.abs((b.rate / a.rate - 1) * 100).toFixed(1)}% ${b.rate >= a.rate ? 'higher' : 'lower'} than A (${(b.rate - a.rate).toFixed(2)} percentage points). The statistical verdict above uses the full run.` : 'Selected dates: a rate comparison will appear once both variants have visitors and variant A has a conversion. The statistical verdict uses the full run.';
    const setup = [['Control', run.name], ['Variant B', run.b_name], ['Traffic allocation · A / B', splitLabel(run)], ['Started', date(run.started_at)]];
    if (!historical()) for (const [key,value] of Object.entries(run.config.variantB || {})) { if (value !== '' && value != null) setup.push(['B · '+key.replace(/[_-]/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2'),String(value)]); }
    el('configSnapshot').innerHTML = setup.map(([label,value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('');
    drawChart();
    el('dailyBody').innerHTML = data.daily.map(d => `<tr><td>${d.date}</td>${['A','B'].map(v => `<td>${n(d[v].visitors)}</td><td>${n(d[v].leads)}</td><td>${pct(d[v].rate)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7" class="ab-empty">No results for this range.</td></tr>';
    el('leadOutcomeHeader').hidden=historical();
    el('leadsBody').innerHTML = data.recent.map(l => `<tr><td>#${l.lead_id}</td><td>${l.variant === 'U' ? 'Unassigned' : 'Variant ' + l.variant}</td><td>${historical() ? attributionLabel(l.attribution) : esc(date(l.first_seen))}</td><td>${esc(date(l.created_at))}</td>${historical()?'':`<td>${l.outcome?.closed_won?'Closed Won':l.outcome?.opportunity?'Opportunity':l.outcome?.state==='matched'?'Lead':l.outcome?.state==='ambiguous'?'Match needs review':'Awaiting match'}</td>`}</tr>`).join('') || '<tr><td colspan="5" class="ab-empty">No attributed leads from these visitors yet.</td></tr>';
  }
  async function load() {
    const id = ++requestId;
    el('error').hidden = true; el('loading').hidden = false; el('report').setAttribute('aria-busy','true');
    el('exportResults').disabled = true;
    const q = new URLSearchParams(params);
    q.set('from',el('dateFrom').value); q.set('to',el('dateTo').value); q.set('source',view);
    try {
      const result = await api('/api/ab-tests?' + q);
      if (id !== requestId) return false;
      data = result;
      render();
      params.set('source',view);
      for (const key of ['from','to']) { const value=key === 'from' ? el('dateFrom').value : el('dateTo').value; if (value) params.set(key,value); else params.delete(key); }
      if (detailOpen && data.selectedId) { params.set('run',data.selectedId); params.set('detail','1'); }
      else { params.delete('run'); params.delete('detail'); }
      history.replaceState(null,'','?'+params);
      return true;
    } catch (err) {
      if (id !== requestId) return false;
      el('error').textContent = err.message+' Use Refresh to try again.'; el('error').hidden=false;
      el('runDetail').hidden=true; el('testCards').innerHTML=''; data=null;
      for (const name of ['activeTotal','visitorTotal','leadTotal','rateTotal']) el(name).textContent='—';
      return false;
    } finally { if (id === requestId) { el('loading').hidden=true; el('report').setAttribute('aria-busy','false'); } }
  }
  function focusDetail() { if (detailOpen && selected()) { el('runName').focus({preventScroll:true}); el('backToTests').scrollIntoView({block:'start'}); } }
  el('viewTabs').addEventListener('click',e => {
    const button=e.target.closest('[data-view]'); if (!button || button.dataset.view === view) return;
    view=button.dataset.view; detailOpen=false; el('testSearch').value='';
    params.delete('run'); params.delete('page'); params.delete('detail'); load();
  });
  el('backToTests').addEventListener('click',() => {
    detailOpen=false; params.delete('run'); params.delete('page'); params.delete('detail');
    load().then(ok => { if (ok) { el('listTitle').focus({preventScroll:true}); el('viewTabs').scrollIntoView({block:'start'}); } });
  });
  el('filters').addEventListener('submit',e => { e.preventDefault(); if (el('dateFrom').value && el('dateTo').value && el('dateFrom').value > el('dateTo').value) { el('error').textContent='Start date must be on or before end date.'; el('error').hidden=false; return; } load(); });
  el('datePreset').addEventListener('change',() => {
    el('customDates').hidden=el('datePreset').value !== 'custom';
    if (!el('customDates').hidden) return;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:data?.timezone || 'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const values=presetDates(el('datePreset').value,today); el('dateFrom').value=values[0]; el('dateTo').value=values[1]; load();
  });
  el('refresh').addEventListener('click',load);
  el('testSearch').addEventListener('input',() => { if (data) drawTests(); });
  el('chartMetric').addEventListener('change',() => { if (data) drawChart(); });
  el('testCards').addEventListener('click',e => { const button=e.target.closest('[data-run]'); if (button) { params.set('run',button.dataset.run); detailOpen=true; load().then(ok => { if (ok) focusDetail(); }); } });
  el('runSelect').addEventListener('change',() => { params.set('run',el('runSelect').value); load(); });
  el('exportResults').addEventListener('click', () => {
    const run = selected(); if (!run) return;
    const rows = [['Test','Run','Date from','Date to','Timezone','Record date','Variant','Visitors','Leads','Linked/converted visitors','Rate','Source','Tagged visitors','Inferred visitors','Tagged leads','Inferred leads','Date basis']];
    for (const day of data.daily) for (const v of (historical() ? ['A','B','U'] : ['A','B'])) rows.push([run.name,runLabel(run),data.from,data.to,data.timezone,day.date,v,day[v].visitors,day[v].leads,day[v].converted,pct(day[v].rate),historical() ? 'Historical estimate' : 'Live',day[v].taggedVisitors ?? '',day[v].inferredVisitors ?? '',day[v].taggedLeads ?? '',day[v].inferredLeads ?? '',historical() ? 'Last saved visitor date / lead submission date' : 'First test visit cohort']);
    if (!data.daily.length) for (const v of ['A','B']) rows.push([run.name,runLabel(run),data.from,data.to,data.timezone,'All selected dates',v,0,0,0,historical() ? '—' : '0.00%',historical() ? 'Historical estimate' : 'Live',0,0,0,0,historical() ? 'Last saved visitor date / lead submission date' : 'First test visit cohort']);
    rows[0].push('Model','Verdict scope','Verdict','Winner','Probability A better','Probability B better','Full-run A visitors','Full-run A converted','Full-run B visitors','Full-run B converted');
    const m=run.inference;
    for (const row of rows.slice(1)) row.push(m?.model || '',m?.scope || '',m?.status || 'Historical estimates only',m?.winner || '',m?.probability?.A ?? '',m?.probability?.B ?? '',m?.stats?.A?.visitors ?? '',m?.stats?.A?.converted ?? '',m?.stats?.B?.visitors ?? '',m?.stats?.B?.converted ?? '');
    rows[0].push('Opportunities','Closed Won','Matched submissions','Unmatched submissions','Outcome checked at','Outcome data delayed');
    for (let i=1;i<rows.length;i++) { const row=rows[i], day=data.daily.find(d=>d.date===row[5]), o=day?.[row[6]]?.outcomes; row.push(o?.opportunities ?? '',o?.closedWon ?? '',o?.matched ?? '',o?.unmatched ?? '',data.outcomeSync?.lastSuccess ? new Date(data.outcomeSync.lastSuccess).toISOString() : '',data.outcomeSync?.stale ?? ''); }
    const cell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g,'""') + '"';
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = `ab-test-${run.id}-${data.from || 'all'}-${data.to || 'today'}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  el('dateFrom').value=params.get('from') || ''; el('dateTo').value=params.get('to') || '';
  el('datePreset').value=params.get('from') || params.get('to') ? 'custom' : 'all';
  el('customDates').hidden=el('datePreset').value !== 'custom';
  load();
})();
