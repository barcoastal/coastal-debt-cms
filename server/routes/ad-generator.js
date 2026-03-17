const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { authenticateToken } = require('./auth');

const midjourneyAdapter = require('../ai-adapters/midjourney');
const fluxAdapter = require('../ai-adapters/flux');
const geminiAdapter = require('../ai-adapters/gemini');

const router = express.Router();

// Encryption (same as settings.js)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'coastal-debt-cms-encryption-key-32';
const IV_LENGTH = 16;
function encryptValue(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}
function decryptValue(encrypted) {
  if (!encrypted || !encrypted.includes(':')) return null;
  try {
    const [ivHex, encHex] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

// Activity logging
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Upload directory
const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer for reference images
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = path.basename(file.originalname, ext).replace(/[^a-z0-9-_]/gi, '-');
    cb(null, `adref-${name}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .png, .jpg, .jpeg, .webp files are allowed'));
    }
  }
});

// ============ BRAND PRE-PROMPT ============

const BRAND_PREPROMPT = `You are generating a background image for a paid ad for Coastal Debt Resolve, a business debt settlement company (specializing in MCA — Merchant Cash Advance debt). Text, logos, and CTAs will be added separately in a design editor — do NOT include any text, words, letters, logos, watermarks, or UI elements in the image.

COASTAL DEBT RESOLVE — FULL BRAND GUIDELINES:

BRAND IDENTITY:
- Full Name: Coastal Debt Resolve (tagline: "RESOLVE")
- Mission: Help small business owners resolve MCA debt through ethical, transparent solutions
- Personality: Professional, empathetic, trustworthy, knowledgeable, empowering
- Tone: Warm but authoritative. Never condescending. No fear tactics.
- Emotional Journey: Acknowledge fear/shame → Build trust → Empower action → Celebrate freedom

COLOR PALETTE (use these colors strictly):
- Primary Blue "Future Blue": #3052FF (buttons, headers, accents)
- Light Background "Cyan Blue": #F2F4F9 (backgrounds)
- Accent Orange: #FF9000 (highlights, urgency, CTAs)
- Secondary Light Blue: #7FB2FF (secondary accents)
- Full Black: #000000 (text on light backgrounds)
- Full White: #FFFFFF (text on dark/blue backgrounds)

TYPOGRAPHY:
- Primary Font: Aeonik (Medium for headings/buttons, Regular for body)
- Min text size: 10pt. Three levels: Heading, Lead, Body.

PHOTOGRAPHY STYLE:
- People: Diverse men and women, ages 21-54, business owners and entrepreneurs
- Positive expressions and attitudes — NOT stressed or defeated
- Neutral color palette with blue or cool accents
- Settings: Interior/exterior of small businesses (bakeries, cafes, construction), offices, handshakes, business deals
- Close-ups: laptops, pens, desks, negotiations
- Neutral colors with blue or cool accents

DESIGN STYLE:
- Clean, modern layouts. Minimal clutter.
- Use white or light (#F2F4F9) backgrounds with blue accents
- Leave open space for text overlays
- Social media patterns: chevron shapes as design elements, curved edge text boxes
- Blue triangle shapes framing corners for stories

ICONS (if applicable):
- Line/stroke style ONLY (no solid fills)
- 3pt stroke weight, scales proportionally
- Blue stroke on white bg, OR white stroke on blue bg
- Business/finance subjects: shield, wallet, store, clock, handshake, chart

CONTRAST & BALANCE:
- All elements must contrast with background
- Use flat colors or contrasting photos for readability
- Don't overload with detail — leave breathing room
- Don't overlay text on people's faces
- Logo placement: top-left or top-right corner
- Website URL at bottom

CRITICAL: Generate ONLY a background image — NO text, NO words, NO letters, NO numbers, NO logos, NO buttons, NO call-to-action overlays. The image must be a clean visual that works as a backdrop for text and branding added in post-production.`;

// Size definitions
const AD_SIZES = [
  { label: 'feed_landscape', name: 'Feed / Landscape', width: 1200, height: 628, ar: '191:100', geminiAspect: '16:9' },
  { label: 'square', name: 'Square', width: 1080, height: 1080, ar: '1:1', geminiAspect: '1:1' },
  { label: 'story_reel', name: 'Story / Reel', width: 1080, height: 1920, ar: '9:16', geminiAspect: '9:16' },
  { label: 'carousel_square', name: 'Carousel Square', width: 1200, height: 1200, ar: '1:1', geminiAspect: '1:1' }
];

// ============ PROJECTS ============

// List all projects
router.get('/projects', authenticateToken, (req, res) => {
  const projects = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM ad_generations WHERE project_id = p.id) as generation_count,
      (SELECT model FROM ad_generations WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as last_model
    FROM ad_projects p
    ORDER BY p.created_at DESC
  `).all();

  projects.forEach(p => {
    try { p.reference_images = JSON.parse(p.reference_images || '[]'); } catch (e) { p.reference_images = []; }
  });

  res.json(projects);
});

// Create project
router.post('/projects', authenticateToken, (req, res) => {
  upload.array('reference_images', 3)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message });
      }
      return res.status(400).json({ error: err.message });
    }

    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });

    const referenceImages = (req.files || []).map(f => `/lp/uploads/${f.filename}`);

    try {
      const result = db.prepare(`
        INSERT INTO ad_projects (name, description, reference_images, created_by_id, created_by_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(name, description || '', JSON.stringify(referenceImages), req.user.id, req.user.name || req.user.email);

      if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'ad_project', result.lastInsertRowid, `Created ad project: ${name}`, req.ip);

      res.json({
        id: result.lastInsertRowid,
        name,
        description: description || '',
        reference_images: referenceImages,
        message: 'Project created'
      });
    } catch (err) {
      console.error('Create ad project error:', err);
      res.status(500).json({ error: 'Failed to create project' });
    }
  });
});

// Get single project with generations
router.get('/projects/:id', authenticateToken, (req, res) => {
  const project = db.prepare('SELECT * FROM ad_projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try { project.reference_images = JSON.parse(project.reference_images || '[]'); } catch (e) { project.reference_images = []; }

  const generations = db.prepare(`
    SELECT * FROM ad_generations WHERE project_id = ? ORDER BY created_at DESC
  `).all(req.params.id);

  res.json({ ...project, generations });
});

// Delete project
router.delete('/projects/:id', authenticateToken, (req, res) => {
  const project = db.prepare('SELECT name FROM ad_projects WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM ad_generations WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM ad_projects WHERE id = ?').run(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'ad_project', parseInt(req.params.id), `Deleted ad project: ${project?.name || req.params.id}`, req.ip);
  res.json({ message: 'Project deleted' });
});

// ============ REFERENCE IMAGE UPLOAD (no project) ============

router.post('/upload-references', authenticateToken, (req, res) => {
  upload.array('reference_images', 3)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    const urls = (req.files || []).map(f => `/lp/uploads/${f.filename}`);
    res.json({ urls });
  });
});

// ============ BRAND PRE-PROMPT ENDPOINT ============

router.get('/brand-preprompt', authenticateToken, (req, res) => {
  res.json({ preprompt: BRAND_PREPROMPT });
});

// Analyze reference images and generate a prompt
router.post('/analyze-references', authenticateToken, async (req, res) => {
  try {
    const { reference_image_urls } = req.body;
    if (!reference_image_urls || !reference_image_urls.length) {
      return res.status(400).json({ error: 'Reference images are required' });
    }

    const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    const geminiKey = getApiKey('gemini');

    if (!anthropicKey && !geminiKey) {
      return res.status(500).json({ error: 'No AI API key configured (need Anthropic or Gemini)' });
    }

    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    const analysisPrompt = `Analyze these reference ad images and generate a detailed image generation prompt that captures their visual style, composition, color palette, mood, and subject matter. The prompt should be suitable for AI image generation (like Midjourney/Flux/Imagen).

Focus on: visual style and aesthetic, color palette and lighting, composition and layout, subject matter and scene, mood and tone, distinctive design elements.

Return ONLY the prompt text, no explanation or preamble. 2-4 sentences, specific and descriptive.`;

    // Read image files from disk
    const imageData = [];
    for (const url of reference_image_urls) {
      const localPath = url.startsWith('/lp/uploads/')
        ? path.join(uploadsDir, url.replace('/lp/uploads/', ''))
        : null;
      if (localPath && fs.existsSync(localPath)) {
        const buffer = fs.readFileSync(localPath);
        const ext = path.extname(localPath).toLowerCase();
        imageData.push({ base64: buffer.toString('base64'), mimeType: mimeTypes[ext] || 'image/jpeg' });
      }
    }

    if (!imageData.length) {
      return res.status(400).json({ error: 'Could not read any reference images from disk' });
    }

    if (anthropicKey) {
      // Use Anthropic Claude with vision
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: anthropicKey });

      const content = [{ type: 'text', text: analysisPrompt }];
      for (const img of imageData) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
        });
      }

      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{ role: 'user', content }]
      });

      return res.json({ prompt: (message.content[0]?.text || '').trim() });
    }

    // Fallback: Gemini REST API (no SDK needed)
    const parts = [{ text: analysisPrompt }];
    for (const img of imageData) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );
    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ prompt: text.trim() });
  } catch (err) {
    console.error('Analyze references error:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze reference images' });
  }
});

// ============ GENERATION ============

// Start generation — supports single size (size_label) or all 4 sizes; project_id is optional
router.post('/generate', authenticateToken, (req, res) => {
  const { project_id, model, prompt, use_brand_prompt, custom_brand_prompt, size_label, reference_image_urls } = req.body;

  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt are required' });
  }

  if (!['midjourney', 'flux', 'gemini'].includes(model)) {
    return res.status(400).json({ error: 'Invalid model. Use: midjourney, flux, or gemini' });
  }

  // Determine reference images: from project (if given) or from request body
  let referenceImages = [];
  if (project_id) {
    const project = db.prepare('SELECT * FROM ad_projects WHERE id = ?').get(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try { referenceImages = JSON.parse(project.reference_images || '[]'); } catch (e) { referenceImages = []; }
  } else if (Array.isArray(reference_image_urls)) {
    referenceImages = reference_image_urls;
  }

  // Determine which sizes to generate
  let sizesToGenerate = AD_SIZES;
  if (size_label) {
    const found = AD_SIZES.find(s => s.label === size_label);
    if (!found) return res.status(400).json({ error: `Invalid size_label. Use: ${AD_SIZES.map(s => s.label).join(', ')}` });
    sizesToGenerate = [found];
  }

  const insert = db.prepare(`
    INSERT INTO ad_generations (project_id, model, prompt, size_label, width, height, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  const generationIds = [];
  for (const size of sizesToGenerate) {
    const result = insert.run(project_id || null, model, prompt, size.label, size.width, size.height);
    generationIds.push(result.lastInsertRowid);
  }

  // Fire-and-forget: process each generation in background
  const useBrand = use_brand_prompt !== false; // default true
  const brandPrompt = custom_brand_prompt || BRAND_PREPROMPT;
  for (let i = 0; i < sizesToGenerate.length; i++) {
    processGeneration(generationIds[i], model, prompt, referenceImages, sizesToGenerate[i], useBrand, brandPrompt);
  }

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'ad_generation', null, `Started ${model} generation${size_label ? ` (${size_label})` : ' (all sizes)'}`, req.ip);

  res.json({ generation_ids: generationIds, message: 'Generation started' });
});

