const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Get dashboard stats
router.get('/dashboard', authenticateToken, (req, res) => {
  // Total leads
  const totalLeads = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;

  // Leads today
  const today = new Date().toISOString().split('T')[0];
  const leadsToday = db.prepare(`
    SELECT COUNT(*) as count FROM leads
    WHERE DATE(created_at) = DATE(?)
  `).get(today).count;

  // Leads this week
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const leadsThisWeek = db.prepare(`
    SELECT COUNT(*) as count FROM leads
    WHERE created_at >= ?
  `).get(weekAgo).count;

  // Leads this month
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const leadsThisMonth = db.prepare(`
    SELECT COUNT(*) as count FROM leads
    WHERE created_at >= ?
  `).get(monthAgo).count;

  // Active landing pages
  const activePages = db.prepare('SELECT COUNT(*) as count FROM landing_pages WHERE is_active = 1').get().count;

  // Total landing pages
  const totalPages = db.prepare('SELECT COUNT(*) as count FROM landing_pages').get().count;

  res.json({
    totalLeads,
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    activePages,
    totalPages
  });
});

// Leads by traffic source
router.get('/by-source', authenticateToken, (req, res) => {
  const data = db.prepare(`
    SELECT lp.traffic_source, COUNT(l.id) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    GROUP BY lp.traffic_source
    ORDER BY count DESC
  `).all();

  res.json(data);
});

// Leads by platform
router.get('/by-platform', authenticateToken, (req, res) => {
  const data = db.prepare(`
    SELECT lp.platform, COUNT(l.id) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    GROUP BY lp.platform
    ORDER BY count DESC
  `).all();

  res.json(data);
});

// Leads by landing page
router.get('/by-page', authenticateToken, (req, res) => {
  const data = db.prepare(`
    SELECT lp.id, lp.name, lp.traffic_source, COUNT(l.id) as count
    FROM landing_pages lp
    LEFT JOIN leads l ON l.landing_page_id = lp.id
    GROUP BY lp.id
    ORDER BY count DESC
  `).all();

  res.json(data);
});

// Leads over time (last 30 days)
router.get('/over-time', authenticateToken, (req, res) => {
  const days = parseInt(req.query.days) || 30;

  const data = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM leads
    WHERE created_at >= DATE('now', '-${days} days')
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all();

  res.json(data);
});

// Recent leads
router.get('/recent', authenticateToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;

  const leads = db.prepare(`
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    ORDER BY l.created_at DESC
    LIMIT ?
  `).all(limit);

  res.json(leads);
});

module.exports = router;
