# Landing-page phone schedule

CMS: **Landing pages → Phone schedule** (also **Settings → Phone schedule**).
The global default is **Always show**. An admin can select weekly hours or always hide,
choose an IANA timezone, and set each day to hours, all day, or hidden. Overnight hours
belong to their starting day. A start is inclusive and an end is exclusive; DST follows
the selected timezone. No business hours are activated by this deployment.

The `phone_schedule` setting is validated and saved transactionally with an activity log.
Only this configuration and a server timestamp are returned by the public endpoint.
The uncached head runtime is injected into every generated landing-page type and into
template-level B variants. Existing-page B variants inherit the same injection.
No page regeneration is needed after changing the schedule. Open pages refresh settings
every minute and apply time boundaries locally using the server clock.

The shared CSS hides tel links, existing phone-only wrappers and empty mobile call bars.
It leaves form controls (including phone inputs), form CTAs and page content intact.
If the initial schedule script cannot load, phone links stay hidden; forms still work.
After a successful load, the last valid weekly schedule continues to run offline.
This does not change phone numbers, routing, attribution, A/B allocation or lead delivery.

Run from the repository root:

```sh
node validation/phone-schedule-2026-10-12/check.cjs
node validation/phone-schedule-2026-10-12/generate.cjs
node validation/phone-schedule-2026-10-12/browser.cjs
```

`check.cjs` uses in-memory SQLite and a localhost server for persistence, authentication,
public data isolation, validation, DST, overnight and boundary cases. `generate.cjs`
exercises the real generator with an isolated database stub. `browser.cjs` tests all 17
templates plus B at desktop/mobile widths, delayed phone insertion, forms, restoration,
server clock boundaries, admin save/reload and save failures. Browser requests are
intercepted; no live settings, leads, tracking or email are sent. Set `PLAYWRIGHT_MODULE`
to the local Playwright module if needed. Preview files/screenshots go to `/private/tmp`.
