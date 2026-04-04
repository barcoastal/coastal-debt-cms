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
const { buildPrompt, validateConfig, PROMPT_OPTIONS } = require('../services/prompt-builder');
const backgroundRemover = require('../services/background-remover');
const { composeAd, recomposeAd } = require('../services/ad-compositor');

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
- IMPORTANT: Vary gender equally — include men just as often as women. Alternate between male and female subjects across different ads. Do NOT default to always showing women.
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
// Parse AI response into a structured design blueprint
function parseDesignBlueprint(rawText) {
  const defaults = {
    prompt: '',
    text_position: 'top',
    text_color: '#FFFFFF',
    overlay_style: 'none',
    bg_is_dark: true,
    bg_dominant_color: '#3052FF',
    visual_elements_position: 'center',
    open_space_for_text: 'top',
    cta_style: 'bottom_bar',
    logo_size: 'small',
    text_style: 'clean_modern',
    layout_notes: ''
  };

  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fallback: treat entire text as a prompt
      return { ...defaults, prompt: rawText.trim() };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      prompt: (parsed.image_prompt || parsed.prompt || rawText).trim(),
      text_position: parsed.text_position || defaults.text_position,
      text_color: parsed.text_color || defaults.text_color,
      overlay_style: parsed.overlay_style || defaults.overlay_style,
      bg_is_dark: parsed.bg_is_dark !== undefined ? parsed.bg_is_dark : defaults.bg_is_dark,
      bg_dominant_color: parsed.bg_dominant_color || defaults.bg_dominant_color,
      visual_elements_position: parsed.visual_elements_position || defaults.visual_elements_position,
      open_space_for_text: parsed.open_space_for_text || defaults.open_space_for_text,
      cta_style: parsed.cta_style || defaults.cta_style,
      logo_size: parsed.logo_size || defaults.logo_size,
      text_style: parsed.text_style || defaults.text_style,
      layout_notes: parsed.layout_notes || defaults.layout_notes
    };
  } catch (e) {
    console.error('Failed to parse design blueprint JSON:', e.message);
    return { ...defaults, prompt: rawText.trim() };
  }
}

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
    const analysisPrompt = `You are an expert art director and ad designer. Study these reference ad images for INSPIRATION. Your job is to produce a design blueprint for creating NEW ads that capture the same FEEL, STYLE, and ENERGY — but are NOT identical copies. Think of the references as mood boards.

Think step by step about every visual detail:

## STEP 1: DEEP ANALYSIS
Look at each reference image carefully and identify:
- What is the visual scene? Describe the objects, people, props you see (ignore text/logos)
- What MOOD and ENERGY does the ad convey? (bold, calm, urgent, professional, etc.)
- What is the background style? Solid color, gradient, photo, or mixed?
- What is the dominant color palette?
- What is the composition style? Where are visual elements vs. empty space?
- Where does the text sit? Top? Middle? Bottom? Over the image or on empty colored space?
- Is there a dark overlay/gradient, or does text sit directly on the background?
- Is there a CTA button? Where? What style?
- How big is the logo relative to the overall ad? (small=5-8% of height, medium=8-12%, large=12%+)

## STEP 2: DESIGN BLUEPRINT (return as JSON)
Create a FRESH ad concept INSPIRED by the references — same style/mood but a DIFFERENT scene or angle. Don't copy the exact same image. Instead, create a new variation that feels like it belongs in the same campaign.

Return ONLY valid JSON:

{
  "image_prompt": "A creative, FRESH scene inspired by the reference style but NOT a copy. Same mood, color palette, and energy — but a different subject, angle, or composition. Describe the visual scene specifically: objects, people, props, colors, lighting, composition. Be concrete like directing a photographer. IMPORTANT: Vary gender — use male subjects (men, businessmen) just as often as female. Do NOT always default to women. MUST end with: no text, no words, no letters, no logos, no watermarks",
  "text_position": "top" | "middle" | "bottom",
  "text_color": "#FFFFFF" or another color that contrasts with the background,
  "overlay_style": "none" | "subtle_gradient",
  "bg_is_dark": true | false,
  "bg_dominant_color": "#hex color of the main background",
  "visual_elements_position": "center" | "right" | "left" | "bottom" | "spread",
  "open_space_for_text": "top" | "top-left" | "top-right" | "left" | "bottom",
  "logo_size": "small" | "medium" | "large",
  "text_style": "bold_impact" | "editorial" | "clean_modern" | "condensed_power" | "elegant_sans" | "tall_stark",
  "layout_notes": "Brief description of how text, visuals, and CTA are arranged"
}

TEXT STYLE GUIDE (pick the one that best matches the reference mood):
- "bold_impact": Heavy Montserrat Black, all caps, orange accent bar — for aggressive/urgent ads
- "editorial": Playfair Display serif headlines, elegant & sophisticated — for premium/trust ads
- "clean_modern": Outfit font, rounded & friendly, pill badges — for approachable/modern ads
- "condensed_power": Bebas Neue tall condensed, wide letter spacing — for bold/punchy statements
- "elegant_sans": Plus Jakarta Sans, polished & refined — for professional/corporate ads
- "tall_stark": Oswald semi-condensed, strong & direct — for clear/straightforward messaging

IMPORTANT:
- The image_prompt should be INSPIRED by the references, NOT a 1:1 copy — create a fresh variation
- The image_prompt is for generating ONLY the background visual (no text/logos — those are added in post)
- Be specific in image_prompt — describe exact objects, exact colors, exact placement
- Match the reference's color palette and mood, but vary the subject matter
- logo_size should match what you see in the references

Return ONLY the JSON, no explanation.`;

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
        max_tokens: 1200,
        messages: [{ role: 'user', content }]
      });

      const rawText = (message.content[0]?.text || '').trim();
      return res.json(parseDesignBlueprint(rawText));
    }

    // Fallback: Gemini REST API (no SDK needed)
    const parts = [{ text: analysisPrompt }];
    for (const img of imageData) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );
    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json(parseDesignBlueprint(text));
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

