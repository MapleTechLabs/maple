---
title: "Product events from traces"
description: "Turn a span you already emit into a product event by annotating it with maple.product_event.* attributes. No second SDK call, and each event links back to the request that performed it."
group: "Product Events"
order: 2
---

Browser `track()` calls and `POST /v1/events` are explicit calls made for the sake of analytics.
Most conversion steps, though, already happen inside a traced code path: the handler that creates
the subscription, the job that finishes the import. Annotate that span and Maple projects it into
the same `product_events` table as everything else, linked to the trace that did the work.

## Annotate the span

Set one attribute on the span that performs the step. Its presence is the switch; nothing else has
to be declared.

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

Any OpenTelemetry SDK works, in any language: the contract is attribute keys on the span, not an
API.

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

**Every other attribute on the span becomes an event property by default.** Whatever the code
already sets, `plan`, `order.total`, the HTTP and database semconv keys, lands in the event's
attributes and is available for funnel breakdowns and filters. The `maple.product_event.*` control
keys are stripped, since they are promoted to their own columns.

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

`include` switches on key presence, so an empty string means "no span attributes", not "no
filter". A server span's attribute map is mostly semconv keys, and product events are retained for
365 days against 30 for raw traces, so set `include` once you know which properties you need.

## Where the link shows up

`product_events` rows from this path carry the trace and span id.

- The **trace detail page** lists the product events a trace produced, under the anatomy strip.
- On **Analytics**, filtering by an event name shows sample traces behind that event, so a
  drop-off in a funnel step is one click from the requests that did or did not complete it.

## Why an attribute and not a button

A product event has to be emitted by the code path that performed the thing, at the moment it
performed it. Marking a trace by hand in the UI would mark one sampled trace and could not be
replayed over history. An attribute marks every trace the path produces, applies retroactively
across the whole trace retention window, and is reviewable in your own diff. The span is the record
and the product event is its projection; there is no second store to keep in sync.

## Which path to use

| Source            | Use when                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| Browser `track()` | The step is a user action in the page and you want it in the replay.     |
| Span annotation   | The step already runs inside a traced request or job.                    |
| `POST /v1/events` | There is no span: webhooks, batch scripts, mobile apps, other languages. |

All three key on the same `user_id`, `group_id` and `visitor_id`, so one funnel can mix them.
