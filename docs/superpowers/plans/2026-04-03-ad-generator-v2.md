# Ad Generator V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the ad generator to produce complete, brand-consistent ads by adding a prompt builder, brand assets library, ad copy restructuring, and an HTML/CSS composition engine with Puppeteer rendering.

**Architecture:** Each step of the existing 4-step wizard is enhanced: Step 1 gets a dropdown prompt builder + background removal, Step 2 becomes structured ad copy generation, Step 3 expands from logo-only to a full brand assets library, and a new Step 4 uses Claude to decide layout then renders via HTML/CSS + Puppeteer into PNG for all 4 ad sizes. The existing Fabric.js editor remains for post-composition edits.

**Tech Stack:** Node.js/Express, better-sqlite3, Puppeteer, @imgly/background-removal-node, @anthropic-ai/sdk, Fabric.js (CDN), HTML/CSS templates

---

## File Structure

### New files

```
server/
  services/
    prompt-builder.js             -- builds AI prompt from dropdown selections
    background-remover.js         -- removes image backgrounds using @imgly/background-removal-node
    ad-compositor.js              -- orchestrates full composition pipeline
    layout-engine.js              -- calls Claude to decide element placement, returns layout JSON
    html-renderer.js              -- builds HTML string from layout JSON + assets + copy
    puppeteer-renderer.js         -- renders HTML to PNG at specified dimensions
  templates/
    ad-base.html                  -- base HTML template with Aeonik font, brand colors, element slots

admin/
  assets/brand-assets/            -- default brand assets shipped with the app
    chevron-blue.svg
    trustpilot-badge.png
    iso-badge.png
    bbb-badge.png
    icon-dollar-hand.svg
    icon-phone.svg
    icon-shield.svg
    icon-checkmark.svg
```

### Modified files

```
server/routes/ad-generator.js    -- add new endpoints, modify generate endpoint
server/database.js               -- add brand_assets table, new columns on ad_generations
admin/ad-generator.html          -- prompt builder UI, brand assets UI, compose step UI
package.json                     -- add puppeteer, @imgly/background-removal-node
```

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install puppeteer and background-removal-node**

```bash
cd /Users/baralezrah/coastal-debt-cms
npm install puppeteer @imgly/background-removal-node
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "require('puppeteer'); require('@imgly/background-removal-node'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add package.json package-lock.json
git commit -m "chore: add puppeteer and background-removal-node dependencies"
```

---

### Task 2: Database Schema — Brand Assets Table + New Columns

**Files:**
- Modify: `server/database.js`

- [ ] **Step 1: Add brand_assets table creation**

Find the ad_generations table creation block in `server/database.js` (around line 1527). After the `CREATE INDEX IF NOT EXISTS idx_ad_gen_status` line, add:

```javascript
// Brand assets library
db.exec(`
  CREATE TABLE IF NOT EXISTS brand_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK(category IN ('logo', 'decorative', 'badge', 'icon')),
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
```

- [ ] **Step 2: Add new columns to ad_generations**

Right after the brand_assets table creation, add migrations for the new columns:

```javascript
// Ad generator v2 columns
const adGenV2Cols = [
  { name: 'prompt_builder_config', type: 'TEXT DEFAULT NULL' },
  { name: 'copy_config', type: 'TEXT DEFAULT NULL' },
  { name: 'selected_assets', type: 'TEXT DEFAULT NULL' },
  { name: 'layout_json', type: 'TEXT DEFAULT NULL' },
  { name: 'composed_urls', type: 'TEXT DEFAULT NULL' }
];
for (const col of adGenV2Cols) {
  try { db.exec(`ALTER TABLE ad_generations ADD COLUMN ${col.name} ${col.type}`); } catch (e) {}
}
```

- [ ] **Step 3: Verify by running the server**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "const db = require('./server/database'); const info = db.prepare(\"PRAGMA table_info(brand_assets)\").all(); console.log(info.map(c => c.name).join(', ')); const info2 = db.prepare(\"PRAGMA table_info(ad_generations)\").all(); console.log(info2.map(c => c.name).join(', '));"
```

Expected: `brand_assets` table columns listed, `ad_generations` should include `prompt_builder_config`, `copy_config`, `selected_assets`, `layout_json`, `composed_urls`.

- [ ] **Step 4: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/database.js
git commit -m "feat: add brand_assets table and ad_generations v2 columns"
```

---

### Task 3: Prompt Builder Service

**Files:**
- Create: `server/services/prompt-builder.js`

- [ ] **Step 1: Create the prompt builder service**

```javascript
// server/services/prompt-builder.js

const PROMPT_OPTIONS = {
  gender: ['Male', 'Female'],
  age_range: ['25-35', '35-45', '45-55'],
  ethnicity: ['Caucasian', 'African American', 'Hispanic/Latino', 'Asian', 'Middle Eastern', 'South Asian'],
  pose: ['Standing confident', 'Arms crossed', 'Hands clasped', 'Leaning casual', 'Pointing', 'Thumbs up'],
  expression: ['Warm smile', 'Confident', 'Serious/professional', 'Friendly', 'Relieved/hopeful'],
  attire: ['Business formal (suit)', 'Business casual', 'Casual', 'Trade/work uniform'],
  framing: ['Half body', 'Full body', 'Head & shoulders'],
  background: ['Transparent', 'Office', 'Outdoor', 'Studio plain']
};

function buildPrompt(config) {
  const { gender, age_range, ethnicity, pose, expression, attire, framing, background, extra_details } = config;

  const bgText = background === 'Transparent'
    ? 'solid white background for easy background removal'
    : `${background.toLowerCase()} background`;

  let prompt = `Professional photo of a ${gender.toLowerCase()}, age ${age_range}, ${ethnicity}, ${pose.toLowerCase()}, ${expression.toLowerCase()} expression, wearing ${attire.toLowerCase()} attire, ${framing.toLowerCase()} shot, ${bgText}, studio lighting, high quality, photorealistic`;

  if (extra_details && extra_details.trim()) {
    prompt += `, ${extra_details.trim()}`;
  }

  return prompt;
}

function validateConfig(config) {
  const errors = [];
  for (const [key, options] of Object.entries(PROMPT_OPTIONS)) {
    if (!config[key]) {
      errors.push(`${key} is required`);
    } else if (!options.includes(config[key])) {
      errors.push(`Invalid ${key}: "${config[key]}". Options: ${options.join(', ')}`);
    }
  }
  return errors;
}

module.exports = { buildPrompt, validateConfig, PROMPT_OPTIONS };
```

- [ ] **Step 2: Verify**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
const { buildPrompt, validateConfig } = require('./server/services/prompt-builder');
const config = { gender: 'Female', age_range: '45-55', ethnicity: 'African American', pose: 'Hands clasped', expression: 'Warm smile', attire: 'Business casual', framing: 'Half body', background: 'Transparent' };
console.log('Errors:', validateConfig(config));
console.log('Prompt:', buildPrompt(config));
"
```

Expected: Empty errors array, prompt string matching the template.

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/services/prompt-builder.js
git commit -m "feat: add prompt builder service with dropdown options"
```

---

### Task 4: Background Removal Service

**Files:**
- Create: `server/services/background-remover.js`

- [ ] **Step 1: Create the background removal service**

```javascript
// server/services/background-remover.js

