const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Lazy-loaded to avoid circular deps
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Encryption (AES-256-CBC, same pattern as google-ads.js)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'coastal-debt-cms-encryption-key-32';
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

// --- Token management ---

async function getValidAccessToken(config) {
  if (!config.access_token_encrypted || !config.refresh_token_encrypted) {
    return null;
  }

  const expiresAt = config.token_expires_at ? new Date(config.token_expires_at) : new Date(0);
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (expiresAt > fiveMinFromNow) {
    return decrypt(config.access_token_encrypted);
  }

  // Token expired or expiring soon — refresh
  const refreshToken = decrypt(config.refresh_token_encrypted);
  const clientId = config.client_id;
  const clientSecret = decrypt(config.client_secret_encrypted);

  if (!refreshToken || !clientId || !clientSecret) return null;

  try {
    const res = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    });

    const data = await res.json();
    if (!res.ok || !data.access_token) {
      console.error('Salesforce token refresh failed:', data);
      return null;
    }

    // Update stored tokens
    const newExpires = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare(`
      UPDATE salesforce_config SET
        access_token_encrypted = ?,
        instance_url = COALESCE(?, instance_url),
        token_expires_at = ?
      WHERE id = 1
    `).run(encrypt(data.access_token), data.instance_url || null, newExpires);

    return data.access_token;
  } catch (err) {
    console.error('Salesforce token refresh error:', err);
    return null;
  }
}

// --- Push lead to Salesforce ---

async function pushLeadToSalesforce(leadId) {
  const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
  if (!config || !config.is_enabled || !config.access_token_encrypted) return;

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return;
  if (lead.salesforce_lead_id) return; // Already pushed

  const accessToken = await getValidAccessToken(config);
  if (!accessToken) {
    console.error('Salesforce: no valid access token, skipping push for lead', leadId);
    return;
  }

  // Build description from extra fields
  const descParts = [];
  if (lead.debt_amount) descParts.push(`Debt Amount: ${lead.debt_amount}`);
  if (lead.has_mca) descParts.push(`MCA: ${lead.has_mca}`);
  if (lead.eli_clickid) descParts.push(`Click ID: ${lead.eli_clickid}`);
  try {
    const page = db.prepare('SELECT platform, name FROM landing_pages WHERE id = ?').get(lead.landing_page_id);
    if (page) descParts.push(`Platform: ${page.platform || 'unknown'}`, `Landing Page: ${page.name || ''}`);
  } catch (e) {}

  const lastName = lead.last_name || lead.first_name || lead.full_name || 'Unknown';
  const company = lead.company_name || '[Not Provided]';

  const sfLead = {
    FirstName: lead.first_name || '',
    LastName: lastName,
    Email: lead.email || '',
    Phone: lead.phone || '',
    Company: company,
    LeadSource: 'Web',
    Description: descParts.join('\n') || undefined
  };

  // Remove undefined/empty optional fields
  if (!sfLead.FirstName) delete sfLead.FirstName;
  if (!sfLead.Email) delete sfLead.Email;
  if (!sfLead.Phone) delete sfLead.Phone;
  if (!sfLead.Description) delete sfLead.Description;

  try {
    const res = await fetch(`${config.instance_url}/services/data/v59.0/sobjects/Lead`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sfLead)
    });

    const data = await res.json();
    if (data.success && data.id) {
      db.prepare('UPDATE leads SET salesforce_lead_id = ? WHERE id = ?').run(data.id, leadId);
      console.log(`Salesforce: pushed lead ${leadId} → SF ID ${data.id}`);
    } else {
      console.error(`Salesforce: failed to push lead ${leadId}:`, JSON.stringify(data));
    }
  } catch (err) {
    console.error(`Salesforce: network error pushing lead ${leadId}:`, err.message);
  }
}

// --- Routes ---

