# Cancellation reviews

When an org cancels its plan, Maple gathers what that org's own usage looked like around the
cancellation and posts a report to a Slack channel in Maple's workspace.

## Setup

1. Autumn → webhooks: an endpoint on `POST /webhooks/autumn` with `billing.updated`, one per
   region (`api.maple.dev`, `api.eu.maple.dev`). Each instance reports only the orgs it serves.
2. Set on the api Worker: `AUTUMN_WEBHOOK_SECRET` (the endpoint's signing secret),
   `MAPLE_SUPPORT_SLACK_BOT_TOKEN`, and `MAPLE_CANCELLATION_SLACK_CHANNEL_ID`.
3. Invite the support bot to that channel.

Without a channel id or bot token the consumer does nothing.

## What triggers one

`billing.updated` with a subscription whose `canceled_at` was just set (cancels at period end),
or one that `expired` without another plan starting in the same delivery (immediate cancel,
failed payment). Add-ons, the free tier and plan switches are skipped. A subscription is
reported once: the `expired` that follows a scheduled cancellation is a no-op.

## What it reads

Two 30-day windows ending at the cancellation, `recent` and `prior`:

| Section  | Source                                                                    |
| -------- | ------------------------------------------------------------------------- |
| plan     | the webhook payload                                                       |
| org      | Clerk (name, age, members), onboarding state, support channel             |
| ingest   | billable volume per day (`DailySpendService`)                             |
| visits   | the org's page views in the app (`product_events` under Maple's own org)  |
| adoption | counts of dashboards, alert rules, destinations, API keys, integrations   |
| billing  | Autumn: the two latest invoices, features past their included allowance   |

A section that cannot be read is `null` and named in the report. Only the Autumn customer read is
required; without it the job is retried.

## How the reason is decided

- `signals.ts` turns the snapshot into sentences and one reason by fixed thresholds. This is the
  report's "Likely reason" and always present.
- The decision model (`apps/ai/src/cancellation/assess.ts`) reads the same snapshot plus those
  sentences and answers the same question, with a probability, and how likely a personal note is
  to win the org back. The report shows it beside the rule's answer and marks a disagreement.

The rules settle the clear cases. The model is there for the ones thresholds miss, such as visits
fading but not yet past the cut-off. Both are judged on the shared cases in `fixtures.ts`; add a
case there when a real cancellation is read wrongly.

The snapshot, both answers and the post time are kept in `cancellation_reviews`.
