const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

// Use persistent volume on Railway (/data), fallback to local data/ directory
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'cms.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'editor' CHECK(role IN ('admin', 'editor', 'viewer')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS landing_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    platform TEXT DEFAULT 'other' CHECK(platform IN ('google', 'meta', 'tiktok', 'linkedin', 'bing', 'outbrain', 'reddit', 'other')),
    traffic_source TEXT,
    webhook_url TEXT,
    form_id INTEGER,
    content TEXT DEFAULT '{}',
    sections_visible TEXT DEFAULT '{}',
    hidden_fields TEXT DEFAULT '{}',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (form_id) REFERENCES forms(id)
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    landing_page_id INTEGER,
    full_name TEXT,
    company_name TEXT,
    email TEXT,
    phone TEXT,
    debt_amount TEXT,
    has_mca TEXT,
    considered_bankruptcy TEXT,
    gclid TEXT,
    rt_clickid TEXT,
    eli_clickid TEXT,
    hidden_fields TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (landing_page_id) REFERENCES landing_pages(id)
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'analytics' CHECK(type IN ('analytics', 'pixel', 'conversion', 'other')),
    code TEXT NOT NULL,
    position TEXT DEFAULT 'head' CHECK(position IN ('head', 'body_start', 'body_end')),
    landing_page_ids TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT DEFAULT 'other' CHECK(platform IN ('google', 'meta', 'tiktok', 'bing', 'outbrain', 'linkedin', 'reddit', 'other')),
    webhook_url TEXT,
    fields TEXT DEFAULT '[]',
    submit_button_text TEXT DEFAULT 'Submit',
    success_message TEXT DEFAULT 'Thank you! We will contact you shortly.',
    is_active INTEGER DEFAULT 1,
    skip_pre_qual INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eli_clickid TEXT UNIQUE,
    gclid TEXT,
    rt_clickid TEXT,
    ip_address TEXT,
    city TEXT,
    region TEXT,
    country TEXT,
    timezone TEXT,
    isp TEXT,
    user_agent TEXT,
    browser TEXT,
    browser_version TEXT,
    os TEXT,
    os_version TEXT,
    device_type TEXT,
    screen_width INTEGER,
    screen_height INTEGER,
    language TEXT,
    referrer_url TEXT,
    landing_page TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    converted INTEGER DEFAULT 0,
    lead_id INTEGER,
    first_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
    visit_count INTEGER DEFAULT 1,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE INDEX IF NOT EXISTS idx_leads_landing_page ON leads(landing_page_id);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
  CREATE INDEX IF NOT EXISTS idx_pages_slug ON landing_pages(slug);
  CREATE INDEX IF NOT EXISTS idx_visitors_eli ON visitors(eli_clickid);
  CREATE INDEX IF NOT EXISTS idx_visitors_converted ON visitors(converted);

  CREATE TABLE IF NOT EXISTS google_ads_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    developer_token_encrypted TEXT,
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expires_at DATETIME,
    customer_id TEXT,
    account_name TEXT,
    connected_at DATETIME,
    connected_by_user_id INTEGER,
    FOREIGN KEY (connected_by_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS conversion_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    gclid TEXT,
    eli_clickid TEXT,
    conversion_action_id TEXT,
    conversion_action_name TEXT,
    conversion_value REAL,
    source TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS postback_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_name TEXT NOT NULL,
    conversion_action_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_conversion_eli ON conversion_events(eli_clickid);
  CREATE INDEX IF NOT EXISTS idx_conversion_gclid ON conversion_events(gclid);

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_name TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
`);

// Create bing_ads_config table
db.exec(`
  CREATE TABLE IF NOT EXISTS bing_ads_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expires_at DATETIME,
    account_id TEXT,
    customer_id TEXT,
    account_name TEXT,
    uet_tag_id TEXT,
    connected_at DATETIME,
    connected_by_user_id INTEGER,
    FOREIGN KEY (connected_by_user_id) REFERENCES users(id)
  )
`);

// Add msclkid to leads, visitors, conversion_events if not exist
try { db.exec(`ALTER TABLE leads ADD COLUMN msclkid TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE visitors ADD COLUMN msclkid TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE conversion_events ADD COLUMN msclkid TEXT`); } catch (e) {}

// Add Bing fields to postback_config if not exist
try { db.exec(`ALTER TABLE postback_config ADD COLUMN bing_conversion_goal_id TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE postback_config ADD COLUMN send_to_bing INTEGER DEFAULT 0`); } catch (e) {}

// Add cost columns to leads table if not exist
try {
  db.exec(`ALTER TABLE leads ADD COLUMN cost_cents INTEGER`);
} catch (e) {} // Column already exists
try {
  db.exec(`ALTER TABLE leads ADD COLUMN cost_currency TEXT DEFAULT 'USD'`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE leads ADD COLUMN cost_fetched_at DATETIME`);
} catch (e) {}

// Add google_ads_event_name to postback_config if not exist
try {
  db.exec(`ALTER TABLE postback_config ADD COLUMN google_ads_event_name TEXT`);
} catch (e) {}

// Add send_to_facebook to postback_config if not exist
try {
  db.exec(`ALTER TABLE postback_config ADD COLUMN send_to_facebook INTEGER DEFAULT 0`);
} catch (e) {}

// Add facebook_event_name to postback_config if not exist
try { db.exec(`ALTER TABLE postback_config ADD COLUMN facebook_event_name TEXT`); } catch (e) {}

// Migrate existing rows with send_to_facebook = 1 but no facebook_event_name
try {
  const INTERNAL_TO_FB = { lead: 'Lead', qualified: 'Lead', appointment: 'Schedule',
    contract_signed: 'CompleteRegistration', sale: 'Purchase', closed: 'Purchase' };
  const fbRows = db.prepare(`SELECT id, event_name FROM postback_config WHERE send_to_facebook = 1 AND (facebook_event_name IS NULL OR facebook_event_name = '')`).all();
  for (const row of fbRows) {
    const fbName = INTERNAL_TO_FB[row.event_name] || 'Lead';
    db.prepare(`UPDATE postback_config SET facebook_event_name = ? WHERE id = ?`).run(fbName, row.id);
  }
  if (fbRows.length > 0) console.log(`Migrated ${fbRows.length} postback configs to facebook_event_name`);
} catch (e) { console.error('facebook_event_name migration error:', e.message); }

// Add debt_amount and revenue to conversion_events if not exist
try {
  db.exec(`ALTER TABLE conversion_events ADD COLUMN debt_amount REAL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE conversion_events ADD COLUMN revenue REAL`);
} catch (e) {}

