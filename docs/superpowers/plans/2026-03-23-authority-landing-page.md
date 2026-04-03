# Authority Landing Page Template - Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `authority` template type to the Coastal Debt CMS optimized for Google Ads landing page experience, with keyword-rich educational content, savings calculator, comparison cards, and comprehensive industry guide.

**Architecture:** New HTML template file + server-side registration (validTypes, templateFiles, defaultContent) + admin UI update. Follows the exact same pattern as existing templates (form, call, game, article) - template HTML with `{{placeholder}}` syntax, content stored as JSON in SQLite, static HTML generated on save/startup.

**Tech Stack:** Node.js/Express, SQLite, vanilla HTML/CSS/JS, inline styles, no external dependencies.

**Spec:** `docs/superpowers/specs/2026-03-23-authority-landing-page-template.md`
**Mockup:** `.superpowers/brainstorm/75072-1774272070/full-page-design.html`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `templates/landing-page-authority.html` | The authority template HTML with all sections, inline CSS, calculator JS, FAQ accordion, schema markup |
| Modify | `server/routes/pages.js:161` | Add 'authority' to POST validTypes |
| Modify | `server/routes/pages.js:203` | Add 'authority' to PUT validTypes |
| Modify | `server/routes/pages.js:353` | Add authority to templateFiles mapping |
| Modify | `server/routes/pages.js:26-98` | Add defaultContentAuthority object (after existing defaultContent) |
| Modify | `server/routes/pages.js:405-409` | Add JSON serialization for new authority fields |
| Modify | `server/routes/pages.js:311` | Select correct defaults based on template_type in generateLandingPage |
| Modify | `admin/pages.html:260-265` | Add 'authority' option to create dropdown |
| Modify | `admin/pages.html:339-343` | Add 'authority' option to edit dropdown (also fix missing 'article' option) |
| Create | `public/robots.txt` | robots.txt allowing AdsBot-Google |
| Modify | `server/index.js` | Serve robots.txt from root |

---

## Chunk 1: Server-Side Registration

### Task 1: Add authority to validTypes and templateFiles

**Files:**
- Modify: `server/routes/pages.js:161,203,353`

- [ ] **Step 1: Add 'authority' to POST route validTypes**

In `server/routes/pages.js` at line 161, change:
```javascript
const validTypes = ['call', 'game', 'article'];
```
to:
```javascript
const validTypes = ['call', 'game', 'article', 'authority'];
```

- [ ] **Step 2: Add 'authority' to PUT route validTypes**

In `server/routes/pages.js` at line 203, change:
```javascript
const validTypes = ['call', 'game', 'article', 'form'];
```
to:
```javascript
const validTypes = ['call', 'game', 'article', 'form', 'authority'];
```

- [ ] **Step 3: Add authority to templateFiles mapping**

In `server/routes/pages.js` at line 353, change:
```javascript
const templateFiles = { call: 'landing-page-call.html', game: 'landing-page-game.html', article: 'landing-page-article.html' };
```
to:
```javascript
const templateFiles = { call: 'landing-page-call.html', game: 'landing-page-game.html', article: 'landing-page-article.html', authority: 'landing-page-authority.html' };
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/pages.js
git commit -m "feat: register authority template type in page routes"
```

### Task 2: Add defaultContentAuthority object

**Files:**
- Modify: `server/routes/pages.js` (after line 98, before routes)

- [ ] **Step 1: Add the defaultContentAuthority object**

Insert after the existing `defaultContent` object (after line 98). This contains all the default content for the business bankruptcy keyword set. All text content comes from the approved mockup.

