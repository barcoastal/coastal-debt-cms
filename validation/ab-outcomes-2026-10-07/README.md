# Trakkit outcomes in A/B tests

The A/B dashboard now shows Opportunities and Closed Won for each measured variant, summary totals, matched submission coverage, per-lead outcomes, and cohort-day outcome columns in its CSV export.

## Connection and deployment

`TRAKKIT_DATABASE_URL` is a server-only PostgreSQL connection for the `coastal_ab_reader` role. It reads only the `coastal_ab` projections defined in `trakkit-views.sql`. The projection is locked to Coastal's Trakkit tenant and Salesforce organization. No raw contact details or credentials are returned by the projections; matching uses normalized SHA-256 fingerprints. The CMS never writes to Trakkit or sends conversion postbacks.

The connection was provisioned and validated on Trakkit, and the CMS environment variable was configured through stdin using the CMS owner account. Connection credentials are not in this repository. Deploy the CMS commit normally; do not deploy the unrelated dirty Trakkit source tree.

The CMS creates additive `ab_lead_outcomes` and `ab_outcome_sync` SQLite tables, checks Trakkit on startup, every five minutes, and when the dashboard is refreshed (at most once per minute). A failed update retains the last successful snapshot, marks it stale, and does not expose database error details. A connection with no successful snapshot displays unavailable counts, not zeros. Source synchronization delayed beyond one hour is shown in the dashboard.

## Attribution

- Only leads joined through `ab_conversions` and `ab_participants` are included. Direct variant-page traffic does not enter the test.
- Match a captured Trakkit click ID to approved `opportunity` / `closed_won` events. Events predating the submission by more than one minute are excluded.
- Alternatively, match the lead to Trakkit's Salesforce feed using an existing Salesforce ID, or an exact normalized email/name-and-company fingerprint plus a creation time within five minutes after the submission. Ambiguous matches and missing related opportunities remain unresolved.
- Follow the converted opportunity and its active replacement when present. Closed Won means the current linked stage is `Closed Won` or Trakkit has an approved `closed_won` event. A Closed Won result also counts as Opportunity.
- Deduplicate an opportunity across variants within a run, assigning it to its earliest attributed submission. Selecting later visitor dates must not transfer a repeated outcome to another variant.
- Date filters select the original first-visit cohort, including later sales outcomes. Recovered historical estimates do not get fabricated exact sales attribution.
- Bayesian winner verdicts remain about visitor-to-lead conversion, explicitly labeled as such.

## Verification

`node validation/ab-outcomes-2026-10-07/check.cjs` checks attribution timing, ambiguous matches, missing related records, delayed/declined events, deduplication across variants, date filtering, unconfigured/historical states and refresh failure retention.

`node validation/ab-outcomes-2026-10-07/browser.cjs` checks real dashboard HTML/CSS/JS against synthetic responses: totals, per-variant and recent-lead results, CSV values, stale/disconnected/historical states, and desktop/mobile overflow. Set `PLAYWRIGHT_MODULE` to an installed Playwright package if needed. Screenshots are saved outside the repository.

The existing Bayesian statistics and browser regression checks also pass. A live read-only Trakkit lookup matched all 19 submissions from the previously reviewed v4 cohort and independently reproduced 5 opportunities and 0 Closed Won, matching the prior Salesforce check. Production deployment is verified separately through the deployed asset versions and the first successful CMS outcome synchronization. The source feed was last updated October 6 at validation time; the UI exposes this delay.