// Add capi_payload to conversion_events for Facebook debug
try { db.exec(`ALTER TABLE conversion_events ADD COLUMN capi_payload TEXT`); } catch (e) {}

// Add first_name, last_name columns to leads table
try { db.exec(`ALTER TABLE leads ADD COLUMN first_name TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN last_name TEXT DEFAULT ''`); } catch (e) {}

// Migrate existing leads: split full_name into first_name/last_name
try {
  const unmigrated = db.prepare(`SELECT id, full_name FROM leads WHERE first_name = '' AND full_name != '' AND full_name IS NOT NULL`).all();
  for (const lead of unmigrated) {
    const parts = (lead.full_name || '').trim().split(/\s+/);
    db.prepare('UPDATE leads SET first_name = ?, last_name = ? WHERE id = ?')
      .run(parts[0] || '', parts.slice(1).join(' ') || '', lead.id);
  }
  if (unmigrated.length) console.log(`Migrated ${unmigrated.length} leads to first_name/last_name`);
} catch (e) { console.error('Name migration error:', e.message); }

// Add fbclid to leads table for Facebook attribution
try { db.exec(`ALTER TABLE leads ADD COLUMN fbclid TEXT DEFAULT ''`); } catch (e) {}

// Add Facebook tracking columns to visitors table
try { db.exec(`ALTER TABLE visitors ADD COLUMN fbclid TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE visitors ADD COLUMN fbc TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE visitors ADD COLUMN fbp TEXT DEFAULT ''`); } catch (e) {}

// Create facebook_config table (must be before ALTER TABLE statements below)
db.exec(`
  CREATE TABLE IF NOT EXISTS facebook_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    page_access_token TEXT,
    verify_token TEXT,
    app_id TEXT,
    app_secret TEXT,
    default_landing_page_id INTEGER,
    connected_at DATETIME,
    FOREIGN KEY (default_landing_page_id) REFERENCES landing_pages(id)
  )
`);

// Create tiktok_config table (singleton pattern matching facebook_config)
db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT,
    advertiser_id TEXT,
    default_landing_page_id INTEGER,
    connected_at DATETIME,
    FOREIGN KEY (default_landing_page_id) REFERENCES landing_pages(id)
  )
`);

// Add app_id and app_secret to tiktok_config (for OAuth flow)
try { db.exec(`ALTER TABLE tiktok_config ADD COLUMN app_id TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE tiktok_config ADD COLUMN app_secret TEXT`); } catch (e) {}

// Add test_event_code to facebook_config
try { db.exec(`ALTER TABLE facebook_config ADD COLUMN test_event_code TEXT`); } catch (e) {}

// Add user_access_token to facebook_config (for multi-page sync)
try { db.exec(`ALTER TABLE facebook_config ADD COLUMN user_access_token TEXT`); } catch (e) {}

// Add Salesforce tracking columns to leads table
try { db.exec(`ALTER TABLE leads ADD COLUMN transfer_status TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN five9_dispo TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN stage TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN contract_sign_date TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN total_debt_sign TEXT`); } catch (e) {}

// Add permissions column to users if not exist
try { db.exec(`ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'`); } catch (e) {}

// Form: skip pre-qualification steps (debt amount + MCA question)
try { db.exec(`ALTER TABLE forms ADD COLUMN skip_pre_qual INTEGER DEFAULT 0`); } catch (e) {}

// CRM + Email Marketing columns on leads
try { db.exec(`ALTER TABLE leads ADD COLUMN email_unsubscribed INTEGER DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN assigned_to INTEGER`); } catch (e) {}

// CRM: Lead Notes
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id);
`);

// CRM: Lead Tasks
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date DATE,
    assignee_id INTEGER,
    assignee_name TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'done')),
    created_by_id INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (assignee_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks(lead_id);
  CREATE INDEX IF NOT EXISTS idx_lead_tasks_assignee ON lead_tasks(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_lead_tasks_due ON lead_tasks(due_date);
`);

// Email Templates
db.exec(`
  CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT,
    created_by_id INTEGER,
    created_by_name TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_id) REFERENCES users(id)
  );
`);

// Email Segments
db.exec(`
  CREATE TABLE IF NOT EXISTS email_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    filter_criteria TEXT NOT NULL DEFAULT '{}',
    created_by_id INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_id) REFERENCES users(id)
  );
`);

// Email Campaigns
db.exec(`
  CREATE TABLE IF NOT EXISTS email_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    template_id INTEGER NOT NULL,
    segment_id INTEGER,
    subject_override TEXT,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','sent','paused','cancelled')),
    scheduled_at DATETIME,
    started_at DATETIME,
    completed_at DATETIME,
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    open_count INTEGER DEFAULT 0,
    click_count INTEGER DEFAULT 0,
    unsubscribe_count INTEGER DEFAULT 0,
    bounce_count INTEGER DEFAULT 0,
    created_by_id INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES email_templates(id),
    FOREIGN KEY (segment_id) REFERENCES email_segments(id)
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_status ON email_campaigns(status);
`);

// Email Send Queue
db.exec(`
  CREATE TABLE IF NOT EXISTS email_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    lead_id INTEGER NOT NULL,
    to_email TEXT NOT NULL,
    to_name TEXT,
    subject TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','bounced')),
    error_message TEXT,
    message_id TEXT,
    queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME,
    opened_at DATETIME,
    clicked_at DATETIME,
    open_count INTEGER DEFAULT 0,
    click_count INTEGER DEFAULT 0,
    flow_run_id INTEGER,
    FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id),
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
  CREATE INDEX IF NOT EXISTS idx_queue_campaign ON email_queue(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_queue_status ON email_queue(status);
  CREATE INDEX IF NOT EXISTS idx_queue_lead ON email_queue(lead_id);
`);

// Email Click Tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS email_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL,
    campaign_id INTEGER,
    lead_id INTEGER NOT NULL,
    original_url TEXT NOT NULL,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY (queue_id) REFERENCES email_queue(id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_clicks_queue ON email_clicks(queue_id);
  CREATE INDEX IF NOT EXISTS idx_email_clicks_campaign ON email_clicks(campaign_id);
`);

// Email Open Tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS email_opens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL,
    campaign_id INTEGER,
    lead_id INTEGER NOT NULL,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY (queue_id) REFERENCES email_queue(id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_opens_queue ON email_opens(queue_id);
  CREATE INDEX IF NOT EXISTS idx_email_opens_campaign ON email_opens(campaign_id);
`);

// Email Unsubscribes
db.exec(`
  CREATE TABLE IF NOT EXISTS email_unsubscribes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    email TEXT NOT NULL,
    campaign_id INTEGER,
    reason TEXT,
    unsubscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
  CREATE INDEX IF NOT EXISTS idx_unsubscribes_email ON email_unsubscribes(email);
`);