```javascript
const defaultContentAuthority = {
  badge: "Business Bankruptcy Alternative 2026",
  headline: "Facing Business Bankruptcy?",
  headlineLine2: "Settle Your Debt for 50-80% Less.",
  subheadline: "With business bankruptcies rising in 2026, thousands of small business owners are choosing debt settlement instead. No court filings. No public record. Keep your business running.",
  bulletPoints: [
    "Avoid small business bankruptcies - no court filings or public record",
    "Settle business debt for 50-80% less than you owe",
    "Keep your business open and your assets protected",
    "Credit recovers in months - not 7-10 years after company bankruptcy"
  ],
  formTitle: "Find Your Path to Debt-Free Business",
  formSubtitle: "Takes 60 seconds. No obligation.",
  formButton: "Get My Free Consultation",
  trustLabel: "As Seen In & Trusted By",
  howItWorksTitle: "The 1-2-3 Path to Freedom",
  howItWorksSubtitle: "Our proven process has helped over 1,500 businesses avoid company bankruptcies",
  steps: [
    { title: "Free Business Debt Analysis", description: "Tell us about your situation. We'll review your business debt and show you how to avoid bankruptcy while reducing what you owe by 50-80%." },
    { title: "We Negotiate With Creditors", description: "Our team contacts your lenders directly - no bankruptcy attorneys or court filings needed. We negotiate to settle for a fraction of what you owe." },
    { title: "Debt Settled, Bankruptcy Avoided", description: "Pay significantly less than your total debt. No business bankruptcy on your record. Your company keeps operating and growing." }
  ],
  eduTitle: "Understanding Business Bankruptcies in 2026",
  eduSubtitle: "What every small business owner needs to know before considering bankruptcy options",
  eduStats: [
    { number: "44%", label: "Increase in business bankruptcies since 2023" },
    { number: "$50K+", label: "Average cost of filing business bankruptcy" },
    { number: "7-10yr", label: "Bankruptcy stays on your record" }
  ],
  eduSections: [
    {
      title: "Why Are Business Bankruptcies Rising?",
      content: "Business bankruptcies in 2026 are at their highest level in over a decade. High interest rates, tightening credit markets, and lingering effects of pandemic-era debt have pushed thousands of small businesses toward insolvency. Many business owners are searching for bankruptcy options for small business - but filing isn't always the best path forward."
    },
    {
      title: "Types of Company Bankruptcies",
      content: "Chapter 7 (Liquidation): The business ceases operations. Assets are sold to pay creditors. This is the most common form of small business bankruptcies, but it means closing your doors permanently.\n\nChapter 11 (Reorganization): The business continues operating under a court-approved repayment plan. Expensive (legal fees often exceed $50,000) and time-consuming (12-18 months minimum).\n\nChapter 13 (Individual): Available only to sole proprietors. Creates a 3-5 year repayment plan. Not available for LLCs or corporations."
    },
    {
      title: "The Alternative: Business Debt Settlement",
      content: "For business owners wondering how to resolve business debt without destroying their future, debt settlement offers a private, faster, and less damaging alternative. Instead of court filings and public records, we negotiate directly with your creditors to reduce what you owe - typically by 50-80%."
    }
  ],
  calcTitle: "Realize Your Savings",
  calcSubtitle: "See how much you could save through debt settlement vs. filing for business bankruptcy",
  calcMinDebt: 10000,
  calcMaxDebt: 500000,
  calcDefaultDebt: 150000,
  calcSavingsPercent: 70,
  calcCta: "Get Your Free Analysis",
  comparisonTitle: "Bankruptcy vs. Debt Settlement",
  comparisonSubtitle: "See why thousands chose settlement over small business bankruptcies",
  comparisonBad: {
    title: "Filing Business Bankruptcy",
    badge: "Not Recommended",
    items: [
      "Public record - searchable forever",
      "Credit damaged for 7-10 years",
      "Often forces business closure",
      "Court may seize business assets",
      "6-18 months in court",
      "Attorney fees $10K-$50K+",
      "Nearly impossible to get future loans"
    ]
  },
  comparisonGood: {
    title: "Business Debt Settlement",
    badge: "Better Option",
    items: [
      "Private negotiation - no public record",
      "Credit recovers in 12-24 months",
      "Keep your business open and operating",
      "Your assets stay protected",
      "Settled in 3-6 months",
      "No upfront fees - save 50-80%",
      "Access to financing within months"
    ]
  },
  caseStudiesTitle: "Real Businesses That Avoided Bankruptcy",
  caseStudiesSubtitle: "Actual settlements for business owners who explored bankruptcy options for small business",
  caseStudies: [
    {
      industry: "Home Interiors",
      story: "Facing a $107K judgment from Mulligan Funding, this interior design business was days away from filing. We negotiated a settlement that saved their company.",
      originalAmount: "$107,684",
      settledAmount: "$55,000",
      savingsPercent: "49%",
      savingsNote: "$52,684 saved",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/Mulligan.pdf"
    },
    {
      industry: "Pumping Services",
      story: "Sued by DLP Funding over an MCA default. We stepped in and settled the lawsuit for a fraction of what was owed.",
      originalAmount: "$12,792",
      settledAmount: "$5,000",
      savingsPercent: "61%",
      savingsNote: "Lawsuit dismissed",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/DLP.pdf"
    },
    {
      industry: "Education",
      story: "RTQ Academy was drowning in MCA debt from Byzfunder. We negotiated a settlement that let them keep serving their community.",
      originalAmount: "$40,570",
      settledAmount: "$18,000",
      savingsPercent: "56%",
      savingsNote: "$22,570 saved",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/Bzfunder.pdf"
    },
    {
      industry: "Construction",
      story: "B Squared Carpentry faced $169K in MCA debt. Our team negotiated aggressively and kept them in business.",
      originalAmount: "$169,006",
      settledAmount: "$117,955",
      savingsPercent: "30%",
      savingsNote: "$51,051 saved",
      proofLink: "https://join.coastaldebt.com/wp-content/uploads/2026/02/AMA-B-Squared-Carpentry-LLC-dba-B-Squared-Carpentry.pdf"
    }
  ],
  personCtaTitle: "Your Financial Future Starts Today",
  personCtaTitleHighlight: "Financial Future",
  personCtaText: "When creditors are calling every day and you're searching for bankruptcy options, it feels like there's no way out. But even with business bankruptcies rising, filing is not your only option. Let us fight for you.",
  personCtaButton: "Get Your Free Consultation",
  personCtaImage: "",
  testimonialsTitle: "Business Owners Who Chose Settlement Over Bankruptcy",
  testimonialsSubtitle: "Real stories from business owners who avoided company bankruptcies",
  testimonials: [
    {
      quote: "They were helpful, clear communication, effective results. I couldn't have asked for a better team to help my trucking company through this difficult time.",
      name: "KMJ Trucking, LLC",
      role: "Trucking Company",
      initials: "KT"
    },
    {
      quote: "Their team was very responsive. As an auto repair shop owner, I was overwhelmed with MCA debt. Coastal Debt gave me my life back.",
      name: "AAMCO Auburn",
      role: "Auto Repair Shop",
      initials: "AA"
    },
    {
      quote: "When I thought bankruptcy was my only option, Coastal Debt showed me there was another way. I cannot thank Carlos enough.",
      name: "Edward Sweeney",
      role: "Business Owner",
      initials: "ES"
    }
  ],
  faqTitle: "Business Bankruptcy Questions? We Have Answers.",
  faqSubtitle: "Everything you need to know about avoiding small business bankruptcies",
  faqItems: [
    { question: "What are the best alternatives to business bankruptcy?", answer: "The most effective alternative to business bankruptcy is debt settlement. Instead of filing for company bankruptcy and going through the courts, a debt settlement firm negotiates directly with your creditors to reduce what you owe by 50-80%. You avoid the public record, keep your business running, and resolve your debt faster than filing for small business bankruptcies." },
    { question: "How do small business bankruptcies affect my credit?", answer: "Small business bankruptcies severely damage your personal credit for 7-10 years, especially if you personally guaranteed business loans. They also create a permanent public record and make future financing extremely difficult. Debt settlement avoids all of this - your credit can recover in 12-24 months and there's no public filing." },
    { question: "What are the bankruptcy options for small business owners in 2026?", answer: "Small business owners typically face Chapter 7 (liquidation) or Chapter 11 (reorganization). Both are expensive, time-consuming, and damaging. With business bankruptcies in 2026 rising, more owners are choosing debt settlement as a faster, more private alternative." },
    { question: "Is debt settlement really better than filing for business bankruptcy?", answer: "For most business owners, yes. Business bankruptcy stays on your record for 7-10 years, can force closure, and makes future financing nearly impossible. Debt settlement is private, faster (3-6 months vs. 6-18 months), and lets you keep operating." },
    { question: "How to handle business debt without bankruptcy?", answer: "If you're looking into how to resolve business debt, consider all options first. Chapter 7 liquidates and closes your business. Chapter 11 reorganizes debt but costs $50K+. Debt settlement is often the smarter path - resolve your debt for 50-80% less, keep your doors open, and protect your personal credit." },
    { question: "Can debt consolidation help me avoid business bankruptcy?", answer: "Consolidation combines debts into one payment but doesn't reduce what you owe. If your business debt is too high to manage even with consolidation, debt settlement is stronger - it actually reduces your total debt by 50-80%, making it the most effective bankruptcy alternative." },
    { question: "What business relief programs are available to avoid bankruptcy?", answer: "Business relief programs include SBA assistance, state-level aid, and private debt settlement programs like ours. Our program helps business owners settle debt for 50-80% less, avoiding company bankruptcies while keeping operations running." },
    { question: "How long does debt settlement take compared to business bankruptcy?", answer: "Most business debt settlements complete in 3-6 months. Small business bankruptcies take 6-18 months or longer due to court proceedings, creditor meetings, and legal filings. Settlement is faster and gets you back on track sooner." }
  ],
  ctaTitle: "Don't Let Bankruptcy Be Your Only Option",
  ctaSubtitle: "Free consultation. See how much you could save without filing for bankruptcy.",
  guideTitle: "The Complete Guide to Business Bankruptcies in 2026",
  guideSubtitle: "Everything small business owners need to know about business bankruptcy - and how to avoid it",
  guideSections: [
    {
      title: "Chapter 7 vs Chapter 11 vs Chapter 13: Which Business Bankruptcy Type Applies to You?",
      content: "When considering business bankruptcy, understanding the three main types is critical. Each chapter serves a different purpose and has different eligibility requirements depending on your business structure.\n\nChapter 7 (Liquidation) is the most common form of small business bankruptcies. The court appoints a trustee who sells your business assets to pay creditors. Once complete, remaining eligible debts are discharged. The catch: your business ceases to exist.\n\nChapter 11 (Reorganization) lets you keep operating while restructuring debt under a court-approved plan. It's the most complex and expensive form of company bankruptcy, typically costing $50,000-$200,000+ in legal fees.\n\nChapter 13 (Individual Reorganization) is only available to sole proprietors (not LLCs or corporations). It creates a 3-5 year repayment plan based on your income.",
      background: "white"
    },
    {
      title: "The True Cost of Filing for Business Bankruptcy",
      content: "Many business owners underestimate the total cost of filing business bankruptcy. Beyond the obvious attorney fees, there are court costs, administrative expenses, and significant hidden costs.\n\nChapter 7 costs: Filing fee ($338) + attorney fees ($1,500-$5,000 for simple cases, $10,000+ for complex). Total: $2,000-$15,000. But the real cost is losing your entire business.\n\nChapter 11 costs: Filing fee ($1,738) + attorney fees ($15,000-$200,000+) + quarterly trustee fees + accountant fees. Total: $50,000-$250,000+.\n\nDebt settlement comparison: No upfront fees. No court costs. No public record. Settle your business debt for 50-80% less than you owe, typically resolved in 3-6 months.",
      background: "light"
    },
    {
      title: "How Business Bankruptcy Affects Your Personal Credit",
      content: "If you signed a personal guarantee on any business loan, line of credit, or MCA advance (which most small business owners have), your personal credit is directly tied to that debt. A business bankruptcy involving personally guaranteed debts will appear on your personal credit report.\n\nBankruptcy typically drops your personal credit score by 150-250 points. Chapter 7 stays on your report for 10 years. Chapter 13 stays for 7 years.\n\nWith debt settlement: Your credit may dip temporarily during negotiations (typically 50-100 points), but begins recovering as soon as debts are settled. Most clients see recovery within 12-24 months.",
      background: "white"
    },
    {
      title: "Business Bankruptcy Timeline: What to Expect",
      content: "Chapter 7 Timeline (3-6 months): Filing, automatic stay, 341 meeting of creditors (30-45 days), trustee liquidates assets (30-90 days), discharge. But your business is gone.\n\nChapter 11 Timeline (12-36 months): Filing, automatic stay, disclosure statement (2-4 months), creditor negotiations (3-6 months), plan confirmation (1-3 months), ongoing execution.\n\nChapter 13 Timeline (3-5 years): Filing, automatic stay, plan proposal, confirmation hearing, 3-5 years of monthly payments.\n\nDebt settlement timeline (3-6 months): Free consultation, debt analysis, creditor negotiations, settlements reached, debts resolved. No court dates, no trustees.",
      background: "light"
    },
    {
      title: "Industries Most Affected by Business Bankruptcies in 2026",
      content: "Business bankruptcies in 2026 are not hitting all industries equally. Restaurants and food service have seen filings increase 38% year-over-year due to elevated lease costs and unsustainable MCA payments.\n\nRetail continues facing pressure from e-commerce. Construction companies that took multiple MCAs to bridge cash flow gaps are among the most common seeking bankruptcy alternatives.\n\nTrucking and transportation have been hit by fuel cost volatility, insurance increases, and freight rate declines. Healthcare practices that expanded during 2020-2022 are carrying debt loads that don't match current revenue.",
      background: "white"
    },
    {
      title: "What Happens to Your Employees When You File Business Bankruptcy",
      content: "Chapter 7 (Liquidation): All employees are terminated. The WARN Act requires 60 days notice for 100+ employees. Unpaid wages become priority claims but employees often wait months for partial payment.\n\nChapter 11 (Reorganization): You can keep employees during reorganization, but uncertainty causes key staff to leave. The court may require workforce reductions.\n\nWith debt settlement: Your business keeps operating normally. Employees keep their jobs, benefits, and stability. Your team never needs to know about the debt negotiation process.",
      background: "light"
    },
    {
      title: "Alternatives to Business Bankruptcy Beyond Debt Settlement",
      content: "Debt consolidation combines multiple debts into one payment but does NOT reduce what you owe. Business restructuring means renegotiating terms directly, but creditors have little incentive to negotiate with individuals.\n\nSBA disaster loans offer low interest rates but have limited availability and strict eligibility. Asset-based lending uses equipment or receivables as collateral but adds more debt.\n\nDebt settlement is the only approach that actually reduces your total debt burden (by 50-80%) without court involvement, public record, or business closure.",
      background: "white"
    },
    {
      title: "Glossary of Business Bankruptcy Terms",
      content: "Automatic Stay: A court order that stops creditors from collecting once bankruptcy is filed.\nDischarge: The court order eliminating your legal obligation to pay certain debts.\nLiquidation: Selling business assets to pay creditors (Chapter 7).\nReorganization: Restructuring debts under court supervision (Chapter 11).\nCreditor Committee: Group of largest unsecured creditors in Chapter 11 cases.\nMeans Test: Calculation for Chapter 7 eligibility based on income.\nPreference Payment: Payments to creditors within 90 days before filing that can be clawed back.\nPersonal Guarantee: Your personal promise to repay business debt, exposing personal assets.\n341 Meeting: Mandatory hearing where trustee and creditors question the debtor under oath.\nDebt Settlement: Private negotiation to accept a reduced payment. No court, no public record.",
      background: "light"
    }
  ],
  guideCta: "Talk to a Debt Specialist - Free Consultation",
  guideCtaSubtext: "Still have questions? Our team can walk you through your specific situation.",
  phone: "(888) 730-2056",
  colors: {
    primary: "#3052FF",
    primaryLight: "#7FB2FF",
    heroBg: "#F2F4F9",
    ctaButton: "#FF9000",
    ctaButtonHover: "#e68200",
    headlineHighlight: "#3052FF",
    navy: "#0f1c2e",
    navyDark: "#0a0f18"
  },
  pageTitle: "Business Bankruptcy Alternative 2026 | Avoid Small Business Bankruptcies",
  metaDescription: "Facing business bankruptcy? Settle your business debt for 50-80% less without filing. No court, no public record. Free consultation. Call (888) 730-2056.",
  mobileCta: "both"
};
```

