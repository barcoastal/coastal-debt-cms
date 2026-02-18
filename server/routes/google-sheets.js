const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const { authenticateToken } = require('./auth');

const router = express.Router();

const SHEETS = [
  { id: '1M5c0N_69hUK2-J_Kg8t8hdFMcWITct3D0aWxlEHM6lI', source: 'Google Ads' },
  { id: '1MIHXOnTG1Yc0tt5mNy0Et1KHtb2POXL6jW3thsev5Ec', source: 'Facebook' }
];

// Header-to-key mapping (normalise sheet headers to consistent snake_case keys)
function headerToKey(header) {
  const map = {
    'date': 'date',
    'debt amount': 'debt_amount',
    'multiple mc': 'multiple_mc',
    'company': 'company',
    'first name': 'first_name',
    'last name': 'last_name',
    'email': 'email',
    'phone': 'phone',
    'url': 'url',
    'form title': 'form_title',
    'entry id': 'entry_id',
    'user ip': 'user_ip',
    'form id': 'form_id',
    'campaign': 'campaign',
    'campaign name': 'campaign',
    'campaign id': 'campaign_id',
    'ad group': 'ad_group',
    'ad group id': 'ad_group_id',
    'keyword': 'keyword',
    'device/placement': 'device',
    'device': 'device',
    'placement': 'device',
    'utm source': 'utm_source',
    'utm_source': 'utm_source',
    'status': 'status',
    'termination reason': 'termination_reason',
    'state': 'state',
    'close date': 'close_date'
  };
  const lower = (header || '').trim().toLowerCase();
  return map[lower] || lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

let authClient = null;

async function getAuthClient() {
  if (authClient) return authClient;
  const keyPath = path.join(__dirname, '..', 'google-sheets-key.json');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  authClient = await auth.getClient();
  return authClient;
}

async function fetchSheet(sheets, sheetConfig) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: 'A:Z'
  });

  const rows = resp.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map(headerToKey);
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((key, i) => {
      obj[key] = (row[i] || '').trim();
    });
    obj.source = sheetConfig.source;
    return obj;
  });
}

// GET /api/google-sheets/leads
router.get('/leads', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const { source } = req.query;

    // Determine which sheets to fetch
    const targets = source
      ? SHEETS.filter(s => s.source.toLowerCase() === source.toLowerCase())
      : SHEETS;

    // Fetch all target sheets in parallel
    const results = await Promise.all(targets.map(s => fetchSheet(sheets, s)));
    let allRows = results.flat();

    // Sort by date descending
    allRows.sort((a, b) => {
      const da = parseSheetDate(a.date);
      const db = parseSheetDate(b.date);
      return db - da;
    });

    res.json(allRows);
  } catch (err) {
    console.error('Google Sheets leads error:', err);
    res.status(500).json({ error: 'Failed to fetch Google Sheets leads' });
  }
});

// Parse dates like "09/07/2025 01:26:49" or "2025-09-07"
function parseSheetDate(dateStr) {
  if (!dateStr) return 0;
  // Try MM/DD/YYYY HH:MM:SS
  const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2}):(\d{2}):(\d{2})$/);
  if (parts) {
    return new Date(parts[3], parts[1] - 1, parts[2], parts[4], parts[5], parts[6]).getTime();
  }
  // Fallback
  const t = new Date(dateStr).getTime();
  return isNaN(t) ? 0 : t;
}

module.exports = router;
