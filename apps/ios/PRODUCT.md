# Maple for iOS — what the app is for

The phone is not a smaller dashboard. It answers three questions, in this
order, and nothing else earns a tab:

1. **Is anything wrong right now?** — one glance, no scrolling.
2. **Why is it going off?** — enough context to decide "page someone / wait /
   it's known" without opening a laptop.
3. **Tell me when it happens.** — push, with the same context, deep-linked.

Everything the web app does that isn't in service of those (dashboards, query
building, replay, settings) stays on the web.

## Information architecture

Three tabs + a profile sheet. The current Services/Issues split goes away.

```
Home        Services        Alerts                 (profile sheet: org switch,
                                                    notifications, sign out)
```

### Home — "the pulse"

Everything above the fold answers question 1.

- **Status headline.** Derived on-device, no new endpoint:
  `All 14 services healthy` · `2 degraded, 1 critical alert` · `No data in
the last hour` (liveness — an org that stopped sending is _not_ healthy).
  Colour follows the worst thing on screen; amber primary used here and only
  here.
- **Your shift**, when the organization has on-call schedules: a compact card
  under the headline. `On call now · Platform primary · until Mon 09:00 · hands
  off to Priya Shah`, or `Next shift` with when and on which schedule. A shift
  with no end in sight reads `no handoff scheduled` and draws no progress. It has
  its own read (`getOnCallOverview`) beside the board's, so it never delays the
  board, and a failed read shows no card. Tap → On call.
- **Open incidents**, critical first, each a card: rule name · service(s) ·
  `observed vs threshold` in the rule's unit · how long open · a 1h sparkline
  of the signal. Tap → Incident detail. Empty state is a real sentence, not
  a placeholder.
- **Services needing attention**: services whose health isn't `healthy`,
  sorted worst-first (health-dot · name · error rate · p95). "All healthy"
  collapses this to a single line. Tap → Service detail. "See all" → Services
  tab.
- **New in the last 24h**: count of new/regressed error issues and anomalies,
  each a row that opens the Alerts tab pre-filtered.
- Pull-to-refresh; auto-refresh every 60s while foregrounded.

Time window is fixed to _now_ (1h for rates, 24h for "new"). Home has no time
picker — a time picker is a question-2 tool.

### Services

The existing list, kept: health-dot, name, throughput, error rate, p95,
sorted worst-first. Time window picker (1h · 6h · 24h · 7d) lives here.

**Service detail** leads with the verdict and the sentence that justifies it
(`Degraded — p95 410ms is 3.4× its 7-day baseline of 120ms`), then one
full-width chart with a Throughput · Errors · Latency switch. The big number
is the _latest settled bucket_ — what the service is doing now — with the
window's peak and average as small print, because an average over a day is
not the question anyone opens this screen with. Scrubbing the chart swaps the
number for the bucket under the finger. Under it: window aggregates, open
incidents scoped to this service, the busiest operations re-rankable by
failures / p95 / volume, and this service's issues. Everything the screen
paints from is one read, `GET /v2/services/{name}/overview`; alerts and
issues land in a second pass. No trace waterfall on the phone — link out to
the web for that.

### Alerts

The triage hub. Segmented control at the top: **Incidents · Errors ·
Anomalies**. Default segment is whichever has open items, incidents first.

- Incidents: open then resolved; severity badge, service, duration,
  observed/threshold, and who has it. Incidents that paged you
  (`listAlertIncidents?paged=me`) lead in their own section and carry
  Acknowledge on the row. Filter chips: open · paged to you · all.
- Errors: the current Issues list, unchanged in content, restyled as rows
  (title · service · count · last seen · sparkline).
- Anomalies: `GET /v2/anomalies/incidents`, same row shape.

**Incident detail** — the "why" screen. Top to bottom:

1. Headline: `Checkout error rate · 9.0% > 5.0% · open 32 min · critical`.
2. **What the rule saw**: the check history for this rule/group
   (`GET /v2/alerts/rules/{id}/checks`) rendered as a bar/line of observed
   values with the threshold line. This works for _every_ signal type
   including builder/raw queries, because it's the rule's own observations,
   not a re-query.
