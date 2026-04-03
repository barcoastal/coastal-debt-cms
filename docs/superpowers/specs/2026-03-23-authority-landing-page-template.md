# Authority Landing Page Template  - Design Spec

**Date:** 2026-03-23
**Status:** Approved
**Template Type:** `authority`

## Overview

A new CMS template type optimized for Google Ads landing page experience score. Combines conversion-optimized above-the-fold design with keyword-rich educational content below. All content is controlled through the CMS admin editor via the `content` JSON  - same pattern as existing templates (`form`, `call`, `game`, `article`).

The first instance will target the "business bankruptcy" keyword cluster, but the template is generic and reusable for any keyword set.

## Target Keywords (First Instance)

- "business bankruptcies"
- "small business bankruptcies"
- "company bankruptcies"
- "bankruptcy options for small business"
- "how to bankrupt your business"
- "business bankruptcies 2026"

## Design Direction

- **Light hero**  - `#F2F4F9` (Cyan Blue) background, black text, white form card with shadow
- **Alternating section backgrounds**  - white / `#F2F4F9` for visual rhythm
- **Blue accent strip** on left edge of page (gradient `#3052FF` → `#7FB2FF`)
- **Brand-aligned**: Aeonik font, `#3052FF` (Future Blue) primary, `#FF9000` (Orange) CTAs, `#7FB2FF` (Light Blue) accents
- **Inspired by Stitch design**: spacious layout, savings calculator, person imagery section, clean cards
- **Dual conversion**: form + phone call CTAs throughout

## Page Sections (Top to Bottom)

### 1. Navigation
- White background, logo left, phone CTA button right (orange)
- Same as other templates  - uses branding settings from DB

### 2. Hero (Above the Fold)
- Light `#F2F4F9` background
- 2-column grid: content left, form right
- **Left column:**
  - Badge (small pill label)
  - H1 headline (2 lines, second line in `#3052FF`)
  - Subheadline paragraph
  - 4 bullet points with chevron `›` icons
  - Trust bar (logo badges: BBB, Trustpilot, Business Insider, BSI)
- **Right column:**
  - White card with shadow
  - Form title + subtitle
  - Form fields (configurable via `form_id`)
  - Orange CTA button
  - Security note

**Content JSON fields:**
```json
{
  "badge": "Business Bankruptcy Alternative 2026",
  "headline": "Facing Business Bankruptcy?",
  "headlineLine2": "Settle Your Debt for 50-80% Less.",
  "subheadline": "With business bankruptcies rising in 2026...",
  "bulletPoints": [
    "Avoid small business bankruptcies  - no court filings or public record",
    "Settle business debt for 50-80% less than you owe",
    "Keep your business open and your assets protected",
    "Credit recovers in months  - not 7-10 years after company bankruptcy"
  ],
  "formTitle": "Find Your Path to Debt-Free Business",
  "formSubtitle": "Takes 60 seconds. No obligation.",
  "formButton": "Get My Free Consultation →",
  "trustLabel": "As Seen In & Trusted By"
}
```

### 3. How It Works (3 Steps)
- White background
- Section title + subtitle
- 3 cards in a row, each with numbered circle, title, description

**Content JSON fields:**
```json
{
  "howItWorksTitle": "The 1-2-3 Path to Freedom",
  "howItWorksSubtitle": "Our proven process has helped over 1,500 businesses avoid company bankruptcies",
  "steps": [
    { "title": "Free Business Debt Analysis", "description": "Tell us about your situation..." },
    { "title": "We Negotiate With Creditors", "description": "Our team contacts your lenders..." },
    { "title": "Debt Settled, Bankruptcy Avoided", "description": "Pay significantly less..." }
  ]
}
```

### 4. Educational Content Section (NEW)
- `#F2F4F9` background
- Section title + subtitle
- 3 stat cards in a row (number + label)
- 2-3 subsections with H3 headings and paragraph content
- Keyword-rich, detailed content for Google Ads quality score

