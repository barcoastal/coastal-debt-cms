const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const db = require('./database');
const authRoutes = require('./routes/auth');
const leadsRoutes = require('./routes/leads');
const pagesRoutes = require('./routes/pages');
const scriptsRoutes = require('./routes/scripts');
const analyticsRoutes = require('./routes/analytics');
const formsRoutes = require('./routes/forms');
const visitorsRoutes = require('./routes/visitors');
const googleAdsRoutes = require('./routes/google-ads');
const postbackRoutes = require('./routes/postback');
const facebookRoutes = require('./routes/facebook');
const bingAdsRoutes = require('./routes/bing-ads');
const settingsRoutes = require('./routes/settings');
const notificationsRoutes = require('./routes/notifications');
const aiContentRoutes = require('./routes/ai-content');
const crmRoutes = require('./routes/crm');
const emailMarketingRoutes = require('./routes/email-marketing');
const emailTrackingRoutes = require('./routes/email-tracking');
const articlesRoutes = require('./routes/articles');
const redtrackRoutes = require('./routes/redtrack');
const googleSheetsRoutes = require('./routes/google-sheets');
const tiktokLeadsRoutes = require('./routes/tiktok-leads');
const salesforceRoutes = require('./routes/salesforce');
const redditAdsRoutes = require('./routes/reddit-ads');
const retreaverRoutes = require('./routes/retreaver');
const adGeneratorRoutes = require('./routes/ad-generator');
const deepAnalysisRoutes = require('./routes/deep-analysis');
const inboxRoutes = require('./routes/inbox');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for Railway/Cloudflare)
app.set('trust proxy', 1);

// Middleware
app.use(compression()); // Gzip compression - reduces file size by ~70%
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve admin static files (no cache - always fresh)
app.use('/admin', (req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
}, express.static(path.join(__dirname, '..', 'admin'), {
  maxAge: 0,
  etag: false
}));

// Serve public assets (logos, trust-logos, etc.)
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), {
  maxAge: '7d',
  etag: true
}));

// Serve uploaded files from persistent volume (survives Railway deploys)
const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', 'public', 'uploads');
app.use('/lp/uploads', express.static(uploadsDir, {
  maxAge: '7d',
  etag: true
}));

// Serve robots.txt from root
app.get('/robots.txt', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'robots.txt'));
});

