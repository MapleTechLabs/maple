---
title: "SQL reference"
description: "Query your telemetry with ClickHouse SQL: the tables and columns you can read, the required macros, result shapes for each chart type, and limits."
group: "Reference"
order: 7
---

SQL widgets on dashboards, raw-SQL alert rules, and the MCP `run_sql` tool all run ClickHouse SQL against the same tables Maple's own pages read. This page lists what you can query and the rules a query has to follow.

## A first query

```sql
SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
       count() AS logs
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket
```

Every query **must** contain `$__orgFilter`. It expands to your organisation's filter, and a query without it is rejected before it runs. Access is also enforced by the credentials the query runs with, so the macro is a correctness check rather than your only protection.

## Macros

| Macro                | Expands to                                                    |
| -------------------- | ------------------------------------------------------------- |
| `$__orgFilter`       | Your organisation filter. Required.                           |
| `$__timeFilter(col)` | `col >= <start> AND col <= <end>` for the selected time range |
| `$__timeGroup(col)`  | `toStartOfInterval(col, INTERVAL <bucket> SECOND)`            |
| `$__startTime`       | The range start, as a `DateTime`                              |
| `$__endTime`         | The range end, as a `DateTime`                                |
| `$__interval_s`      | The bucket width in seconds, an integer of at least 1         |

The argument to `$__timeFilter` and `$__timeGroup` must be a plain column name. Any other `$__name` is an error. When a widget has no explicit granularity, buckets target about 30 points with a 5-minute minimum.

On dashboards, variables are written `$name` or `${name}` and are substituted as quoted string literals. A variable set to **All** becomes a comma-separated list, so use it with `IN`:

```sql
WHERE $__orgFilter AND $__timeFilter(Timestamp) AND ServiceName IN ($service)
```

## Tables

The main tables are below. Run `describe_warehouse_tables` from the [MCP server](/docs/reference/mcp) for the full list with every column and its type.

| Table                           | One row per                                 | Time column |
| ------------------------------- | ------------------------------------------- | ----------- |
| `traces`                        | Span                                        | `Timestamp` |
| `service_overview_spans`        | Entry-point span (server, consumer or root) | `Timestamp` |
| `logs`                          | Log record                                  | `Timestamp` |
| `error_events`                  | Exception occurrence                        | `Timestamp` |
| `metrics_sum`                   | Counter data point                          | `TimeUnix`  |
| `metrics_gauge`                 | Gauge data point                            | `TimeUnix`  |
| `metrics_histogram`             | Histogram data point                        | `TimeUnix`  |
| `metrics_exponential_histogram` | Exponential histogram data point            | `TimeUnix`  |
| `session_replays`               | Browser session                             | `StartTime` |
| `session_events`                | Session timeline event                      | `Timestamp` |
| `product_events`                | Product event                               | `Timestamp` |
| `service_usage`                 | Service and hour                            | `Hour`      |
| `attribute_keys_hourly`         | Attribute key and hour                      | `Hour`      |

### `traces`

| Column                                              | Type                                  | Notes                                                             |
| --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `Timestamp`                                         | `DateTime64(9)`                       | Span start                                                        |
| `TraceId`, `SpanId`, `ParentSpanId`                 | `String`                              |                                                                   |
| `ServiceName`, `SpanName`                           | `LowCardinality(String)`              |                                                                   |
| `SpanKind`                                          | `LowCardinality(String)`              | `Internal`, `Server`, `Client`, `Producer`, `Consumer`            |
| `Duration`                                          | `UInt64`                              | **Nanoseconds.** Divide by `1e6` for milliseconds.                |
| `StatusCode`                                        | `LowCardinality(String)`              | `Ok`, `Error`, `Unset` (Title Case)                               |
| `StatusMessage`                                     | `String`                              |                                                                   |
| `SpanAttributes`, `ResourceAttributes`              | `Map(LowCardinality(String), String)` | Read with `SpanAttributes['http.route']`                          |
| `EventsTimestamp`, `EventsName`, `EventsAttributes` | Arrays                                | Span events, index-aligned                                        |
| `SampleRate`                                        | `Float64`                             | 1.0 when unsampled. Multiply counts by it to estimate throughput. |
| `IsEntryPoint`                                      | `UInt8`                               | 1 for server, consumer and root spans                             |

For per-service request rate, error rate and latency, query `service_overview_spans` instead. It has the same core columns, holds only entry-point spans, and is much smaller, but it has no attribute maps.

### `logs`

