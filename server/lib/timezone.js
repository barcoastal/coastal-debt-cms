const db = require('../database');

function getConfiguredTimezone() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get();
  return (row && row.value) || 'America/New_York';
}

// Convert a YYYY-MM-DD in configured timezone to UTC datetime boundaries
function localDateToUtcRange(dateStr, tz) {
  // Create midnight in the target timezone by finding the UTC equivalent
  const offsetHours = getTimezoneOffsetHours(tz);
  // Midnight local = midnight UTC minus the offset
  const startUtc = new Date(dateStr + 'T00:00:00Z');
  startUtc.setTime(startUtc.getTime() - offsetHours * 3600000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1);
  // Return in SQLite-compatible format (space separator, no Z) to match how timestamps are stored
  return {
    start: startUtc.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
    end: endUtc.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  };
}

// Get "today" as YYYY-MM-DD in configured timezone
function getTodayInTz(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

// Get timezone offset in hours (e.g. -5 for EST, -4 for EDT)
function getTimezoneOffsetHours(tz) {
  const now = new Date();
  const localStr = now.toLocaleString('en-US', { timeZone: tz });
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  return (new Date(localStr) - new Date(utcStr)) / 3600000;
}

// Get SQLite offset string like '+5 hours' or '-5 hours' for converting UTC to local in queries
function getSqliteOffsetStr(tz) {
  const offset = getTimezoneOffsetHours(tz);
  const sign = offset >= 0 ? '+' : '';
  return `${sign}${offset} hours`;
}

// Get "now" in the configured timezone as ISO string (for SQLite comparisons)
function getNowInTz(tz) {
  const now = new Date();
  return now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
}

// Format a Date object as YYYY-MM-DD using local (non-UTC) getters.
// Use this instead of date.toISOString().split('T')[0] which incorrectly converts to UTC.
function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { getConfiguredTimezone, localDateToUtcRange, getTodayInTz, getTimezoneOffsetHours, getSqliteOffsetStr, getNowInTz, formatLocalDate };
