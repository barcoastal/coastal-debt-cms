// Google Gemini Flash image generation adapter (free tier)
// Docs: https://ai.google.dev/gemini-api/docs/image-generation

const fs = require('fs');
const path = require('path');

const MODEL = 'gemini-2.0-flash-preview-image-generation';

async function generate(apiKey, prompt, referenceImageUrls, size) {
  const parts = [];

  // Add reference images as inline base64 parts
  if (referenceImageUrls && referenceImageUrls.length > 0) {
    for (const url of referenceImageUrls) {
      try {
        const imageData = await fetchImageAsBase64(url);
        if (imageData) {
          parts.push({
            inline_data: {
              mime_type: imageData.mimeType,
              data: imageData.base64
            }
          });
        }
      } catch (e) {
        console.error('Failed to fetch reference image for Gemini:', e.message);
      }
    }
  }

  // Add text prompt with size guidance
  parts.push({
    text: `${prompt}\n\nGenerate this as a ${size.width}x${size.height} image with ${size.geminiAspect} aspect ratio.`
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE']
        }
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  // Extract image from response parts
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    const responseParts = data.candidates[0].content.parts || [];
    for (const part of responseParts) {
      if (part.inline_data && part.inline_data.data) {
        return {
          jobId: null,
          status: 'completed',
          imageBase64: part.inline_data.data
        };
      }
    }
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
