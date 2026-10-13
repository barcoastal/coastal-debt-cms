(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else {
    root.CoastalGoogleClickIds = model;
    // The Google RedTrack campaign forwards {gclid} as ref_id. Restore the
    // canonical parameter before template forms and tracking scripts read it.
    try {
      const url = new URL(root.location.href), ids = model.fromUrl(url.href);
      if (!model.cleanId(url.searchParams.get('gclid')) && ids.gclid) {
        url.searchParams.set('gclid', ids.gclid);
        root.history.replaceState(root.history.state, '', url.href);
      }
    } catch (_) { /* Server-side capture also handles the original page URL. */ }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Matches RT_CAMPAIGNS.google in the lead and visitor routes. ref_id is not
  // a Google ID for other campaigns (Facebook/Bing/affiliate values differ).
  const googleCampaign = '6855272ea2fde3e964e81fb6';
  function cleanId(value) {
    if (typeof value !== 'string') return '';
    const id = value.trim();
    return /^[A-Za-z0-9._~=-]{1,1024}$/.test(id) && !/^(null|undefined|false|true|gclid|gbraid|wbraid)$/i.test(id) ? id : '';
  }
  function fromUrl(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return {};
      const params = url.searchParams;
      const direct = cleanId(params.get('gclid'));
      const googleRef = params.get('cmpid') === googleCampaign ? cleanId(params.get('ref_id')) : '';
      return {gclid: direct || googleRef, gbraid: cleanId(params.get('gbraid')), wbraid: cleanId(params.get('wbraid')),
        source: direct ? 'page_url_gclid' : googleRef ? 'google_ref_id' : ''};
    } catch (_) { return {}; }
  }
  function resolve(fields, fallbackUrl) {
    const urls = [fields.page_url, fields.sourceURL, fields.source_url, fallbackUrl].map(fromUrl);
    const result = {};
    for (const key of ['gclid', 'gbraid', 'wbraid']) result[key] = cleanId(fields[key]) || urls.map(ids => ids[key]).find(Boolean) || '';
    result.source = cleanId(fields.gclid) ? 'submitted_gclid' : (urls.find(ids => ids.gclid) || {}).source || '';
    return result;
  }
  return {cleanId, fromUrl, resolve};
});
