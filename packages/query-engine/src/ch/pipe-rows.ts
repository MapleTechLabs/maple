// Rows a pipe returns over the wire, derived from the query that fills it, so a
// column change in the query is a type change for every pipe reader.

import type { DateTime } from "effect"
import type { InferQueryOutput } from "@maple-dev/effect-orm/clickhouse"
import type { attributeKeysQuery, spanAttributeValuesQuery } from "./queries/attribute-keys"
import type {
	errorDetailTracesQuery,
	errorsByTypeQuery,
	errorsTimeseriesQuery,
	spanHierarchyQuery,
	tracesDurationStatsQuery,
} from "./queries/errors"
import type { logsCountQuery, logsListQuery } from "./queries/logs"
import type { ListMetricsOutput } from "./queries/metrics"
import type { serviceApdexTimeseriesQuery, serviceOverviewQuery } from "./queries/services"
import type { tracesRootListQuery } from "./queries/traces"

/** A decoded row in wire form: the pipe executor encodes a `DateTime.Utc` back to its string. */
export type WireRow<Row> = { readonly [K in keyof Row]: Row[K] extends DateTime.Utc ? string : Row[K] }

/** The wire row a query builder produces. */
export type PipeRow<F extends (...args: never) => object> = WireRow<InferQueryOutput<ReturnType<F>>>

export type ListTracesRow = PipeRow<typeof tracesRootListQuery>
export type SpanHierarchyRow = PipeRow<typeof spanHierarchyQuery>
export type TracesDurationStatsRow = PipeRow<typeof tracesDurationStatsQuery>
export type ListLogsRow = PipeRow<typeof logsListQuery>
export type LogsCountRow = PipeRow<typeof logsCountQuery>
/** `isMonotonic` stays `boolean | number`: chDB returns 0/1, the remote API a boolean. */
export type ListMetricsRow = WireRow<ListMetricsOutput>
export type ServiceOverviewRow = PipeRow<typeof serviceOverviewQuery>
export type ServiceApdexTimeSeriesRow = PipeRow<typeof serviceApdexTimeseriesQuery>
export type ErrorsByTypeRow = PipeRow<typeof errorsByTypeQuery>
export type ErrorsTimeseriesRow = PipeRow<typeof errorsTimeseriesQuery>
export type ErrorDetailTracesRow = PipeRow<typeof errorDetailTracesQuery>
export type AttributeKeysRow = PipeRow<typeof attributeKeysQuery>
export type AttributeValuesRow = PipeRow<typeof spanAttributeValuesQuery>