// List all completed generations (gallery)
router.get('/generations', authenticateToken, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) as count FROM ad_generations WHERE status = 'completed' AND image_url IS NOT NULL`).get().count;
  const generations = db.prepare(`
    SELECT id, model, prompt, size_label, width, height, image_url, edited_image_url, created_at
    FROM ad_generations
    WHERE status = 'completed' AND image_url IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({ generations, total, page, pages: Math.ceil(total / limit) });
});

// Batch status check
router.get('/generations/batch-status', authenticateToken, (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean).map(Number);
  if (ids.length === 0) return res.json([]);

  const placeholders = ids.map(() => '?').join(',');
  const generations = db.prepare(`SELECT id, status, image_url, edited_image_url, error_message, size_label, width, height FROM ad_generations WHERE id IN (${placeholders})`).all(...ids);
  res.json(generations);
});

// Regenerate single size
router.post('/regenerate/:id', authenticateToken, (req, res) => {
  const gen = db.prepare('SELECT * FROM ad_generations WHERE id = ?').get(req.params.id);
  if (!gen) return res.status(404).json({ error: 'Generation not found' });

  let referenceImages = [];
  if (gen.project_id) {
    const project = db.prepare('SELECT * FROM ad_projects WHERE id = ?').get(gen.project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try { referenceImages = JSON.parse(project.reference_images || '[]'); } catch (e) { referenceImages = []; }
  }

  // Reset status
  db.prepare('UPDATE ad_generations SET status = ?, image_url = NULL, error_message = NULL, external_job_id = NULL, completed_at = NULL WHERE id = ?')
    .run('pending', gen.id);

  const size = AD_SIZES.find(s => s.label === gen.size_label) || AD_SIZES[0];
  processGeneration(gen.id, gen.model, gen.prompt, referenceImages, size);

  res.json({ message: 'Regeneration started' });
});

// ============ SETTINGS ============

const AI_SETTINGS_KEYS = ['useapi_key', 'replicate_key', 'gemini_key', 'useapi_discord', 'useapi_channel'];

router.get('/settings', authenticateToken, (req, res) => {
  const settings = {};
  for (const key of AI_SETTINGS_KEYS) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value) {
      // Mask encrypted keys, show plain text for non-secret values
      if (key.endsWith('_key')) {
        const decrypted = decryptValue(row.value);
        settings[key] = decrypted ? ('*'.repeat(Math.max(0, decrypted.length - 4)) + decrypted.slice(-4)) : '********';
      } else {
        settings[key] = row.value;
      }
    } else {
      settings[key] = '';
    }
  }
  res.json(settings);
});