const fs = require('fs');
const path = require('path');

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', '..', 'public', 'uploads');

async function removeBackground(inputImagePath) {
  // Dynamic import for ESM module
  const { removeBackground: removeBg } = await import('@imgly/background-removal-node');

  // Read the input image
  const absolutePath = inputImagePath.startsWith('/')
    ? inputImagePath
    : path.join(uploadsDir, inputImagePath);

  const imageBuffer = fs.readFileSync(absolutePath);
  const blob = new Blob([imageBuffer], { type: 'image/png' });

  // Remove background
  const resultBlob = await removeBg(blob, {
    output: { format: 'image/png' }
  });

  // Save as new file
  const resultBuffer = Buffer.from(await resultBlob.arrayBuffer());
  const baseName = path.basename(absolutePath, path.extname(absolutePath));
  const outputFilename = `${baseName}-nobg-${Date.now()}.png`;
  const outputPath = path.join(uploadsDir, outputFilename);
  fs.writeFileSync(outputPath, resultBuffer);

  return {
    file_path: outputPath,
    url: `/lp/uploads/${outputFilename}`
  };
}

module.exports = { removeBackground };
```

- [ ] **Step 2: Verify import works**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
(async () => {
  const { removeBackground } = await import('@imgly/background-removal-node');
  console.log('Module loaded:', typeof removeBackground);
})();
"
```

Expected: `Module loaded: function`

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/services/background-remover.js
git commit -m "feat: add background removal service using imgly"
```

---

### Task 5: Brand Assets API Endpoints

**Files:**
- Modify: `server/routes/ad-generator.js`

- [ ] **Step 1: Add brand asset multer config**

After the existing `logoUpload` multer config in `server/routes/ad-generator.js`, add:

```javascript
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
```

- [ ] **Step 2: Add GET /brand-assets endpoint**

After the logo routes (around line 622), add:

```javascript
// ============ BRAND ASSETS ============

router.get('/brand-assets', authenticateToken, (req, res) => {
  const assets = db.prepare('SELECT * FROM brand_assets ORDER BY category, name').all();
  const grouped = { logo: [], decorative: [], badge: [], icon: [] };
  for (const asset of assets) {
    if (grouped[asset.category]) grouped[asset.category].push(asset);
  }
  res.json(grouped);
});
```

- [ ] **Step 3: Add POST /brand-assets endpoint**

```javascript
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
```

- [ ] **Step 4: Add DELETE /brand-assets/:id endpoint**

```javascript
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
```

- [ ] **Step 5: Verify endpoints**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
const db = require('./server/database');
// Insert test asset
db.prepare('INSERT INTO brand_assets (category, name, file_path) VALUES (?, ?, ?)').run('badge', 'Test Badge', '/lp/uploads/test.png');
const assets = db.prepare('SELECT * FROM brand_assets').all();
console.log('Assets:', assets.length, assets[0].name);
db.prepare('DELETE FROM brand_assets WHERE name = ?').run('Test Badge');
console.log('Cleaned up');
"
```

Expected: `Assets: 1 Test Badge` then `Cleaned up`

- [ ] **Step 6: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/routes/ad-generator.js
git commit -m "feat: add brand assets CRUD endpoints"
```

---

### Task 6: Prompt Builder + Background Removal API Endpoints

**Files:**
- Modify: `server/routes/ad-generator.js`

- [ ] **Step 1: Import services at top of ad-generator.js**

After the existing adapter imports (line 11), add:

```javascript
const { buildPrompt, validateConfig, PROMPT_OPTIONS } = require('../services/prompt-builder');
const backgroundRemover = require('../services/background-remover');
```

- [ ] **Step 2: Add GET /prompt-options endpoint**

Add after the brand assets endpoints:

```javascript
// ============ PROMPT BUILDER ============

router.get('/prompt-options', authenticateToken, (req, res) => {
  res.json(PROMPT_OPTIONS);
});
```

- [ ] **Step 3: Add POST /build-prompt endpoint**

```javascript
router.post('/build-prompt', authenticateToken, (req, res) => {
  const errors = validateConfig(req.body);
  if (errors.length > 0) return res.status(400).json({ errors });
  const prompt = buildPrompt(req.body);
  res.json({ prompt });
});
```

- [ ] **Step 4: Add POST /remove-background endpoint**

```javascript
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
```

- [ ] **Step 5: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/routes/ad-generator.js
git commit -m "feat: add prompt builder and background removal endpoints"
```

---

### Task 7: Ad Copy Generation Endpoint (V2)

**Files:**
- Modify: `server/routes/ad-generator.js`

- [ ] **Step 1: Add POST /generate-copy-v2 endpoint**

Add after the prompt builder endpoints:

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/routes/ad-generator.js
git commit -m "feat: add structured ad copy generation endpoint for composition"
```

---

### Task 8: Layout Engine Service

**Files:**
- Create: `server/services/layout-engine.js`

- [ ] **Step 1: Create the layout engine**

```javascript
// server/services/layout-engine.js

async function generateLayout(personImageInfo, copyConfig, selectedAssets, sizeLabel, width, height) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
  if (!apiKey) return getDefaultLayout(sizeLabel);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const assetList = selectedAssets.map(a => `- ${a.category}: "${a.name}"`).join('\n');
  const isVertical = height > width;
  const isSquare = Math.abs(width - height) < 100;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are a professional ad layout designer for Coastal Debt Resolve. Design the layout for a ${width}x${height} (${sizeLabel}) display ad.

PERSON IMAGE: ${personImageInfo.framing || 'half body'} shot, will be composited with transparent background.

AD COPY:
- Headline: "${copyConfig.headline}"
- Subheadline: "${copyConfig.subheadline}"
- CTA: "${copyConfig.cta_text}" + button "${copyConfig.cta_button}"

BRAND ASSETS AVAILABLE:
${assetList || '(none selected)'}

CANVAS: ${width}x${height}px, ${isVertical ? 'vertical/story' : isSquare ? 'square' : 'landscape'} format.

BRAND COLORS: Background #F2F4F9, Primary Blue #3052FF, Orange accent #FF9000, Black #000000.

Design a layout that looks like a premium Coastal Debt Resolve ad. The person should be prominent. Text should have clear hierarchy. Trust badges go at the bottom.

