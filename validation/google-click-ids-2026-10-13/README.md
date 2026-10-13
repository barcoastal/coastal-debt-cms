# Google click ID capture

The configured Google RedTrack campaign forwards Google's click ID in `ref_id`.
Some arrivals have no separate `gclid` parameter. Existing templates only read
`gclid`, browser storage or `_gcl_aw`, so those submissions lost their Google ID.
The October 13 audit found 20 affected Google leads in the preceding 30 days;
273 other saved URLs had identical values for both `gclid` and `ref_id`.

The generator now inserts a small inline normalizer before tracking/form scripts.
It restores `gclid` from `ref_id` **only for the known Google campaign** and keeps
existing GCLIDs, the rest of the query and the fragment intact. This covers every
landing-page template and template B. The lead and visitor handlers independently
recover the ID from their submitted page URL (or same-site HTTP referrer), so
cached pages are protected too. No visitor/name/email matching or ID synthesis is
used. GBRAID/WBRAID remain separate metadata on submitted leads.

Checks (all external requests are intercepted):

```sh
node validation/google-click-ids-2026-10-13/check.cjs
node validation/phone-schedule-2026-10-12/generate.cjs
node validation/google-click-ids-2026-10-13/browser.cjs
```

Historical recovery is dry-run by default:

```sh
node scripts/recover-google-click-ids.cjs --since=2026-09-13
node scripts/recover-google-click-ids.cjs --since=2026-09-13 --apply
```

It only fills empty lead GCLIDs from that lead's saved Coastal URL, preserves
other fields, saves a restricted backup on the persistent volume, and logs the
changed IDs. A concurrent edit aborts the transaction. It does not resend leads,
webhooks, emails or conversions, and does not modify visitor or A/B records.
