(function () {
  if (!window._abExposure) return;
  // Keep attribution tied to this document, including when another tab starts a newer run.
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const method = init?.method || input?.method || 'GET';
      if (url.origin === location.origin && /^\/api\/leads\/?$/.test(url.pathname) && method.toUpperCase() === 'POST') {
        const headers = new Headers(init?.headers || input?.headers);
        headers.set('X-Coastal-AB-Exposure', window._abExposure);
        init = { ...init, headers };
      }
    } catch (_) { /* Preserve the original request if it cannot be inspected. */ }
    return originalFetch.call(this, input, init);
  };
  function record() {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', record);
    fetch('/api/ab-tests/exposure', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: window._abExposure })
    }).catch(function () {});
  }
  if (document.visibilityState === 'visible') record();
  else document.addEventListener('visibilitychange', record);
})();
