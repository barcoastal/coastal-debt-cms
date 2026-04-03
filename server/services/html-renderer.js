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
