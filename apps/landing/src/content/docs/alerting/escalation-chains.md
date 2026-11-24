---
title: "Escalation chains"
description: "Page people step by step until someone acknowledges: what a step can page, how waits and repeats work, what acknowledging and resolving do, and what happens when a step reaches nobody."
group: "Alerting"
order: 4.6
---

An **escalation chain** pages one step at a time and waits for an acknowledgement before it moves on. A rule that should wake someone up uses a chain. A rule that only needs to land in a channel uses plain [destinations](/docs/alerting/notification-destinations).

Chains live under **Alerts → Routing**. Org admins and engineers can create and change them.

## Create a chain

1. Open **Alerts → Routing** and select **New chain** (**Create chain** while there are none).
2. Add a step and pick who it pages.
3. Set how many **minutes for an acknowledgement** the step waits before the next one.
4. Add more steps, and turn on **If nobody acknowledges, repeat the chain** if it should start over.
5. Select **Create chain**, then pick the chain on a rule under **Notify → Escalation chain**. See [Alert rules](/docs/alerting/alert-rules#notify).

A chain can have up to 10 steps, each with up to 10 targets and a wait of up to 24 hours. It can repeat up to 5 times.

### What a step can page

| Target      | Who is paged                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Destination | A [notification destination](/docs/alerting/notification-destinations): a channel, PagerDuty, a webhook.      |
| Person      | One member: by email, by a push to their phones if they use the Maple app, and by direct message in a chat workspace they have linked their account in. |
| Schedule    | Whoever an [on-call schedule](/docs/alerting/on-call-schedules) says is on call when the step comes up.        |

Who is on call is read when the step fires, not when the chain was saved or the incident opened.

## How a chain runs

When a rule's incident opens at a severity that names a chain, the chain's first step pages at once. Each later step pages when the step before it has waited its minutes without an acknowledgement.

| What happens                         | What the chain does                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Someone **acknowledges** the incident | It pauses. No further step pages while the incident stays acknowledged.                 |
| The incident is **unacknowledged**    | It resumes from the step it was on.                                                     |
| The incident **resolves**             | It ends, whether it resolved by itself or by hand.                                      |
| The last step's wait runs out         | It starts over if repeats are left, and ends otherwise.                                 |
| A **silence** covers the incident     | A step that falls due is held and pages when the silence ends.                          |

The incident's page shows the chain's position, and the timeline lists every page it sent and to whom.

### Severity and chains

Each severity tier of a rule can name its own chain.

- An incident that goes from warning to critical clears the acknowledgement and pages again. If the critical tier names a chain, that chain starts. If it does not, the warning tier's chain carries on with the critical alert.
- An incident that drops back to warning stops the critical tier's chain. A chain that belongs to the warning tier keeps running, and its next step pages about the warning that is left.

## When a step reaches nobody

A step reaches nobody when its schedule has a gap, its people have left the organization, or its destinations are switched off. Maple then:

1. Does not count the step as sent, and writes it on the incident's timeline: **Nobody on call on** and the schedule's name, or **An escalation step reached nobody** when no schedule was involved.
2. Moves straight to the next step of the pass, without waiting.
3. Emails the organization's admins when a whole pass ends without reaching anybody. The subject starts with "Nobody on call was reached".

Fix the cause from the timeline entry: add a layer or an override to the schedule, take people who left out of the chain, or switch the destination back on.

## Deleting

A chain cannot be deleted while a rule's tier names it. A schedule cannot be deleted while a chain pages it, or while a running escalation on an open incident still has a step ahead that pages it.

## API and MCP

- The [API](/docs/reference/api) has chains under `/v2/alerts/escalation_chains`. An incident's `escalation` field holds its latest run: the chain, the step it is on and when the next one is due.
- The [MCP server](/docs/reference/mcp) has `list_escalation_chains` and `manage_escalation_chain`.

## Related

- [On-call schedules](/docs/alerting/on-call-schedules)
- [Incidents](/docs/alerting/incidents)
- [Notification destinations](/docs/alerting/notification-destinations)
