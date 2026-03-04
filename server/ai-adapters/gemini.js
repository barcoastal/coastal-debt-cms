// Google Gemini Imagen 3 adapter
// Docs: https://ai.google.dev/gemini-api/docs/image-generation

const fs = require('fs');
const path = require('path');

async function generate(apiKey, prompt, referenceImageUrls, size) {
  const contents = [];

  // Add reference images as inline base64 parts
  if (referenceImageUrls && referenceImageUrls.length > 0) {
    for (const url of referenceImageUrls) {
      try {
        const imageData = await fetchImageAsBase64(url);
        if (imageData) {
          contents.push({
            inlineData: {
              mimeType: imageData.mimeType,
              data: imageData.base64
            }
          });
        }
      } catch (e) {
        console.error('Failed to fetch reference image for Gemini:', e.message);
      }
    }
  }

  // Add text prompt
  contents.push({ text: prompt });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: size.geminiAspect,
          outputOptions: { mimeType: 'image/png' }
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