**Content JSON fields:**
```json
{
  "eduTitle": "Understanding Business Bankruptcies in 2026",
  "eduSubtitle": "What every small business owner needs to know before considering bankruptcy options",
  "eduStats": [
    { "number": "44%", "label": "Increase in business bankruptcies since 2023" },
    { "number": "$50K+", "label": "Average cost of filing business bankruptcy" },
    { "number": "7-10yr", "label": "Bankruptcy stays on your record" }
  ],
  "eduSections": [
    {
      "title": "Why Are Business Bankruptcies Rising?",
      "content": "Business bankruptcies in 2026 are at their highest level..."
    },
    {
      "title": "Types of Company Bankruptcies",
      "content": "Chapter 7 (Liquidation): The business ceases operations..."
    },
    {
      "title": "The Alternative: Business Debt Settlement",
      "content": "For business owners wondering how to bankrupt your business..."
    }
  ]
}
```

### 5. Savings Calculator (NEW)
- White background
- Section title + subtitle
- Centered card with:
  - Debt amount display (large number)
  - Slider to adjust amount
  - Two result cards: estimated settlement + estimated savings
  - Orange CTA button
- **Interactive**: JavaScript slider updates values in real-time
- Calculator is lightweight (no external libraries) for page speed

**Content JSON fields:**
```json
{
  "calcTitle": "Realize Your Savings",
  "calcSubtitle": "See how much you could save through debt settlement vs. filing for business bankruptcy",
  "calcMinDebt": 10000,
  "calcMaxDebt": 500000,
  "calcDefaultDebt": 150000,
  "calcSavingsPercent": 70,
  "calcCta": "Get Your Free Analysis →"
}
```

### 6. Comparison Cards (Replaces Table)
- `#F2F4F9` background
- Section title + subtitle
- 2-column grid: Bankruptcy card (white, red X icons) vs Settlement card (dark navy, green check icons, blue border, "Recommended" tag)
- Mobile: stacks vertically

**Content JSON fields:**
```json
{
  "comparisonTitle": "Bankruptcy vs. Debt Settlement",
  "comparisonSubtitle": "See why thousands chose settlement over small business bankruptcies",
  "comparisonBad": {
    "title": "Filing Business Bankruptcy",
    "badge": "Not Recommended",
    "items": [
      "Public record  - searchable forever",
      "Credit damaged for 7-10 years",
      "Often forces business closure",
      "Court may seize business assets",
      "6-18 months in court",
      "Attorney fees $10K-$50K+",
      "Nearly impossible to get future loans"
    ]
  },
  "comparisonGood": {
    "title": "Business Debt Settlement",
    "badge": "Better Option",
    "items": [
      "Private negotiation  - no public record",
      "Credit recovers in 12-24 months",
      "Keep your business open and operating",
      "Your assets stay protected",
      "Settled in 3-6 months",
      "No upfront fees  - save 50-80%",
      "Access to financing within months"
    ]
  }
}
```

### 7. Case Studies
- White background
- Section title + subtitle
- 2x2 grid of case cards
- Each card: industry badge, story paragraph, original amount (strikethrough), settled amount, savings percentage

**Content JSON fields:**
```json
{
  "caseStudiesTitle": "Real Businesses That Avoided Bankruptcy",
  "caseStudiesSubtitle": "Actual settlements for business owners who explored bankruptcy options for small business",
  "caseStudies": [
    {
      "industry": "Home Interiors",
      "story": "Facing a $107K judgment from Mulligan Funding...",
      "originalAmount": "$107,684",
      "settledAmount": "$55,000",
      "savingsPercent": "49%",
      "proofLink": "https://..."
    }
  ]
}
```

### 8. Person CTA Section (NEW)
- Dark navy background
- 2-column: empathetic copy left, business owner photo right
- Orange CTA button + phone number link
- Photo configured via content JSON (URL to uploaded image)

**Content JSON fields:**
```json
{
  "personCtaTitle": "Your Financial Future Starts Today",
  "personCtaTitleHighlight": "Financial Future",
  "personCtaText": "When creditors are calling every day...",
  "personCtaButton": "Get Your Free Consultation →",
  "personCtaImage": "/uploads/business-owner.jpg"
}
```

### 9. Testimonials
- White background
- Section title + subtitle
- 3-column grid of testimonial cards
- Each: stars, quote, avatar initials, name, role

**Content JSON fields:**
```json
{
  "testimonialsTitle": "Business Owners Who Chose Settlement Over Bankruptcy",
  "testimonialsSubtitle": "Real stories from business owners who avoided company bankruptcies",
  "testimonials": [
    {
      "quote": "They were helpful, clear communication...",
      "name": "KMJ Trucking, LLC",
      "role": "Trucking Company",
      "initials": "KT"
    }
  ]
}
```