// GET /config — return config with masked secrets
router.get('/config', authenticateToken, (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
    if (!config) return res.json({});

    res.json({
      client_id: config.client_id || '',
      client_secret: config.client_secret_encrypted ? '.....' + (decrypt(config.client_secret_encrypted) || '').slice(-4) : '',
      has_client_secret: !!config.client_secret_encrypted,
      is_enabled: config.is_enabled,
      is_connected: !!(config.access_token_encrypted && config.instance_url),
      instance_url: config.instance_url || '',
      connected_at: config.connected_at || '',
      token_expires_at: config.token_expires_at || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /config — save client_id, client_secret, is_enabled
router.post('/config', authenticateToken, (req, res) => {
  try {
    const { client_id, client_secret, is_enabled } = req.body;
    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();

    let secretEncrypted = config.client_secret_encrypted;
    if (client_secret && !client_secret.startsWith('.....')) {
      secretEncrypted = encrypt(client_secret);
    }

    db.prepare(`
      UPDATE salesforce_config SET
        client_id = ?,
        client_secret_encrypted = ?,
        is_enabled = ?
      WHERE id = 1
    `).run(client_id || '', secretEncrypted, is_enabled !== undefined ? (is_enabled ? 1 : 0) : config.is_enabled);

    if (logActivity) logActivity(req.user?.id, 'salesforce_config_updated', 'Salesforce configuration updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /status — connection status
router.get('/status', authenticateToken, (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
    res.json({
      connected: !!(config?.access_token_encrypted && config?.instance_url),
      enabled: !!config?.is_enabled,
      instance_url: config?.instance_url || '',
      connected_at: config?.connected_at || '',
      has_credentials: !!(config?.client_id && config?.client_secret_encrypted)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /connect — generate OAuth URL
router.get('/connect', authenticateToken, (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
    if (!config?.client_id || !config?.client_secret_encrypted) {
      return res.status(400).json({ error: 'Save Client ID and Client Secret first' });
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${baseUrl}/api/salesforce/callback`;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.client_id,
      redirect_uri: redirectUri,
      scope: 'api refresh_token',
      prompt: 'login consent'
    });

    res.json({ url: `https://login.salesforce.com/services/oauth2/authorize?${params}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /callback — OAuth callback (no auth required — redirected from Salesforce)
router.get('/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      return res.redirect(`/admin/settings.html?sf_error=${encodeURIComponent(error_description || error)}`);
    }
    if (!code) {
      return res.redirect('/admin/settings.html?sf_error=No+authorization+code+received');
    }

    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
    if (!config?.client_id || !config?.client_secret_encrypted) {
      return res.redirect('/admin/settings.html?sf_error=Salesforce+not+configured');
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${baseUrl}/api/salesforce/callback`;
    const clientSecret = decrypt(config.client_secret_encrypted);

    const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.client_id,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      })
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) {
      const errMsg = data.error_description || data.error || 'Token exchange failed';
      return res.redirect(`/admin/settings.html?sf_error=${encodeURIComponent(errMsg)}`);
    }

    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare(`
      UPDATE salesforce_config SET
        access_token_encrypted = ?,
        refresh_token_encrypted = ?,
        instance_url = ?,
        token_expires_at = ?,
        connected_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(
      encrypt(data.access_token),
      data.refresh_token ? encrypt(data.refresh_token) : config.refresh_token_encrypted,
      data.instance_url,
      expiresAt
    );

    res.redirect('/admin/settings.html?sf_connected=true');
  } catch (err) {
    console.error('Salesforce callback error:', err);
    res.redirect(`/admin/settings.html?sf_error=${encodeURIComponent(err.message)}`);
  }
});

// POST /disconnect — clear tokens
router.post('/disconnect', authenticateToken, (req, res) => {
  try {
    db.prepare(`
      UPDATE salesforce_config SET
        access_token_encrypted = NULL,
        refresh_token_encrypted = NULL,
        instance_url = NULL,
        token_expires_at = NULL,
        connected_at = NULL
      WHERE id = 1
    `).run();

    if (logActivity) logActivity(req.user?.id, 'salesforce_disconnected', 'Salesforce disconnected');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /test — test connection
router.post('/test', authenticateToken, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
    if (!config?.access_token_encrypted || !config?.instance_url) {
      return res.status(400).json({ error: 'Not connected to Salesforce' });
    }

    const accessToken = await getValidAccessToken(config);
    if (!accessToken) {
      return res.status(400).json({ error: 'Failed to get valid access token' });
    }

    const testRes = await fetch(`${config.instance_url}/services/data/v59.0/sobjects/Lead/describe`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (testRes.ok) {
      res.json({ success: true, message: 'Connected — Lead object is accessible' });
    } else {
      const errData = await testRes.json().catch(() => ({}));
      res.status(400).json({ error: errData[0]?.message || `Salesforce API returned ${testRes.status}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push/:leadId — manual push single lead
router.post('/push/:leadId', authenticateToken, async (req, res) => {
  try {
    const lead = db.prepare('SELECT id, salesforce_lead_id FROM leads WHERE id = ?').get(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.salesforce_lead_id) return res.json({ success: true, message: 'Already pushed', salesforce_lead_id: lead.salesforce_lead_id });

    await pushLeadToSalesforce(lead.id);

    const updated = db.prepare('SELECT salesforce_lead_id FROM leads WHERE id = ?').get(lead.id);
    if (updated?.salesforce_lead_id) {
      res.json({ success: true, salesforce_lead_id: updated.salesforce_lead_id });
    } else {
      res.status(500).json({ error: 'Push failed — check server logs' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push-all — bulk push leads missing salesforce_lead_id
router.post('/push-all', authenticateToken, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM salesforce_config WHERE id = 1').get();
    if (!config?.access_token_encrypted || !config?.instance_url) {
      return res.status(400).json({ error: 'Not connected to Salesforce' });
    }

    const leads = db.prepare('SELECT id FROM leads WHERE salesforce_lead_id IS NULL AND is_blocked = 0 ORDER BY id DESC LIMIT 100').all();
    if (leads.length === 0) {
      return res.json({ success: true, pushed: 0, failed: 0, message: 'No unpushed leads found' });
    }

    let pushed = 0, failed = 0;
    for (const lead of leads) {
      try {
        await pushLeadToSalesforce(lead.id);
        const updated = db.prepare('SELECT salesforce_lead_id FROM leads WHERE id = ?').get(lead.id);
        if (updated?.salesforce_lead_id) pushed++;
        else failed++;
      } catch (e) {
        failed++;
      }
    }

    res.json({ success: true, pushed, failed, total: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.pushLeadToSalesforce = pushLeadToSalesforce;
