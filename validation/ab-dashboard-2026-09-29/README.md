# A/B test analytics — 2026-09-29

New admin entry: `/admin/ab-tests.html`. The existing A/B settings dialog links directly to the selected test. Reports include date filters in the configured CMS timezone, A/B visitors, leads, unique converted visitors, conversion rate, observed uplift, daily charts/tables, recent lead dates, configuration/run history, and a daily CSV export.

## Measurement

The deployment creates persistent `ab_runs`, `ab_participants`, and `ab_conversions` tables. Existing enabled tests start their first measured run; historical visitor/lead tables are not modified or backfilled because their variant attribution is ambiguous. The UI explicitly states the beginning of coverage.

An experiment uses a random HttpOnly browser session cookie and a visibility-triggered exposure request. The server serves the assigned variant and injects document-specific context. Lead submissions attach that context only to the same-origin lead endpoint, so a second tab cannot overwrite an older document's attribution. The original lead destination and webhook routing are preserved. Direct visits to a B source page cannot count toward the parent test.

Repeat visits count once per run. Lead records are deduplicated by lead ID; conversion rate counts unique converted participants, so multiple leads from one visitor cannot inflate conversion above 100%. Date filtering uses each participant's first measured visit in that run. Later conversions remain attributed to that visitor cohort. Runs retain their configuration after split/content-override/source-page changes, disabling, or re-enabling. Unchanged configuration saves do not restart a run. Editing page content itself does not create a new run.

## Verification

With app dependencies available:

```
node validation/ab-dashboard-2026-09-29/check.cjs
node validation/join3-2026-09-24/check.cjs
```

If using the release worktree, set `NODE_PATH=/Users/baralezrah/coastal-debt-cms/node_modules` for the first command. The first suite uses an in-memory SQLite DB and a temporary directory, without importing production databases or workers. It verifies allocation at 0/100%, repeat visits, direct-B exclusion, duplicate lead handling, old-tab conversions, date boundaries including DST, run transitions, HTML serving, missing variants, and the scoped browser submission header.

`preview.cjs` serves an isolated dashboard at `http://127.0.0.1:3098/admin/ab-tests.html` with synthetic in-memory records. Browser checks covered desktop, 390px mobile width (no document overflow), custom/empty date ranges, selecting historical runs, filtering active tests, chart metric selection, and CSV download. The downloaded CSV was parsed and reconciled to the preview report totals.

No production lead submissions or A/B configuration changes are part of verification.
