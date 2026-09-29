(function () {
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const n = value => Number(value || 0).toLocaleString();
  const pct = value => value == null ? '—' : Number(value).toFixed(2) + '%';
  const params = new URLSearchParams(location.search);
  let data, requestId = 0;
  const date = ms => ms ? new Date(ms).toLocaleString('en-US', { timeZone: data.timezone, dateStyle: 'medium', timeStyle: 'short' }) : 'Running';
  function presetDates(value, today) {
    if (value === 'all') return ['', ''];
    const days = value === 'today' ? 0 : value === '7d' ? 6 : 29;
    return [new Date(Date.parse(today + 'T12:00:00Z') - days * 86400000).toISOString().slice(0, 10), today];
  }
  function selected() { return data?.runs.find(r => r.id === data.selectedId); }
  function historical() { return data?.source === 'historical'; }
  function runLabel(run) { return run.source === 'historical' ? 'Historical period ' + Math.abs(run.id) : 'Run #' + run.id; }
  function status(run) { return run.source === 'historical' ? 'Historical' : run.ended_at ? 'Ended' : 'Active'; }
  function splitLabel(run) { return run.config.split == null ? 'Not recorded' : (100 - Number(run.config.split)) + '% / ' + Number(run.config.split) + '%'; }
  function attributionLabel(value) { return value === 'tagged' ? 'URL + variant tag' : value === 'inferred_source' ? 'Matched source page' : value === 'inferred_origin' ? 'Inferred test origin' : 'Unassigned'; }

  function drawTests() {
    const search = el('testSearch').value.toLowerCase();
    const filter = el('testStatus').value;
    const runs = data.runs.filter(r => (r.name + ' ' + r.slug + ' ' + r.b_name).toLowerCase().includes(search) && (filter === 'all' || (filter === 'active' ? !r.ended_at : r.ended_at)));
    el('testsBody').innerHTML = runs.map(r => `<tr class="${r.id === data.selectedId ? 'ab-selected' : ''}">
      <td><button class="ab-test-link" data-run="${r.id}">${esc(r.name)}</button><small>/lp/${esc(r.slug)}/ · ${runLabel(r)}</small></td>
      <td><span class="ab-status ${r.ended_at ? '' : 'active'}">${status(r)}</span></td>
      <td>${splitLabel(r)}</td>
      <td>${n(r.stats.A.visitors + r.stats.B.visitors)}</td><td>${n(r.stats.A.leads + r.stats.B.leads)}</td>
      <td><span style="color:var(--a)">${pct(r.stats.A.rate)}</span> / <span style="color:var(--b)">${pct(r.stats.B.rate)}</span></td>
      <td>${esc(date(r.started_at))}<small>${r.ended_at ? (historical() ? 'Through ' : 'Ended ') + esc(date(r.ended_at)) : 'Currently running'}</small></td></tr>`).join('') || '<tr><td colspan="7" class="ab-empty">No tests match these filters. Enable an A/B test from Landing Pages to start.</td></tr>';
    el('testCount').textContent = `${runs.length} saved ${historical() ? 'period' : 'run'}${runs.length === 1 ? '' : 's'}`;
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
    for (const [v, color] of [['A','#3052ff'],['B','#8a46ce']]) {
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
    el('timezone').textContent = 'Dates in ' + data.timezone;
    el('coverage').textContent = historical() ? `Historical records recovered through ${date(data.trackingSince)}. Test periods come from saved activity logs. Lead URLs identify the original test; missing variant tags are shown as inferred. Historical visitor counts and conversion rates are estimates.` : data.trackingSince ? `Live measurement began ${date(data.trackingSince)}. Switch to Historical results for earlier test results. Each split or variant configuration change starts a separate run.` : 'Enable an A/B test on a landing page to begin measuring results.';
    el('periodCountLabel').textContent = historical() ? 'Historical periods' : 'Active tests';
    el('totalRateLabel').textContent = historical() ? 'Estimated lead rate' : 'Visitor conversion rate';
    el('testStatus').hidden = historical();
    el('comparisonRateHeader').textContent = historical() ? 'Est. lead rate A / B' : 'Conversion A / B';
    el('dailyRateA').textContent = historical() ? 'A est. rate' : 'A conversion';
    el('dailyRateB').textContent = historical() ? 'B est. rate' : 'B conversion';
    el('chartMetric').querySelector('[value=rate]').textContent = historical() ? 'Estimated lead rate' : 'Conversion rate';
    el('dailyDescription').textContent = historical() ? 'Visitors by last saved visit; leads by submission date. Daily rates are estimates.' : 'Grouped by the visitor’s first measured date in this run.';
    el('recentDescription').textContent = historical() ? 'Latest 50 historical leads submitted within the selected dates.' : 'Latest 50 leads from visitors in the selected date range.';
    el('leadContextHeader').textContent = historical() ? 'Attribution' : 'First test visit';
    el('methodology').textContent = historical() ? 'Historical method: periods begin/end at recorded test saves. Each visitor appears once, on their last saved visit before live tracking began; earlier visits were not retained as separate events. For tests with a separate B source page, untagged visitors on the test URL are estimated as A. Lead submission URLs distinguish test traffic from direct source-page traffic. Lead dates are actual submission dates. Estimated lead rate = attributed leads ÷ recorded visitors; it is not a visitor-cohort conversion rate. Historical splits not preserved in records are shown as “Not recorded”. Records with unresolved attribution remain unassigned. The imported snapshot remains stable as live tracking continues.' : 'Live method: one visitor per browser per run, first seen within the selected dates. Leads include later submissions from those visitors. Conversion rate = visitors with at least one lead ÷ visitors. Direct B-source traffic is excluded. Clearing cookies or switching browsers counts as a new visitor.';
    const active = historical() ? data.runs.length : data.runs.filter(r => !r.ended_at).length;
    const totals = data.runs.reduce((a,r) => { for (const v of ['A','B']) { a.visitors += r.stats[v].visitors; a.leads += r.stats[v].leads; a.converted += r.stats[v].converted; } return a; }, {visitors:0,leads:0,converted:0});
    el('activeTotal').textContent = n(active); el('visitorTotal').textContent = n(totals.visitors); el('leadTotal').textContent = n(totals.leads); el('rateTotal').textContent = pct(totals.visitors ? (historical() ? totals.leads : totals.converted) / totals.visitors * 100 : (historical() ? null : 0));
    drawTests();
    const run = selected();
    el('runDetail').hidden = !run;
    el('exportResults').disabled = !run;
    if (!run) return;
    el('runName').textContent = run.name;
    el('runMeta').textContent = `${runLabel(run)} · ${historical() ? 'From' : status(run) + ' · Started'} ${date(run.started_at)}${run.ended_at ? (historical() ? ' · Through ' : ' · Ended ') + date(run.ended_at) : ''}`;
    el('runSelect').innerHTML = data.runs.filter(r => r.page_id === run.page_id).map(r => `<option value="${r.id}" ${r.id === run.id ? 'selected' : ''}>${runLabel(r)} · ${esc(date(r.started_at))} · ${status(r)}</option>`).join('');
    el('pageLink').href = '/lp/' + encodeURIComponent(run.slug) + '/';
    el('configureLink').href = '/admin/pages.html?ab=' + run.page_id;
    el('variantCards').innerHTML = ['A','B'].map(v => { const s = run.stats[v]; return `<section class="ab-variant variant-${v.toLowerCase()}">
      <h3>Variant ${v}${v === 'A' ? ' · Control' : ''}</h3><div class="ab-muted">${esc(v === 'A' ? run.name + (historical() ? '' : ' · ' + run.template) : run.b_name)} · ${run.config.split == null ? 'Split not recorded' : (v === 'A' ? 100 - Number(run.config.split) : Number(run.config.split)) + '% allocated'}</div>
      <strong class="ab-rate">${pct(s.rate)}</strong><span class="ab-muted">${historical() ? 'estimated lead rate' : 'visitor conversion rate'}</span>
      <div class="ab-variant-stats"><div><strong>${n(s.visitors)}</strong><span>Visitors</span></div><div><strong>${n(s.leads)}</strong><span>Leads</span></div><div><strong>${n(historical() ? s.taggedLeads : s.converted)}</strong><span>${historical() ? 'Tagged leads' : 'Converted visitors'}</span></div></div></section>`; }).join('');
    const a = run.stats.A, b = run.stats.B;
    el('attributionNote').hidden = !historical();
    if (historical()) {
      const u = run.stats.U;
      el('attributionNote').textContent = `Attribution in this range — A: ${n(a.taggedVisitors)} tagged + ${n(a.inferredVisitors)} inferred visitors; ${n(a.taggedLeads)} tagged + ${n(a.inferredLeads)} source-matched/inferred leads. B: ${n(b.taggedVisitors)} tagged + ${n(b.inferredVisitors)} inferred visitors; ${n(b.taggedLeads)} tagged + ${n(b.inferredLeads)} source-matched/inferred leads. Unassigned: ${n(u.visitors)} visitors and ${n(u.leads)} leads, excluded from A/B totals. ${run.excluded_updated_visitors ? n(run.excluded_updated_visitors) + ' older visitor records were updated after the cutoff and could not be reconstructed (whole test period).' : ''}`;
    }
    el('insight').textContent = historical() ? `Historical results: A generated ${n(a.leads)} leads; B generated ${n(b.leads)} leads in the selected dates. Estimated lead rates are ${pct(a.rate)} and ${pct(b.rate)}. Review inferred attribution below before drawing a conclusion.` : a.visitors && b.visitors && a.rate ? `B's observed conversion rate is ${Math.abs((b.rate / a.rate - 1) * 100).toFixed(1)}% ${b.rate >= a.rate ? 'higher' : 'lower'} than A (${(b.rate - a.rate).toFixed(2)} percentage points). This is an observed difference, not a statistically confirmed winner.` : 'A comparison will appear once both variants have visitors and variant A has a conversion. No winner is declared automatically.';
    el('configSnapshot').textContent = historical() ? JSON.stringify({period_dates:run.basis,split:run.config.split ?? 'Not preserved',variant_b:run.b_name,note:'Earlier content/configuration snapshots were not stored. Where shown, the split is the saved configuration at the live-tracking cutoff.'},null,2) : JSON.stringify(run.config, null, 2);
    drawChart();
    el('dailyBody').innerHTML = data.daily.map(d => `<tr><td>${d.date}</td>${['A','B'].map(v => `<td>${n(d[v].visitors)}</td><td>${n(d[v].leads)}</td><td>${pct(d[v].rate)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7" class="ab-empty">No results for this range.</td></tr>';
    el('leadsBody').innerHTML = data.recent.map(l => `<tr><td>#${l.lead_id}</td><td>${l.variant === 'U' ? 'Unassigned' : 'Variant ' + l.variant}</td><td>${historical() ? attributionLabel(l.attribution) : esc(date(l.first_seen))}</td><td>${esc(date(l.created_at))}</td></tr>`).join('') || '<tr><td colspan="4" class="ab-empty">No attributed leads from these visitors yet.</td></tr>';
  }
  async function load() {
    const id = ++requestId;
    el('error').hidden = true; el('loading').hidden = false; el('report').setAttribute('aria-busy', 'true');
    el('exportResults').disabled = true;
    const q = new URLSearchParams(params);
    q.set('from', el('dateFrom').value); q.set('to', el('dateTo').value); q.set('source', el('resultsSource').value);
    try {
      const result = await api('/api/ab-tests?' + q);
      if (id !== requestId) return;
      data = result;
      render();
      params.set('from', el('dateFrom').value); params.set('to', el('dateTo').value); params.set('source', el('resultsSource').value);
      if (data.selectedId) params.set('run', data.selectedId);
      history.replaceState(null, '', '?' + params);
    } catch (err) {
      if (id !== requestId) return;
      el('error').textContent = err.message + ' Use Refresh to try again.'; el('error').hidden = false;
      el('runDetail').hidden = true; el('testsBody').innerHTML = ''; data = null;
      for (const name of ['activeTotal','visitorTotal','leadTotal','rateTotal']) el(name).textContent = '—';
    } finally { if (id === requestId) { el('loading').hidden = true; el('report').setAttribute('aria-busy', 'false'); } }
  }
  el('filters').addEventListener('submit', e => { e.preventDefault(); if (el('dateFrom').value && el('dateTo').value && el('dateFrom').value > el('dateTo').value) { el('error').textContent = 'Start date must be on or before end date.'; el('error').hidden = false; return; } load(); });
  el('datePreset').addEventListener('change', () => { if (el('datePreset').value === 'custom') return; const today = new Intl.DateTimeFormat('en-CA', {timeZone:data?.timezone || 'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); const values = presetDates(el('datePreset').value, today); el('dateFrom').value = values[0]; el('dateTo').value = values[1]; load(); });
  ['dateFrom','dateTo'].forEach(id => el(id).addEventListener('change', () => { el('datePreset').value = 'custom'; }));
  el('resultsSource').addEventListener('change', () => { if (selected()) params.set('page', selected().page_id); params.delete('run'); el('testStatus').value='all'; load(); });
  el('refresh').addEventListener('click', load);
  el('testSearch').addEventListener('input', () => { if (data) drawTests(); }); el('testStatus').addEventListener('change', () => { if (data) drawTests(); });
  el('chartMetric').addEventListener('change', () => { if (data) drawChart(); });
  el('testsBody').addEventListener('click', e => { const button = e.target.closest('[data-run]'); if (button) { params.set('run', button.dataset.run); load().then(() => el('runDetail').scrollIntoView({behavior:'smooth',block:'start'})); } });
  el('runSelect').addEventListener('change', () => { params.set('run', el('runSelect').value); load(); });
  el('exportResults').addEventListener('click', () => {
    const run = selected(); if (!run) return;
    const rows = [['Test','Run','Date from','Date to','Timezone','Record date','Variant','Visitors','Leads','Linked/converted visitors','Rate','Source','Tagged visitors','Inferred visitors','Tagged leads','Inferred leads','Date basis']];
    for (const day of data.daily) for (const v of (historical() ? ['A','B','U'] : ['A','B'])) rows.push([run.name,runLabel(run),data.from,data.to,data.timezone,day.date,v,day[v].visitors,day[v].leads,day[v].converted,pct(day[v].rate),historical() ? 'Historical estimate' : 'Live',day[v].taggedVisitors ?? '',day[v].inferredVisitors ?? '',day[v].taggedLeads ?? '',day[v].inferredLeads ?? '',historical() ? 'Last saved visitor date / lead submission date' : 'First test visit cohort']);
    if (!data.daily.length) for (const v of ['A','B']) rows.push([run.name,runLabel(run),data.from,data.to,data.timezone,'All selected dates',v,0,0,0,historical() ? '—' : '0.00%',historical() ? 'Historical estimate' : 'Live',0,0,0,0,historical() ? 'Last saved visitor date / lead submission date' : 'First test visit cohort']);
    const cell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g,'""') + '"';
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = `ab-test-${run.id}-${data.from || 'all'}-${data.to || 'today'}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  el('resultsSource').value = params.get('source') === 'live' ? 'live' : 'historical';
  el('dateFrom').value = params.get('from') || ''; el('dateTo').value = params.get('to') || '';
  el('datePreset').value = params.get('from') || params.get('to') ? 'custom' : 'all';
  load();
})();
