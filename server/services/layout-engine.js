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
