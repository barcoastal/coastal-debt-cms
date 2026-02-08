const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import fetchGclidCost (will be loaded after module initialization)
let fetchGclidCost = null;
setTimeout(() => {
  try {
    fetchGclidCost = require('./google-ads').fetchGclidCost;
  } catch (e) {
    console.log('Google Ads module not loaded yet');
  }
}, 0);

// Submit lead (public endpoint - from landing pages)
router.post('/', async (req, res) => {
  const {
    landing_page_slug,
    full_name,
    company_name,
    email,
    phone,
    debt_amount,
    has_mca,
    considered_bankruptcy,
    gclid,
    rt_clickid: rt_clickid_body,
    eli_clickid,
    ...hiddenFields
  } = req.body;

  // Fallback: read RedTrack cookie server-side (handles HttpOnly cookies)
  const rt_clickid = rt_clickid_body || req.cookies?.['rtkclickid-store'] || '';

  // Find the landing page
  const page = db.prepare('SELECT * FROM landing_pages WHERE slug = ?').get(landing_page_slug);

  if (!page) {
    return res.status(400).json({ error: 'Invalid landing page' });
  }

  // Get the form if assigned
  let form = null;
  if (page.form_id) {
    form = db.prepare('SELECT * FROM forms WHERE id = ?').get(page.form_id);
  }

  // Insert lead
  const result = db.prepare(`
    INSERT INTO leads (
      landing_page_id, full_name, company_name, email, phone,
      debt_amount, has_mca, considered_bankruptcy, gclid, rt_clickid, eli_clickid, hidden_fields
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    page.id,
    full_name,
    company_name,
    email,
    phone,
    debt_amount,
    has_mca,
    considered_bankruptcy,
    gclid || '',
    rt_clickid || '',
    eli_clickid || '',
    JSON.stringify(hiddenFields)
  );

  // Determine webhook URL: page webhook overrides form webhook
  const webhookUrl = page.webhook_url || (form ? form.webhook_url : null);

  // Send to webhook if configured
  if (webhookUrl) {
    try {
      const webhookData = {
        full_name,
        company_name,
        email,
        phone,
        debt_amount,
        has_mca,
        considered_bankruptcy,
        gclid: gclid || '',
        rt_clickid: rt_clickid || '',
        eli_clickid: eli_clickid || '',
        traffic_source: page.traffic_source,
        landing_page: page.name,
        ...hiddenFields,
        submitted_at: new Date().toISOString()
      };

      console.log('Sending to webhook:', webhookUrl);
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookData)
      }).then(res => console.log('Webhook response:', res.status))
        .catch(err => console.error('Webhook error:', err));
    } catch (err) {
      console.error('Webhook error:', err);
    }
  }

  // Mark visitor as converted
  if (eli_clickid) {
    try {
      db.prepare(`
        UPDATE visitors SET converted = 1, lead_id = ? WHERE eli_clickid = ?
      `).run(result.lastInsertRowid, eli_clickid);
    } catch (err) {
      console.error('Failed to mark visitor as converted:', err);
    }
  }

  // Fetch Google Ads cost for GCLID (async, don't block response)
  if (gclid && fetchGclidCost) {
    fetchGclidCost(gclid).then(cost => {
      if (cost) {
        db.prepare(`
          UPDATE leads SET cost_cents = ?, cost_currency = ?, cost_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(cost.cost_cents, cost.currency, result.lastInsertRowid);
        console.log(`Fetched cost for lead ${result.lastInsertRowid}: $${(cost.cost_cents/100).toFixed(2)}`);
      }
    }).catch(err => console.error('Failed to fetch GCLID cost:', err));
  }

  res.json({ success: true, id: result.lastInsertRowid });
});

// Get all leads (admin)
router.get('/', authenticateToken, (req, res) => {
  const { page = 1, limit = 50, search, landing_page_id, platform, from_date, to_date } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE 1=1
  `;
  let countQuery = `
    SELECT COUNT(*) as total FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (l.full_name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ?)`;
    countQuery += ` AND (l.full_name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (landing_page_id) {
    query += ` AND l.landing_page_id = ?`;
    countQuery += ` AND l.landing_page_id = ?`;
    params.push(landing_page_id);
  }

  if (platform) {
    query += ` AND lp.platform = ?`;
    countQuery += ` AND lp.platform = ?`;
    params.push(platform);
  }

  if (from_date) {
    query += ` AND l.created_at >= ?`;
    countQuery += ` AND l.created_at >= ?`;
    params.push(from_date);
  }

  if (to_date) {
    query += ` AND l.created_at <= ?`;
    countQuery += ` AND l.created_at <= ?`;
    params.push(to_date);
  }

  const total = db.prepare(countQuery).get(...params).total;

  query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
  const leads = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));

  // Parse hidden_fields JSON
  leads.forEach(lead => {
    try {
      lead.hidden_fields = JSON.parse(lead.hidden_fields || '{}');
    } catch (e) {
      lead.hidden_fields = {};
    }
  });

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// Get single lead
router.get('/:id', authenticateToken, (req, res) => {
  const lead = db.prepare(`
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE l.id = ?
  `).get(req.params.id);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  try {
    lead.hidden_fields = JSON.parse(lead.hidden_fields || '{}');
  } catch (e) {
    lead.hidden_fields = {};
  }

  res.json(lead);
});

// Delete lead
router.delete('/:id', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ message: 'Lead deleted' });
});

// Export leads to CSV
router.get('/export/csv', authenticateToken, (req, res) => {
  const { landing_page_id, from_date, to_date } = req.query;

  let query = `
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE 1=1
  `;
  const params = [];

  if (landing_page_id) {
    query += ` AND l.landing_page_id = ?`;
    params.push(landing_page_id);
  }

  if (from_date) {
    query += ` AND l.created_at >= ?`;
    params.push(from_date);
  }

  if (to_date) {
    query += ` AND l.created_at <= ?`;
    params.push(to_date);
  }

  query += ` ORDER BY l.created_at DESC`;

  const leads = db.prepare(query).all(...params);

  // Create CSV
  const headers = [
    'ID', 'Full Name', 'Company', 'Email', 'Phone', 'Debt Amount',
    'Has MCA', 'Considered Bankruptcy', 'GCLID', 'RT Click ID', 'Eli Click ID',
    'Cost', 'Landing Page', 'Traffic Source', 'Platform', 'Created At'
  ];

  const rows = leads.map(l => [
    l.id,
    l.full_name,
    l.company_name,
    l.email,
    l.phone,
    l.debt_amount,
    l.has_mca,
    l.considered_bankruptcy,
    l.gclid,
    l.rt_clickid,
    l.eli_clickid,
    l.cost_cents ? `$${(l.cost_cents/100).toFixed(2)}` : '',
    l.landing_page_name,
    l.traffic_source,
    l.platform,
    l.created_at
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.map(cell => `"${cell || ''}"`).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=leads-${Date.now()}.csv`);
  res.send(csv);
});

module.exports = router;
