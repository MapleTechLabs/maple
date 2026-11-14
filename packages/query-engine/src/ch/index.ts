// ClickHouse Query DSL — Maple facade
//
// The generic, reusable query builder now lives in the standalone
// @maple-dev/effect-orm package. This module re-exports that public API
// and layers Maple's OpenTelemetry-specific table definitions, the named-query
// ("pipe") registry, and the pre-built query templates on top of it.

// Generic DSL — types, table, expressions, functions, params, query builder,
// compilation, and unions — re-exported from the standalone library.
export * from "@maple-dev/effect-orm/clickhouse"

// Handwritten SQL. Shadows the builder's `rawCompiledQuery`, whose `reason`
// is any string, with one that pins Maple's closed `RawSqlReason` union — the
// explicit export wins over the star re-export above.
export { type RawSqlReason, rawCompiledQuery } from "./raw-sql"

// Pipe dispatch — maps Tinybird-style pipe names + params to compiled CH SQL.
// Shared by the cloud WarehouseQueryService and the local CLI executor so both
// resolve a pipe name to identical SQL.
export { compilePipeQuery, type PipeCompiledQuery } from "./pipe-dispatch"

// One builder over a current and a previous window, rows tagged with `period`.
export { compilePeriodCompare, type PeriodCompareWindows } from "./period-compare"

export * as tables from "./tables"

// Shared row-schema codecs (ClickHouse `FORMAT JSON` 64-bit-int-as-string coercion).
export { CHNumber } from "./schema"

// Wire rows of the pipes, derived from the queries that fill them.
export * from "./pipe-rows"

// Pre-built query templates, one module per surface.
export * from "./queries/traces"
export * from "./queries/attribute-keys"
export * from "./queries/metrics"
export * from "./queries/logs"
export * from "./queries/session-replays"
export * from "./queries/session-events"
export * from "./queries/web-analytics"
export * from "./queries/web-analytics-ai"
export * from "./queries/cost"
export * from "./queries/search-console"
export * from "./queries/security-telemetry"
export * from "./queries/user-activity"
export * from "./queries/product-events"
export * from "./queries/product-events-paths"
export * from "./queries/product-events-explore"
export * from "./queries/services"
export * from "./queries/releases"
export * from "./queries/errors"
export * from "./queries/anomaly"
export * from "./queries/activity"
export * from "./queries/service-map"
export * from "./queries/service-map-rollup"
export * from "./queries/service-infra"
export * from "./queries/service-operations"
export * from "./queries/service-endpoints"
export * from "./queries/service-api"
export * from "./queries/service-endpoint-details"
export * from "./queries/alert-checks"
export * from "./queries/audit-log"
export * from "./queries/audit-trail"
export * from "./queries/cancellation-evidence"
export * from "./queries/liveness"
export * from "./queries/signal-presence"
export * from "./queries/top-operations"
export * from "./queries/mcp"
export * from "./queries/users"
export * from "./queries/infra"
export * from "./queries/containers"
export * from "./queries/pr-review"
export * from "./queries/aws-ingest"
export * from "./queries/source-usage"
export * from "./queries/ci-runs"
export * from "./queries/uptime"
export * from "./queries/slos"
