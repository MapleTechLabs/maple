# Troubleshooting

First identify which stage failed: installation, query construction/compilation, client execution,
or row decoding. [Running a query](./running-queries.md#error-boundaries) separates those boundaries.

## Installation and imports

| Symptom                                                      | Likely cause                                          | Fix                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| npm returns 404 for the builder                              | Its first npm release is pending.                     | Use the source-build path in [Getting started](./getting-started.md#installation-and-compatibility). |
| `Schema.TaggedError is not a function`                       | Effect 3 is installed or resolving ahead of Effect 4. | Install the documented Effect 4 version and inspect the resolved dependency tree.                    |
| `ERR_REQUIRE_ESM` or an import cannot be loaded by `require` | The builder ships ESM.                                | Use ESM imports and `"type": "module"`, or your bundler's ESM support.                               |
| A helper exists in source but not in the package             | A deep source import or stale local build.            | Use the four public entry points and rebuild/reinstall your tarball.                                 |
| An example's `Events`, `Services`, `CH`, or `T` is undefined | A guide fragment expects the shared schema/imports.   | Start with the complete example and shared `schema.ts`; recipe files include their own imports.      |

## Compilation failures

| Symptom                                     | Meaning                                                  | Fix                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Nothing happens when calling `CH.compile`   | It returns an unrun Effect.                              | Use `yield*` in an Effect program or `await Effect.runPromise(...)`.                                              |
| `UnresolvedParam`                           | A placeholder has no value.                              | Match the case-sensitive name passed to `param.*` with the param bag.                                             |
| `InvalidLiteral`                            | A value does not encode through its codec.               | Check type, finiteness, date format, and custom schema constraints.                                               |
| `InvalidArguments`                          | A function received a value/argument list it cannot use. | Read the error message; inspect empty lists and function-specific limits.                                         |
| `QueryBuilderDefect`                        | The DSL was used incorrectly.                            | Supply `select`, use order tuples, and keep parameter names valid. Do not treat it as a retryable database error. |
| `.compileUnion` vs `.compile` type mismatch | Union queries have their own compiler.                   | Use `CH.compileUnion` for a union or wrap it with `CH.fromUnion` before `CH.compile`.                             |

Expected builder errors use the tag `@maple-dev/clickhouse-builder/QueryBuilderError`.
[`catchTag`](./params-and-compilation.md#handling-compilation-failures) matches the full tag,
not just `QueryBuilderError`.

## Unexpected SQL or results

- **A tenant or time filter disappeared:** a later `.where()` replaced the earlier callback.
  Assemble the complete filter array once. Repeated `select`, `having`, and `orderBy` also replace.
- **`orderBy` errors:** use `.orderBy(["count", "desc"])`, not two bare strings.
- **An aggregate cannot be used in WHERE:** filter raw rows in WHERE and groups in HAVING.
- **Counts grew after a join:** multiple right-side rows matched. Include tenant keys and
  deduplicate/aggregate the joined source where your data model requires one row per key.
- **A LEFT JOIN returns empty strings or zeros:** ClickHouse uses defaults for unmatched columns
  with `join_use_nulls=0`; use `join_use_nulls=1` when you need NULLs, and match the decoder.
- **Arithmetic produces an unexpected value:** chained arithmetic follows SQL precedence;
  `.sub(1).div(2)` emits `x - 1 / 2`, not `(x - 1) / 2`. Use an intermediate subquery.
- **`tenantScope` is `"cross-tenant"`:** check every source, including joins, CTEs, and union
  branches. They must be bound to the same tenant. HAVING and OR are not scope evidence.
- **A query compiles but ClickHouse rejects it:** compilation is not a server-side semantic check.
  Check actual columns/types, aggregate rules, function availability, server version, and settings.

A `LIMIT` does not guarantee a cheap query: grouping or sorting can still scan many rows.
Use the real table's sorting key and bounded time filters; inspect the server plan rather than
assuming a typed query is optimized. See [Recipes](./recipes.md#time-buckets-over-a-bounded-interval).

## Decode failures and lost information

`CompiledQueryDecodeError` reports `rowIndex`. Inspect that row's field names and wire values
alongside `compiled.rowSchemaSource`, `compiled.untypedColumns`, and `compiled.rowSchemaMismatch`.

| Symptom                              | Check                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `rowSchemaSource` is `"none"`        | A selected expression has no codec, or the SQL is handwritten. Prefer typed helpers or supply a declared row schema.                          |
| A count arrives as `"42"`            | Use `CH.CHNumber` in a declared schema; the derived numeric codecs already accept quoted numbers.                                             |
| A field disappeared after decoding   | An explicit schema replaced the derived shape. Inspect `rowSchemaMismatch`.                                                                   |
| An ID's last digits changed          | The value passed through JavaScript `number`. Project `toString(...)` in SQL before parsing JSON.                                             |
| Timestamps shifted by several hours  | The codec assumes zone-less text is UTC, but the server/column emitted another timezone. Normalize SQL output or use a matching custom codec. |
| Microseconds/nanoseconds disappeared | Parsed `DateTime.Utc` has millisecond precision. Preserve the text with `T.dateTime64String`.                                                 |
| An average/percentile is NULL        | Empty/non-finite aggregate results can serialize as JSON null. Keep the nullable type or explicitly define a fallback.                        |
| “No rows” crashes a point lookup     | Use `decodeFirstRow` and handle `Option.none`; an empty result is not a decode failure.                                                       |

The built-in numeric codecs are wire decoders, not full range validators. `T.uint64` does not
make JavaScript numbers lossless or enforce UInt64 bounds. `T.untyped` validates nothing for its
field even when the rest of the row has a derived schema.

## Reporting a problem

Include the package version, resolved Effect version, runtime, and ClickHouse version. Reduce
the problem to a table declaration, a query, the parameter shapes, and the generated SQL.
For decoding failures include a redacted wire row and `rowSchemaSource`. Remove credentials
and personal data: parameters are interpolated into `compiled.sql`, so the SQL may contain
sensitive values. File a [GitHub issue](https://github.com/MapleTechLabs/maple/issues).
