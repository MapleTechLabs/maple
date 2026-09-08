# Recipes

These examples use the `Events` and `Services` declarations from
[Getting started](./getting-started.md#shared-tables-used-by-the-guides). Save that block as
`schema.ts`, then place a recipe next to it. Each recipe is a complete file that compiles SQL
without a database. Execute its `compiled.sql` using [your client](./running-queries.md).

## Time buckets over a bounded interval

Use a half-open range (`start <= Timestamp < end`) so adjacent windows do not overlap.
Filter the raw timestamp and group by its bucket, rather than filtering only a transformed date.
These examples assume UTC timestamps.

```ts title="time-buckets.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"
import { Events } from "./schema"

const query = CH.from(Events)
	.select(($) => ({
		bucket: CH.toStartOfInterval($.Timestamp, 300),
		count: CH.count(),
		p95: CH.quantile(0.95)($.DurationMs),
	}))
	.where(($) => [
		$.OrgId.eq(CH.param.string("orgId")),
		$.Timestamp.gte(CH.param.dateTime("startTime")),
		$.Timestamp.lt(CH.param.dateTime("endTime")),
	])
	.groupBy("bucket")
	.orderBy(["bucket", "asc"])

export const compiled = await Effect.runPromise(
	CH.compile(query, {
		orgId: "org_123",
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 01:00:00",
	}),
)
console.log(compiled.sql)
```

The interval is in seconds: `300` produces five-minute buckets. Empty buckets are absent;
fill gaps in your application if the chart needs zeros. A decoded bucket is `DateTime.Utc`,
not a native `Date`; use Effect's `DateTime` utilities or a string timestamp type to serialize it.
Validate a user-selected bucket size as a positive integer and cap the number of buckets.

Per `schema-pk-filter-on-orderby`, performance depends on whether the real table's sorting key
supports these filters. Declaring a TypeScript table does not create an index or make a scan cheap.
See [ClickHouse query optimization](https://clickhouse.com/docs/optimize/query-optimization).

## Optional filters and empty lists

Keep all predicates in one WHERE callback. This example treats an empty name list as “no name
filter” and preserves the mandatory tenant/time filters. If an empty selection means “no results”
in your product, return an empty result before executing instead.

```ts title="optional-filters.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"
import { Events } from "./schema"

export const buildQuery = (names: readonly string[], minDurationMs?: number) =>
	CH.from(Events)
		.select(($) => ({ name: $.Name, durationMs: $.DurationMs }))
		.where(($) => [
			$.OrgId.eq(CH.param.string("orgId")),
			$.Timestamp.gte(CH.param.dateTime("startTime")),
			$.Timestamp.lt(CH.param.dateTime("endTime")),
			CH.whenTrue(names.length > 0, () => $.Name.in_(...names)),
			CH.when(minDurationMs, (minimum) => $.DurationMs.gte(minimum)),
		])
		.orderBy(["durationMs", "desc"])
		.limit(50)

export const compiled = await Effect.runPromise(
	CH.compile(buildQuery(["checkout"], 0), {
		orgId: "org_123",
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-02 00:00:00",
	}),
)
console.log(compiled.sql)
```

`CH.when(0, ...)` includes the predicate; it skips `undefined`, `null`, and `false`, not every
falsy value. Values passed to `.in_()` are escaped. Check range and allowed-value constraints
at your input boundary before calling `buildQuery`.

## Filter aggregates with HAVING

Use `where` to choose events, then `having` to choose groups by their aggregated count.

```ts title="aggregate-filter.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"
import { Events } from "./schema"

const query = CH.from(Events)
	.select(($) => ({ name: $.Name, count: CH.count() }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.groupBy("name")
	.having(() => [CH.dynamicColumn("count", T.uint64).gte(CH.param.int("minimumCount"))])
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(20)

export const compiled = await Effect.runPromise(
	CH.compile(query, {
		orgId: "org_123",
		minimumCount: 10,
	}),
)
console.log(compiled.sql) // ... GROUP BY name HAVING count >= 10 ORDER BY ...
```

`count` is an output alias, so it is not on the input accessor `$`. Keep the string passed to
`dynamicColumn` under application control. Add time bounds when the endpoint needs a bounded scan.

## Paginate a grouped result

For a small grouped result, a deterministic ordering and offset are straightforward. Grouping
makes `name` unique in this result, so it breaks ties between equal counts.

```ts title="pagination.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"
import { Events } from "./schema"

const pageSize = 25
const pageIndex = 1 // zero-based: the second page
const query = CH.from(Events)
	.select(($) => ({ name: $.Name, count: CH.count() }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(pageSize)
	.offset(pageIndex * pageSize)

export const compiled = await Effect.runPromise(CH.compile(query, { orgId: "org_123" }))
console.log(compiled.sql) // ... LIMIT 25 OFFSET 25
```

Validate page sizes and indices as bounded non-negative integers before constructing a query.
An offset is not a cursor: concurrent inserts can shift pages, and large offsets still require
work. For a raw event feed, use a fixed time range and a cursor over a unique, stable sort key
(such as timestamp plus event ID). The builder does not create or validate cursors for you.

## Preserve large integer IDs

Keep a numeric column numeric in its table declaration. Convert its projection to text before
JSON parsing could lose precision. This also works for IDs produced by numeric hash functions.

```ts title="large-ids.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

const Records = CH.table("records", { Id: T.uint64, Name: T.string })
const query = CH.from(Records)
	.select(($) => ({ id: CH.toString($.Id), name: $.Name }))
	.limit(1)

export const compiled = await Effect.runPromise(CH.compile(query, {}))
export const rows = await Effect.runPromise(
	compiled.decodeRows([{ id: "18446744073709551615", name: "checkout" }]),
)
console.log(rows[0]?.id) // "18446744073709551615", preserved as a string
```

Do not convert that string back to `number`. Use `BigInt(id)` for exact integer arithmetic
outside JSON, or leave it as a string for identity and transport. Do not use `param.int` for an
unsafe integer value; it deliberately accepts only safe JavaScript integers.
