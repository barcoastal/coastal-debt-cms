// Apply once to every generated template, including standalone variant-b.html files.
const head = `<style id="coastal-phone-visibility">
html:not([data-coastal-phone-state="open"]) a[href^="tel:" i],
html:not([data-coastal-phone-state="open"]) .phone-element,
html:not([data-coastal-phone-state="open"]) .retreaver-phone,
html:not([data-coastal-phone-state="open"]) [data-phone-visibility],
.coastal-phone-bar-hidden { display: none !important; }
</style><script src="/api/phone-schedule/runtime.js" async></script>`;
module.exports = function injectPhoneVisibility(html) {
  if (html.includes('id="coastal-phone-visibility"')) return html;
  return html.replace(/<head[^>]*>/i, match => match + '\n' + head);
};
