---
title: "Sampling & Throughput Estimation"
description: "How Maple weights sampled spans at ingest so throughput, error rate and service map call counts reflect the traffic you actually served."
group: "Concepts"
navLabel: "Sampling & Throughput"
order: 2
---

When you sample traces, the spans Maple receives are a fraction of the requests your services handled. Maple gives every span a weight at ingest and sums those weights, so request rates, error rates and service map call counts estimate the traffic before sampling.

## What is trace sampling?

Sampling reduces span volume by exporting only a subset of traces.

- **Head sampling** decides at the start of a trace, for example "keep 10% of traces". The OpenTelemetry SDK or Collector makes the choice before any spans are exported.
- **Tail sampling** decides after the trace completes, usually based on latency, errors or other attributes.

Both cut storage and processing cost. Both also mean the raw span count no longer equals the number of requests.

## How each span gets its weight

At ingest, Maple stores a `SampleRate` on every span: the number of requests that span stands for. It resolves the value from three sources, in this order:

1. **`SampleRate` span attribute.** If the span carries a `SampleRate` attribute of 1 or more (for example, set by your Collector), Maple uses it as is.
2. **W3C threshold in `tracestate`.** When OpenTelemetry probability sampling is active, the span's `tracestate` carries an `ot` entry with a `th` (rejection threshold) key, such as `ot=th:e668`. Maple converts the threshold to a weight of `1 / acceptance probability`. The weight is capped at 10000 (an acceptance probability of 0.01%).
3. **Default of 1.** A span with neither is treated as unsampled.

No configuration is needed. If your SDK or Collector sets `th` in `tracestate`, or sets a `SampleRate` attribute, Maple picks it up.

For example, `th:e668` means about 90% of traces were rejected, so about 10% were kept and each kept span has a `SampleRate` of about 10.

## How throughput is calculated

Throughput is the sum of the weights, divided by the length of the window:

```
estimated requests = sum(SampleRate)
throughput         = estimated requests / window seconds
```

With 10% sampling (`SampleRate = 10`) and 500 sampled entry-point spans over 60 seconds, the estimate is 5,000 requests, or about 83 requests per second.

Because the weight is stored on each span, **mixed sampling rates add up correctly**. Take 100 spans in one bucket: 99 kept at 50% (weight 2) and 1 kept at 1/8192 (weight 8192). The estimate is `99 × 2 + 1 × 8192 = 8390` requests. The same holds when different services, or different deployments of one service, sample at different rates.

## How error rate is calculated

Error rate uses the same weights. Each error span counts for its `SampleRate`, and so does each span in the denominator:

```
error rate = sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate)
```

A tail sampler that keeps every error but only 1% of successful requests would make a raw error count look far too high. Weighting each span by its own `SampleRate` corrects for that, as long as the sampler reports the weight it used.

Service map edges use the same weighting for call counts between services.

## UI indicators

When a service has sampled spans in the selected window:

- **Tilde prefix (`~`).** Throughput is prefixed with `~` to mark it as an estimate. This appears in the services table and on service map nodes and edges.
- **Traced rate.** The services table shows the rate of spans actually received under the estimate, for example `~8.3 traced`.
- **Tooltip.** Hovering the throughput cell shows the sampling rate and the extrapolation factor, for example "Estimated from 10% sampled traces (x10 extrapolation)".

## Limitations

**The estimate is only as good as the weight.** If a sampler drops spans without recording `th` in `tracestate` or a `SampleRate` attribute, Maple counts the surviving spans at weight 1 and underestimates throughput.

## Exact counts with SpanMetrics

For exact RED metrics (rate, errors, duration) next to sampled traces, use the OpenTelemetry Collector [SpanMetrics Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector). It derives metrics from every span before sampling, so the counts do not depend on the sampling configuration.

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

The metrics pipeline sees every request while the traces pipeline samples as aggressively as you like.
