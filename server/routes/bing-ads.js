const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import logActivity (loaded after initialization to avoid circular deps)
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Encryption key - reuse same pattern as google-ads.js
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

// Microsoft OAuth configuration
const BING_CLIENT_ID = process.env.BING_ADS_CLIENT_ID || '';
const BING_CLIENT_SECRET = process.env.BING_ADS_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.BING_ADS_REDIRECT_URI || 'http://localhost:3000/api/bing-ads/callback';

const SCOPES = [
  'https://ads.microsoft.com/msads.manage',
  'offline_access'
];

// Get connection status
router.get('/status', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT * FROM bing_ads_config WHERE id = 1').get();

  if (!config || !config.refresh_token_encrypted) {
    return res.json({ connected: false });
  }

  res.json({
    connected: true,
    account_id: config.account_id,
    customer_id: config.customer_id,
    account_name: config.account_name,
    uet_tag_id: config.uet_tag_id,
    connected_at: config.connected_at
  });
});

// Initiate OAuth flow
router.get('/connect', authenticateToken, (req, res) => {
  if (!BING_CLIENT_ID) {
    return res.status(500).json({ error: 'Bing Ads OAuth not configured. Set BING_ADS_CLIENT_ID environment variable.' });
  }

  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(BING_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    `&prompt=consent`;

  res.json({ auth_url: authUrl });
});

// OAuth callback
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/admin/settings.html?bing_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/admin/settings.html?bing_error=no_code');
  }

  try {
    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: BING_CLIENT_ID,
        client_secret: BING_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: SCOPES.join(' ')
      })
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      return res.redirect('/admin/settings.html?bing_error=' + encodeURIComponent(tokens.error_description || tokens.error));
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString();

    // Save tokens
    const existing = db.prepare('SELECT id FROM bing_ads_config WHERE id = 1').get();
    if (existing) {
      db.prepare(`
        UPDATE bing_ads_config SET
          access_token_encrypted = ?,
          refresh_token_encrypted = ?,
          token_expires_at = ?,
          connected_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(
        encrypt(tokens.access_token),
        encrypt(tokens.refresh_token),
        expiresAt
      );
    } else {
      db.prepare(`
        INSERT INTO bing_ads_config (id, access_token_encrypted, refresh_token_encrypted, token_expires_at, connected_at)
        VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        encrypt(tokens.access_token),
        encrypt(tokens.refresh_token),
        expiresAt
      );
    }

    if (logActivity) logActivity(null, 'System', 'connected', 'bing_ads', null, 'Bing Ads connected via OAuth', req.ip);
    res.redirect('/admin/settings.html?bing_connected=true');
  } catch (err) {
    console.error('Bing OAuth callback error:', err);
    res.redirect('/admin/settings.html?bing_error=token_exchange_failed');
  }
});

// Save account details
router.post('/select-account', authenticateToken, (req, res) => {
  const { account_id, customer_id, account_name } = req.body;

  if (!account_id || !customer_id) {
    return res.status(400).json({ error: 'Account ID and Customer ID required' });
  }

  const existing = db.prepare('SELECT id FROM bing_ads_config WHERE id = 1').get();
  if (existing) {
    db.prepare(`
      UPDATE bing_ads_config SET account_id = ?, customer_id = ?, account_name = ? WHERE id = 1
    `).run(account_id, customer_id, account_name || account_id);
  } else {
    db.prepare(`
      INSERT INTO bing_ads_config (id, account_id, customer_id, account_name) VALUES (1, ?, ?, ?)
    `).run(account_id, customer_id, account_name || account_id);
  }

  res.json({ message: 'Account saved' });
});

// Save UET Tag ID
router.post('/save-uet-tag', authenticateToken, (req, res) => {
  const { uet_tag_id } = req.body;

  const existing = db.prepare('SELECT id FROM bing_ads_config WHERE id = 1').get();
  if (existing) {
    db.prepare('UPDATE bing_ads_config SET uet_tag_id = ? WHERE id = 1').run(uet_tag_id || null);
  } else {
    db.prepare('INSERT INTO bing_ads_config (id, uet_tag_id) VALUES (1, ?)').run(uet_tag_id || null);
  }

  res.json({ message: 'UET Tag ID saved' });
});

// Disconnect
router.post('/disconnect', authenticateToken, (req, res) => {
  db.prepare(`
    UPDATE bing_ads_config SET
      access_token_encrypted = NULL,
      refresh_token_encrypted = NULL,
      token_expires_at = NULL,
      account_id = NULL,
      customer_id = NULL,
      account_name = NULL,
      uet_tag_id = NULL,
      connected_at = NULL
    WHERE id = 1
  `).run();

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'disconnected', 'bing_ads', null, 'Bing Ads disconnected', req.ip);
  res.json({ message: 'Disconnected' });
});

// Helper: Get valid access token (refresh if needed)
async function getValidAccessToken(config) {
  const expiresAt = new Date(config.token_expires_at);
  const now = new Date();

  // If token expires in less than 5 minutes, refresh it
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const refreshToken = decrypt(config.refresh_token_encrypted);

    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: BING_CLIENT_ID,
        client_secret: BING_CLIENT_SECRET,
        grant_type: 'refresh_token',
        scope: SCOPES.join(' ')
      })
    });

    const tokens = await response.json();

    if (tokens.access_token) {
      const newExpiresAt = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString();

      db.prepare(`
        UPDATE bing_ads_config SET
          access_token_encrypted = ?,
          token_expires_at = ?
        WHERE id = 1
      `).run(encrypt(tokens.access_token), newExpiresAt);

      // Update refresh token if a new one was provided
      if (tokens.refresh_token) {
        db.prepare(`
          UPDATE bing_ads_config SET refresh_token_encrypted = ? WHERE id = 1
        `).run(encrypt(tokens.refresh_token));
      }

      return tokens.access_token;
    }
  }

  return decrypt(config.access_token_encrypted);
}

// Upload offline conversion to Bing Ads
async function uploadBingConversion(msclkid, conversionGoalId, conversionTime, conversionValue, currencyCode) {
  const config = db.prepare('SELECT * FROM bing_ads_config WHERE id = 1').get();

  if (!config || !config.refresh_token_encrypted) {
    console.error('Bing Ads not configured');
    return { success: false, error: 'Bing Ads not configured' };
  }

  try {
    const accessToken = await getValidAccessToken(config);

    const conversion = {
      msclkid: msclkid,
      conversionName: conversionGoalId,
      conversionTime: conversionTime || new Date().toISOString()
    };

    if (conversionValue) {
      conversion.conversionValue = conversionValue;
      conversion.conversionCurrency = currencyCode || 'USD';
    }

    const response = await fetch(
      'https://bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'CustomerAccountId': config.account_id || '',
          'CustomerId': config.customer_id || '',
          'DeveloperToken': process.env.BING_ADS_DEVELOPER_TOKEN || ''
        },
        body: JSON.stringify({
          OfflineConversions: [conversion]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Bing Ads conversion upload error:', data);
      return { success: false, error: data.Message || JSON.stringify(data) };
    }

    console.log('Bing conversion uploaded successfully for msclkid:', msclkid);
    return { success: true, data };
  } catch (err) {
    console.error('Error uploading Bing conversion:', err);
    return { success: false, error: err.message };
  }
}

module.exports = router;
module.exports.uploadBingConversion = uploadBingConversion;
