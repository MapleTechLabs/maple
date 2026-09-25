---
title: "Product events"
description: "Track the steps that matter, like signup, checkout and plan started, from the browser, a span you already emit, or any backend, and build funnels, drop-off and path analysis on them."
group: "Product Events"
order: 1
---

A product event is a named thing a person did: `signup_completed`, `checkout_completed`, `plan_started`. Maple stores every one in a single `product_events` table, keyed to a person by `user_id`, `group_id` and `visitor_id`, and keeps it for 365 days. Funnels, drop-off and paths in the dashboard query builder run on that table, and **Web Analytics** filters and breaks down browser events.

Product events do not require session replay or the browser SDK. Any service that emits OpenTelemetry spans, or can make an HTTP request, can send them.

## Three ways to send one

| Source            | How                                                              | Use when                                                                 |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Browser           | `track(name, props)` in `@maple-dev/browser` or the Effect SDK   | The step is a user action in the page, and you want it in the replay.    |
| Span annotation   | `maple.product_event.name` on a span you already emit            | The step already runs inside a traced request or job.                    |
| `POST /v1/events` | NDJSON to the ingest gateway, or `MapleEvents` in the Effect SDK | There is no span: webhooks, batch scripts, mobile apps, other languages. |

All three key on the same `user_id`, `group_id` and `visitor_id`, so one funnel can mix them.

### Browser

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.track("checkout_completed", { plan: "pro", seats: 12 })
```

The event appears in the session transcript next to the clicks and requests around it. Calls made before the SDK finishes initializing are queued. See the [Browser SDK](/docs/session-replay/browser-sdk#custom-events).

### From a span

```ts
span.setAttributes({
	"maple.product_event.name": "plan_started",
	"maple.product_event.user_id": user.id,
})
```

Every other attribute on that span becomes an event property, and the event links back to the trace that performed it. See [Product events from traces](/docs/product-events/from-traces).

### Direct

```bash
curl -X POST https://ingest.maple.dev/v1/events \
  -H "Authorization: Bearer YOUR_INGEST_KEY" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary $'{"name":"plan_started","user_id":"user_123","attributes":{"plan":"startup"}}\n'
```

See the [Product events API](/docs/product-events/api) for the full field list, and the [Effect server SDK](/docs/sdks/effect-server#server-side-track) for a batching client.

## Identity

All three paths carry the same ids. `user_id` is whatever you pass to `identify()` in the browser and to your backend calls. `visitor_id` is the anonymous browser cookie, shared across your subdomains. Maple links a visitor to the user it later becomes. A funnel counted by person therefore joins an anonymous visit on the marketing site, the signed-in app session, and a server-side event from a webhook handler into one person.

`group_id` is the account, workspace or org the event belongs to. It is a filter and breakdown dimension. Funnels count persons, visitors, users or sessions, never groups. An event that carries only a `group_id` is stored and queryable, but it cannot be linked to a person.

## Naming

Names are 1 to 128 bytes. Names starting with `$` are reserved for Maple's SDKs. Use stable, lowercase, past-tense names like `plan_started`. The name is the funnel step key, so renaming an event splits its history.

## Verify

Send one event, then check within a minute:

- **Browser `track()`**: open **Web Analytics**. The event is listed on the **Events** card, and in the **Event** section of the sidebar.
- **Span annotation**: open the trace that produced it. The trace page lists it under **Product events**.
- **Any source**: open a dashboard, add a chart, and pick **Product events** as the data source. The event name is available to count and filter.

For `POST /v1/events`, a `200` response with `{"accepted": 1}` means the row was queued. `{"accepted": 0}` means the row was dropped, usually for a bad `name`, `source` or `timestamp`.

## Next steps

- [Product events from traces](/docs/product-events/from-traces)
- [Product events API](/docs/product-events/api)
- [Web Analytics](/docs/product-events/web-analytics)
