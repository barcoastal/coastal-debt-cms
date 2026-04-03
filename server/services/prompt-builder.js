// server/services/prompt-builder.js

const PROMPT_OPTIONS = {
  gender: ['Male', 'Female'],
  age_range: ['25-35', '35-45', '45-55'],
  ethnicity: ['Caucasian', 'African American', 'Hispanic/Latino', 'Asian', 'Middle Eastern', 'South Asian'],
  pose: ['Standing confident', 'Arms crossed', 'Hands clasped', 'Leaning casual', 'Pointing', 'Thumbs up'],
  expression: ['Warm smile', 'Confident', 'Serious/professional', 'Friendly', 'Relieved/hopeful'],
  attire: ['Business formal (suit)', 'Business casual', 'Casual', 'Trade/work uniform'],
  framing: ['Half body', 'Full body', 'Head & shoulders'],
  background: ['Transparent', 'Office', 'Outdoor', 'Studio plain']
};

function buildPrompt(config) {
  const { gender, age_range, ethnicity, pose, expression, attire, framing, background, extra_details } = config;

  const bgText = background === 'Transparent'
    ? 'solid white background for easy background removal'
    : `${background.toLowerCase()} background`;

  let prompt = `Professional photo of a ${gender.toLowerCase()}, age ${age_range}, ${ethnicity}, ${pose.toLowerCase()}, ${expression.toLowerCase()} expression, wearing ${attire.toLowerCase()} attire, ${framing.toLowerCase()} shot, ${bgText}, studio lighting, high quality, photorealistic`;

  if (extra_details && extra_details.trim()) {
    prompt += `, ${extra_details.trim()}`;
  }

  return prompt;
}

function validateConfig(config) {
  const errors = [];
  for (const [key, options] of Object.entries(PROMPT_OPTIONS)) {
    if (!config[key]) {
      errors.push(`${key} is required`);
    } else if (!options.includes(config[key])) {
      errors.push(`Invalid ${key}: "${config[key]}". Options: ${options.join(', ')}`);
    }
  }
  return errors;
}

module.exports = { buildPrompt, validateConfig, PROMPT_OPTIONS };
