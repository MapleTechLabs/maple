# Effect ClickHouse

`@maple-dev/effect-clickhouse` builds ClickHouse SQL from typed TypeScript. You describe a
table once, and the builder infers column types, output row shapes, and join accessors from
it. Queries are immutable values — every method returns a new query — and nothing touches the
network: the end product is a `CompiledQuery` holding a SQL string plus a typed decoder. You
bring your own ClickHouse client.

## Is this for your project?

Use the builder when you want typed ClickHouse SELECT queries, reusable query definitions,
and runtime result decoding in TypeScript. It works with an ordinary async application as
well as an Effect application. The database client remains your choice.

You do not need a Maple account, Maple's schema, or tenant columns. Tenant analysis is an
optional feature for applications that share tables between tenants.

The root builder does not manage connections, create tables, run migrations, insert rows, or provide
an ORM. It does not validate SQL against a live server, choose query plans, enforce authorization,
or supply retries. Existing ClickHouse tables and your executor own those responsibilities.
The first npm release is pending; [Getting started](./getting-started.md) includes a source-build
path and installation instructions for the upcoming release.

## Start here

1. [Compile and decode offline](./getting-started.md) with one complete file.
2. [Run a real query](./running-queries.md) against `system.numbers`, without creating a table.
3. [Adapt a recipe](./recipes.md) to your own schema.
4. [Benchmark a change](./benchmarking.md) with a fixed workload and saved baseline.
5. Consult [Troubleshooting](./troubleshooting.md) if installation or results differ from expectations.

The named complete examples are extracted from Markdown, typechecked, and exercised by
[`check-doc-examples.mjs`](../scripts/check-doc-examples.mjs). Focused behavior tests also live in
[`src/docs-examples.test.ts`](../src/docs-examples.test.ts). Client execution requires a server;
the offline checks verify SQL construction and decoding, not database execution plans.

## Guides

Roughly in reading order.

| Guide                                                 | What it covers                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Getting started](./getting-started.md)               | Install, define a table, build → compile → decode                                   |
| [Tables and column types](./tables-and-types.md)      | `table()`, the column-type constructors, `Map`/`Array`/`Nullable`                   |
| [Building queries](./queries.md)                      | `select`, `where`, `groupBy`, `orderBy`, `limit`, `format`, immutability            |
| [Expressions and conditions](./expressions.md)        | Comparisons, arithmetic, optional predicates, aggregates                            |
| [Joins and subqueries](./joins-and-subqueries.md)     | The join family, `fromQuery`, correlated subqueries                                 |
| [Unions and CTEs](./unions-and-ctes.md)               | `unionAll`, `fromUnion`, `withCTE`                                                  |
| [Params and compilation](./params-and-compilation.md) | `param.*`, how values reach the SQL, `CompiledQuery`                                |
| [Decoding results](./decoding-results.md)             | `rowSchema`, `decodeRows`, `decodeFirstRow`, decode errors                          |
| [Running a query](./running-queries.md)               | Executing the SQL with a real client, wire settings, `SETTINGS`                     |
| [Benchmarking](./benchmarking.md)                     | Define suites, measure baseline/candidate runs, verify results, and compare budgets |
| [Agent benchmark playbook](./benchmark-agent.md)      | Repeatable optimization workflow and evidence checklist                             |
| [Tenant scoping](./tenant-scoping.md)                 | `tenantScope`, what marks a query scoped, `crossTenant()`                           |
| [Extending the DSL](./extending.md)                   | `defineFn`, raw escape hatches, handwritten SQL                                     |

## Reference

- [Recipes](./recipes.md) — complete examples for everyday queries.
- [Troubleshooting](./troubleshooting.md) — common failures and sharp edges.

- [API reference](./reference.md) — the full export catalog by module, plus error types.

## Entry points

| Import                                        | Contents                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple-dev/effect-clickhouse`                | Curated public API — `from`, `compile`, `param`, expression helpers, and ClickHouse functions under friendly names (`min`, `max`, `count`, `quantile`, …) |
| `@maple-dev/effect-clickhouse/types`          | Column-type constructors (`string`, `uint64`, `dateTime`, `map`, `array`, `nullable`, …) and the `CH*` type descriptors                                   |
| `@maple-dev/effect-clickhouse/expr`           | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `dynamicColumn`, `not`, …)      |
| `@maple-dev/effect-clickhouse/sql`            | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments                                                                 |
| `@maple-dev/effect-clickhouse/benchmark`      | Driver-free suite definitions, runner, report schemas, and comparisons                                                                                    |
| `@maple-dev/effect-clickhouse/benchmark/http` | ClickHouse HTTP transport, environment configuration, and query-log collection                                                                            |
| `@maple-dev/effect-clickhouse/benchmark/cli`  | `runCli(args)` for embedding the bundled `ch-bench` commands                                                                                              |

The root barrel is curated, not exhaustive — see
[the reference](./reference.md#whats-only-on-a-subpath) for what lives only on a subpath.

## Query benchmarks

The optional `@maple-dev/effect-clickhouse/benchmark` entry point and bundled
`ch-bench` CLI measure real queries, compare fixed workloads, and save evidence.
See [Benchmarking](./benchmarking.md) and the
[agent playbook](./benchmark-agent.md). The root SQL builder remains driver-free.