// Brand asset uploads
const brandAssetStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = path.basename(file.originalname, ext).replace(/[^a-z0-9-_]/gi, '-');
    cb(null, `brand-asset-${name}-${Date.now()}${ext}`);
  }
});
const brandAssetUpload = multer({
  storage: brandAssetStorage,
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

// ============ BRAND ASSETS ============

router.get('/brand-assets', authenticateToken, (req, res) => {
  const assets = db.prepare('SELECT * FROM brand_assets ORDER BY category, name').all();
  const grouped = { logo: [], decorative: [], badge: [], icon: [] };
  for (const asset of assets) {
    if (grouped[asset.category]) grouped[asset.category].push(asset);
  }
  res.json(grouped);
});

router.post('/brand-assets', authenticateToken, (req, res) => {
  brandAssetUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { category, name } = req.body;
    if (!category || !['logo', 'decorative', 'badge', 'icon'].includes(category)) {
      return res.status(400).json({ error: 'category must be one of: logo, decorative, badge, icon' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const filePath = `/lp/uploads/${req.file.filename}`;
    const result = db.prepare('INSERT INTO brand_assets (category, name, file_path) VALUES (?, ?, ?)').run(category, name.trim(), filePath);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'brand_asset', result.lastInsertRowid, `Uploaded brand asset: ${name}`, req.ip);
    res.json({ id: result.lastInsertRowid, category, name: name.trim(), file_path: filePath });
  });
});

router.delete('/brand-assets/:id', authenticateToken, (req, res) => {
  const asset = db.prepare('SELECT * FROM brand_assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  db.prepare('DELETE FROM brand_assets WHERE id = ?').run(req.params.id);

  // Delete file from disk
  const filename = asset.file_path.split('/').pop();
  const filePath = path.join(uploadsDir, filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'brand_asset', asset.id, `Deleted brand asset: ${asset.name}`, req.ip);
  res.json({ message: 'Asset deleted' });
});

// ============ PROMPT BUILDER ============

router.get('/prompt-options', authenticateToken, (req, res) => {
  res.json(PROMPT_OPTIONS);
});

router.post('/build-prompt', authenticateToken, (req, res) => {
  const errors = validateConfig(req.body);
  if (errors.length > 0) return res.status(400).json({ errors });
  const prompt = buildPrompt(req.body);
  res.json({ prompt });
});

router.post('/remove-background', authenticateToken, async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  try {
    const filename = image_url.split('/').pop();
    const result = await backgroundRemover.removeBackground(filename);
    res.json({ original_url: image_url, transparent_url: result.url });
  } catch (err) {
    console.error('Background removal error:', err.message);
    res.status(500).json({ error: 'Background removal failed: ' + err.message });
  }
});

// Separate layers: returns person cutout AND background with person removed (inpainted)
router.post('/separate-layers', authenticateToken, async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  try {
    // Step 1: Remove background from person (get person cutout)
    const filename = image_url.split('/').pop();
    const personResult = await backgroundRemover.removeBackground(filename);

    // Step 2: Inpaint — remove person from original image using Gemini
    const filePath = path.join(uploadsDir, filename);
    if (!fs.existsSync(filePath)) throw new Error('Original image not found');

    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const apiKey = getApiKey('gemini');
    if (!apiKey) throw new Error('Gemini API key not configured');

    // Try multiple models for inpainting
    const inpaintModels = ['gemini-2.5-flash-preview-image-generation', 'gemini-2.0-flash-exp', 'gemini-2.0-flash'];
    let bgCleanUrl = null;

    for (const inpaintModel of inpaintModels) {
      try {
        console.log(`[Separate] Trying inpaint with ${inpaintModel}...`);
        const inpaintRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${inpaintModel}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inline_data: { mime_type: mimeType, data: base64Image } },
                  { text: 'Edit this image: Remove the person/human completely from the image. Fill the area where the person was with the surrounding background, matching the colors, patterns, and decorative elements. Keep everything else (arrows, chevrons, icons, shapes, gradients). Output the edited image.' }
                ]
              }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
            })
          }
        );

        if (!inpaintRes.ok) {
          const errText = await inpaintRes.text();
          console.warn(`[Separate] ${inpaintModel} failed: ${inpaintRes.status} ${errText.substring(0, 100)}`);
          continue;
        }

        const inpaintData = await inpaintRes.json();
        if (inpaintData.candidates && inpaintData.candidates[0] && inpaintData.candidates[0].content) {
          const parts = inpaintData.candidates[0].content.parts || [];
          for (const part of parts) {
            const imgData = part.inline_data || part.inlineData;
            if (imgData && imgData.data) {
              const bgFilename = `ad-bg-clean-${Date.now()}.png`;
              const bgPath = path.join(uploadsDir, bgFilename);
              fs.writeFileSync(bgPath, Buffer.from(imgData.data, 'base64'));
              bgCleanUrl = `/lp/uploads/${bgFilename}`;
              console.log(`[Separate] Inpaint success with ${inpaintModel}`);
              break;
            }
          }
        }
        if (bgCleanUrl) break;
      } catch (inpaintErr) {
        console.warn(`[Separate] ${inpaintModel} error: ${inpaintErr.message}`);
      }
    }

    if (!bgCleanUrl) {
      console.warn('[Separate] All inpaint models failed — returning person only');
    }

    res.json({
      original_url: image_url,
      person_url: personResult.url,
      background_url: bgCleanUrl
    });
  } catch (err) {
    console.error('Separate layers error:', err.message);
    res.status(500).json({ error: 'Layer separation failed: ' + err.message });
  }
});