// Phase 2 placeholders
db.exec(`
  CREATE TABLE IF NOT EXISTS automation_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('event','scheduled','segment_entry','manual')),
    trigger_config TEXT DEFAULT '{}',
    is_active INTEGER DEFAULT 0,
    created_by_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS automation_flow_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('send_email','send_sms','wait','condition','update_lead','add_note','assign')),
    action_config TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (flow_id) REFERENCES automation_flows(id)
  );

  CREATE TABLE IF NOT EXISTS automation_flow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    current_step_id INTEGER,
    status TEXT DEFAULT 'running' CHECK(status IN ('running','waiting','completed','failed','cancelled')),
    next_action_at DATETIME,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (flow_id) REFERENCES automation_flows(id),
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
  CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON automation_flow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_flow_runs_next ON automation_flow_runs(next_action_at);

  CREATE TABLE IF NOT EXISTS sms_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    to_phone TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','delivered','failed')),
    twilio_sid TEXT,
    error_message TEXT,
    direction TEXT DEFAULT 'outbound' CHECK(direction IN ('outbound','inbound')),
    campaign_id INTEGER,
    flow_run_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
  CREATE INDEX IF NOT EXISTS idx_sms_lead ON sms_messages(lead_id);
`);

// Add pixel_id to facebook_config if not exist
try {
  db.exec(`ALTER TABLE facebook_config ADD COLUMN pixel_id TEXT`);
} catch (e) {}

// Add ad_account_id to facebook_config if not exist
try {
  db.exec(`ALTER TABLE facebook_config ADD COLUMN ad_account_id TEXT`);
} catch (e) {}

// Add login_customer_id (MCC ID) to google_ads_config for manager account access
try {
  db.exec(`ALTER TABLE google_ads_config ADD COLUMN login_customer_id TEXT`);
} catch (e) {}

// Notification and alert tables
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    email_recipients TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    metric TEXT NOT NULL,
    condition TEXT NOT NULL,
    threshold REAL NOT NULL,
    time_window_hours INTEGER NOT NULL DEFAULT 24,
    secondary_metric TEXT,
    secondary_condition TEXT,
    secondary_threshold REAL,
    notify_email INTEGER DEFAULT 1,
    email_recipients TEXT,
    last_triggered_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inbound_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'facebook',
    api_key TEXT NOT NULL,
    landing_page_id INTEGER,
    is_active INTEGER DEFAULT 1,
    field_mapping TEXT DEFAULT '{}',
    leads_received INTEGER DEFAULT 0,
    last_received_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create default admin user if none exists
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const passwordHash = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO users (email, password_hash, name, role)
    VALUES (?, ?, ?, ?)
  `).run('admin@coastaldebt.com', passwordHash, 'Admin', 'admin');
  console.log('Default admin user created: admin@coastaldebt.com / admin123');
}

// Seed default form and landing pages if none exist
const formCount = db.prepare('SELECT COUNT(*) as count FROM forms').get();
if (formCount.count === 0) {
  const formFields = JSON.stringify([
    {"name":"first_name","label":"First Name","type":"text","placeholder":"John","options":"","required":true},
    {"name":"last_name","label":"Last Name","type":"text","placeholder":"Smith","options":"","required":true},
    {"name":"company_name","label":"Business Name","type":"text","placeholder":"Your Company Name","options":"","required":true},
    {"name":"email","label":"Email Address","type":"email","placeholder":"john@company.com","options":"","required":true},
    {"name":"phone","label":"Phone Number","type":"tel","placeholder":"(555) 123-4567","options":"","required":true},
    {"name":"has_mca","label":"Do you have a Merchant Cash Advance (MCA)?","type":"radio","placeholder":"","options":"Yes,No","required":true},
    {"name":"gclid","label":"Google Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"rt_clickid","label":"RT Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"eli_clickid","label":"Eli Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"keyword","label":"Keyword","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"visitor_ip","label":"Visitor IP","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"page_url","label":"Page URL","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"referrer_url","label":"Referrer URL","type":"hidden","placeholder":"","options":"","required":false}
  ]);
  db.prepare(`
    INSERT INTO forms (name, platform, webhook_url, fields, submit_button_text, success_message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('Google Ads Form', 'google', 'https://hooks.zapier.com/hooks/catch/23550212/ulvkpuf/', formFields, 'Get My Free Consultation', 'Thank you! One of our debt relief specialists will contact you within 24 hours.');
  console.log('Default form created');
}

const pageCount = db.prepare('SELECT COUNT(*) as count FROM landing_pages').get();
if (pageCount.count === 0) {
  const defaultContent = JSON.stringify({"badge":"Bankruptcy Alternative","headline":"Don't File Bankruptcy.","headlineHighlight":"Up to 80% Less.","subheadline":"Thousands of business owners avoided bankruptcy by settling their debt through us. No court. No public record. Keep your business running.","bulletPoints":["No public bankruptcy record","Keep your business & assets","Credit recovers in months, not years","No court appearances or legal complexity"],"formTitle":"See If You Qualify","formSubtitle":"Takes 60 seconds. No obligation.","formButton":"Get My Free Debt Analysis","trustLabel":"As Seen In & Trusted By","comparisonTitle":"Why Business Owners Choose Debt Settlement Over Bankruptcy","howItWorksTitle":"How It Works","howItWorksSubtitle":"Our proven 3-step process has helped over 1,500 businesses avoid bankruptcy","steps":[{"title":"Free Debt Analysis","description":"Tell us about your situation. We'll review your debt and show you exactly how much you could save without filing bankruptcy."},{"title":"We Negotiate With Creditors","description":"Our team contacts your lenders directly. No lawyers, no court. We negotiate to reduce your total debt by 50-80%."},{"title":"Debt Resolved, Business Saved","description":"Pay a fraction of what you owed. No bankruptcy on your record. Your business keeps running."}],"caseStudiesTitle":"Real Settlements. Real Savings.","caseStudiesSubtitle":"These are actual settlement agreements we negotiated for our clients","empathyTitle":"We Know This Is Hard. You're Not Alone.","empathyText":["Facing the possibility of bankruptcy is one of the most stressful experiences a business owner can go through. The sleepless nights, the constant calls from creditors, the fear of losing everything you've built — we understand.","But here's what we want you to know: there is another way. Every day, we help business owners just like you find a path forward without bankruptcy.","You don't have to face this alone. Let us fight for you."],"testimonialsTitle":"Real People. Real Results.","testimonialsSubtitle":"Hear from business owners who found relief with Coastal Debt","ctaTitle":"Don't Let Bankruptcy Be Your Only Option","ctaSubtitle":"Free consultation. See how much you could save without filing.","ctaButton":"Get My Free Debt Analysis","phone":"(800) 123-0000","colors":{"primary":"#3052FF","primaryLight":"#4a6aff","navy":"#1a2e4a","navyDark":"#0f1c2e"}});
  const defaultSections = JSON.stringify({"trustBar":true,"comparison":true,"howItWorks":true,"caseStudies":true,"empathy":true,"testimonials":true,"faq":true,"cta":true});

  const pages = [
    { slug: 'business-debt-relief', name: 'Business Debt Relief - Bankruptcy Alternative', source: 'Google Ads - Bankruptcy Keywords', formId: 1 },
    { slug: 'mca-debt-relief', name: 'MCA Debt Relief', source: 'Google Ads - MCA Keywords', formId: null },
    { slug: 'business-debt-relief-programs', name: 'Business Debt Relief Programs', source: 'Google Ads - Business Debt Relief Keywords', formId: null }
  ];

  const insertPage = db.prepare(`
    INSERT INTO landing_pages (slug, name, platform, traffic_source, form_id, content, sections_visible, hidden_fields)
    VALUES (?, ?, 'google', ?, ?, ?, ?, '{}')
  `);

  pages.forEach(p => {
    insertPage.run(p.slug, p.name, p.source, p.formId, defaultContent, defaultSections);
  });
  console.log('Default landing pages created');
}

