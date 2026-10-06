# Warehouse timestamps as `DateTime.Utc`

Status: started 2026-10-07. Foundation and one pilot (AuditLog) landed; everything else still reads strings.

## Problem

`packages/query-engine/src/ch/tables.ts` declares every timestamp column with effect-orm's string flavour
(`T.dateTimeString` / `T.dateTime64String`). Rows carry the raw ClickHouse text, which is UTC but has no zone
marker: `2026-10-07 10:00:00` (DateTime), `2026-10-07 10:00:00.041` (DateTime64(3)),
`2026-10-07 10:00:00.123456789` (DateTime64(9)).

Every consumer then parses that text itself: `parseWarehouseDateTime` (78 non-test call lines, about half on
row fields), `warehouseDateTimeToIso`, hand-rolled codecs (the audit log had one), and raw `Date.parse` /
`new Date(row.x)` in about 20 places. The raw ones are wrong whenever the host is not UTC, because V8 reads a
tz-less date-time as local time:

```
$ TZ=Europe/Berlin bun -e 'console.log(new Date(Date.parse("2026-10-07 10:00:00")).toISOString())'
2026-10-07T08:00:00.000Z
$ TZ=UTC bun -e 'console.log(new Date(Date.parse("2026-10-07 10:00:00")).toISOString())'
2026-10-07T10:00:00.000Z
```

Production Workers run in UTC, so prod is right by luck; local dev, tests and the local CLI on a Berlin
machine are two hours off.

## Target

1. **Decode once, in effect-orm.** Columns are `T.dateTime` / `T.dateTime64`; `compiledQuery` runs
   `decodeRows` after execution (and after the raw-row cache), so rows hold `DateTime.Utc`. Bounds use
   `param.dateTime(...)` (same placeholder kind as `param.dateTimeString`, so the SQL does not change).
2. **Encode once, at the HTTP edge.** Response schemas that forward a warehouse timestamp use
   `DateTimeUtcFromWarehouse` (DateTime, `YYYY-MM-DD hh:mm:ss`) or `DateTimeUtcFromWarehouse64`
   (DateTime64(3), `YYYY-MM-DD hh:mm:ss.SSS`) from `@maple/query-engine/datetime`. They encode
   `DateTime.Utc` to exactly the string ClickHouse would have sent, so iOS and web see the same bytes.
3. **Backend code computes with `DateTime`**, no string parsing. `parseWarehouseDateTime` shrinks to request
   input parsing and eventually goes away.

### Constraints

- **DateTime64(9) cannot round-trip.** `DateTime.Utc` holds milliseconds; `.123456789` comes back as
  `.123`. Traces, Logs.Timestamp, Metrics*, SessionReplay*, SessionEvents, ProductEvents, AiCrawlerRequests,
  IdentityLinks stay strings on any path that forwards them to a client, until effect-orm grows a nanosecond
  type or those fields are deliberately changed to millisecond precision (a visible wire change, needs a
  decision). Internal-only reads of those columns may switch where milliseconds suffice.
- **Web decodes with the same domain schemas.** Moving an HTTP field from `Schema.String` to the codec makes
  the web client's decoded value a `DateTime.Utc`, so each surface also updates its web consumers. The wire
  is unchanged; the web types are not.
- **Flavour propagates.** `min`/`max`/`toStartOfInterval` over a migrated column yield `DateTime.Utc`;
  `toString_`/`formatDateTime`/`toUnixTimestamp` still yield strings or numbers. Switching a table changes
  every raw select over it, so a table moves with all of its raw consumers.
- **Caches.** Nothing caches decoded rows today (decode is after the raw-row cache). Any new cache of decoded
  rows must encode first: `DateTime.Utc` does not survive `JSON.stringify`.

## Inventory

Groups are independent: each is one or more tables plus every raw select over them, their backend parsers
and HTTP fields. Queries that already stringify (`toString_`, `formatDateTime`, `toUnixTimestamp`) are
unaffected: `signalPresenceQuery`, `liveness.ts`, `listRuleChecksQuery`, `slowTracesQuery`, the service-map
`*ExistingHoursSQL`, the Cloudflare integration and the stringified parts of `ai-sessions.ts`.

