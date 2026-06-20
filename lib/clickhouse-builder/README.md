# @maple-dev/clickhouse-builder

A type-safe, immutable ClickHouse SQL query builder for TypeScript.

- **Type-safe** — define a table once and the query builder infers column types,
  output row shapes, and join accessors. No stringly-typed columns.
- **Immutable & composable** — every builder method returns a new query; share
  and extend base queries without surprises.
- **ClickHouse-native** — first-class helpers for the functions you actually use
  (`quantile`, `toStartOfInterval`, `mapGet`, window functions, …) plus escape
  hatches (`rawExpr`, `unsafeCompiledQuery`) for anything not yet modeled.
- **Parameterised compilation** — compile to a SQL string with named params
  resolved and string literals escaped.

Built on [Effect](https://effect.website) (peer dependency).

## Install

```bash
bun add @maple-dev/clickhouse-builder effect
# or: npm i @maple-dev/clickhouse-builder effect
```

`effect` is a peer dependency — bring your own.

## Quick start

```ts
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

// 1. Describe a table
const Events = CH.table("events", {
	OrgId: T.string,
	Name: T.string,
	Timestamp: T.dateTime,
	DurationMs: T.uint64,
	Attributes: T.map(T.string, T.string),
})

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
	.orderBy("count", "desc")
	.limit(50)

// 3. Compile to SQL (params resolved, literals escaped)
const compiled = CH.compile(query, {
	orgId: "org_123",
	startTime: "2026-01-01 00:00:00",
})

compiled.sql // -> SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, ...
const rows = compiled.castRows(await runOnClickHouse(compiled.sql))
```

## Entry points

| Import | Contents |
| --- | --- |
| `@maple-dev/clickhouse-builder` | Curated public API: `from`, `compile`, `param`, expression helpers, and ClickHouse functions under friendly names (`min`, `max`, `count`, `quantile`, …). |
| `@maple-dev/clickhouse-builder/types` | Column-type constructors (`string`, `uint64`, `dateTime`, `map`, `array`, `nullable`, …) and the `CH*` type descriptors. |
| `@maple-dev/clickhouse-builder/expr` | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `toStartOfInterval`, `dynamicColumn`, …). Handy for `import * as CH`. |
| `@maple-dev/clickhouse-builder/sql` | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments. |

## Extending with custom functions

```ts
import { defineFn } from "@maple-dev/clickhouse-builder"

// Declare any ClickHouse function not already wrapped.
const toStartOfFiveMinute = defineFn<[CH.Expr<string>], string>("toStartOfFiveMinute")
```

## License

MIT
