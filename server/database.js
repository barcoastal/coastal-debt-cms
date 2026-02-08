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
`);

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

module.exports = db;
