const db = require('../database');

function getConfiguredTimezone() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get();
  return (row && row.value) || 'America/New_York';
}

// Convert a YYYY-MM-DD in configured timezone to UTC datetime boundaries
function localDateToUtcRange(dateStr, tz) {
  const dt = new Date(dateStr + 'T00:00:00');
  const localStr = dt.toLocaleString('en-US', { timeZone: tz });
  const utcStr = dt.toLocaleString('en-US', { timeZone: 'UTC' });
  const offsetMs = new Date(utcStr) - new Date(localStr);
  const start = new Date(dt.getTime() + offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Get "today" as YYYY-MM-DD in configured timezone
function getTodayInTz(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

// Get timezone offset in hours (for SQLite date grouping)
function getTimezoneOffsetHours(tz) {
  const now = new Date();
  const localStr = now.toLocaleString('en-US', { timeZone: tz });
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  return (new Date(localStr) - new Date(utcStr)) / 3600000;
}

module.exports = { getConfiguredTimezone, localDateToUtcRange, getTodayInTz, getTimezoneOffsetHours };