### 10. FAQ (with Schema Markup)
- `#F2F4F9` background
- Section title + subtitle
- Accordion-style Q&A items
- **Auto-generates FAQPage schema markup** from the FAQ content for Google

**Content JSON fields:**
```json
{
  "faqTitle": "Business Bankruptcy Questions? We Have Answers.",
  "faqSubtitle": "Everything you need to know about avoiding small business bankruptcies",
  "faqItems": [
    {
      "question": "What are the best alternatives to business bankruptcy?",
      "answer": "The most effective alternative to business bankruptcy is debt settlement..."
    }
  ]
}
```

### 11. Bottom CTA + Form
- Dark navy background
- Section title + subtitle
- Form (same fields as hero form, styled for dark bg)
- Phone number link below

**Content JSON fields:**
```json
{
  "ctaTitle": "Don't Let Bankruptcy Be Your Only Option",
  "ctaSubtitle": "Free consultation. See how much you could save without filing for bankruptcy.",
  "phone": "(888) 730-2056"
}
```

### 12. Comprehensive Industry Guide (NEW  - Post-Form Deep Content)
- White background with `#F2F4F9` alternating subsection backgrounds
- Section title: "The Complete Guide to Business Bankruptcies in 2026"
- Long-form, keyword-rich authoritative content
- Structured with H2 title → multiple H3 subsections, each with detailed paragraphs
- This is the SEO power section  - Google sees deep original content that matches search intent

**Subsections (each is an H3 with 2-4 paragraphs):**

1. **"Chapter 7 vs Chapter 11 vs Chapter 13: Which Business Bankruptcy Type Applies to You?"**
   - Detailed explanation of each chapter
   - Who qualifies for each
   - Pros/cons of each type
   - Which business structures (LLC, sole prop, corp) can file which

2. **"The True Cost of Filing for Business Bankruptcy"**
   - Attorney fees breakdown ($10K-$50K+ for Chapter 11)
   - Court filing fees
   - Administrative costs
   - Hidden costs (lost business, vendor relationships, employee turnover)
   - Total cost comparison table: Ch. 7 vs Ch. 11 vs Ch. 13 vs debt settlement

3. **"How Business Bankruptcy Affects Your Personal Credit"**
   - Personal guarantee implications
   - Credit score impact timeline
   - How long bankruptcy stays on personal vs business credit reports
   - Impact on personal assets (home, car, savings)

4. **"Business Bankruptcy Timeline: What to Expect"**
   - Step-by-step timeline for each chapter type
   - Key milestones (filing, 341 meeting, discharge)
   - How long each phase takes
   - Comparison to debt settlement timeline

5. **"Industries Most Affected by Business Bankruptcies in 2026"**
   - Statistics by industry (restaurants, retail, construction, trucking, healthcare)
   - Why certain industries are more vulnerable
   - MCA debt as a contributing factor

6. **"What Happens to Your Employees When You File Business Bankruptcy"**
   - Chapter 7: layoff requirements and WARN Act
   - Chapter 11: employee retention during reorganization
   - Impact on employee benefits, wages owed
   - Settlement alternative: keep employees, keep operating

7. **"Alternatives to Business Bankruptcy Beyond Debt Settlement"**
   - Debt consolidation
   - Business restructuring
   - SBA disaster loans and relief programs
   - Negotiating directly with creditors
   - Asset-based lending
   - Why settlement is often the strongest option

8. **"Glossary of Business Bankruptcy Terms"**
   - Key terms: automatic stay, discharge, liquidation, reorganization, creditor committee, means test, preference payment, etc.
   - Written in plain language for business owners, not lawyers

