import { createQueryDraft, type QueryBuilderQueryDraft } from "@maple/query-engine/query-builder"
import type {
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	WidgetVisualization,
} from "@maple/domain/http"
import {
	makeProductEventsFunnelDataSource,
	makeProductEventsPathsDataSource,
	makeQueryDataSource,
	makeRouteDataSource,
	makeStaticDataSource,
} from "@maple/widgets/dashboard"

// The "Add widget" picker's ready-made widgets (apps/web dashboard-builder/widgets), React-free so
// the web app and the Foldkit port read one catalog.

/** The domain's readonly shapes made mutable, sparing the data source (`dashboard-builder/types`). */
type DeepMutable<T> =
	T extends ReadonlyArray<infer U>
		? Array<DeepMutable<U>>
		: T extends object
			? { -readonly [K in keyof T]: K extends "dataSource" ? T[K] : DeepMutable<T[K]> }
			: T

type VisualizationType = WidgetVisualization
type WidgetDataSource = typeof WidgetDataSourceSchema.Type
type WidgetDisplayConfig = DeepMutable<typeof WidgetDisplayConfigSchema.Type>

export interface WidgetPresetDefinition {
	id: string
	name: string
	description: string
	visualization: VisualizationType
	dataSource: WidgetDataSource
	display: WidgetDisplayConfig
}

export const statPresets: WidgetPresetDefinition[] = [
	{
		id: "stat-total-traces",
		name: "Total Traces",
		description: "Sum of traces across all services",
		visualization: "stat",
		dataSource: makeRouteDataSource("service_usage", undefined, {
			reduceToValue: { field: "totalTraces", aggregate: "sum" },
		}),
		display: {
			title: "Total Traces",
			unit: "number",
		},
	},
	{
		id: "stat-total-logs",
		name: "Total Logs",
		description: "Sum of logs across all services",
		visualization: "stat",
		dataSource: makeRouteDataSource("service_usage", undefined, {
			reduceToValue: { field: "totalLogs", aggregate: "sum" },
		}),
		display: {
			title: "Total Logs",
			unit: "number",
		},
	},
	{
		id: "stat-error-rate",
		name: "Error Rate",
		description: "Overall error rate as percentage",
		visualization: "stat",
		dataSource: makeRouteDataSource("errors_summary", undefined, {
			reduceToValue: { field: "errorRate", aggregate: "first" },
		}),
		display: {
			title: "Error Rate",
			unit: "percent",
		},
	},
	{
		id: "stat-total-errors",
		name: "Total Errors",
		description: "Total number of errors",
		visualization: "stat",
		dataSource: makeRouteDataSource("errors_summary", undefined, {
			reduceToValue: { field: "totalErrors", aggregate: "first" },
		}),
		display: {
			title: "Total Errors",
			unit: "number",
		},
	},
	{
		id: "stat-root-error-rate",
		name: "Root Error Rate",
		description: "Error rate for root spans only",
		visualization: "stat",
		dataSource: makeRouteDataSource(
			"errors_summary",
			{ rootOnly: true },
			{ reduceToValue: { field: "errorRate", aggregate: "first" } },
		),
		display: {
			title: "Root Error Rate",
			unit: "percent",
		},
	},
	{
		id: "stat-root-total-errors",
		name: "Root Errors",
		description: "Total number of errors on root spans",
		visualization: "stat",
		dataSource: makeRouteDataSource(
			"errors_summary",
			{ rootOnly: true },
			{ reduceToValue: { field: "totalErrors", aggregate: "first" } },
		),
		display: {
			title: "Root Errors",
			unit: "number",
		},
	},
	{
		id: "stat-total-services",
		name: "Active Services",
		description: "Number of active services",
		visualization: "stat",
		dataSource: makeRouteDataSource("service_usage", undefined, {
			reduceToValue: { field: "serviceName", aggregate: "count" },
		}),
		display: {
			title: "Active Services",
			unit: "number",
		},
	},
]

