---
title: "Introduction"
description: "What Maple is, what it includes, and how to send your first telemetry."
group: "Getting Started"
order: 1
---

Maple is an observability platform built on OpenTelemetry. Your applications send traces, logs and metrics over OTLP, the protocol every OpenTelemetry SDK already speaks, and Maple stores them and lets you query, chart and alert on them. There is no proprietary agent to install.

<figure class="shot">
  <img src="/screenshots/docs/introduction-01-overview.webp" alt="Maple's Overview page for a production environment over the last 24 hours: an All clear alert strip, service health counts, totals for logs, traces, metrics and data size, and request volume and error rate charts." loading="lazy" />
  <figcaption>The Overview page: service health, signal totals, and request volume at a glance.</figcaption>
</figure>

## What's in Maple

- [Traces](/docs/explore/traces): search spans and open a trace to see every span in it.
- [Logs](/docs/explore/logs): search logs and jump from a log line to the trace that produced it.
- [Metrics](/docs/explore/metrics): browse and chart the metrics your services export.
- [Services](/docs/explore/services): throughput, error rate and latency per service.
- [Service map](/docs/explore/service-map): the calls between your services, built from trace data.
- [Errors](/docs/errors/overview): exceptions grouped into issues that you can assign and track to done.
- [Alerts](/docs/alerting/alert-rules): rules on any signal, with notifications to your destinations.
- [Dashboards](/docs/dashboards/build-dashboards): charts and tables built from queries.
- [Replays](/docs/session-replay/replays): recordings of browser sessions, linked to their traces.
- [Web analytics](/docs/product-events/web-analytics): page views and visitors from the browser SDK.
- [Agent Sessions](/docs/agent-sessions/overview): AI agent conversations, with every model call and tool call.
- Infrastructure: [Hosts](/docs/infrastructure/hosts), [Kubernetes](/docs/infrastructure/kubernetes), [Containers](/docs/infrastructure/docker), [Cloudflare](/docs/integrations/cloudflare) and [PlanetScale](/docs/integrations/planetscale).

## Getting started

For a copy-paste walkthrough, including a curl command that sends a test span without an SDK, follow the [Quickstart](/docs/getting-started/quickstart). The short version:

1. Sign up at [app.maple.dev](https://app.maple.dev). During onboarding you pick the region your organization lives in (US or EU).
2. Open **Settings → Ingestion** and copy an ingest key. Use the private key (`maple_sk_…`) for server applications and the public key (`maple_pk_…`) for browser code.
3. Point an OpenTelemetry SDK at the ingest endpoint for your region:

   | Region         | Ingest endpoint               |
   | -------------- | ----------------------------- |
   | United States  | `https://ingest.maple.dev`    |
   | European Union | `https://ingest.eu.maple.dev` |

   A key only works in the region it was created in. See [Regions](/docs/reference/regions).

4. Send a request to your application, then open **Explore → Traces** in Maple and check that a trace for it appears.

With the standard OpenTelemetry environment variables, step 3 looks like this:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"   # EU: https://ingest.eu.maple.dev
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_SERVICE_NAME="my-service"
```

If you use a coding agent, the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill instruments a repository for you, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) checks an existing OpenTelemetry setup against Maple's conventions.

## Language guides

- [Effect SDK](/docs/sdks/effect): Maple's SDK for Effect applications
- [Node.js](/docs/guides/instrumentation-nodejs): Express, Fastify, Hono
- [Next.js](/docs/guides/instrumentation-nextjs): App Router, Pages Router, middleware
- [Python](/docs/guides/instrumentation-python): FastAPI, Django, Flask
- [Go](/docs/guides/instrumentation-go)
- [Rust](/docs/guides/instrumentation-rust): through the `tracing` crate
- [Java](/docs/guides/instrumentation-java): the OpenTelemetry Java agent
- [C# / .NET](/docs/guides/instrumentation-csharp)
- [Kotlin](/docs/guides/instrumentation-kotlin): Ktor and Spring Boot
- [Laravel](/docs/guides/instrumentation-laravel): Eloquent, queues, HTTP client

The attributes Maple reads for the service map, error grouping and throughput are listed in [OpenTelemetry conventions](/docs/concepts/otel-conventions).

## Next steps

- [Quickstart](/docs/getting-started/quickstart): your first trace in about five minutes.
- [Instrument your application](/docs/instrumentation): every language and framework guide.
- [OpenTelemetry conventions](/docs/concepts/otel-conventions): the attributes Maple reads.
