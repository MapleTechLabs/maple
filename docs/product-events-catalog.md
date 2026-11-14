# Maple's own product events: catalog

What Maple records about its own users in the dogfood org's `product_events` table, so per-customer
usage (active users, feature adoption, churn signals) can be read straight from it. How the table and
its feeds work is in `product-events-funnels.md`; this page is only the vocabulary.

## Identity

The customer is a Clerk organization, a contact is a Clerk user.

- `GroupId` = Clerk org id (`org_…`), `UserId` = Clerk user id (`user_…`).
- **Browser** (`app.maple.dev`): `identify()` runs on every Clerk snapshot whose identity changed
  (`apps/web/src/update.ts`, `appliedClerkSnapshot`), so a sign-in and an org switch both re-identify.
  Every later session row, page view and `track()` event carries the user and the active org.
  Traits on the session: `email`, `username` (full name), `groupName` (org name), `role` (Clerk role
  key, e.g. `org:admin`) and `plan` (Autumn plan id), the last two once known.
- **Server** (`POST /v1/events`, `ProductEventsService`): every emit passes `userId` / `groupId`
  from the request or webhook payload. Billing webhooks know only the org (`GroupId` set, `UserId`
  empty).
- **Trace-derived** (`Source = 'trace'`): a Maple span carrying `maple.product_event.*`
  (`productEventSpanAttributes` in `packages/domain/src/tinybird/product-event-attributes.ts`)
  projects into the table with the tenant's user and org. Its `Attributes` are only the props
  listed below, never the span's other attributes.
- **iOS** (`apps/ios`): events reach the table without `UserId` / `GroupId`; the Swift SDK
  (`maple-swift` 0.3.3) does not stamp identity on session event rows. Exclude or treat as
  anonymous until it does.
- **Landing** (`maple.dev`): anonymous marketing events (`VisitorId` only). Not customer usage.

Attributes never carry PII beyond these ids, nor names, free text, query contents or secrets.

## Active users and feature usage

Use the identified `$pageview` rows on the app host (`Kind = 'navigation'`, `Host = 'app.maple.dev'`):
about 95% carry `UserId` and `GroupId`. `PagePath` is the feature area: `/traces`, `/traces/:id`,
`/logs`, `/metrics`, `/dashboards/:id`, `/alerts`, `/errors`, `/infra`, `/agent-sessions`,
`/status-pages`, `/settings`, … There are deliberately no `*_viewed` events duplicating them.

## Events

`source`: where the event is emitted. `web` = `trackProduct()` in `apps/web` (`ProductEvent` union in
`apps/web/src/data/product-events.ts`), `server` = `ProductEventsService.track` in `apps/api`
(`ProductEventName`), `trace` = a span in `apps/api` / `apps/ai`.

### Account and team

| Event              | Source | Fires when                                                                   | Attributes                                                      | Identity   |
| ------------------ | ------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| `signup_completed` | server | Clerk `user.created` webhook                                                 | `sign_up_source` (`email`, `google`, `github`…), `email_domain` | user       |
| `member_joined`    | server | Clerk `organizationMembership.created` webhook                               | `role`                                                          | user + org |
| `member_removed`   | server | Clerk `organizationMembership.deleted`, after the revocation sweep succeeded | `role` (when sent)                                              | user + org |
| `member_invited`   | web    | An invite is sent from Settings › Members or the onboarding team step        | `role`                                                          | user + org |

### Onboarding

| Event                       | Source | Fires when                                                                                                              | Attributes                     | Identity   |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| `onboarding_step_completed` | web    | Continue on a quick-start step                                                                                          | `step`                         | user + org |
| `onboarding_reward_claimed` | web    | Org admin redeems the onboarding-checklist credit                                                                       | (none)                         | user + org |
| `first_data_received`       | web    | The quick-start connect step's presence poll sees the org's first signal arrive (not data already there when it opened) | `signal` (`traces`, `logs`, …) | user + org |

### Product usage

