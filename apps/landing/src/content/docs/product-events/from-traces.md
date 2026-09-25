---
title: "Product events from traces"
description: "Turn a span you already emit into a product event by annotating it with maple.product_event.* attributes. No second SDK call, and each event links back to the request that performed it."
group: "Product Events"
order: 2
---

Browser `track()` calls and `POST /v1/events` are explicit calls made for analytics. Most conversion steps already happen inside a traced code path: the handler that creates the subscription, the job that finishes the import. Annotate that span and Maple writes it into the same `product_events` table as everything else, linked to the trace that did the work.

For when to use this path instead of the other two, see [Three ways to send one](/docs/product-events/overview#three-ways-to-send-one).

## Annotate the span

Set one attribute on the span that performs the step. Its presence is the switch. Nothing else has to be declared.

```ts
span.setAttributes({
	"maple.product_event.name": "plan_started", // required
	"maple.product_event.user_id": user.id, // optional identity
	"maple.product_event.group_id": org.id,
	"maple.product_event.visitor_id": anonId,
	"maple.product_event.url": req.url, // optional page context
})
```

With the Effect SDK the same keys go through `Effect.annotateCurrentSpan`:

```ts
yield *
	Effect.annotateCurrentSpan({
		"maple.product_event.name": "plan_started",
		"maple.product_event.user_id": user.id,
		"maple.product_event.group_id": org.id,
	})
```

Any OpenTelemetry SDK works, in any language. The contract is a set of attribute keys on the span.

| Attribute                        | Notes                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maple.product_event.name`       | **Required.** The event name. Names starting with `$` are reserved.                                                                                                                                                                    |
| `maple.product_event.user_id`    | The signed-in user, matching what you pass to `identify()` in the browser.                                                                                                                                                             |
| `maple.product_event.group_id`   | Account, workspace or org id.                                                                                                                                                                                                          |
| `maple.product_event.visitor_id` | The browser visitor cookie value, when the backend has it.                                                                                                                                                                             |
| `maple.product_event.url`        | Page the step happened on. `host` and `page_path` are derived from it.                                                                                                                                                                 |
| `session.id`                     | OpenTelemetry's own session key. When the span carries one, it becomes the event's session id, so a browser-originated trace joins its replay session. Without it the event has no session and takes no part in session-keyed funnels. |

The `service_name` of the event is the span's service, and its timestamp is the span's start time.

## Event properties

**Every other attribute on the span becomes an event property by default.** Whatever the code already sets (`plan`, `order.total`, the HTTP and database semconv keys) lands in the event's attributes and is available for funnel breakdowns and filters. The `maple.product_event.*` control keys are stripped, because they are promoted to their own columns.

Two optional attributes narrow or replace that default:

```ts
"maple.product_event.include": "plan,seats"   // copy ONLY these span keys
"maple.product_event.prop.plan": "pro"        // set a property explicitly; wins on collision
```

| `include`      | `prop.*` | Resulting properties                                              |
| -------------- | -------- | ----------------------------------------------------------------- |
| absent         | absent   | every span attribute                                              |
| absent         | set      | every span attribute, with the `prop.*` values overriding on ties |
| `"plan,seats"` | absent   | only `plan` and `seats`                                           |
| `""`           | set      | only the `prop.*` values                                          |

`include` switches on key presence, so an empty string means "no span attributes". A server span's attribute map is mostly semconv keys, and product events are kept for 365 days, longer than raw traces (see [Retention](/docs/reference/retention)). Set `include` once you know which properties you need.

## Where the link shows up

`product_events` rows from this path carry the trace and span id.

- The **trace detail page** lists the product events a trace produced, under **Product events**.
- On **Web Analytics**, setting the **Event** filter to an event that annotated spans produce shows a **Traces behind** panel with sample traces for that event. A drop-off in a funnel step is one click from the requests behind it.

## When events start

Maple turns annotated spans into product events as the spans are ingested. Only spans ingested after you deploy the annotation become events. Spans already stored are not converted, so a new annotation has no history before its deploy.

## Why an attribute

A product event has to be emitted by the code path that performed the step, at the moment it performed it. An attribute marks every trace that code path produces, and it is reviewed in your own diff like any other code change. The span is the record and the product event is its projection, so there is no second store to keep in sync.

## Verify

Deploy the annotation, trigger the step once, and open the resulting trace in **Traces**. Within a minute, the trace page lists the event under **Product events**. The event is then available to funnels and charts that use **Product events** as their data source.

If the trace appears but no product event does:

- Check that `maple.product_event.name` is set on a span in the trace, and that its value does not start with `$`.
- Check that the trace was ingested after the annotation was deployed.