3. **What changed on the service** (only for the five service signals): the
   affected service's error-rate / p95 / throughput timeseries around the
   incident window, from `/v2/traces/timeseries`. This is where a latency
   alert shows "throughput also spiked" or "errors did too".
4. **Likely cause**: linked error issue if `error_issue_id` is set; otherwise
   top error issues for the service in the window (`GET /v2/error_issues`
   filtered by service, sorted by first-seen desc). Top failing operations
   from a breakdown by span name.
5. **Timeline**: trigger / renotify / resolve events and where they went
   (`GET /v2/alerts/deliveries?incident_id=`).
6. Actions: **Open on web** (deep link into the same incident), **Share**
   (link + headline). Mute-rule is a later addition once we decide it
   belongs on the phone.

An open incident is also answered here. A card under the headline says who
has it: nobody yet, with who the next escalation step pages and a countdown to
it, or the person who acknowledged and how long that took. A bar where the tab
bar would be holds the one thing to do next: **Acknowledge**, then **Resolve**
(confirmed, with the web's wording), with the other of the two and
**Unacknowledge** under its menu. These are the v2 `acknowledgeAlertIncident`,
`unacknowledgeAlertIncident` and `resolveAlertIncident` operations the web
incident page calls, and they need `incidents:respond`.

**Error issue detail** stays roughly as-is: title, message, service, first/
last seen, occurrence sparkline, stack, linked incidents. Actions: open on
web, share.

### On call

Pushed from the Overview shift card, read-only, and drawn from one document:
`GET /v2/alerts/oncall_overview`.

- **On call**: a line saying where you stand (`You are on call · 3d 6h left on
  Platform primary`, or off call with the next shift), then **Your shifts**
  (the current one marked Now, the rest with `in 6 days` and their dates),
  **On call now** (one row per schedule: schedule, who, until, with `Nobody` in
  the warning colour) and **Coverage gaps** when there are any. An organization
  with no schedules gets a sentence saying they are set up on the web.
  Someone still on call where the document stops (`continues`) is never given
  that cut as an end: the line reads `no handoff scheduled`, the Until column
  `No handoff`, a shift row `no end scheduled`, and nothing counts down.
- **Schedule**: the rotation in one line with its time zone, who is on call now
  and who they hand off to, **Who covers** the next 14 days as one lane per
  person (overrides outlined, uncovered stretches in a lane of their own),
  the **Upcoming** handoffs and the schedule's gaps. A rotation of one reads
  `No handoff in the next 14 days`. It takes the overview the On call screen
  already holds, when that was read for the same person and organization, and
  reloads through the same read.

Times are shown in the device's time zone. Creating overrides and editing
layers stay on the web.

### Profile sheet

Org switcher (existing), **Notifications** (per-org toggles: critical
incidents · warning incidents · resolved · new error issues · anomalies), sign
out. Nothing else.

## Health model

Reuse the thresholds already ported into `Primitives.swift` from
`service-health.ts` / `latency-tone.ts` — the phone must agree with the
browser about what "degraded" means. Latency is judged against the service's
own trailing-7d p95, which `listServices` returns as
`baseline_p95_latency_ms`; the absolute 1s/3s breaks are only the fallback for
a service with no usable history, because on their own they call every
slow-by-design worker degraded forever. Home's headline is `max` over per-service
health, then bumped to critical if any open incident is critical, then to
"no data" if `throughput == 0` across the org for the last hour.

## API surface

Reads needed, all in v2 already:

| Screen   | Operations                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home     | `listServices` (1h), `listAlertIncidents?status=open`, `listErrorIssues` (24h, sort first_seen), `listAnomalyIncidents`, `queryTraceTimeseries` for sparklines                                                           |
| Services | `listServices`, `getService`, `queryTraceTimeseries`, `queryTraceBreakdown`, `listAlertIncidents`, `listErrorIssues`                                                                                                     |
| Alerts   | `listAlertIncidents`, `getAlertIncident`, `getAlertRule`, `listAlertRuleChecks`, `listAlertDeliveries`, `listErrorIssues`, `getErrorIssue`, `listAnomalyIncidents`, `getAnomalyIncident`, `getAnomalyIncidentTimeseries` |
| On call  | `getOnCallOverview` (also read by Home for the shift card)                                                                                                                                                               |

Every screen also calls `listEnvironments` once per organization, to populate
the deployment-environment control that sits beside the organization switcher on
all three tab roots. Both controls hide themselves when there is nothing to
switch to. See "The environment axis" in the README for which reads the
selection reaches and which it does not.

Add these `operationId`s to `IOS_OPERATIONS` in `scripts/generate-ios-openapi.ts`.
Sparkline queries: batch per screen, 1h/24 buckets, `p95_duration` and
`error_rate` aggregations — cheap, and the API is already cost-profiled.

Gaps to fill on the API side (small):

- `listAlertIncidents` filtered by service name — today filter is `rule_id`/
  `status`. Either add `service_name` or the app joins client-side via the
  rule's `service_names` (fine for the first version; org rule counts are
  small).
