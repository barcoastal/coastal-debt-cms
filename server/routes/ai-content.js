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
      model: 'claude-sonnet-4-5-20250929',
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

module.exports = router;
