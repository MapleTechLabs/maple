## 1
Most people have no idea how much Maple does now.

Traces, logs, metrics, errors, alerts, releases, dashboards, an agent that investigates incidents, LLM agent observability, a 75+ tool MCP server, infra monitoring. All on OpenTelemetry.

Here's all of it 🧵
[t01-service-map-3d.png]

## 2
Traces. Every request across every service, faceted and searchable. Peek opens one without leaving the list, then waterfall, timeline and flow views. Every span links straight to its logs.
[t02a-traces-peek.png, t02b-trace-waterfall.png]

## 3
Logs. Search text and attributes together, filter by trace id, and see volume by severity at a glance. From any line you can jump to the span that was running when it was written.
[t03-logs.png]

## 4
Metrics. Every OTel metric is typed and listed, with per-series, reset-aware rate and increase. One click to add a chart to a dashboard or turn it into an alert.

Here: a DB connection pool backing up the minute a bad deploy landed.
[t04-metrics.png]

## 5
Services. p50/p95/p99, throughput, Apdex and error rate per service, with deploys marked on every chart.

The service map is built from real calls, with rate, errors and latency on every edge. Databases and caches show up too. (And yes, there's a 3D mode.)
[t05a-service-detail.png, t05b-service-map.png]

## 6
Errors. Exceptions are fingerprinted into issues, ignoring ids, emails and hosts. Claim, assign, set severity, comment. Resolved issues reopen if they come back.

Attach the PR that fixes one and Maple watches prod after merge to confirm it's gone.
[t06a-errors.png, t06b-issue-detail.png]

## 7
Alerts. Error rate, latency, Apdex, throughput, no-data, or any query or raw SQL.

Every rule previews against real history before you save it, so you see exactly when it would have fired. Slack, Discord, Telegram, PagerDuty, email, webhooks.
[t07-alert-preview.png]

## 8
Releases. Every deploy is compared with the version it replaced, across every service it reached.

This one took payment-svc from 0% to 10.5% errors and p95 from 389ms to 5s. You'd know within minutes, not when a customer emails.
[t08-releases.png]

## 9
Dashboards. 22 templates, and Maple tells you which ones your data can actually fill before you create anything. Variables, raw SQL widgets, drill-down from any chart into its traces, public share links and embeds.
[t09-dashboard-templates.png]

## 10
Investigations. Hit Investigate on an issue or incident and an agent reads your traces, logs, metrics and your code (in a sandboxed checkout), then hands back the cause, its confidence and what to do next.
[t10-investigation.png]

## 11
MCP. 75+ tools for Claude Code, Cursor, Windsurf or anything that speaks MCP. Search traces, diagnose a service, compare periods, run SQL, read your source, build dashboards and alerts.

One command to connect. OAuth, scoped to your org.
[t11-mcp.png]

## 12
Agent sessions. Shipping LLM agents? Maple turns GenAI traces into sessions: turns, tool calls, tokens, cost per model, and what went wrong (context window blowups, rate limits, failing tools).

Works with Claude Code and 20+ frameworks.
[t12-agent-session.png]

## 13
Infrastructure. Hosts, Docker, Kubernetes, Railway, Cloudflare and PlanetScale in one place, sorted by what needs a look first. Any Prometheus /metrics endpoint works too.
[t13-infra.png]

## 14
More:

• Session replay, linked to traces
• Web analytics, incl. AI crawler reads
• Product events and funnels
• A PR review agent grounded in prod telemetry
• Slack and Discord bot
• Maple Local: all of it as one binary
• Bring your own ClickHouse, EU region

## 15
Maple is source-available and built on OpenTelemetry, so if you already emit OTel you're one endpoint change away.

maple.dev
