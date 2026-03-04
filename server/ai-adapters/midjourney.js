// Midjourney adapter via UseAPI.net proxy
// Docs: https://useapi.net/docs

const BASE_URL = 'https://api.useapi.net/v2';

async function generate(apiKey, prompt, referenceImageUrls, size, extraConfig = {}) {
  const { discord, channel } = extraConfig;
  if (!discord || !channel) {
    throw new Error('UseAPI Discord Server ID and Channel ID are required for Midjourney');
  }

  // Build prompt with aspect ratio and style reference
  let fullPrompt = prompt;
  if (referenceImageUrls && referenceImageUrls.length > 0) {
    fullPrompt += ' --sref ' + referenceImageUrls.join(' ');
  }
  fullPrompt += ` --ar ${size.ar}`;

  const res = await fetch(`${BASE_URL}/jobs/imagine`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      discord: discord,
      server: discord,
      channel: channel,
      prompt: fullPrompt
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Midjourney API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    jobId: data.jobid,
    status: 'processing'
  };
}

async function checkStatus(apiKey, jobId, extraConfig = {}) {
  const res = await fetch(`${BASE_URL}/jobs/?jobid=${encodeURIComponent(jobId)}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Midjourney status error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  // Midjourney returns a 4-image grid. Once complete, auto-upscale U1
  if (data.status === 'completed' && data.attachments && data.attachments.length > 0) {
    // Check if this is already an upscaled image
    if (data.content && data.content.includes('Upscaled')) {
      return {
        status: 'completed',
        imageUrl: data.attachments[0].url
      };
    }

    // Try to auto-upscale U1 (first image from the grid)
    try {
      const upscaleRes = await fetch(`${BASE_URL}/jobs/button`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jobid: jobId,
          button: 'U1'
        })
      });

      if (upscaleRes.ok) {
        const upscaleData = await upscaleRes.json();
        return {
          status: 'processing',
          jobId: upscaleData.jobid // Return new upscale job ID to poll
        };
      }
    } catch (e) {
      console.error('Midjourney upscale error:', e.message);
    }

    // Fallback: return grid image if upscale fails
    return {
      status: 'completed',
      imageUrl: data.attachments[0].url
    };
  }

  if (data.status === 'failed' || data.status === 'cancelled') {
    return {
      status: 'failed',
      error: data.error || data.content || 'Midjourney generation failed'
    };
  }

  return { status: 'processing' };
}

module.exports = { generate, checkStatus };
