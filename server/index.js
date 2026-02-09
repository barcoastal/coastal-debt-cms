const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

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

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for Railway/Cloudflare)
app.set('trust proxy', 1);

// Middleware
app.use(compression()); // Gzip compression - reduces file size by ~70%
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve admin static files (no cache - always fresh)
app.use('/admin', express.static(path.join(__dirname, '..', 'admin'), {
  maxAge: 0,
  etag: true
}));

// Serve generated landing pages with cache headers
const isProduction = !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
app.use('/lp', (req, res, next) => {
  if (isProduction) {
    // Production: cache for Cloudflare CDN
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    res.setHeader('CDN-Cache-Control', 'max-age=86400');
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

// Redirect root to admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint - check what cookies the server sees (remove after debugging)
app.get('/api/debug/cookies', (req, res) => {
  res.json({
    cookies: req.cookies,
    rtkclickid: req.cookies?.['rtkclickid-store'] || 'NOT FOUND',
    allCookieNames: Object.keys(req.cookies || {}),
    rawCookieHeader: req.headers.cookie || 'NO COOKIE HEADER'
  });
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