- Error issue **occurrence timeseries** isn't in v2 (`events` is deferred).
  Sparklines on issue rows can wait, or use `/v2/traces/timeseries` filtered
  by `status = Error` + service as a proxy.

## Push notifications

### Product

Notify on: incident **triggered** (critical → time-sensitive interruption
level; warning → active), incident **resolved** (quiet), **new** error issue,
**regressed** error issue, anomaly opened. Per-org, per-user toggles in the
profile sheet. Ask for permission the first time the user opens an incident
or flips a toggle — never at launch.

Payload = the Home card: `Checkout error rate — 9.0% > 5.0% on checkout-api`,
subtitle with severity + duration, thread by `dedupe_key` so renotifies
collapse, deep link `maple://incidents/{id}` (universal link
`https://app.maple.dev/…` so it also works with the app absent). Later:
a Live Activity on the Lock Screen while a critical incident is open.

### Status (2026-08-17)

Shipped: `mobile_devices` table + `/v2/mobile_devices`, `ApnsClient`
(ES256 JWT, HTTP/2 via Workers `fetch` — verified working in production
Workers; local `workerd` speaks HTTP/1.1 and can't reach APNs), fan-out from
`AlertsService.queueIncidentNotifications` for trigger / renotify / resolve,
the iOS registrar + settings sheet + notification-tap deep link. Not yet:
issue and anomaly pushes (toggles exist, greyed by copy), Live Activity,
delivery rows in the incident timeline.

### Backend shape

Alert destinations are **org-scoped** (Slack channel, PagerDuty…); push is
**user-scoped**. Don't model a phone as a destination. Instead:

- `mobile_devices` table: `user_id`, `org_id`, `platform`, `token`,
  `environment` (sandbox/prod), `preferences` (the toggles), `last_seen_at`.
  Register/refresh via `PUT /v2/me/devices/{token}`, delete on sign-out /
  APNs feedback.
- A `pushFanOut` step in `NotificationDispatcher` (the same shared path error
  issues and incidents already use), keyed off the event type — independent
  of which rule destinations exist, so a rule with zero destinations still
  reaches phones. Filter by device preferences, dedupe by
  `(dedupe_key, event_type)`.
- Transport: **APNs requires HTTP/2**, which the Workers `fetch` API doesn't
  guarantee to origins. Verify before committing to direct APNs from
  `apps/alerting`; if it fails, relay through FCM (HTTP v1 works over
  HTTP/1.1, and covers Android later) or run the sender where HTTP/2 egress
  is available (the ingest gateway's host). Decide this first — it's the only
  real unknown in the plan.
- Deliveries table already records attempts per destination; record push
  sends there too (destination type `mobile`) so the incident timeline shows
  "notified 3 devices".

## Sequencing

1. Home + Alerts (incidents) + incident detail. Requires only new
   `IOS_OPERATIONS`. This is the app.
2. Service detail expansion, anomalies segment.
3. Push: transport spike → devices endpoint → fan-out → iOS registration
   and settings sheet.
4. Live Activity, follow-a-service, mute-rule — only after 1–3 are in
   people's hands.

## Design

`DESIGN.md` conventions hold (Geist Mono body, hairlines, tonal depth, one
amber per screen, skeletons not spinners). Home is the screen that has to be
beautiful; the rest can be dense. Sparklines are 1px lines with no axes; the
threshold on incident charts is a dashed hairline. Health colours come from
`Tokens.swift`, never ad hoc.
