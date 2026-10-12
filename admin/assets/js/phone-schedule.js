(async function () {
  'use strict';
  const model = window.CoastalPhoneSchedule;
  const $ = id => document.getElementById(id);
  if (location.hash === '#phone') switchTab('phone');
  const names = {mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday', sat:'Saturday', sun:'Sunday'};
  let serverTime = Date.now(), receivedAt = performance.now();
  let loading = true;
  const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];
  if (Intl.supportedValuesOf) zones.push(...Intl.supportedValuesOf('timeZone'));
  for (const zone of new Set(zones)) $('phoneScheduleTimezone').add(new Option(zone.replace(/_/g, ' '), zone));
  for (const [day, name] of Object.entries(names)) {
    const row = document.createElement('div'); row.className = 'phone-day-row';
    row.innerHTML = `<div class="phone-day-name">${name}<small id="phone-${day}-overnight"></small></div>
      <select id="phone-${day}-mode" aria-label="${name} availability"><option value="hours">Set hours</option><option value="all-day">All day</option><option value="closed">Hidden</option></select>
      <input id="phone-${day}-start" type="time" aria-label="${name} show from" required>
      <input id="phone-${day}-end" type="time" aria-label="${name} show until" required>`;
    $('phoneScheduleDays').appendChild(row);
  }
  function read() {
    return {mode: $('phoneScheduleMode').value, timezone: $('phoneScheduleTimezone').value,
      days: Object.fromEntries(Object.keys(names).map(day => [day, {mode: $(`phone-${day}-mode`).value,
        start: $(`phone-${day}-start`).value, end: $(`phone-${day}-end`).value}]))};
  }
  function render(data) {
    const value = data.schedule;
    serverTime = data.serverTime; receivedAt = performance.now();
    $('phoneScheduleMode').value = value.mode;
    if (![...$('phoneScheduleTimezone').options].some(option => option.value === value.timezone)) $('phoneScheduleTimezone').add(new Option(value.timezone, value.timezone));
    $('phoneScheduleTimezone').value = value.timezone;
    for (const day of Object.keys(names)) for (const key of ['mode', 'start', 'end']) $(`phone-${day}-${key}`).value = value.days[day][key];
    update();
  }
  function update() {
    const value = read(), weekly = value.mode === 'scheduled';
    $('phoneWeeklyHours').hidden = !weekly;
    $('phoneScheduleTimezone').disabled = !weekly;
    for (const day of Object.keys(names)) {
      const row = value.days[day];
      for (const key of ['start', 'end']) $(`phone-${day}-${key}`).disabled = !weekly || row.mode !== 'hours';
      $(`phone-${day}-overnight`).textContent = row.mode === 'hours' && row.end < row.start ? 'Ends next day' : '';
      $(`phone-${day}-end`).setCustomValidity(weekly && row.mode === 'hours' && row.start === row.end ? 'Choose a different end time, or select All day.' : '');
    }
    try {
      const clean = model.normalize(value), now = serverTime + performance.now() - receivedAt;
      const visible = model.visible(clean, now);
      $('phoneSchedulePreview').dataset.visible = String(visible);
      $('phoneScheduleStatus').textContent = (visible ? 'Phones visible' : 'Phones hidden') + (weekly ? ' right now' : ' at all times');
      $('phoneScheduleClock').textContent = new Intl.DateTimeFormat('en-US', {timeZone:value.timezone, weekday:'long', hour:'numeric', minute:'2-digit', timeZoneName:'short'}).format(new Date(now)) + ' · Preview of these settings';
      return clean;
    } catch (error) {
      $('phoneScheduleStatus').textContent = 'Check your weekly hours';
      $('phoneScheduleClock').textContent = error.message;
      return null;
    }
  }
  $('phoneScheduleForm').addEventListener('input', () => {
    update(); $('phoneScheduleMessage').dataset.error = 'false';
    $('phoneScheduleMessage').textContent = 'Unsaved changes';
  });
  $('phoneScheduleForm').addEventListener('submit', async event => {
    event.preventDefault(); const value = update(); if (!value) return;
    $('phoneScheduleFields').disabled = true;
    $('phoneScheduleSave').textContent = 'Saving…';
    try {
      render(await api('/api/phone-schedule', {method:'PUT', body:JSON.stringify(value)}));
      $('phoneScheduleMessage').dataset.error = 'false';
      $('phoneScheduleMessage').textContent = 'Saved for all landing pages. Open pages update within a minute.';
    } catch (error) {
      $('phoneScheduleMessage').dataset.error = 'true'; $('phoneScheduleMessage').textContent = error.message;
    } finally { $('phoneScheduleFields').disabled = false; $('phoneScheduleSave').textContent = 'Save phone schedule'; }
  });
  try {
    render(await api('/api/phone-schedule'));
    $('phoneScheduleFields').disabled = false; loading = false;
    $('phoneScheduleMessage').textContent = 'Changes apply to all landing pages when saved.';
  } catch (error) {
    $('phoneScheduleLoadError').hidden = false;
    $('phoneScheduleLoadError').textContent = 'Could not load the phone schedule. Reload this page to try again. ' + error.message;
  }
  setInterval(() => { if (!loading) update(); }, 30000);
  window.addEventListener('hashchange', () => { if (location.hash === '#phone') switchTab('phone'); });
})();
