---
title: "Web analytics"
description: "What the Web Analytics page shows: visitors, sessions, page views, referrers, devices, countries and custom events from the Maple browser SDK, and what data each part needs."
group: "Product Events"
order: 4
---

**Web Analytics** shows who visited your sites, which pages they read, and where they came from. It reads the sessions, page views and `track()` events that the Maple browser SDK already sends for session replay. There is no separate analytics script.

## Prerequisites

The [Browser SDK](/docs/session-replay/browser-sdk) (`@maple-dev/browser`), or the browser entry point of `@maple-dev/effect-sdk`, initialized on every site you want to measure. Server-side product events from spans or `POST /v1/events` do not appear on this page. Query them with a dashboard chart instead.

## What the page shows

The page opens on the last 7 days. The time range picker, the filters and the **Replays** button (which opens the same window on the Replays page) are in the header.

### Live visitors

The badge left of the time range counts visitors active in the last few minutes. It ignores the selected range and refreshes every 15 seconds.

### Headline metrics

| Metric          | What it counts                                                                          |
| --------------- | --------------------------------------------------------------------------------------- |
| Unique visitors | Distinct browsers, by visitor id. If some sessions have no visitor id, the tile says what share do. |
| Sessions        | Browser sessions in the window.                                                          |
| Page views      | Page views across every session.                                                         |
| Pages / session | Page views divided by sessions.                                                          |
| Bounce rate     | Share of sessions that bounced, over sessions that report a visitor id.                  |
| Avg. session    | Average duration of sessions that ended.                                                 |
| New visitors    | Sessions that were a visitor's first ever.                                               |
| Returning       | Sessions from visitors seen before this window.                                          |

Pick a metric to chart it over the window.

### Breakdowns

Five cards break the traffic down, each with its own tabs. Click any row to filter the whole page by it.

- **Referrers**, **UTM source**, **Medium** and **Campaign**: where visitors came from.
- **Pages**, **Entries** and **Exits**: what they read, and where sessions started and ended.
- **Devices**, **Browsers** and **OS**.
- **Countries**, **Languages** and **Sites**.
- **Events**: custom events from `track()`, with the number of sessions that fired each.

**Sites** lists each host that sends data, so one organization can measure a marketing site and an app side by side. With more than one site, **Pages** shows each page's site icon.

### Filters

The sidebar filters by **Traffic**, **Site**, **Page**, **Event**, **Referrer**, **UTM source**, **UTM medium**, **UTM campaign**, **Visitor** (**New** or **Returning**), **Country** and **Language**. Active filters show as chips under the page title. **Clear all** removes them and keeps the time range.

**Traffic** chooses **Humans**, **Bots** or both. Only **Humans** is checked when the page opens. When more than 5% of recorded sessions in the window came from crawlers or automated browsers, a notice says how many and whether they are counted. It only covers bots that ran the browser SDK. Fetchers that do not run JavaScript never create a session.

When the **Event** filter names an event that annotated spans also produce, a **Traces behind** panel lists sample traces for it. See [Product events from traces](/docs/product-events/from-traces).

## What each part needs

| To see                                      | You need                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Sessions, page views, pages, devices        | The browser SDK initialized on the page.                                                    |
| Unique, new and returning visitors, bounce rate | The persistent visitor id. It is on by default. It is off when `privacy.persistVisitorId` is `false`, when consent is required and not granted, or when the browser sends Global Privacy Control. |
| One visitor across `example.com` and `app.example.com` | `privacy.crossSubdomainCookie` left on (the default) and the SDK on both sites.  |
| Events                                      | `MapleBrowser.track(name, props)` calls.                                                    |
| UTM source, medium and campaign             | `utm_source`, `utm_medium` and `utm_campaign` on the landing URL.                          |
| Countries                                   | Country is resolved at the ingest gateway. When it is not available the tab says so, and it is never backfilled. |

See [Consent](/docs/session-replay/browser-sdk#consent) for how the SDK handles consent and privacy signals.

## Verify

Open your site in a browser with the SDK installed, visit two pages, then open **Web Analytics**. Within a minute, the live badge counts you, **Page views** includes your two pages, and both pages are listed under **Pages**.

## Troubleshooting

- **Page views appear but Unique visitors is 0.** No session carried a visitor id. Check `privacy.persistVisitorId`, consent, and Global Privacy Control.
- **Numbers lower than another analytics tool.** Bots are excluded by default, and sessions only start once the SDK runs. Check the **Traffic** filter and the bot notice.
- **Countries is empty.** Country is resolved at ingest, and only for traffic received after it was available.

## Next steps

- [Browser SDK](/docs/session-replay/browser-sdk)
- [Replays](/docs/session-replay/replays)
- [Product events](/docs/product-events/overview)
