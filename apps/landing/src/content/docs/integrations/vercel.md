---
title: "Vercel"
description: "Connect a Vercel team with an access token. Maple creates log, trace and AI Gateway drains on the team, so request, function, build and edge logs, deployment traces, and AI Gateway usage arrive in Maple. Speed Insights, Web Analytics and audit log drains are optional."
group: "Integrations"
order: 11
---

The Vercel integration connects one Vercel team to Maple with an access token. Maple creates three drains on the team: a log drain for request, function, build and edge logs, a trace drain for deployment traces, and an AI Gateway drain for model usage and cost. The data appears under **Infrastructure → Vercel**, in the [logs](/docs/explore/logs) and [traces](/docs/explore/traces) explorers, and AI Gateway requests also appear in Agent Sessions. You can also turn on drains for Speed Insights (Core Web Vitals), Web Analytics (page views and events) and the team's audit log. Maple also keeps a list of the team's projects and recent deployments.

## Prerequisites

- The Vercel team is on the Pro or Enterprise plan. Vercel offers drains only on those plans.
- A Vercel access token, created at [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens). Scope it to the team you want to connect and set an expiry date.
- You are an admin of the Maple organization.
- Optional drains have their own requirements: Speed Insights needs Speed Insights Plus on the project, Web Analytics needs Web Analytics enabled on the project, and the audit log needs an Enterprise team.

## Connect

1. Open **Integrations → Vercel** in Maple.
2. Paste the access token.
3. Pick the team. Maple skips this step when the token can see only one team.
4. Choose **All projects** or pick the projects to forward.
5. Set the sampling rate. The default, 100%, forwards every log and trace.
6. Switch logs, traces and AI Gateway on or off. Speed Insights, Web Analytics and the audit log are off by default; switch on the ones you want.
7. Click **Connect**.

Maple creates the drains right away. The first logs arrive with the next request to a forwarded project.

## What Maple creates on Vercel

Maple adds one drain per switch that is on:

| Drain                  | Receives                                                      | Default |
| ---------------------- | ------------------------------------------------------------- | ------- |
| `Maple logs`           | Runtime, build and static logs, including one log per request | On      |
| `Maple traces`         | Deployment traces, in OpenTelemetry format                    | On      |
| `Maple AI Gateway`     | One event per AI Gateway request and per provider attempt     | On      |
| `Maple Speed Insights` | One event per Core Web Vitals measurement from a real visit   | Off     |
| `Maple Web Analytics`  | One event per page view and per custom event                  | Off     |
| `Maple audit log`      | One event per change on the team, for the whole team          | Off     |

Every drain sends to Maple's ingest endpoint and authenticates with your organization's ingest key. If you rotate the ingest key, Maple updates the drains. The sampling rate applies to logs and traces only; the other drains forward every event, so spend totals, Web Vitals percentiles and visitor counts stay exact. The audit log drain always covers the whole team, whatever projects you pick.

If Vercel refuses an optional drain, for example the audit log on a team that is not on Enterprise, Maple marks only that drain as refused, shows Vercel's reason, and keeps the other drains running. It tries again on each sync. When you change projects, sampling, or the switches in Maple, Maple updates the drains on Vercel immediately. You can see them under **Team Settings → Drains** on Vercel; edit them from Maple, not from Vercel.

## Cost

Vercel bills drain usage on Pro and Enterprise. At the time of writing, on Pro:

- Drained data costs $0.50 per GB, measured as uncompressed JSON, for every drain.
- AI Gateway data also costs $0.05 per 1,000 requests.
- Speed Insights needs Speed Insights Plus, $10 per project per month, and costs $0.65 per 10,000 events.
- Web Analytics costs $0.03 per 1,000 events.
- The audit log drain is available on Enterprise only.

See Vercel's pricing for [drains](https://vercel.com/docs/drains#usage-and-pricing), [Speed Insights](https://vercel.com/docs/speed-insights/limits-and-pricing) and [Web Analytics](https://vercel.com/docs/analytics/limits-and-pricing) for current prices.

A lower sampling rate lowers the logs and traces volume. Forwarding only the projects you need lowers every drain except the audit log.

## What Maple collects

### Logs

Each log is stored with the project name as `service.name` and `cloud.provider` set to `vercel`, plus the project id, deployment id, environment and branch as resource attributes. Vercel's `level` maps to the log severity: `info` to INFO, `warning` to WARN, `error` to ERROR and `fatal` to FATAL.

Request logs carry `http.request.method`, `url.path` (and `url.query` when the request has one), `http.response.status_code`, `user_agent.original` and `vercel.cache` (`HIT`, `MISS`, `STALE` and so on). Every log carries `vercel.source` (`build`, `edge`, `lambda`, `static`, `external`, `firewall` or `redirect`) and, where Vercel sends them, the request id, entrypoint, execution region and trace id. A log with a trace id links to its trace.

### Traces

Vercel sends deployment traces with the `vercel.projectId` and `vercel.deploymentId` resource attributes. Its platform spans come in two services: `vercel.edge-network` for routing and caching, and `vercel.serverless-runtime` for functions. Maple moves each function invocation (`Invoke Function`) and its outbound calls to a service named after the project, the same name its logs use, so every project is its own service on the service map with its own dependencies. Cold-start steps (`Start VM`, `Spawn Node.js`, `Init User Code`) and `waitUntil` stay under `vercel.serverless-runtime`. Every function span keeps `maple_vercel.platform_service = vercel.serverless-runtime` as a resource attribute.

