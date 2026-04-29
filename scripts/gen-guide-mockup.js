#!/usr/bin/env node
// Generates a clean PNG mockup of the guide cover for the LP hero.
// Renders the cover-only template in puppeteer at A4 aspect, exports a transparent PNG with shadow.
//
//   node scripts/gen-guide-mockup.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets', 'pdf-guide');
const LOGOS = path.join(ROOT, 'public', 'assets', 'logos');
const TPL = path.join(__dirname, 'mca-guide-template.html');
const OUT = path.join(ASSETS, 'guide-mockup.png');

function inlineSvg(absPath, transform) {
  let svg = fs.readFileSync(absPath, 'utf8');
  if (typeof transform === 'function') svg = transform(svg);
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
function whiteLockup(svg) {
  return svg.replace(/fill="#3052FF"/gi, 'fill="#FFFFFF"').replace(/fill="#7FB2FF"/gi, 'fill="rgba(255,255,255,0.55)"');
}
function inlineImage(name) {
  return 'data:image/png;base64,' + fs.readFileSync(path.join(ASSETS, name)).toString('base64');
}

(async () => {
  let html = fs.readFileSync(TPL, 'utf8')
    .replace(/\{\{IMG1\}\}/g, inlineImage('pdf-guide-img-1.png'))
    .replace(/\{\{IMG2\}\}/g, inlineImage('pdf-guide-img-2.png'))
    .replace(/\{\{IMG3\}\}/g, inlineImage('pdf-guide-img-3.png'))
    .replace(/\{\{LOGO_DARK\}\}/g, inlineSvg(path.join(LOGOS, 'logo-dark-text.svg')))
    .replace(/\{\{LOGO_WHITE\}\}/g, inlineSvg(path.join(LOGOS, 'logo-white-text.svg'), whiteLockup))
    .replace(/\{\{CHEV_BLUE\}\}/g, inlineSvg(path.join(LOGOS, 'chevron-only.svg')))
    .replace(/\{\{CHEV_WHITE\}\}/g, inlineSvg(path.join(LOGOS, 'chevron-white.svg')));

  const b = await puppeteer.launch({ headless: 'new' });
  const p = await b.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  try { await p.evaluate(() => document.fonts.ready); await new Promise(r => setTimeout(r, 1500)); } catch (_) {}
  await p.setViewport({ width: 794, height: 1123, deviceScaleFactor: 3 }); // A4 @ 3x
  await p.evaluate(() => {
    const pages = document.querySelectorAll('.page');
    pages.forEach((el, i) => el.style.display = i === 0 ? 'block' : 'none');
  });
  await p.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 794, height: 1123 } });
  await b.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`✓ ${OUT}  (${kb} KB)`);
})();
