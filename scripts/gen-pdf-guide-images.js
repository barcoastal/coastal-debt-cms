#!/usr/bin/env node
// One-shot: generate 3 real-style photos for the PDF guide template via Gemini Imagen,
// save to public/uploads/. Runs locally; commits the resulting PNGs.
//
//   GEMINI_API_KEY=... node scripts/gen-pdf-guide-images.js

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('GEMINI_API_KEY env var required');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const IMAGES = [
  {
    file: 'pdf-guide-img-1.png',
    prompt:
      'Photorealistic editorial photograph of a small business owner sitting at a desk reviewing financial documents and a laptop, looking thoughtful and concerned. Warm office lighting. Mid-30s to 50s, mixed ethnicity. Modern small business setting. Shallow depth of field. No text, no logos, no watermarks. 16:9.'
  },
  {
    file: 'pdf-guide-img-2.png',
    prompt:
      'Photorealistic editorial photograph of two small business owners at a table with a printed plan in front of them, pointing at a chart, looking focused and collaborative. Natural daylight, modern office. Mid-30s to 50s, diverse. Optimistic mood. Shallow depth of field. No text, no logos, no watermarks. 16:9.'
  },
  {
    file: 'pdf-guide-img-3.png',
    prompt:
      'Photorealistic editorial photograph of a small business owner standing in their workplace, smiling confidently, sleeves rolled up, looking forward to the future. Bright natural light, modern interior. Mid-30s to 50s, mixed ethnicity. Hopeful, calm mood. Shallow depth of field. No text, no logos, no watermarks. 16:9.'
  }
];

async function generate(prompt, outFile) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio: '16:9', safetyFilterLevel: 'block_only_high', personGeneration: 'allow_adult' }
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
  const b64 = d.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('No image bytes in response: ' + JSON.stringify(d).slice(0, 400));
  const out = path.join(OUT_DIR, outFile);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  const sizeKb = Math.round(fs.statSync(out).size / 1024);
  console.log(`✓ ${outFile}  (${sizeKb} KB)`);
}

(async () => {
  for (const img of IMAGES) {
    process.stdout.write(`Generating ${img.file}…  `);
    try { await generate(img.prompt, img.file); }
    catch (e) { console.error('FAILED:', e.message); }
  }
  console.log('Done. Public URLs:');
  for (const img of IMAGES) console.log('  /lp/uploads/' + img.file);
})();
