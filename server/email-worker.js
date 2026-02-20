const db = require('./database');
const { createTransporter, getSmtpConfig } = require('./lib/smtp');
const { resolveVariables, getSegmentLeadQuery } = require('./routes/email-marketing');
const { generateToken, generateClickToken } = require('./routes/email-tracking');

let workerInterval = null;
let schedulerInterval = null;

function getSetting(key, defaultValue) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function getBaseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function stripHtml(html) {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Rewrite <a href> URLs with click tracking
function rewriteLinks(html, queueId) {
  return html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*?)>/gi, (match, before, url, after) => {
    // Skip mailto, tel, and unsubscribe links
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.includes('unsubscribe')) {
      return match;
    }
    const token = generateClickToken(queueId, url);
    const trackUrl = `${getBaseUrl()}/t/c/${token}`;
    return `<a ${before}href="${trackUrl}"${after}>`;
  });
}

// Add open tracking pixel before </body>
function addOpenPixel(html, queueId) {
  const token = generateToken(queueId);
  const pixelUrl = `${getBaseUrl()}/t/o/${token}.gif`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">`;

  if (html.includes('</body>')) {
    return html.replace('</body>', pixel + '</body>');
  }
  return html + pixel;
}

// Add CAN-SPAM unsubscribe footer if not already present
function addUnsubscribeFooter(html, queueId) {
  if (html.includes('{{unsubscribe_url}}') || html.includes('/t/u/')) {
    return html; // Template already has unsubscribe link
  }

  const token = generateToken(queueId);
  const unsubUrl = `${getBaseUrl()}/t/u/${token}`;
  const address = getSetting('email_physical_address', '');

  const footer = `
<div style="margin-top:30px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center;">
  <p>You are receiving this email because you submitted a form on our website.</p>
  ${address ? `<p>${address}</p>` : ''}
  <p><a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe</a></p>
</div>`;

  if (html.includes('</body>')) {
    return html.replace('</body>', footer + '</body>');
  }
  return html + footer;
}

