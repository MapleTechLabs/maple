# Running a compiled query

This package never touches the network. `compile` gives you a `CompiledQuery`: a SQL string, the
tenant scope it derived, and a decoder for the rows. Executing it is your client's job, and this
page is the missing half — the twenty lines that close the loop, with the two wire details the
column types already assume.

## A complete client example

For Node.js install `@clickhouse/client` separately:

```sh
npm install @clickhouse/client
```

This example reads five rows from ClickHouse's built-in `system.numbers` table. It creates no
schema and writes no data. Set `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, and
`CLICKHOUSE_PASSWORD` for your server; the defaults target a local server.

```ts title="run-query.ts"
import { createClient } from "@clickhouse/client"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-clickhouse"
import * as T from "@maple-dev/effect-clickhouse/types"

const client = createClient({
	url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
	username: process.env.CLICKHOUSE_USERNAME ?? "default",
	password: process.env.CLICKHOUSE_PASSWORD ?? "",
})

try {
	const Numbers = CH.table("system.numbers", { number: T.uint64 })
	const query = CH.from(Numbers).select("number").limit(5)
	const compiled = await Effect.runPromise(CH.compile(query, {}))
	const result = await client.query({
		query: compiled.sql,
		format: "JSONEachRow",
		clickhouse_settings: { max_execution_time: 30 },
	})
	const wire = await result.json<Record<string, unknown>>()
	const rows = await Effect.runPromise(compiled.decodeRows(wire))
	console.log(rows) // [{ number: 0 }, ..., { number: 4 }]
} finally {
	await client.close()
}
```

Run it with `bun run-query.ts` or your project's TypeScript runner. A connection failure here
is a client/server configuration issue; the offline example in [Getting started](./getting-started.md)
can still compile and decode without a server.

The one-shot script closes the client even on failure. In a long-running Node service, share a
client and close it during shutdown. The official client uses a connection pool. For Workers or
other fetch-based runtimes use `@clickhouse/client-web`; follow your runtime's resource lifetime.
Keep database credentials on your server, rather than shipping them in frontend code.
See the [official JavaScript client documentation](https://clickhouse.com/docs/integrations/language-clients/js/index).

## Formats and numeric precision

Pass `format: "JSONEachRow"` to the client and leave `.format()` off the builder query.
The client's `result.json()` returns an array for this format. For `FORMAT JSON`, the raw HTTP
response is an envelope with a `data` array; that array, not the whole envelope, is what the
decoder accepts. Consume each client result body once.

You do not need `output_format_json_quote_64bit_integers: 0` for decoding: the numeric codecs
accept both quoted and unquoted numbers. Both decode into JavaScript `number`, so **neither
choice preserves arbitrary 64-bit integers**. For IDs, hashes, or exact large counters, select
`CH.toString($.Id)` and keep the result as a string. Do not relabel a numeric database column as
`T.string` without converting its SELECT expression. See the [lossless ID recipe](./recipes.md#preserve-large-integer-ids).

## Error boundaries

There are three independent failure stages:

| Stage                          | What failed                                                     | What to do                                                |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
| `CH.compile`                   | Missing or invalid parameter (`QueryBuilderError`)              | Validate inputs or fix the param bag.                     |
| `client.query` / `result.json` | Connection, credentials, server SQL error, or response parsing  | Inspect the client error and server query ID.             |
| `compiled.decodeRows`          | Wire rows disagree with the schema (`CompiledQueryDecodeError`) | Inspect `rowIndex`, aliases, nullability, and wire types. |

`Effect.runPromise` bridges to normal Promise rejection. Inside an Effect application,
`yield* CH.compile(...)` and `yield* compiled.decodeRows(...)` preserve their typed errors;
see [handling compilation failures](./params-and-compilation.md#handling-compilation-failures).
Wrapping the database client in Effect is an application integration choice: preserve the
client cause in your own typed error and forward cancellation with the client's `abort_signal`.

`compiled.tenantScope` is metadata, not an execution gate. For tenant-scoped endpoints, check
it before sending SQL and derive tenant values from authenticated context. A correctly scoped
query for the wrong tenant is still unauthorized.

## Attaching `SETTINGS`

The query DSL has no `.settings()` method: query settings are an execution
concern, and the builder does not execute. Most clients take them out of band, which is what the
example above does.

When they have to travel _in the SQL_ — a gateway that forwards a statement verbatim, an endpoint that accepts one SQL string — the `/sql` subpath has the two functions for it:

```ts
import { parseStatement, withSettings } from "@maple-dev/effect-clickhouse/sql"

const statement = withSettings(
	parseStatement(compiled.sql),
	"SETTINGS max_execution_time = 30, max_threads = 4",
)
statement.text // the body, then SETTINGS, then FORMAT
```

`parseStatement` splits a statement into `body` / `settings` / `format` and `renderStatement` (or
`.text`) puts it back together **in that order** — `SETTINGS` before `FORMAT`, which is the order
ClickHouse accepts and the inverse of what string concatenation gives you. It is total: any string
has a body, so a statement with no terminal clauses round-trips unchanged. `withFormat` is the
same edit for the format clause, and `ClickHouseStatementFromString` is the pair as a codec, for a
boundary that stores a statement as text but wants the parsed shape in hand.

Appending `SETTINGS …` to `compiled.sql` by hand is the thing to avoid: a query that already ends
in `FORMAT JSON` — anything built with `.format(…)` — produces a syntax error, and a body ending in
a `--` comment swallows whatever you appended.

_(Backed by `docs/running-queries.md > SETTINGS precede FORMAT whatever order you add them in`.)_

## Cost profiles, retries, tenancy

None of that is here on purpose. A `CompiledQuery` is a value: it can be cached, logged,
fingerprinted, or handed to a different executor per tenant, and every one of those policies
belongs to the application rather than the builder. What the builder guarantees is that the value
describes itself — its SQL, its tenant scope, and how its rows decode.

## Benchmark a query change

Use the [benchmarking guide](./benchmarking.md) to turn a query into a repeatable
workload, record a baseline, verify results, and compare read volume, memory, and
latency. The bundled `ch-bench` CLI handles execution and saved evidence. For an
automated optimization workflow, follow the [agent playbook](./benchmark-agent.md).
