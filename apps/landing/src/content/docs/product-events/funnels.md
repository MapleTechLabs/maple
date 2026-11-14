---
title: "Funnels"
description: "Build a funnel over product events in Maple: pick the steps, count people, visitors, users or sessions, set a conversion window, break it down by channel or event property, filter a step, and read where people drop off and how long it takes."
group: "Product Events"
order: 5
---

A funnel answers one question: of the people who did the first thing, how many went on to do the next, and the next. **Product analytics → Funnels** builds one from the product events you already send. The same funnel can sit on a dashboard as a **Funnel** widget.

## Prerequisites

Product events from any source: the [Browser SDK](/docs/session-replay/browser-sdk), a [span you already emit](/docs/product-events/from-traces), or the [Product events API](/docs/product-events/api). Page views and mobile screen views count too.

## Build a funnel

1. Open **Product analytics** and pick the **Funnels** tab.
2. Add a step for each thing people do, in order. A funnel takes up to ten steps.
3. Read the result below. The funnel is in the URL, so the link you copy opens the same funnel.

Each step is one of three kinds:

| Kind    | Matches                                                                                                |
| :------ | :----------------------------------------------------------------------------------------------------- |
| Event   | A `track()` call or a server-side event, by name.                                                      |
| Page    | A page view by path, or a mobile screen view by screen name. A page can be narrowed to one host.       |
| Session | Where a session came from: referrer, UTM source, medium or campaign, country or site. First step only. |

A session step is how you start a funnel at a campaign: "arrived from the launch campaign, then signed up, then started a plan".

### Filter a step by a property

Turn on **Filter by property** to narrow an event step to events that carry a value: `plan = "startup"`, or `method = "google" AND source = "cli"`. Only `=` and `AND` are supported. The filter runs when you press Enter or stop typing.

The same event can be two steps with different filters, for example `plan_started` with `plan = "startup"` and later `plan_started` with `plan = "scale"`.

### Repeat a step

List the same event twice to ask who did it twice. `product_viewed`, `product_viewed`, `add_to_cart` counts people who looked at two products before adding one to the cart. One event never counts for two steps.

## What a funnel counts

**Count by** picks who is counted:

| Count by | Counts                                                                                                                                  |
| :------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| Person   | The user id when the event has one, else the visitor. An anonymous visit and the signed-in activity of the same browser are one person. |
| Visitor  | The anonymous browser or device id.                                                                                                     |
| User     | Identified users only.                                                                                                                  |
| Session  | Each browser session on its own. Server-side events have no session and take no part.                                                   |

**Within** is the conversion window: every step has to happen within that long after the first step. Pick a window that fits the funnel. A checkout fits an hour. Signup to a paid plan needs days.

A person can try more than once. If their first try runs out of time and a later one gets further, the later one is counted. Events in the same millisecond keep the order they were recorded in.

## Read the result

- **Entered** and **Conversion** are compared with the same length of time before the selected range.
- **Time to convert** is the median time from the first step to the last, for the people who finished, and the time 90% of them finished within.
- **Biggest drop** names the step that loses the largest share of the people who reached the one before it.
- **Drop-off** draws a column per step: who reached it, and above it who left since the previous step. Hover a column for the time between steps and what the leavers did next. **Bars** draws one bar per step.
- The **Steps** table lists, per step, the count, the share of everyone who entered, the share of the previous step, how many dropped, the median and p90 time from the previous step, and the three most common things leavers did next.

"Leavers did next" is the first event of a person after the last step they reached. "Nothing after" means they sent no further event in the selected range.

## Break it down

**Break down by** splits the funnel into groups and shows each group's conversion next to everyone's:

- where the session came from: referrer, UTM source, medium, campaign, country or site;
- an event property your events carry, such as `plan` or `method`.

A person is counted under the first value seen for them in the range. People with no value are grouped as `(none)`. The table lists up to 20 groups, the ones most people entered first.

To look at one group only, use the filters on the left. They narrow the whole funnel to people with a matching session.

## Server-side and mobile steps

A step can come from your backend. `plan_started` usually does, because the browser leaves for the payment page. Count by **Person** and send the same `user_id` you pass to `identify()` in the browser, so the server-side step joins the visit that led to it.

Mobile screen views are page steps: use the screen name as the path. For a funnel that starts before sign-in in a mobile app, count by **Visitor** and send the same `visitor_id` (your install id) on every event, before and after sign-in. Maple links a visitor to a user from browser sessions only.

## Next steps

- [Product events overview](/docs/product-events/overview)
- [Product events API](/docs/product-events/api)
- [Build dashboards](/docs/dashboards/build-dashboards)