// ============ AD COPY V2 (structured for composition) ============

router.post('/generate-copy-v2', authenticateToken, async (req, res) => {
  const { topic, angle } = req.body;

  const fallback = {
    headline: 'Understanding Your MCA Debt Matters!',
    highlight_words: ['MCA Debt'],
    subheadline: 'You need a solution tailored to your business challenges.',
    subheadline_bold: ['solution'],
    cta_text: 'Explore your options with a free consultation:',
    cta_text_bold: ['a free consultation:'],
    cta_button: 'CoastalDebt.com'
  };

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) return res.json(fallback);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const angleHint = angle ? `\nAngle/tone: ${angle}` : '';
    const topicHint = topic ? `\nTopic/concept: ${topic}` : '';

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are an expert ad copywriter for Coastal Debt Resolve — a company that ONLY handles MCA (Merchant Cash Advance) debt settlement for business owners.

Generate structured ad copy for a display ad. The copy must be punchy, emotional, and drive clicks.${topicHint}${angleHint}

RULES:
- ONLY MCA / business debt. NEVER mention credit cards, personal debt, student loans.
- Headline: 3-6 words, powerful, scroll-stopping
- Pick 1-2 words in the headline to highlight in blue (the key MCA/debt terms)
- Subheadline: 8-15 words, one bold keyword
- CTA text: short line leading to the button
- CTA button is always "CoastalDebt.com"

Respond with ONLY valid JSON:
{
  "headline": "Understanding Your MCA Debt Matters!",
  "highlight_words": ["MCA Debt"],
  "subheadline": "You need a solution tailored to your business challenges.",
  "subheadline_bold": ["solution"],
  "cta_text": "Explore your options with a free consultation:",
  "cta_text_bold": ["a free consultation:"],
  "cta_button": "CoastalDebt.com"
}`
      }]
    });

    const text = message.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.json(fallback);

    const parsed = JSON.parse(match[0]);
    res.json({
      headline: parsed.headline || fallback.headline,
      highlight_words: Array.isArray(parsed.highlight_words) ? parsed.highlight_words : fallback.highlight_words,
      subheadline: parsed.subheadline || fallback.subheadline,
      subheadline_bold: Array.isArray(parsed.subheadline_bold) ? parsed.subheadline_bold : fallback.subheadline_bold,
      cta_text: parsed.cta_text || fallback.cta_text,
      cta_text_bold: Array.isArray(parsed.cta_text_bold) ? parsed.cta_text_bold : fallback.cta_text_bold,
      cta_button: 'CoastalDebt.com'
    });
  } catch (err) {
    console.error('Ad copy v2 error:', err.message);
    res.json(fallback);
  }
});

// ============ COMPOSE AD (V2) ============

router.post('/compose', authenticateToken, async (req, res) => {
  const { person_image_url, person_info, size_label, background_color, chevrons, text_position } = req.body;
  const copyConfig = req.body.copy_config || req.body.copy;
  const assetIds = req.body.selected_asset_ids || req.body.asset_ids;

  if (!person_image_url) return res.status(400).json({ error: 'person_image_url is required' });
  if (!copyConfig || !copyConfig.headline) return res.status(400).json({ error: 'copy/copy_config with headline is required' });

  try {
    // Fetch selected brand assets from DB
    let selectedAssets = [];
    if (Array.isArray(assetIds) && assetIds.length > 0) {
      const placeholders = assetIds.map(() => '?').join(',');
      selectedAssets = db.prepare(`SELECT * FROM brand_assets WHERE id IN (${placeholders})`).all(...assetIds);
    }

    // Build person info with offset and overrides
    const personInfoMerged = { ...person_info };

    // Build layout overrides from frontend controls
    const layoutOverrides = {};
    if (background_color) layoutOverrides.background_color = background_color;
    if (chevrons) layoutOverrides.chevrons = chevrons;
    if (text_position && text_position !== 'auto') layoutOverrides.text_position = text_position;

    // Single size or all sizes
    if (size_label) {
      const result = await recomposeAd(person_image_url, copyConfig, selectedAssets, personInfoMerged, size_label, layoutOverrides);
      if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'ad_composition', null, `Composed ad (${size_label})`, req.ip);
      return res.json(result);
    }

    const results = await composeAd(person_image_url, copyConfig, selectedAssets, personInfoMerged, layoutOverrides);
    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'ad_composition', null, `Composed ad in ${results.length} sizes`, req.ip);
    res.json({ compositions: results });
  } catch (err) {
    console.error('Compose error:', err);
    res.status(500).json({ error: 'Composition failed: ' + err.message });
  }
});

router.post('/recompose', authenticateToken, async (req, res) => {
  const { person_image_url, copy_config, selected_asset_ids, person_info, size_label } = req.body;

  if (!person_image_url || !copy_config || !size_label) {
    return res.status(400).json({ error: 'person_image_url, copy_config, and size_label are required' });
  }

  try {
    let selectedAssets = [];
    if (Array.isArray(selected_asset_ids) && selected_asset_ids.length > 0) {
      const placeholders = selected_asset_ids.map(() => '?').join(',');
      selectedAssets = db.prepare(`SELECT * FROM brand_assets WHERE id IN (${placeholders})`).all(...selected_asset_ids);
    }

    const result = await recomposeAd(person_image_url, copy_config, selectedAssets, person_info, size_label);

    res.json(result);
  } catch (err) {
    console.error('Recompose error:', err);
    res.status(500).json({ error: 'Recomposition failed: ' + err.message });
  }
});

// ============ SAVE EDIT ============

// AI Redesign — rearrange canvas elements into professional layout (with vision + brand rules)
const AI_REDESIGN_SYSTEM_PROMPT = `You are a senior art director for Coastal Debt Resolve, an MCA (Merchant Cash Advance) debt settlement company serving business owners. You redesign ad layouts into clean, professional, on-brand compositions.

BRAND GUIDELINES — Coastal Debt Resolve:
- Colors: Primary Blue #3052FF, Light BG #F2F4F9, Orange accent #FF9000, Black #000000, White #FFFFFF
- Typography: Sora (headings), Inter (body)
- Style: Clean, professional, lots of white space, corporate but warm
- Industry: MCA debt settlement for business owners

LAYOUT RULES:
- Person image: 35-45% of canvas width, aligned to bottom-left OR bottom-right (never center unless story format)
- Headline: 6-10% of canvas height, placed opposite the person, top 30% of canvas
- Subheadline: 4-6% of canvas height, directly below headline, same side
- CTA button: bottom 30% of canvas, prominent, ~15% height
- Chevrons: behind person at 30-50% opacity, top corner opposite to headline
- Logo: top-right corner, ~15-20% width, always visible
- Trust badges: bottom row, all 3 evenly spaced, ~10% height
- Safe zone: 5% margin from all edges
- Text should never overlap person's face
- Use golden ratio for visual hierarchy

GOLDEN REFERENCE LAYOUTS (follow these patterns):

Layout A - "Classic Left Person" (for square/feed):
- Person: left 5%, bottom 0, width 45%
- Chevrons: top-left 5%, behind person, 35% width
- Headline: right 55%, top 15%, width 40%
- Subheadline: right 55%, top 40%, width 40%
- CTA button: right 55%, top 60%, width 35%
- Logo: top-right 5%, width 18%
- Badges: bottom-center, row, width 60%

Layout B - "Classic Right Person" (mirror of A):
- Person: right 5%, bottom 0, width 45%
- Chevrons: top-right 5%, behind person, 35% width
- Headline: left 5%, top 15%, width 40%
- Subheadline: left 5%, top 40%, width 40%
- CTA button: left 5%, top 60%, width 35%
- Logo: top-right 5%, width 18%
- Badges: bottom-center, row, width 60%

Layout C - "Story Full Person" (for story/reel 9:16):
- Person: center, bottom 0, width 85%, height 75%
- Chevrons: top-left, 40% width, behind person
- Headline: top 5%, center, width 90%, large
- Subheadline: top 15%, center, width 90%
- CTA: bottom 10%, center, width 70%
- Logo: top-right, width 25%
- Badges: NOT shown in story

Analyze the provided screenshot and element data. Pick the layout pattern that best fits the canvas orientation and existing content. Return positions that match the chosen pattern exactly.`;

router.post('/ai-redesign', authenticateToken, async (req, res) => {
  const { elements, canvasWidth, canvasHeight, selectedSize, screenshot } = req.body;
  if (!elements || !canvasWidth || !canvasHeight) {
    return res.status(400).json({ error: 'elements, canvasWidth, canvasHeight required' });
  }

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) return res.status(500).json({ error: 'No API key' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    // Load reference ad image (the target style)
    const refImagePath = path.join(__dirname, '..', '..', 'public', 'assets', 'ad-references', 'reference-square.png');
    let referenceBase64 = null;
    try {
      if (fs.existsSync(refImagePath)) {
        referenceBase64 = fs.readFileSync(refImagePath).toString('base64');
      }
    } catch (e) { console.warn('Could not load reference ad:', e.message); }

    const instructionText = `${AI_REDESIGN_SYSTEM_PROMPT}

You are given TWO images:
1. FIRST image = REFERENCE (the target style — this is what a GREAT Coastal Debt ad looks like)
2. SECOND image = CURRENT canvas state (what the user has built so far)

Your job: Rearrange the elements in the CURRENT canvas to match the STYLE and LAYOUT of the REFERENCE.

Look at the reference and note:
- Person position (left side, bottom aligned, ~40% width)
- Chevrons behind person at top-left, in brand blue
- Headline on the right side, large, bold
- Subheadline below headline, smaller
- CTA button (blue pill) below subheadline on right
- Icon (circle with dollar) near bottom of person area
- Trust badges in a clean row at the bottom
- Logo in top-right corner
- Lots of white space, no overlapping text on face
- Clean, professional spacing

Current elements on canvas (with their current positions):
${JSON.stringify(elements, null, 2)}

Canvas size: ${canvasWidth}x${canvasHeight} (${selectedSize || 'unknown'})

Match each element from the current canvas to its role and place it where the reference shows that element type. Return positions (in pixels) that fill the canvas properly.

FOR TEXT ELEMENTS (headline, subheadline, cta, cta_button), also return styling to match the reference:
- fontFamily: pick from: Sora, Inter, Montserrat, Poppins, Playfair Display, Bebas Neue, Oswald, DM Sans, Plus Jakarta Sans, Outfit, Space Grotesk, Archivo
- fontSize: number (pixels)
- fontWeight: 'normal', '600', 'bold', '800', '900'
- fill: hex color (use brand colors: #3052FF blue, #FF9000 orange, #000000 black, #333333 dark gray, #FFFFFF white)
- fontStyle: 'normal' or 'italic'
- textAlign: 'left', 'center', 'right'

REFERENCE TEXT STYLE:
- Headline: Sora Bold, font-size ~48, mix of black #000000 and blue #3052FF with some words in orange #FF9000
- Subheadline: Sora Regular, font-size ~24, dark gray #333333 with some bold words
- CTA text: Sora Regular, font-size ~20, dark gray with bold blue highlight
- CTA button label: Sora Bold, font-size ~22, white on blue pill

CRITICAL POSITION RULES:
- ALL elements MUST be FULLY INSIDE the canvas bounds (0 to ${canvasWidth} for left, 0 to ${canvasHeight} for top)
- left + (width * scaleX) must be <= ${canvasWidth}
- top + (height * scaleY) must be <= ${canvasHeight}
- NEVER place elements with left < 0 or top < 0
- NEVER place elements with left > ${canvasWidth - 50} (they'd be mostly off-canvas)
- Use appropriate scaleX/scaleY (typically 0.3 to 1.5) to fit elements within canvas
- Person should fill about 40-50% of canvas height, positioned at bottom-left or bottom-right
- Text should use scale 1.0 — font size controls text size, not scale

Return ONLY a JSON array. Each object must have: index, left, top, scaleX, scaleY. For text elements also include: fontFamily, fontSize, fontWeight, fill, textAlign. No explanation, no markdown, just the JSON array.`;

    // Build content: reference image first, then current canvas, then text
    const userContent = [];

    // 1. Reference image (if available)
    if (referenceBase64) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: referenceBase64 }
      });
    }

    // 2. Current canvas screenshot
    if (screenshot) {
      const b64 = String(screenshot).replace(/^data:image\/\w+;base64,/, '');
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64 }
      });
    }

    userContent.push({ type: 'text', text: instructionText });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      messages: [{ role: 'user', content: userContent }]
    });

    const text = message.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'AI returned invalid layout' });

    const positions = JSON.parse(match[0]);
    res.json({ positions });
  } catch (err) {
    console.error('AI Redesign error:', err.message);
    res.status(500).json({ error: 'Redesign failed: ' + err.message });
  }
});

// ============ LAYOUT TEMPLATES (user-saved) ============

// Save current layout as template
router.post('/layout-templates', authenticateToken, (req, res) => {
  const { name, size_label, layout_json, thumbnail_url } = req.body;
  if (!name || !size_label || !layout_json) {
    return res.status(400).json({ error: 'name, size_label, layout_json required' });
  }
  try {
    const result = db.prepare(`
      INSERT INTO ad_layout_templates (name, size_label, layout_json, thumbnail_url)
      VALUES (?, ?, ?, ?)
    `).run(name, size_label, JSON.stringify(layout_json), thumbnail_url || null);
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error('Save layout template error:', err.message);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// List templates (optionally filtered by size)
router.get('/layout-templates', authenticateToken, (req, res) => {
  const { size_label } = req.query;
  let templates;
  if (size_label) {
    templates = db.prepare('SELECT * FROM ad_layout_templates WHERE size_label = ? ORDER BY created_at DESC').all(size_label);
  } else {
    templates = db.prepare('SELECT * FROM ad_layout_templates ORDER BY created_at DESC').all();
  }
  templates.forEach(t => { try { t.layout_json = JSON.parse(t.layout_json); } catch (e) {} });
  res.json(templates);
});

// Delete template
router.delete('/layout-templates/:id', authenticateToken, (req, res) => {
  try {
    db.prepare('DELETE FROM ad_layout_templates WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

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

  const fallback = { headline: 'Settle Your MCA Debt', subheadline: 'Reduce your merchant cash advance debt by up to 80%', badge: 'MCA Debt Relief' };

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
          content: `You are an expert direct-response ad copywriter for Coastal Debt Resolve, a company that ONLY deals with MCA (Merchant Cash Advance) debt settlement for business owners. Create compelling ad copy for a paid ad.${sizeHint}

CRITICAL CONTEXT — Coastal Debt Resolve ONLY handles:
- MCA (Merchant Cash Advance) debt
- Business debt / business loan debt
- Do NOT mention: credit card debt, personal debt, student loans, mortgages, or any non-MCA debt

Ad concept: "${prompt}"

Generate copy that is punchy, emotional, and drives clicks. Use power words. The headline should stop the scroll. Keep it focused on MCA / business debt only.

Respond with ONLY valid JSON:
{
  "badge": "short badge/label text, 2-3 words (e.g. 'MCA Debt Relief', 'Business Owners', 'Limited Time')",
  "headline": "powerful main headline, max 6 words, all caps friendly",
  "subheadline": "supporting line, max 12 words, adds urgency or specifics — MCA/business debt ONLY",
  "style": "dark_overlay or light_overlay or gradient_bar or minimal"
}

Do NOT include a phone number. Do NOT mention credit cards or personal debt.`
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
        style: parsed.style || 'dark_overlay'
      });
    }

    // Simple mode (legacy)
    const msg2 = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You write ad copy for Coastal Debt Resolve, a company that ONLY handles MCA (Merchant Cash Advance) debt settlement for business owners. Do NOT mention credit cards, personal debt, or non-MCA debt. Given the ad prompt below, produce a short headline (max 8 words) and a subheadline (max 12 words).${sizeHint}

Ad prompt: "${prompt}"

Respond with ONLY valid JSON: {"headline":"...","subheadline":"..."}`
      }]
    });

    const text2 = msg2.content[0].text.trim();
    const match2 = text2.match(/\{[\s\S]*\}/);
    if (!match2) return res.json(fallback);

    const parsed2 = JSON.parse(match2[0]);
    res.json({
      headline: (parsed2.headline || fallback.headline).slice(0, 80),
      subheadline: (parsed2.subheadline || fallback.subheadline).slice(0, 100)
    });
  } catch (err) {
    console.error('Ad copy generation error:', err.message);
    res.json(fallback);
  }
});

