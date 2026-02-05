const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Default form fields
const defaultFormFields = [
  { name: 'has_mca', label: 'Do you have MCA (Merchant Cash Advance) debt?', type: 'radio', required: true, options: 'Yes,No' },
  { name: 'company_name', label: 'Company Name', type: 'text', required: true, placeholder: 'Your Company Name' },
  { name: 'full_name', label: 'Full Name', type: 'text', required: true, placeholder: 'John Smith' },
  { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'john@company.com' },
  { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: '(555) 123-4567' }
];

// Default content template
const defaultContent = {
  badge: "Bankruptcy Alternative",
  headline: "Don't File Bankruptcy.",
  headlineHighlight: "Up to 80% Less.",
  subheadline: "Thousands of business owners avoided bankruptcy by settling their debt through us. No court. No public record. Keep your business running.",
  bulletPoints: [
    "No public bankruptcy record",
    "Keep your business & assets",
    "Credit recovers in months, not years",
    "No court appearances or legal complexity"
  ],
  formTitle: "See If You Qualify",
  formSubtitle: "Takes 60 seconds. No obligation.",
  formButton: "Get My Free Debt Analysis",
  trustLabel: "As Seen In & Trusted By",
  comparisonTitle: "Why Business Owners Choose Debt Settlement Over Bankruptcy",
  howItWorksTitle: "How It Works",
  howItWorksSubtitle: "Our proven 3-step process has helped over 1,500 businesses avoid bankruptcy",
  steps: [
    { title: "Free Debt Analysis", description: "Tell us about your situation. We'll review your debt and show you exactly how much you could save without filing bankruptcy." },
    { title: "We Negotiate With Creditors", description: "Our team contacts your lenders directly. No lawyers, no court. We negotiate to reduce your total debt by 50-80%." },
    { title: "Debt Resolved, Business Saved", description: "Pay a fraction of what you owed. No bankruptcy on your record. Your business keeps running." }
  ],
  caseStudiesTitle: "Real Settlements. Real Savings.",
  caseStudiesSubtitle: "These are actual settlement agreements we negotiated for our clients",
  empathyTitle: "We Know This Is Hard. You're Not Alone.",
  empathyText: [
    "Facing the possibility of bankruptcy is one of the most stressful experiences a business owner can go through. The sleepless nights, the constant calls from creditors, the fear of losing everything you've built — we understand.",
    "But here's what we want you to know: there is another way. Every day, we help business owners just like you find a path forward without bankruptcy.",
    "You don't have to face this alone. Let us fight for you."
  ],
  testimonialsTitle: "Real People. Real Results.",
  testimonialsSubtitle: "Hear from business owners who found relief with Coastal Debt",
  ctaTitle: "Don't Let Bankruptcy Be Your Only Option",
  ctaSubtitle: "Free consultation. See how much you could save without filing.",
  ctaButton: "Get My Free Debt Analysis",
  phone: "(800) 123-4567",
  colors: {
    primary: "#3052FF",
    primaryLight: "#4a6aff",
    navy: "#1a2e4a",
    navyDark: "#0f1c2e"
  }
};

const defaultSectionsVisible = {
  trustBar: true,
  comparison: true,
  howItWorks: true,
  caseStudies: true,
  empathy: true,
  testimonials: true,
  faq: true,
  cta: true
};

// Get all landing pages
router.get('/', authenticateToken, (req, res) => {
  const pages = db.prepare(`
    SELECT lp.*, COUNT(l.id) as lead_count
    FROM landing_pages lp
    LEFT JOIN leads l ON lp.id = l.landing_page_id
    GROUP BY lp.id
    ORDER BY lp.created_at DESC
  `).all();

  pages.forEach(page => {
    try {
      page.content = JSON.parse(page.content || '{}');
      page.sections_visible = JSON.parse(page.sections_visible || '{}');
      page.hidden_fields = JSON.parse(page.hidden_fields || '{}');
    } catch (e) {}
  });

  res.json(pages);
});

// Get single landing page
router.get('/:id', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);

  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  try {
    page.content = JSON.parse(page.content || '{}');
    page.sections_visible = JSON.parse(page.sections_visible || '{}');
    page.hidden_fields = JSON.parse(page.hidden_fields || '{}');
  } catch (e) {}

  res.json(page);
});

// Create landing page
router.post('/', authenticateToken, (req, res) => {
  const { name, slug, platform, traffic_source, form_id } = req.body;

  if (!name || !slug) {
    return res.status(400).json({ error: 'Name and slug required' });
  }

  // Check slug is URL-safe
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    const result = db.prepare(`
      INSERT INTO landing_pages (name, slug, platform, traffic_source, form_id, content, sections_visible, hidden_fields)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      safeSlug,
      platform || 'other',
      traffic_source || '',
      form_id || null,
      JSON.stringify(defaultContent),
      JSON.stringify(defaultSectionsVisible),
      JSON.stringify({})
    );

    // Generate the landing page HTML
    generateLandingPage(result.lastInsertRowid);

    res.json({ id: result.lastInsertRowid, slug: safeSlug, message: 'Page created' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Slug already exists' });
    }
    res.status(500).json({ error: 'Failed to create page' });
  }
});

// Update landing page
router.put('/:id', authenticateToken, (req, res) => {
  const { name, slug, platform, traffic_source, webhook_url, form_id, content, sections_visible, hidden_fields, is_active } = req.body;

  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  const safeSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9-]/g, '-') : page.slug;

  db.prepare(`
    UPDATE landing_pages SET
      name = ?, slug = ?, platform = ?, traffic_source = ?, webhook_url = ?, form_id = ?,
      content = ?, sections_visible = ?, hidden_fields = ?, is_active = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || page.name,
    safeSlug,
    platform || page.platform,
    traffic_source !== undefined ? traffic_source : page.traffic_source,
    webhook_url !== undefined ? webhook_url : page.webhook_url,
    form_id !== undefined ? form_id : page.form_id,
    content ? JSON.stringify(content) : page.content,
    sections_visible ? JSON.stringify(sections_visible) : page.sections_visible,
    hidden_fields ? JSON.stringify(hidden_fields) : page.hidden_fields,
    is_active !== undefined ? (is_active ? 1 : 0) : page.is_active,
    req.params.id
  );

  // Regenerate the landing page HTML
  generateLandingPage(req.params.id);

  res.json({ message: 'Page updated' });
});

