# Agent benchmark playbook

Objective: change a query and produce comparable, reviewable performance evidence.

1. Run `ch-bench --help` and `ch-bench doctor --json`. Check log and table-metadata
   availability; use `--cluster` when logs are spread across replicas.
2. Identify a populated, stable snapshot and fixed inputs. Record the snapshot
   revision in the suite. Do not benchmark the application's synthetic catalog as
   though it were a populated workload.
3. Define stable case IDs with `Bench.query` and `Bench.defineSuite`. Include query
   options and compile parameters in inputs. Choose ordered/unordered result checks
   per case, or document why exact verification must be skipped.
4. Run the baseline **before editing**. Use explicit artifact paths, `--json`, and
   identical controls for baseline and candidate. Keep credentials in environment
   variables. Compile the current module on each revision; JSON suites freeze SQL.
5. Make the change, measure the candidate, then compare saved reports offline. Use
   read volume, memory and latency budgets appropriate to the workload. Inspect the
   result's verdict and correctness independently. Exit 0 does not prove a speedup.
6. If evidence is inconclusive, inspect diagnostics and missing metrics. If results
   changed, run correctness/parity tests before claiming an optimization. If latency
   is noisy, collect more observations on the same stable workload.
7. Inspect the saved candidate SQL and plans with `inspect --case ID`. Plans describe
   the current server. Schema-hash mismatches invalidate query-only comparisons;
   a schema experiment requires a separately designed validation, not relabeling data.
8. Report the exact case, controls, dataset, metric deltas, correctness status,
   warnings, and artifact paths. Do not describe empty-table timings as evidence.

Commands do not create data or change schemas. Shared-server background activity
and data drift can affect results. Result/condition caches are disabled, while the
OS page cache is never cleared. Forced termination does not save a partial report;
ordinary query failures do preserve completed observations.

See [benchmarking.md](./benchmarking.md) for the API, options, and JSON protocol.