- [ ] **Step 2: Update POST route to use correct defaults for authority pages**

In `server/routes/pages.js` at line 174, the POST route hardcodes `defaultContent` when creating a page. Change:
```javascript
JSON.stringify(defaultContent),
```
to:
```javascript
JSON.stringify(validTemplateType === 'authority' ? defaultContentAuthority : defaultContent),
```

Also define `defaultSectionsVisibleAuthority` near the `defaultContentAuthority` object:
```javascript
const defaultSectionsVisibleAuthority = {
  howItWorks: true,
  educational: true,
  calculator: true,
  comparison: true,
  caseStudies: true,
  personCta: true,
  testimonials: true,
  faq: true,
  cta: true,
  guide: true
};
```

And update line 175 to use the right sections visible:
```javascript
JSON.stringify(validTemplateType === 'authority' ? defaultSectionsVisibleAuthority : defaultSectionsVisible),
```

- [ ] **Step 3: Update GET single page endpoint to merge with correct defaults**

In `server/routes/pages.js` at line 143, the GET `/:id` route always merges with `defaultContent`. Change the merge to be template-type-aware:

Find (line 143 area):
```javascript
page.content = { ...defaultContent, ...saved, colors: { ...defaultContent.colors, ...(saved.colors || {}) } };
```

Change to:
```javascript
const defaults = (page.template_type === 'authority') ? defaultContentAuthority : defaultContent;
page.content = { ...defaults, ...saved, colors: { ...defaults.colors, ...(saved.colors || {}) } };
```

