#!/usr/bin/env node
/**
 * CMS Sync Script
 * Connects to the production CMS API to read/update page content.
 *
 * Usage:
 *   node scripts/cms-sync.js login                  # Login and save token
 *   node scripts/cms-sync.js list                   # List all pages
 *   node scripts/cms-sync.js get <slug>             # Get page content by slug
 *   node scripts/cms-sync.js push <slug>            # Push local DB content to production
 *   node scripts/cms-sync.js pull <slug>            # Pull production content to local DB
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, '..', '.cms-sync.json');
const PROD_URL = 'https://info.coastaldebt.com';

// Load saved config (token, etc.)
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function apiCall(method, endpoint, body = null) {
  const config = loadConfig();
  if (!config.token) {
    console.error('Not logged in. Run: node scripts/cms-sync.js login');
    process.exit(1);
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${PROD_URL}${endpoint}`, options);

  if (res.status === 401) {
    console.error('Token expired. Run: node scripts/cms-sync.js login');
    process.exit(1);
  }

  const data = await res.json();
  if (!res.ok) {
    console.error(`API error (${res.status}):`, data.error || data);
    process.exit(1);
  }
  return data;
}

// --- Commands ---

async function login() {
  const email = await prompt('Email: ');
  const password = await prompt('Password: ');

  const res = await fetch(`${PROD_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  // Extract token from set-cookie header
  const setCookie = res.headers.get('set-cookie') || '';
  const tokenMatch = setCookie.match(/token=([^;]+)/);

  const data = await res.json();

  if (!res.ok) {
    console.error('Login failed:', data.error);
    process.exit(1);
  }

  if (tokenMatch) {
    const config = loadConfig();
    config.token = tokenMatch[1];
    config.user = data.user;
    config.loginTime = new Date().toISOString();
    saveConfig(config);
    console.log(`Logged in as ${data.user.email}`);
    console.log('Token saved to .cms-sync.json');
  } else {
    console.error('Login succeeded but no token in response cookie. Check API.');
  }
}

async function listPages() {
  const pages = await apiCall('GET', '/api/pages');
  console.log('\nProduction CMS Pages:');
  console.log('─'.repeat(80));
  pages.forEach(p => {
    const leadCount = p.lead_count || 0;
    console.log(`  ID: ${p.id} | /${p.slug}/ | ${p.name} | ${leadCount} leads | ${p.is_active ? 'Active' : 'Inactive'}`);
  });
  console.log(`\nTotal: ${pages.length} pages`);
}

async function getPage(slug) {
  const pages = await apiCall('GET', '/api/pages');
  const page = pages.find(p => p.slug === slug);
  if (!page) {
    console.error(`Page with slug "${slug}" not found in production.`);
    console.log('Available slugs:', pages.map(p => p.slug).join(', '));
    process.exit(1);
  }
  console.log(`\nPage: ${page.name} (ID: ${page.id})`);
  console.log(`Slug: ${page.slug}`);
  console.log(`Platform: ${page.platform}`);
  console.log(`Leads: ${page.lead_count || 0}`);
  console.log('\nContent:');
  console.log(JSON.stringify(page.content, null, 2));
  return page;
}

async function pushContent(slug) {
  // Get local content
  const db = require(path.join(__dirname, '..', 'server', 'database'));
  const localPage = db.prepare('SELECT * FROM landing_pages WHERE slug = ?').get(slug);
  if (!localPage) {
    console.error(`Page "${slug}" not found in local DB.`);
    process.exit(1);
  }
  const localContent = JSON.parse(localPage.content);

  // Find production page
  const pages = await apiCall('GET', '/api/pages');
  const prodPage = pages.find(p => p.slug === slug);
  if (!prodPage) {
    console.error(`Page "${slug}" not found in production.`);
    process.exit(1);
  }

  console.log(`\nPushing local content for "${slug}" to production (page ID: ${prodPage.id})...`);
  console.log(`Local content keys: ${Object.keys(localContent).join(', ')}`);

  const result = await apiCall('PUT', `/api/pages/${prodPage.id}/content`, { content: localContent });
  console.log('Success:', result.message);
  console.log('Production page updated and regenerated.');
}

async function pullContent(slug) {
  // Get production content
  const pages = await apiCall('GET', '/api/pages');
  const prodPage = pages.find(p => p.slug === slug);
  if (!prodPage) {
    console.error(`Page "${slug}" not found in production.`);
    process.exit(1);
  }

  const prodContent = prodPage.content;

  // Update local DB
  const db = require(path.join(__dirname, '..', 'server', 'database'));
  const localPage = db.prepare('SELECT * FROM landing_pages WHERE slug = ?').get(slug);

  if (localPage) {
    db.prepare('UPDATE landing_pages SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(prodContent), localPage.id);
    console.log(`Updated local page "${slug}" with production content.`);
  } else {
    console.log(`Page "${slug}" not in local DB. Creating...`);
    db.prepare(`INSERT INTO landing_pages (slug, name, content, platform, is_active, template_type, sections_visible)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(slug, prodPage.name, JSON.stringify(prodContent), prodPage.platform || 'google', 1, prodPage.template_type || 'form',
        JSON.stringify(prodPage.sections_visible || {}));
    console.log(`Created local page "${slug}".`);
  }

  // Regenerate local HTML
  const pagesRoute = require(path.join(__dirname, '..', 'server', 'routes', 'pages'));
  const updatedPage = db.prepare('SELECT id FROM landing_pages WHERE slug = ?').get(slug);
  pagesRoute.generateLandingPage(updatedPage.id);
  console.log('Local HTML regenerated.');
}

// --- Main ---
const [,, command, ...args] = process.argv;

(async () => {
  switch (command) {
    case 'login':
      await login();
      break;
    case 'list':
      await listPages();
      break;
    case 'get':
      if (!args[0]) { console.error('Usage: cms-sync.js get <slug>'); process.exit(1); }
      await getPage(args[0]);
      break;
    case 'push':
      if (!args[0]) { console.error('Usage: cms-sync.js push <slug>'); process.exit(1); }
      await pushContent(args[0]);
      break;
    case 'pull':
      if (!args[0]) { console.error('Usage: cms-sync.js pull <slug>'); process.exit(1); }
      await pullContent(args[0]);
      break;
    default:
      console.log(`CMS Sync — Manage production CMS content

Usage:
  node scripts/cms-sync.js login                Login to production CMS
  node scripts/cms-sync.js list                 List all production pages
  node scripts/cms-sync.js get <slug>           View production page content
  node scripts/cms-sync.js push <slug>          Push local content → production
  node scripts/cms-sync.js pull <slug>          Pull production content → local`);
  }
})();
