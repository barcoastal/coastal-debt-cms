# Trakkit form capture

Landing-page and article forms now read the Trakkit SDK's current click ID before falling back to the cookie. Empty hidden fields are created at load so the tracker can populate them after its response arrives. Capture also runs when FormData is constructed, including dynamically added forms. Join3/Join4 preserve an already populated ID when another attribution refresh has no value.

The incoming referral URL ID remains in `affiliate_tkclid`; the capture code does not directly substitute it for the page's own ID. No new click IDs are generated, existing leads are not replayed, and no webhook destinations or mappings change.

## Checks

Generate the isolated Join previews, then run the browser checks:

```sh
node validation/join3-2026-09-24/check.cjs
node validation/join4-2026-09-29/check.cjs
node validation/trakkit-capture-2026-10-03/check.cjs
```

`PLAYWRIGHT_MODULE` can point to an existing Playwright installation. Chrome is required. All browser requests are fulfilled locally or aborted, including lead submissions and trackers.

Coverage: 120 browser cases across 15 inline capture blocks, plus real Join3 and Join4 submissions with cookies unavailable. Cases cover SDK-only IDs, cookie fallback, SDK errors, preservation of a captured ID, missing tracker, late tracker response, dynamic forms/programmatic FormData, storage exceptions, and separate affiliate attribution.

To reproduce the original Authority failure and verify the corrected hero and bottom form handlers, first save the public pre-fix page HTML, then run:

```sh
node validation/trakkit-capture-2026-10-03/authority.cjs /path/to/pre-fix-authority.html
```

This substitutes the updated capture block into the downloaded page only inside the isolated test. The original page must predate this fix. No customer submission data is needed.

The fix covers IDs available in the SDK, cookie, or form at submission. It does not recover an ID when the tracker never loads or its response has not arrived before submission.
