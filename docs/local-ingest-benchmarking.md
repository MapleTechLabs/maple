# Local ingest benchmarking

Two benches in `apps/cli/bench/` measure how long Maple Local takes to accept OTLP. Both need
libchdb (`~/.maple/bin/libchdb.so` or `MAPLE_LIBCHDB`). Run them on demand, not in CI: timings
on shared runners are too noisy to gate on. Commit the JSON reports with any PR that changes the
ingest path, before and after.

## `bun run --cwd apps/cli bench:ingest`

Starts a real `maple start --in-memory` and times each POST to its 2xx, for signal × records per
export × concurrent exports. Reports p50, p95, max and records per second per cell, plus every
request over 1 s with its offset from server start (`stalls`).

```bash
bun run --cwd apps/cli bench:ingest --signals traces --sizes 1,50 --concurrency 1,5 --exports 40
bun run --cwd apps/cli bench:ingest --burn 8   # keep 8 cores busy, like a loaded dev machine
```

## `bun run --cwd apps/cli bench:ingest:chdb`

Opens a scratch store in-process, with the same config `maple start --in-memory` generates, and
breaks one request down:

- `stages`: JSON parse, encode, SQL build and `exec` per export size. `exec` is nearly all of it.
- `settings`: insert cost with each `--settings name=value` applied in turn.
- `views`: drops every materialized view on the source table, then adds each back alone and times
  the insert. With `parallel_view_processing` on, the marginals no longer add up to the total.
- `sustained`: back-to-back traces exports, listing every insert over 500 ms. Background merges
  and part cleanup show up here; short runs end before the first cleanup pass and prove nothing.

`--set name=value` applies a session setting to every section, `--chdb-config none|<file>`
swaps the generated config, and `--skip stages,settings,views,sustained` drops sections.

## What the 2026-10-28 runs found

Reports are in `docs/benchmarks/local-ingest-*-2026-10-28-{before,after}.json` (Apple M-series,
10 cores, load average 5 to 20 from other work).

- A traces insert feeds 28 views and ran them one after another: ~100 ms for one span, against
  ~6 ms with no views. `parallel_view_processing = 1` brings it to ~30 ms.
- chDB cleans merged-away parts every 30 to 40 s on 128 threads. Under steady traces ingest each
  pass deleted thousands of parts and stalled single inserts for up to ~14 s. The generated config cleans
  every second on 4 threads; the worst stall dropped to ~3 s, though the number of inserts over
  500 ms barely changed. chDB ignores `--merge_tree.*` arguments, so this needs a config file.
- The remaining tail is background merges on chDB's 2-thread pool. The same spans in fewer,
  larger inserts stall about half as long in total, which is the case for coalescing concurrent
  requests into one insert per datasource.
