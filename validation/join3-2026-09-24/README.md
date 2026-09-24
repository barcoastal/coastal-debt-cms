# Join3

Adds the Join3 template to creation, editing, list labels and campaign cloning. The design follows the supplied Business Debt Insider `/mca` reference with Coastal branding, existing Coastal imagery, settlement examples and client review excerpts. Existing pages keep their selected templates.

The template uses the normal content editor for hero text, colors, steps, benefit paragraphs, comparison, FAQ and CTA. Benefit paragraphs may start with `# Heading` on their first line. Existing assigned forms, hidden fields, scripts, submission routing, skip-prequalification, mobile CTA and attribution are supported. The visible review and settlement examples are fixed in the template, as on Join.

Validation:

- `node validation/join3-2026-09-24/check.cjs` exercises the actual CMS create/edit/read handlers and generation, using a fake database and isolated output.
- Syntax checks pass for the server routes, template helper, client script, generated inline scripts and admin inline scripts.
- Browser checked on desktop and at 390px: images load, no horizontal overflow, FAQ opens, phone icon appears, normal viewport restored.
- Local-only form test covers both disqualification states, transitions, required consent and a successful submission. The received payload preserves slug, qualification, contact details, consent and visitor attribution. No test lead is sent to production.

Local preview: run the check, then `python3 validation/join3-2026-09-24/serve.py`. The preview server mocks all API requests and saves test payloads under the ignored `preview/` directory.