### Speed Insights and Web Analytics

These drains arrive as logs, each under its own `service.name`: `vercel-speed-insights` and `vercel-web-analytics`. The resource carries `cloud.provider` set to `vercel`, the team id and, where Vercel sends them, the project id, deployment id and environment.

- **Speed Insights**: one log per measurement, such as `LCP 2.41s /dashboard`. The metric is in `vercel.speed_insights.metric` (`LCP`, `INP`, `CLS`, `FCP`, `TTFB` or `FID`) and the value in `vercel.speed_insights.value`, in milliseconds (CLS is a score). Each log also carries `url.path`, `vercel.route`, the visitor's country, region and city (`geo.*`), browser and OS (`user_agent.*`) and device.
- **Web Analytics**: one log per page view or custom event, such as `pageview /pricing`. It carries `vercel.web_analytics.event.type` and `.event.name`, the event data as JSON in `vercel.web_analytics.event.data`, `url.path`, `url.query`, the referrer, and the same visitor fields as Speed Insights.

### Audit log

Audit events do not arrive as logs. They go to the audit log in the Security section, which only organization admins can read: an audit event names a person, their email and their IP address, and every member can read logs.

Each event shows who acted (name, email and id), the action as Vercel names it, such as `drain-created`, the time, the IP address and user agent, and the event's full payload. The drain has to be created with your organization's private ingest key, which is what Maple uses when it creates the drain for you.

## AI Gateway

Requests that go through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) arrive through the AI Gateway drain. Maple stores each request as a trace under the service `ai-gateway`: the root span carries the model, the provider, input, cached and output tokens, time to first token, and the cost in USD (`vercel.ai_gateway.cost.total`), and each provider attempt is a child span, so retries and failovers show. Vercel sends no prompt or completion content.

AI Gateway data shows in two places:

- **Infrastructure → Vercel**: spend per project, with a **No project** row for requests made outside one (an API key used elsewhere). A project's **AI Gateway** tab breaks its spend, requests, tokens and latency down by model.
- **Agent Sessions**, with the vendor **Vercel AI Gateway**. Each gateway request is its own session.

## Richer traces with `@vercel/otel`

Vercel's own deployment traces cover the platform's view of a request. To trace your application code, install `@vercel/otel` and register it in `instrumentation.ts` at the root of the project:

```ts
import { registerOTel } from "@vercel/otel"

export function register() {
	registerOTel({ serviceName: "my-app" })
}
```

The trace drain forwards these spans to Maple. You do not need to configure an exporter.

## Where the data shows

- **Infrastructure → Vercel → Overview**: requests, error rate, cache hit rate and cold-start rate across the team, AI Gateway spend by project, recent builds and failed builds, and, when those drains are on, Web Vitals, page views and audit log events.
- **Infrastructure → Vercel → Projects**: each project with its last build, requests, 5xx rate, cache hit rate, cold-start rate and latency. Click a project for its own page.
- **A project's page** has a tab for each part:
  - **Traffic**: requests by status class, top paths with their cache hit rate, and top errors.
  - **Functions**: invocations, cold-start rate and cold-start init time per route.
  - **Dependencies**: the hosts its functions call, with calls, error rate and latency, and a link to the project on the service map.
  - **Builds**: recent deployments with build time, state and why a failed build stopped. **Build logs** opens the logs explorer on that build's output.
  - **AI Gateway**, **Speed Insights** (p75 Web Vitals by route and device) and **Web Analytics** (page views, devices, top pages, referrers, countries and custom events).

  A section whose drain is off says so and links to the setting that turns it on.
- **Service map**: each project with its outbound calls, from its function spans, and an edge from `vercel.edge-network` to every project it invokes. A project's Infrastructure tab links to its Vercel project page.
- [Logs](/docs/explore/logs): filter by `service.name` (the project name) or `vercel.project.id`. Speed Insights, Web Analytics and audit log events are under their own `service.name`.
- [Traces](/docs/explore/traces): your `@vercel/otel` service, the deployment traces, and `ai-gateway`.
- **Dashboards**: the **Vercel** template charts requests, cache, errors and AI Gateway usage.

## Troubleshooting

- **Connect fails with a message about the plan.** Vercel creates drains only on Pro and Enterprise. Maple shows Vercel's error as it came back.
- **The token stopped working.** The integration card shows that the token failed. Create a new token and paste it on **Integrations → Vercel**. Maple stops polling Vercel until it has a working token, but the drains keep sending data.
- **No logs after connecting.** Logs arrive when a forwarded project receives traffic or builds. Check that the project is in the forwarded list and that logs are switched on.
- **No AI Gateway data.** Check that AI Gateway is switched on, and that the requests go through AI Gateway from the connected team.
- **An optional drain shows as refused.** Vercel would not create it. Speed Insights needs Speed Insights Plus on the project, Web Analytics needs Web Analytics enabled, and the audit log needs Enterprise. Fix that on Vercel, then click **Re-apply drains** on the integration card, or switch the drain off.

## Disconnect

On **Integrations → Vercel**, click **Disconnect**. Maple deletes its drains from the Vercel team. Data already in Maple stays until it reaches the end of your retention period.

## Next steps

- [Logs](/docs/explore/logs): search and filter Vercel logs.
- [Alert rules](/docs/alerting/alert-rules): alert on 5xx responses or AI Gateway spend.