export const listPresets: WidgetPresetDefinition[] = [
	{
		id: "list-traces",
		name: "Recent Traces",
		description: "Latest traces with service, duration, and status",
		visualization: "list",
		dataSource: makeQueryDataSource({
			resultShape: "list",
			queries: [
				{
					id: "preset-list-traces",
					name: "A",
					enabled: true,
					dataSource: "traces",
					whereClause: "root_only = true",
					aggregation: "count",
					stepInterval: "",
					orderByDirection: "desc",
					addOns: {
						groupBy: false,
						having: false,
						orderBy: false,
						limit: false,
						legend: false,
					},
					groupBy: [],
					having: "",
					orderBy: "",
					limit: "",
					legend: "",
				},
			],
			limit: 25,
		}),
		display: {
			title: "Recent Traces",
			listDataSource: "traces",
			listWhereClause: "",
			listLimit: 25,
			listRootOnly: true,
			columns: [
				{ field: "serviceName", header: "Service" },
				{ field: "spanName", header: "Span" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "statusCode", header: "Status" },
			],
		},
	},
	{
		id: "list-error-traces",
		name: "Error Traces",
		description: "Traces with errors",
		visualization: "list",
		dataSource: makeQueryDataSource({
			resultShape: "list",
			queries: [
				{
					id: "preset-list-errors",
					name: "A",
					enabled: true,
					dataSource: "traces",
					whereClause: "root_only = true AND has_error = true",
					aggregation: "count",
					stepInterval: "",
					orderByDirection: "desc",
					addOns: {
						groupBy: false,
						having: false,
						orderBy: false,
						limit: false,
						legend: false,
					},
					groupBy: [],
					having: "",
					orderBy: "",
					limit: "",
					legend: "",
				},
			],
			limit: 25,
		}),
		display: {
			title: "Error Traces",
			listDataSource: "traces",
			listWhereClause: "has_error = true",
			listLimit: 25,
			listRootOnly: true,
			columns: [
				{ field: "serviceName", header: "Service" },
				{ field: "spanName", header: "Span" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "statusCode", header: "Status" },
			],
		},
	},
	{
		id: "list-logs",
		name: "Recent Logs",
		description: "Latest log entries",
		visualization: "list",
		dataSource: makeRouteDataSource("list_logs", { limit: 25 }),
		display: {
			title: "Recent Logs",
			listDataSource: "logs",
			listWhereClause: "",
			listLimit: 25,
			columns: [
				{ field: "timestamp", header: "Time" },
				{ field: "severityText", header: "Severity" },
				{ field: "serviceName", header: "Service" },
				{ field: "body", header: "Message" },
			],
		},
	},
	{
		id: "list-product-events",
		name: "Recent Events",
		description: "Latest track() calls and server-side events",
		visualization: "list",
		dataSource: makeQueryDataSource({
			resultShape: "list",
			queries: [
				{
					...createQueryDraft(0),
					id: "preset-list-product-events",
					dataSource: "product_events",
					aggregation: "count",
					whereClause: 'event.kind != "navigation"',
				},
			],
			limit: 25,
			columns: ["timestamp", "eventName", "userId", "pagePath", "source"],
		}),
		display: {
			title: "Recent Events",
			listDataSource: "product_events",
			listWhereClause: 'event.kind != "navigation"',
			listLimit: 25,
			columns: [
				{ field: "timestamp", header: "Time" },
				{ field: "eventName", header: "Event" },
				{ field: "userId", header: "User" },
				{ field: "pagePath", header: "Page" },
				{ field: "source", header: "Source" },
			],
		},
	},
]

function buildBreakdownQuery(
	index: number,
	overrides: {
		dataSource: "traces" | "logs" | "product_events"
		whereClause: string
		aggregation: string
		groupBy: string[]
		name?: string
		legend?: string
	},
): QueryBuilderQueryDraft {
	const draft = createQueryDraft(index)
	const base = {
		...draft,
		name: overrides.name ?? draft.name,
		enabled: true,
		whereClause: overrides.whereClause,
		aggregation: overrides.aggregation,
		groupBy: overrides.groupBy,
		addOns: { groupBy: true, having: false, orderBy: false, limit: true, legend: false },
		limit: "10",
		legend: overrides.legend ?? draft.legend,
	}
	if (overrides.dataSource === "logs") return { ...base, dataSource: "logs" }
	if (overrides.dataSource === "product_events") return { ...base, dataSource: "product_events" }
	return { ...base, dataSource: "traces" }
}

export const piePresets: WidgetPresetDefinition[] = [
	{
		id: "pie-errors-by-service",
		name: "Errors by Service",
		description: "Distribution of errors across services",
		visualization: "pie",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "traces",
					whereClause: "has_error = true",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Errors by Service",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: true, showLabels: false, showPercent: true },
		},
	},
	{
		id: "pie-logs-by-severity",
		name: "Logs by Severity",
		description: "Distribution of log volume by severity level",
		visualization: "pie",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "logs",
					whereClause: "",
					aggregation: "count",
					groupBy: ["severity"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Logs by Severity",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: false, showLabels: true, showPercent: true },
		},
	},
	{
		id: "pie-events-by-page",
		name: "Events by Page",
		description: "Where track() events fire, by page path",
		visualization: "pie",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "product_events",
					whereClause: 'event.kind = "custom"',
					aggregation: "count",
					groupBy: ["page.path"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Events by Page",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: true, showLabels: false, showPercent: true },
		},
	},
	{
		id: "pie-traces-by-service",
		name: "Traces by Service",
		description: "Distribution of trace volume across services",
		visualization: "pie",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "traces",
					whereClause: "root_only = true",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Traces by Service",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: true, showLabels: false, showPercent: true },
		},
	},
]

