---
title: "On-call schedules"
description: "Decide who Maple pages and when: rotations in layers, overrides for a swapped shift, what happens in a gap or when someone leaves, and a calendar feed of the shifts."
group: "Alerting"
order: 4.3
---

An **on-call schedule** answers one question: who gets paged right now. People take turns in a rotation, and an [escalation chain](/docs/alerting/escalation-chains) pages whoever the schedule says is on call when its step comes up.

Schedules live under **Alerts → On-call**. Org admins and engineers can create and change them. Everyone in the org can read them.

## Create a schedule

1. Open **Alerts → On-call** and select **New schedule** (**Create schedule** while there are none).
2. Name it, and pick its **Time zone**. Handoff times and restrictions are read in that zone, whatever zone each person is in.
3. Add a **layer**: the people on it, in rotation order, and when they **hand off**.
4. Select **Create schedule** at the bottom of the form.

The preview under the form draws the weeks ahead as you type, and marks any stretch where nobody is on call.

### Layers

A layer is one rotation. A schedule can have up to 5.

| Field                        | What it does                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| People, in rotation order    | Who takes turns, up to 50. Each person holds the layer until the next handoff.                  |
| Hand off                     | Daily at a time, weekly on a weekday and time, or every given number of hours.                  |
| Only active in these windows | Limits the layer to weekly windows, such as weeknights or weekends. Without one it is always on. |

Later layers sit on top of earlier ones wherever they have someone on call. That is how a "weeknights" layer covers the nights and leaves the days to the layer below it. The **Final schedule** row of the calendar shows the result: the person who is actually paged.

## Overrides

An **override** puts one person on call for a time range, over every layer. Use it when someone swaps a shift or covers for a colleague.

- On a schedule's page, select a shift in the **Final schedule** row, or **Add override**.
- Pick who covers and from when to when. An override can last up to 90 days.
- When two overrides overlap, the one made last wins.

Deleting an override hands the time back to the layers.

## Gaps

A **gap** is a stretch with nobody on call: a restriction leaves it open and no other layer covers it. The on-call list and the schedule's page both name the gaps of the next 14 days.

A chain step that pages a schedule in a gap reaches nobody. Maple writes that on the incident's timeline and moves straight to the chain's next step. See [When a step reaches nobody](/docs/alerting/escalation-chains#when-a-step-reaches-nobody).

## When someone leaves the organization

A person who leaves stays in the rotation until you edit it, but can no longer be paged:

- Their shifts pass to the next person in the rotation order who is still in the organization. When nobody in the layer is, those shifts go uncovered and count as a gap.
- Their overrides are ignored.
- The schedule's page and the on-call list name them, so you can take them out of the layer.

## Calendar feed

A schedule can hand out a private link that calendar apps subscribe to. It shows the schedule's shifts from a week back to 60 days ahead, named after who is on call. Every handoff starts a new event, so a rotation with one person in it still shows a shift per rotation. A long override is one event with its real start and end.

1. Open the schedule and find **Calendar feed** at the bottom of the page.
2. Select **Create calendar link** and copy the link. It is shown once.
3. Add it to your calendar app as a subscription by URL (in most apps: add calendar, from URL).

The link works without signing in, so anyone who has it can read who is on call. Treat it like a password:

- **Replace link** makes a new one. The old link stops working at once, for every calendar subscribed to it.
- **Turn off** ends the feed.

A schedule has one link at a time. Creating a link when one already exists changes nothing: someone has to choose **Replace link**. The API behaves the same way, and replaces only with `replace=true`.

Calendar apps refresh subscriptions on their own schedule, often every few hours, so a changed shift can take a while to show up there. The schedule's page in Maple is always current.

## API and MCP

- The [API](/docs/reference/api) has the schedules under `/v2/alerts/oncall_schedules`, with `/{id}/oncall` (who is on call at an instant), `/{id}/shifts`, `/{id}/overrides` and `/{id}/calendar_feed`.
- The [MCP server](/docs/reference/mcp) has `list_oncall_schedules`, `who_is_on_call` and `manage_oncall_schedule`.

## Related

- [Escalation chains](/docs/alerting/escalation-chains)
- [Alert rules](/docs/alerting/alert-rules)
- [Incidents](/docs/alerting/incidents)
