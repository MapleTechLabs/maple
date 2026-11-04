import { createQueryDraft, formatFiltersAsWhereClause } from "@maple/query-engine/query-builder"
import {
	isWidgetDataSourceEndpoint,
	type WidgetDataSourceEndpoint,
} from "@maple/web-data/warehouse/widget-data-sources"
import { Array as Arr } from "effect"
import { legacyQueryDraft } from "./drafts"
import type { EditorState, QueryDraft } from "./editor-state"

// A fixed route widget (a preset like "Total Traces") read as the builder query that computes
// the same metric, so editing it keeps the metric. Routes with no equivalent stay fixed.

type StatAggregate = EditorState["statAggregate"]

/** The builder query for a route, or `fixed` when no builder query computes its metric. */
export type RouteStandIn =
	| Readonly<{ kind: "builder"; query: QueryDraft; statAggregate: StatAggregate | null }>
	| Readonly<{ kind: "fixed" }>

/** What a route widget stores: its endpoint, params, and the field and aggregate a stat reduces. */
export type RouteWidget = Readonly<{
	endpoint: string | null
	params: Readonly<Record<string, unknown>>
	reduce: Readonly<{ field: string; aggregate: StatAggregate }> | null
}>

const FIXED: RouteStandIn = { kind: "fixed" }

type Filters = Readonly<{ serviceName?: string; rootSpansOnly?: boolean; errorsOnly?: boolean }>

const builder = (
	dataSource: "traces" | "logs",
	aggregation: string,
	filters: Filters,
	statAggregate: StatAggregate,
): RouteStandIn => {
	const draft = createQueryDraft(0)
	const base = {
		...draft,
		aggregation,
		whereClause: formatFiltersAsWhereClause({ filters }),
		addOns: { ...draft.addOns, groupBy: false },
		groupBy: [],
	}
	return {
		kind: "builder",
		query: dataSource === "logs" ? { ...base, dataSource: "logs" } : base,
		statAggregate,
	}
}

const stringParam = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

/** One service out of a `services` list; several have no single `service.name =` clause. */
const singleService = (value: unknown): string | undefined | null => {
	if (value === undefined) return undefined
	if (!Arr.isArray(value)) return null
	const names = Arr.filter(value, (item): item is string => typeof item === "string")
	return names.length === 0 ? undefined : names.length === 1 ? names[0] : null
}

/** A per-service row summed (or averaged) across services; any other reduction has no builder equal. */
const perServiceRow = (
	route: RouteWidget,
	expected: StatAggregate,
	toStandIn: (serviceName: string | undefined) => RouteStandIn,
	serviceParam: unknown,
): RouteStandIn => (route.reduce?.aggregate === expected ? toStandIn(stringParam(serviceParam)) : FIXED)

const serviceUsage = (route: RouteWidget): RouteStandIn => {
	switch (route.reduce?.field) {
		// `TraceCount` counts every span row.
		case "totalTraces":
		case "totalTraceCount":
			return perServiceRow(
				route,
				"sum",
				(serviceName) => builder("traces", "count", { serviceName }, "sum"),
				route.params.service,
			)
		case "totalLogs":
			return perServiceRow(
				route,
				"sum",
				(serviceName) => builder("logs", "count", { serviceName }, "sum"),
				route.params.service,
			)
		// `serviceName` (count of services) has no builder aggregation.
		default:
			return FIXED
	}
}

/** One summary row, so any reduction of it is the value itself. */
const errorsSummary = (route: RouteWidget): RouteStandIn => {
	const serviceName = singleService(route.params.services)
	if (serviceName === null) return FIXED
	const filters = { serviceName, rootSpansOnly: route.params.rootOnly === true }
	switch (route.reduce?.field) {
		case "totalErrors":
			return builder("traces", "count", { ...filters, errorsOnly: true }, "sum")
		// `errorRate` is errors over spans for the whole window; the builder only reduces per-bucket
		// rates, which drift from it under uneven traffic. `affectedServicesCount` is a distinct count.
		default:
			return FIXED
	}
}

const serviceOverview = (route: RouteWidget): RouteStandIn => {
	const latency = (aggregation: string) =>
		perServiceRow(
			route,
			"avg",
			(serviceName) => builder("traces", aggregation, { serviceName }, "avg"),
			route.params.service_name,
		)
	switch (route.reduce?.field) {
		case "p50LatencyMs":
			return latency("p50_duration")
		case "p95LatencyMs":
			return latency("p95_duration")
		// `throughput` is requests per second; the builder counts per bucket.
		default:
			return FIXED
	}
}

/** Pre-query-builder chart routes store builder-shaped params. */
const legacyChart = (route: RouteWidget): RouteStandIn => ({
	kind: "builder",
	query: legacyQueryDraft(route.params),
	statAggregate: null,
})

const fixed = (): RouteStandIn => FIXED

/** Every route the dashboard can store; a new one is a type error here until it is mapped. */
const ROUTE_STAND_INS = {
	service_usage: serviceUsage,
	errors_summary: errorsSummary,
	service_overview: serviceOverview,
	custom_timeseries: legacyChart,
	custom_breakdown: legacyChart,
	service_overview_time_series: fixed,
	service_apdex_time_series: fixed,
	services_facets: fixed,
	list_traces: fixed,
	traces_facets: fixed,
	traces_duration_stats: fixed,
	list_logs: fixed,
	logs_count: fixed,
	logs_facets: fixed,
	errors_by_type: fixed,
	error_detail_traces: fixed,
	errors_facets: fixed,
	error_rate_by_service: fixed,
	list_metrics: fixed,
	metrics_summary: fixed,
	// Query sets, product events and notes never reach here: they are not route sources.
	custom_query_builder_timeseries: fixed,
	custom_query_builder_breakdown: fixed,
	custom_query_builder_list: fixed,
	// A `kind: "route"` SQL widget is not a preset; it reads as a builder query, as before presets mapped.
	raw_sql_chart: legacyChart,
	product_events_funnel: fixed,
	product_events_paths: fixed,
	markdown_static: fixed,
} satisfies Record<WidgetDataSourceEndpoint, (route: RouteWidget) => RouteStandIn>

/** `routeStandInOf`: the builder query that computes a route widget's metric, or `fixed`. */
export const routeStandInOf = (route: RouteWidget): RouteStandIn =>
	route.endpoint !== null && isWidgetDataSourceEndpoint(route.endpoint)
		? ROUTE_STAND_INS[route.endpoint](route)
		: FIXED
