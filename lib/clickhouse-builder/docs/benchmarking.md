# Benchmarking ClickHouse queries

The package ships a driver-free `@maple-dev/clickhouse-builder/benchmark` API,
an HTTP adapter at `/benchmark/http`, and the `ch-bench` executable. The builder's
root import still does no networking. No Maple account or schema is required.

The executable runs on Node 22.18+ or Bun. For TypeScript suites with extensionless
imports or application path aliases, use Bun (`bun run ch-bench …`). With Node, use
JavaScript modules or TypeScript supported by Node's native type stripping, with
explicit import extensions. Suite modules execute trusted local code.

## Define a workload

```ts
import { compile, from, param, table } from "@maple-dev/clickhouse-builder"
import { uint32, string } from "@maple-dev/clickhouse-builder/types"
import * as Bench from "@maple-dev/clickhouse-builder/benchmark"

const events = table("events", { id: uint32, name: string })
const byName = from(events)
	.select("id", "name")
	.where(($) => [$.name.eq(param.string("name"))])

export default Bench.defineSuite({
	name: "events",
	dataset: "events-snapshot-v1",
	cases: [
		Bench.query({
			id: "events/by-name",
			inputs: { name: "checkout" },
			compile: (inputs) => compile(byName, inputs),
			results: "unordered",
		}),
	],
})
```

Save this as `queries.bench.ts`. Point it at an existing, populated dataset.
`query` creates an Effect; `defineSuite` compiles all cases before measurement.
Its default export is an Effect, which the CLI runs. Plain `Suite` values and JSON
suite files are also supported. `caseFromCompiled(id, compiled, inputs)` adapts an
already compiled query. Raw cases supply `id`, `inputs` (a canonical JSON string),
`context`, `profile`, `fingerprint`, and `sampleSql` directly.

Use stable IDs for experiments, independent of SQL fingerprints. Include all
parameters and builder options in `inputs`; use plain JSON values, converting
Dates, Sets, and Maps explicitly. Separate selective/unselective filters, different
windows, and capability routes into distinct cases. An input is part of the
experiment contract; changing it makes comparisons incompatible.

## Measure a change

```sh
export CLICKHOUSE_URL=http://localhost:8123
export CLICKHOUSE_USER=default
export CLICKHOUSE_PASSWORD=your-password
export CLICKHOUSE_DATABASE=default

ch-bench doctor --json
ch-bench run queries.bench.ts --runs 20 --warmup 2 --threads 2 \
  --out .bench/baseline.json --json
# Edit the query, retaining the case IDs and inputs.
ch-bench run queries.bench.ts --runs 20 --warmup 2 --threads 2 \
  --out .bench/candidate.json --json
ch-bench compare .bench/baseline.json .bench/candidate.json \
  --metric meanReadBytes --threshold 10 --min-delta 1048576 --json
ch-bench inspect .bench/candidate.json --case events/by-name \
  --out .bench/plans.json --json
```

Every `run` imports and compiles the current module in a fresh CLI process.
`export queries.bench.ts --out .bench/suite.json` explicitly freezes SQL for replay.
Replaying a frozen JSON suite does not pick up source changes. `--match` filters
case ID/context substrings; `--case` selects an exact ID. Empty selections fail.
`--dataset` overrides the suite's revision; `--source-revision` records a Git SHA or
other caller-supplied revision. Neither field creates a snapshot or detects data drift.

Credentials are read from the environment and are not written into artifacts.
Endpoints must be HTTP(S), without embedded credentials, query strings or fragments.
Reports contain literal SQL and input values; keep `.bench/` gitignored.

## Evidence and verdicts

Runs are serial, with rotating case order and excluded warmups. They measure
isolated-query behavior, not concurrent throughput. Reports retain each query ID,
full-response wall time, server time, read rows/bytes, result rows, memory,
`ProfileEvents`, exact executed SQL, controls, server version, and database.
Schema DDL is hashed before measurement where table metadata is accessible; row
counts and bytes are intentionally excluded from that hash. This detects DDL
changes, not dataset changes. `inspect` saves current plans and table metadata for
recorded SQL; it cannot recover historical plans and warns on a changed target/version.

