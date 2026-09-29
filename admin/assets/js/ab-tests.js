(function () {
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const n = value => Number(value || 0).toLocaleString();
  const pct = value => Number(value || 0).toFixed(2) + '%';
  const params = new URLSearchParams(location.search);
  let data, requestId = 0;
  const date = ms => ms ? new Date(ms).toLocaleString('en-US', { timeZone: data.timezone, dateStyle: 'medium', timeStyle: 'short' }) : 'Running';
  function presetDates(value, today) {
    if (value === 'all') return ['', ''];
    const days = value === 'today' ? 0 : value === '7d' ? 6 : 29;
    return [new Date(Date.parse(today + 'T12:00:00Z') - days * 86400000).toISOString().slice(0, 10), today];
  }
  function selected() { return data?.runs.find(r => r.id === data.selectedId); }
  function status(run) { return run.ended_at ? 'Ended' : 'Active'; }
  function drawTests() {
    const search = el('testSearch').value.toLowerCase();
    const filter = el('testStatus').value;
    const runs = data.runs.filter(r => (r.name + ' ' + r.slug + ' ' + r.b_name).toLowerCase().includes(search) && (filter === 'all' || (filter === 'active' ? !r.ended_at : r.ended_at)));
    el('testsBody').innerHTML = runs.map(r => `<tr class="${r.id === data.selectedId ? 'ab-selected' : ''}">
      <td><button class="ab-test-link" data-run="${r.id}">${esc(r.name)}</button><small>/lp/${esc(r.slug)}/ · Run #${r.id}</small></td>
      <td><span class="ab-status ${r.ended_at ? '' : 'active'}">${status(r)}</span></td>
      <td>${100 - Number(r.config.split ?? 50)}% / ${Number(r.config.split ?? 50)}%</td>
      <td>${n(r.stats.A.visitors + r.stats.B.visitors)}</td><td>${n(r.stats.A.leads + r.stats.B.leads)}</td>
      <td><span style="color:var(--a)">${pct(r.stats.A.rate)}</span> / <span style="color:var(--b)">${pct(r.stats.B.rate)}</span></td>
      <td>${esc(date(r.started_at))}<small>${r.ended_at ? 'Ended ' + esc(date(r.ended_at)) : 'Currently running'}</small></td></tr>`).join('') || '<tr><td colspan="7" class="ab-empty">No tests match these filters. Enable an A/B test from Landing Pages to start.</td></tr>';
    el('testCount').textContent = `${runs.length} saved run${runs.length === 1 ? '' : 's'}`;
  }
  function drawChart() {
    const metric = el('chartMetric').value;
    if (!data.daily.length) { el('dailyChart').innerHTML = '<div class="ab-empty">No measured visitors in this date range.<br>Results appear as visitors enter this test.</div>'; return; }
    const days = data.daily;
    const max = Math.max(1, ...days.flatMap(d => [d.A[metric], d.B[metric]]));
    const w = 880, h = 180, left = 44, right = 15, top = 12, bottom = 30;
    const x = i => left + (days.length === 1 ? (w - left - right) / 2 : i / (days.length - 1) * (w - left - right));
    const y = v => h - bottom - v / max * (h - top - bottom);
    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily ${esc(metric)} by variant. Exact values are in the table below.">`;
    for (let i = 0; i < 3; i++) {
      const value = max * i / 2;
      svg += `<line x1="${left}" x2="${w-right}" y1="${y(value)}" y2="${y(value)}" stroke="#e8edf4"/><text x="${left - 8}" y="${y(value)+4}" text-anchor="end" fill="#718198" font-size="11">${metric === 'rate' ? value.toFixed(1)+'%' : Number(value.toFixed(1))}</text>`;
    }
    for (const [v, color] of [['A','#3052ff'],['B','#8a46ce']]) {
      svg += `<polyline points="${days.map((d,i) => `${x(i)},${y(d[v][metric])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
      if (days.length < 60) svg += days.map((d,i) => `<circle cx="${x(i)}" cy="${y(d[v][metric])}" r="3.5" fill="${color}"><title>${d.date} · ${v}: ${metric === 'rate' ? pct(d[v][metric]) : n(d[v][metric])}</title></circle>`).join('');
    }
    const labels = [...new Set([0, Math.floor((days.length - 1)/2), days.length - 1])];
    svg += labels.map(i => `<text x="${x(i)}" y="${h-7}" text-anchor="${i === 0 ? 'start' : i === days.length-1 ? 'end' : 'middle'}" fill="#718198" font-size="11">${days[i].date}</text>`).join('') + '</svg>';
    el('dailyChart').innerHTML = svg;
  }
  function render() {
    el('timezone').textContent = 'Dates in ' + data.timezone;
    el('coverage').textContent = data.trackingSince ? `Reliable test tracking began ${date(data.trackingSince)}. Earlier totals cannot be assigned reliably and are excluded. Each split or variant configuration change starts a separate run.` : 'Enable an A/B test on a landing page to begin measuring results.';
    const active = data.runs.filter(r => !r.ended_at).length;
    const totals = data.runs.reduce((a,r) => { for (const v of ['A','B']) { a.visitors += r.stats[v].visitors; a.leads += r.stats[v].leads; a.converted += r.stats[v].converted; } return a; }, {visitors:0,leads:0,converted:0});
    el('activeTotal').textContent = n(active); el('visitorTotal').textContent = n(totals.visitors); el('leadTotal').textContent = n(totals.leads); el('rateTotal').textContent = pct(totals.visitors ? totals.converted / totals.visitors * 100 : 0);
    drawTests();
    const run = selected();
    el('runDetail').hidden = !run;
    el('exportResults').disabled = !run;
    if (!run) return;
    el('runName').textContent = run.name;
    el('runMeta').textContent = `${status(run)} · Run #${run.id} · Started ${date(run.started_at)}${run.ended_at ? ' · Ended ' + date(run.ended_at) : ''}`;
    el('runSelect').innerHTML = data.runs.filter(r => r.page_id === run.page_id).map(r => `<option value="${r.id}" ${r.id === run.id ? 'selected' : ''}>Run #${r.id} · ${esc(date(r.started_at))} · ${status(r)}</option>`).join('');
    el('pageLink').href = '/lp/' + encodeURIComponent(run.slug) + '/';
    el('configureLink').href = '/admin/pages.html?ab=' + run.page_id;
    el('variantCards').innerHTML = ['A','B'].map(v => { const s = run.stats[v]; return `<section class="ab-variant variant-${v.toLowerCase()}">
      <h3>Variant ${v}${v === 'A' ? ' · Control' : ''}</h3><div class="ab-muted">${esc(v === 'A' ? run.name + ' · ' + run.template : run.b_name)} · ${v === 'A' ? 100 - Number(run.config.split ?? 50) : Number(run.config.split ?? 50)}% allocated</div>
      <strong class="ab-rate">${pct(s.rate)}</strong><span class="ab-muted">visitor conversion rate</span>
      <div class="ab-variant-stats"><div><strong>${n(s.visitors)}</strong><span>Visitors</span></div><div><strong>${n(s.leads)}</strong><span>Leads</span></div><div><strong>${n(s.converted)}</strong><span>Converted visitors</span></div></div></section>`; }).join('');
    const a = run.stats.A, b = run.stats.B;
    el('insight').textContent = a.visitors && b.visitors && a.rate ? `B's observed conversion rate is ${Math.abs((b.rate / a.rate - 1) * 100).toFixed(1)}% ${b.rate >= a.rate ? 'higher' : 'lower'} than A (${(b.rate - a.rate).toFixed(2)} percentage points). This is an observed difference, not a statistically confirmed winner.` : 'A comparison will appear once both variants have visitors and variant A has a conversion. No winner is declared automatically.';
    el('configSnapshot').textContent = JSON.stringify(run.config, null, 2);
    drawChart();
    el('dailyBody').innerHTML = data.daily.map(d => `<tr><td>${d.date}</td>${['A','B'].map(v => `<td>${n(d[v].visitors)}</td><td>${n(d[v].leads)}</td><td>${pct(d[v].rate)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7" class="ab-empty">No results for this range.</td></tr>';
    el('leadsBody').innerHTML = data.recent.map(l => `<tr><td>#${l.lead_id}</td><td>Variant ${l.variant}</td><td>${esc(date(l.first_seen))}</td><td>${esc(date(l.created_at))}</td></tr>`).join('') || '<tr><td colspan="4" class="ab-empty">No attributed leads from these visitors yet.</td></tr>';
  }
  async function load() {
    const id = ++requestId;
    el('error').hidden = true; el('loading').hidden = false; el('report').setAttribute('aria-busy', 'true');
    el('exportResults').disabled = true;
    const q = new URLSearchParams(params);
    q.set('from', el('dateFrom').value); q.set('to', el('dateTo').value);
    try {
      const result = await api('/api/ab-tests?' + q);
      if (id !== requestId) return;
      data = result;
      render();
      params.set('from', el('dateFrom').value); params.set('to', el('dateTo').value);
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
  el('refresh').addEventListener('click', load);
  el('testSearch').addEventListener('input', () => { if (data) drawTests(); }); el('testStatus').addEventListener('change', () => { if (data) drawTests(); });
  el('chartMetric').addEventListener('change', () => { if (data) drawChart(); });
  el('testsBody').addEventListener('click', e => { const button = e.target.closest('[data-run]'); if (button) { params.set('run', button.dataset.run); load().then(() => el('runDetail').scrollIntoView({behavior:'smooth',block:'start'})); } });
  el('runSelect').addEventListener('change', () => { params.set('run', el('runSelect').value); load(); });
  el('exportResults').addEventListener('click', () => {
    const run = selected(); if (!run) return;
    const rows = [['Test','Run','Date from','Date to','Timezone','Visitor date','Variant','Visitors','Leads','Converted visitors','Conversion rate']];
    for (const day of data.daily) for (const v of ['A','B']) rows.push([run.name,run.id,data.from,data.to,data.timezone,day.date,v,day[v].visitors,day[v].leads,day[v].converted,pct(day[v].rate)]);
    if (!data.daily.length) for (const v of ['A','B']) rows.push([run.name,run.id,data.from,data.to,data.timezone,'All selected dates',v,0,0,0,'0.00%']);
    const cell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g,'""') + '"';
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = `ab-test-${run.id}-${data.from || 'all'}-${data.to || 'today'}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  el('dateFrom').value = params.get('from') || ''; el('dateTo').value = params.get('to') || '';
  el('datePreset').value = params.has('from') || params.has('to') ? 'custom' : 'all';
  load();
})();