| Column                                                   | Type                                  | Notes                                                                 |
| -------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `Timestamp`                                              | `DateTime64(9)`                       |                                                                       |
| `TimestampTime`                                          | `DateTime`                            | Second precision                                                      |
| `ServiceName`                                            | `LowCardinality(String)`              |                                                                       |
| `SeverityText`                                           | `LowCardinality(String)`              | Casing varies by SDK                                                  |
| `SeverityNumber`                                         | `UInt8`                               | 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal |
| `Body`                                                   | `String`                              |                                                                       |
| `TraceId`, `SpanId`                                      | `String`                              |                                                                       |
| `LogAttributes`, `ResourceAttributes`, `ScopeAttributes` | `Map(LowCardinality(String), String)` |                                                                       |

Filter severity on `SeverityNumber` rather than `SeverityText`: some SDKs send `Error` and others `ERROR`. `SeverityNumber BETWEEN 17 AND 20` matches every error.

### Metrics tables

All four metric tables share `ServiceName`, `MetricName`, `MetricDescription`, `MetricUnit`, `Attributes` (a map of data-point attributes), `ResourceAttributes`, `StartTimeUnix` and `TimeUnix`. Then:

- `metrics_sum` and `metrics_gauge` carry `Value Float64`. `metrics_sum` adds `IsMonotonic` and `AggregationTemporality` (1 is delta, 2 is cumulative). Delta rows already hold the per-interval increase, so `sum(Value)` per bucket is exact; cumulative rows need a rate.
- `metrics_histogram` carries `Count`, `Sum`, `Min`, `Max`, `BucketCounts` and `ExplicitBounds`.
- `metrics_exponential_histogram` carries `Count`, `Sum`, `Scale`, `ZeroCount` and the positive and negative bucket arrays.

### Things that trip people up

- **Missing map keys read as `''`, not `NULL`.** Test with `mapContains(SpanAttributes, 'key')` or `SpanAttributes['key'] != ''`.
- **Status and span kind are Title Case.** `StatusCode = 'Error'` matches; `'ERROR'` does not.
- **Hourly rollups use `Hour`, not `Timestamp`.** Snap your range with `toStartOfHour`, or a window shorter than an hour returns nothing.
- **Rollup columns are aggregate states.** Read `SimpleAggregateFunction` columns with `sum(...)` and `AggregateFunction` columns with the matching `…Merge(...)`.
- **Filter on the sort key first.** `traces` is sorted by service and span name, so adding `ServiceName = '…'` makes a query dramatically cheaper.

## Result shapes for charts

| Display                     | Return                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| Line, area, bar             | A time column (name it `bucket`) plus one numeric column per series |
| Stat                        | One row with a numeric column named `value`                         |
| Pie, funnel, horizontal bar | A `name` column and a `value` column                                |
| Heatmap                     | `x`, `y` and `value` columns                                        |
| Histogram                   | One `value` column, one row per observation                         |
| Table                       | Any columns                                                         |

For time series, every non-time column becomes a series named after the column, and non-numeric columns are dropped. Rows are not split by a string column, so to draw several lines, return one column per line, for example with `countIf`:

```sql
SELECT $__timeGroup(Timestamp) AS bucket,
       countIf(StatusCode = 'Error') AS errors,
       count() AS requests
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket
```

## What is allowed

A query is a single `SELECT` or `WITH` statement. A trailing `;` is fine, and a trailing `FORMAT` clause is dropped. Rejected:

- More than one statement.
- Any write or DDL keyword: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `RENAME`, `ATTACH`, `DETACH`, `CREATE`, `GRANT`, `REVOKE`, `OPTIMIZE`, `SYSTEM`, `KILL`, and `INTO OUTFILE`.
- A `SETTINGS` clause.
- Table functions that reach outside Maple, such as `url`, `file`, `s3`, `remote`, `mysql`, `postgresql` and `dictionary`.

A rejected query returns `400` with one of these codes: `MissingOrgFilter`, `InvalidMacro`, `UnresolvedMacro`, `DisallowedStatement`, `DisallowedFunction`, `MultipleStatements`, `ResourceLimit`.

## Limits

| Limit               | Value                                                                  |
| ------------------- | ---------------------------------------------------------------------- |
| Query text          | 32,768 characters                                                      |
| Rows returned       | 1,000. More is an error, not a silent cut: aggregate or add a `LIMIT`. |
| Result size         | 5 MB of JSON, 64,000 characters per cell                               |
| Execution time      | 10 seconds for dashboards and `run_sql`, 5 seconds for alerts          |
| Raw-SQL alert rules | Must use `$__timeFilter(…)`                                            |

Your query is wrapped in an outer `LIMIT`, so `WITH TOTALS`, `LIMIT BY` and `WITH FILL` in the outermost query are discarded.

## Related

- [Maple MCP server](/docs/reference/mcp): `run_sql` and `describe_warehouse_tables`
- [OpenTelemetry conventions](/docs/concepts/otel-conventions): which attributes land in which column
- [Limits](/docs/reference/limits)