// A/B template test: serve variant-b.html if visitor is in variant B
const isProduction = !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
app.use('/lp', (req, res, next) => {
  // Check if requesting a page directory (ends with / or no extension)
  if (req.path.match(/\/[^.]+\/?$/) || req.path.endsWith('/')) {
    const slug = req.path.replace(/^\/|\/$/g, '');
    if (slug) {
      try {
        const page = db.prepare('SELECT id, ab_config FROM landing_pages WHERE slug = ?').get(slug);
        if (page) {
          const abCfg = JSON.parse(page.ab_config || '{}');
          if (abCfg.enabled && (abCfg.variantB_template || abCfg.variantB_page)) {
            // Disable CDN caching for A/B tested pages
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('CDN-Cache-Control', 'no-store');
            res.setHeader('Vary', 'Cookie');

            const cookieName = `ab_${page.id}`;
            const cookies = req.headers.cookie || '';
            const match = cookies.match(new RegExp(cookieName + '=([^;]+)'));
            let variant = match ? match[1] : null;

            if (!variant) {
              const split = abCfg.split || 50;
              variant = Math.random() * 100 < split ? 'B' : 'A';
              res.cookie(cookieName, variant, { maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
            }

            console.log(`[A/B] Page ${slug} (id:${page.id}): variant=${variant}, cookie=${match ? match[1] : 'new'}`);

            // Helper: inject variant script into HTML before </head>
            function sendWithVariant(filePath, variantLabel) {
              let html = fs.readFileSync(filePath, 'utf8');
              html = html.replace('</head>', `<script>window._abVariant="${variantLabel}";</script>\n</head>`);
              res.type('html').send(html);
            }

            if (variant === 'B') {
              // Option 1: Serve another existing page as variant B
              if (abCfg.variantB_page) {
                const bPage = db.prepare('SELECT slug FROM landing_pages WHERE id = ?').get(abCfg.variantB_page);
                if (bPage) {
                  const bPath = path.join(__dirname, '..', 'public', bPage.slug, 'index.html');
                  if (fs.existsSync(bPath)) {
                    console.log(`[A/B] Serving page "${bPage.slug}" as variant B for "${slug}"`);
                    return sendWithVariant(bPath, 'B');
                  }
                }
              }
              // Option 2: Serve generated variant-b.html
              const variantPath = path.join(__dirname, '..', 'public', slug, 'variant-b.html');
              if (fs.existsSync(variantPath)) {
                return sendWithVariant(variantPath, 'B');
              } else {
                console.log(`[A/B] WARNING: no variant B file found for ${slug}`);
              }
            } else {
              // Variant A: serve normal page but inject variant tag
              const aPath = path.join(__dirname, '..', 'public', slug, 'index.html');
              if (fs.existsSync(aPath)) {
                return sendWithVariant(aPath, 'A');
              }
            }
          }
        }
      } catch (e) {
        console.error('[A/B] Error:', e.message);
      }
    }
  }
  next();
});

// Serve generated landing pages with cache headers
app.use('/lp', (req, res, next) => {
  if (isProduction) {
    // Short cache so template changes reflect quickly
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('CDN-Cache-Control', 'max-age=60');
  } else {
    // Development: no caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('Vary', 'Accept-Encoding');
  next();
}, express.static(path.join(__dirname, '..', 'public'), {
  maxAge: isProduction ? '1h' : 0,
  etag: true,
  lastModified: true
}));

// Serve generated article pages at /a/[slug]/
app.use('/a', (req, res, next) => {
  if (isProduction) {
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    res.setHeader('CDN-Cache-Control', 'max-age=86400');
  } else {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('Vary', 'Accept-Encoding');
  next();
}, express.static(path.join(__dirname, '..', 'public', 'articles'), {
  maxAge: isProduction ? '1h' : 0,
  etag: true,
  lastModified: true
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/scripts', scriptsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/forms', formsRoutes);
app.use('/api/visitors', visitorsRoutes);
app.use('/api/google-ads', googleAdsRoutes);
app.use('/api/postback', postbackRoutes);
app.use('/api/facebook', facebookRoutes);
app.use('/api/bing-ads', bingAdsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/ai', aiContentRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/email', emailMarketingRoutes);
app.use('/api/articles', articlesRoutes);
app.use('/api/redtrack', redtrackRoutes);
app.use('/api/google-sheets', googleSheetsRoutes);
app.use('/api/tiktok-leads', tiktokLeadsRoutes);
app.use('/api/salesforce', salesforceRoutes);
app.use('/api/reddit-ads', redditAdsRoutes);
app.use('/api/retreaver', retreaverRoutes);
app.use('/api/ad-generator', adGeneratorRoutes);
app.use('/api/deep-analysis', deepAnalysisRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/t', emailTrackingRoutes);

// Redirect root to admin (or handle TikTok OAuth callback)
app.get('/', (req, res) => {
  // TikTok OAuth redirects to root with auth_code param
  if (req.query.auth_code) {
    return res.redirect('/api/tiktok-leads/callback?auth_code=' + encodeURIComponent(req.query.auth_code));
  }
  res.redirect('/admin');
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    server_time: new Date().toLocaleString('en-US', { timeZoneName: 'short' })
  });
});

// DB size check and cleanup
app.get('/api/db-status', (req, res) => {
  try {
    const tables = db.prepare(`
      SELECT name, (SELECT COUNT(*) FROM pragma_table_info(name)) as columns
      FROM sqlite_master WHERE type='table' ORDER BY name
    `).all();
    const counts = {};
    for (const t of tables) {
      try { counts[t.name] = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c; } catch(e) { counts[t.name] = -1; }
    }
    // DB file size
    const fs = require('fs');
    const path = require('path');
    const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'coastal-debt.db')
      : path.join(__dirname, 'coastal-debt.db');
    let dbSize = 0;
    try { dbSize = fs.statSync(dbPath).size; } catch(e) {}
    res.json({ db_size_mb: (dbSize / 1024 / 1024).toFixed(1), table_counts: counts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cleanup old data to free disk space
app.post('/api/db-cleanup', (req, res) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth required' });
  try {
    const jwt = require('jsonwebtoken');
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'coastal-secret-key-change-in-production');
    if (!verified) return res.status(401).json({ error: 'Invalid token' });
  } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  try {
    const results = {};
    // Delete visitors older than 60 days that didn't convert
    results.old_visitors = db.prepare(`DELETE FROM visitors WHERE converted = 0 AND first_visit < datetime('now', '-60 days')`).changes;
    // Delete old activity logs (>90 days)
    try { results.old_activity = db.prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', '-90 days')`).changes; } catch(e) {}
    // Delete old ad generations that failed
    try { results.failed_ads = db.prepare(`DELETE FROM ad_generations WHERE status = 'failed' AND created_at < datetime('now', '-30 days')`).changes; } catch(e) {}
    // Vacuum to reclaim space
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    results.vacuumed = true;
    res.json({ message: 'Cleanup complete', deleted: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Regenerate all landing pages from DB on startup (Railway wipes filesystem on deploy)
try {
  const { generateLandingPage } = require('./routes/pages');
  const pages = db.prepare('SELECT id, slug FROM landing_pages').all();
  let count = 0;
  for (const page of pages) {
    try {
      generateLandingPage(page.id);
      count++;
    } catch (err) {
      console.error(`Failed to regenerate page "${page.slug}":`, err.message);
    }
  }
  if (count > 0) {
    console.log(`Regenerated ${count}/${pages.length} landing pages on startup`);
  }
} catch (err) {
  console.error('Failed to regenerate landing pages on startup:', err.message);
}

// Regenerate all articles from DB on startup
try {
  const { generateArticlePage } = require('./routes/articles');
  const articles = db.prepare('SELECT id, slug FROM articles').all();
  let articleCount = 0;
  for (const article of articles) {
    try {
      generateArticlePage(article.id);
      articleCount++;
    } catch (err) {
      console.error(`Failed to regenerate article "${article.slug}":`, err.message);
    }
  }
  if (articleCount > 0) {
    console.log(`Regenerated ${articleCount}/${articles.length} articles on startup`);
  }
} catch (err) {
  console.error('Failed to regenerate articles on startup:', err.message);
}

// Background alert rule evaluation - every 15 minutes
const { evaluateAlertRules } = require('./routes/notifications');
setInterval(evaluateAlertRules, 15 * 60 * 1000);
setTimeout(evaluateAlertRules, 30 * 1000); // Run once 30s after startup

// Background Google Ads cost fetching - every 15 minutes
const { fetchMissingCosts } = require('./routes/google-ads');
setInterval(fetchMissingCosts, 15 * 60 * 1000);
setTimeout(fetchMissingCosts, 60 * 1000); // First run 60s after startup

// Background TikTok cost fetching - every 15 minutes
const { fetchTikTokMissingCosts } = require('./routes/tiktok-leads');
setInterval(fetchTikTokMissingCosts, 15 * 60 * 1000);
setTimeout(fetchTikTokMissingCosts, 90 * 1000); // 90s after startup (staggered from Google's 60s)

// Background Reddit cost fetching - every 15 minutes
const { fetchRedditMissingCosts } = require('./routes/reddit-ads');
setInterval(fetchRedditMissingCosts, 15 * 60 * 1000);
setTimeout(fetchRedditMissingCosts, 120 * 1000); // 120s after startup (staggered)

// Background Auction Insights sync - every 6 hours
const { syncAuctionInsights } = require('./routes/analytics');
setInterval(syncAuctionInsights, 6 * 60 * 60 * 1000);
setTimeout(syncAuctionInsights, 150 * 1000); // First run 150s after startup (staggered)

// Start email worker (background queue processor + campaign scheduler)
const { startWorker: startEmailWorker } = require('./email-worker');
startEmailWorker();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);

  // Print Zapier webhook URL on startup
  try {
    const crypto = require('crypto');
    let zapKey = db.prepare('SELECT value FROM settings WHERE key = ?').get('zapier_api_key');
    if (!zapKey) {
      const newKey = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('zapier_api_key', newKey);
      zapKey = { value: newKey };
    }
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    console.log(`Zapier webhook: ${base}/api/leads/zapier?key=${zapKey.value}`);
  } catch (e) {}
});