Query logs are collected after timing, with `--log-wait` controlling the polling
window (each HTTP request is separately bounded). `--cluster` uses
`clusterAllReplicas`; without it logs are node-local. Missing logs retain HTTP
summary metrics, with missing memory/counters represented explicitly. A memory
budget cannot pass without memory measurements. Per the official
[query-log documentation](https://clickhouse.com/docs/reference/system-tables/query_log),
initial queries are selected to avoid double counting child queries.

Result and condition caches are disabled. `--cache warm` leaves filesystem and
uncompressed caches available; `--cache bypass` disables them per query. Neither
clears the OS page cache. `--threads` pins parallelism. Controls override matching
inline settings, preserving other settings. Queries use server-side `readonly=2`;
the tool does not seed data, create tables, flush global caches or deploy changes.

`results: "unordered"` hashes canonical JSON rows, retaining duplicates and ignoring
row order. `"ordered"` also checks order. `"skip"` explicitly skips verification.
Without a per-case mode, `--verify-results` and `--result-order` apply. Exact hashes
can differ for approximate aggregates, floating point changes, nondeterministic
ordering, or concurrent ingestion. Use domain parity tests when exact equality is
not appropriate. The comparison separately reports correctness as `verified`,
`different-or-unstable`, or `not-fully-verified`.

| Verdict        | Exit | Meaning                                                                              |
| -------------- | ---- | ------------------------------------------------------------------------------------ |
| `pass`         | 0    | All selected metric budgets pass the configured thresholds                           |
| `regression`   | 1    | At least one budget exceeds both percentage and absolute limits                      |
| `invalid`      | 2    | Failed/partial execution, incompatible experiment, changed results, or invalid input |
| `inconclusive` | 3    | Missing cases/metrics, or no dataset revision                                        |

Comparisons always gate; `--fail-on-regression` is accepted for existing scripts.
A pass is not a statistical significance claim or proof of correctness when
verification was skipped. Small-sample percentiles are noisy; zero-row reads warn
that the workload may be empty (metadata optimizations can also read zero rows).
Reports are written before failure. An ordinary query failure retains completed
cases and measurements plus the failed query ID when available. Forced process
termination is not checkpointed.

Multiple budgets are supplied with `--budgets budgets.json`:

```json
[
	{ "metric": "meanReadBytes", "thresholdPercent": 10, "minDelta": 1048576 },
	{ "metric": "meanMemoryUsage", "thresholdPercent": 10, "minDelta": 1048576 },
	{ "metric": "p95WallMs", "thresholdPercent": 15, "minDelta": 5 }
]
```

Other metrics: `meanServerMs`, `meanReadRows`. Missing measurements never become zeros.

## Programmatic API and machine output

`/benchmark` exports `query`, `defineSuite`, `caseFromCompiled`, `runSuite`,
`compareRuns` (one metric), `compareBudgets` (verdict across budgets), the Effect
schemas `Sample`, `Suite`, `RunMetrics`, `Aggregates`, `SampleResult`, `RunOutput`,
and `BenchmarkError`. `BenchmarkTransport` is the execution/log-collection port;
`RunOptions`, `BenchmarkProgress`, `ComparisonOptions`, `ComparisonMetric`,
`ComparisonRow`, `Verdict`, `BenchmarkInput`, `BenchmarkResponse`, and `LogMetrics`
describe the public contracts. SQL helpers (`benchmarkSql`, `explainSql`,
`validateReplaySql`) and measurement helpers (`aggregate`, `mean`, `percentile`,
`metricNumber`, `canonicalJson`, `sampleId`, `validateSuite`) are also available.

`/benchmark/http` exports `makeHttpClient(config)`, `httpConfigFromEnv`, and
`makeHttpTransport(client, options)`, plus `HttpConfig`, `decodeJson`, and
`decodeJsonLines`. The client exposes `query`, `run` (including non-200 responses),
`metadata`, `tables`, `target`, and `collectLogs`; every operation returns an Effect.
`/benchmark/cli` exports `runCli(args): Promise<number>` for application wrappers.
Only the executable sets `process.exitCode`.

With `--json`, stdout contains one JSON envelope:
`{ version: 1, command, artifact, result }`. Input/connection failures produce
`{ version: 1, command, verdict: "invalid", diagnostics }`. Progress events are
JSON lines on stderr with `version`, `type`, and `message`; round events include
`round` and `warmup`, and case failures include `caseId`. Keep suite modules silent
on stdout to preserve this contract. `schema --json` emits JSON Schema documents
for suite files, run reports and budget files. Version 1 run reports remain readable.

For the agent workflow, read [benchmark-agent.md](./benchmark-agent.md).