// Articles table for Outbrain advertorial pages
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    headline TEXT,
    subheadline TEXT,
    body_html TEXT,
    author_name TEXT DEFAULT 'Sarah Mitchell',
    author_title TEXT DEFAULT 'Senior Business Correspondent',
    publish_date TEXT,
    platform TEXT DEFAULT 'outbrain' CHECK(platform IN ('google', 'meta', 'tiktok', 'linkedin', 'bing', 'outbrain', 'reddit', 'other')),
    traffic_source TEXT,
    form_id INTEGER,
    content TEXT DEFAULT '{}',
    meta_title TEXT,
    meta_description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (form_id) REFERENCES forms(id)
  );
  CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
`);

// Add article_id to leads table
try { db.exec(`ALTER TABLE leads ADD COLUMN article_id INTEGER`); } catch (e) {}

// IP Blocklist table
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT UNIQUE NOT NULL,
    reason TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add is_blocked column to leads
try { db.exec(`ALTER TABLE leads ADD COLUMN is_blocked INTEGER DEFAULT 0`); } catch (e) {}

// Outbrain: Business Debt landing page + direct form (no pre-qual)
const obFormExists = db.prepare("SELECT id FROM forms WHERE name = 'Outbrain Business Debt Form'").get();
if (!obFormExists) {
  const obFields = JSON.stringify([
    {"name":"first_name","label":"First Name","type":"text","placeholder":"John","options":"","required":true},
    {"name":"last_name","label":"Last Name","type":"text","placeholder":"Smith","options":"","required":true},
    {"name":"company_name","label":"Company Name","type":"text","placeholder":"Your Company","options":"","required":true},
    {"name":"email","label":"Email","type":"email","placeholder":"john@company.com","options":"","required":true},
    {"name":"phone","label":"Phone Number","type":"tel","placeholder":"(555) 123-4567","options":"","required":true},
    {"name":"gclid","label":"Google Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"rt_clickid","label":"RT Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"eli_clickid","label":"Eli Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"keyword","label":"Keyword","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"visitor_ip","label":"Visitor IP","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"page_url","label":"Page URL","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"referrer_url","label":"Referrer URL","type":"hidden","placeholder":"","options":"","required":false}
  ]);
  const obForm = db.prepare(`
    INSERT INTO forms (name, platform, webhook_url, fields, submit_button_text, success_message, skip_pre_qual)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run('Outbrain Business Debt Form', 'outbrain', 'https://hooks.zapier.com/hooks/catch/23550212/ulvkpuf/', obFields, 'Get My Free Consultation', 'Thank you! A debt relief specialist will contact you shortly.');
  console.log('Outbrain form created (ID: ' + obForm.lastInsertRowid + ')');

  const obContent = JSON.stringify({
    badge: "Business Debt Relief",
    headline: "Drowning in Business Debt?",
    headlineLine2: "We Help You",
    headlineHighlight: "Resolve It for Less.",
    subheadline: "Our expert negotiators work directly with your creditors to reduce what you owe — so you can get back to running your business.",
    bulletPoints: [
      "Reduce your total debt by 50-80%",
      "Stop creditor harassment & collection calls",
      "One affordable monthly payment",
      "No upfront fees — pay only when we settle"
    ],
    formTitle: "Get Your Free Debt Analysis",
    formSubtitle: "See how much you could save. Takes 60 seconds.",
    formButton: "Get My Free Consultation",
    trustLabel: "As Seen In & Trusted By",
    comparisonTitle: "DIY vs. Professional Debt Relief",
    comparisonSubtitle: "See why business owners trust Coastal Debt to handle their debt",
    comparisonColBad: "Going It Alone",
    comparisonColGood: "Coastal Debt Relief",
    comparisonRows: [
      {"label":"Creditor Calls","bad":"Non-stop harassment","good":"We handle all communication"},
      {"label":"Debt Reduction","bad":"Pay full amount + interest","good":"Settle for 50-80% less"},
      {"label":"Monthly Payments","bad":"Multiple payments to many lenders","good":"One simple monthly payment"},
      {"label":"Legal Protection","bad":"Risk of lawsuits & garnishment","good":"Legal team on your side"},
      {"label":"Time to Resolve","bad":"Years of minimum payments","good":"3-6 months average"},
      {"label":"Your Business","bad":"Struggling to stay open","good":"Keep operating & growing"}
    ],
    comparisonCtaText: "See How Much You Could Save",
    howItWorksTitle: "How It Works",
    howItWorksSubtitle: "Our proven 3-step process has helped over 1,500 businesses get out of debt",
    steps: [
      {"title":"Free Debt Analysis","description":"Tell us about your business debt. We'll review your situation and show you exactly how much you could save."},
      {"title":"We Negotiate for You","description":"Our team contacts your creditors directly and negotiates to reduce what you owe — often by 50-80%."},
      {"title":"Debt Resolved","description":"Pay a fraction of what you owed. Get back to focusing on what matters — your business."}
    ],
    caseStudiesTitle: "Real Settlements. Real Savings.",
    caseStudiesSubtitle: "These are actual settlement agreements we negotiated for our clients",
    empathyTitle: "Business Debt Is Overwhelming. We Get It.",
    empathyText: [
      "When you started your business, you never imagined debt would become this heavy. The daily stress of creditor calls, the anxiety of not knowing if you can make payroll, the fear of losing what you've worked so hard to build.",
      "But here's what we want you to know: there is another way. You don't have to drain your savings, close your doors, or file bankruptcy. Every day, we help business owners just like you negotiate their way out of debt.",
      "Let us take this weight off your shoulders. Your first consultation is completely free."
    ],
    testimonialsTitle: "Real People. Real Results.",
    testimonialsSubtitle: "Hear from business owners who found relief with Coastal Debt",
    ctaTitle: "Your Business Deserves a Fresh Start",
    ctaSubtitle: "Free consultation. No obligation. See how much you could save today.",
    ctaButton: "Get My Free Consultation",
    faqTitle: "Common Questions About Business Debt Relief",
    faqSubtitle: "Get the answers you need before making a decision",
    faqItems: [
      {"question":"What types of business debt can you help with?","answer":"We help with merchant cash advances (MCAs), business loans, lines of credit, equipment financing, and most unsecured business debts. If creditors are calling, we can likely help."},
      {"question":"How much can I actually save?","answer":"Most of our clients settle their debt for 50-80% less than what they owe. The exact amount depends on your specific situation, which is why we offer a free analysis."},
      {"question":"Will this affect my credit score?","answer":"There may be a temporary impact, but most clients see their scores recover within 12-24 months. Compare this to the years of damage from defaulting or filing bankruptcy."},
      {"question":"How long does the process take?","answer":"Most cases are resolved in 3-6 months. This is significantly faster than trying to pay off debt on your own or going through bankruptcy proceedings."},
      {"question":"Do I have to stop paying my creditors?","answer":"We'll work with you to develop the best strategy for your situation. Our goal is to negotiate the lowest possible settlement while protecting your business."},
      {"question":"Is there any upfront cost?","answer":"No. We don't charge any upfront fees. You only pay when we successfully negotiate a settlement on your behalf."}
    ],
    pageTitle: "Business Debt Relief | Reduce What You Owe by 50-80%",
    metaDescription: "Struggling with business debt? Our experts negotiate with your creditors to reduce what you owe by 50-80%. No upfront fees. Free consultation.",
    phone: "(800) 123-4567",
    colors: {
      primary: "#3052FF",
      primaryLight: "#4a6aff",
      navy: "#1a2e4a",
      navyDark: "#0f1c2e"
    }
  });
  const obSections = JSON.stringify({trustBar:true,comparison:true,howItWorks:true,caseStudies:true,empathy:true,testimonials:true,faq:true,cta:true});

  db.prepare(`
    INSERT INTO landing_pages (slug, name, platform, traffic_source, form_id, content, sections_visible, hidden_fields)
    VALUES (?, ?, 'outbrain', 'Outbrain - Business Debt', ?, ?, ?, '{}')
  `).run('business-debt-solutions', 'Business Debt Solutions - Outbrain', obForm.lastInsertRowid, obContent, obSections);
  console.log('Outbrain landing page created');
}

