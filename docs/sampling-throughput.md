# Sampling & Throughput Estimation

Maple detects trace sampling and extrapolates throughput, so request rates stay realistic when only a fraction of traces is collected.

## What is trace sampling?

Distributed tracing at scale produces a large volume of spans. Sampling cuts that volume by exporting only a subset of traces:

- **Head sampling**: the decision is made at the start of a trace (e.g. "keep 10% of traces"). The OTel SDK or Collector decides before any spans are processed.
- **Tail sampling**: the decision is made after the trace completes, typically based on latency, errors, or other attributes.

Both reduce storage and processing costs. Both also mean the raw span count no longer reflects actual throughput.

## How Maple detects sampling

OpenTelemetry records the W3C `tracestate` on every span. When probability sampling is active, the `ot` entry carries a `th` (rejection threshold) key:

```
tracestate: ot=th:e668
```

At ingest time, Maple computes a per-row `SampleRate` weight on the `traces` datasource (the `SAMPLE_RATE_EXPR` column default in `packages/domain/src/tinybird/datasources.ts`). The expression resolves three sources in priority order:

1. `SpanAttributes['SampleRate']`: an explicit collector-set value. It wins when it is `>= 1`.
2. `TraceState th:<hex>`: W3C threshold sampling, parsed inline. The weight is capped at 10000.
3. Default `1.0`: unsampled.

The weight is materialized per row, so downstream queries don't parse TraceState. They sum `SampleRate`.

No configuration is needed. If your OTel SDK or Collector sets the `th` value, Maple picks it up.

## How throughput is calculated

The threshold hex value encodes the rejection probability. The per-row `SampleRate` is the inverse of the acceptance probability:

```typescript
// threshold "e668" -> ~90% rejection -> ~10% acceptance -> SampleRate ~10
const thresholdInt = parseInt(thresholdHex, 16)
const maxInt = Math.pow(16, thresholdHex.length)
const rejectionRate = thresholdInt / maxInt
const acceptanceProbability = 1 - rejectionRate
const sampleRate = 1 / acceptanceProbability
```

The query engine then sums the column:

```
estimatedTotal = sum(SampleRate)        -- per-row weighted sum
throughput     = estimatedTotal / durationSeconds
```

For example, with 10% sampling (`SampleRate = 10`) and 500 sampled service entry point spans over 60 seconds:

```
estimatedTotal = 500 * 10 = 5000
throughput     = 5000 / 60 = ~83 req/s
```

This also handles **mixed sampling rates** correctly. Take a bucket of 100 spans: 99 sampled at 50% (weight 2) and 1 sampled at 1/8192 (weight 8192). The per-row sum is `99 * 2 + 1 * 8192 = 8390`. A single weight per bucket would give `100 * 8192`.

## UI indicators

When sampling is detected for a service:

- **Tilde prefix (`~`)**: throughput values are prefixed with `~` to mark them as estimates. This appears in the services table, service map nodes, and service map edges.
- **Secondary "traced" line**: the services table shows the actual traced rate under the estimate (e.g. `~8.3 traced`).
- **Tooltip**: hovering the throughput cell shows the sampling rate and extrapolation factor (e.g. "Estimated from 10% sampled traces (x10 extrapolation)").

## Limitations

- **Edge throughput**: service-to-service call counts on the service map use the same per-row `SampleRate` weighting. The edge label shows `~` when sampling is active.
- **Error rate**: sampled error spans use the same per-row weights as throughput. Maple computes `sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate)`, so mixed sampling rates do not over-represent aggressively retained errors. If an upstream sampler does not report reliable inclusion weights, exact pre-sampling error rates still require SpanMetrics.

## For best results

For exact RED metrics (Rate, Errors, Duration) alongside sampled traces, use the **OpenTelemetry Collector SpanMetrics Connector**. It derives metrics from every span before sampling, so counts stay exact whatever the trace sampling configuration.

- [SpanMetrics Connector docs](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector)

A typical Collector pipeline:

```yaml
connectors:
    spanmetrics:
        namespace: span.metrics

service:
    pipelines:
        traces:
            receivers: [otlp]
            processors: [batch]
            exporters: [otlp, spanmetrics] # fork to both export + metrics
        metrics:
            receivers: [spanmetrics]
            exporters: [otlp]
```

The metrics pipeline sees every request while the traces pipeline samples aggressively.
