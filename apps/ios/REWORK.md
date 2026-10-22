# Maple for iOS: the rework

`PRODUCT.md` shipped: Home, Services and Alerts answer "is anything wrong, why,
tell me". This rework keeps those three questions and adds a fourth the phone
can't answer today: **"let me check it myself."** Someone paged at dinner
should be able to find the failing trace, read the log line and resolve the
issue without opening a laptop.

It also makes the app read as the same product as the web dashboard. Today it
borrows the tokens but not the shapes: the web leads with stat tiles, a
P50/P95/P99 table and a Monitor / Analyze / Triage sidebar, the phone with a
headline and loose rows. A user moving between the two should recognise every
screen.

Designs: Wonder, file "Maple Design System", page "iOS Rework".

## What changes

### 1. Navigation mirrors the web sidebar

```
Overview    Services    Triage    Explore    (search tab)
```

| Web sidebar group                 | iOS                                                  |
| --------------------------------- | ---------------------------------------------------- |
| Overview                          | **Overview** tab (today's Home, renamed to match)    |
| Monitor: Services, Infrastructure | **Services** tab, Infrastructure as a segment        |
| Triage: Errors, Alerts            | **Triage** tab, segments Errors · Alerts · Anomalies |
| Analyze: Explore, Dashboards      | **Explore** tab: Traces · Logs · Dashboards          |
| Search (Cmd K)                    | iOS 26 search tab: services, issues, trace ids       |

The org switcher and environment picker stay in the nav bar of every tab
root, the way the web keeps them in the sidebar header. Profile sheet is
unchanged.

### 2. Shared shapes ported from the web

Build these once in `Components/` and use them everywhere, so a phone screen
and its web counterpart share a vocabulary:

- **StatTile**: uppercase label, big mono value, delta line `+6.2% vs previous
  hour` (green good, red bad). Two per row. Overview, Service detail, Error
  detail and Dashboards all lead with a row of them.
- **PercentileTriplet**: `p50 24ms · p95 118ms · p99 402ms` in the chart
  palette (blue / amber / red), the same colours as the web services table.
  Replaces the single grey p95 on service rows.
- **ServiceSwatch**: the web's 8px rounded square from `ServiceColor`, not a
  circle. Health stays a separate dot at the end of the row.
- **TableCard**: hairline-bordered card with an uppercase header row and
  hairline row dividers, the web table at phone width (name + two numbers).
- **SegmentedTabs**: underline tabs like the web's `Overview · Setup ·
  Settings`, not the system segmented control.

Amber stays once per screen (the primary action or the status headline).

### 3. New capabilities

In priority order. Each is a v2 read that already exists unless noted.

1. **Error triage actions.** Resolve, ignore, claim / assign, severity, from the
   issue detail and as row swipes. Today the phone can only look. Endpoints:
   the v2 error issue transition / claim operations the MCP tools already use.
2. **Trace detail.** Reverses PRODUCT.md's "no waterfall on the phone": a
   vertical waterfall where each span is a full-width row (service swatch,
   name, duration bar indented by depth) and tapping a span opens its
   attributes, events and logs. Reached from issue sample traces, incident
   "likely cause", and Explore.
3. **Explore: traces and logs.** A query bar with chips (service, status,
   duration > x, attribute = y) and a time window, results as a list. Logs show
   severity colour strip, timestamp, service, body; tap to expand attributes and
   jump to the trace.
4. **Dashboards, read-only.** The org's dashboards list (pinned first), each
   rendered as a single column of widgets: stat tiles two-up, charts
   full-width, tables as TableCards. No editing on the phone.
5. **Service detail parity.** Header stats with deltas, a Throughput / Errors /
   Latency chart with p50/p95/p99 lines (not p95 only), operations table, and
   new segments for Errors, Deployments (`service_deployments`) and
   Infrastructure (hosts / containers backing the service).
6. **Ask Maple.** A button on incident and issue detail that starts a chat
   seeded with that context (`apps/ai` chat endpoint). The answer streams into
   a sheet; "Open on web" continues it.
7. **Alert rule mute.** Mute a rule for 1h / 4h / until resolved from the
   incident screen. Needs a v2 mute endpoint (gap).

### 4. Out of scope

Dashboard and alert rule editing, query builder, session replay, service map,
code review, settings beyond the profile sheet. Those stay on the web, with an
"Open on web" link where a screen would otherwise dead-end.

## API surface additions

Add to `IOS_OPERATIONS` in `scripts/generate-ios-openapi.ts`:

| Feature        | Operations                                                     |
| -------------- | -------------------------------------------------------------- |
| Triage actions | error issue transition, claim, release, set severity           |
| Trace detail   | get trace (spans), span logs                                   |
| Explore        | search traces, search logs, attribute keys / values for chips  |
| Dashboards     | list dashboards, get dashboard, widget query evaluate          |
| Service parity | service deployments, infra list filtered by service            |
| Ask Maple      | chat create / stream (through `apps/api` forward to `apps/ai`) |

Gaps: rule mute (new endpoint), widget evaluation for mobile (confirm the
existing evaluate endpoint is v2-exposed), error issue occurrence timeseries
(still deferred, see PRODUCT.md).

## Sequencing

1. Shared shapes (StatTile, PercentileTriplet, ServiceSwatch, TableCard,
   SegmentedTabs) and restyle the existing Overview / Services / Alerts on them.
   Nothing new to fetch, and it is most of the "aligned with the dashboard" win.
2. Tab restructure: Triage (Errors + Alerts + Anomalies), Explore placeholder.
3. Error triage actions.
4. Trace detail, then Explore traces and logs.
5. Dashboards read-only.
6. Service detail segments, Ask Maple, rule mute.

## Screens designed

| Screen          | Covers                                                  |
| --------------- | ------------------------------------------------------- |
| Overview        | Stat tiles, open alerts, needs attention as a TableCard |
| Services        | Swatch + percentile triplet rows, window picker         |
| Service detail  | Header stats, p50/p95/p99 chart, operations, segments   |
| Triage: Errors  | Segments, issue rows, swipe actions                     |
| Error detail    | Stats, stack, sample traces, resolve / assign bar       |
| Incident detail | Rule chart with threshold, likely cause, Ask Maple      |
| Explore: Logs   | Query chips, log rows                                   |
| Trace detail    | Vertical waterfall                                      |
| Dashboard       | Single-column widgets                                   |

## Status (2026-10-20, branch `feat/ios-rework`)

Built:

- Shared shapes in `DesignSystem/DashboardShapes.swift` (UnderlineTabs,
  PercentileTriplet, TableCard, StatDelta); `StatTile` takes a delta.
- Overview stat tiles with "vs previous hour", which is the same `listServices`
  query over `ResolvedTimeWindow.previous`. Needs attention as a TableCard.
- Services rows carry p50 / p95 / p99.
- Tabs: Overview, Services, Triage (Errors · Alerts · Anomalies), Explore
  (Traces · Logs · Dashboards).
- Triage actions on issue detail (Resolve / Reopen, Claim / Release, Ignore,
  severity) and as a long-press menu on issue rows.
- Trace detail: vertical waterfall, span sheet with attributes, resource and
  the span's logs. Reached from Explore, log rows and issue sample traces.
- Explore Traces and Logs with window, service and errors / slow / level chips.
- Dashboards, read-only: list, then each board as one column. Widget data
  comes from `POST /v2/dashboards/{id}/widget_data`, which runs the same
  `DashboardWidgetDataService.resolveBatch` as the web board and share links.
  `WidgetData` ports the web's `toReadyData` transform so stat tiles match.

New v2 operations: `transitionErrorIssue`, `claimErrorIssue`,
`releaseErrorIssue`, `setErrorIssueSeverity`, `queryDashboardWidgetData`.

Not yet: Ask Maple, rule mute (needs an endpoint), service detail
Errors / Deploys / Infra segments, search tab.