// Update landing page content only
router.put('/:id/content', authenticateToken, (req, res) => {
  const { content } = req.body;

  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(req.params.id);
  if (!page) {
    return res.status(404).json({ error: 'Page not found' });
  }

  db.prepare(`
    UPDATE landing_pages SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(JSON.stringify(content), req.params.id);

  // Regenerate the landing page HTML
  generateLandingPage(req.params.id);

  res.json({ message: 'Content updated' });
});

// Delete landing page
router.delete('/:id', authenticateToken, (req, res) => {
  const page = db.prepare('SELECT slug FROM landing_pages WHERE id = ?').get(req.params.id);

  if (page) {
    // Delete the generated HTML file
    const filePath = path.join(__dirname, '..', '..', 'public', page.slug);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true });
    }
  }

  db.prepare('DELETE FROM leads WHERE landing_page_id = ?').run(req.params.id);
  db.prepare('DELETE FROM landing_pages WHERE id = ?').run(req.params.id);

  res.json({ message: 'Page deleted' });
});

// Generate landing page HTML
function generateLandingPage(pageId) {
  const page = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(pageId);
  if (!page) return;

  const content = JSON.parse(page.content || '{}');
  const sectionsVisible = JSON.parse(page.sections_visible || '{}');
  const hiddenFields = JSON.parse(page.hidden_fields || '{}');

  // Get form if assigned
  let form = null;
  if (page.form_id) {
    form = db.prepare('SELECT * FROM forms WHERE id = ?').get(page.form_id);
    if (form) {
      form.fields = JSON.parse(form.fields || '[]');
    }
  }

  // Get all active scripts
  const allActiveScripts = db.prepare(`SELECT * FROM scripts WHERE is_active = 1`).all();

  // Filter scripts for this page (global or specifically assigned)
  const pageScripts = allActiveScripts.filter(s => {
    const pageIds = JSON.parse(s.landing_page_ids || '[]');
    return pageIds.length === 0 || pageIds.includes(pageId);
  });

  const headScripts = pageScripts.filter(s => s.position === 'head').map(s => s.code).join('\n');
  const bodyScripts = pageScripts.filter(s => s.position === 'body_start' || s.position === 'body_end').map(s => s.code).join('\n');

  // Generate hidden fields HTML
  const hiddenFieldsHtml = Object.entries(hiddenFields)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
    .join('\n            ');

  // Read the template and generate
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'landing-page.html');

  if (!fs.existsSync(templatePath)) {
    console.log('Template not found, skipping generation');
    return;
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Replace placeholders
  html = html.replace(/{{SLUG}}/g, page.slug);
  html = html.replace(/{{HEAD_SCRIPTS}}/g, headScripts);
  html = html.replace(/{{BODY_SCRIPTS}}/g, bodyScripts);
  html = html.replace(/{{HIDDEN_FIELDS}}/g, hiddenFieldsHtml);

  // Replace content placeholders
  Object.entries(content).forEach(([key, value]) => {
    if (typeof value === 'string') {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
  });

  // Handle colors
  if (content.colors) {
    Object.entries(content.colors).forEach(([key, value]) => {
      html = html.replace(new RegExp(`{{colors.${key}}}`, 'g'), value);
    });
  }

  // Handle JSON arrays for JavaScript
  html = html.replace(/{{bulletPointsJson}}/g, JSON.stringify(content.bulletPoints || []));
  html = html.replace(/{{stepsJson}}/g, JSON.stringify(content.steps || []));
  html = html.replace(/{{empathyTextJson}}/g, JSON.stringify(content.empathyText || []));

  // Handle form data
  const formFields = form ? form.fields : defaultFormFields;
  const formWebhook = page.webhook_url || (form ? form.webhook_url : '');
  const formSubmitText = form ? form.submit_button_text : content.formButton || 'Get My Free Debt Analysis';
  const formSuccessMsg = form ? form.success_message : 'Thank you! A debt specialist will call you within 15 minutes.';

  html = html.replace(/{{formFieldsJson}}/g, JSON.stringify(formFields));
  html = html.replace(/{{formWebhook}}/g, formWebhook);
  html = html.replace(/{{formSubmitText}}/g, formSubmitText);
  html = html.replace(/{{formSuccessMsg}}/g, formSuccessMsg);

  // Create the page directory and save
  const pageDir = path.join(__dirname, '..', '..', 'public', page.slug);
  if (!fs.existsSync(pageDir)) {
    fs.mkdirSync(pageDir, { recursive: true });
  }

  fs.writeFileSync(path.join(pageDir, 'index.html'), html);
  console.log(`Generated landing page: ${page.slug}`);
}

// Export the generate function
module.exports = router;
module.exports.generateLandingPage = generateLandingPage;