Respond with ONLY valid JSON:
{
  "background_color": "#F2F4F9",
  "person": {
    "position": "left" or "right" or "center",
    "vertical_align": "bottom" or "center",
    "width_percent": 40-55,
    "offset_x_percent": 0,
    "offset_y_percent": 0
  },
  "chevrons": {
    "visible": true/false,
    "position": "top-left" or "top-right",
    "behind_person": true/false
  },
  "logo": {
    "position": "top-left" or "top-right"
  },
  "headline": {
    "area": "top-right" or "top-left" or "top-center" or "center",
    "max_width_percent": 45-60,
    "font_size": 36-52
  },
  "subheadline": {
    "area": "below-headline",
    "font_size": 16-22
  },
  "icon": {
    "visible": true/false,
    "position": "middle-center" or "near-person",
    "asset_name": "name of icon asset or null"
  },
  "cta_text": {
    "area": "below-subheadline",
    "font_size": 14-18
  },
  "cta_button": {
    "area": "below-cta",
    "style": "pill",
    "bg_color": "#3052FF",
    "text_color": "#FFFFFF",
    "font_size": 16-20
  },
  "trust_badges": {
    "visible": true/false,
    "position": "bottom-center" or "bottom-left",
    "layout": "row"
  }
}`
    }]
  });

  const text = message.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return getDefaultLayout(sizeLabel);

  return JSON.parse(match[0]);
}

function getDefaultLayout(sizeLabel) {
  const base = {
    background_color: '#F2F4F9',
    person: { position: 'left', vertical_align: 'bottom', width_percent: 45, offset_x_percent: 0, offset_y_percent: 0 },
    chevrons: { visible: true, position: 'top-left', behind_person: true },
    logo: { position: 'top-right' },
    headline: { area: 'top-right', max_width_percent: 50, font_size: 42 },
    subheadline: { area: 'below-headline', font_size: 18 },
    icon: { visible: true, position: 'near-person', asset_name: null },
    cta_text: { area: 'below-subheadline', font_size: 16 },
    cta_button: { area: 'below-cta', style: 'pill', bg_color: '#3052FF', text_color: '#FFFFFF', font_size: 18 },
    trust_badges: { visible: true, position: 'bottom-center', layout: 'row' }
  };

  if (sizeLabel === 'story_reel') {
    base.person.width_percent = 70;
    base.person.position = 'center';
    base.headline.area = 'top-center';
    base.headline.max_width_percent = 85;
    base.headline.font_size = 36;
  }

  return base;
}

module.exports = { generateLayout, getDefaultLayout };
```

- [ ] **Step 2: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/services/layout-engine.js
git commit -m "feat: add layout engine service with Claude-driven layout decisions"
```

---

### Task 9: HTML Renderer Service

**Files:**
- Create: `server/services/html-renderer.js`

- [ ] **Step 1: Create the HTML renderer**

```javascript
// server/services/html-renderer.js

const fs = require('fs');
const path = require('path');

function renderAdHtml(layout, copyConfig, personImageUrl, selectedAssets, width, height) {
  const logoAsset = selectedAssets.find(a => a.category === 'logo');
  const chevronAsset = selectedAssets.find(a => a.category === 'decorative');
  const badges = selectedAssets.filter(a => a.category === 'badge');
  const iconAsset = layout.icon && layout.icon.visible
    ? selectedAssets.find(a => a.category === 'icon' && (a.name === layout.icon.asset_name || !layout.icon.asset_name))
    : null;

  // Build highlighted headline
  let headlineHtml = escapeHtml(copyConfig.headline);
  if (copyConfig.highlight_words) {
    for (const word of copyConfig.highlight_words) {
      headlineHtml = headlineHtml.replace(
        new RegExp(escapeRegExp(word), 'gi'),
        `<span style="color: #3052FF;">${escapeHtml(word)}</span>`
      );
    }
  }

  // Build subheadline with bold
  let subheadlineHtml = escapeHtml(copyConfig.subheadline);
  if (copyConfig.subheadline_bold) {
    for (const word of copyConfig.subheadline_bold) {
      subheadlineHtml = subheadlineHtml.replace(
        new RegExp(escapeRegExp(word), 'gi'),
        `<strong>${escapeHtml(word)}</strong>`
      );
    }
  }

  // Build CTA text with bold
  let ctaTextHtml = escapeHtml(copyConfig.cta_text);
  if (copyConfig.cta_text_bold) {
    for (const word of copyConfig.cta_text_bold) {
      ctaTextHtml = ctaTextHtml.replace(
        new RegExp(escapeRegExp(word), 'gi'),
        `<strong>${escapeHtml(word)}</strong>`
      );
    }
  }

  const personPos = layout.person || {};
  const isPersonLeft = personPos.position === 'left';
  const isPersonRight = personPos.position === 'right';
  const isPersonCenter = personPos.position === 'center';
  const personWidthPct = personPos.width_percent || 45;

  const textSide = isPersonLeft ? 'right' : isPersonRight ? 'left' : 'center';
  const textWidthPct = isPersonCenter ? 85 : (100 - personWidthPct - 5);

  // Compute positions
  const personLeft = isPersonLeft ? `${personPos.offset_x_percent || 0}%` :
    isPersonRight ? `${100 - personWidthPct + (personPos.offset_x_percent || 0)}%` :
    `${(100 - personWidthPct) / 2}%`;

  const textLeft = isPersonLeft ? `${personWidthPct + 2}%` :
    isPersonRight ? '5%' : '7.5%';
  const textRight = isPersonLeft ? '5%' :
    isPersonRight ? `${personWidthPct + 2}%` : '7.5%';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: ${width}px;
    height: ${height}px;
    background: ${layout.background_color || '#F2F4F9'};
    font-family: 'Sora', 'Inter', sans-serif;
    overflow: hidden;
    position: relative;
  }

  .person {
    position: absolute;
    bottom: ${personPos.vertical_align === 'center' ? '10%' : '0'};
    left: ${personLeft};
    width: ${personWidthPct}%;
    z-index: 2;
  }
  .person img {
    width: 100%;
    height: auto;
    display: block;
  }

  .chevrons {
    position: absolute;
    top: 5%;
    ${layout.chevrons && layout.chevrons.position === 'top-right' ? 'right: 5%;' : 'left: 5%;'}
    z-index: ${layout.chevrons && layout.chevrons.behind_person ? '1' : '3'};
    width: 15%;
  }
  .chevrons img { width: 100%; height: auto; }

  .logo {
    position: absolute;
    top: 4%;
    ${layout.logo && layout.logo.position === 'top-left' ? 'left: 5%;' : 'right: 5%;'}
    z-index: 10;
    width: 20%;
  }
  .logo img { width: 100%; height: auto; }

  .text-area {
    position: absolute;
    top: ${isPersonCenter ? '5%' : '12%'};
    left: ${textLeft};
    right: ${textRight};
    z-index: 5;
  }

  .headline {
    font-size: ${layout.headline ? layout.headline.font_size : 42}px;
    font-weight: 800;
    color: #000000;
    line-height: 1.15;
    margin-bottom: ${Math.round(height * 0.02)}px;
  }

  .subheadline {
    font-size: ${layout.subheadline ? layout.subheadline.font_size : 18}px;
    font-weight: 400;
    color: #333333;
    line-height: 1.5;
    margin-bottom: ${Math.round(height * 0.02)}px;
  }

  .icon-wrapper {
    width: ${Math.round(width * 0.06)}px;
    height: ${Math.round(width * 0.06)}px;
    border: 2px solid #3052FF;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: ${Math.round(height * 0.015)}px;
  }
  .icon-wrapper img { width: 60%; height: 60%; }

  .cta-text {
    font-size: ${layout.cta_text ? layout.cta_text.font_size : 16}px;
    color: #333333;
    margin-bottom: ${Math.round(height * 0.015)}px;
  }

  .cta-button {
    display: inline-block;
    background: ${layout.cta_button ? layout.cta_button.bg_color : '#3052FF'};
    color: ${layout.cta_button ? layout.cta_button.text_color : '#FFFFFF'};
    font-size: ${layout.cta_button ? layout.cta_button.font_size : 18}px;
    font-weight: 600;
    padding: ${Math.round(height * 0.015)}px ${Math.round(width * 0.04)}px;
    border-radius: 100px;
    font-family: 'Sora', 'Inter', sans-serif;
  }

  .trust-badges {
    position: absolute;
    bottom: 3%;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: ${Math.round(width * 0.04)}px;
    z-index: 10;
  }
  .trust-badges img {
    height: ${Math.round(height * 0.06)}px;
    width: auto;
  }