| # | Tables (precision) | Raw selects | Backend parsing | HTTP fields |
|---|---|---|---|---|
| A | AuditLog (64(3)) | `auditLogEntriesQuery` | `audit-event.ts` hand-rolled codec | v2 `audit_log` (ISO, built from `Date`) |
| B | AlertChecks (64(3)) | `alertChecksSummaryQuery` bucket | `AlertReadModelsService.ts` (`String(row.bucket)`), `alert-rules.http.ts` `summaryTimestamp` | v2 alert-rules bucket (normalised) |
| C | ErrorFingerprintsMinutely, ErrorEvents, ErrorEventsByTime (DateTime) | `errors.ts` (9 queries), `anomaly.ts` error spike (3), `releases.ts` | `ErrorsService.ts:1246`, `ErrorIssueReadModelsService.ts:463/473` | `ErrorsByTypeResponse`, `ErrorsSparkResponse`, `ReleasesList`/`ReleaseDetail` (`http/query-engine.ts`) |
| D | ServiceUsage (DateTime) | `dailySignalVolumeQuery`, `serviceUsageQuery` | `DailySpendService.ts` (3) | MCP `ingest_usage` |
| E | TracesAggregatesHourly, LogsAggregatesHourly (DateTime) | anomaly signals/volume, `tracesTimeseriesQuery`, `logsTimeseriesQuery`, `activity.ts` | `AnomalyDetectionService.ts` (6), `bucket-cache.ts` (4), `chat-chart.ts`, `AlertsService.ts:1259/1283` | generic timeseries `bucket` (`domain/src/query-engine.ts:564/606`) |
| F | ServiceOverview*, ServiceOperations*, ServiceMap*Hourly, ServicePlatformsHourly (DateTime) | `services.ts`, `service-operations.ts`, `service-map.ts` | `query-engine.ts` `toEpochMs` | ServiceApdex/DetailOverview/Operations/DbQuerySummary `bucket`/`lastSeen` |
| G | MetricCatalog (DateTime) | `listMetricsQuery` | none found | MCP `list_metrics` |
| H | Traces, TraceDetailSpans, Logs (64(9)) | traces/logs list, detail, hierarchy, `ai-sessions.ts`, `ai-tools.ts` | `inspect-trace.ts`, `error-detail.ts`, `query-engine.ts:258`, `telemetry.http.ts`, agent-sessions | SpanHierarchy, ErrorDetailTraces, MCP traces/logs |
| I | Metrics* (64(9)) | `infra.ts` (14), `containers.ts` (5), `metrics.ts`, railway/planetscale | `telemetry.http.ts:621` | infra List*/Detail*/Timeseries |
| J | SessionReplays, SessionReplayEvents, SessionEvents, ProductEvents, IdentityLinks, AiCrawlerRequests (64(9)) | `session-replays.ts`, `session-events.ts`, product events, web analytics | `session-window.ts`, `ai-traffic-model.ts` (web) | `http/session-replay.ts`, `http/ai-sessions.ts`, web analytics |

Groups H to J are blocked on the nanosecond constraint for any field that reaches a client.

## Order

1. **A, AuditLog** (done): internal, DateTime64(3), one query, removes a hand-rolled parser.
2. **B, AlertChecks summary**: one raw select, DateTime64(3), output already normalised before the wire.
3. **C, error tick + errors HTTP**: the first group that exercises `DateTimeUtcFromWarehouse` on
   `http/query-engine.ts` fields; `ErrorEventsByTime` also feeds anomaly and releases, so they move together.
4. **D, ServiceUsage**: internal billing math; check `serviceUsageQuery` consumers first.
5. **E, F, G**: the hourly/minutely rollups; largest web surface, migrate one response schema at a time.
6. **H to J**: decide the nanosecond question first.

Per surface: switch columns, `param.dateTimeString` to `param.dateTime`, response fields to the codec, delete
the parsing, update web consumers, and confirm `catalog.baseline.test.ts` passes unchanged (a column-flavour
switch must not change SQL).