// Enqueue a campaign - resolve segment, render templates, insert into queue
function enqueueCampaign(campaignId) {
  const campaign = db.prepare(`
    SELECT c.*, t.subject, t.html_body, t.text_body
    FROM email_campaigns c
    JOIN email_templates t ON c.template_id = t.id
    WHERE c.id = ?
  `).get(campaignId);

  if (!campaign) {
    console.error(`Campaign ${campaignId} not found`);
    return 0;
  }

  // Get leads from segment
  let leads;
  if (campaign.segment_id) {
    const segment = db.prepare('SELECT filter_criteria FROM email_segments WHERE id = ?').get(campaign.segment_id);
    if (!segment) {
      console.error(`Segment ${campaign.segment_id} not found`);
      return 0;
    }
    const { sql, params } = getSegmentLeadQuery(segment.filter_criteria);
    leads = db.prepare(sql).all(...params);
  } else {
    // No segment - send to all leads with email
    leads = db.prepare(`
      SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone, l.debt_amount,
             l.stage, l.created_at, lp.name as landing_page_name, lp.platform
      FROM leads l
      LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      WHERE l.email IS NOT NULL AND l.email != '' AND COALESCE(l.email_unsubscribed, 0) = 0
    `).all();
  }

  if (leads.length === 0) {
    db.prepare(`UPDATE email_campaigns SET status = 'sent', total_recipients = 0, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(campaignId);
    return 0;
  }

  const subject = campaign.subject_override || campaign.subject;
  const baseUrl = getBaseUrl();

  const insertQueue = db.prepare(`
    INSERT INTO email_queue (campaign_id, lead_id, to_email, to_name, subject, html_body, text_body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const enqueue = db.transaction(() => {
    let count = 0;
    for (const lead of leads) {
      if (!lead.email) continue;

      // Create a placeholder queue entry to get the ID first
      const result = insertQueue.run(
        campaignId, lead.id, lead.email, [lead.first_name, lead.last_name].filter(Boolean).join(' ') || '',
        'pending', 'pending', null
      );
      const queueId = result.lastInsertRowid;

      // Generate unsubscribe URL with queue ID
      const unsubToken = generateToken(queueId);
      const unsubUrl = `${baseUrl}/t/u/${unsubToken}`;

      // Resolve variables
      const resolvedSubject = resolveVariables(subject, lead, { unsubscribe_url: unsubUrl });
      let resolvedHtml = resolveVariables(campaign.html_body, lead, {
        unsubscribe_url: unsubUrl,
        platform: lead.platform,
        landing_page: lead.landing_page_name
      });

      // Add tracking
      resolvedHtml = addUnsubscribeFooter(resolvedHtml, queueId);
      resolvedHtml = rewriteLinks(resolvedHtml, queueId);
      resolvedHtml = addOpenPixel(resolvedHtml, queueId);

      const resolvedText = campaign.text_body
        ? resolveVariables(campaign.text_body, lead, { unsubscribe_url: unsubUrl })
        : stripHtml(resolvedHtml);

      // Update with rendered content
      db.prepare(`UPDATE email_queue SET subject = ?, html_body = ?, text_body = ? WHERE id = ?`)
        .run(resolvedSubject, resolvedHtml, resolvedText, queueId);

      count++;
    }

    db.prepare(`UPDATE email_campaigns SET total_recipients = ? WHERE id = ?`).run(count, campaignId);
    return count;
  });

  const count = enqueue();
  console.log(`Enqueued ${count} emails for campaign "${campaign.name}" (#${campaignId})`);
  return count;
}

// Process queued emails
async function processQueue() {
  const enabled = getSetting('email_worker_enabled', '1');
  if (enabled !== '1') return;

  const rateLimit = parseInt(getSetting('email_rate_limit', '10'));
  const batchSize = Math.ceil(rateLimit / 6); // emails per 10-second tick

  // Check for campaigns that need enqueueing (status = 'sending' but no queued emails)
  const sendingCampaigns = db.prepare(`
    SELECT c.id FROM email_campaigns c
    WHERE c.status = 'sending'
    AND NOT EXISTS (SELECT 1 FROM email_queue eq WHERE eq.campaign_id = c.id)
  `).all();

  for (const c of sendingCampaigns) {
    enqueueCampaign(c.id);
  }

  // Get queued emails
  const items = db.prepare(`
    SELECT eq.* FROM email_queue eq
    JOIN email_campaigns ec ON eq.campaign_id = ec.id
    WHERE eq.status = 'queued' AND ec.status = 'sending'
    ORDER BY eq.id ASC
    LIMIT ?
  `).all(batchSize);

  // Also get non-campaign queued items (from flows, etc.)
  const flowItems = db.prepare(`
    SELECT * FROM email_queue
    WHERE status = 'queued' AND campaign_id IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(batchSize);

  const allItems = [...items, ...flowItems];
  if (allItems.length === 0) return;

  const transporter = createTransporter();
  if (!transporter) {
    console.error('Email worker: SMTP not configured');
    return;
  }

  const smtpConfig = getSmtpConfig();
  const fromName = getSetting('email_from_name', 'Coastal Debt');
  const from = `${fromName} <${smtpConfig.smtp_from || smtpConfig.smtp_user}>`;

  for (const item of allItems) {
    try {
      // Mark as sending
      db.prepare(`UPDATE email_queue SET status = 'sending' WHERE id = ?`).run(item.id);

      const result = await transporter.sendMail({
        from,
        to: item.to_name ? `${item.to_name} <${item.to_email}>` : item.to_email,
        subject: item.subject,
        html: item.html_body,
        text: item.text_body || undefined
      });

      // Mark as sent
      db.prepare(`
        UPDATE email_queue SET status = 'sent', message_id = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(result.messageId || null, item.id);

      // Increment campaign sent_count
      if (item.campaign_id) {
        db.prepare('UPDATE email_campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(item.campaign_id);
      }
    } catch (err) {
      console.error(`Email worker: failed to send queue #${item.id}:`, err.message);

      const isBounce = err.message.includes('550') || err.message.includes('553') || err.message.includes('mailbox');
      db.prepare(`
        UPDATE email_queue SET status = ?, error_message = ? WHERE id = ?
      `).run(isBounce ? 'bounced' : 'failed', err.message, item.id);

      if (item.campaign_id) {
        if (isBounce) {
          db.prepare('UPDATE email_campaigns SET bounce_count = bounce_count + 1 WHERE id = ?').run(item.campaign_id);
        } else {
          db.prepare('UPDATE email_campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(item.campaign_id);
        }
      }
    }
  }

  // Check if any sending campaigns are now complete
  const activeCampaigns = db.prepare(`SELECT id FROM email_campaigns WHERE status = 'sending'`).all();
  for (const c of activeCampaigns) {
    const remaining = db.prepare(`SELECT COUNT(*) as cnt FROM email_queue WHERE campaign_id = ? AND status IN ('queued', 'sending')`).get(c.id);
    if (remaining.cnt === 0) {
      db.prepare(`UPDATE email_campaigns SET status = 'sent', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
      console.log(`Campaign #${c.id} completed`);
    }
  }
}

// Check for scheduled campaigns
function checkScheduledCampaigns() {
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const scheduled = db.prepare(`
    SELECT id, name FROM email_campaigns
    WHERE status = 'scheduled' AND scheduled_at <= ?
  `).all(now);

  for (const campaign of scheduled) {
    console.log(`Starting scheduled campaign "${campaign.name}" (#${campaign.id})`);
    db.prepare(`UPDATE email_campaigns SET status = 'sending', started_at = CURRENT_TIMESTAMP WHERE id = ?`).run(campaign.id);
    enqueueCampaign(campaign.id);
  }
}

function startWorker() {
  console.log('Email worker started');

  // Process queue every 10 seconds
  workerInterval = setInterval(() => {
    processQueue().catch(err => console.error('Email worker error:', err.message));
  }, 10000);

  // Check scheduled campaigns every 60 seconds
  schedulerInterval = setInterval(checkScheduledCampaigns, 60000);

  // Initial check after 5 seconds
  setTimeout(() => {
    checkScheduledCampaigns();
    processQueue().catch(err => console.error('Email worker error:', err.message));
  }, 5000);
}

function stopWorker() {
  if (workerInterval) clearInterval(workerInterval);
  if (schedulerInterval) clearInterval(schedulerInterval);
  console.log('Email worker stopped');
}

module.exports = { startWorker, stopWorker, enqueueCampaign };
