# Warehouse timestamps as `DateTime.Utc`

Status 2026-10-07: every warehouse timestamp column decodes to `DateTime.Utc`. The request side
(bounds built as strings, HTTP request schemas, web) is the next pass.

## Decisions

- **One instant type.** Query rows carry `DateTime.Utc`. Backend code computes with `DateTime` /
  `Duration`, not epoch-ms strings.
- **Millisecond precision.** DateTime64(9) columns lose their nanoseconds on read; this is
  accepted. Keyset cursors that must stay exact inside one millisecond compare against the row's
  nanosecond `toString(Timestamp)` (`exactDateTime64` in `ch/tables.ts`, and `exactTimestamp` on
  logs rows).
- **HTTP wire.** Response fields that used to forward the tz-less `YYYY-MM-DD hh:mm:ss[.fff]` string
  now carry ISO-8601 with `Z` (`DateTime.formatIso`). v1 is being retired, so this is accepted.
- **Pipes stay a wire contract.** The pipe executor re-encodes decoded rows (`compiled.encodeRows`),
  so `@maple/domain/tinybird` endpoint types remain strings.
- **UTC on the server.**
  - BYO ClickHouse and chDB get `session_timezone=UTC` per query (`BackendDialect.pinSessionTimezoneUtc`).
  - Tinybird rejects that setting as restricted. Its servers report UTC (checked 2026-10-07).
  - CI test lanes run with `TZ=Asia/Kathmandu`.

## Mechanism

- **Columns.** `utcDateTime()` / `utcDateTime64(p)` in `packages/domain/src/tinybird/datasources.ts`
  are `t.dateTime().brand(CH.dateTime.schema)`. The query column decodes to `DateTime.Utc`; the
  datafile type and ingested row are unchanged, so the Tinybird manifest does not move. Date
  functions (`toStartOfInterval`, `toStartOfHour`, `min`, `max`) keep the flavour.
- **Bounds.**
  - `param.dateTime(name)` on DateTime64 columns.
  - `utcSecondsParam(name)` on second-precision DateTime columns. `param.dateTimeSeconds` in
    effect-orm 0.3.0 rejects a `DateTime.Utc` at runtime despite its type.
  - Both may share a name.
- **String input.** `parseUtc` (`packages/query-engine/src/datetime.ts`) turns string input
  (tz-less read as UTC, or ISO with zone) into `Option<DateTime.Utc>`.
- **Decoding rows.** `compiledQuery` decodes rows with the query's row schema. A query with an
  untyped selected field (`rowSchemaSource: "none"`) passes rows through undecoded, so each
  migrated query has a decode contract test. The SQL catalog gate
  (`apps/api/scripts/query-bench/catalog.clickhouse.e2e.test.ts`) decodes a synthetic row of every
  catalog shape against the analyzer's column types.
- **Caches.** A `DateTime.Utc` does not survive JSON. The qe-direct cache stores registry rows
  through the compiled row codec (`query-runner.ts`); `spanHierarchy` passes its codec to
  `cachedDirect` explicitly.

## Next

1. **Request side.** HTTP request schemas and service signatures take `DateTime.Utc` bounds. Web
   builds them with `DateTime`. This is where most of the remaining `formatWarehouseDateTime` and
   `parseWarehouseDateTime` callers are; they go once their surface moves.
2. **effect-orm.**
   - Fix `CHDateTimeSecondsLiteral` to accept `DateTime.Utc` / `Date` as its doc says.
   - Add `t.dateTimeUtc()` / `t.dateTime64Utc(p)` builders (a patch is ready).
   - Then replace `utcSecondsParam` and the `.brand(...)` helpers.
3. **Explicit `'UTC'` in date functions** (effect-orm). This only matters if a managed server ever
   stops running in UTC.
4. **Column DDL `DateTime('UTC')`.** Only if a Tinybird branch shows the change is metadata-only.
