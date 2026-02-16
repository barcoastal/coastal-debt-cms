const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Get all articles
router.get('/', authenticateToken, (req, res) => {
  const articles = db.prepare(`
    SELECT a.*, COUNT(l.id) as lead_count
    FROM articles a
    LEFT JOIN leads l ON a.id = l.article_id
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all();

  articles.forEach(article => {
    try { article.content = JSON.parse(article.content || '{}'); } catch (e) { article.content = {}; }
  });

  res.json(articles);
});

// Get single article
router.get('/:id', authenticateToken, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  try { article.content = JSON.parse(article.content || '{}'); } catch (e) { article.content = {}; }
  res.json(article);
});

// Create article
router.post('/', authenticateToken, (req, res) => {
  const { name, slug, headline, subheadline, body_html, author_name, author_title, publish_date,
          platform, traffic_source, form_id, content, meta_title, meta_description } = req.body;

  if (!name || !slug) return res.status(400).json({ error: 'Name and slug required' });

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    const result = db.prepare(`
      INSERT INTO articles (name, slug, headline, subheadline, body_html, author_name, author_title,
        publish_date, platform, traffic_source, form_id, content, meta_title, meta_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, safeSlug,
      headline || '', subheadline || '', body_html || '',
      author_name || 'Sarah Mitchell', author_title || 'Senior Business Correspondent',
      publish_date || new Date().toISOString().split('T')[0],
      platform || 'outbrain', traffic_source || '',
      form_id || null,
      content ? JSON.stringify(content) : '{}',
      meta_title || '', meta_description || ''
    );

    generateArticlePage(result.lastInsertRowid);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'article', result.lastInsertRowid, `Created article: ${name}`, req.ip);
    res.json({ id: result.lastInsertRowid, slug: safeSlug, message: 'Article created' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Slug already exists' });
    console.error('Failed to create article:', err);
    res.status(500).json({ error: 'Failed to create article' });
  }
});

// Update article
router.put('/:id', authenticateToken, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const { name, slug, headline, subheadline, body_html, author_name, author_title, publish_date,
          platform, traffic_source, form_id, content, meta_title, meta_description, is_active } = req.body;

  const safeSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9-]/g, '-') : article.slug;

  db.prepare(`
    UPDATE articles SET
      name = ?, slug = ?, headline = ?, subheadline = ?, body_html = ?,
      author_name = ?, author_title = ?, publish_date = ?,
      platform = ?, traffic_source = ?, form_id = ?,
      content = ?, meta_title = ?, meta_description = ?,
      is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || article.name,
    safeSlug,
    headline !== undefined ? headline : article.headline,
    subheadline !== undefined ? subheadline : article.subheadline,
    body_html !== undefined ? body_html : article.body_html,
    author_name || article.author_name,
    author_title || article.author_title,
    publish_date || article.publish_date,
    platform || article.platform,
    traffic_source !== undefined ? traffic_source : article.traffic_source,
    form_id !== undefined ? form_id : article.form_id,
    content ? JSON.stringify(content) : article.content,
    meta_title !== undefined ? meta_title : article.meta_title,
    meta_description !== undefined ? meta_description : article.meta_description,
    is_active !== undefined ? (is_active ? 1 : 0) : article.is_active,
    req.params.id
  );

  generateArticlePage(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'article', parseInt(req.params.id), `Updated article: ${name || article.name}`, req.ip);
  res.json({ message: 'Article updated' });
});

// Delete article
router.delete('/:id', authenticateToken, (req, res) => {
  const article = db.prepare('SELECT slug FROM articles WHERE id = ?').get(req.params.id);

  if (article) {
    const filePath = path.join(__dirname, '..', '..', 'public', 'articles', article.slug);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true });
    }
  }

  db.prepare('UPDATE leads SET article_id = NULL WHERE article_id = ?').run(req.params.id);
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'article', parseInt(req.params.id), `Deleted article: ${article?.slug || req.params.id}`, req.ip);
  res.json({ message: 'Article deleted' });
});

// Regenerate all articles
router.post('/regenerate-all', authenticateToken, (req, res) => {
  const articles = db.prepare('SELECT id, slug FROM articles').all();
  let count = 0;
  for (const article of articles) {
    try {
      generateArticlePage(article.id);
      count++;
    } catch (err) {
      console.error(`Failed to regenerate article ${article.slug}:`, err);
    }
  }
  res.json({ message: `Regenerated ${count} articles` });
});

// Generate article HTML
function generateArticlePage(articleId) {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) return;

  const content = JSON.parse(article.content || '{}');

  // Get form if assigned
  let form = null;
  if (article.form_id) {
    form = db.prepare('SELECT * FROM forms WHERE id = ?').get(article.form_id);
    if (form) form.fields = JSON.parse(form.fields || '[]');
  }

  // Get active scripts (global only for articles)
  const allActiveScripts = db.prepare('SELECT * FROM scripts WHERE is_active = 1').all();
  const globalScripts = allActiveScripts.filter(s => {
    const pageIds = JSON.parse(s.landing_page_ids || '[]');
    return pageIds.length === 0;
  });

  const headScripts = globalScripts.filter(s => s.position === 'head').map(s => s.code).join('\n');
  const bodyScripts = globalScripts.filter(s => s.position === 'body_start' || s.position === 'body_end').map(s => s.code).join('\n');

  // Read template
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'article-page.html');
  if (!fs.existsSync(templatePath)) {
    console.log('Article template not found, skipping generation');
    return;
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Split body_html at {{MID_ARTICLE_FORM}} marker
  const bodyHtml = article.body_html || '';
  const formMarker = '{{MID_ARTICLE_FORM}}';
  let bodyBefore = bodyHtml;
  let bodyAfter = '';
  const markerIndex = bodyHtml.indexOf(formMarker);
  if (markerIndex !== -1) {
    bodyBefore = bodyHtml.substring(0, markerIndex);
    bodyAfter = bodyHtml.substring(markerIndex + formMarker.length);
  }

  // Format publish date
  let publishDate = article.publish_date || '';
  if (publishDate) {
    try {
      const d = new Date(publishDate + 'T00:00:00');
      publishDate = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {}
  }

  // Form data
  const formFields = form ? form.fields : [];
  const formSubmitText = form ? form.submit_button_text : 'Get My Free Consultation';
  const formSuccessMsg = form ? form.success_message : 'Thank you! A debt relief specialist will contact you shortly.';
  const formTitle = content.formTitle || 'See If Your Business Qualifies';
  const formSubtitle = content.formSubtitle || 'Free, no-obligation analysis. Takes 60 seconds.';
  const endFormTitle = content.endFormTitle || formTitle;
  const endFormSubtitle = content.endFormSubtitle || formSubtitle;

  // Hidden fields HTML
  const hiddenFieldsHtml = '';

  // Replace all placeholders
  html = html.replace(/{{SLUG}}/g, article.slug);
  html = html.replace(/{{HEAD_SCRIPTS}}/g, headScripts);
  html = html.replace(/{{BODY_SCRIPTS}}/g, bodyScripts);
  html = html.replace(/{{META_TITLE}}/g, article.meta_title || article.headline || article.name);
  html = html.replace(/{{META_DESCRIPTION}}/g, article.meta_description || article.subheadline || '');
  html = html.replace(/{{HEADLINE}}/g, article.headline || '');
  html = html.replace(/{{SUBHEADLINE}}/g, article.subheadline || '');
  html = html.replace(/{{AUTHOR_NAME}}/g, article.author_name || 'Staff Writer');
  html = html.replace(/{{AUTHOR_TITLE}}/g, article.author_title || '');
  html = html.replace(/{{PUBLISH_DATE}}/g, publishDate);
  html = html.replace(/{{BODY_BEFORE_FORM}}/g, bodyBefore);
  html = html.replace(/{{BODY_AFTER_FORM}}/g, bodyAfter);
  html = html.replace(/{{FORM_TITLE}}/g, formTitle);
  html = html.replace(/{{FORM_SUBTITLE}}/g, formSubtitle);
  html = html.replace(/{{END_FORM_TITLE}}/g, endFormTitle);
  html = html.replace(/{{END_FORM_SUBTITLE}}/g, endFormSubtitle);
  html = html.replace(/{{FORM_SUBMIT_TEXT}}/g, formSubmitText);
  html = html.replace(/{{FORM_SUCCESS_MSG}}/g, formSuccessMsg);
  html = html.replace(/{{FORM_FIELDS_JSON}}/g, JSON.stringify(formFields));
  html = html.replace(/{{HIDDEN_FIELDS}}/g, hiddenFieldsHtml);

  // Inject branding from settings
  try {
    const brandingRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('favicon_url', 'meta_image_url', 'site_name')").all();
    const branding = {};
    brandingRows.forEach(r => { branding[r.key] = r.value; });

    let brandingTags = '';
    if (branding.favicon_url) brandingTags += `\n  <link rel="icon" href="${branding.favicon_url}">`;
    if (branding.meta_image_url) brandingTags += `\n  <meta property="og:image" content="${branding.meta_image_url}">`;
    if (branding.site_name) brandingTags += `\n  <meta property="og:site_name" content="${branding.site_name}">`;
    if (brandingTags) html = html.replace('</head>', brandingTags + '\n</head>');
  } catch (err) {
    console.error('Failed to inject branding into article:', err);
  }

  // Write to public/articles/[slug]/index.html
  const articleDir = path.join(__dirname, '..', '..', 'public', 'articles', article.slug);
  if (!fs.existsSync(articleDir)) {
    fs.mkdirSync(articleDir, { recursive: true });
  }

  fs.writeFileSync(path.join(articleDir, 'index.html'), html);
  console.log(`Generated article page: ${article.slug}`);
}

module.exports = router;
module.exports.generateArticlePage = generateArticlePage;
