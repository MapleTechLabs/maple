import { Effect } from "effect"
import type { BackendError, WarehouseApiError } from "./effect-utils"
import type { WarehouseServices } from "./warehouse-services"

import { getServiceUsage } from "./service-usage"
import { getServiceOverview, getServiceApdexTimeSeries, getServicesFacets } from "./services"
import { listTraces, getTracesFacets, getTracesDurationStats } from "./traces"
import { listLogs, getLogsCount, getLogsFacets } from "./logs"
import { getErrorsByType, getErrorsFacets, getErrorsSummary, getErrorDetailTraces } from "./errors"
import { getErrorRateByService } from "./error-rates"
import { listMetrics, getMetricsSummary } from "./metrics"
import {
	getCustomChartTimeSeries,
	getCustomChartBreakdown,
	getCustomChartServiceSparklines,
} from "./custom-charts"
import { getQueryBuilderTimeseries } from "./query-builder-timeseries"
import { getQueryBuilderBreakdown } from "./query-builder-breakdown"
import { getQueryBuilderList } from "./query-builder-list"
import { getRawSqlChart } from "./raw-sql-chart"
import { getProductEventsFunnelWidget, getProductEventsPathsWidget } from "./product-events"

/**
 * The dashboard widgets' data sources: one warehouse server function per stored `endpoint`.
 * Moved here from apps/web's `data-source-registry.ts` so both frontends run the same table.
 */

/**
 * Error channel shared by every warehouse server function: the `WarehouseApiError` union or a
 * tagged `@maple/http/errors/*` backend error surfaced by the API client.
 */
export type WidgetServerFunctionError = WarehouseApiError | BackendError

// The input and success channels stay `any`: each endpoint decodes its own input and resolves a
// distinct response shape, consumed through a single structural `{ data }` accessor.
// oxlint-disable-next-line typescript/no-explicit-any
export type WidgetServerFunction = (opts: { data: any }) => Effect.Effect<
	// oxlint-disable-next-line typescript/no-explicit-any
	any,
	WidgetServerFunctionError,
	WarehouseServices
>

const markdownStaticServerFn: WidgetServerFunction = () => Effect.succeed({ data: null })

export const widgetServerFunctions = {
	service_usage: getServiceUsage,
	service_overview: getServiceOverview,
	service_overview_time_series: getCustomChartServiceSparklines,
	service_apdex_time_series: getServiceApdexTimeSeries,
	services_facets: getServicesFacets,
	list_traces: listTraces,
	traces_facets: getTracesFacets,
	traces_duration_stats: getTracesDurationStats,
	list_logs: listLogs,
	logs_count: getLogsCount,
	logs_facets: getLogsFacets,
	errors_summary: getErrorsSummary,
	errors_by_type: getErrorsByType,
	error_detail_traces: getErrorDetailTraces,
	errors_facets: getErrorsFacets,
	error_rate_by_service: getErrorRateByService,
	list_metrics: listMetrics,
	metrics_summary: getMetricsSummary,
	custom_timeseries: getCustomChartTimeSeries,
	custom_breakdown: getCustomChartBreakdown,
	custom_query_builder_timeseries: getQueryBuilderTimeseries,
	custom_query_builder_breakdown: getQueryBuilderBreakdown,
	custom_query_builder_list: getQueryBuilderList,
	raw_sql_chart: getRawSqlChart,
	product_events_funnel: getProductEventsFunnelWidget,
	product_events_paths: getProductEventsPathsWidget,
	markdown_static: markdownStaticServerFn,
} satisfies Record<string, WidgetServerFunction>

export type WidgetDataSourceEndpoint = keyof typeof widgetServerFunctions

const isWidgetDataSourceEndpoint = (endpoint: string): endpoint is WidgetDataSourceEndpoint =>
	Object.prototype.hasOwnProperty.call(widgetServerFunctions, endpoint)

/**
 * The server function for a stored endpoint name, or `undefined` for an unknown one. Accepts any
 * string: a JSON-decoded widget config types its endpoint only as `string`.
 */
export const getWidgetServerFunction = (endpoint: string): WidgetServerFunction | undefined =>
	isWidgetDataSourceEndpoint(endpoint) ? widgetServerFunctions[endpoint] : undefined