// Facebook / Social: MCA Debt Relief landing page
{
  const fbForm = db.prepare("SELECT id FROM forms WHERE name = 'Outbrain Business Debt Form'").get();
  const fbFormId = fbForm ? fbForm.id : null;

  const fbContent = JSON.stringify({
    badge: "MCA Debt Relief",
    headline: "Get Up to 80% Off Your",
    headlineLine2: "MCA Debt Payments!",
    headlineHighlight: "MCA Debt Payments!",
    subheadline: "Small businesses are discovering a proven MCA Debt Relief program. Pay less than you owe. Only $20K+ MCA Debt Relief. No Loans or Other Debt.",
    bulletPoints: [
      "Increase cashflow immediately — comfortable weekly payments",
      "Get up to 80% off your MCA debt in 6-8 months",
      "Dedicated expert Debt Settlement Advisor & legal team",
      "No upfront fees — pay only when we settle"
    ],
    formTitle: "See If Your Business Qualifies",
    formSubtitle: "Only $20K+ MCA Debt. Takes 60 seconds.",
    formButton: "Get My Free Consultation",
    trustLabel: "As Seen In & Trusted By",
    comparisonTitle: "Why Business Owners Choose MCA Debt Settlement",
    comparisonSubtitle: "See why thousands trust Coastal Debt to handle their MCA debt",
    comparisonColBad: "Struggling Alone",
    comparisonColGood: "Coastal Debt Relief",
    comparisonRows: [
      {"label":"Daily ACH Payments","bad":"30-50% of revenue withdrawn daily","good":"One comfortable weekly payment"},
      {"label":"Debt Reduction","bad":"Pay full amount + high factor rates","good":"Settle for up to 80% less"},
      {"label":"MCA Cycle","bad":"Taking new MCAs to pay old ones","good":"Break the cycle for good"},
      {"label":"Legal Protection","bad":"Risk of lawsuits & UCC liens","good":"Legal team on your side"},
      {"label":"Time to Resolve","bad":"Trapped for years","good":"6-8 months average"},
      {"label":"Your Business","bad":"Bleeding cash, can't grow","good":"Keep operating & growing"}
    ],
    comparisonCtaText: "Check Your Eligibility",
    howItWorksTitle: "How It Works",
    howItWorksSubtitle: "We've perfected our proven process to get over 1,000 businesses out of MCA debt",
    steps: [
      {"title":"Free, Confidential Consultation","description":"Our expert advisors will call you to quickly determine whether your business is qualified for our debt relief program. We need to ensure this will be the best solution for your business."},
      {"title":"Expert Debt Analysis","description":"Our trusted team will do a deep-dive analysis of your MCA debt and lender agreements. They will work on a plan based on your unique situation to ensure the best outcome."},
      {"title":"Same-Day Sign Up","description":"Not all businesses qualify for our program, but we hope we can help yours. If your business does qualify, we can sign you up on the spot and get you fast-tracked to financial freedom."}
    ],
    caseStudiesTitle: "Our Numbers Speak for Themselves",
    caseStudiesSubtitle: "These are actual settlement agreements we negotiated for our clients",
    empathyTitle: "Trapped in MCA Debt? You're Not Alone.",
    empathyText: [
      "You took out an MCA to keep your business running. Then another. And another. Now the daily ACH withdrawals are eating your revenue alive, and you feel like there's no way out.",
      "But here's what we want you to know: there IS a way out. Every day, we help business owners just like you break free from the MCA debt cycle — settling for a fraction of what they owe.",
      "Let us take this weight off your shoulders. Your first consultation is completely free and confidential."
    ],
    testimonialsTitle: "What Our Clients Are Saying",
    testimonialsSubtitle: "Hear from business owners who found relief with Coastal Debt",
    faqTitle: "Common Questions About MCA Debt Relief",
    faqSubtitle: "Get the answers you need before making a decision",
    faqItems: [
      {"question":"What types of MCA debt can you help with?","answer":"We help with all types of Merchant Cash Advances, including daily and weekly ACH payment MCAs, revenue-based financing, and business cash advances from any funder."},
      {"question":"How much can I actually save?","answer":"Our clients typically save 30-80% of their total MCA debt. Recent settlements include 73% savings ($23K debt settled for $6,110) and 61% savings ($12.8K debt settled for $5,000)."},
      {"question":"Will the daily ACH withdrawals stop?","answer":"Yes. Once you enroll in our program, we work to stop the daily ACH withdrawals and replace them with one comfortable weekly or monthly payment you can afford."},
      {"question":"How long does the process take?","answer":"Most MCA debt cases are resolved in 6-8 months. This is significantly faster than continuing to make minimum payments or taking out new MCAs."},
      {"question":"Do I need $20,000+ in MCA debt to qualify?","answer":"Yes, our program is designed for businesses with at least $20,000 in MCA debt. If you have multiple MCAs, we can help consolidate and settle them all."},
      {"question":"Is there any upfront cost?","answer":"No. We don't charge any upfront fees. You only pay when we successfully negotiate a settlement on your behalf."}
    ],
    ctaTitle: "Get Out of MCA Debt for Good",
    ctaSubtitle: "Free consultation. No obligation. See how much you could save today.",
    ctaButton: "Get Started",
    pageTitle: "Get Up to 80% Off Your MCA Debt | Coastal Debt Resolve",
    metaDescription: "Discover if you qualify for our proven MCA Debt Relief program. Get up to 80% off your Merchant Cash Advance debt. Free consultation. No upfront fees.",
    phone: "(888) 961-5338",
    colors: {
      primary: "#3052FF",
      primaryLight: "#4a6aff",
      navy: "#1a2e4a",
      navyDark: "#0f1c2e"
    }
  });
  const fbSections = JSON.stringify({trustBar:true,comparison:true,howItWorks:true,caseStudies:true,empathy:true,testimonials:true,faq:true,cta:true});

  const fbPageExists = db.prepare("SELECT id FROM landing_pages WHERE slug = 'restructure-mca-business-loans-now-social'").get();
  if (!fbPageExists) {
    db.prepare(`
      INSERT INTO landing_pages (slug, name, platform, traffic_source, form_id, content, sections_visible, hidden_fields)
      VALUES (?, ?, 'meta', 'Facebook - Social', ?, ?, ?, '{}')
    `).run('restructure-mca-business-loans-now-social', 'MCA Debt Relief - Facebook', fbFormId, fbContent, fbSections);
    console.log('Facebook landing page created: restructure-mca-business-loans-now-social');
  }
}

