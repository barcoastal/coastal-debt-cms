# Ad Generator V2 — Template-Based Ad Composition

## Problem

The current ad generator produces AI background images, then requires users to manually place text, logos, and badges in a Fabric.js canvas. This is slow, requires design skill, and produces inconsistent results. Users need to generate polished, brand-consistent ads like the Coastal Debt Resolve reference ad — complete with person photo, headline, subheadline, CTA button, trust badges, chevron decorations, and logo — without design expertise.

## Solution

Upgrade the existing 4-step ad generator wizard so each step collects a specific ingredient, then a new composition engine assembles everything into a finished, brand-consistent ad rendered as PNG in all 4 sizes.

---

## Step 1: Generate Person Image (with Prompt Builder)

### What changes

Replace the freeform prompt input with a **dropdown-based prompt builder**. Users select options from dropdowns; the tool assembles a prompt automatically.

### Prompt Builder Dropdowns

| Field | Options |
|-------|---------|
| Gender | Male, Female |
| Age Range | 25-35, 35-45, 45-55 |
| Ethnicity | Caucasian, African American, Hispanic/Latino, Asian, Middle Eastern, South Asian |
| Pose | Standing confident, Arms crossed, Hands clasped, Leaning casual, Pointing, Thumbs up |
| Expression | Warm smile, Confident, Serious/professional, Friendly, Relieved/hopeful |
| Attire | Business formal (suit), Business casual, Casual, Trade/work uniform |
| Framing | Half body, Full body, Head & shoulders |
| Background | Transparent (default), Office, Outdoor, Studio plain |

### Additional fields

- **Extra Details** — optional free-text for specifics ("wearing glasses", "holding a tablet")
- **Model Selector** — Midjourney, Flux, or Gemini (same as current)
- **Variations** — generate 1-5 variations to pick from

### Prompt assembly

The tool builds the prompt string from selections:

```
"Professional photo of a [gender], age [age_range], [ethnicity], [pose], [expression], wearing [attire], [framing] shot, [background] background, studio lighting, high quality"
```

The brand preprompt is appended automatically (same as current behavior).

### Background removal

After the AI generates the person image, the tool automatically removes the background to produce a transparent PNG. This is required for compositing in Step 4. The "Transparent" background option in the dropdown instructs the AI to generate on a plain background (easier removal), but background removal runs regardless.

### What stays the same

- AI model selection (Midjourney/Flux/Gemini)
- Reference image upload (optional)
- Bulk generation with progress tracking
- Image gallery to pick from variations

---

## Step 2: Ad Copy

### What changes

Restructure the copy generation to produce the specific text elements needed for the template layout.

### Copy elements generated