</style>
</head>
<body>

  ${chevronAsset && layout.chevrons && layout.chevrons.visible !== false ? `<div class="chevrons"><img src="${chevronAsset.file_path}" /></div>` : ''}

  ${logoAsset ? `<div class="logo"><img src="${logoAsset.file_path}" /></div>` : ''}

  <div class="person"><img src="${personImageUrl}" /></div>

  <div class="text-area">
    <div class="headline">${headlineHtml}</div>
    <div class="subheadline">${subheadlineHtml}</div>
    ${iconAsset ? `<div class="icon-wrapper"><img src="${iconAsset.file_path}" /></div>` : ''}
    <div class="cta-text">${ctaTextHtml}</div>
    <div class="cta-button">${escapeHtml(copyConfig.cta_button || 'CoastalDebt.com')}</div>
  </div>

  ${badges.length > 0 && layout.trust_badges && layout.trust_badges.visible !== false ? `
  <div class="trust-badges">
    ${badges.map(b => `<img src="${b.file_path}" alt="${escapeHtml(b.name)}" />`).join('\n    ')}
  </div>` : ''}

</body>
</html>`;

  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { renderAdHtml };
```

- [ ] **Step 2: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/services/html-renderer.js
git commit -m "feat: add HTML renderer service for ad composition"
```

---

### Task 10: Puppeteer Renderer Service

**Files:**
- Create: `server/services/puppeteer-renderer.js`

- [ ] **Step 1: Create the Puppeteer renderer**

```javascript
// server/services/puppeteer-renderer.js

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', '..', 'public', 'uploads');

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  return browserInstance;
}

async function renderHtmlToPng(htmlString, width, height, outputFilename) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Write HTML to temp file so local file:// URLs for images resolve
    const tempHtmlPath = path.join(uploadsDir, `_temp-render-${Date.now()}.html`);

    // Rewrite /lp/uploads/ paths to absolute file:// paths
    const resolvedHtml = htmlString.replace(
      /src="\/lp\/uploads\//g,
      `src="file://${uploadsDir}/`
    );

    fs.writeFileSync(tempHtmlPath, resolvedHtml);
    await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle0', timeout: 15000 });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    const outputPath = path.join(uploadsDir, outputFilename);
    await page.screenshot({
      path: outputPath,
      type: 'png',
      clip: { x: 0, y: 0, width, height }
    });

    // Clean up temp HTML
    try { fs.unlinkSync(tempHtmlPath); } catch (e) {}

    return {
      file_path: outputPath,
      url: `/lp/uploads/${outputFilename}`
    };
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// Close browser on process exit
process.on('exit', () => { if (browserInstance) browserInstance.close().catch(() => {}); });

module.exports = { renderHtmlToPng, closeBrowser };
```

- [ ] **Step 2: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/services/puppeteer-renderer.js
git commit -m "feat: add Puppeteer renderer service for HTML-to-PNG conversion"
```

---

### Task 11: Ad Compositor Service (Orchestrator)

**Files:**
- Create: `server/services/ad-compositor.js`

- [ ] **Step 1: Create the compositor**

```javascript
// server/services/ad-compositor.js

const { generateLayout } = require('./layout-engine');
const { renderAdHtml } = require('./html-renderer');
const { renderHtmlToPng } = require('./puppeteer-renderer');

const AD_SIZES = [
  { label: 'feed_landscape', name: 'Feed / Landscape', width: 1200, height: 628 },
  { label: 'square', name: 'Square', width: 1080, height: 1080 },
  { label: 'story_reel', name: 'Story / Reel', width: 1080, height: 1920 },
  { label: 'carousel_square', name: 'Carousel Square', width: 1200, height: 1200 }
];

async function composeAd(personImageUrl, copyConfig, selectedAssets, personInfo) {
  const results = [];

  for (const size of AD_SIZES) {
    // 1. Get layout from Claude
    const layout = await generateLayout(
      personInfo || {},
      copyConfig,
      selectedAssets,
      size.label,
      size.width,
      size.height
    );

    // 2. Build HTML
    const html = renderAdHtml(layout, copyConfig, personImageUrl, selectedAssets, size.width, size.height);

    // 3. Render to PNG
    const filename = `ad-composed-${size.label}-${Date.now()}.png`;
    const rendered = await renderHtmlToPng(html, size.width, size.height, filename);

    results.push({
      size_label: size.label,
      size_name: size.name,
      width: size.width,
      height: size.height,
      image_url: rendered.url,
      layout_json: layout
    });
  }

  return results;
}

async function recomposeAd(personImageUrl, copyConfig, selectedAssets, personInfo, sizeLabel) {
  const size = AD_SIZES.find(s => s.label === sizeLabel) || AD_SIZES[0];

  const layout = await generateLayout(personInfo || {}, copyConfig, selectedAssets, size.label, size.width, size.height);
  const html = renderAdHtml(layout, copyConfig, personImageUrl, selectedAssets, size.width, size.height);
  const filename = `ad-composed-${size.label}-${Date.now()}.png`;
  const rendered = await renderHtmlToPng(html, size.width, size.height, filename);

  return {
    size_label: size.label,
    size_name: size.name,
    width: size.width,
    height: size.height,
    image_url: rendered.url,
    layout_json: layout
  };
}

module.exports = { composeAd, recomposeAd, AD_SIZES };
```

- [ ] **Step 2: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/services/ad-compositor.js
git commit -m "feat: add ad compositor orchestrator service"
```

---

### Task 12: Compose & Recompose API Endpoints

**Files:**
- Modify: `server/routes/ad-generator.js`

- [ ] **Step 1: Import compositor at top of file**

After the background-remover import added in Task 6, add:

```javascript
const { composeAd, recomposeAd } = require('../services/ad-compositor');
```

- [ ] **Step 2: Add POST /compose endpoint**

Add after the generate-copy-v2 endpoint:

```javascript
// ============ COMPOSE AD (V2) ============

router.post('/compose', authenticateToken, async (req, res) => {
  const { person_image_url, copy_config, selected_asset_ids, person_info } = req.body;

  if (!person_image_url) return res.status(400).json({ error: 'person_image_url is required' });
  if (!copy_config || !copy_config.headline) return res.status(400).json({ error: 'copy_config with headline is required' });

  try {
    // Fetch selected brand assets from DB
    let selectedAssets = [];
    if (Array.isArray(selected_asset_ids) && selected_asset_ids.length > 0) {
      const placeholders = selected_asset_ids.map(() => '?').join(',');
      selectedAssets = db.prepare(`SELECT * FROM brand_assets WHERE id IN (${placeholders})`).all(...selected_asset_ids);
    }

    const results = await composeAd(person_image_url, copy_config, selectedAssets, person_info);

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'ad_composition', null, `Composed ad in ${results.length} sizes`, req.ip);
    res.json({ compositions: results });
  } catch (err) {
    console.error('Compose error:', err);
    res.status(500).json({ error: 'Composition failed: ' + err.message });
  }
});
```

- [ ] **Step 3: Add POST /recompose endpoint**

```javascript
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
```

- [ ] **Step 4: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add server/routes/ad-generator.js
git commit -m "feat: add compose and recompose ad endpoints"
```