// Seed article: MCA Debt Relief (Facebook/Social)
{
  const obForm = db.prepare("SELECT id FROM forms WHERE name = 'Outbrain Business Debt Form'").get();
  const articleFormId = obForm ? obForm.id : null;

  const articleBodyHtml = `
<p>If you're a small business owner drowning in Merchant Cash Advance (MCA) debt, you're not alone. Thousands of business owners across the country took on MCAs to keep their businesses running — only to find themselves trapped in a cycle of daily withdrawals that eat up 30-50% of their revenue.</p>

<p>But there's a proven way out. A growing number of business owners are discovering that they can legally settle their MCA debt for a fraction of what they owe — keeping their doors open and their credit intact.</p>

<div class="article-stat-box">
<div class="stat-number">Up to 80%</div>
<div class="stat-label">Reduction on MCA debt payments through professional debt settlement — no bankruptcy required</div>
</div>

<h2>Keep Your Business Open</h2>

<div class="article-benefits">
<div class="benefits-grid">
  <div class="benefit-card">
    <div class="benefit-icon"><svg width="24" height="24" fill="none" stroke="#fff" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2v20m-7-7l7 7 7-7"/></svg></div>
    <div>
      <h4>Increase Cashflow Immediately</h4>
      <p>Upon signup, breathe easier with comfortable weekly payments instead of crushing daily ACH withdrawals eating your revenue.</p>
    </div>
  </div>
  <div class="benefit-card">
    <div class="benefit-icon"><svg width="24" height="24" fill="none" stroke="#fff" stroke-width="2" viewBox="0 0 24 24"><path d="M12 1v4m0 14v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M1 12h4m14 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg></div>
    <div>
      <h4>Get Up to 80% Off Your MCA Debt</h4>
      <p>Pay off your Merchant Cash Advance debt completely in 6-8 months — for a fraction of what you currently owe.</p>
    </div>
  </div>
  <div class="benefit-card">
    <div class="benefit-icon"><svg width="24" height="24" fill="none" stroke="#fff" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87m-4-12a4 4 0 010 7.75"/></svg></div>
    <div>
      <h4>Dedicated Expert Team</h4>
      <p>Get a dedicated Debt Settlement Advisor and a team of trusted attorneys working on your behalf to get the best results.</p>
    </div>
  </div>
</div>
</div>

<div class="article-inline-cta"><a href="#midFormSection">Register for a free consultation &rarr;</a></div>

{{MID_ARTICLE_FORM}}

<h2>Our Numbers Speak for Themselves</h2>

<div class="case-studies-section">
<div class="case-studies-subtitle">These are actual settlement agreements we negotiated for our clients</div>
<div class="case-studies-grid">
  <div class="case-card">
    <div class="case-savings">49% Savings</div>
    <div class="case-company">Mulligan</div>
    <div class="case-row"><span class="label">Original Debt</span><span class="value">$107,684</span></div>
    <div class="case-row"><span class="label">Settled For</span><span class="value saved">$55,000</span></div>
  </div>
  <div class="case-card">
    <div class="case-savings">61% Savings</div>
    <div class="case-company">DLP Funding</div>
    <div class="case-row"><span class="label">Original Debt</span><span class="value">$12,791</span></div>
    <div class="case-row"><span class="label">Settled For</span><span class="value saved">$5,000</span></div>
  </div>
  <div class="case-card">
    <div class="case-savings">56% Savings</div>
    <div class="case-company">ByzFunder</div>
    <div class="case-row"><span class="label">Original Debt</span><span class="value">$40,569</span></div>
    <div class="case-row"><span class="label">Settled For</span><span class="value saved">$18,000</span></div>
  </div>
  <div class="case-card">
    <div class="case-savings">30% Savings</div>
    <div class="case-company">AMA B-Squared Carpentry</div>
    <div class="case-row"><span class="label">Original Debt</span><span class="value">$169,006</span></div>
    <div class="case-row"><span class="label">Settled For</span><span class="value saved">$117,955</span></div>
  </div>
  <div class="case-card">
    <div class="case-savings">44% Savings</div>
    <div class="case-company">Balboa</div>
    <div class="case-row"><span class="label">Original Debt</span><span class="value">$400,000</span></div>
    <div class="case-row"><span class="label">Settled For</span><span class="value saved">$225,000</span></div>
  </div>
  <div class="case-card">
    <div class="case-savings">73% Savings</div>
    <div class="case-company">Global Solution / Everest Funding</div>
    <div class="case-row"><span class="label">Original Debt</span><span class="value">$23,000</span></div>
    <div class="case-row"><span class="label">Settled For</span><span class="value saved">$6,110</span></div>
  </div>
</div>
</div>

<div class="article-cta-banner">
<div class="cta-text">Could your business be next?</div>
<div class="cta-sub">Free analysis. No obligation. Takes 60 seconds.</div>
<a href="#midFormSection" class="cta-button">Check Your Eligibility</a>
</div>

<h2>What Our Clients Are Saying</h2>

<div class="testimonials-section">
<div class="testimonials-grid">
  <div class="testimonial-card">
    <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
    <div class="testimonial-text">"Christopher Ayala from Coastal Debt was honest, patient, and truly humane in his approach. He took the time to understand my situation and never made me feel rushed. I finally feel like I can breathe again."</div>
    <div class="testimonial-author">Rajesh C.</div>
    <div class="testimonial-date">March 23, 2024</div>
  </div>
  <div class="testimonial-card">
    <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
    <div class="testimonial-text">"Craig Caliph was an absolute game changer for my business. His professionalism and patience throughout the entire process made all the difference. I would recommend Coastal Debt to any business owner struggling with MCA debt."</div>
    <div class="testimonial-author">Jim T.</div>
    <div class="testimonial-date">April 3, 2024</div>
  </div>
  <div class="testimonial-card">
    <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
    <div class="testimonial-text">"Nathan Moe was incredibly knowledgeable and walked me through every step. He explained exactly what would happen and delivered on every promise. My restaurant is still open today because of Coastal Debt."</div>
    <div class="testimonial-author">Cindy V.</div>
    <div class="testimonial-date">February 14, 2024</div>
  </div>
  <div class="testimonial-card">
    <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
    <div class="testimonial-text">"Jake and his team made me feel comfortable and confident from day one. They handled everything with the lenders so I could focus on running my business. The results exceeded my expectations."</div>
    <div class="testimonial-author">Norm R.</div>
    <div class="testimonial-date">February 13, 2024</div>
  </div>
  <div class="testimonial-card">
    <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
    <div class="testimonial-text">"Chris showed incredible integrity and kindness in an industry that desperately needs it. He fought for me like it was his own money on the line. I went from multiple daily ACH pulls to one affordable payment."</div>
    <div class="testimonial-author">R.L.</div>
    <div class="testimonial-date">May 30, 2024</div>
  </div>
</div>
</div>

<h2>How It Works</h2>

<div class="process-section">
<div class="process-subtitle">We've perfected our proven process to get over 1,000 businesses out of MCA debt. We craft customized solutions for each client to get the best results.</div>
<div class="process-steps">
  <div class="process-step">
    <div class="step-number">1</div>
    <div class="step-content">
      <h4>Free, Confidential Consultation</h4>
      <p>Our expert advisors will call you to quickly determine whether your business is qualified for our debt relief program. We need to ensure that this will be the best solution for your business.</p>
    </div>
  </div>
  <div class="process-step">
    <div class="step-number">2</div>
    <div class="step-content">
      <h4>Expert Debt Analysis</h4>
      <p>Our trusted team will do a deep-dive analysis of your MCA debt and lender agreements. They will work on a plan based on your unique situation to ensure the best outcome for your business.</p>
    </div>
  </div>
  <div class="process-step">
    <div class="step-number">3</div>
    <div class="step-content">
      <h4>Same-Day Sign Up</h4>
      <p>Not all businesses qualify for our program, but we hope we can help yours. If your business does qualify, we can sign you up on the spot and get you fast-tracked on the road to financial freedom.</p>
    </div>
  </div>
</div>
</div>

<div class="article-trust-badges">
<span class="trust-text">Trusted By</span>
<img src="/lp/assets/trust-logos/bbb.svg" alt="BBB Accredited" onerror="this.style.display='none'">
<img src="/lp/assets/trust-logos/trustpilot.svg" alt="Trustpilot" onerror="this.style.display='none'">
<img src="/lp/assets/trust-logos/inc.svg" alt="Inc. 5000" onerror="this.style.display='none'">
</div>

<div class="article-cta-banner">
<div class="cta-text">Get Out of MCA Debt for Good</div>
<div class="cta-sub">Join 1,500+ business owners who resolved their MCA debt without bankruptcy.</div>
<a href="#endFormSection" class="cta-button">Get Started</a>
</div>

<p><em>Only businesses with $20,000+ in MCA debt qualify for this program. Consultation is free and confidential.</em></p>`;

  const articleContent = JSON.stringify({
    formTitle: 'See If Your Business Qualifies',
    formSubtitle: 'Only $20K+ MCA Debt. No loans or other debt. Takes 60 seconds.',
    endFormTitle: 'Get Up to 80% Off Your MCA Debt',
    endFormSubtitle: 'Free, confidential consultation. No obligation.'
  });

  const articleExists = db.prepare("SELECT id FROM articles WHERE slug = 'business-debt-settlement-guide'").get();
  if (!articleExists) {
    db.prepare(`
      INSERT INTO articles (slug, name, headline, subheadline, body_html, author_name, author_title, publish_date, platform, traffic_source, form_id, content, meta_title, meta_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'meta', 'Facebook - Social', ?, ?, ?, ?)
    `).run(
      'business-debt-settlement-guide',
      'MCA Debt Relief - Social Advertorial',
      'Get Up to 80% Off Your MCA Debt Payments',
      'Small businesses are discovering a proven MCA debt relief program that can reduce what you owe by up to 80%. No bankruptcy. No court. Keep your business open.',
      articleBodyHtml,
      'Sarah Mitchell',
      'Senior Business Correspondent',
      '2026-02-15',
      articleFormId,
      articleContent,
      'Get Up to 80% Off Your MCA Debt Payments | Coastal Debt Resolve',
      'Discover if you qualify for our proven MCA Debt Relief program. Get up to 80% off your Merchant Cash Advance debt. Free consultation. No upfront fees.'
    );
    console.log('Seed article created: business-debt-settlement-guide');
  }
}

