// Loaded in the head with fresh schedule data, independently of cached page HTML.
window.startCoastalPhoneVisibility = function (initial) {
  'use strict';
  const root = document.documentElement;
  let schedule, serverTime, receivedAt, refreshing = false;
  const bars = '#mobileStickyCtaBar, #mobileCta, .mobile-sticky-cta, .mobile-cta';
  function updateBars() {
    const closed = root.dataset.coastalPhoneState === 'closed';
    document.querySelectorAll(bars).forEach(bar => {
      const links = Array.from(bar.querySelectorAll('a, button'));
      // Keep mixed call/form bars and form-only CTAs available. Hide empty call bars.
      const hasAvailableAction = links.some(link => !link.matches('a[href^="tel:" i], .phone-element') && getComputedStyle(link).display !== 'none');
      bar.classList.toggle('coastal-phone-bar-hidden', closed && !hasAvailableAction);
    });
  }
  function tick() {
    const now = serverTime + performance.now() - receivedAt;
    const state = CoastalPhoneSchedule.visible(schedule, now) ? 'open' : 'closed';
    if (root.dataset.coastalPhoneState !== state) {
      root.dataset.coastalPhoneState = state;
      updateBars();
    }
  }
  function apply(data) {
    schedule = CoastalPhoneSchedule.normalize(data.schedule);
    if (!Number.isFinite(data.serverTime)) throw new Error('Missing schedule clock');
    serverTime = data.serverTime; receivedAt = performance.now(); tick();
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/phone-schedule/public', {cache: 'no-store', signal: controller.signal});
      if (response.ok) apply(await response.json());
    } catch (_) { /* The last valid schedule keeps running when offline. */ }
    finally { clearTimeout(timeout); refreshing = false; }
  }
  apply(initial);
  function watchPhoneChanges() {
    updateBars();
    const observer = new MutationObserver(updateBars);
    // Retreaver and template scripts can replace phone links or change CTA mode.
    observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['href']});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchPhoneChanges, {once:true});
  else watchPhoneChanges();
  setInterval(tick, 1000);
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refresh(); } });
  window.addEventListener('pageshow', event => { if (event.persisted) { tick(); refresh(); } });
};
