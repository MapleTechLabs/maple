# Getting started

Build and decode your first query without connecting to a database. Then follow
[Running a query](./running-queries.md) to execute one against ClickHouse.

## Installation and compatibility

This is an ESM-only TypeScript package built on **Effect 4**. You do not need an
Effect application: `Effect.runPromise` lets you use it from ordinary async code.
These examples are checked against Effect `4.0.0-rc.111` and the builder in this repository.
The package declares `effect >=4.0.0-rc.111 <5` as a peer dependency; Effect 3 is incompatible.

**First release pending.** The package has not been published to npm yet. The registry
command below is for the upcoming release. To try the current source now, build a tarball
from the repository:

```sh
git clone https://github.com/MapleTechLabs/maple.git
cd maple
bun install --frozen-lockfile
bun run --cwd lib/effect-clickhouse build
cd lib/effect-clickhouse
bun pm pack
```

Install the resulting `.tgz` into your own project with its peer dependency:

```sh
npm install /absolute/path/to/the-generated-package.tgz effect@4.0.0-rc.111
```

Repository access is required for this path. Once the package is available on npm,
the equivalent registry install is:

```sh
npm install @maple-dev/effect-clickhouse effect@4.0.0-rc.111
# or: bun add @maple-dev/effect-clickhouse effect@4.0.0-rc.111
```

Keep the Effect version explicit while adopting the prerelease. An unqualified `effect`
currently installs Effect 3. Use an ESM project (`"type": "module"` in `package.json`)
and a TypeScript runner such as Bun for the `.ts` files below. A database client is a
separate dependency, needed only when you execute SQL.

## A complete first example

Save this as `quick-start.ts` and run `bun quick-start.ts`. It builds SQL and decodes a sample
wire response; it does not need a server, credentials, or an existing table.

```ts title="quick-start.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-clickhouse"
import * as T from "@maple-dev/effect-clickhouse/types"

const Events = CH.table("events", {
	Name: T.string,
	DurationMs: T.uint64,
})

const query = CH.from(Events)
	.select(($) => ({
		name: $.Name,
		p95: CH.quantile(0.95)($.DurationMs),
		count: CH.count(),
	}))
	.where(($) => [$.DurationMs.gte(CH.param.int("minDurationMs"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(50)

export const compiled = await Effect.runPromise(CH.compile(query, { minDurationMs: 100 }))
console.log(compiled.sql)
console.log(compiled.rowSchemaSource) // "derived"

export const rows = await Effect.runPromise(compiled.decodeRows([{ name: "checkout", p95: 420, count: "3" }]))
console.log(rows) // [{ name: "checkout", p95: 420, count: 3 }]
```

The generated SQL is:

```sql
SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, count() AS count
FROM events
WHERE DurationMs >= 100
GROUP BY name
ORDER BY count DESC, name ASC
LIMIT 50
```

`table()` describes a table; it does not create it or check that the database has those columns.
The keys returned by `select` become both SQL aliases and result properties. This query infers
`{ name: string; p95: number | null; count: number }`: ClickHouse can return JSON `null` for an
aggregate with a non-finite result.

`compile` returns an Effect that must be run. Its parameters are validated and escaped into
the SQL string at compilation time. They are **not** ClickHouse server-side placeholders.
Use `compileUnsafe(query, params)` if synchronous throwing fits your caller instead.

The result schema is derived from the typed SELECT, so you do not need to write a second schema.
`count: "3"` becomes `count: 3`. Selecting an untyped expression can disable that derivation;
[Decoding results](./decoding-results.md) explains how to detect and repair it.

## Shared tables used by the guides

The later guides use `CH`, `T`, `Effect`, and these illustrative tables. Save this as `schema.ts`
when trying their query snippets. Their table and column names are case-sensitive contracts
with your own database. Replace them with your real schema before executing.

```ts title="schema.ts"
import * as CH from "@maple-dev/effect-clickhouse"
import * as T from "@maple-dev/effect-clickhouse/types"

export const Events = CH.table(
	"events",
	{
		OrgId: T.string,
		Name: T.string,
		Timestamp: T.dateTime,
		DurationMs: T.uint64,
		Attributes: T.map(T.string, T.string),
	},
	{ tenantColumn: "OrgId" },
)

export const Services = CH.table(
	"services",
	{
		OrgId: T.string,
		Name: T.string,
		Team: T.string,
	},
	{ tenantColumn: "OrgId" },
)
```

Tenant scoping is optional. The first example has no tenant column; the shared tables do.
Declaring `tenantColumn` adds scope analysis, not a WHERE clause or an authorization policy.
Always supply the tenant from your trusted application context. See [Tenant scoping](./tenant-scoping.md).

## Where to next

- [Running a query](./running-queries.md): a complete client example using `system.numbers`, with no table setup.
- [Recipes](./recipes.md): time buckets, optional filters, aggregate filters, pagination, and lossless IDs.
- [Tables and column types](./tables-and-types.md): model your actual schema and wire formats.
- [Troubleshooting](./troubleshooting.md): installation, compilation, decoding, and unexpected results.
