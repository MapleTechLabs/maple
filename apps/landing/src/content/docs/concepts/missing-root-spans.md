---
title: "Traces without a root span"
description: "Why traces reach Maple without their root span, how Setup health measures it, and how to fix each cause."
group: "Concepts"
navLabel: "Missing root spans"
order: 3
---

The root span is the one span in a trace with no parent. When it never reaches Maple, the rest of the trace still arrives, but:

- the trace is missing from the trace list, its filters and trace search, which list traces by their root span;
- alert rules on error rate, latency and throughput don't count it, because they are computed over root spans;
- its duration and its waterfall start at the first span that did arrive.

## How Setup health measures it

**Settings → Setup health** runs the check **Traces have a root span** (`TRC-02`). It takes every trace whose first span started between 75 and 15 minutes ago and counts the ones whose root span never arrived. A span is exported when it ends, and the root usually ends last, so the 15 minutes give it time to arrive.

| Traces without a root span | Result   |
| -------------------------- | -------- |
| None or one                | Passes   |
| Two or more, up to 0.1%    | Info     |
| More than 0.1%             | Warning  |
| More than 1%               | Critical |

Warning and critical need at least 50 traces in the window. Traces whose root was dropped by sampling don't count: those with a `th:` value in `tracestate`, and, when Maple's ingest sampling is on, traces made only of the error and slow spans it keeps from traces it drops.

The finding lists the services where these traces start, each with its own share. The `audit_setup` [MCP tool](/docs/reference/mcp) returns the same result.

## Find the cause

The earliest span that did arrive points at the cause. The [agent prompt](#investigate-with-an-agent) below finds example traces and reads them for you.

| Earliest span that arrived                                           | Cause                                                                                 | Fix                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| An Internal or Client span in a short-lived process                  | The root span was never exported                                                      | [Flush before the process stops](#flush-before-the-process-stops) |
| A Server span with a parent ID                                       | A proxy, gateway, load balancer or platform in front sends `traceparent` but no spans | [Context from upstream](#context-from-upstream)                   |
| Any span, in a trace that runs for many minutes                      | The root span is still open                                                           | [Long-running root spans](#long-running-root-spans)               |
| A span whose parent belongs to a service that exports somewhere else | The caller sends its spans to another Maple organization or another backend           | Send every service to the same organization                       |

## Flush before the process stops

The OpenTelemetry SDK exports spans in batches. Whatever is still in the batch when the process exits or the runtime freezes it is lost, and the root span, which ends last, is usually among them.

- In serverless functions, flush the tracer provider at the end of every invocation with `await provider.forceFlush()`.
- In CLI commands, scripts and jobs, call `await sdk.shutdown()` before the process exits, on the error path too.
- In servers, call `sdk.shutdown()` on `SIGTERM`, so a deploy or scale-down doesn't drop the roots of requests in flight.

The [instrumentation guides](/docs/instrumentation) show the setup for each language.

## Context from upstream

When a proxy, gateway or load balancer adds or forwards `traceparent` without exporting a span of its own, your first service continues a trace whose root lives in that proxy. Then nearly every trace that passes through it has no root.

- If the proxy can export OpenTelemetry, send its spans to Maple, and it becomes the root.
- Otherwise, remove the incoming `traceparent` and `tracestate` headers at the proxy, so the first service starts the trace itself.

Cloud Run rewrites `traceparent` on every request it forwards: the parent becomes a span inside Google's infrastructure that Maple never receives, so traces that enter a Cloud Run service have no root. [Instrument a Cloud Run service](/docs/integrations/gcp-opentelemetry#instrument-a-cloud-run-service) covers the setup and this limit.

## Long-running root spans

A root span that stays open for more than about 15 minutes, such as a WebSocket session or a batch job, counts as missing until it ends. Start a new trace for each message or step, and connect it to the session with a span link.

## Investigate with an agent

Connect the [Maple MCP server](/docs/getting-started/ai-agents) to a coding agent such as Claude Code, Codex or Cursor, and paste this prompt:

```text
Investigate why traces in my Maple organization arrive without a root span, using the Maple MCP tools. Guide: https://maple.dev/docs/concepts/missing-root-spans

1. Call audit_setup and read the TRC-02 finding: the share of traces without a root span and the services where they start.

2. Find example traces with run_sql, over a 30-minute window that ends 15 minutes ago:

SELECT ServiceName AS firstService, SpanKind AS firstSpanKind, SpanName AS firstSpan,
       count() AS traces, any(TraceId) AS exampleTrace
FROM (
  SELECT TraceId,
         argMin(ServiceName, Timestamp) AS ServiceName,
         argMin(SpanKind, Timestamp) AS SpanKind,
         argMin(SpanName, Timestamp) AS SpanName
  FROM traces
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  GROUP BY TraceId
  HAVING countIf(ParentSpanId = '') = 0
     AND min(Timestamp) >= $__startTime + INTERVAL 10 MINUTE
)
GROUP BY firstService, firstSpanKind, firstSpan
ORDER BY traces DESC
LIMIT 20

3. For the top rows, call inspect_trace on exampleTrace and inspect_span on its earliest span. Note the span kind, the parent span ID, the resource attributes (cloud.platform, faas.*, telemetry.sdk.*) and how long the trace runs.

4. Classify each row:
   - Internal or Client earliest span in a short-lived process: the root span is never exported, because the process exits or is frozen before the SDK flushes.
   - Server earliest span with a parent ID: a proxy, gateway, load balancer or platform such as Cloud Run sends traceparent without exporting spans.
   - The trace runs for many minutes: the root span is still open.
   - The parent belongs to a service that exports to another Maple organization or another backend.

5. If the source code is available, locally or through search_source_code and read_source_file, find where each affected service sets up OpenTelemetry. Check that it flushes at the end of each request, invocation or command, and shuts the SDK down on SIGTERM.

6. Report per service: the cause, the trace IDs that show it, and the code or configuration change that fixes it. Don't change any code until I confirm.
```