- [ ] **Step 4: Update generateLandingPage to select correct defaults by template_type**

In `server/routes/pages.js`, in the `generateLandingPage` function, find the content merge block (around lines 380-385). The actual code is a multi-line merge, NOT a simple spread:

```javascript
const mergedContent = { ...defaultContent };
Object.entries(content).forEach(([key, value]) => {
  if (value !== null && value !== undefined) {
    mergedContent[key] = value;
  }
});
```

Change to:
```javascript
const defaults = (page.template_type === 'authority') ? defaultContentAuthority : defaultContent;
const mergedContent = { ...defaults };
Object.entries(content).forEach(([key, value]) => {
  if (value !== null && value !== undefined) {
    mergedContent[key] = value;
  }
});
```

Also fix the colors deep merge (around line 388) from:
```javascript
mergedContent.colors = { ...defaultContent.colors, ...(content.colors || {}) };
```
to:
```javascript
mergedContent.colors = { ...defaults.colors, ...(content.colors || {}) };
```

- [ ] **Step 5: Add JSON serialization for new authority fields**

After the existing JSON serialization block (after line 409), add:

```javascript
    // Authority template JSON fields
    html = html.replace(/{{eduStatsJson}}/g, JSON.stringify(mergedContent.eduStats || []));
    html = html.replace(/{{eduSectionsJson}}/g, JSON.stringify(mergedContent.eduSections || []));
    html = html.replace(/{{caseStudiesJson}}/g, JSON.stringify(mergedContent.caseStudies || []));
    html = html.replace(/{{testimonialsJson}}/g, JSON.stringify(mergedContent.testimonials || []));
    html = html.replace(/{{comparisonBadJson}}/g, JSON.stringify(mergedContent.comparisonBad || {}));
    html = html.replace(/{{comparisonGoodJson}}/g, JSON.stringify(mergedContent.comparisonGood || {}));
    html = html.replace(/{{guideSectionsJson}}/g, JSON.stringify(mergedContent.guideSections || []));

    // Authority template numeric fields (generic string replacement skips non-string values)
    html = html.replace(/{{calcMinDebt}}/g, String(mergedContent.calcMinDebt || 10000));
    html = html.replace(/{{calcMaxDebt}}/g, String(mergedContent.calcMaxDebt || 500000));
    html = html.replace(/{{calcDefaultDebt}}/g, String(mergedContent.calcDefaultDebt || 150000));
    html = html.replace(/{{calcSavingsPercent}}/g, String(mergedContent.calcSavingsPercent || 70));
```

