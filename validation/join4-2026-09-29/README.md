# Join Version 4

Template type `join4` combines the Join3 hero and assessment controller with the Join V2 header and every lower-page section. Hero defaults only come from Join3; V2 section defaults, text editing, and ordering remain available. CSS selectors are scoped under `#join4-hero` to avoid changing the lower page. Existing templates are unchanged.

Run `node validation/join4-2026-09-29/check.cjs` for isolated CMS creation, editing, readback, section preservation/order, hidden fields, and assigned form checks. Run `python3 validation/join4-2026-09-29/serve.py` for a local preview at http://localhost:3098/lp/join4/. `node validation/join4-2026-09-29/browser.cjs` checks desktop/mobile rendering and submits only to the isolated local server. Preview output is ignored.

The V4 copy also repairs the inherited malformed TikTok script wrapper and guards optional WordPress localization. Assigned CMS scripts have insertion points in the head and body.
