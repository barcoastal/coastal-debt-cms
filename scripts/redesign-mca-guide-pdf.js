#!/usr/bin/env node
// Redesigns MCA-Debt-Relief-Guide.pdf using the Coastal Debt brand book.
// Renders an HTML template with puppeteer's bundled chromium.
//
//   node scripts/redesign-mca-guide-pdf.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets', 'pdf-guide');
const OUT_PDF = path.join(ASSETS, 'mca-debt-relief-guide-redesigned.pdf');
const TPL = path.join(__dirname, 'mca-guide-template.html');

function inlineImage(name) {
  const p = path.join(ASSETS, name);
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}
function inlineSvg(absPath, transform) {
  let svg = fs.readFileSync(absPath, 'utf8');
  if (typeof transform === 'function') svg = transform(svg);
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

// Build a true all-white lockup: chevron front becomes pure white, chevron back becomes 60% white.
// The wordmark is already white in logo-white-text.svg.
function whiteLockup(svg) {
  return svg
    .replace(/fill="#3052FF"/gi, 'fill="#FFFFFF"')
    .replace(/fill="#7FB2FF"/gi, 'fill="rgba(255,255,255,0.55)"');
}

(async () => {
  const LOGOS = path.join(ROOT, 'public', 'assets', 'logos');
  let html = fs.readFileSync(TPL, 'utf8');
  html = html
    .replace(/\{\{IMG1\}\}/g, inlineImage('pdf-guide-img-1.png'))
    .replace(/\{\{IMG2\}\}/g, inlineImage('pdf-guide-img-2.png'))
    .replace(/\{\{IMG3\}\}/g, inlineImage('pdf-guide-img-3.png'))
    .replace(/\{\{LOGO_DARK\}\}/g, inlineSvg(path.join(LOGOS, 'logo-dark-text.svg')))
    .replace(/\{\{LOGO_WHITE\}\}/g, inlineSvg(path.join(LOGOS, 'logo-white-text.svg'), whiteLockup))
    .replace(/\{\{CHEV_BLUE\}\}/g, inlineSvg(path.join(LOGOS, 'chevron-only.svg')))
    .replace(/\{\{CHEV_WHITE\}\}/g, inlineSvg(path.join(LOGOS, 'chevron-white.svg')));

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Give Google Fonts up to 15s; fall back to system stack if blocked
  try {
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 1500));
  } catch (_) {}
  await page.emulateMediaType('print');
  await page.pdf({
    path: OUT_PDF,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  await browser.close();
  const kb = Math.round(fs.statSync(OUT_PDF).size / 1024);
  console.log(`✓ ${OUT_PDF}  (${kb} KB)`);
})();