- [ ] **Step 6: Commit**

```bash
git add server/routes/pages.js
git commit -m "feat: add defaultContentAuthority and JSON serialization for authority template"
```

### Task 3: Update admin dropdowns

**Files:**
- Modify: `admin/pages.html:260-265,339-343`

- [ ] **Step 1: Add authority to create dropdown**

In `admin/pages.html` at lines 260-265, add the authority option after article:

```html
<select id="createTemplateType">
  <option value="form">Form (Lead Capture)</option>
  <option value="call">Call Now (Phone Focused)</option>
  <option value="game">Game (Gamification)</option>
  <option value="article">Article (Editorial + Form)</option>
  <option value="authority">Authority (SEO + Conversion)</option>
</select>
```

- [ ] **Step 2: Add authority to edit dropdown (and fix missing article)**

In `admin/pages.html` at lines 339-343, add both article (missing) and authority:

```html
<select id="editTemplateType">
  <option value="form">Form (Lead Capture)</option>
  <option value="call">Call Now (Phone Focused)</option>
  <option value="game">Game (Gamification)</option>
  <option value="article">Article (Editorial + Form)</option>
  <option value="authority">Authority (SEO + Conversion)</option>
</select>
```

- [ ] **Step 3: Commit**

```bash
git add admin/pages.html
git commit -m "feat: add authority template option to admin dropdowns, fix missing article in edit"
```