**Content JSON fields:**
```json
{
  "guideTitle": "The Complete Guide to Business Bankruptcies in 2026",
  "guideSubtitle": "Everything small business owners need to know about business bankruptcy  - and how to avoid it",
  "guideSections": [
    {
      "title": "Chapter 7 vs Chapter 11 vs Chapter 13: Which Business Bankruptcy Type Applies to You?",
      "content": "When considering business bankruptcy, understanding the three main types...",
      "background": "white"
    },
    {
      "title": "The True Cost of Filing for Business Bankruptcy",
      "content": "Many business owners underestimate the total cost of filing...",
      "background": "light"
    },
    {
      "title": "How Business Bankruptcy Affects Your Personal Credit",
      "content": "One of the most common questions from business owners...",
      "background": "white"
    },
    {
      "title": "Business Bankruptcy Timeline: What to Expect",
      "content": "The timeline for business bankruptcies varies significantly...",
      "background": "light"
    },
    {
      "title": "Industries Most Affected by Business Bankruptcies in 2026",
      "content": "Business bankruptcies in 2026 are not hitting all industries equally...",
      "background": "white"
    },
    {
      "title": "What Happens to Your Employees When You File Business Bankruptcy",
      "content": "For many business owners, the impact on employees...",
      "background": "light"
    },
    {
      "title": "Alternatives to Business Bankruptcy Beyond Debt Settlement",
      "content": "While debt settlement is the strongest option for most...",
      "background": "white"
    },
    {
      "title": "Glossary of Business Bankruptcy Terms",
      "content": "Automatic Stay: A court order that immediately stops...",
      "background": "light"
    }
  ],
  "guideCta": "Talk to a Debt Specialist  - Free Consultation",
  "guideCtaSubtext": "Still have questions? Our team can walk you through your specific situation."
}
```

**Design notes:**
- Each subsection alternates white / `#F2F4F9` background
- A small inline CTA appears every 2-3 subsections (anchor link to form) to catch readers ready to convert
- The glossary section uses a 2-column grid of term/definition pairs
- Content is rendered from the `guideSections` array  - admin can add, remove, or reorder sections
- Each section's `background` field controls white vs light styling

### 13. Footer
- Dark background, copyright, privacy/terms links (same as other templates)

## Sections Visibility

All sections toggleable via `sections_visible` JSON, same pattern as existing templates:

```json
{
  "howItWorks": true,
  "educational": true,
  "calculator": true,
  "comparison": true,
  "caseStudies": true,
  "personCta": true,
  "testimonials": true,
  "faq": true,
  "cta": true,
  "guide": true
}
```

## Colors Configuration

Customizable via `colors` object in content JSON:

```json
{
  "colors": {
    "primary": "#3052FF",
    "primaryLight": "#7FB2FF",
    "heroBg": "#F2F4F9",
    "ctaButton": "#FF9000",
    "ctaButtonHover": "#e68200",
    "headlineHighlight": "#3052FF",
    "navy": "#0f1c2e",
    "navyDark": "#0a0f18"
  }
}
```

## Technical Requirements

### SEO / Google Ads Optimization
- **Semantic HTML5**: `<header>`, `<main>`, `<section>`, `<article>`, `<footer>`
- **Heading hierarchy**: Single H1 → H2 per section → H3 for subsections
- **FAQPage schema markup**: Auto-generated JSON-LD from `faqItems` array
- **Organization schema**: Company info in JSON-LD
- **Review schema**: Aggregate rating from testimonials
- **Meta tags**: `pageTitle`, `metaDescription` from content JSON
- **robots.txt**: Add to CMS  - allow AdsBot-Google explicitly

### Performance
- **Inline CSS** (same as other templates  - no external stylesheets)
- **Minimal JS**: Only calculator slider + FAQ accordion + form validation + tracking
- **No heavy libraries**: Vanilla JS only
- **Lazy load**: Person CTA image loads lazily
- **Optimized images**: Trust logos served from /assets/ (already cached)

### Mobile
- All grids collapse to single column at 768px
- Comparison cards stack vertically
- Calculator fully responsive
- Sticky mobile CTA bar (same as other templates)
- Touch-friendly button sizes (min 44px tap target)

### Template File
- New file: `/templates/landing-page-authority.html`
- Template type value: `authority`

### Code Changes in `pages.js` (3 Locations)

1. **POST route `validTypes` array** (~line 161): Add `'authority'` to the array
2. **PUT route `validTypes` array** (~line 203): Add `'authority'` to the array
3. **`templateFiles` mapping** (~line 353): Add `authority: 'landing-page-authority.html'`

### Default Content Strategy

Create a separate `defaultContentAuthority` object (not merged into the shared `defaultContent`). Select the correct defaults based on `template_type` during page creation:
- When `template_type === 'authority'`, use `defaultContentAuthority`
- Otherwise, use existing `defaultContent`
- The merge in `generateLandingPage` uses the same logic  - pick defaults by template type before merging with page-specific content

