# Tables and column types

## `table(name, columns)`

```ts
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

const Events = CH.table("events", {
	OrgId: T.string,
	Name: T.string,
	Timestamp: T.dateTime,
	DurationMs: T.uint64,
	Attributes: T.map(T.string, T.string),
})
```

`name` is emitted verbatim as the FROM target, so it can also name a CTE or a view. The
`columns` record is what every accessor, output type, and join is inferred from.

A table is a plain value — `{ _tag: "Table", name, columns }`. It is never checked against a
live server, so a column that does not exist in ClickHouse will typecheck happily and fail at
query time. Treat the declaration as a contract you keep in sync with your migrations.

## Column types

A column type is an Effect `Schema` plus the ClickHouse type name it stands for. That schema is
the single source of truth: the TypeScript column type is read off it, and `compile` folds the
selected columns' schemas into the row schema `decodeRows` validates against — see
[Decoding results](./decoding-results.md).

The constructors are values, not calls (except the parameterised ones):

| Constructor          | ClickHouse type   | Decodes to          | From the wire             |
| -------------------- | ----------------- | ------------------- | ------------------------- |
| `T.string`           | `String`          | `string`            | `string`                  |
| `T.uint8`            | `UInt8`           | `number`            | number or quoted number   |
| `T.uint16`           | `UInt16`          | `number`            | number or quoted number   |
| `T.uint32`           | `UInt32`          | `number`            | number or quoted number   |
| `T.uint64`           | `UInt64`          | `number`            | number or quoted number   |
| `T.int64`            | `Int64`           | `number`            | number or quoted number   |
| `T.int32`            | `Int32`           | `number`            | number or quoted number   |
| `T.float64`          | `Float64`         | `number`            | number or quoted number   |
| `T.bool`             | `Bool`            | `boolean`           | `true`/`false` or `1`/`0` |
| `T.dateTime`         | `DateTime`        | `DateTime.Utc`      | `YYYY-MM-DD hh:mm:ss`     |
| `T.dateTime64`       | `DateTime64`      | `DateTime.Utc`      | with a fractional part    |
| `T.dateTimeString`   | `DateTime`        | `string`            | unparsed, as sent         |
| `T.dateTime64String` | `DateTime64`      | `string`            | unparsed, as sent         |
| `T.map(k, v)`        | `Map(K, V)`       | `Record<string, V>` | object                    |
| `T.array(e)`         | `Array(E)`        | `ReadonlyArray<E>`  | array                     |
| `T.nullable(t)`      | `Nullable(T)`     | `T \| null`         | value or `null`           |
| `T.untyped(sql)`     | whatever you name | `unknown`           | unvalidated               |

Two of those deserve a note.

**64-bit integers.** ClickHouse's `FORMAT JSON` quotes them, a client that sets
`output_format_json_quote_64bit_integers=0` gets them bare, and a gateway
that refuses `output_format_json_quote_64bit_integers=0` quotes them regardless. Every integer
type accepts both and decodes to a `number` — which also means a `UInt64` above `2^53` cannot
survive: select `CH.toString($.Id)` while leaving the actual table column declared `T.uint64`.
The resulting expression has a string codec; see the [ID recipe](./recipes.md#preserve-large-integer-ids).

**DateTimes.** The parsed codecs interpret zone-less strings such as `2026-05-24 14:30:00`
as UTC. ClickHouse does **not** guarantee that all timestamp strings are UTC: text output follows
the column/server timezone. Use UTC columns or normalize the selected expression to UTC before
using `T.dateTime` / `T.dateTime64`. For an unchanged wire string, use `T.dateTimeString` /
`T.dateTime64String`. See [ClickHouse DateTime timezones](https://clickhouse.com/docs/reference/data-types/datetime).

**Numeric validation.** Built-in numeric codecs accept finite numbers and quoted finite numbers.
They do not enforce each ClickHouse integer's sign, bit width, safe-integer range, or integrality.
Use schema checks through `T.custom` when your application needs those constraints; `param.int`
separately requires a safe integer. A successful decode does not prove an unsafe large number
retained precision.

> **Import the namespace.** Every constructor is on the root barrel too, but
> `import * as T from "@maple-dev/clickhouse-builder/types"` — as above — reads better than
> `CH.string` and keeps column types visually distinct from the query DSL.

_(Backed by `docs/tables-and-types.md > Column types come from /types as a namespace`.)_

## `InferTS`

`InferTS<ColType>` maps a column type to its TypeScript type. You rarely need it directly —
`select` already infers output rows — but it is exported for writing your own helpers:

```ts
import type { InferTS } from "@maple-dev/clickhouse-builder"

type Ms = InferTS<typeof T.uint64> // number
```

`InferEncoded<ColType>` is its counterpart — the wire type the schema decodes _from_.

Related utilities: `ColumnDefs` (the shape of a `columns` record), `OutputToColumnDefs`
(converts a query's output row back into column defs, used by `fromQuery`), and
`NullableColumnDefs` (what `leftJoin` applies to the joined side).

## Map columns

`Map` columns get a `.get(key)` accessor that compiles to ClickHouse's bracket syntax:

```ts
const query = CH.from(Events)
	.select(($) => ({ method: $.Attributes.get("http.method") }))
	.where(($) => [$.OrgId.eq("org_123")])

// SELECT Attributes['http.method'] AS method FROM events WHERE OrgId = 'org_123'
```

`.get()` yields the map's _value_ type — `Expr<string>` for a `Map(String, String)`, `Expr<number>` for a `Map(String, UInt64)`. For the other map operations — `mapContains`,
`mapKeys`, `mapValues`, `mapGet`, `mapLiteral` — see the
[API reference](./reference.md#map).

_(Backed by `docs/tables-and-types.md > Reading a Map column`.)_

## Aliasing a table

`from()` takes an optional alias, which qualifies every column reference. You need this as
soon as a join introduces ambiguity:

```ts
CH.from(Events, "e") // FROM events AS e, columns emit as e.Name
```

See [Joins and subqueries](./joins-and-subqueries.md).

`T.dateTime64` preserves milliseconds when encoding `Date`/`DateTime.Utc` comparison bounds
and decoded rows. JavaScript timestamps have millisecond precision; use `T.dateTime64String`
when forwarding microseconds or nanoseconds unchanged. `T.dateTime` encodes whole seconds.

## Types not in the built-in list

`T.custom(sqlType, schema)` models types such as UUID, LowCardinality, enums, or decimals using
their JSON representation. Match your existing database schema rather than redesigning the
physical table to fit this library's constructors. For a `LowCardinality(String)` column, for
example, `T.custom("LowCardinality(String)", Schema.String)` decodes the ordinary string it emits.

`T.untyped(sqlType)` accepts an unknown field without validating it. Unlike `CH.untypedExpr`, it
supplies a `Schema.Unknown` codec, so other selected fields can still be validated. The unknown
field itself has no guarantee. Prefer a real custom codec where you know the wire representation.

`T.aggregateState(fn, ...argumentTypes)` describes an opaque aggregate-state value passed from
an inner query into a matching merge function. It is not a decoder for inspecting state bytes.
See [Extending the DSL](./extending.md#a-column-type-of-your-own).