### Task 4: Add robots.txt

**Files:**
- Create: `public/robots.txt`
- Modify: `server/index.js`

- [ ] **Step 1: Create robots.txt**

Create `public/robots.txt`:
```
User-agent: *
Allow: /lp/
Allow: /a/

User-agent: AdsBot-Google
Allow: /

User-agent: AdsBot-Google-Mobile
Allow: /
```

- [ ] **Step 2: Serve robots.txt from root**

In `server/index.js`, add before the `/lp` static middleware (before line 84):

```javascript
// Serve robots.txt from root
app.get('/robots.txt', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'robots.txt'));
});
```

- [ ] **Step 3: Commit**

```bash
git add public/robots.txt server/index.js
git commit -m "feat: add robots.txt allowing AdsBot-Google"
```

---

## Chunk 2: Authority Template HTML

### Task 5: Create the authority template HTML file

**Files:**
- Create: `templates/landing-page-authority.html`
- Reference mockup: `.superpowers/brainstorm/75072-1774272070/full-page-design.html`

This is the largest task. The template file should be a single self-contained HTML file with inline CSS and JS (same pattern as other templates). All dynamic content uses `{{placeholder}}` syntax for simple values and `{{fieldJson}}` for arrays/objects that are rendered client-side via JS.

- [ ] **Step 1: Create the template file with full HTML structure**

