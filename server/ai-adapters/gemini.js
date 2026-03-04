// Google Gemini Imagen 4 adapter
// Docs: https://ai.google.dev/gemini-api/docs/imagen

const fs = require('fs');
const path = require('path');

async function generate(apiKey, prompt, referenceImageUrls, size) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        instances: [{ prompt: prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: size.geminiAspect,
          personGeneration: 'allow_adult'
        }
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Imagen API error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  if (data.predictions && data.predictions.length > 0 && data.predictions[0].bytesBase64Encoded) {
    return {
      jobId: null,
      status: 'completed',
      imageBase64: data.predictions[0].bytesBase64Encoded
    };
  }

  throw new Error('Gemini returned no image data');
}

async function checkStatus() {
  // Gemini is synchronous, no polling needed
  return { status: 'completed' };
}

async function fetchImageAsBase64(url) {
  // Handle local file URLs
  if (url.startsWith('/lp/uploads/') || url.startsWith('/uploads/')) {
    const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
      : path.join(__dirname, '..', '..', 'public', 'uploads');
    const filename = url.split('/').pop();
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filename).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      return {
        base64: buffer.toString('base64'),
        mimeType: mimeMap[ext] || 'image/png'
      };
    }
  }

  // Fetch remote URL
  const res = await fetch(url);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  return {
    base64: buffer.toString('base64'),
    mimeType: contentType
  };
}

module.exports = { generate, checkStatus };