// Migration: rename full_name to first_name + last_name in all forms
(function() {
  var forms = db.prepare('SELECT id, fields FROM forms').all();
  for (var form of forms) {
    var fields = JSON.parse(form.fields || '[]');
    var fnIdx = fields.findIndex(f => f.name === 'full_name');
    if (fnIdx !== -1) {
      fields.splice(fnIdx, 1,
        {name:'first_name', label:'First Name', type:'text', placeholder:'John', options:'', required:true},
        {name:'last_name', label:'Last Name', type:'text', placeholder:'Smith', options:'', required:true}
      );
      db.prepare('UPDATE forms SET fields = ? WHERE id = ?').run(JSON.stringify(fields), form.id);
    }
  }
})();

// Migration: ensure all forms have standard hidden fields (Meta-specific only on Meta/Facebook forms)
(function() {
  var commonFields = [
    {name:'keyword', label:'Keyword'},
    {name:'visitor_ip', label:'Visitor IP'}
  ];
  var metaOnlyFields = [
    {name:'fb_campaign_id', label:'FB Campaign ID'},
    {name:'fb_adset_id', label:'FB Ad Set ID'},
    {name:'fb_ad_id', label:'FB Ad ID'},
    {name:'fb_campaign_name', label:'FB Campaign Name'},
    {name:'fb_adset_name', label:'FB Ad Set Name'},
    {name:'fb_ad_name', label:'FB Ad Name'},
    {name:'fb_placement', label:'FB Placement'}
  ];
  var metaFieldNames = metaOnlyFields.map(function(f) { return f.name; });
  var forms = db.prepare('SELECT id, name, platform, fields FROM forms').all();
  for (var i = 0; i < forms.length; i++) {
    var form = forms[i];
    try {
      var fields = JSON.parse(form.fields);
      var isMeta = form.platform === 'meta' || form.name.toLowerCase().indexOf('facebook') !== -1;
      var fieldsToAdd = isMeta ? commonFields.concat(metaOnlyFields) : commonFields;
      var added = 0;

      // Add missing fields
      for (var j = 0; j < fieldsToAdd.length; j++) {
        var rf = fieldsToAdd[j];
        if (!fields.some(function(f) { return f.name === rf.name; })) {
          var idx = -1;
          for (var k = 0; k < fields.length; k++) { if (fields[k].name === 'page_url') { idx = k; break; } }
          var entry = {name: rf.name, label: rf.label, type: 'hidden', placeholder: '', options: '', required: false};
          if (idx !== -1) fields.splice(idx, 0, entry);
          else fields.push(entry);
          added++;
        }
      }

      // Remove Meta-only fields from non-Meta forms
      if (!isMeta) {
        var before = fields.length;
        fields = fields.filter(function(f) { return metaFieldNames.indexOf(f.name) === -1; });
        var removed = before - fields.length;
        if (removed > 0) added += removed;
      }

      if (added > 0) {
        db.prepare('UPDATE forms SET fields = ? WHERE id = ?').run(JSON.stringify(fields), form.id);
        console.log('Migration: updated hidden fields on form "' + form.name + '"');
      }
    } catch (e) {}
  }
})();