---

### Task 13: Ship Default Brand Assets

**Files:**
- Create: `admin/assets/brand-assets/` directory with SVG/PNG files

- [ ] **Step 1: Create brand assets directory and SVG icons**

```bash
mkdir -p /Users/baralezrah/coastal-debt-cms/admin/assets/brand-assets
```

Create `admin/assets/brand-assets/icon-dollar-hand.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#3052FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M32 8v4M32 52v4M24 16c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8h-4c-4.4 0-8 3.6-8 8s3.6 8 8 8 8-3.6 8-8"/>
  <path d="M8 48c8-4 12-8 16-8h8c2.2 0 4 1.8 4 4s-1.8 4-4 4h-6"/>
  <path d="M8 56l12-8h12l12 4"/>
</svg>
```

Create `admin/assets/brand-assets/icon-phone.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#3052FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 4h16a4 4 0 014 4v48a4 4 0 01-4 4H12a4 4 0 01-4-4V8a4 4 0 014-4z"/>
  <line x1="16" y1="52" x2="24" y2="52"/>
  <path d="M36 20l8-8 12 12-8 8a32 32 0 01-12-12z"/>
</svg>
```

Create `admin/assets/brand-assets/icon-shield.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#3052FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M32 4L8 16v16c0 14.4 10.4 27.2 24 32 13.6-4.8 24-17.6 24-32V16L32 4z"/>
  <polyline points="22,32 30,40 42,24"/>
</svg>
```

Create `admin/assets/brand-assets/icon-checkmark.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#3052FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="32" cy="32" r="28"/>
  <polyline points="20,32 28,42 44,22"/>
</svg>
```

Create `admin/assets/brand-assets/chevron-blue.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 200" fill="#3052FF">
  <polygon points="0,0 80,0 120,100 80,200 0,200 40,100"/>
  <polygon points="10,20 70,20 100,100 70,180 10,180 40,100" fill="#3052FF" opacity="0.7" transform="translate(20, 0)"/>
</svg>
```

- [ ] **Step 2: Create a seed script to auto-populate brand assets on first run**

Add to the bottom of `server/routes/ad-generator.js`, before `module.exports`:

```javascript
// ============ SEED DEFAULT BRAND ASSETS ============
(function seedDefaultAssets() {
  const count = db.prepare('SELECT COUNT(*) as c FROM brand_assets').get().c;
  if (count > 0) return; // already seeded

  const defaultAssets = [
    { category: 'decorative', name: 'Blue Chevrons', filename: 'chevron-blue.svg' },
    { category: 'icon', name: 'Dollar Hand', filename: 'icon-dollar-hand.svg' },
    { category: 'icon', name: 'Phone', filename: 'icon-phone.svg' },
    { category: 'icon', name: 'Shield', filename: 'icon-shield.svg' },
    { category: 'icon', name: 'Checkmark', filename: 'icon-checkmark.svg' }
  ];

  const insert = db.prepare('INSERT INTO brand_assets (category, name, file_path) VALUES (?, ?, ?)');
  for (const asset of defaultAssets) {
    const assetPath = `/assets/brand-assets/${asset.filename}`;
    insert.run(asset.category, asset.name, assetPath);
  }
  console.log('[Ad Generator] Seeded default brand assets');
})();
```

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add admin/assets/brand-assets/ server/routes/ad-generator.js
git commit -m "feat: ship default brand asset SVGs and auto-seed on first run"
```

---

### Task 14: Frontend — Prompt Builder UI (Step 1)

**Files:**
- Modify: `admin/ad-generator.html`

- [ ] **Step 1: Add prompt builder HTML**

Find the Step 1 panel (`id="step1"`) in `admin/ad-generator.html`. Locate the existing prompt textarea and model/size selection area. Add the prompt builder above the existing prompt textarea:

```html
<!-- Prompt Builder -->
<div class="prompt-builder-section" style="margin-bottom: 20px;">
  <label class="field-label" style="font-size: 13px; font-weight: 600; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 12px;">Person Description</label>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Gender</label>
      <select id="pb-gender" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Age Range</label>
      <select id="pb-age" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="25-35">25-35</option>
        <option value="35-45">35-45</option>
        <option value="45-55">45-55</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Ethnicity</label>
      <select id="pb-ethnicity" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="Caucasian">Caucasian</option>
        <option value="African American">African American</option>
        <option value="Hispanic/Latino">Hispanic/Latino</option>
        <option value="Asian">Asian</option>
        <option value="Middle Eastern">Middle Eastern</option>
        <option value="South Asian">South Asian</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Pose</label>
      <select id="pb-pose" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="Standing confident">Standing confident</option>
        <option value="Arms crossed">Arms crossed</option>
        <option value="Hands clasped">Hands clasped</option>
        <option value="Leaning casual">Leaning casual</option>
        <option value="Pointing">Pointing</option>
        <option value="Thumbs up">Thumbs up</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Expression</label>
      <select id="pb-expression" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="Warm smile">Warm smile</option>
        <option value="Confident">Confident</option>
        <option value="Serious/professional">Serious/professional</option>
        <option value="Friendly">Friendly</option>
        <option value="Relieved/hopeful">Relieved/hopeful</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Attire</label>
      <select id="pb-attire" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="Business formal (suit)">Business formal</option>
        <option value="Business casual">Business casual</option>
        <option value="Casual">Casual</option>
        <option value="Trade/work uniform">Trade/work uniform</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Framing</label>
      <select id="pb-framing" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="">Select...</option>
        <option value="Half body">Half body</option>
        <option value="Full body">Full body</option>
        <option value="Head & shoulders">Head & shoulders</option>
      </select>
    </div>
    <div>
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Background</label>
      <select id="pb-background" class="pb-select" style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px; background: #fff;">
        <option value="Transparent" selected>Transparent (recommended)</option>
        <option value="Office">Office</option>
        <option value="Outdoor">Outdoor</option>
        <option value="Studio plain">Studio plain</option>
      </select>
    </div>
  </div>
  <div style="margin-top: 12px;">
    <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 4px; display: block;">Extra Details (optional)</label>
    <input type="text" id="pb-extra" placeholder="e.g. wearing glasses, holding a tablet..." style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px;">
  </div>
  <div id="pb-preview" style="margin-top: 12px; padding: 12px; background: var(--gray-100); border-radius: 8px; font-size: 13px; color: var(--gray-600); font-style: italic; display: none;">
    <!-- Auto-generated prompt preview -->
  </div>
</div>
```

- [ ] **Step 2: Add prompt builder JavaScript**

Add to the `<script>` section of `ad-generator.html`:

```javascript
// ============ PROMPT BUILDER ============

function getPromptBuilderConfig() {
  return {
    gender: document.getElementById('pb-gender').value,
    age_range: document.getElementById('pb-age').value,
    ethnicity: document.getElementById('pb-ethnicity').value,
    pose: document.getElementById('pb-pose').value,
    expression: document.getElementById('pb-expression').value,
    attire: document.getElementById('pb-attire').value,
    framing: document.getElementById('pb-framing').value,
    background: document.getElementById('pb-background').value,
    extra_details: document.getElementById('pb-extra').value
  };
}

