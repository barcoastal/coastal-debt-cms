# A/B test analytics — 2026-09-29

New admin entry: `/admin/ab-tests.html`. The existing A/B settings dialog links directly to the selected test. Reports include date filters in the configured CMS timezone, A/B visitors, leads, unique converted visitors, conversion rate, observed uplift, daily charts/tables, recent lead dates, configuration/run history, and a daily CSV export.

## Measurement

The deployment creates persistent `ab_runs`, `ab_participants`, and `ab_conversions` tables. Existing enabled tests start their first measured run; historical visitor/lead tables are not modified or backfilled because their variant attribution is ambiguous. The live view states its beginning of coverage. The historical view below recovers the earlier data separately.

An experiment uses a random HttpOnly browser session cookie and a visibility-triggered exposure request. The server serves the assigned variant and injects document-specific context. Lead submissions attach that context only to the same-origin lead endpoint, so a second tab cannot overwrite an older document's attribution. The original lead destination and webhook routing are preserved. Direct visits to a B source page cannot count toward the parent test.

Repeat visits count once per run. Lead records are deduplicated by lead ID; conversion rate counts unique converted participants, so multiple leads from one visitor cannot inflate conversion above 100%. Date filtering uses each participant's first measured visit in that run. Later conversions remain attributed to that visitor cohort. Runs retain their configuration after split/content-override/source-page changes, disabling, or re-enabling. Unchanged configuration saves do not restart a run. Editing page content itself does not create a new run.

## Verification

With app dependencies available:

```
node validation/ab-dashboard-2026-09-29/check.cjs
node validation/join3-2026-09-24/check.cjs
```

If using the release worktree, set `NODE_PATH=/Users/baralezrah/coastal-debt-cms/node_modules` for the first command. The first suite uses an in-memory SQLite DB and a temporary directory, without importing production databases or workers. It verifies allocation at 0/100%, repeat visits, direct-B exclusion, duplicate lead handling, old-tab conversions, date boundaries including DST, run transitions, HTML serving, missing variants, and the scoped browser submission header.

`preview.cjs` serves an isolated dashboard at the available local port printed on startup with synthetic in-memory records. Browser checks covered desktop, 390px mobile width (no document overflow), custom/empty date ranges, selecting historical runs, filtering active tests, chart metric selection, and CSV download. The downloaded CSV was parsed and reconciled to the preview report totals.

No production lead submissions or A/B configuration changes are part of verification.


## Historical recovery

The dashboard defaults to All tests, showing active runs first alongside ended runs and historical periods. Live tracking and Historical results remain selectable; filtered views include a Show all tests shortcut. Summary cards in All tests use live measurements only, while historical estimates remain labeled per row and use their own attribution, daily details and CSV format. New tests remain visible even before their first visit. `ab_history_runs`, `ab_history_records`, and `ab_history_meta` preserve a one-time snapshot in the existing database. Original lead/visitor records and live measurement tables are not modified.

Historical periods follow A/B enable/save/disable activity records. Leads are attributed by their original `hidden_fields.page_url` and variant tag, even when the destination form belongs to a different B source page. Former B source pages are recovered from that same evidence. A source page's direct traffic is excluded from its parent experiment. For separate-page experiments, untagged lead submissions are inferred from the source page, and untagged visitors on the original test URL are estimated as A. These counts are labeled in the report. Unresolved attribution remains unassigned and is included separately in exports.

Legacy visitors had one mutable record each, so the snapshot uses their last saved visit before the live cutoff. Leads use their actual submission dates. Historical rates are estimated leads / recorded visitors, not live visitor-cohort conversion rates. Missing historical allocations are not fabricated. Visitor records already updated beyond the cutoff cannot be reconstructed and are counted in the attribution note when present. The snapshot is immutable and imports once; new live events cannot rewrite it.

`history-check.cjs` covers date boundaries, former/current B pages, direct B traffic, untagged/unknown attribution, disabled tests, unchanged source data, and idempotent imports. `history-audit.py` opens production read-only and validates the recovery in an in-memory copy of the relevant fields. It prints aggregate counts only, no customer contact details.

Read-only validation for the selected MCA test recovered:

- Sep 1 to Sep 29 cutoff: A 1,051 recorded/estimated visitors and 12 leads; B 3,737 recorded visitors and 76 leads. Estimated rates 1.14% / 2.03%.
- Apr 7 to Sep 1: A 8,573 recorded/estimated visitors and 183 leads; B 8,588 recorded visitors and 119 leads.

Browser verification covered source switching, a two-day custom historical range, mobile width without document overflow, and CSV download. The historical fixture CSV reconciled to 60 visitors / 6 leads and included attribution counts and the date basis.
