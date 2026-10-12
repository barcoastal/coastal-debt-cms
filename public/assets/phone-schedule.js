(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoastalPhoneSchedule = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const formatters = new Map();
  function formatter(timezone) {
    if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }));
    return formatters.get(timezone);
  }
  function defaults() {
    return {mode: 'always', timezone: 'America/New_York', days: Object.fromEntries(days.map((day, i) =>
      [day, {mode: i === 0 || i === 6 ? 'closed' : 'hours', start: '09:00', end: '18:00'}]))};
  }
  function normalize(value) {
    if (!value || !['always', 'scheduled', 'hidden'].includes(value.mode)) throw new Error('Choose when to show phone numbers.');
    if (typeof value.timezone !== 'string' || value.timezone.length > 80) throw new Error('Choose a valid timezone.');
    try { formatter(value.timezone); } catch (_) { throw new Error('Choose a valid timezone.'); }
    const clean = {mode: value.mode, timezone: value.timezone, days: {}};
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    for (const day of days) {
      const row = value.days && value.days[day];
      if (!row || !['closed', 'hours', 'all-day'].includes(row.mode)) throw new Error('Choose hours for every day.');
      if (!time.test(row.start) || !time.test(row.end)) throw new Error('Enter valid start and end times for ' + day + '.');
      if (row.mode === 'hours' && row.start === row.end) throw new Error('Start and end must differ for ' + day + '. Choose All day for 24 hours.');
      clean.days[day] = {mode: row.mode, start: row.start, end: row.end};
    }
    return clean;
  }
  function visible(schedule, now) {
    if (schedule.mode === 'always') return true;
    if (schedule.mode === 'hidden') return false;
    const parts = Object.fromEntries(formatter(schedule.timezone).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    const index = days.indexOf(parts.weekday.toLowerCase());
    const current = parts.hour + ':' + parts.minute;
    const today = schedule.days[days[index]], yesterday = schedule.days[days[(index + 6) % 7]];
    // An overnight interval belongs to its starting day, including Sunday -> Monday.
    if (yesterday.mode === 'hours' && yesterday.end < yesterday.start && current < yesterday.end) return true;
    if (today.mode === 'all-day') return true;
    if (today.mode !== 'hours') return false;
    return today.end < today.start ? current >= today.start : current >= today.start && current < today.end;
  }
  return {days, defaults, normalize, visible};
});