function updatePromptPreview() {
  const config = getPromptBuilderConfig();
  const required = ['gender', 'age_range', 'ethnicity', 'pose', 'expression', 'attire', 'framing', 'background'];
  const missing = required.filter(k => !config[k]);
  const preview = document.getElementById('pb-preview');

  if (missing.length > 0) {
    preview.style.display = 'none';
    return;
  }

  const bgText = config.background === 'Transparent'
    ? 'solid white background for easy background removal'
    : `${config.background.toLowerCase()} background`;

  let prompt = `Professional photo of a ${config.gender.toLowerCase()}, age ${config.age_range}, ${config.ethnicity}, ${config.pose.toLowerCase()}, ${config.expression.toLowerCase()} expression, wearing ${config.attire.toLowerCase()} attire, ${config.framing.toLowerCase()} shot, ${bgText}, studio lighting, high quality, photorealistic`;
  if (config.extra_details.trim()) prompt += `, ${config.extra_details.trim()}`;

  preview.style.display = 'block';
  preview.textContent = prompt;

  // Also set the main prompt textarea if it exists
  const promptTextarea = document.getElementById('adPrompt');
  if (promptTextarea) promptTextarea.value = prompt;
}

// Bind all prompt builder dropdowns
document.querySelectorAll('.pb-select, #pb-extra').forEach(el => {
  el.addEventListener('change', updatePromptPreview);
  el.addEventListener('input', updatePromptPreview);
});
```

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add admin/ad-generator.html
git commit -m "feat: add prompt builder dropdown UI to step 1"
```

---

### Task 15: Frontend — Brand Assets UI (Step 3)

**Files:**
- Modify: `admin/ad-generator.html`

- [ ] **Step 1: Add brand assets section to Step 3**

Find the Step 3 panel in `ad-generator.html`. After the existing logo section, add:

```html
<!-- Brand Assets Library -->
<div style="margin-top: 24px; border-top: 1px solid var(--gray-200); padding-top: 20px;">
  <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 16px;">Brand Assets</h3>
  <div id="brand-assets-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 12px;">
    <!-- Populated by JS -->
  </div>

  <!-- Upload new asset -->
  <div style="margin-top: 16px; padding: 16px; background: var(--gray-100); border-radius: 10px;">
    <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Upload New Asset</div>
    <div style="display: flex; gap: 8px; align-items: end; flex-wrap: wrap;">
      <div>
        <label style="font-size: 11px; color: var(--gray-500); display: block; margin-bottom: 4px;">Category</label>
        <select id="asset-upload-category" style="padding: 8px; border: 1px solid var(--gray-200); border-radius: 6px; font-size: 13px;">
          <option value="decorative">Decorative</option>
          <option value="badge">Trust Badge</option>
          <option value="icon">Icon</option>
          <option value="logo">Logo</option>
        </select>
      </div>
      <div>
        <label style="font-size: 11px; color: var(--gray-500); display: block; margin-bottom: 4px;">Name</label>
        <input type="text" id="asset-upload-name" placeholder="e.g. Trustpilot Badge" style="padding: 8px; border: 1px solid var(--gray-200); border-radius: 6px; font-size: 13px;">
      </div>
      <div>
        <label style="font-size: 11px; color: var(--gray-500); display: block; margin-bottom: 4px;">File</label>
        <input type="file" id="asset-upload-file" accept=".png,.jpg,.jpeg,.webp,.svg" style="font-size: 12px;">
      </div>
      <button onclick="uploadBrandAsset()" style="padding: 8px 16px; background: #3052FF; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;">Upload</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add brand assets JavaScript**

```javascript
// ============ BRAND ASSETS ============

let allBrandAssets = { logo: [], decorative: [], badge: [], icon: [] };
let selectedAssetIds = new Set();

async function loadBrandAssets() {
  try {
    const res = await fetch('/api/ad-generator/brand-assets', { headers: { 'Authorization': `Bearer ${getToken()}` } });
    allBrandAssets = await res.json();
    renderBrandAssetsGrid();
  } catch (err) {
    console.error('Failed to load brand assets:', err);
  }
}

function renderBrandAssetsGrid() {
  const grid = document.getElementById('brand-assets-grid');
  if (!grid) return;

  const allAssets = [...(allBrandAssets.logo || []), ...(allBrandAssets.decorative || []), ...(allBrandAssets.badge || []), ...(allBrandAssets.icon || [])];
  if (allAssets.length === 0) {
    grid.innerHTML = '<div style="color: var(--gray-400); font-size: 13px; grid-column: 1 / -1;">No brand assets uploaded yet.</div>';
    return;
  }

  grid.innerHTML = allAssets.map(asset => {
    const isSelected = selectedAssetIds.has(asset.id);
    return `<div onclick="toggleAsset(${asset.id})" style="border: 2px solid ${isSelected ? '#3052FF' : 'var(--gray-200)'}; border-radius: 10px; padding: 10px; text-align: center; cursor: pointer; background: ${isSelected ? '#eef1ff' : '#fff'}; transition: all 0.15s; position: relative;">
      <img src="${asset.file_path}" style="width: 48px; height: 48px; object-fit: contain; margin-bottom: 6px;" onerror="this.style.display='none'">
      <div style="font-size: 11px; font-weight: 600; color: var(--gray-700); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${asset.name}</div>
      <div style="font-size: 10px; color: var(--gray-400); text-transform: uppercase;">${asset.category}</div>
      ${isSelected ? '<div style="position: absolute; top: 4px; right: 4px; background: #3052FF; color: #fff; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; display: flex; align-items: center; justify-content: center;">✓</div>' : ''}
    </div>`;
  }).join('');
}

function toggleAsset(id) {
  if (selectedAssetIds.has(id)) {
    selectedAssetIds.delete(id);
  } else {
    selectedAssetIds.add(id);
  }
  renderBrandAssetsGrid();
}