Create `templates/landing-page-authority.html`. The template must include:

**Head section:**
- Meta tags using `{{pageTitle}}` and `{{metaDescription}}`
- Inline CSS (all styles from mockup, adapted to use CSS variables with `{{colors.*}}` placeholders)
- FAQPage JSON-LD schema markup using `{{faqItemsJson}}`
- Organization JSON-LD schema (Coastal Debt Resolve company info)
- AggregateRating JSON-LD schema (5-star rating from testimonials count)
- Font loading: self-hosted Aeonik with fallback to Inter from Google Fonts

**CSS variables to set from placeholders:**
```css
:root {
  --primary: {{colors.primary}};
  --primary-light: {{colors.primaryLight}};
  --hero-bg: {{colors.heroBg}};
  --cta-btn: {{colors.ctaButton}};
  --cta-btn-hover: {{colors.ctaButtonHover}};
  --headline-hl: {{colors.headlineHighlight}};
  --navy: {{colors.navy}};
  --navy-dark: {{colors.navyDark}};
}
```

**Body sections (all from mockup, in order):**

1. **Nav** - logo + phone CTA with `phone-element` class on phone link
2. **Hero** - light bg (`--hero-bg`), 2-column grid
   - Left: `{{badge}}`, H1 with `{{headline}}` / `{{headlineLine2}}` (highlight color), `{{subheadline}}`, bullet points rendered from `{{bulletPointsJson}}` via JS, trust bar
   - Right: form card with `{{formTitle}}`, `{{formSubtitle}}`, form fields from `{{formFieldsJson}}`, `{{formButton}}` on orange CTA
   - Form includes TCPA checkbox, hidden fields from `{{hiddenFieldsHtml}}`
3. **How It Works** - white bg, `{{howItWorksTitle}}`, steps from `{{stepsJson}}` rendered via JS
4. **Educational** - `#F2F4F9` bg, `{{eduTitle}}`, stats from `{{eduStatsJson}}`, sections from `{{eduSectionsJson}}` rendered via JS
5. **Calculator** - white bg, `{{calcTitle}}`, interactive slider (vanilla JS), uses `{{calcMinDebt}}`, `{{calcMaxDebt}}`, `{{calcDefaultDebt}}`, `{{calcSavingsPercent}}`, `{{calcCta}}`
6. **Comparison** - `#F2F4F9` bg, `{{comparisonTitle}}`, two cards from `{{comparisonBadJson}}` and `{{comparisonGoodJson}}`
7. **Case Studies** - white bg, `{{caseStudiesTitle}}`, cards from `{{caseStudiesJson}}`
8. **Person CTA** - navy bg, 2-column, `{{personCtaTitle}}` with `{{personCtaTitleHighlight}}`, `{{personCtaText}}`, `{{personCtaButton}}`, `{{personCtaImage}}` with fallback
9. **Testimonials** - white bg, `{{testimonialsTitle}}`, cards from `{{testimonialsJson}}` with hardcoded 5 stars
10. **FAQ** - `#F2F4F9` bg, `{{faqTitle}}`, accordion from `{{faqItemsJson}}` with toggle JS
11. **Bottom CTA** - navy bg, `{{ctaTitle}}`, `{{ctaSubtitle}}`, second form (same fields), `{{phone}}` link
12. **Guide** - alternating white/light sections, `{{guideTitle}}`, sections from `{{guideSectionsJson}}`, inline CTAs every 2-3 sections, glossary in 2-column grid
13. **Footer** - `{{siteName}}`, privacy/terms links