| Event                         | Source | Fires when                                                                           | Attributes                                                               | Identity   |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------- |
| `dashboard_created`           | web    | A dashboard is created (blank, template, import, duplicate, "add to dashboard")      | `widgets` (count)                                                        | user + org |
| `alert_rule_created`          | web    | An alert rule save lands                                                             | `signal`                                                                 | user + org |
| `integration_connected`       | web    | An integration's connect callback succeeds                                           | `provider`                                                               | user + org |
| `api_key_created`             | web    | An API key is created                                                                | `kind` (`standard`/`mcp`), `access`                                      | user + org |
| `investigation_started`       | trace  | An AI investigation is created and claimed (web, API or MCP), `apps/api`             | `subject_type`                                                           | user + org |
| `mcp_tool_called`             | trace  | Every tool call on the public MCP server, `apps/ai`                                  | `tool`, `source` (`mcp`), `client` (MCP client name, e.g. `claude-code`) | user + org |
| `integration_disconnected`    | web    | An integration (incl. AWS, GCP, chat workspaces) is disconnected                     | `provider`                                                               | user + org |
| `alert_incident_acknowledged` | web    | An incident is acknowledged from the alerts inbox or incident page                   | (none)                                                                   | user + org |
| `uptime_monitor_created`      | web    | An uptime monitor is created (form, or from a URL in the status-page builder/editor) | `kind`                                                                   | user + org |
| `slo_created`                 | web    | An SLO is created                                                                    | (none)                                                                   | user + org |
| `status_page_created`         | web    | A status page is created (draft or published)                                        | (none)                                                                   | user + org |

`mcp_tool_called` is the AI-usage signal and the only per-call event (about 12k a day across all orgs
in November 2026). MCP tools that create things (`create_dashboard`, `create_alert_rule`, …) show up here under
`tool`, not as `*_created`; the `*_created` events above are the web UI's.

### Billing

| Event                         | Source | Fires when                                                                | Attributes                                                 | Identity                 |
| ----------------------------- | ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `plan_checkout_started`       | web    | Right before the Stripe redirect                                          | `plan_id`                                                  | user + org               |
| `plan_checkout_returned`      | web    | Buyer back from Stripe                                                    | `confirmed`                                                | user + org               |
| `plan_started`                | server | Autumn `billing.updated` (activated), or inline `attach` with no redirect | `plan_id`, `trigger` (`webhook`/`attach`), `kind`, `trial` | org (+ user on `attach`) |
| `plan_changed`                | server | Autumn `billing.updated` (updated)                                        | `plan_id`, `trigger`, `kind`                               | org                      |
| `plan_cancelled`              | server | Autumn `billing.updated` (expired)                                        | `plan_id`, `trigger`, `kind`                               | org                      |
| `support_channel_invite_sent` | web    | A member asks for a Slack Connect invite to the support channel           | (none)                                                     | user + org               |

Webhook plan events set `GroupId` to the Autumn customer id, which is the paying org's Clerk id. An
org billed through another org (`billing-orgs.md`) has its plan events under that billing org.

## Not covered

- **The Clerk webhook is not delivering in production** (no `ClerkWebhook.receive` span from
  2026-11-03 to 2026-11-10, and no `signup_completed` row ever). Until `POST /webhooks/clerk` is
  registered in Clerk for `user.created` and `organizationMembership.created/updated/deleted`,
  `signup_completed`, `member_joined` and `member_removed` stay empty (and the membership revocation
  sweep does not run).
- **Daily ingest volume per org.** Not a product event: it lives in billing usage
  (`DailySpendService`), and there is no per-org daily hook to emit it from without a new job.
- **iOS identity**, see above.
- Explorer queries are not events (they run on every filter change); use page views.

## Historical duplicates

Before `ProductEvents.track` stopped carrying `maple.product_event.name` on its own span, every
server event (`signup_completed`, `plan_*`) was also projected as an unidentified `Source = 'trace'`
row. To read history, drop those rows:

```sql
NOT (Source = 'trace' AND ServiceName = 'maple-api' AND GroupId = ''
     AND EventName IN ('signup_completed', 'plan_started', 'plan_changed', 'plan_cancelled'))
```

## Adding an event

1. Name it `object_action`, snake_case, and add it to the union it is emitted from
   (`ProductEvent` in `apps/web/src/data/product-events.ts`, `ProductEventName` in `ProductEventsService.ts`,
   or `productEventSpanAttributes` on a span that already exists).
2. Fire it once, when the action succeeded. Low-cardinality attributes only.
3. Add it to this page.
