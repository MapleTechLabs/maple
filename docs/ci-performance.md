# CI performance

The baseline is [CI run 35671651855](https://github.com/MapleTechLabs/maple/actions/runs/35671651855):
10m16s end to end, including runner queueing. The package-test job took 484s,
with 439s in its test step. Backend alone took 330.55s across 148 files;
UI took 94.87s across 73 files. Fixed API/web sharding missed the backend
when services moved out of API, leaving the longest suite unsharded.

`.github/scripts/plan-tests.py` now discovers workspace test scripts from the
root workspace patterns and tracked manifests. It sizes Vitest shards against
a 100s estimated test budget and packs small suites into lanes with the same
budget. Backend uses a measured, conservative 3s/file estimate, web 0.8s/file,
and other suites 1.5s/file, plus startup overhead. File counts deliberately
include all tracked test/spec files: this can overestimate a suite, but never
filters the tests actually executed. Each lane invokes the original package
scripts through Turbo; Vitest owns discovery and shard assignment.

The current inventory produces 21 test lanes, including five backend shards.
A synthetic fivefold increase in files produces 82 lanes with the same Vitest
work budget. The planner tests run in change detection and verify complete,
nonduplicated workspace ownership, contiguous shard coverage, bounded estimates,
automatic inclusion of new workspaces, and the matrix limit. Run locally with:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_plan_tests.py'
python3 .github/scripts/plan-tests.py
```

Each runner executes one Turbo task at a time and at most two Vitest workers.
This avoids nested CPU oversubscription and bounds simultaneous PGlite instances.
Isolation and existing test assertions remain enabled. Each lane retains its own
Turbo cache; shard arguments participate in task hashes. Knip has its own lane.
The required `CI passed` check includes the dynamic test matrix.

`run-tests.py` writes elapsed time to the job summary and fails above 240s,
including cold dependency builds. The step also has a five-minute hard timeout.
This catches slower tests added inside existing files, which file-count sizing
cannot predict. Investigate a budget failure using the Vitest file timings:
fix unnecessary real waits/repeated setup, split an oversized file, or update
the measured per-file estimate. Do not simply increase the runtime budget.

Bun-native CLI and otel-helper tests retain their own unsharded lanes and original
arguments; Rust and the standalone Slack agent retain their dedicated workflows.
The runtime budget still applies to the Bun lanes. If those suites grow beyond it,
they need runner-specific splitting rather than Vitest flags.

The file-count projection is a capacity model; the measured fivefold suite run
below validates the test setup separately. More shards
consume more runner setup time and require available organization concurrency;
[GitHub schedules matrix jobs according to runner availability](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymatrix).
No change to a matrix can guarantee constant end-to-end latency with fixed runner
capacity. Compare the first cold and warm runs after merging against the linked
baseline, recording queue delay, longest test lane, total runner minutes, and
cache hits. The first run creates new lane caches. If queueing dominates, adjust
runner capacity or reduce repeated setup before adding further shards.

## Measured Vitest and fixture improvements

The indexed PGlite fixture replaces per-test tar extraction with a precomputed
filesystem tree. A CPU profile of `AlertsService.test.ts` showed repeated
`analyzePath`, `lookupPath`, and path normalization among the main costs.
The fixture has 1,375 files but only 27 directories: the previous loader checked
each file's ancestors again on every database boot. `FixtureMemoryFS` creates
those directories once and copies the fixture bytes into a new MEMFS instance.
Database instances, SQL transactions, rows, DDL, and session settings stay isolated.
No test module isolation was disabled and no live database is pooled.

Global setup caches the fixture by PGlite package metadata, V8 version, migration
names/content, and fixture format. It provides the selected path to workers, so
they do not import the migrator and hash the SQL again. Atomic writes prevent
partially written fixtures; unique staging names also cover concurrent projects.
The isolation tests verify that one database's DDL and session settings do not
leak into another, and that a cache hit does not rewrite the fixture.

UI defaults to Node, with explicit `@vitest-environment jsdom` directives on the
DOM suites. Pure calculations no longer initialize a browser environment.

The measurements below use the same worker count before and after. They exclude
installation/build time and GitHub queueing, and are single paired runs rather
than statistical confidence intervals. [Recorded results](benchmarks/ci-2026-09-22.json)
include versions, counts, CPU time, memory, and an outcome fingerprint.

| Workload                                              |   Before |   After | Reduction |
| ----------------------------------------------------- | -------: | ------: | --------: |
| Full backend, Linux, 2 CPUs / 2 workers               |  214.61s | 153.83s |     28.3% |
| Full UI, same Linux container                         |   23.38s |  16.80s |     28.1% |
| 5× backend, macOS, 2 workers                          |  433.26s | 323.99s |     25.2% |
| Fresh database boot, Linux, mean of 29 warmed samples | 117.70ms | 63.47ms |     46.1% |

Linux used `node:24.18.0-bookworm-slim` on arm64, capped at two CPUs and 6 GiB,
with Bun 1.4.0 and Vitest 4.1.10. Original test outcomes were preserved: backend
passed 1,808 original tests plus two new fixture tests, and UI passed all 674.
API (441) and AI (679) also passed against the new shared fixture.

The fivefold run executed five independent Vitest projects over the entire
backend suite: **9,050 passed, 890 existing integration/environment skips**, in
both runs. Every test identity and pass/skip outcome matched. Both runs used the
same snapshot cache and Node compile-cache setting; the only restore change was
tar versus indexed MEMFS. Node compile caching is not enabled in the shipped
configuration: it did not improve the separate Linux full-suite experiment.
Reported peak child RSS remained about 2 GiB for backend; this is not aggregate
container RSS, and no memory reduction is claimed.

Reproduce repeated runs using the checked-in runner:

```sh
python3 scripts/ci/benchmark-vitest.py --suite backend --workers 2 --runs 3 --output /tmp/backend-bench
python3 scripts/ci/benchmark-vitest.py --suite backend --copies 5 --workers 2 --runs 3 --output /tmp/backend-5x-bench
python3 scripts/ci/benchmark-vitest.py --suite ui --workers 2 --runs 3 --output /tmp/ui-bench
```

Run baseline and candidate sequentially on the same otherwise idle machine,
with the same Node/Bun versions, built dependencies, environment, and cache
settings. The runner writes logs, Vitest JSON, and a timing summary; it repeats
real tests via isolated projects and removes the temporary config afterwards.
A failed suite stops the benchmark and returns failure. It was smoke-tested with
two copies of UI: all 1,348 tests passed.

Workflow lint, planner/runner tests, source lint, and formatting pass. The backend
`typecheck:test` command has 218 existing diagnostics; the diagnostic set was
unchanged and none are in the modified fixture files. These suite measurements
do not claim a post-merge GitHub end-to-end time: compare that against the linked
CI run once the workflow executes on GitHub.

## Vitest 5 upgrade

The workspace catalog now uses Vitest 5.0.1, including `lib/unitflow`, which
previously declared its own version. Node 24.18.0 and Vite 8.2.2 already meet
the new requirements. The Effect adapter now uses Vitest's public `TestRunner`
API; the remaining patch defers that lookup for Bun's Vitest shim and preserves
the existing abort-signal guard. Vitest 5's default mock cleanup is retained.

Execution evals now install the shared PGlite global setup too. Collection was
validated with a placeholder credential and an unmatched test-name filter:
all 44 cases collected without running model calls. Browser tests still use
jsdom; Browser Mode is a separate migration to a real browser provider.

The optimization comparisons above were measured on Vitest 4.1.10. They are
not measurements of the version upgrade itself.

All 38 JavaScript workspace test commands passed on the upgrade: 11,216 Vitest
tests and 596 Bun-native tests. Existing environment-gated skips were retained.
The backend test typecheck has the identical 218 diagnostics as before the
upgrade. [Upgrade validation results](benchmarks/vitest-5-2026-09-22.json)
record each suite and its report hash.

The upgraded runner also passed the fivefold backend workload: 9,050 passed,
890 existing skips, zero failures, in 281.60 seconds with two workers on macOS.
This run did not enable Node compile caching; the earlier Vitest 4 fivefold run
did, so the elapsed times are not a controlled comparison of Vitest versions.
