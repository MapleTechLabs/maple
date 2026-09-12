# API CPU probes

Run from the repository root. Bun drives the installed Rolldown build; Node measures the emitted JavaScript. All outputs must be under `apps/api/node_modules/.cache/`. The builder clears its chosen output directory before building so stale hashed chunks cannot contaminate a measurement.

```sh
OUT=apps/api/node_modules/.cache/cold-path/baseline BASELINE_REF=79dfb6da9d bun apps/api/scripts/cold-path/build-bundle2.mjs
bun apps/api/scripts/cold-path/measure.mjs apps/api/node_modules/.cache/cold-path/baseline apps/api/node_modules/.cache/cold-path/baseline.json 9 full

OUT=apps/api/node_modules/.cache/cold-path/candidate bun apps/api/scripts/cold-path/build-bundle2.mjs
bun apps/api/scripts/cold-path/measure.mjs apps/api/node_modules/.cache/cold-path/candidate apps/api/node_modules/.cache/cold-path/query.json 9 query
bun apps/api/scripts/cold-path/measure.mjs apps/api/node_modules/.cache/cold-path/candidate apps/api/node_modules/.cache/cold-path/full.json 9 full
```

`BASELINE_REF` overrides changed, tracked runtime source under `apps/api/src` and `packages/effect-sdk/src` with that revision's contents **inside the bundler**, without changing the checkout. Dependencies, SDK dist files, and fixtures remain fixed. It is for comparing these changes, not reproducing an arbitrary historical deployment. New benchmark modules stay current. It requires a baseline with the same `buildApp` entry contract.

Each sample is a fresh Node process. The probe measures startup imports, fixture imports, HTTP imports, and real route/service graph construction separately. `total` is their per-run sum, summarized by its median. `warm10000` is separate: 10,000 API-key rejections on `/internal/query-engine/execute-batch`, after 1,000 warm-up requests. This exercises the bridge, routing, auth, response encoding, and request wrapper without database or network I/O. It does not represent successful warehouse-query CPU.

These are **desktop V8 proxies**, not Cloudflare per-invocation CPU. `process.cpuUsage()` includes compiler/GC helper threads, so CPU may exceed elapsed time. The graph probe has additional bundle entry points and Cloudflare stubs. It does not time Alchemy event initialization or actual upstream requests. Do not run tests, builds, or other CPU-heavy jobs alongside measurements.

## Telemetry flush fixture

```sh
node --no-warnings --loader ./apps/api/scripts/cold-path/cf-loader.mjs apps/api/scripts/cold-path/measure-telemetry.mjs apps/api/node_modules/.cache/cold-path/baseline
node --no-warnings --loader ./apps/api/scripts/cold-path/cf-loader.mjs apps/api/scripts/cold-path/measure-telemetry.mjs apps/api/node_modules/.cache/cold-path/candidate
```

This bundles SDK **source**, pre-creates 200 spans, then times 200 flush calls queued together. A local collector stub accepts the OTLP JSON; every iteration asserts all 200 distinct spans arrived exactly once. Nine iterations report wall time, process CPU, and POST count. This isolates redundant flush work; it is not total tracing overhead or a production concurrency distribution.

## Workerd startup

```sh
bun run --cwd apps/api bench:startup-cpu worker
```

Builds a single Worker entry with the installed Alchemy `makeEffectVirtualEntry`, Cloudflare bundler plugin, and production's `strictExecutionOrder: false`. It supplies the API's current workflow export metadata, so update that map if the Worker adds or removes a hosted class. Wrangler profiles the emitted modules with `--args=--no-bundle`, without deploying. The profile is `apps/api/node_modules/.cache/maple-startup-check/worker-startup.cpuprofile`. The parser reports sampled active time, excluding both sampled idle and unsampled time; it is not a production CPU-budget measurement.

## Offline request smoke test in workerd

Build with `WORKER_PROBE=1` and the same cache output setting. Point a temporary Wrangler config at `worker.js`, with compatibility date `2026-04-08`, `nodejs_compat`, `find_additional_modules: true`, and an ESModule rule for `**/*.js`. Start `wrangler dev --local --no-bundle` from `apps/api`. The fixture uses the real graph caches and request bridge, but only offline ports. Send concurrent POSTs to `/internal/query-engine/execute-batch` and a full-graph route; expected results include 401 without credentials, 403 with `Bearer maple_ak_rejected`, and the normal 404 envelope for an unknown route. Stop the local server after testing.
