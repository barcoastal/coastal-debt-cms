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
    platform TEXT DEFAULT 'other' CHECK(platform IN ('google', 'meta', 'tiktok', 'linkedin', 'bing', 'outbrain', 'other')),
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
    platform TEXT DEFAULT 'other' CHECK(platform IN ('google', 'meta', 'tiktok', 'bing', 'outbrain', 'linkedin', 'other')),
    webhook_url TEXT,
    fields TEXT DEFAULT '[]',
    submit_button_text TEXT DEFAULT 'Submit',
    success_message TEXT DEFAULT 'Thank you! We will contact you shortly.',
    is_active INTEGER DEFAULT 1,
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

// Add debt_amount and revenue to conversion_events if not exist
try {
  db.exec(`ALTER TABLE conversion_events ADD COLUMN debt_amount REAL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE conversion_events ADD COLUMN revenue REAL`);
} catch (e) {}

// Add capi_payload to conversion_events for Facebook debug
try { db.exec(`ALTER TABLE conversion_events ADD COLUMN capi_payload TEXT`); } catch (e) {}

// Add fbclid to leads table for Facebook attribution
try { db.exec(`ALTER TABLE leads ADD COLUMN fbclid TEXT DEFAULT ''`); } catch (e) {}

// Add Facebook tracking columns to visitors table
try { db.exec(`ALTER TABLE visitors ADD COLUMN fbclid TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE visitors ADD COLUMN fbc TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE visitors ADD COLUMN fbp TEXT DEFAULT ''`); } catch (e) {}

// Add test_event_code to facebook_config
try { db.exec(`ALTER TABLE facebook_config ADD COLUMN test_event_code TEXT`); } catch (e) {}

// Add Salesforce tracking columns to leads table
try { db.exec(`ALTER TABLE leads ADD COLUMN transfer_status TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN five9_dispo TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN stage TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN contract_sign_date TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN total_debt_sign TEXT`); } catch (e) {}

// Add permissions column to users if not exist
try { db.exec(`ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'`); } catch (e) {}

// Add pixel_id to facebook_config if not exist
try {
  db.exec(`ALTER TABLE facebook_config ADD COLUMN pixel_id TEXT`);
} catch (e) {}

// Add ad_account_id to facebook_config if not exist
try {
  db.exec(`ALTER TABLE facebook_config ADD COLUMN ad_account_id TEXT`);
} catch (e) {}

// Create facebook_config table
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
    {"name":"full_name","label":"Full Name","type":"text","placeholder":"John Smith","options":"","required":true},
    {"name":"company_name","label":"Business Name","type":"text","placeholder":"Your Company Name","options":"","required":true},
    {"name":"email","label":"Email Address","type":"email","placeholder":"john@company.com","options":"","required":true},
    {"name":"phone","label":"Phone Number","type":"tel","placeholder":"(555) 123-4567","options":"","required":true},
    {"name":"has_mca","label":"Do you have a Merchant Cash Advance (MCA)?","type":"radio","placeholder":"","options":"Yes,No","required":true},
    {"name":"gclid","label":"Google Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"rt_clickid","label":"RT Click ID","type":"hidden","placeholder":"","options":"","required":false},
    {"name":"eli_clickid","label":"Eli Click ID","type":"hidden","placeholder":"","options":"","required":false},
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

module.exports = db;
