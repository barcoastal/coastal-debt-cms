const express = require('express');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Platform-specific prompt instructions
const platformGuidance = {
  google: `This landing page is for GOOGLE ADS traffic.
- Match the ad headline promise — be direct and specific
- Lead with the solution, not the problem
- Use search-intent language (people are actively looking for help)
- Include specific numbers and percentages
- Keep copy concise — Google users want quick answers`,

  meta: `This landing page is for FACEBOOK/META ADS traffic.
- People weren't searching for this — they were interrupted from scrolling
- Lead with empathy and emotion first, then the solution
- Use storytelling and relatable scenarios
- Longer, more persuasive copy is fine — build trust before asking
- Social proof is critical (testimonials, numbers of people helped)`,

  bing: `This landing page is for BING ADS traffic.
- Similar to Google but audience skews older and more conservative
- Use professional, trustworthy language
- Emphasize established credibility and track record
- Be straightforward — avoid hype or flashy language`,

  tiktok: `This landing page is for TIKTOK ADS traffic.
- Audience is younger and more skeptical of traditional advertising
- Use casual, direct language — no corporate speak
- Lead with a bold claim or surprising statistic
- Keep sections punchy and scannable
- Emphasize speed and simplicity of the process`,

  linkedin: `This landing page is for LINKEDIN ADS traffic.
- Audience is business professionals
- Use professional but not stiff language
- Emphasize business impact, ROI, and professional outcomes
- Reference industry credibility and business expertise`,

  outbrain: `This landing page is for OUTBRAIN/NATIVE ADS traffic.
- User clicked from a content recommendation — they expect informative content
- Start with educational/editorial tone, then transition to offer
- Use "discovery" language — help them learn something new
- Build trust through information before the hard sell`,

  other: `This landing page is for general traffic.
- Use clear, professional language
- Balance emotional appeal with factual information
- Include strong social proof and clear calls to action`
};

