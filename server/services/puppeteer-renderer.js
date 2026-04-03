// server/services/puppeteer-renderer.js

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', '..', 'public', 'uploads');

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  return browserInstance;
}

async function renderHtmlToPng(htmlString, width, height, outputFilename) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Write HTML to temp file so local file:// URLs for images resolve
    const tempHtmlPath = path.join(uploadsDir, `_temp-render-${Date.now()}.html`);

    // Rewrite /lp/uploads/ paths to absolute file:// paths
    const resolvedHtml = htmlString.replace(
      /src="\/lp\/uploads\//g,
      `src="file://${uploadsDir}/`
    );

    fs.writeFileSync(tempHtmlPath, resolvedHtml);
    await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle0', timeout: 15000 });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    const outputPath = path.join(uploadsDir, outputFilename);
    await page.screenshot({
      path: outputPath,
      type: 'png',
      clip: { x: 0, y: 0, width, height }
    });

    // Clean up temp HTML
    try { fs.unlinkSync(tempHtmlPath); } catch (e) {}

    return {
      file_path: outputPath,
      url: `/lp/uploads/${outputFilename}`
    };
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// Close browser on process exit
process.on('exit', () => { if (browserInstance) browserInstance.close().catch(() => {}); });

module.exports = { renderHtmlToPng, closeBrowser };