router.post('/settings', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?');

  for (const key of AI_SETTINGS_KEYS) {
    if (req.body[key] !== undefined) {
      const val = req.body[key];
      // Don't save masked placeholders
      if (val && !val.match(/^\*+.{0,4}$/)) {
        if (key.endsWith('_key')) {
          const encrypted = encryptValue(val);
          upsert.run(key, encrypted, encrypted);
        } else {
          upsert.run(key, val, val);
        }
      }
    }
  }

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'ad_generator_settings', null, 'Updated AI API keys', req.ip);
  res.json({ message: 'Settings saved' });
});

// ============ LOGO ============

// Logo multer instance
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `ad-logo-${Date.now()}${ext}`);
  }
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .png, .jpg, .jpeg, .webp, .svg files are allowed'));
    }
  }
});

// Get stored logo URL
router.get('/logo', authenticateToken, (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('ad_generator_logo_url');
  res.json({ logo_url: row ? row.value : null });
});

// Upload logo
router.post('/logo', authenticateToken, (req, res) => {
  logoUpload.single('logo')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const logoUrl = `/lp/uploads/${req.file.filename}`;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run('ad_generator_logo_url', logoUrl, logoUrl);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'ad_generator_logo', null, 'Uploaded ad generator logo', req.ip);
    res.json({ logo_url: logoUrl, message: 'Logo uploaded' });
  });
});

