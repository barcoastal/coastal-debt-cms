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

// ============ GENERATION ============

// Start generation for all 4 sizes
router.post('/generate', authenticateToken, (req, res) => {
  const { project_id, model, prompt } = req.body;

  if (!project_id || !model || !prompt) {
    return res.status(400).json({ error: 'project_id, model, and prompt are required' });
  }

  if (!['midjourney', 'flux', 'gemini'].includes(model)) {
    return res.status(400).json({ error: 'Invalid model. Use: midjourney, flux, or gemini' });
  }

  const project = db.prepare('SELECT * FROM ad_projects WHERE id = ?').get(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let referenceImages;
  try { referenceImages = JSON.parse(project.reference_images || '[]'); } catch (e) { referenceImages = []; }

  // Create 4 generation rows
  const insert = db.prepare(`
    INSERT INTO ad_generations (project_id, model, prompt, size_label, width, height, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  const generationIds = [];
  for (const size of AD_SIZES) {
    const result = insert.run(project_id, model, prompt, size.label, size.width, size.height);
    generationIds.push(result.lastInsertRowid);
  }

  // Fire-and-forget: process each generation in background
  for (let i = 0; i < AD_SIZES.length; i++) {
    processGeneration(generationIds[i], model, prompt, referenceImages, AD_SIZES[i]);
  }

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'ad_generation', null, `Started ${model} generation for project #${project_id}`, req.ip);

  res.json({ generation_ids: generationIds, message: 'Generation started' });
});

// Batch status check
router.get('/generations/batch-status', authenticateToken, (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean).map(Number);
  if (ids.length === 0) return res.json([]);

  const placeholders = ids.map(() => '?').join(',');
  const generations = db.prepare(`SELECT id, status, image_url, error_message, size_label FROM ad_generations WHERE id IN (${placeholders})`).all(...ids);
  res.json(generations);
});

// Regenerate single size
router.post('/regenerate/:id', authenticateToken, (req, res) => {
  const gen = db.prepare('SELECT * FROM ad_generations WHERE id = ?').get(req.params.id);
  if (!gen) return res.status(404).json({ error: 'Generation not found' });

  const project = db.prepare('SELECT * FROM ad_projects WHERE id = ?').get(gen.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let referenceImages;
  try { referenceImages = JSON.parse(project.reference_images || '[]'); } catch (e) { referenceImages = []; }

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

// ============ BACKGROUND PROCESSING ============

async function processGeneration(genId, model, prompt, referenceImageUrls, size) {
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

    // Make absolute URLs from relative paths for external APIs
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const absoluteUrls = referenceImageUrls.map(u => u.startsWith('http') ? u : `${baseUrl}${u}`);

    const result = await adapter.generate(apiKey, prompt, absoluteUrls, size, extraConfig);

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
