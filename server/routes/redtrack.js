const express = require('express');
const { authenticateToken } = require('./auth');

const router = express.Router();

const API_KEY = process.env.REDTRACK_API_KEY || 'tQqIhdIIBzLQg3J9Z3zs';
const BASE_URL = 'https://api.redtrack.io/report';

// GET /api/redtrack/campaigns — Campaign-level report
router.get('/campaigns', authenticateToken, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = new URLSearchParams({
      api_key: API_KEY,
      group: 'campaign',
      total: 'true'
    });
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const response = await fetch(`${BASE_URL}?${params}`);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'RedTrack API error' });
    }

    // API returns { items: [...], total: {...} } — send just the items array
    res.json(data.items || []);
  } catch (err) {
    console.error('RedTrack campaigns error:', err);
    res.status(500).json({ error: 'Failed to fetch RedTrack campaigns' });
  }
});

// GET /api/redtrack/daily — Daily breakdown for charts
router.get('/daily', authenticateToken, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = new URLSearchParams({
      api_key: API_KEY,
      group: 'date'
    });
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const response = await fetch(`${BASE_URL}?${params}`);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'RedTrack API error' });
    }

    res.json(data);
  } catch (err) {
    console.error('RedTrack daily error:', err);
    res.status(500).json({ error: 'Failed to fetch RedTrack daily data' });
  }
});

// GET /api/redtrack/summary — Totals only
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = new URLSearchParams({
      api_key: API_KEY,
      group: 'campaign',
      total: 'true'
    });
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const response = await fetch(`${BASE_URL}?${params}`);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'RedTrack API error' });
    }

    // Return only the total object
    res.json(data.total || {});
  } catch (err) {
    console.error('RedTrack summary error:', err);
    res.status(500).json({ error: 'Failed to fetch RedTrack summary' });
  }
});

module.exports = router;
