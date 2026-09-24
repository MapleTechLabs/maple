# API CPU improvements — 2026-09-12

Implemented locally against revision `79dfb6da9d`, with measurements after each logical change. No production deployment or production CPU profile was taken.

## Results

Final comparison uses nine fresh-process desktop V8 samples per variant, identical offline fixtures, and the same installed dependencies. The cold metric is the per-run `total`: startup-module imports + fixture imports + HTTP-module imports + real route/service construction; it excludes network and the first request handler itself.

| Metric                                           |  Baseline |     Final |                          Change |
| ------------------------------------------------ | --------: | --------: | ------------------------------: |
| Dashboard query cold initialization, process CPU |  303.8 ms |  213.3 ms |                          −29.8% |
| Dashboard query cold initialization, elapsed     |  202.3 ms |  140.8 ms |                          −30.4% |
| Dashboard query graph construction, elapsed      |   33.8 ms |   10.3 ms |                          −69.6% |
| Full graph cold initialization, process CPU      |  303.8 ms |  289.2 ms |                           −4.8% |
| Warm API-key rejection, CPU per request          | 0.1037 ms | 0.1042 ms |              approximately flat |
| 200 simultaneous telemetry flush calls, CPU      |  11.46 ms |   1.52 ms |   −86.8% for this flush fixture |
| Same flush fixture, completion time              |  232.1 ms |   1.58 ms | redundant serial timers removed |

Warm figures come from 10,000 requests after 1,000 warm-ups per process. The flush fixture has nine iterations, one OTLP POST in both variants, and verifies all 200 unique spans arrive exactly once. It measures flush overhead, not total API CPU or total tracing overhead. No sampling was enabled.

`process.cpuUsage()` includes compiler and GC helper threads; these values are not Cloudflare invocation CPU or predicted production p50/p99. The graph probe uses extra bundle entries and Cloudflare stubs. Production savings depend on cold-request frequency, route mix, and concurrent flush volume. No steady-state improvement is claimed for successful warehouse queries.

## Changes, in measured order

1. **Removed unused sandbox service composition from the API HTTP graph.** The service implementation remains available to the AI Worker. A clean 15-sample comparison was effectively flat: 290.5 → 294.0 ms CPU and 189.3 → 189.9 ms elapsed. Kept as a dependency cleanup, not counted as a measured performance win. An earlier candidate run overlapped tests and was discarded.

2. **Added a smaller graph for `/internal/query-engine/*`.** It uses the existing dashboard handlers and the already-decorated internal API group, preserving session auth, validation, and error envelopes. Warehouse dependencies now have their own composition root, without billing, integrations, alerts, and other management services. The first 15-sample check measured approximately 230 ms CPU versus the prior approximately 290 ms baseline; the final controlled rebuild is in the table above. Full and query graphs share an isolate-owned service memo map, but each has its own router. Raw fallback registration is fresh for each router. Graph construction is serialized through native promises, preserving the requesting event's Workers I/O ownership. Each graph remains recoverably cached after successful construction.

3. **Coalesced queued Worker telemetry flushes with identical environment arguments.** Calls arriving while an export is running still schedule a trailing drain; they cannot return before their spans have been drained. Different arguments do not coalesce. Rejected drains do not poison later calls. Other SDK presets retain the existing one-drain-per-call behavior. Span sampling, exception capture, export serialization, and final-event delivery are unchanged. The isolated flush measurement is in the table.

4. **Recorded isolate age and request ordinal on all ordinary request spans**, including successful responses and graph-build failures. Previously those attributes were attached only to rendered 5xx responses. Health, preflight, and AI forwarding keep their existing early paths. An initial short warm benchmark added approximately 5 microseconds/request; after a longer warm-up, final warm rejection CPU is within about 0.5% of baseline. This is diagnostic coverage, not a CPU optimization. Ordinals count ordinary API requests, not all Worker events.

5. **Repaired the profiling tools.** The startup check now uses Alchemy's installed entry generator and Cloudflare Rolldown plugin, with `strictExecutionOrder: false`, then profiles the emitted bundle rather than rebuilding it with esbuild. Removed stale AI class exports from its metadata. Fixed sampled CPU accounting, heap-unit conversion, stale hashed-chunk contamination, and swallowed import failures. Added repeatable graph, warm-request, telemetry, and offline workerd fixtures. These tooling changes have no deployed runtime cost.

## Validation

- API runtime typecheck, benchmark typecheck, and SDK typecheck pass.
- Full SDK suite: 133 tests pass, including coalescing, trailing drains, different arguments, failure recovery, and existing no-loss export tests.
- Targeted API suites: 27 tests pass, covering graph build order, concurrent cold graph construction, service sharing, router separation, request context isolation, authentication, validation, CORS, error envelopes, and isolate attributes.
- Offline workerd smoke test: concurrent cold requests on both graphs returned expected 401/403/404 responses with CORS, without Worker I/O ownership errors.
- Changed-file lint and whitespace checks pass.
- Broad API **test** typecheck still fails in untouched test files (dashboard template fixtures, branded IDs, and other existing test typings). No errors remain in the changed test files. This is distinct from the passing application typecheck.

An alternating three-run workerd startup check using the generated entry measured median sampled active CPU of **46.6 ms baseline → 46.8 ms candidate**, effectively unchanged. The candidate is about 1.21 MiB gzip across its modules. Startup-only profiles exclude lazy HTTP graph construction; the improvement comes on the first dashboard query, not from shifting cost into script startup.

## Reproduction and artifacts

See [the CPU probe instructions](../apps/api/scripts/cold-path/README.md). Raw local results are under `apps/api/node_modules/.cache/api-cpu-investigation/`:

- `baseline.json` / `no-sandbox.json`: initial cleanup comparison.
- `query-split.json` / `query-split-full.json`: first smaller-graph comparison.
- `pre-flush.json` / `post-flush.json`: telemetry burst measurements.
- `pre-metadata.json` / `post-metadata.json`: instrumentation overhead check.
- `final-baseline.json`, `final-query.json`, `final-full.json`: final initialization and steady warm-request measurements.
- `startup-comparison.json` and `startup-*.log`: alternating local workerd startup measurements.

## Production follow-up

After deployment, compare Cloudflare CPU and wall-time distributions separately, grouped by route and event type. The isolate attributes now allow successful early requests to be distinguished from warm traffic. Separate cron/queue CPU from HTTP: changing a telemetry service name does not remove its CPU from the API Worker. Use actual traffic to decide whether other route families should get smaller graphs.

Postgres socket ownership, connection timeouts, `strictExecutionOrder`, query semantics, and trace sampling were not changed. Further sampling needs a separate measured decision and correct propagation/weighting; setting `OTEL_TRACES_SAMPLER` alone does not configure this custom Worker preset.

References: [Cloudflare CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/), [CPU versus wall-time metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [Wrangler startup profiling](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