export const funnelPresets: WidgetPresetDefinition[] = [
	{
		id: "funnel-product-events",
		name: "Product-event funnel",
		description: "Conversion through page views and track() events, stitched per person",
		visualization: "funnel",
		// No steps yet: the route answers an empty funnel with no rows and the
		// editor opens on the Product events panel asking for the first step.
		dataSource: makeProductEventsFunnelDataSource({ steps: [] }),
		display: {
			title: "Conversion funnel",
			chartId: "query-builder-funnel",
			unit: "number",
			funnel: { showStepPercent: true, steps: [] },
		},
	},
	{
		id: "funnel-dropoff-product-events",
		name: "Drop-off",
		description:
			"Where people leave a product-event funnel, how long each step takes, and where the leavers went",
		visualization: "funnel",
		dataSource: makeProductEventsFunnelDataSource({ steps: [], variant: "dropoff" }),
		display: {
			title: "Drop-off",
			chartId: "query-builder-funnel",
			unit: "number",
			funnel: { showStepPercent: true, steps: [], variant: "dropoff" },
		},
	},
	{
		id: "funnel-traces-by-service",
		name: "Traces by Service",
		description: "Trace volume per service as a descending funnel",
		visualization: "funnel",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "traces",
					whereClause: "root_only = true",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Traces by Service",
			chartId: "query-builder-funnel",
			unit: "number",
			funnel: { showStepPercent: true },
		},
	},
	{
		id: "funnel-errors-by-service",
		name: "Errors by Service",
		description: "Error volume per service ranked as a funnel",
		visualization: "funnel",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "traces",
					whereClause: "has_error = true",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Errors by Service",
			chartId: "query-builder-funnel",
			unit: "number",
			funnel: { showStepPercent: false },
		},
	},
]

export const pathsPresets: WidgetPresetDefinition[] = [
	{
		id: "paths-after-event",
		name: "Paths after an event",
		description: "What people do in the steps after one event or page, top branches per step",
		visualization: "paths",
		// No anchor yet: the route answers the empty state and the editor opens on
		// the anchor picker.
		dataSource: makeProductEventsPathsDataSource({ anchor: { kind: "event", eventName: "" } }),
		display: {
			title: "Paths",
			chartId: "query-builder-paths",
			paths: { anchor: { kind: "event", eventName: "" }, direction: "after" },
		},
	},
	{
		id: "paths-before-event",
		name: "Paths before an event",
		description: "How people arrived at one event or page, read back from it",
		visualization: "paths",
		dataSource: makeProductEventsPathsDataSource({
			anchor: { kind: "event", eventName: "" },
			direction: "before",
		}),
		display: {
			title: "Paths to",
			chartId: "query-builder-paths",
			paths: { anchor: { kind: "event", eventName: "" }, direction: "before" },
		},
	},
]

export const hbarPresets: WidgetPresetDefinition[] = [
	{
		id: "hbar-top-operations",
		name: "Busiest Operations",
		description: "Top span names by volume, each as a share of the total",
		visualization: "hbar",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "traces",
					whereClause: "",
					aggregation: "count",
					groupBy: ["span.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Busiest Operations",
			chartId: "query-builder-hbar",
			unit: "number",
		},
	},
	{
		id: "hbar-top-events",
		name: "Top Events",
		description: "Most-fired product events, by distinct persons",
		visualization: "hbar",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "product_events",
					whereClause: 'event.kind != "navigation"',
					aggregation: "persons",
					groupBy: ["event.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Top Events",
			chartId: "query-builder-hbar",
			unit: "number",
		},
	},
	{
		id: "hbar-spans-by-service",
		name: "Spans by Service",
		description: "Span volume per service, ranked",
		visualization: "hbar",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "traces",
					whereClause: "",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Spans by Service",
			chartId: "query-builder-hbar",
			unit: "number",
		},
	},
]

