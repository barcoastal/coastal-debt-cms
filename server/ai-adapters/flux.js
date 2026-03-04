// Flux Pro adapter via Replicate API
// Docs: https://replicate.com/black-forest-labs/flux-1.1-pro

const BASE_URL = 'https://api.replicate.com/v1';

async function generate(apiKey, prompt, referenceImageUrls, size) {
  const input = {
    prompt: prompt,
    width: size.width,
    height: size.height,
    num_outputs: 1,
    output_format: 'png'
  };

  // If reference images provided, use first one as image input for img2img
  if (referenceImageUrls && referenceImageUrls.length > 0) {
    input.image = referenceImageUrls[0];
    input.prompt_strength = 0.75;
  }

  const res = await fetch(`${BASE_URL}/models/black-forest-labs/flux-1.1-pro/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'respond-async'
    },
    body: JSON.stringify({ input })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Flux API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    jobId: data.id,
    status: 'processing'
  };
}

async function checkStatus(apiKey, jobId) {
  const res = await fetch(`${BASE_URL}/predictions/${jobId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Flux status error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  if (data.status === 'succeeded' && data.output) {
    const imageUrl = Array.isArray(data.output) ? data.output[0] : data.output;
    return {
      status: 'completed',
      imageUrl: imageUrl
    };
  }

  if (data.status === 'failed' || data.status === 'canceled') {
    return {
      status: 'failed',
      error: data.error || 'Flux generation failed'
    };
  }

  return { status: 'processing' };
}

module.exports = { generate, checkStatus };
