// Keep measured results and recovered estimates distinct while listing every test.
function report(store, query = {}) {
  const live = store.report(query);
  const history = store.history.report(query);
  const source = ['active', 'ended', 'live', 'historical'].includes(query.source) ? query.source : 'all';
  const liveRuns = live.runs.map(run => ({ ...run, source: 'live' }));
  const active = run => run.source === 'live' && !run.ended_at;
  const runs = (source === 'active' ? liveRuns.filter(active) : source === 'ended' ? liveRuns.filter(run => run.ended_at) : source === 'live' ? liveRuns : source === 'historical' ? history.runs : [...liveRuns, ...history.runs])
    .sort((a, b) => Number(active(b)) - Number(active(a)) || b.started_at - a.started_at || b.id - a.id);
  const selected = runs.find(run => run.id === Number(query.run)) || runs.find(run => run.page_id === Number(query.page)) || runs[0];
  let detail = selected?.source === 'historical' ? history : live;
  if (selected && detail.selectedId !== selected.id) {
    detail = (selected.source === 'historical' ? store.history : store).report({ ...query, run: selected.id });
  }
  return {
    ...detail, source, runs, selectedId: selected?.id || null,
    daily: selected ? detail.daily : [], recent: selected ? detail.recent : [],
    activeCount: liveRuns.filter(active).length,
    endedCount: liveRuns.filter(run => run.ended_at).length,
    historicalCount: history.runs.length
  };
}
module.exports = { report };