export const histogramPresets: WidgetPresetDefinition[] = [
	{
		id: "histogram-trace-duration",
		name: "Trace Duration Distribution",
		description: "Distribution of recent root span durations",
		visualization: "histogram",
		// A list of raw root-span durations, bucketized client-side by the
		// histogram chart — a count-by-service breakdown is NOT a duration
		// distribution (MAP-49).
		dataSource: makeQueryDataSource({
			resultShape: "list",
			queries: [
				{
					id: "preset-histogram-durations",
					name: "A",
					enabled: true,
					dataSource: "traces",
					whereClause: "root_only = true",
					aggregation: "count",
					stepInterval: "",
					orderByDirection: "desc",
					addOns: {
						groupBy: false,
						having: false,
						orderBy: false,
						limit: false,
						legend: false,
					},
					groupBy: [],
					having: "",
					orderBy: "",
					limit: "",
					legend: "",
				},
			],
			limit: 200,
			columns: ["durationMs"],
		}),
		display: {
			title: "Trace Duration Distribution",
			chartId: "query-builder-histogram",
			unit: "duration_ms",
			histogram: { bucketCount: 30 },
		},
	},
	{
		id: "histogram-log-volume",
		name: "Log Volume by Service",
		description: "Distribution of log volume across services",
		visualization: "histogram",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					dataSource: "logs",
					whereClause: "",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Log Volume by Service",
			chartId: "query-builder-histogram",
			unit: "number",
			histogram: { bucketCount: 20 },
		},
	},
]

export const heatmapPresets: WidgetPresetDefinition[] = [
	{
		id: "heatmap-errors-by-service",
		name: "Errors by Service",
		description: "Density of errors across services and types",
		visualization: "heatmap",
		dataSource: makeQueryDataSource({
			resultShape: "breakdown",
			queries: [
				buildBreakdownQuery(0, {
					name: "A",
					legend: "Errors",
					dataSource: "traces",
					whereClause: "has_error = true",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
				buildBreakdownQuery(1, {
					name: "B",
					legend: "OK",
					dataSource: "traces",
					whereClause: "has_error = false",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: false },
		}),
		display: {
			title: "Errors vs OK by Service",
			chartId: "query-builder-heatmap",
			unit: "number",
			heatmap: { colorScale: "blues" },
		},
	},
]

export const markdownPresets: WidgetPresetDefinition[] = [
	{
		id: "markdown-note",
		name: "Note",
		description: "Static markdown note for context, links, or runbooks",
		visualization: "markdown",
		dataSource: makeStaticDataSource(),
		display: {
			title: "Note",
			markdown: {
				content:
					"# Dashboard notes\n\nDocument **what this dashboard tracks**, link to runbooks, or leave context for teammates.\n\n- Edit this widget to customize\n- Supports headings, lists, links, **bold**, *italic*, and `code`",
			},
		},
	},
]

export const tablePresets: WidgetPresetDefinition[] = [
	{
		id: "table-traces",
		name: "Recent Traces",
		description: "Latest traces with duration and status",
		visualization: "table",
		dataSource: makeRouteDataSource("list_traces", { limit: 5 }, { limit: 5 }),
		display: {
			title: "Recent Traces",
			columns: [
				{ field: "rootSpanName", header: "Root Span" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "hasError", header: "Status", align: "right" },
			],
		},
	},
	{
		id: "table-errors",
		name: "Errors by Type",
		description: "Error types with counts and affected services",
		visualization: "table",
		dataSource: makeRouteDataSource("errors_by_type", { limit: 5 }, { limit: 5 }),
		display: {
			title: "Errors by Type",
			columns: [
				{ field: "errorLabel", header: "Error" },
				{ field: "count", header: "Count", unit: "number", align: "right" },
				{ field: "affectedServicesCount", header: "Services", align: "right" },
			],
		},
	},
	{
		id: "table-root-errors",
		name: "Root Errors by Type",
		description: "Error types on root spans only",
		visualization: "table",
		dataSource: makeRouteDataSource("errors_by_type", { limit: 5, rootOnly: true }, { limit: 5 }),
		display: {
			title: "Root Errors by Type",
			columns: [
				{ field: "errorLabel", header: "Error" },
				{ field: "count", header: "Count", unit: "number", align: "right" },
				{ field: "affectedServicesCount", header: "Services", align: "right" },
			],
		},
	},
	{
		id: "table-services",
		name: "Service Overview",
		description: "Services with latency, errors, and throughput",
		visualization: "table",
		dataSource: makeRouteDataSource("service_overview"),
		display: {
			title: "Service Overview",
			columns: [
				{ field: "serviceName", header: "Service" },
				{ field: "p95LatencyMs", header: "P95", unit: "duration_ms", align: "right" },
				{ field: "errorRate", header: "Error Rate", unit: "percent", align: "right" },
				{ field: "throughput", header: "Throughput", unit: "requests_per_sec", align: "right" },
			],
		},
	},
]