// ============ SAVE EDIT ============

router.post('/generations/:id/save-edit', authenticateToken, async (req, res) => {
  const { image_base64 } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });

  const gen = db.prepare('SELECT id FROM ad_generations WHERE id = ?').get(req.params.id);
  if (!gen) return res.status(404).json({ error: 'Generation not found' });

  try {
    // Strip data URI prefix if present
    const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, '');
    const filename = `ad-edited-${gen.id}-${Date.now()}.png`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    const editedUrl = `/lp/uploads/${filename}`;
    db.prepare('UPDATE ad_generations SET edited_image_url = ? WHERE id = ?').run(editedUrl, gen.id);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'ad_generation', gen.id, 'Saved edited ad image', req.ip);
    res.json({ edited_image_url: editedUrl, message: 'Edit saved' });
  } catch (err) {
    console.error('Save edit error:', err);
    res.status(500).json({ error: 'Failed to save edited image' });
  }
});

// ============ GENERATE AD COPY (AI) ============

router.post('/generate-ad-copy', authenticateToken, async (req, res) => {
  const { prompt, size_label, full_design } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const fallback = { headline: 'Settle Your Business Debt', subheadline: 'Reduce what you owe by up to 80%', cta: 'Get a Free Consultation', badge: 'Debt Relief', phone: '(888) 979-9511' };

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) return res.json(fallback);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const sizeHint = size_label ? ` The ad size is "${size_label}".` : '';

    if (full_design) {
      // Full design mode: generate complete ad copy with layout guidance
      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `You are an expert direct-response ad copywriter and designer for Coastal Debt Resolve, a business debt settlement company. Create compelling ad copy for a paid ad.${sizeHint}

Ad concept: "${prompt}"

Generate copy that is punchy, emotional, and drives clicks. Use power words. The headline should stop the scroll.

Respond with ONLY valid JSON:
{
  "badge": "short badge/label text, 2-3 words (e.g. 'Debt Relief', 'Free Consultation', 'Limited Time')",
  "headline": "powerful main headline, max 6 words, all caps friendly",
  "subheadline": "supporting line, max 12 words, adds urgency or specifics",
  "cta": "call to action button text, max 5 words",
  "phone": "(888) 979-9511",
  "style": "dark_overlay or light_overlay or gradient_bar or minimal"
}`
        }]
      });

      const text = message.content[0].text.trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return res.json(fallback);

      const parsed = JSON.parse(match[0]);
      return res.json({
        badge: (parsed.badge || fallback.badge).slice(0, 30),
        headline: (parsed.headline || fallback.headline).slice(0, 80),
        subheadline: (parsed.subheadline || fallback.subheadline).slice(0, 100),
        cta: (parsed.cta || fallback.cta).slice(0, 40),
        phone: parsed.phone || fallback.phone,
        style: parsed.style || 'dark_overlay'
      });
    }

    // Simple mode (legacy)
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You write ad copy for Coastal Debt Resolve, a business debt settlement company. Given the ad prompt below, produce a short headline (max 8 words) and a CTA (max 5 words).${sizeHint}