async function uploadBrandAsset() {
  const category = document.getElementById('asset-upload-category').value;
  const name = document.getElementById('asset-upload-name').value;
  const fileInput = document.getElementById('asset-upload-file');

  if (!name || !fileInput.files[0]) {
    alert('Please provide a name and file');
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('category', category);
  formData.append('name', name);

  try {
    const res = await fetch('/api/ad-generator/brand-assets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}` },
      body: formData
    });
    if (!res.ok) throw new Error((await res.json()).error);
    document.getElementById('asset-upload-name').value = '';
    fileInput.value = '';
    await loadBrandAssets();
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
}

// Load assets when step 3 is shown
```

- [ ] **Step 3: Call loadBrandAssets when step 3 activates**

In the existing `goToStep()` function, add inside the `case 3` or equivalent:

```javascript
if (step === 3) loadBrandAssets();
```

- [ ] **Step 4: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add admin/ad-generator.html
git commit -m "feat: add brand assets library UI to step 3"
```

---

### Task 16: Frontend — Ad Copy V2 UI (Step 2)

**Files:**
- Modify: `admin/ad-generator.html`

- [ ] **Step 1: Restructure Step 2 for ad copy generation**

In the Step 2 panel, add a new section before the canvas editor that lets users generate and edit structured copy. Add this at the top of the step 2 panel:

```html
<!-- Ad Copy Generation -->
<div id="copy-generation-section" style="margin-bottom: 20px; padding: 20px; background: #fff; border: 1px solid var(--gray-200); border-radius: 12px;">
  <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 16px;">Ad Copy</h3>
  <div style="display: flex; gap: 12px; margin-bottom: 16px; align-items: end;">
    <div style="flex: 1;">
      <label style="font-size: 12px; font-weight: 600; color: var(--gray-500); display: block; margin-bottom: 4px;">Topic / Angle (optional)</label>
      <input type="text" id="copy-topic" placeholder="e.g. urgency, savings, fresh start..." style="width: 100%; padding: 10px 12px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px;">
    </div>
    <button onclick="generateCopyV2()" id="btn-gen-copy" style="padding: 10px 20px; background: #3052FF; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Generate Copy</button>
  </div>

  <div id="copy-fields" style="display: none;">
    <div style="margin-bottom: 12px;">
      <label style="font-size: 11px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.5px;">Headline</label>
      <input type="text" id="copy-headline" style="width: 100%; padding: 10px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 18px; font-weight: 700;">
    </div>
    <div style="margin-bottom: 12px;">
      <label style="font-size: 11px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.5px;">Highlight Words (comma-separated, shown in blue)</label>
      <input type="text" id="copy-highlight" style="width: 100%; padding: 10px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px;" placeholder="e.g. MCA Debt">
    </div>
    <div style="margin-bottom: 12px;">
      <label style="font-size: 11px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.5px;">Subheadline</label>
      <input type="text" id="copy-subheadline" style="width: 100%; padding: 10px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px;">
    </div>
    <div style="margin-bottom: 12px;">
      <label style="font-size: 11px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.5px;">CTA Text</label>
      <input type="text" id="copy-cta-text" style="width: 100%; padding: 10px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px;">
    </div>
    <div>
      <label style="font-size: 11px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.5px;">CTA Button</label>
      <input type="text" id="copy-cta-button" value="CoastalDebt.com" style="width: 100%; padding: 10px; border: 2px solid var(--gray-200); border-radius: 8px; font-size: 14px;" readonly>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add copy generation JavaScript**

```javascript
// ============ AD COPY V2 ============

let currentCopyConfig = null;

async function generateCopyV2() {
  const btn = document.getElementById('btn-gen-copy');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const res = await fetch('/api/ad-generator/generate-copy-v2', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: document.getElementById('copy-topic').value })
    });
    const data = await res.json();

    document.getElementById('copy-headline').value = data.headline;
    document.getElementById('copy-highlight').value = (data.highlight_words || []).join(', ');
    document.getElementById('copy-subheadline').value = data.subheadline;
    document.getElementById('copy-cta-text').value = data.cta_text;
    document.getElementById('copy-cta-button').value = data.cta_button || 'CoastalDebt.com';
    document.getElementById('copy-fields').style.display = 'block';

    currentCopyConfig = data;
  } catch (err) {
    alert('Copy generation failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Copy';
  }
}

function getCopyConfig() {
  return {
    headline: document.getElementById('copy-headline').value,
    highlight_words: document.getElementById('copy-highlight').value.split(',').map(s => s.trim()).filter(Boolean),
    subheadline: document.getElementById('copy-subheadline').value,
    subheadline_bold: currentCopyConfig ? currentCopyConfig.subheadline_bold : [],
    cta_text: document.getElementById('copy-cta-text').value,
    cta_text_bold: currentCopyConfig ? currentCopyConfig.cta_text_bold : [],
    cta_button: document.getElementById('copy-cta-button').value
  };
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add admin/ad-generator.html
git commit -m "feat: add structured ad copy UI to step 2"
```

---

### Task 17: Frontend — Compose & Export UI (Step 4)

**Files:**
- Modify: `admin/ad-generator.html`

- [ ] **Step 1: Update wizard steps to rename step 4**

Find the wizard step for step 4 in the HTML. Change the label from "Ad Copy" to "Compose & Export":

```html
<div class="wizard-step" data-step="4" onclick="goToStep(4)">
  <span class="wizard-step-num">4</span> Compose & Export
</div>
```

Also rename step 2 label to "Ad Copy" and step 3 stays "Brand Assets" (adjust existing labels as needed to match the new flow: 1=Generate, 2=Ad Copy, 3=Brand Assets, 4=Compose & Export).

- [ ] **Step 2: Add Step 4 compose panel HTML**

Add a new step panel for the compose step:

```html
<div class="step-panel" id="step4-compose">
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
    <h2 style="font-size: 20px; font-weight: 700;">Compose & Export</h2>
    <div style="display: flex; gap: 8px;">
      <button onclick="composeAd()" id="btn-compose" style="padding: 10px 24px; background: #3052FF; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;">Compose All Sizes</button>
      <button onclick="downloadAllComposed()" id="btn-download-all" style="padding: 10px 24px; background: #065f46; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; display: none;">Download All</button>
    </div>
  </div>

  <div id="compose-status" style="display: none; padding: 16px; background: #eef1ff; border-radius: 10px; margin-bottom: 20px; font-size: 14px; color: #3052FF; font-weight: 500;">
    Composing ads... this may take a moment.
  </div>

  <div id="compose-results" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
    <!-- Populated by JS -->
  </div>
</div>
```

- [ ] **Step 3: Add compose JavaScript**

```javascript
// ============ COMPOSE & EXPORT ============

let composedResults = [];

async function composeAd() {
  const btn = document.getElementById('btn-compose');
  const status = document.getElementById('compose-status');
  btn.disabled = true;
  btn.textContent = 'Composing...';
  status.style.display = 'block';
  document.getElementById('compose-results').innerHTML = '';
  document.getElementById('btn-download-all').style.display = 'none';

  // Gather the selected person image (from step 1 — the user's chosen generation)
  const personImageUrl = getSelectedPersonImage();
  if (!personImageUrl) {
    alert('Please select a person image in Step 1 first');
    btn.disabled = false;
    btn.textContent = 'Compose All Sizes';
    status.style.display = 'none';
    return;
  }

  const copyConfig = getCopyConfig();
  if (!copyConfig.headline) {
    alert('Please generate ad copy in Step 2 first');
    btn.disabled = false;
    btn.textContent = 'Compose All Sizes';
    status.style.display = 'none';
    return;
  }

  const personInfo = { framing: document.getElementById('pb-framing').value || 'Half body' };

  try {
    const res = await fetch('/api/ad-generator/compose', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        person_image_url: personImageUrl,
        copy_config: copyConfig,
        selected_asset_ids: Array.from(selectedAssetIds),
        person_info: personInfo
      })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();
    composedResults = data.compositions;

    renderComposedResults();
    document.getElementById('btn-download-all').style.display = 'inline-block';
  } catch (err) {
    alert('Composition failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compose All Sizes';
    status.style.display = 'none';
  }
}

function renderComposedResults() {
  const container = document.getElementById('compose-results');
  container.innerHTML = composedResults.map((r, i) => `
    <div style="background: #fff; border: 1px solid var(--gray-200); border-radius: 12px; overflow: hidden;">
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--gray-200); display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="font-weight: 600; font-size: 14px;">${r.size_name}</span>
          <span style="font-size: 12px; color: var(--gray-400); margin-left: 8px;">${r.width}x${r.height}</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button onclick="recomposeSize('${r.size_label}')" style="padding: 4px 12px; background: var(--gray-100); border: 1px solid var(--gray-200); border-radius: 6px; font-size: 12px; cursor: pointer;">Re-compose</button>
          <a href="${r.image_url}" download="ad-${r.size_label}.png" style="padding: 4px 12px; background: #3052FF; color: #fff; border-radius: 6px; font-size: 12px; text-decoration: none; display: inline-block;">Download</a>
        </div>
      </div>
      <div style="padding: 12px; text-align: center; background: var(--gray-100);">
        <img src="${r.image_url}" style="max-width: 100%; max-height: 400px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
      </div>
    </div>
  `).join('');
}

async function recomposeSize(sizeLabel) {
  const personImageUrl = getSelectedPersonImage();
  const copyConfig = getCopyConfig();
  const personInfo = { framing: document.getElementById('pb-framing').value || 'Half body' };

  try {
    const res = await fetch('/api/ad-generator/recompose', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        person_image_url: personImageUrl,
        copy_config: copyConfig,
        selected_asset_ids: Array.from(selectedAssetIds),
        person_info: personInfo,
        size_label: sizeLabel
      })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    const result = await res.json();

    // Replace in results
    const idx = composedResults.findIndex(r => r.size_label === sizeLabel);
    if (idx !== -1) composedResults[idx] = result;
    renderComposedResults();
  } catch (err) {
    alert('Re-compose failed: ' + err.message);
  }
}