| Element | Description | Example |
|---------|-------------|---------|
| Headline | 3-6 words, bold, mixed color styling | "Understanding Your **MCA Debt** Matters!" |
| Highlight words | Which words in the headline render in brand blue (#3052FF) | "MCA Debt" |
| Subheadline | 8-15 words, one bold keyword | "You need a **solution** tailored to your business challenges." |
| CTA text | Short call-to-action line | "Explore your options with **a free consultation:**" |
| CTA button | Button label (always "CoastalDebt.com") | "CoastalDebt.com" |

### How it works

- Claude generates all copy elements in one call based on a randomly selected MCA/debt angle
- User sees all text fields and can edit any of them inline
- Bold/highlight keywords are editable
- "Regenerate" button to get new copy without losing the person image

### What stays the same

- Meta ad copy generator (separate feature, still available)
- Copywriting angles system

---

## Step 3: Brand Assets

### What changes

Expand the current logo step into a full brand assets manager.

### Asset categories

| Category | Assets | Format |
|----------|--------|--------|
| Logo | Coastal Debt Resolve logos (already exists) | PNG/SVG |
| Decorative | Blue chevron arrows | PNG with transparency |
| Trust Badges | Trustpilot 4.8, ISO 9001:2015, BBB Torch Awards 2026 | PNG |
| Icons | Dollar/hand, phone, shield, checkmark, etc. | SVG/PNG |

### Brand asset library

- One-time upload: assets are stored server-side and persist across all ads
- Upload UI in this step with drag-and-drop per category
- Each asset has a name and category tag
- Toggle checkboxes to include/exclude assets per ad

### What the user does in this step

1. Sees all available brand assets organized by category
2. Checks/unchecks which ones to include in this ad
3. Can upload new assets to the library
4. Logo selection works the same as current step 3

### What stays the same

- Logo selection UI and positioning shortcuts
- Custom logo upload

---

## Step 4: Compose & Export (NEW)

### Overview

This is the new core feature. Takes all outputs from steps 1-3 and assembles a finished ad.

### Composition pipeline

1. **Layout decision** — Claude analyzes the person image (dimensions, pose direction, framing) and returns a layout JSON specifying where each element goes
2. **HTML/CSS assembly** — The tool builds an HTML page using the layout JSON, placing: person image, headline, subheadline, CTA button, logo, chevrons, trust badges, icon
3. **Puppeteer rendering** — Headless browser renders the HTML at each of the 4 ad sizes and screenshots to PNG
4. **Preview** — User sees all 4 sizes side by side
5. **Edit or download** — Accept and download, or load into Fabric.js for manual tweaks

### Layout JSON structure

Claude returns a JSON object describing element placement:

```json
{
  "background_color": "#F2F4F9",
  "person": {
    "position": "left",
    "vertical_align": "bottom",
    "width_percent": 45,
    "z_index": 2
  },
  "chevrons": {
    "position": "top-left",
    "behind_person": true
  },
  "logo": {
    "position": "top-right"
  },
  "headline": {
    "position": "top-right-area",
    "font_size_scale": 1.0
  },
  "subheadline": {
    "position": "middle-right"
  },
  "icon": {
    "position": "middle-center",
    "asset_id": "dollar-hand"
  },
  "cta_text": {
    "position": "below-subheadline"
  },
  "cta_button": {
    "position": "below-cta-text"
  },
  "trust_badges": {
    "position": "bottom-center",
    "layout": "row"
  }
}
```

### Ad sizes rendered

| Size | Dimensions | Aspect Ratio |
|------|-----------|--------------|
| Feed/Landscape | 1200x628 | ~16:9 |
| Square | 1080x1080 | 1:1 |
| Story/Reel | 1080x1920 | 9:16 |
| Carousel | 1200x1200 | 1:1 |

Each size gets its own layout decision from Claude — the story/reel layout will stack elements differently than the landscape layout.

### Re-compose option

If the user doesn't like the layout, they can click "Re-compose" to have Claude generate a different layout arrangement without regenerating the person image or copy.

### Edit fallback

User can load any size into the existing Fabric.js editor for manual adjustments. The composed PNG becomes the canvas background, and elements are overlaid as editable Fabric objects where possible.

---

## Technical Architecture

### New dependencies

- **Puppeteer** — headless Chrome for HTML-to-PNG rendering
- **Background removal** — `@imgly/background-removal-node` or equivalent Node.js library for transparent PNGs

### New database tables/columns

**`brand_assets` table (new)**:
```
id, category (logo|decorative|badge|icon), name, file_path, uploaded_at
```

**`ad_generations` table — new columns**:
```
prompt_builder_config JSON   -- stores dropdown selections
copy_config JSON             -- stores headline, subheadline, CTA, highlight words
selected_assets JSON         -- array of brand_asset IDs included
layout_json JSON             -- Claude's layout decision
composed_urls JSON           -- paths to all 4 rendered sizes
```

### New API endpoints

| Endpoint | Purpose |
|----------|---------|
| POST /api/ad-generator/brand-assets | Upload a brand asset |
| GET /api/ad-generator/brand-assets | List all brand assets by category |
| DELETE /api/ad-generator/brand-assets/:id | Remove a brand asset |
| POST /api/ad-generator/build-prompt | Build prompt string from dropdown selections |
| POST /api/ad-generator/remove-background | Remove background from generated image |
| POST /api/ad-generator/generate-copy | Generate ad copy elements |
| POST /api/ad-generator/compose | Run composition pipeline (layout → HTML → render) |
| POST /api/ad-generator/recompose | Re-run layout with same inputs |

### HTML template system

A set of HTML/CSS templates that the composition engine populates:

- Base template with Aeonik font loading, brand color variables
- Element positioning via CSS Grid / absolute positioning driven by layout JSON
- Responsive variants per ad size
- The template produces pixel-perfect output matching the reference ad style

### File structure (new files)

```
server/
  routes/ad-generator.js          -- existing, modified
  services/
    prompt-builder.js             -- builds prompt from dropdowns
    background-remover.js         -- removes image backgrounds
    ad-compositor.js              -- orchestrates composition pipeline
    layout-engine.js              -- calls Claude for layout decisions
    html-renderer.js              -- builds HTML from layout + assets
    puppeteer-renderer.js         -- renders HTML to PNG
  templates/
    ad-base.html                  -- base HTML template for ads
    ad-feed.css                   -- feed/landscape layout styles
    ad-square.css                 -- square layout styles
    ad-story.css                  -- story/reel layout styles
    ad-carousel.css               -- carousel layout styles

admin/
  ad-generator.html               -- existing, modified with new steps UI
```

---

## What stays the same

- The 4-step wizard UI pattern
- AI model selection (Midjourney/Flux/Gemini)
- Reference image upload
- Fabric.js canvas editor (for post-composition edits)
- Meta ad copy generator
- Project management (ad_projects)
- Existing generation tracking and polling
- Logo selection (absorbed into brand assets step)