// POST /api/ai/generate-content
router.post('/generate-content', authenticateToken, async (req, res) => {
  try {
    const { keywords, platform, currentContent } = req.body;

    if (!keywords || !keywords.length) {
      return res.status(400).json({ error: 'Keywords are required' });
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to your environment variables.' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const platformGuide = platformGuidance[platform] || platformGuidance.other;

    const prompt = `You are a direct-response copywriter for a debt relief company called Coastal Debt.

TARGET KEYWORDS: ${keywords.join(', ')}
PLATFORM: ${platform || 'general'}

${platformGuide}

Generate COMPLETE landing page content optimized for these keywords and platform. The page helps business owners settle their debt without filing bankruptcy. Every field must be fully written, keyword-relevant content — no placeholders.

Return a JSON object with this EXACT structure:
{
  "seo": {
    "pageTitle": "browser tab title with keyword (50-60 chars)",
    "metaDescription": "compelling meta description with keyword (150-160 chars)"
  },
  "hero": {
    "badge": "short badge text above headline (2-3 words)",
    "headline": "powerful first line (max 6 words)",
    "headlineLine2": "second line continuing the thought",
    "headlineHighlight": "highlighted/emphasized phrase (e.g. 'Up to 80% Less.')",
    "subheadline": "1-2 sentences expanding the promise",
    "bulletPoints": ["benefit point 1", "benefit point 2", "benefit point 3", "benefit point 4"],
    "formTitle": "form heading (e.g. 'See If You Qualify')",
    "formSubtitle": "form subtext (e.g. 'Takes 60 seconds. No obligation.')",
    "cta": "button text (3-5 words)"
  },
  "howItWorks": {
    "title": "section heading",
    "subtitle": "section subtitle",
    "steps": [
      { "title": "Step 1 title", "description": "Step 1 description (1-2 sentences)" },
      { "title": "Step 2 title", "description": "Step 2 description (1-2 sentences)" },
      { "title": "Step 3 title", "description": "Step 3 description (1-2 sentences)" }
    ]
  },
  "comparison": {
    "title": "comparison section heading",
    "subtitle": "comparison subtitle",
    "colBad": "bad option header (e.g. 'Filing Bankruptcy')",
    "colGood": "good option header (e.g. 'Debt Settlement')",
    "ctaText": "comparison CTA button text"
  },
  "empathy": {
    "title": "empathetic heading showing understanding",
    "paragraphs": ["paragraph 1 (2-3 sentences)", "paragraph 2 (2-3 sentences)"]
  },
  "testimonials": {
    "title": "testimonials section heading",
    "subtitle": "testimonials subtitle",
    "items": [
      { "name": "First L.", "location": "City, ST", "quote": "realistic testimonial (2-3 sentences)" },
      { "name": "First L.", "location": "City, ST", "quote": "realistic testimonial (2-3 sentences)" },
      { "name": "First L.", "location": "City, ST", "quote": "realistic testimonial (2-3 sentences)" }
    ]
  },
  "faq": {
    "title": "FAQ section heading",
    "subtitle": "FAQ subtitle",
    "items": [
      { "question": "keyword-relevant question", "answer": "clear, helpful answer (2-3 sentences)" },
      { "question": "another relevant question", "answer": "clear answer" },
      { "question": "another relevant question", "answer": "clear answer" },
      { "question": "another relevant question", "answer": "clear answer" }
    ]
  },
  "cta": {
    "title": "final CTA heading",
    "subtitle": "final CTA subtitle",
    "button": "final CTA button text"
  },
  "footer": {
    "disclaimer": "brief legal disclaimer"
  }
}

Return ONLY valid JSON. No markdown fences, no extra text.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const generated = JSON.parse(jsonStr);

    res.json({ success: true, content: generated });
  } catch (error) {
    console.error('AI content generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate content' });
  }
});

// POST /api/ai/generate-authority-content — generate full authority template content from keywords
router.post('/generate-authority-content', authenticateToken, async (req, res) => {
  try {
    const { keywords, platform } = req.body;

    if (!keywords || !keywords.length) {
      return res.status(400).json({ error: 'Keywords are required' });
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to your environment variables.' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const platformGuide = platformGuidance[platform] || platformGuidance.google;

    const prompt = `You are a direct-response copywriter and SEO expert for Coastal Debt, a debt relief company.

TARGET KEYWORDS: ${keywords.join(', ')}
PLATFORM: ${platform || 'google'}

${platformGuide}

GOAL: Generate COMPLETE landing page content for the "Authority" template. This template is designed to maximize Google Ads Landing Page Experience score. The content must:
1. Be deeply relevant to the target keywords - use them naturally throughout ALL sections
2. Provide genuine educational value (Google rewards helpful, expert content)
3. Be comprehensive enough that Google sees this as authoritative on the topic
4. Include specific numbers, statistics, and actionable information
5. Never use em dashes or en dashes - use regular hyphens (-) only
6. Never use placeholder text - every field must have real, complete content

The company helps business owners settle debt (especially MCA/merchant cash advances) for 50-80% less without filing bankruptcy.

Return a JSON object with this EXACT structure (all fields required, no placeholders):
{
  "seo": {
    "pageTitle": "keyword-rich title (50-60 chars)",
    "metaDescription": "compelling description with primary keyword (150-160 chars)"
  },
  "hero": {
    "badge": "short badge text with keyword (3-5 words)",
    "headline": "powerful headline with primary keyword (max 8 words)",
    "headlineLine2": "second line with value proposition",
    "subheadline": "2-3 sentences expanding the promise, using secondary keywords naturally",
    "bulletPoints": ["keyword-relevant benefit 1", "benefit 2", "benefit 3", "benefit 4"],
    "formTitle": "form heading (e.g. 'See If You Qualify')",
    "formSubtitle": "form subtext (e.g. 'Takes 60 seconds. No obligation.')",
    "formButton": "CTA button text (3-5 words)"
  },
  "howItWorks": {
    "title": "section heading with keyword context",
    "subtitle": "subtitle with social proof and keyword",
    "steps": [
      { "title": "Step 1 title", "description": "1-2 sentences with keyword relevance" },
      { "title": "Step 2 title", "description": "1-2 sentences" },
      { "title": "Step 3 title", "description": "1-2 sentences with outcome" }
    ]
  },
  "educational": {
    "title": "educational section heading with primary keyword",
    "subtitle": "subtitle establishing authority",
    "stats": [
      { "number": "stat with number", "label": "stat description" },
      { "number": "stat", "label": "description" },
      { "number": "stat", "label": "description" }
    ],
    "sections": [
      { "title": "educational subtopic 1 with keyword", "content": "2-3 paragraphs separated by double newlines. Deep, expert content using keywords naturally." },
      { "title": "educational subtopic 2", "content": "2-3 paragraphs of expert content" },
      { "title": "educational subtopic 3", "content": "2-3 paragraphs of expert content" }
    ]
  },
  "calculator": {
    "title": "calculator section heading",
    "subtitle": "subtitle with keyword context",
    "cta": "calculator CTA button text",
    "minDebt": 10000,
    "maxDebt": 500000,
    "defaultDebt": 150000,
    "savingsPercent": 70
  },
  "comparison": {
    "title": "comparison heading with keyword",
    "subtitle": "subtitle",
    "bad": {
      "title": "bad option header (e.g. 'Filing Bankruptcy')",
      "badge": "Not Recommended",
      "items": ["negative point 1", "negative point 2", "negative point 3", "negative point 4", "negative point 5", "negative point 6", "negative point 7"]
    },
    "good": {
      "title": "good option header (e.g. 'Debt Settlement')",
      "badge": "Better Option",
      "items": ["positive point 1", "positive point 2", "positive point 3", "positive point 4", "positive point 5", "positive point 6", "positive point 7"]
    }
  },
  "caseStudies": {
    "title": "case studies heading",
    "subtitle": "subtitle with keyword context",
    "items": [
      { "industry": "Industry Name", "story": "2-3 sentence real-sounding case story", "originalAmount": "$XXX,XXX", "settledAmount": "$XX,XXX", "savingsPercent": "XX%", "savingsNote": "$XX,XXX saved" },
      { "industry": "Industry Name", "story": "case story", "originalAmount": "$XXX,XXX", "settledAmount": "$XX,XXX", "savingsPercent": "XX%", "savingsNote": "$XX,XXX saved" },
      { "industry": "Industry Name", "story": "case story", "originalAmount": "$XXX,XXX", "settledAmount": "$XX,XXX", "savingsPercent": "XX%", "savingsNote": "$XX,XXX saved" },
      { "industry": "Industry Name", "story": "case story", "originalAmount": "$XXX,XXX", "settledAmount": "$XX,XXX", "savingsPercent": "XX%", "savingsNote": "$XX,XXX saved" }
    ]
  },
  "personCta": {
    "title": "empathetic heading first part",
    "titleHighlight": "highlighted continuation (2-3 words)",
    "text": "2-3 empathetic sentences connecting with the reader's pain and offering hope",
    "button": "CTA button text"
  },
  "testimonials": {
    "title": "testimonials heading with keyword context",
    "subtitle": "subtitle",
    "items": [
      { "quote": "realistic testimonial 2-3 sentences relating to keyword topic", "name": "Business Name or Person", "role": "Business Type", "initials": "XX" },
      { "quote": "testimonial", "name": "Name", "role": "Role", "initials": "XX" },
      { "quote": "testimonial", "name": "Name", "role": "Role", "initials": "XX" }
    ]
  },
  "faq": {
    "title": "FAQ heading with keyword",
    "subtitle": "subtitle",
    "items": [
      { "question": "keyword-rich question people actually search for", "answer": "thorough, helpful answer (3-4 sentences) using keywords naturally" },
      { "question": "another search-relevant question", "answer": "thorough answer" },
      { "question": "another question", "answer": "thorough answer" },
      { "question": "another question", "answer": "thorough answer" },
      { "question": "another question", "answer": "thorough answer" },
      { "question": "another question", "answer": "thorough answer" },
      { "question": "another question", "answer": "thorough answer" },
      { "question": "another question", "answer": "thorough answer" }
    ]
  },
  "cta": {
    "title": "final CTA heading with keyword",
    "subtitle": "final CTA subtitle"
  },
  "guide": {
    "title": "comprehensive guide heading with primary keyword (e.g. 'The Complete Guide to...')",
    "subtitle": "guide subtitle establishing authority",
    "cta": "guide CTA button text",
    "ctaSubtext": "subtext under CTA",
    "sections": [
      { "title": "guide section 1 with keyword", "content": "3-4 paragraphs of deep expert content, separated by newlines. This must be genuinely helpful.", "background": "white" },
      { "title": "guide section 2", "content": "3-4 paragraphs of expert content", "background": "light" },
      { "title": "guide section 3", "content": "3-4 paragraphs", "background": "white" },
      { "title": "guide section 4", "content": "3-4 paragraphs", "background": "light" },
      { "title": "guide section 5", "content": "3-4 paragraphs", "background": "white" },
      { "title": "guide section 6", "content": "3-4 paragraphs", "background": "light" },
      { "title": "guide section 7", "content": "3-4 paragraphs", "background": "white" },
      { "title": "Glossary of Key Terms", "content": "Term1: definition\\nTerm2: definition\\nTerm3: definition (at least 8-10 terms)", "background": "light" }
    ]
  }
}

CRITICAL: Return ONLY valid JSON. No markdown fences, no comments, no extra text. Every string value must be complete content, not a description of what to write.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const generated = JSON.parse(jsonStr);

    res.json({ success: true, content: generated });
  } catch (error) {
    console.error('AI authority content generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate authority content' });
  }
});

// POST /api/ai/analyze — generic AI analysis endpoint
router.post('/analyze', authenticateToken, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const analysis = message.content[0]?.text || '';
    res.json({ analysis });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({ error: error.message || 'AI analysis failed' });
  }
});

module.exports = router;