function downloadAllComposed() {
  composedResults.forEach(r => {
    const a = document.createElement('a');
    a.href = r.image_url;
    a.download = `ad-${r.size_label}.png`;
    a.click();
  });
}

// Helper: get the currently selected person image from step 1
function getSelectedPersonImage() {
  // Look for the selected/active generation image in the step 1 gallery
  const selectedImg = document.querySelector('.gen-result-img.selected, .generation-card.selected img');
  if (selectedImg) return selectedImg.getAttribute('src') || selectedImg.getAttribute('data-url');

  // Fallback: get the first completed generation
  const firstImg = document.querySelector('.gen-result-img, .generation-card img');
  return firstImg ? (firstImg.getAttribute('src') || firstImg.getAttribute('data-url')) : null;
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add admin/ad-generator.html
git commit -m "feat: add compose & export UI as step 4 with re-compose and download"
```

---

### Task 18: Wire Up Background Removal in Step 1

**Files:**
- Modify: `admin/ad-generator.html`

- [ ] **Step 1: Add background removal button to generation results**

In the generation results area (where generated images are displayed in step 1), add a "Remove Background" button for each result. Find where generation result cards are rendered and add:

```javascript
// After a generation completes and shows in the gallery, add this to each card's button area:
`<button onclick="removeBg('${gen.image_url}', this)" style="padding: 4px 10px; background: var(--gray-100); border: 1px solid var(--gray-200); border-radius: 6px; font-size: 11px; cursor: pointer;">Remove BG</button>`
```

- [ ] **Step 2: Add removeBg function**

```javascript
async function removeBg(imageUrl, btn) {
  btn.disabled = true;
  btn.textContent = 'Removing...';
  try {
    const res = await fetch('/api/ad-generator/remove-background', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();

    // Update the image src to the transparent version
    const card = btn.closest('.generation-card, .gen-result');
    const img = card.querySelector('img');
    if (img) img.src = data.transparent_url;
    btn.textContent = 'BG Removed ✓';
    btn.style.background = '#d1fae5';
    btn.style.color = '#065f46';
  } catch (err) {
    alert('Background removal failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Remove BG';
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add admin/ad-generator.html
git commit -m "feat: add background removal button to generated images in step 1"
```

---

### Task 19: Integration Testing — Full Pipeline

**Files:**
- No new files, manual verification

- [ ] **Step 1: Start the server and verify all endpoints exist**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
const app = require('./server/routes/ad-generator');
const routes = [];
app.stack.forEach(layer => {
  if (layer.route) routes.push(layer.route.methods ? Object.keys(layer.route.methods).join(',').toUpperCase() + ' ' + layer.route.path : layer.route.path);
});
console.log('Routes:', routes.join('\n'));
" 2>/dev/null || echo "Run server manually to test"
```

- [ ] **Step 2: Test prompt builder service directly**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
const { buildPrompt, validateConfig } = require('./server/services/prompt-builder');
const config = { gender: 'Female', age_range: '45-55', ethnicity: 'African American', pose: 'Hands clasped', expression: 'Warm smile', attire: 'Business casual', framing: 'Half body', background: 'Transparent' };
const errors = validateConfig(config);
console.log('Validation errors:', errors);
console.log('Prompt:', buildPrompt(config));
"
```

- [ ] **Step 3: Test HTML renderer output**

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
const { renderAdHtml } = require('./server/services/html-renderer');
const layout = { background_color: '#F2F4F9', person: { position: 'left', vertical_align: 'bottom', width_percent: 45, offset_x_percent: 0, offset_y_percent: 0 }, chevrons: { visible: false }, logo: { position: 'top-right' }, headline: { font_size: 42 }, subheadline: { font_size: 18 }, icon: { visible: false }, cta_text: { font_size: 16 }, cta_button: { bg_color: '#3052FF', text_color: '#FFFFFF', font_size: 18 }, trust_badges: { visible: false } };
const copy = { headline: 'Test Headline', highlight_words: ['Test'], subheadline: 'Test sub', cta_text: 'Click here:', cta_button: 'CoastalDebt.com' };
const html = renderAdHtml(layout, copy, '/lp/uploads/test.png', [], 1080, 1080);
console.log('HTML length:', html.length);
console.log('Contains Sora font:', html.includes('Sora'));
console.log('Contains headline:', html.includes('Test Headline'));
"
```

- [ ] **Step 4: Start the server and test in browser**

```bash
cd /Users/baralezrah/coastal-debt-cms && npm start
```

Open the ad generator, walk through all 4 steps, verify:
1. Prompt builder dropdowns populate the prompt textarea
2. Ad copy generation returns structured fields
3. Brand assets load and can be toggled
4. Compose button calls the API and renders results

- [ ] **Step 5: Commit any fixes**

```bash
cd /Users/baralezrah/coastal-debt-cms
git add -A
git commit -m "fix: integration fixes for ad generator v2 pipeline"
```

---

### Task 20: Deploy

**Files:**
- None (git push)

- [ ] **Step 1: Push to main**

```bash
cd /Users/baralezrah/coastal-debt-cms && git push origin main
```

Railway auto-deploys from main.

- [ ] **Step 2: Verify Puppeteer works on Railway**

Puppeteer on Railway may need the `@sparticuz/chromium` package if the default Chrome binary isn't available. If deploy fails with Chrome errors, install it:

```bash
npm install @sparticuz/chromium
```

Then update `puppeteer-renderer.js` to use it:

```javascript
const chromium = require('@sparticuz/chromium');

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: chromium.args,
    executablePath: await chromium.executablePath() || undefined
  });
  return browserInstance;
}
```
