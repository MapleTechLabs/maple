# @maple-dev/effect-clickhouse

Type-safe ClickHouse queries, result decoding, and reproducible benchmarks for Effect and TypeScript.

[Read the documentation](https://effect-clickhouse.maple.dev) ·
[Getting started](./docs/getting-started.md) · [Recipes](./docs/recipes.md)

- **Schema-first** — a column type _is_ an Effect `Schema`, so a query compiles
  to its own row schema. `decodeRows` validates without you writing one, and the
  wire quirks (64-bit ints arriving quoted, tz-less DateTimes) are modelled once
  in the types rather than rediscovered per consumer.
- **Type-safe** — define a table once and the query builder infers column types,
  output row shapes, and join accessors. No stringly-typed columns.
- **Immutable & composable** — every builder method returns a new query; share
  and extend base queries without surprises.
- **ClickHouse-native** — first-class helpers for the functions you actually use
  (`quantile`, `toStartOfInterval`, `mapGet`, window functions, …) plus escape
  hatches (`rawExpr`, `rawCompiledQuery`) for anything not yet modeled.
- **Parameterised compilation** — compile to a SQL string with named params
  resolved and string literals escaped. A param with no value, or a value of the
  wrong kind, fails the compile instead of reaching the server.

Built on [Effect](https://effect.website) (peer dependency).

## Install

**First npm release pending.** The command below applies after publication. To try it now,
use the [source-build installation](./docs/getting-started.md#installation-and-compatibility).

```bash
bun add @maple-dev/effect-clickhouse effect@4.0.0-rc.111
# or: npm i @maple-dev/effect-clickhouse effect@4.0.0-rc.111
```

`effect` is a peer dependency — bring your own. The explicit version matters: this package
requires **Effect 4** (`>=4.0.0-rc.111`), which is not on npm's `latest` tag.
Installing a bare `effect` gets you 3.x, and the package will throw
`Schema.TaggedError is not a function` on import.

## Quick start

```ts
import * as CH from "@maple-dev/effect-clickhouse"
import * as T from "@maple-dev/effect-clickhouse/types"

// 1. Describe a table
const Events = CH.table(
	"events",
	{
		OrgId: T.string,
		Name: T.string,
		Timestamp: T.dateTime,
		DurationMs: T.uint64,
		Attributes: T.map(T.string, T.string),
	},
	// Optional: name the column carrying row-level tenancy and every compiled
	// query reports whether it pinned it. See docs/tenant-scoping.md.
	{ tenantColumn: "OrgId" },
)

// 2. Build a query
const query = CH.from(Events)
	.select(($) => ({
		name: $.Name,
		p95: CH.quantile(0.95)($.DurationMs),
		count: CH.count(),
	}))
	.where(($) => [
		$.OrgId.eq(CH.param.string("orgId")),
		$.Timestamp.gte(CH.param.dateTime("startTime")),
		CH.when(true, () => $.Name.like("checkout%")),
	])
	.groupBy("name")
	.orderBy(["count", "desc"])
	.limit(50)

// 3. Compile to SQL (params resolved, literals escaped)
const compiled = CH.compileUnsafe(query, {
	orgId: "org_123",
	startTime: "2026-01-01 00:00:00",
})

compiled.sql // -> SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, ...
```

## Decoding results

Run the SQL with your own ClickHouse client, then hand the rows back to
`decodeRows`. The row schema comes from the query itself — every column type is
a `Schema`, so the SELECT already describes its own rows:

```ts
import { Effect } from "effect"

const compiled = CH.compileUnsafe(query, { orgId: "org_123", startTime: "2026-01-01 00:00:00" })

compiled.rowSchemaSource // "derived"
const result = await client.query({ query: compiled.sql, format: "JSONEachRow" })
const rows = await Effect.runPromise(compiled.decodeRows(await result.json()))
// -> ReadonlyArray<{ name: string; p95: number | null; count: number }>
```

`client` is your own ClickHouse client — the builder brings none.
[Running a query](./docs/running-queries.md) has the full loop and the wire settings that go
with it.

`count()` is a `UInt64`, which ClickHouse's `FORMAT JSON` quotes and a gateway with
`output_format_json_quote_64bit_integers=0` does not — the
column type accepts either, so the same code works against both backends. That
is the class of drift a bare cast used to hide, which is why there is no
`castRows`.

Pass a `rowSchema` explicitly to **narrow** what the builder inferred (a `String`
column as a literal union, say); it wins over the derived one. If any selected
expression has no type to read — an `untypedExpr`, a `defineUntypedFn` —
nothing is derived, `rowSchemaSource` is `"none"`, and `decodeRows` degrades to
a pass-through rather than pretending.

Compilation itself is Effect-returning: a param with no value, or a value the
column cannot hold, is a `QueryBuilderError` in the error channel rather than a
throw, so a route can `catchTag` it instead of crashing. `compileUnsafe` is the
throwing variant, for a fixture or a catalog sweep where a query that will not
compile should fail loudly. A bug inside a callback stays a defect either way.

`decodeFirstRow` is the point-lookup variant, returning `Option<Output>` so you
don't hand-roll `rows[0] ?? null`. Both fail with `CompiledQueryDecodeError`,
which carries the offending `rowIndex`. When a query does derive nothing,
`untypedColumns` names the selected aliases responsible.

`encodeRows` runs the same schema backwards, turning decoded rows into the wire
shape ClickHouse sent. That is what lets a service hold the good value in memory
and still emit the bytes its own clients parse: a `DateTime` column decoded to a
`DateTime.Utc` re-encodes to `'YYYY-MM-DD hh:mm:ss'`, not to ISO-8601, because
the column's codec is the authority on both directions.

## Documentation

Full guides live in [`docs/`](./docs/README.md):

| Guide                                                      | What it covers                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| [Getting started](./docs/getting-started.md)               | Install, define a table, build → compile → decode               |
| [Tables and column types](./docs/tables-and-types.md)      | `table()`, column-type constructors, `Map`/`Array`/`Nullable`   |
| [Building queries](./docs/queries.md)                      | `select`, `where`, `groupBy`, `orderBy`, `limit`, immutability  |
| [Expressions and conditions](./docs/expressions.md)        | Comparisons, arithmetic, optional predicates, aggregates        |
| [Joins and subqueries](./docs/joins-and-subqueries.md)     | The join family, `fromQuery`, correlated subqueries             |
| [Unions and CTEs](./docs/unions-and-ctes.md)               | `unionAll`, `fromUnion`, `withCTE`                              |
| [Params and compilation](./docs/params-and-compilation.md) | `param.*`, how values reach the SQL, `CompiledQuery`            |
| [Decoding results](./docs/decoding-results.md)             | `rowSchema`, `decodeRows`, decode errors                        |
| [Running a query](./docs/running-queries.md)               | Executing the SQL with a real client, wire settings, `SETTINGS` |
| [Tenant scoping](./docs/tenant-scoping.md)                 | `tenantColumn`, what marks a query scoped, `crossTenant()`      |
| [Extending the DSL](./docs/extending.md)                   | `defineFn`, raw escape hatches, handwritten SQL                 |
| [API reference](./docs/reference.md)                       | Full export catalog by module, plus error types                 |

Named complete examples are extracted and checked by
[`scripts/check-doc-examples.mjs`](./scripts/check-doc-examples.mjs). Focused query and decoding
regressions live in [`src/docs-examples.test.ts`](./src/docs-examples.test.ts).

## Entry points

| Import                               | Contents                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple-dev/effect-clickhouse`       | Curated public API: `from`, `compile`, `param`, expression helpers, and ClickHouse functions under friendly names (`min`, `max`, `count`, `quantile`, …).                                       |
| `@maple-dev/effect-clickhouse/types` | Column-type constructors (`string`, `uint64`, `dateTime`, `map`, `array`, `nullable`, …) and the `CH*` type descriptors.                                                                        |
| `@maple-dev/effect-clickhouse/expr`  | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `toStartOfInterval`, `dynamicColumn`, …). Handy for `import * as CH`. |
| `@maple-dev/effect-clickhouse/sql`   | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments.                                                                                                      |

## Extending with custom functions

```ts
import type { DateTime } from "effect"
import { defineFn, sameAs } from "@maple-dev/effect-clickhouse"

// Declare any ClickHouse function not already wrapped. The second argument is
// the ClickHouse type it returns — required, because that is what lets a query
// using it still derive its row schema.
const toStartOfFiveMinute = defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>("toStartOfFiveMinute", T.dateTime)

// When the result type depends on the arguments — `min`, `argMax`, `coalesce`,
// `arrayJoin` all hand back one of their inputs — pass a rule instead:
// `sameAs(i)`, `firstTyped()`, `elementOf(i)`, `arrayOfArg(i)`.
const anyLast = defineFn<[CH.Expr<string>], string>("anyLast", sameAs(0))
```

## Validation

`bun run test` also extracts the named complete Markdown examples, typechecks them against
the public package exports, and runs the offline examples. Set `CLICKHOUSE_DOCS_LIVE=1` to
run the client example too, with `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, and
`CLICKHOUSE_PASSWORD` for its connection. Build the package before running these checks.

Run `bun run build`, `bun run typecheck`, and `bun run test` from this package. Tests include regressions for
nullable results, UNION column alignment, tenant scoping, custom parameters, and DateTime64 precision.
To include the live ClickHouse cases, set `EFFECT_CLICKHOUSE_TEST_URL` and, if needed,
`EFFECT_CLICKHOUSE_TEST_USER` and `EFFECT_CLICKHOUSE_TEST_PASSWORD`. They use only SELECTs and CTEs.

Use `bun run test:release` before publishing: it requires a live endpoint and checks the
build, types, tests, docs, and an isolated tarball consumer. `prepublishOnly` enforces
this check. See [Testing and release checks](./docs/testing.md) for the coverage manifest
and pinned ClickHouse version matrix.

## License

MIT

## Query benchmarks

The optional `@maple-dev/effect-clickhouse/benchmark` entry point and bundled
`ch-bench` CLI measure real queries, compare fixed workloads, and save evidence.
See [Benchmarking](docs/benchmarking.md) and the
[agent playbook](docs/benchmark-agent.md). The root SQL builder remains driver-free.
