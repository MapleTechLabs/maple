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

Run this Bash sequence from the repository root. Port 8797 must be free. The temporary config, responses and log stay in the benchmark cache; the subshell stops Wrangler on exit.

```bash
(
  set -euo pipefail
  OUT=apps/api/node_modules/.cache/cold-path/smoke WORKER_PROBE=1 bun apps/api/scripts/cold-path/build-bundle2.mjs
  cd apps/api
  probe_dir=node_modules/.cache/cold-path/smoke
  cat > "$probe_dir/wrangler.json" <<'JSON'
{
  "name": "maple-api-offline-smoke",
  "main": "./worker.js",
  "compatibility_date": "2026-04-08",
  "compatibility_flags": ["nodejs_compat"],
  "find_additional_modules": true,
  "rules": [{ "type": "ESModule", "globs": ["**/*.js"] }]
}
JSON
  WRANGLER_SEND_METRICS=false bunx wrangler dev --local --no-bundle \
    --config "$probe_dir/wrangler.json" --port 8797 > "$probe_dir/wrangler.log" 2>&1 &
  probe_pid=$!
  trap 'kill "$probe_pid" 2>/dev/null || true; wait "$probe_pid" 2>/dev/null || true' EXIT
  ready=0
  for attempt in {1..100}; do
    if curl -fsS http://127.0.0.1:8797/health > /dev/null 2>&1; then ready=1; break; fi
    sleep 0.2
  done
  test "$ready" = 1
  # Health does not build either HTTP graph. Exercise both graphs concurrently.
  node --input-type=module <<'JS'
import assert from "node:assert/strict"
const cases = [
  ["/internal/query-engine/execute-batch", "", 401],
  ["/internal/ai-sessions/list", "", 401], // AllRoutes; not forwarded to maple-ai
  ["/internal/query-engine/execute-batch", "Bearer maple_ak_rejected", 403],
  ["/internal/ai-sessions/list", "Bearer maple_ak_rejected", 403],
  ["/internal/query-engine/not-a-route", "", 404],
  ["/not-a-route", "", 404],
]
await Promise.all(cases.map(async ([path, authorization, expected]) => {
  const response = await fetch(`http://127.0.0.1:8797${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.maple.dev", authorization },
    body: "{}",
  })
  const body = await response.json()
  assert.equal(response.status, expected, path)
  assert.equal(response.headers.get("access-control-allow-origin"), "*", path)
  if (expected === 404) assert.equal(body.error.code, "route_not_found")
}))
console.log("PASS: concurrent cold requests, both graphs, 401/403/404 and CORS")
JS
)
```

The fixture uses the real graph caches and request bridge with offline ports. These requests stop at auth or routing, without database or warehouse calls. This is a request-ownership smoke test, not a performance benchmark.
