const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import logActivity (loaded after initialization to avoid circular deps)
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Default form fields
const defaultFormFields = [
  { name: 'has_mca', label: 'Do you have MCA (Merchant Cash Advance) debt?', type: 'radio', required: true, options: 'Yes,No' },
  { name: 'company_name', label: 'Company Name', type: 'text', required: true, placeholder: 'Your Company Name' },
  { name: 'first_name', label: 'First Name', type: 'text', required: true, placeholder: 'John' },
  { name: 'last_name', label: 'Last Name', type: 'text', required: true, placeholder: 'Smith' },
  { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'john@company.com' },
  { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: '(555) 123-4567' }
];

// Default content template
const defaultContent = {
  badge: "MCA Debt Relief",
  headline: "Drowning in MCA Debt?",
  headlineLine2: "Settle Your MCA Debt for",
  headlineHighlight: "Up to 80% Less.",
  subheadline: "Thousands of business owners escaped crushing MCA payments by settling their debt through us. Stop the daily ACH withdrawals. Keep your business running.",
  bulletPoints: [
    "Stop daily/weekly ACH withdrawals",
    "Reduce your total MCA balance by 50-80%",
    "Keep your business & revenue",
    "No upfront fees — we get paid when you save"
  ],
  formTitle: "See If You Qualify",
  formSubtitle: "Takes 60 seconds. No obligation.",
  formButton: "Get My Free MCA Analysis",
  trustLabel: "As Seen In & Trusted By",
  comparisonTitle: "Why Business Owners Choose MCA Debt Settlement",
  howItWorksTitle: "How It Works",
  howItWorksSubtitle: "Our proven 3-step process has helped over 1,500 businesses resolve MCA debt",
  steps: [
    { title: "Free MCA Debt Analysis", description: "Tell us about your MCA debt. We'll review your advances and show you exactly how much you could save through settlement." },
    { title: "We Negotiate With Your MCA Lenders", description: "Our team contacts your MCA companies directly. We negotiate to reduce your total debt by 50-80% and stop the daily withdrawals." },
    { title: "Debt Resolved, Business Saved", description: "Pay a fraction of what you owed. Your daily ACH payments stop. Your cash flow recovers and your business keeps running." }
  ],
  caseStudiesTitle: "Real MCA Settlements. Real Savings.",
  caseStudiesSubtitle: "These are actual MCA settlement agreements we negotiated for our clients",
  empathyTitle: "We Know MCA Debt Is Crushing. You're Not Alone.",
  empathyText: [
    "When MCA companies are draining your bank account every single day, it feels like there's no way out. The stacked advances, the confusing factor rates, the aggressive collections — we understand what you're going through.",
    "But here's what we want you to know: MCA debt can be settled for a fraction of what you owe. Every day, we help business owners just like you break free from the MCA debt cycle.",
    "You don't have to face this alone. Let us fight for you."
  ],
  testimonialsTitle: "Real People. Real Results.",
  testimonialsSubtitle: "Hear from business owners who found MCA debt relief with Coastal Debt",
  ctaTitle: "Stop the Daily MCA Withdrawals Today",
  ctaSubtitle: "Free consultation. See how much of your MCA debt we can settle.",
  ctaButton: "Get My Free MCA Analysis",
  pageTitle: "MCA Debt Relief | Settle Merchant Cash Advance Debt for 50-80% Less",
  metaDescription: "Struggling with MCA debt? Settle your Merchant Cash Advance debt for a fraction of what you owe. Stop daily ACH withdrawals. Free consultation.",
  comparisonSubtitle: "See why thousands of business owners chose settlement over continuing MCA payments",
  comparisonColBad: "Keeping MCA Debt",
  comparisonColGood: "MCA Debt Settlement",
  comparisonRows: [
    { label: "Daily Payments", bad: "Continue daily/weekly ACH drains", good: "Payments stop during negotiation" },
    { label: "Total Cost", bad: "Pay back 1.3x-1.5x the advance", good: "Settle for 50-80% less" },
    { label: "Cash Flow", bad: "Strangled by daily withdrawals", good: "Cash flow recovers immediately" },
    { label: "Stacked Advances", bad: "Cycle of borrowing to repay", good: "Resolve all MCAs at once" },
    { label: "Time to Resolve", bad: "Trapped for 6-18 months", good: "3-6 months average" },
    { label: "Your Business", bad: "Risk of closure from cash drain", good: "Keep operating and growing" },
    { label: "Future Financing", bad: "Stuck in MCA cycle", good: "Access better financing options" }
  ],
  comparisonCtaText: "See How Much You Could Save on Your MCA Debt",
  faqTitle: "MCA Debt Questions? We Have Answers.",
  faqSubtitle: "Get the facts about MCA debt settlement",
  faqItems: [
    { question: "Can MCA debt really be settled for less?", answer: "Yes. MCA companies often accept 20-50 cents on the dollar through negotiated settlements. We've helped thousands of businesses reduce their MCA debt by 50-80%." },
    { question: "Will the daily ACH withdrawals stop?", answer: "Yes. Once we begin negotiating on your behalf, we work to stop the daily or weekly ACH withdrawals from your bank account so your cash flow can recover." },
    { question: "I have multiple stacked MCAs — can you help?", answer: "Absolutely. Stacked MCAs are our specialty. We negotiate with all of your MCA lenders simultaneously to resolve all your advances at once." },
    { question: "How long does MCA debt settlement take?", answer: "Most MCA settlements are completed in 3-6 months, depending on the number of advances and the lenders involved." },
    { question: "Will this affect my credit score?", answer: "MCA debt is typically not reported to credit bureaus, so settlement usually has no impact on your personal credit score." },
    { question: "What if an MCA company is threatening legal action?", answer: "Don't panic. Many MCA companies threaten lawsuits as a collection tactic. We deal with MCA lenders every day and know how to negotiate even in aggressive situations. Contact us immediately so we can help." }
  ],
  phone: "",
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
    const saved = JSON.parse(page.content || '{}');
    // Merge with defaults so editor fields show actual values
    page.content = { ...defaultContent, ...saved, colors: { ...defaultContent.colors, ...(saved.colors || {}) } };
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

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'page', result.lastInsertRowid, `Created page: ${name}`, req.ip);
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

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'page', parseInt(req.params.id), `Updated page: ${name || page.name}`, req.ip);
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

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'page', parseInt(req.params.id), `Deleted page: ${page?.slug || req.params.id}`, req.ip);
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

  // Generate hidden fields HTML (skip names already hardcoded in the template)
  const HARDCODED_HIDDEN = new Set([
    'gclid','msclkid','fbclid','rt_clickid','eli_clickid','keyword',
    'fb_campaign_id','fb_adset_id','fb_ad_id','fb_campaign_name',
    'fb_adset_name','fb_ad_name','fb_placement','visitor_ip',
    'page_url','referrer_url','landing_page_slug','debt_amount','has_mca'
  ]);
  const hiddenFieldsHtml = Object.entries(hiddenFields)
    .filter(([key]) => !HARDCODED_HIDDEN.has(key))
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
    .join('\n            ');

  // Read the template and generate
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'landing-page.html');

  if (!fs.existsSync(templatePath)) {
    console.log('Template not found, skipping generation');
    return;
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Get Facebook Pixel ID from config
  let fbPixelId = '';
  try {
    const fbConfig = db.prepare('SELECT pixel_id FROM facebook_config WHERE id = 1').get();
    fbPixelId = fbConfig?.pixel_id || '';
  } catch (e) {}

  // Replace placeholders
  html = html.replace(/{{SLUG}}/g, page.slug);
  html = html.replace(/{{HEAD_SCRIPTS}}/g, headScripts);
  html = html.replace(/{{BODY_SCRIPTS}}/g, bodyScripts);
  html = html.replace(/{{HIDDEN_FIELDS}}/g, hiddenFieldsHtml);
  html = html.replace(/{{FB_PIXEL_ID}}/g, fbPixelId);

  // Merge content with defaults so all template placeholders get replaced
  // If a field is explicitly set (even to empty string), respect it
  const mergedContent = { ...defaultContent };
  Object.entries(content).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      mergedContent[key] = value;
    }
  });

  // Deep merge colors so partial overrides don't lose defaults
  mergedContent.colors = { ...defaultContent.colors, ...(content.colors || {}) };

  // Replace content placeholders
  Object.entries(mergedContent).forEach(([key, value]) => {
    if (typeof value === 'string') {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
  });

  // Handle colors
  if (mergedContent.colors) {
    Object.entries(mergedContent.colors).forEach(([key, value]) => {
      html = html.replace(new RegExp(`{{colors.${key}}}`, 'g'), value);
    });
  }

  // Handle JSON arrays for JavaScript
  html = html.replace(/{{bulletPointsJson}}/g, JSON.stringify(mergedContent.bulletPoints || []));
  html = html.replace(/{{stepsJson}}/g, JSON.stringify(mergedContent.steps || []));
  html = html.replace(/{{empathyTextJson}}/g, JSON.stringify(mergedContent.empathyText || []));
  html = html.replace(/{{comparisonRowsJson}}/g, JSON.stringify(mergedContent.comparisonRows || []));
  html = html.replace(/{{faqItemsJson}}/g, JSON.stringify(mergedContent.faqItems || []));

  // Handle form data
  const formFields = form ? form.fields : defaultFormFields;
  const formWebhook = page.webhook_url || (form ? form.webhook_url : '');
  const formSubmitText = form ? form.submit_button_text : content.formButton || 'Get My Free Debt Analysis';
  const formSuccessMsg = form ? form.success_message : 'Thank you! A debt specialist will call you within 15 minutes.';

  const skipPreQual = form ? (form.skip_pre_qual ? true : false) : false;

  html = html.replace(/{{formFieldsJson}}/g, JSON.stringify(formFields));
  html = html.replace(/{{formWebhook}}/g, formWebhook);
  html = html.replace(/{{formSubmitText}}/g, formSubmitText);
  html = html.replace(/{{formSuccessMsg}}/g, formSuccessMsg);
  html = html.replace(/{{skipPreQual}}/g, String(skipPreQual));

  // Remove phone elements if no phone number is set
  if (!mergedContent.phone) {
    // Remove all elements with phone-element class (handles multi-line blocks)
    html = html.replace(/<a[^>]*phone-element[\s\S]*?<\/a>/g, '');
    html = html.replace(/<p[^>]*phone-element[\s\S]*?<\/p>/g, '');
    html = html.replace(/<div[^>]*phone-element[\s\S]*?<\/div>/g, '');
  }

  // Inject branding from settings
  try {
    const brandingRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('favicon_url', 'meta_image_url', 'site_name')").all();
    const branding = {};
    brandingRows.forEach(r => { branding[r.key] = r.value; });

    let brandingTags = '';
    if (branding.favicon_url) {
      brandingTags += `\n  <link rel="icon" href="${branding.favicon_url}">`;
    }
    if (branding.meta_image_url) {
      brandingTags += `\n  <meta property="og:image" content="${branding.meta_image_url}">`;
    }
    if (branding.site_name) {
      brandingTags += `\n  <meta property="og:site_name" content="${branding.site_name}">`;
    }
    if (brandingTags) {
      html = html.replace('</head>', brandingTags + '\n</head>');
    }
  } catch (err) {
    console.error('Failed to inject branding:', err);
  }

  // Create the page directory and save
  const pageDir = path.join(__dirname, '..', '..', 'public', page.slug);
  if (!fs.existsSync(pageDir)) {
    fs.mkdirSync(pageDir, { recursive: true });
  }

  fs.writeFileSync(path.join(pageDir, 'index.html'), html);
  console.log(`Generated landing page: ${page.slug}`);
}

// Regenerate all landing pages (useful after template changes)
router.post('/regenerate-all', authenticateToken, (req, res) => {
  const pages = db.prepare('SELECT id, slug FROM landing_pages').all();
  let count = 0;
  for (const page of pages) {
    try {
      generateLandingPage(page.id);
      count++;
    } catch (err) {
      console.error(`Failed to regenerate page ${page.slug}:`, err);
    }
  }
  res.json({ message: `Regenerated ${count} landing pages` });
});

// Export the generate function
module.exports = router;
module.exports.generateLandingPage = generateLandingPage;
