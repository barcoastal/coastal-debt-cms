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

function applyOverrides(layout, overrides) {
  if (!overrides) return layout;
  if (overrides.background_color) layout.background_color = overrides.background_color;
  if (overrides.chevrons) layout.chevrons = { ...layout.chevrons, ...overrides.chevrons };
  if (overrides.text_position && overrides.text_position !== 'auto') {
    layout.headline = { ...layout.headline, area: `top-${overrides.text_position}` };
  }
  return layout;
}

async function composeAd(personImageUrl, copyConfig, selectedAssets, personInfo, layoutOverrides) {
  const results = [];

  for (const size of AD_SIZES) {
    const layout = await generateLayout(
      personInfo || {},
      copyConfig,
      selectedAssets,
      size.label,
      size.width,
      size.height
    );

    applyOverrides(layout, layoutOverrides);

    const html = renderAdHtml(layout, copyConfig, personImageUrl, selectedAssets, size.width, size.height);
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

async function recomposeAd(personImageUrl, copyConfig, selectedAssets, personInfo, sizeLabel, layoutOverrides) {
  const size = AD_SIZES.find(s => s.label === sizeLabel) || AD_SIZES[0];

  const layout = await generateLayout(personInfo || {}, copyConfig, selectedAssets, size.label, size.width, size.height);
  applyOverrides(layout, layoutOverrides);

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
