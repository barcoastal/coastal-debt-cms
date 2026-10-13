const fs = require('fs');
const path = require('path');
const model = require('../../public/assets/google-click-ids');
const script = fs.readFileSync(path.join(__dirname, '../../public/assets/google-click-ids.js'), 'utf8');
function inject(html) {
  if (html.includes('id="coastal-google-click-ids"')) return html;
  return html.replace(/<head[^>]*>/i, match => match + '\n<script id="coastal-google-click-ids">' + script + '</script>');
}
function forRequest(req) {
  let fallback = '';
  try {
    const url = new URL(req.headers?.referer || '');
    // Only use the HTTP referrer for same-site form requests. Never import a
    // Google ID from an unrelated referring website or from a visitor match.
    if (url.host === req.get('host')) fallback = url.href;
  } catch (_) {}
  return model.resolve(req.body || {}, fallback);
}
module.exports = {...model, inject, forRequest};