// ============ META AD COPY GENERATOR ============

const META_AD_ANGLES = {
  general: 'General MCA debt relief — highlight the service and benefits',
  urgency: 'Create urgency — limited time offer, act now before it\'s too late',
  savings: 'Focus on savings — settle for pennies on the dollar, save up to 80%',
  pain: 'Address pain points — drowning in daily payments, MCA draining your business',
  trust: 'Build trust — proven track record, hundreds of businesses helped, real results',
  fresh_start: 'Fresh start angle — leave MCA debt behind, rebuild your business',
  comparison: 'Why choose us — what makes Coastal Debt Resolve different from others',
  educational: 'Educational — explain what MCA debt is and why settlement is the best option'
};

router.post('/generate-meta-copy', authenticateToken, async (req, res) => {
  const { angle, count, custom_instructions } = req.body;
  const numVariations = Math.min(Math.max(parseInt(count) || 3, 1), 10);
  const angleDesc = META_AD_ANGLES[angle] || META_AD_ANGLES.general;

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const customLine = custom_instructions ? `\nAdditional instructions: ${custom_instructions}` : '';

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are an expert Meta (Facebook/Instagram) ad copywriter for Coastal Debt Resolve.

ABOUT THE COMPANY:
- Coastal Debt Resolve helps business owners settle MCA (Merchant Cash Advance) debt
- They ONLY deal with MCA debt and business debt — NEVER mention credit cards, personal debt, student loans, or mortgages
- They can reduce what businesses owe by up to 80%
- Free consultation available
- Website: coastaldebt.com

AD ANGLE: ${angleDesc}${customLine}

Generate exactly ${numVariations} UNIQUE Meta ad copy variations. Each variation should feel completely different — different hooks, different angles, different emotional triggers. Mix short punchy copy with longer storytelling copy.

For each variation provide:
- primary_text: The main ad body (80-300 chars). This is what appears above the image. Use line breaks for readability. Mix styles: some with emojis, some without, some with questions, some with statements, some with statistics.
- headline: Bold headline below the image (max 40 chars). Should stop the scroll.
- description: Optional description text below headline (max 30 chars). Can be empty string.
- cta: Call to action button. Use ONLY these Meta-approved options: "Learn More", "Get Quote", "Contact Us", "Sign Up", "Apply Now"

RULES:
- ONLY MCA / business debt. Never mention credit cards or personal debt.
- No phone numbers
- Vary the tone: some professional, some emotional, some urgent, some educational
- Use power words: free, save, proven, guaranteed, relief, resolve, settle
- Some variations should use emojis sparingly (1-2 max), others none

Return ONLY a valid JSON array:
[
  { "primary_text": "...", "headline": "...", "description": "...", "cta": "..." },
  ...
]`
      }]
    });

    const rawText = (message.content[0]?.text || '').trim();
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('Meta copy: no JSON array found in response:', rawText.substring(0, 200));
      return res.status(500).json({ error: 'AI returned invalid format' });
    }

    const variations = JSON.parse(jsonMatch[0]);
    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'meta_ad_copy', null, `Generated ${variations.length} Meta ad copy variations (${angle})`, req.ip);

    res.json({ variations });
  } catch (err) {
    console.error('Meta copy generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate Meta ad copy' });
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

// ============ SEED DEFAULT BRAND ASSETS ============
(function seedDefaultAssets() {
  const count = db.prepare('SELECT COUNT(*) as c FROM brand_assets').get().c;
  if (count > 0) {
    // Ensure real trust badges exist (upgrade from placeholder icons)
    const hasTrustpilot = db.prepare("SELECT id FROM brand_assets WHERE name = 'Trustpilot 4.8'").get();
    if (!hasTrustpilot) {
      const insert = db.prepare('INSERT INTO brand_assets (category, name, file_path) VALUES (?, ?, ?)');
      insert.run('badge', 'Trustpilot 4.8', '/assets/trust-logos/trustpilot.webp');
      insert.run('badge', 'ISO 9001:2015', '/assets/trust-logos/bsi.webp');
      insert.run('badge', 'BBB Torch Awards', '/assets/trust-logos/bbb-torch-awards.png');
      insert.run('logo', 'Coastal Debt Logo (Dark)', '/assets/logos/logo-dark-text.svg');
      insert.run('logo', 'Coastal Debt Logo (White)', '/assets/logos/logo-white-text.svg');
      insert.run('decorative', 'Chevron Arrows', '/assets/brand-assets/chevron-arrows.svg');
      console.log('[Ad Generator] Added real trust badges and logos to brand assets');
    }
    return;
  }

  const defaultAssets = [
    { category: 'decorative', name: 'Blue Chevrons', file_path: '/assets/brand-assets/chevron-blue.svg' },
    { category: 'decorative', name: 'Chevron Arrows', file_path: '/assets/brand-assets/chevron-arrows.svg' },
    { category: 'icon', name: 'Dollar Hand', file_path: '/assets/brand-assets/icon-dollar-hand.svg' },
    { category: 'icon', name: 'Phone', file_path: '/assets/brand-assets/icon-phone.svg' },
    { category: 'icon', name: 'Shield', file_path: '/assets/brand-assets/icon-shield.svg' },
    { category: 'icon', name: 'Checkmark', file_path: '/assets/brand-assets/icon-checkmark.svg' },
    { category: 'badge', name: 'Trustpilot 4.8', file_path: '/assets/trust-logos/trustpilot.webp' },
    { category: 'badge', name: 'ISO 9001:2015', file_path: '/assets/trust-logos/bsi.webp' },
    { category: 'badge', name: 'BBB Torch Awards', file_path: '/assets/trust-logos/bbb-torch-awards.png' },
    { category: 'logo', name: 'Coastal Debt Logo (Dark)', file_path: '/assets/logos/logo-dark-text.svg' },
    { category: 'logo', name: 'Coastal Debt Logo (White)', file_path: '/assets/logos/logo-white-text.svg' }
  ];

  const insert = db.prepare('INSERT INTO brand_assets (category, name, file_path) VALUES (?, ?, ?)');
  for (const asset of defaultAssets) {
    insert.run(asset.category, asset.name, asset.file_path);
  }
  console.log('[Ad Generator] Seeded default brand assets');
})();

module.exports = router;