Ad prompt: "${prompt}"

Respond with ONLY valid JSON: {"headline":"...","cta":"..."}`
      }]
    });

    const text = message.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.json(fallback);

    const parsed = JSON.parse(match[0]);
    res.json({
      headline: (parsed.headline || fallback.headline).slice(0, 80),
      cta: (parsed.cta || fallback.cta).slice(0, 40)
    });
  } catch (err) {
    console.error('Ad copy generation error:', err.message);
    res.json(fallback);
  }
});

// ============ BACKGROUND PROCESSING ============

async function processGeneration(genId, model, prompt, referenceImageUrls, size, useBrand = true, brandPrompt = null) {
  try {
    db.prepare('UPDATE ad_generations SET status = ? WHERE id = ?').run('processing', genId);

    const adapter = getAdapter(model);
    const apiKey = getApiKey(model);
    if (!apiKey) {
      throw new Error(`No API key configured for ${model}`);
    }

    const extraConfig = {};
    if (model === 'midjourney') {
      extraConfig.discord = db.prepare('SELECT value FROM settings WHERE key = ?').get('useapi_discord')?.value || '';
      extraConfig.channel = db.prepare('SELECT value FROM settings WHERE key = ?').get('useapi_channel')?.value || '';
    }

    // Build full prompt with optional brand pre-prompt
    const effectiveBrand = brandPrompt || BRAND_PREPROMPT;
    const fullPrompt = useBrand
      ? `${effectiveBrand}\n\nUSER REQUEST:\n${prompt}`
      : prompt;

    // Make absolute URLs from relative paths for external APIs
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const absoluteUrls = referenceImageUrls.map(u => u.startsWith('http') ? u : `${baseUrl}${u}`);

    const result = await adapter.generate(apiKey, fullPrompt, absoluteUrls, size, extraConfig);

    // Gemini returns synchronously
    if (result.status === 'completed') {
      if (result.imageBase64) {
        const localUrl = await saveBase64Image(genId, result.imageBase64);
        db.prepare('UPDATE ad_generations SET status = ?, image_url = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('completed', localUrl, genId);
      } else if (result.imageUrl) {
        const localUrl = await downloadAndSaveImage(genId, result.imageUrl);
        db.prepare('UPDATE ad_generations SET status = ?, image_url = ?, external_image_url = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('completed', localUrl, result.imageUrl, genId);
      }
      return;
    }

    // Async models: poll for completion
    let jobId = result.jobId;
    db.prepare('UPDATE ad_generations SET external_job_id = ? WHERE id = ?').run(jobId, genId);

    const maxAttempts = 120;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(5000);

      const statusResult = await adapter.checkStatus(apiKey, jobId, extraConfig);

      // Midjourney upscale returns a new job ID
      if (statusResult.jobId && statusResult.jobId !== jobId) {
        jobId = statusResult.jobId;
        db.prepare('UPDATE ad_generations SET external_job_id = ? WHERE id = ?').run(jobId, genId);
      }

      if (statusResult.status === 'completed' && statusResult.imageUrl) {
        const localUrl = await downloadAndSaveImage(genId, statusResult.imageUrl);
        db.prepare('UPDATE ad_generations SET status = ?, image_url = ?, external_image_url = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('completed', localUrl, statusResult.imageUrl, genId);
        return;
      }

      if (statusResult.status === 'failed') {
        throw new Error(statusResult.error || 'Generation failed');
      }
    }

    throw new Error('Generation timed out after 10 minutes');
  } catch (err) {
    console.error(`Ad generation #${genId} failed:`, err.message);
    db.prepare('UPDATE ad_generations SET status = ?, error_message = ? WHERE id = ?')
      .run('failed', err.message, genId);
  }
}

function getAdapter(model) {
  switch (model) {
    case 'midjourney': return midjourneyAdapter;
    case 'flux': return fluxAdapter;
    case 'gemini': return geminiAdapter;
    default: throw new Error(`Unknown model: ${model}`);
  }
}

function getApiKey(model) {
  const keyMap = { midjourney: 'useapi_key', flux: 'replicate_key', gemini: 'gemini_key' };
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(keyMap[model]);
  if (!row || !row.value) return null;
  return decryptValue(row.value);
}

async function saveBase64Image(genId, base64Data) {
  const filename = `ad-gen-${genId}-${Date.now()}.png`;
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  return `/lp/uploads/${filename}`;
}

async function downloadAndSaveImage(genId, imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = imageUrl.includes('.webp') ? '.webp' : '.png';
  const filename = `ad-gen-${genId}-${Date.now()}${ext}`;
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `/lp/uploads/${filename}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = router;