This keeps the existing templates unaffected and ensures all authority-specific fields (`eduTitle`, `eduStats`, `eduSections`, `calcTitle`, `comparisonBad`, `comparisonGood`, `personCtaTitle`, etc.) have sensible defaults.

### JSON Serialization in `generateLandingPage`

The following new array/object fields need `html.replace` calls (same pattern as existing `bulletPointsJson`, `stepsJson`, etc.):
- `{{eduStatsJson}}`  - from `eduStats` array
- `{{eduSectionsJson}}`  - from `eduSections` array
- `{{caseStudiesJson}}`  - from `caseStudies` array
- `{{testimonialsJson}}`  - from `testimonials` array
- `{{comparisonBadJson}}`  - from `comparisonBad` object
- `{{comparisonGoodJson}}`  - from `comparisonGood` object
- `{{guideSectionsJson}}`  - from `guideSections` array

### Admin Integration

Template type `authority` selectable in page editor dropdown. Requires updating **two** `<select>` elements in `/admin/pages.html`:
- Create page dropdown (~line 260)
- Edit page dropdown (~line 339)

All content fields editable through existing JSON editor in admin. Sections visibility toggles and preview/regenerate work same as other templates.

### Sections Visibility Implementation

Note: The existing `sectionsVisible` parsing in `pages.js` (~line 316) reads the value but does not apply it during template generation. For the authority template, implement section visibility by wrapping each section in a conditional comment marker (e.g. `<!-- SECTION:educational -->...<!-- /SECTION:educational -->`) and stripping sections where `sectionsVisible[key] === false` during generation. This should be implemented for the authority template first and can later be backported to other templates.

### A/B Testing

A/B testing for authority-specific elements (calculator, educational section, comparison cards) is **deferred to a later phase**. The existing A/B testing script handles hero-level elements (headline, badge, subheadline, form, CTA button, colors) which apply to the authority template's hero section without changes.

### Calculator Logic

**Formula:**
- Settlement amount = `debt * (1 - calcSavingsPercent / 100)`
- Savings amount = `debt * calcSavingsPercent / 100`

Example: $150,000 debt at 70% savings → settlement = $45,000, savings = $105,000

**Slider:**
- Range: `calcMinDebt` to `calcMaxDebt`
- Step size: `$5,000`
- Default: `calcDefaultDebt`

### Font Strategy

Aeonik is a commercial font not on Google Fonts. Strategy:
- Self-host Aeonik WOFF2 files in `/public/assets/fonts/` (Regular + Medium weights)
- Load via `@font-face` in the template's inline CSS
- Fallback stack: `'Aeonik', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- If Aeonik font files are not available at build time, fall back to Inter from Google Fonts

### Tracking
- Same tracking integration as other templates (Facebook Pixel, UTM params, click IDs, visitor tracking)
- Calculator interaction events tracked (slider used, CTA clicked)

## Additional Details

### Case Study `proofLink`
- Renders as a "View Settlement" link below the savings badge (same as current template)
- Optional  - if empty/null, the link is not rendered

### Testimonial Stars
- All testimonials render 5 stars by default
- No `stars` field needed in the JSON  - hardcoded to 5 (matching current template behavior)

### Person CTA Image Fallback
- If `personCtaImage` is empty or the image fails to load, the right column shows a solid gradient background (`#1a3050` → `#0f1c2e`) with no image  - the section still works as a full-width CTA with the text content
- The template uses `loading="lazy"` and `onerror` handler to hide the broken image

### Phone Number
- Uses the same `phone` field from content JSON as existing templates
- Same phone-removal logic applies: if `phone` is empty, phone elements are stripped from the generated HTML

### robots.txt
- Add `/public/robots.txt` to the CMS with:
  ```
  User-agent: *
  Allow: /lp/
  Allow: /a/

  User-agent: AdsBot-Google
  Allow: /

  User-agent: AdsBot-Google-Mobile
  Allow: /
  ```
- Serve it from the Express static middleware

## Default Content

Create `defaultContentAuthority` with the full "business bankruptcy" keyword set content shown in the mockup. This includes all section titles, subtitles, educational content, FAQ items, case studies, testimonials, calculator defaults, and comparison items. When creating a new authority page, these defaults are used so the admin has a working starting point to customize.

## Mockup Reference

Visual mockup: `.superpowers/brainstorm/75072-1774272070/full-page-design.html`
