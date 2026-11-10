---
title: "Vercel"
description: "Connect a Vercel team with an access token. Maple creates log, trace and AI Gateway drains on the team, so request, function, build and edge logs, deployment traces, and AI Gateway usage arrive in Maple."
group: "Integrations"
order: 11
---

The Vercel integration connects one Vercel team to Maple with an access token. Maple creates three drains on the team: a log drain for request, function, build and edge logs, a trace drain for deployment traces, and an AI Gateway drain for model usage and cost. The data appears under **Infrastructure → Vercel**, in the [logs](/docs/explore/logs) and [traces](/docs/explore/traces) explorers, and AI Gateway requests also appear in Agent Sessions. Maple also keeps a list of the team's projects and recent deployments.

## Prerequisites

- The Vercel team is on the Pro or Enterprise plan. Vercel offers drains only on those plans.
- A Vercel access token, created at [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens). Scope it to the team you want to connect and set an expiry date.
- You are an admin of the Maple organization.

## Connect

1. Open **Integrations → Vercel** in Maple.
2. Paste the access token.
3. Pick the team. Maple skips this step when the token can see only one team.
4. Choose **All projects** or pick the projects to forward.
5. Set the sampling rate. The default, 100%, forwards every log and trace.
6. Switch logs, traces and AI Gateway on or off.
7. Click **Connect**.

Maple creates the drains right away. The first logs arrive with the next request to a forwarded project.

## What Maple creates on Vercel

Maple adds three drains to the team:

| Drain              | Receives                                                       |
| ------------------ | -------------------------------------------------------------- |
| `Maple logs`       | Runtime, build and static logs, including one log per request  |
| `Maple traces`     | Deployment traces, in OpenTelemetry format                     |
| `Maple AI Gateway` | One event per AI Gateway request and per provider attempt      |

All three send to Maple's ingest endpoint and authenticate with your organization's ingest key. If you rotate the ingest key, Maple updates the drains. The sampling rate applies to logs and traces only; the AI Gateway drain forwards every request, so spend totals stay exact. When you change projects, sampling, or the switches in Maple, Maple updates the drains on Vercel immediately. You can see them under **Team Settings → Drains** on Vercel; edit them from Maple, not from Vercel.

## Cost

Vercel bills drain usage on Pro and Enterprise. At the time of writing, drained data costs $0.50 per GB, measured as uncompressed JSON. AI Gateway data also costs $0.05 per 1,000 requests, on top of the data volume. See [Vercel's drain pricing](https://vercel.com/docs/drains#usage-and-pricing) for current prices.

A lower sampling rate lowers the logs and traces volume. Forwarding only the projects you need lowers all three drains.

## What Maple collects

### Logs

Each log is stored with the project name as `service.name` and `cloud.provider` set to `vercel`, plus the project id, deployment id, environment and branch as resource attributes. Vercel's `level` maps to the log severity: `info` to INFO, `warning` to WARN, `error` to ERROR and `fatal` to FATAL.

Request logs carry `http.request.method`, `url.path` (and `url.query` when the request has one), `http.response.status_code`, `user_agent.original` and `vercel.cache` (`HIT`, `MISS`, `STALE` and so on). Every log carries `vercel.source` (`build`, `edge`, `lambda`, `static`, `external`, `firewall` or `redirect`) and, where Vercel sends them, the request id, entrypoint, execution region and trace id. A log with a trace id links to its trace.

### Traces

Vercel sends deployment traces as they are, with the `vercel.projectId` and `vercel.deploymentId` resource attributes.

## AI Gateway

Requests that go through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) arrive through the AI Gateway drain. Maple stores each request as a trace under the service `ai-gateway`: the root span carries the model, the provider, input, cached and output tokens, time to first token, and the cost in USD (`vercel.ai_gateway.cost.total`), and each provider attempt is a child span, so retries and failovers show. Vercel sends no prompt or completion content.

AI Gateway data shows in two places:

- **Infrastructure → Vercel → AI Gateway**: spend, requests, tokens and latency, broken down by model and by project.
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

- **Infrastructure → Vercel**: requests, status classes, cache hit rate and errors across the team, and each project with its production and latest deployment. Click a project for its own page.
- [Logs](/docs/explore/logs): filter by `service.name` (the project name) or `vercel.project.id`.
- [Traces](/docs/explore/traces): your `@vercel/otel` service, the deployment traces, and `ai-gateway`.
- **Dashboards**: the **Vercel** template charts requests, cache, errors and AI Gateway usage.

## Troubleshooting

- **Connect fails with a message about the plan.** Vercel creates drains only on Pro and Enterprise. Maple shows Vercel's error as it came back.
- **The token stopped working.** The integration card shows that the token failed. Create a new token and paste it on **Integrations → Vercel**. Maple stops polling Vercel until it has a working token, but the drains keep sending data.
- **No logs after connecting.** Logs arrive when a forwarded project receives traffic or builds. Check that the project is in the forwarded list and that logs are switched on.
- **No AI Gateway data.** Check that AI Gateway is switched on, and that the requests go through AI Gateway from the connected team.

## Disconnect

On **Integrations → Vercel**, click **Disconnect**. Maple deletes its drains from the Vercel team. Data already in Maple stays until it reaches the end of your retention period.

## Next steps

- [Logs](/docs/explore/logs): search and filter Vercel logs.
- [Alert rules](/docs/alerting/alert-rules): alert on 5xx responses or AI Gateway spend.
