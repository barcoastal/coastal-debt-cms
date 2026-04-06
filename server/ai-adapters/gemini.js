// Google Gemini image generation adapter (paid tier)
// Docs: https://ai.google.dev/gemini-api/docs/image-generation

const fs = require('fs');
const path = require('path');

// Try models in order — newest and fastest first
const MODELS = [
  'gemini-2.0-flash-exp-image-generation',
  'gemini-2.0-flash',
  'imagen-4.0-generate-001'
];

async function generate(apiKey, prompt, referenceImageUrls, size) {
  // Try Gemini multimodal models first (support reference images)
  for (const model of MODELS) {
    try {
      console.log(`[Gemini] Trying model: ${model}`);
      const result = await tryGenerate(apiKey, model, prompt, referenceImageUrls, size);
      if (result) return result;
    } catch (e) {
      console.warn(`[Gemini] Model ${model} failed: ${e.message}`);
      // If rate limited, don't try more models on same key
      if (e.message.includes('429') || e.message.includes('quota')) throw e;
      continue;
    }
  }
  throw new Error('All Gemini models failed to generate an image');
}

async function tryGenerate(apiKey, model, prompt, referenceImageUrls, size) {
  // Imagen 3 uses a different API format
  if (model.startsWith('imagen')) {
    return tryImagen(apiKey, model, prompt, size);
  }

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

  console.log(`[Gemini] Generating with model ${model}, ${parts.length} parts, size ${size.width}x${size.height}`);

  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT']
    }
  };

  // 60-second timeout to prevent hanging
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    }
  );
  clearTimeout(timeout);

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[Gemini] API error (${res.status}) on ${model}:`, errText.substring(0, 300));
    throw new Error(`Gemini API error (${res.status}): ${errText.substring(0, 200)}`);
  }

  const data = await res.json();

  // Check for blocked content
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error(`Gemini blocked prompt: ${data.promptFeedback.blockReason}`);
  }

  // Extract image from response parts (API may return camelCase or snake_case)
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    const responseParts = data.candidates[0].content.parts || [];
    for (const part of responseParts) {
      const imgData = part.inline_data || part.inlineData;
      if (imgData && imgData.data) {
        const mime = imgData.mime_type || imgData.mimeType || 'image/png';
        console.log(`[Gemini] Got image from ${model}, mime: ${mime}, size: ${imgData.data.length} chars`);
        return {
          jobId: null,
          status: 'completed',
          imageBase64: imgData.data
        };
      }
    }
    console.warn(`[Gemini] ${model} returned text only:`, JSON.stringify(responseParts.map(p => Object.keys(p))));
  }

  // Check finish reason
  if (data.candidates && data.candidates[0]) {
    const finishReason = data.candidates[0].finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini generation stopped: ${finishReason}`);
    }
  }

  console.warn(`[Gemini] ${model} returned no image, trying next model...`);
  return null;
}

async function tryImagen(apiKey, model, prompt, size) {
  const aspectMap = { '16:9': '16:9', '1:1': '1:1', '9:16': '9:16', '4:3': '4:3', '3:4': '3:4' };
  const aspect = aspectMap[size.geminiAspect] || '16:9';

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: aspect }
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Imagen API error (${res.status}): ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  if (data.predictions && data.predictions[0] && data.predictions[0].bytesBase64Encoded) {
    console.log(`[Gemini] Got image from Imagen 3`);
    return {
      jobId: null,
      status: 'completed',
      imageBase64: data.predictions[0].bytesBase64Encoded
    };
  }

  return null;
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
    console.warn(`[Gemini] Local file not found: ${filePath}`);
  }

  // Fetch remote URL
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[Gemini] Failed to fetch reference image ${url}: ${res.status}`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  return {
    base64: buffer.toString('base64'),
    mimeType: contentType
  };
}

module.exports = { generate, checkStatus };