**JavaScript (inline, at bottom of body):**
- Render bullet points, steps, edu stats, edu sections, comparison cards, case studies, testimonials, FAQ items, guide sections from their JSON data
- Calculator: slider input handler, formats currency, calculates settlement = debt * (1 - savingsPercent/100) and savings = debt * savingsPercent/100, step size $5000
- FAQ accordion: click handler toggles answer visibility
- Form validation and submission (same as existing templates)
- Tracking: visitor tracking, phone click tracking, calculator interaction events
- Hidden fields injection from `{{hiddenFieldsHtml}}`
- Mobile sticky CTA bar (both form scroll-to and phone call)

**Section visibility:** Each section wrapped in a comment marker:
```html
<!-- SECTION:educational -->
<section class="section section-light">...</section>
<!-- /SECTION:educational -->
```

The `generateLandingPage` function strips sections where `sectionsVisible[key] === false`.

**Key design details from mockup:**
- Blue accent strip on left edge (CSS `::before` on body/wrapper)
- Light hero (`#F2F4F9`) with white form card + shadow
- Orange `#FF9000` CTA buttons throughout
- Blue `#3052FF` chevron `>` as bullet icons
- Alternating white / `#F2F4F9` section backgrounds
- Comparison cards: white card (red X icons) vs dark navy card (green checkmarks, blue border, "Recommended" tag)
- Calculator: large number display, range slider, two result cards
- Person CTA: image on right with gradient fallback, empathetic copy on left
- Glossary: 2-column grid of term/definition cards
- Guide inline CTAs: blue buttons anchoring to `#leadForm`
- Mobile: all grids collapse to 1 column at 768px, sticky bottom CTA bar

- [ ] **Step 2: Add section stripping logic to generateLandingPage**

In `server/routes/pages.js`, after the phone element removal block (after line 432), add:

```javascript
    // Strip hidden sections based on sectionsVisible
    if (page.template_type === 'authority') {
      const sectionKeys = ['howItWorks', 'educational', 'calculator', 'comparison', 'caseStudies', 'personCta', 'testimonials', 'faq', 'cta', 'guide'];
      for (const key of sectionKeys) {
        if (sectionsVisible[key] === false) {
          const regex = new RegExp(`<!-- SECTION:${key} -->[\\s\\S]*?<!-- /SECTION:${key} -->`, 'g');
          html = html.replace(regex, '');
        }
      }
    }
```

- [ ] **Step 3: Test locally**

```bash
cd /Users/baralezrah/coastal-debt-cms
npm start
```

1. Open admin at `http://localhost:PORT/admin/pages.html`
2. Create a new page with template type "Authority (SEO + Conversion)"
3. Set a slug (e.g. `test-bankruptcy`)
4. Save and open `http://localhost:PORT/lp/test-bankruptcy/`
5. Verify:
   - All sections render with default content
   - Calculator slider works and updates numbers
   - FAQ accordion opens/closes
   - Form submits correctly
   - Phone number links work
   - Mobile responsive (resize browser to 375px width)
   - View page source: verify FAQ schema markup in JSON-LD
   - Check no `{{placeholder}}` text visible anywhere

- [ ] **Step 4: Commit**

```bash
git add templates/landing-page-authority.html server/routes/pages.js
git commit -m "feat: add authority landing page template with all sections, calculator, FAQ schema"
```

---

## Chunk 3: Polish and Verification

### Task 6: Final verification and mobile testing

- [ ] **Step 1: Test all sections visibility toggles**

Via admin, edit the page and set various sections to hidden. Regenerate and verify they're stripped from the HTML output.

- [ ] **Step 2: Test content editing**

Edit the page content JSON in admin. Change headlines, add/remove FAQ items, modify case studies. Regenerate and verify changes appear.

- [ ] **Step 3: Test phone removal**

Set phone to empty string in content. Regenerate and verify all phone elements are removed.

- [ ] **Step 4: Google Ads quality check**

Open the generated page and verify:
- H1 contains target keyword
- Meta title and description are set
- FAQ schema markup is valid (use Google Rich Results Test)
- Page loads in under 3 seconds
- Mobile-friendly (Google Mobile-Friendly Test)
- No console errors

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: authority landing page template - complete implementation"
```