// Migration: add 'reddit' to platform CHECK constraints on existing tables
// SQLite requires table rebuild to change CHECK constraints
(function() {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='forms'").get();
    if (row && row.sql && !row.sql.includes("'reddit'")) {
      console.log('Running reddit platform migration...');
      db.pragma('foreign_keys = OFF');

      db.exec(`
        -- forms: rebuild with reddit in CHECK
        DROP TABLE IF EXISTS forms_new;
        CREATE TABLE forms_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          platform TEXT DEFAULT 'other' CHECK(platform IN ('google', 'meta', 'tiktok', 'bing', 'outbrain', 'linkedin', 'reddit', 'other')),
          webhook_url TEXT,
          fields TEXT DEFAULT '[]',
          submit_button_text TEXT DEFAULT 'Submit',
          success_message TEXT DEFAULT 'Thank you! We will contact you shortly.',
          is_active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          skip_pre_qual INTEGER DEFAULT 0
        );
        INSERT INTO forms_new SELECT * FROM forms;
        DROP TABLE forms;
        ALTER TABLE forms_new RENAME TO forms;
      `);
      console.log('Migration: rebuilt forms with reddit platform');

      // landing_pages (may already be done)
      const lpRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='landing_pages'").get();
      if (lpRow && !lpRow.sql.includes("'reddit'")) {
        db.exec(`
          DROP TABLE IF EXISTS landing_pages_new;
          CREATE TABLE landing_pages_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            platform TEXT DEFAULT 'other' CHECK(platform IN ('google', 'meta', 'tiktok', 'linkedin', 'bing', 'outbrain', 'reddit', 'other')),
            traffic_source TEXT,
            webhook_url TEXT,
            form_id INTEGER,
            content TEXT DEFAULT '{}',
            sections_visible TEXT DEFAULT '{}',
            hidden_fields TEXT DEFAULT '{}',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (form_id) REFERENCES forms(id)
          );
          INSERT INTO landing_pages_new SELECT * FROM landing_pages;
          DROP TABLE landing_pages;
          ALTER TABLE landing_pages_new RENAME TO landing_pages;
        `);
        console.log('Migration: rebuilt landing_pages with reddit platform');
      }

      // articles
      db.exec(`
        DROP TABLE IF EXISTS articles_new;
        CREATE TABLE articles_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          headline TEXT,
          subheadline TEXT,
          body_html TEXT,
          author_name TEXT DEFAULT 'Sarah Mitchell',
          author_title TEXT DEFAULT 'Senior Business Correspondent',
          publish_date TEXT,
          platform TEXT DEFAULT 'outbrain' CHECK(platform IN ('google', 'meta', 'tiktok', 'linkedin', 'bing', 'outbrain', 'reddit', 'other')),
          traffic_source TEXT,
          form_id INTEGER,
          content TEXT DEFAULT '{}',
          meta_title TEXT,
          meta_description TEXT,
          is_active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (form_id) REFERENCES forms(id)
        );
        INSERT INTO articles_new SELECT * FROM articles;
        DROP TABLE articles;
        ALTER TABLE articles_new RENAME TO articles;
      `);
      console.log('Migration: rebuilt articles with reddit platform');

      db.pragma('foreign_keys = ON');
    }
  } catch (e) {
    console.error('Reddit platform migration error:', e.message);
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
  }
})();

module.exports = db;
