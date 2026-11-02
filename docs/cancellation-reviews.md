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

5. For the Stripe survey, plan history and failed charges: `STRIPE_SECRET_KEY` needs Customers,
   Tax IDs, Subscriptions and Charges read. Without one, the part it feeds is left out.

Without a channel id nothing is reviewed.

## What triggers one

`billing.updated` with a subscription whose `canceled_at` was just set (cancels at period end),
or one that `expired` (immediate cancel, failed payment). The review then asks Autumn what the
org holds now: an add-on, or a plan that ended while another plan is active, is skipped. A
cancellation is reported once: the `expired` that follows a scheduled cancellation is a no-op,
while cancelling again after keeping the plan is a new review.

The webhook records the delivery's plan events, then queues each cancellation on the
`cancellation-reviews` Cloudflare Queue and answers 200. If the queue refuses it, the route
answers 503 and Svix redelivers; the redelivery records those events again, under the same
`webhook_message_id`.

The api Worker's queue consumer runs the review (`CancellationReviewService`), one message at a
time, under its own service name `maple-cancellation-reviews`. If Clerk, Autumn, Postgres or Slack
does not answer, the message is retried after 1, 2, 4, 8 and 16 minutes; a review still failing
after that is logged as an error and dropped. If Slack answers but refuses the post (bot not in
the channel, wrong channel id), that is logged as an error and not retried; a scheduled
cancellation is tried once more when the plan expires. A cancellation queued or delivered twice is
reported once: the review claims its row in `cancellation_reviews` before it gathers the report. The one
exception is a Slack post that times out (30 s) but lands anyway: its retry, five minutes later,
posts the report a second time.

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

The report's Sessions button opens Maple's own replays page filtered to the org's id, from 30 days
before the cancellation to an hour after it. It shows them only when you are signed in to the org
the app reports its own usage to (the product-events key's org).

## How the reason is decided

`signals.ts` turns the snapshot into sentences and one reason, by fixed thresholds that all live
in that file. `fixtures.ts` holds one synthetic org per way of leaving; add a case there when a
real cancellation is read wrongly.

The snapshot, the reason and the post time are kept in `cancellation_reviews`. Once there are real
cancellations whose reasons are known, those rows are what a model's read could be tested against.

## The model's read

After the rules, maple-ai reads the snapshot with everything the rules cannot see
(`POST /internal/cancellation-review/read` over the `AI_WORKER` binding, `INTERNAL_SERVICE_TOKEN`).
Each section has its own reader, and each part of a section is `null` on its own when it fails:

| Section        | Reader                  | What                                                                                                                                                 |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| stripeFeedback | `evidence.ts`           | Stripe's survey answer and comment for this cancellation (never an earlier one's)                                                                    |
| sessions       | `evidence.ts`           | the last 20 browser sessions in Maple's app, the 5 newest with last pages and errors                                                                 |
| auditLog       | `evidence.ts`           | the last 40 changes; reads and tool calls are filtered out in the query                                                                              |
| company        | `evidence-company.ts`   | org and billing name, country and tax id types, company email domains, homepage, people                                                              |
| billing        | `evidence-billing.ts`   | the subscription's trial, price, discount and Stripe reason; other subscriptions; invoices; charges; spend controls                                  |
| app            | `evidence-app.ts`       | integration health, onboarding, alerts, anomalies, investigations, error issues, agent feedback, earlier cancellations, scrape targets, keys, digest |
| telemetry      | `evidence-telemetry.ts` | per-service volume, environment and SDK, alert checks, error volume, product events, audit activity and tool calls by actor                          |

Every window ends at the cancellation (an hour later at most): a review that runs late never reads
what happened after. Times are whole days before the cancellation.

What reaches the model is counts, statuses and error classes. Free text (agent feedback, error
messages) is cut and has addresses, links and long tokens taken out first. A personal org or billing
name (one holding a member's name) is replaced by a flag. Free-mail domains are only counted. The
homepage of the members' company domain is read (title and meta description only, 5 s, HTML only,
public hosts only) so the model can say who the customer is.

The model answers with:

- `company`: its best guess at who the customer is, a one-liner and a confidence; `null` with
  nothing to go on. Shown under the links.
- `findings`: at most three facts that are unusual for this customer and bear on why it left, with
  no interpretation. Often none. Shown as "What stands out".
- `verdict`: `agree` with the rules' reason or `override` it, with a `category` label stored for
  counting; an override's reason leads the report, the rules' stays beside it.
- `conclusion`: its opinion, shown last as "Model's read".

The prompt lists what is normal for most customers and is not a finding (one member, few dashboards,
no alerts, unset environment), so the model does not report the same numbers for everyone.
Sections are read four at a time, each given 30 s, and the model 60 s; whatever does not answer is
left out and named under "Could not read". The answer is kept in `cancellation_reviews.model_read`.
