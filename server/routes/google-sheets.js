const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('./auth');

const router = express.Router();

const SHEETS = [
  { id: '1M5c0N_69hUK2-J_Kg8t8hdFMcWITct3D0aWxlEHM6lI', source: 'Google Ads' },
  { id: '1MIHXOnTG1Yc0tt5mNy0Et1KHtb2POXL6jW3thsev5Ec', source: 'Facebook' },
  { id: '1MIHXOnTG1Yc0tt5mNy0Et1KHtb2POXL6jW3thsev5Ec', source: 'Facebook Form', tab: 'form' },
  { id: '1zcECsFWlakaG4c6fX2vbjISlrbn-3mX70Fmj2HGMb9k', source: 'TikTok' }
];

// Header-to-key mapping (normalise sheet headers to consistent snake_case keys)
function headerToKey(header, index, allHeaders) {
  const map = {
    'date': 'date',
    'date / time': 'date',
    'debt amount': 'debt_amount',
    'multiple mc': 'multiple_mc',
    'company': 'company',
    'first name': 'first_name',
    'last name': 'last_name',
    'email': 'email',
    'phone': 'phone',
    'url': 'url',
    'form title': 'form_title',
    'form titlle': 'form_title',
    'entry id': 'entry_id',
    'user ip': 'user_ip',
    'form id': 'form_id',
    'campaign': 'campaign',
    'campaign name': 'campaign',
    'utm campaign': 'campaign',
    'campaign id': 'campaign_id',
    'ad id': 'ad_id',
    'ad set id': 'ad_set_id',
    'ad name': 'ad_name',
    'ad set name': 'ad_set_name',
    'ad group': 'ad_group',
    'ad group id': 'ad_group_id',
    'utm term': 'utm_term',
    'utm agid': 'utm_agid',
    'utm ad': 'utm_ad',
    'creative': 'creative',
    'keyword': 'keyword',
    'device/placement': 'device',
    'device': 'device',
    'placement': 'placement',
    'utm source': 'utm_source',
    'utm_source': 'utm_source',
    'status': 'status',
    'termination reason': 'termination_reason',
    'state': 'state',
    'close date': 'close_date'
  };
  const lower = (header || '').trim().toLowerCase();
  // Handle blank/space-only headers by position (column 8 = Phone in Google Ads sheet)
  if (!lower) return '_blank_' + index;
  return map[lower] || lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

let authClient = null;

// On Railway, write the key file from env var so file-based auth just works
const keyPath = path.join(__dirname, '..', 'google-sheets-key.json');
if (process.env.GOOGLE_SHEETS_KEY_JSON && !fs.existsSync(keyPath)) {
  try {
    fs.writeFileSync(keyPath, process.env.GOOGLE_SHEETS_KEY_JSON);
    console.log('Wrote google-sheets-key.json from env var');
  } catch (e) {
    console.error('Failed to write google-sheets-key.json:', e.message);
  }
}

async function getAuthClient() {
  if (authClient) return authClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  authClient = await auth.getClient();
  return authClient;
}

async function fetchSheet(sheets, sheetConfig) {
  const range = sheetConfig.tab ? `'${sheetConfig.tab}'!A:AZ` : 'A:AZ';
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range
  });

  const rows = resp.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map((h, i, arr) => headerToKey(h, i, arr));

  // Detect phone column: if header is blank/space but data looks like phone numbers
  const phoneIdx = headers.findIndex((h, i) => {
    if (!h.startsWith('_blank_')) return false;
    // Check a few data rows to see if values look like phone numbers
    for (let r = 1; r < Math.min(rows.length, 5); r++) {
      const val = (rows[r][i] || '').trim();
      if (val && /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(val)) return true;
    }
    return false;
  });
  if (phoneIdx !== -1) headers[phoneIdx] = 'phone';

  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((key, i) => {
      if (key.startsWith('_blank_')) return; // skip truly blank columns
      obj[key] = (row[i] || '').trim();
    });
    obj.source = sheetConfig.source;
    return obj;
  });
}

// GET /api/google-sheets/debug — diagnose Google Sheets connection
router.get('/debug', authenticateToken, async (req, res) => {
  const checks = {
    keyFileExists: fs.existsSync(keyPath),
    keyFilePath: keyPath,
    envVarSet: !!process.env.GOOGLE_SHEETS_KEY_JSON,
    envVarLength: process.env.GOOGLE_SHEETS_KEY_JSON ? process.env.GOOGLE_SHEETS_KEY_JSON.length : 0
  };

  try {
    if (checks.keyFileExists) {
      const raw = fs.readFileSync(keyPath, 'utf8');
      const key = JSON.parse(raw);
      checks.keyFileValid = true;
      checks.clientEmail = key.client_email || 'missing';
      checks.projectId = key.project_id || 'missing';
      checks.hasPrivateKey = !!key.private_key;
    }
  } catch (e) {
    checks.keyFileValid = false;
    checks.keyFileError = e.message;
  }

  try {
    const client = await getAuthClient();
    checks.authSuccess = true;
    const sheets = google.sheets({ version: 'v4', auth: client });
    for (const s of SHEETS) {
      try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId: s.id, range: 'A1:A2' });
        checks['sheet_' + s.source.replace(/\s/g, '_')] = { ok: true, rows: resp.data.values ? resp.data.values.length : 0 };
      } catch (e) {
        checks['sheet_' + s.source.replace(/\s/g, '_')] = { ok: false, error: e.message };
      }
    }
  } catch (e) {
    checks.authSuccess = false;
    checks.authError = e.message;
  }

  res.json(checks);
});

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

    // Fetch all target sheets in parallel (skip sheets that fail e.g. permission errors)
    const results = await Promise.all(targets.map(s =>
      fetchSheet(sheets, s).catch(err => {
        console.error(`Google Sheets: failed to fetch "${s.source}" (${s.id}):`, err.message);
        return [];
      })
    ));
    let allRows = results.flat();

    // Sort by date descending
    allRows.sort((a, b) => {
      const da = parseSheetDate(a.date);
      const db = parseSheetDate(b.date);
      return db - da;
    });

    res.json(allRows);
  } catch (err) {
    console.error('Google Sheets leads error:', err.message || err);
    const detail = process.env.GOOGLE_SHEETS_KEY_JSON
      ? 'Auth via env var failed: ' + (err.message || 'unknown')
      : 'Key file missing or invalid: ' + (err.message || 'unknown');
    res.status(500).json({ error: 'Failed to fetch Google Sheets leads', detail });
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
