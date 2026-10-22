# Cancellation reviews

When an org cancels its plan, Maple gathers what that org's own usage looked like around the
cancellation and posts a report to a Slack channel in Maple's workspace.

## Setup

1. Autumn → webhooks: an endpoint on `POST /webhooks/autumn` with `billing.updated`, one per
   region (`api.maple.dev`, `api.eu.maple.dev`). Each instance reports only the orgs it serves.
2. Set on the api Worker: `AUTUMN_WEBHOOK_SECRET` (the endpoint's signing secret),
   `MAPLE_SUPPORT_SLACK_BOT_TOKEN`, and `MAPLE_CANCELLATION_SLACK_CHANNEL_ID`.
3. Invite the support bot to that channel.
4. Optional: `MAPLE_CLERK_DASHBOARD_URL`, the production instance's dashboard URL
   (`https://dashboard.clerk.com/apps/<app>/instances/<ins>`). Without it the report's Clerk links
   open the last-active instance.

Without a channel id nothing is reviewed.

## What triggers one

`billing.updated` with a subscription whose `canceled_at` was just set (cancels at period end),
or one that `expired` (immediate cancel, failed payment). The review then asks Autumn what the
org holds now: an add-on, or a plan that ended while another plan is active, is skipped. A
cancellation is reported once: the `expired` that follows a scheduled cancellation is a no-op,
while cancelling again after keeping the plan is a new review.

The review runs inside the webhook request (`CancellationReviewService`), after the delivery's
plan events are recorded. If Clerk, Autumn, Postgres or Slack does not answer, the route answers
503 and Svix redelivers; the redelivery records those events again, under the same
`webhook_message_id`. If Slack answers
but refuses the post (bot not in the channel, wrong channel id), that is logged as an error and
not retried; a scheduled cancellation is tried once more when the plan expires.

## What it reads

Two 30-day windows ending at the cancellation, `recent` and `prior`. "Last telemetry" looks back
a year, so an org that switched off months ago is not read as one that never started:

| Section  | Source                                                                   |
| -------- | ------------------------------------------------------------------------ |
| plan     | the webhook payload                                                      |
| org      | Clerk (name, age, members), signup contact, support channel              |
| ingest   | billable volume per day (`DailySpendService`)                            |
| visits   | the org's page views in the app (`product_events` under Maple's own org) |
| adoption | counts of dashboards, alert rules, integrations                          |
| billing  | Autumn: the two latest invoices, features past their included allowance  |

A section that cannot be read is `null` and named in the report. Only the region lookup and the
Autumn customer read are required.

The report also links the org in Clerk, Stripe and Autumn, lists its integrations
(`IntegrationInventoryService`) and the other Clerk orgs its members (the first 10) belong to,
each with its plan and links from one Autumn read per org shown. These are shown only, never
stored or used by the rules.

Each snapshot section is one stat in the report; its signal sentences only colour it (red or
green, nothing for neutral). Sentences about a section with no stat, such as a past-due payment,
are listed under the reason.

## How the reason is decided

`signals.ts` turns the snapshot into sentences and one reason, by fixed thresholds that all live
in that file. `fixtures.ts` holds one synthetic org per way of leaving; add a case there when a
real cancellation is read wrongly.

The snapshot, the reason and the post time are kept in `cancellation_reviews`. Once there are real
cancellations whose reasons are known, those rows are what a model's read could be tested against.
