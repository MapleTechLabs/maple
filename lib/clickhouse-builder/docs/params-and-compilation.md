# Params and compilation

## Declaring params

```ts
CH.param.string("orgId")
CH.param.int("limit")
CH.param.float("threshold")
CH.param.bool("includeDrafts")
CH.param.dateTime("startTime")
CH.param.dateTimeString("stringTimestamp")
CH.param.dateTimeSeconds("secondPrecisionTimestamp")
CH.param.of(T.uint64, "customNumber")
```

A param is an `Expr` placeholder usable anywhere an expression
is — most often on the right of a comparison:

```ts
.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
```

Calling a comparison method **on** an unresolved param (rather than passing it as an argument)
throws `QueryBuilderDefect`: there is nothing to compare yet, and which side of the comparison the
param sits on is written in the source, so no input can cause or avoid it. See
[Failures and defects](#failures-and-defects).

Param names must be alphanumeric, optionally separated by single underscores — the name travels
through the placeholder that `compile` later matches, and `__` would make its boundary
ambiguous. A name that cannot round-trip is a `QueryBuilderDefect` at declaration.

## What each kind accepts

The declared kind is checked when the value arrives, so a value of the wrong shape is a
compilation failure rather than SQL text that happens to contain it:

| Kind       | Accepts                                                | Emits                           |
| ---------- | ------------------------------------------------------ | ------------------------------- |
| `string`   | a string                                               | an escaped literal, `'org_123'` |
| `int`      | a safe integer                                         | `50`                            |
| `float`    | any finite number                                      | `0.95`                          |
| `bool`     | a boolean                                              | `1` / `0`                       |
| `dateTime` | `'YYYY-MM-DD hh:mm:ss'`, a `Date`, or a `DateTime.Utc` | `'2026-01-01 00:00:00'`         |

Each kind names a column type, and the value is encoded through that type's
schema — the same schema a column of that type decodes rows with, read backwards. The two
directions cannot drift, because there is only one of them.

`param.dateTime` and `param.dateTimeString` preserve milliseconds in `Date` and `DateTime.Utc`
values, as well as fractions already present in strings. Use `param.dateTimeSeconds` for a
whole-second DateTime bound, or `param.of(T.dateTime, name)` for the parsed UTC flavour.

`param.of` keeps each codec distinct even when several types share the same SQL name.
Reuse type definitions across queries when practical.

`param.of(type, name)` takes it further: any column type, including one you declared with
`T.custom`, works as a param.

```ts
const Level = T.custom("Enum8('warn' = 1, 'error' = 2)", Schema.Literals(["warn", "error"]))
const Logs = CH.table("logs", { Level })
const query = CH.from(Logs)
	.select("Level")
	.where(($) => [$.Level.eq(CH.param.of(Level, "level"))])

const compiled = await Effect.runPromise(CH.compile(query, { level: "warn" }))
// WHERE Level = 'warn'
// CH.compile(query, { level: "banana" }) fails when run: the codec rejects the value.
```

Compilation returns an `Effect`, so a value the query cannot accept is a typed failure rather
than a throw. That matters because these are runtime values: a param bag comes from a request
as often as from your own code, and a route that can `catchTag` a bad one can answer with a
400 instead of crashing.

Inside an `Effect.gen` program:

```ts
const byDuration = CH.from(Events)
	.select("Name")
	.where(($) => [$.DurationMs.gte(CH.param.int("minDurationMs"))])

const compiled = yield * CH.compile(byDuration, { minDurationMs: 100 })
// WHERE DurationMs >= 100
// Replacing 100 with 10.5 fails with code "InvalidLiteral".
// Passing {} fails with code "UnresolvedParam".
```

A throw that is _not_ a `QueryBuilderError` — a bug inside one of your callbacks — stays a
defect. Turning it into a typed failure would hand you a value to pattern-match on where the
honest answer is that something is broken.

`compileUnsafe` (and `compileUnionUnsafe`) throw instead, for the places where that is the
contract: a fixture or a catalog sweep should fail loudly rather than produce an entry nobody
notices is missing.

Params the query never mentions are ignored, so one bag of params can serve a family of
queries.

_(Backed by `src/ch/core-dsl.test.ts > param resolution`.)_

## How params are resolved

> **Params are resolved at compile time, not execution time.** `compile` substitutes each
> value into the SQL text. This is _not_ server-side parameter binding — ClickHouse never sees
> a placeholder.

```ts
const compiled = CH.compileUnsafe(query, { orgId: "org_123" })
compiled.sql // … WHERE OrgId = 'org_123'
```

Two consequences worth planning around:

- **Every distinct parameter set produces a distinct SQL string.** If you cache or fingerprint
  by SQL text, each value is its own entry.
- **Escaping is the safety mechanism**, not binding. String values go through
  `escapeClickHouseString`, which escapes backslashes and single quotes:

    ```ts
    CH.compileUnsafe(query, { orgId: "a'b\\c" })
    // … WHERE OrgId = 'a\'b\\c'
    ```

    Values flowing through `param.*` and the comparison methods are escaped. Values you splice
    in via [`rawExpr` / `rawCond`](./extending.md#raw-escape-hatches) are **not** — never build
    those from user input.

A query is a reusable template: compile the same one repeatedly with different params.

_(Backed by `docs/params-and-compilation.md > Params are resolved at compile time`,
`> String params are escaped`, `> One query, many parameter sets`.)_

## `compile`

```ts
CH.compile(query, params, options?)   // Effect<CompiledQuery, QueryBuilderError>
CH.compileUnsafe(query, params, options?)  // CompiledQuery, throws
```

| Argument              | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `query`               | The `CHQuery` to compile                                             |
| `params`              | Record resolving every `param.*` placeholder by name                 |
| `options.rowSchema`   | Effect `Schema` used by `decodeRows` / `decodeFirstRow`              |
| `options.skipFormat`  | Omit a trailing `FORMAT` clause (used internally for subqueries)     |
| `options.deferParams` | Leave placeholders unresolved, for SQL spliced into an outer compile |

`compileCH` is the internal name; the package exports it as `compile`. Unions use
`compileUnion(union, params)`.

## The `CompiledQuery`

```ts
interface CompiledQuery<Output> {
	readonly sql: string
	readonly tenantScope: "single-tenant" | "cross-tenant" | "untenanted"
	readonly rowSchemaSource: "declared" | "derived" | "none"
	readonly rowSchema: CompiledQueryRowSchema<Output> | undefined
	readonly untypedColumns: ReadonlyArray<string>
	readonly rowSchemaMismatch: RowSchemaMismatch | undefined
	readonly rawSql?: { readonly reason: string; readonly justification: string }
	readonly route?: string
	readonly decodeRows: (rows) => Effect<ReadonlyArray<Output>, CompiledQueryDecodeError>
	readonly decodeFirstRow: (rows) => Effect<Option<Output>, CompiledQueryDecodeError>
	readonly encodeRows: (rows) => Effect<ReadonlyArray<Record<string, unknown>>, CompiledQueryEncodeError>
}
```

| Field                           | Purpose                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `sql`                           | The statement to execute. The builder never runs it.                                     |
| `tenantScope`                   | Whether the query pins a single tenant — see [Tenant scoping](./tenant-scoping.md)       |
| `rowSchemaSource`               | Where the row schema came from, so a caller can tell real validation from a pass-through |
| `rowSchema`                     | The codec itself, for a caller that needs a `Schema` rather than a call                  |
| `untypedColumns`                | When `rowSchemaSource` is `"none"`, the selected aliases responsible                     |
| `rowSchemaMismatch`             | How a _declared_ schema disagrees with the SELECT by field name, when it does            |
| `rawSql`                        | Present only for `rawCompiledQuery`: the `reason` and `justification` it was given       |
| `route`                         | Set by `.route(tag)`; opaque metadata for your executor                                  |
| `decodeRows` / `decodeFirstRow` | See [Decoding results](./decoding-results.md)                                            |
| `encodeRows`                    | The same codec backwards — decoded rows to the wire shape                                |

There is deliberately **no `castRows`**. A bare cast looked type-safe while hiding wire-format
drift, so it was removed in favour of schema-checked decoding.

## Handwritten SQL

When you need SQL the builder cannot express, `rawCompiledQuery` wraps a string in the same
`CompiledQuery` interface so downstream code is uniform. `tenantScope` is required there,
because it cannot be inferred from a string. See [Extending the DSL](./extending.md).

## Failures and defects

Two classes, and the line between them is what a runtime value can reach.

`QueryBuilderError` describes a **value** the builder was handed and cannot turn into SQL. Code
that assembles a query from a request body can hit every one of these with correct code and bad
input, so `compile` puts them in the Effect error channel, catchable by the tag
`"@maple-dev/clickhouse-builder/QueryBuilderError"`:

| Code               | Cause                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `UnresolvedParam`  | A param the params bag has no value for                                  |
| `InvalidLiteral`   | A param value, or a comparison operand, the column's codec rejects       |
| `InvalidArguments` | Arguments a function cannot use — an empty condition list, a bad pattern |

`QueryBuilderDefect` describes a **call** that could not be right for any value: a query with no
`select()`, an `orderBy` entry that is not a tuple, a param name that is not an identifier, a
placeholder compared as if it were resolved.
No input reaches these; only a rewrite does — a missing `select()` is written in the query
definition, not steered by a request. `compile` maps
only `QueryBuilderError` into the error channel and dies on everything else, so a defect arrives
as a defect in the `Cause` — where a bug belongs, and where no `catchTag` can swallow it.

## Handling compilation failures

Use the full namespaced error tag with Effect 4's `catchTag`. This example deliberately omits
a required parameter and recovers only that typed builder failure; defects are not swallowed.

```ts title="compile-errors.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

const Events = CH.table("events", { Name: T.string })
const query = CH.from(Events)
	.select("Name")
	.where(($) => [$.Name.eq(CH.param.string("name"))])

export const outcome = await Effect.runPromise(
	CH.compile(query, {}).pipe(
		Effect.map((compiled) => ({ ok: true as const, sql: compiled.sql })),
		Effect.catchTag("@maple-dev/clickhouse-builder/QueryBuilderError", (error) =>
			Effect.succeed({ ok: false as const, code: error.code, message: error.message }),
		),
	),
)
console.log(outcome) // { ok: false, code: "UnresolvedParam", message: ... }
```

This is a demonstration result, not an HTTP error contract. In your service, map expected
failures to your domain errors at the boundary. Validate page sizes, bucket sizes, dates,
and allowed sort fields before query construction. Do not retry an invalid parameter.

`compile` captures builder failures raised while it evaluates query callbacks. A helper that
throws before you call `compile` is outside that boundary; avoid eagerly constructing unsafe
expressions from unchecked input.
