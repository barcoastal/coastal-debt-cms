const REDTRACK_API_KEY = process.env.REDTRACK_API_KEY || 'tQqIhdIIBzLQg3J9Z3zs';

/**
 * Fetch individual RedTrack conversions in a time window.
 * Returns an array of { id, clickid, type, payout, created_at }.
 */
async function fetchRedTrackConversions(fromIso, toIso) {
  const params = new URLSearchParams({
    api_key: REDTRACK_API_KEY,
    date_from: fromIso.substring(0, 10),
    date_to: toIso.substring(0, 10),
    per: '500'
  });

  const url = `https://api.redtrack.io/conversions?${params}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`RedTrack /conversions ${response.status}: ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  const rows = Array.isArray(data) ? data : (data.items || data.rows || data.data || []);

  return rows.map(row => ({
    id: row.id || row._id || row.conversion_id || `${row.clickid}_${row.type}_${row.created_at}`,
    clickid: row.clickid || row.click_id || '',
    type: row.type || row.event || row.conversion_type || '',
    payout: row.payout != null ? parseFloat(row.payout) : (row.revenue != null ? parseFloat(row.revenue) : 0),
    created_at: row.created_at || row.time || row.date || new Date().toISOString()
  })).filter(r => r.clickid && r.type);
}

module.exports = { fetchRedTrackConversions };
