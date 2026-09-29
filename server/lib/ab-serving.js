const fs = require('fs');
const path = require('path');
const { configOf } = require('./ab-store');

module.exports = function abServing(db, store, publicDir) {
  return (req, res, next) => {
    const slug = /^\/([^/.]+)\/?(?:index\.html)?$/.exec(req.path)?.[1];
    if (!slug || !['GET', 'HEAD'].includes(req.method)) return next();
    try {
      const page = db.prepare('SELECT * FROM landing_pages WHERE slug = ?').get(slug);
      if (!page) return next();
      const cfg = configOf(page);
      if (!cfg.enabled) return next();
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('CDN-Cache-Control', 'no-store');
      res.vary('Cookie');
      const aPath = path.join(publicDir, slug, 'index.html');
      let bPath = aPath;
      if (cfg.variantB_page) {
        const b = db.prepare('SELECT slug FROM landing_pages WHERE id = ?').get(cfg.variantB_page);
        bPath = b ? path.join(publicDir, b.slug, 'index.html') : '';
      } else if (cfg.variantB_template) bPath = path.join(publicDir, slug, 'variant-b.html');
      // Never label an A fallback as B when its configured page is unavailable.
      if (!fs.existsSync(aPath) || !bPath || !fs.existsSync(bPath)) return next();
      const run = store.sync(page);
      const p = store.assign(run, req.cookies?.[`ab_session_${page.id}`], req.cookies?.[`ab_${page.id}`]);
      const cookieOptions = { maxAge: 30 * 86400000, path: '/', sameSite: 'lax', secure: req.secure };
      res.cookie(`ab_session_${page.id}`, p.token, { ...cookieOptions, httpOnly: true });
      res.cookie(`ab_${page.id}`, p.variant, cookieOptions);
      const context = `<script>window._abVariant=${JSON.stringify(p.variant)};window._abTestPageId=${page.id};window._abExposure=${JSON.stringify(p.token)};</script><script src="/assets/ab-tracking.js?v=1" defer></script>`;
      let html = fs.readFileSync(p.variant === 'B' ? bPath : aPath, 'utf8');
      html = html.replace(/<head[^>]*>/i, match => match + context);
      res.type('html').send(html);
    } catch (err) { console.error('[A/B tracking]', err.message); next(); }
  };
};
