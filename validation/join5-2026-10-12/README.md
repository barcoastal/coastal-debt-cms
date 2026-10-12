# Join Version 5 — Bankruptcy

`join5` combines the shared Version 4 hero, qualification steps and mobile debt picker with the Authority sections used by `/lp/bankruptcy-alternative/`. The default content snapshot comes from that CMS page on October 12, 2026. Each page retains independent editable content, form assignment, hidden fields and A/B attribution.

The reference styles are scoped outside the hero. Shared `join3.js`, `join4.js` and `join4-hero.css` provide the existing hero behavior. The footer form retains its layout and phone validation, copies the hero's attribution fields at submission, and shares the success state. Only one handler submits each form. The shared Trakkit capture block covers both forms, including an SDK ID without a cookie.

The CMS template selectors support creation, editing and cloning. The generator supports the Authority section visibility flags without leaving browser errors when a section is removed.

Validation:

- `node validation/join5-2026-10-12/check.cjs`: actual routes and generation, default bankruptcy content, editor round trip, escaping, assigned forms, hidden sections and template selectors.
- `node validation/join5-2026-10-12/browser.cjs`: desktop/mobile overflow, form order, qualification, calculator, FAQ, both submission paths, shared success state, click IDs, original test variant, and hidden sections. Lead submissions and tracking calls are intercepted locally. Screenshots are saved outside the repository.
- Existing Join3 and Join4 route/generator checks pass.

The new live page is created separately from the reference page and inherits its form, webhook, hidden fields and applicable page-specific scripts. Existing pages and A/B allocations are not changed.
