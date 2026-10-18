import { createQueryDraft, type QueryBuilderQueryDraft } from "@maple/query-engine/query-builder"
import { makeQueryDataSource, makeRouteDataSource } from "@maple/widgets/dashboard"
import type { SyncedRow } from "../../dataset.ts"
import { acmeAdmin, DAY, isoBefore } from "../../identity.ts"

/**
 * A board with every breakdown widget type over the warehouse (pie, horizontal bar, funnel bars and
 * drop-off, histogram, heatmap), a gauge and a stat with its sparkline, so the tiles run on real
 * query answers rather than the lab's fixtures.
 */

export const WIDGETS_DASHBOARD_ID = "dash_parity_ops_widgets"

/** `buildBreakdownQuery` (@maple/web-data's widget presets). */
const breakdownQuery = (
	index: number,
	overrides: Readonly<{ whereClause: string; groupBy: ReadonlyArray<string>; name?: string; legend?: string }>,
): QueryBuilderQueryDraft => {
	const draft = createQueryDraft(index)
	return {
		...draft,
		name: overrides.name ?? draft.name,
		enabled: true,
		dataSource: "traces",
		whereClause: overrides.whereClause,
		aggregation: "count",
		groupBy: [...overrides.groupBy],
		addOns: { groupBy: true, having: false, orderBy: false, limit: true, legend: false },
		limit: "10",
		legend: overrides.legend ?? draft.legend,
	}
}

const breakdown = (queries: ReadonlyArray<QueryBuilderQueryDraft>) =>
	makeQueryDataSource({
		resultShape: "breakdown",
		queries: [...queries],
		formulas: [],
		comparison: { mode: "none", includePercentChange: false },
	})

const byService = (whereClause: string) => breakdown([breakdownQuery(0, { whereClause, groupBy: ["service.name"] })])

const traceCount = makeQueryDataSource({
	resultShape: "timeseries",
	queries: [{ ...createQueryDraft(0), dataSource: "traces", aggregation: "count", whereClause: "" }],
})

const totalTraces = makeRouteDataSource("service_usage", undefined, {
	reduceToValue: { field: "totalTraces", aggregate: "sum" },
})

const widget = (
	id: string,
	visualization: string,
	dataSource: unknown,
	display: Readonly<Record<string, unknown>>,
	layout: Readonly<{ x: number; y: number; w: number; h: number }>,
) => ({ id, visualization, dataSource, display, layout })

const WIDGETS = [
	widget("traces-stat", "stat", totalTraces, {
		title: "Total Traces",
		unit: "number",
		sparkline: { enabled: true, dataSource: traceCount },
	}, { x: 0, y: 0, w: 3, h: 4 }),
	widget("traces-gauge", "gauge", totalTraces, {
		title: "Trace budget",
		unit: "number",
		gauge: { min: 0, max: 20000 },
		thresholds: [{ value: 0, color: "var(--color-emerald-500)" }, { value: 15000, color: "var(--color-red-500)" }],
	}, { x: 3, y: 0, w: 3, h: 4 }),
	widget("traces-pie", "pie", byService("root_only = true"), {
		title: "Traces by Service",
		chartId: "query-builder-pie",
		unit: "number",
		pie: { donut: true, showLabels: false, showPercent: true },
	}, { x: 6, y: 0, w: 6, h: 4 }),
	widget("spans-hbar", "hbar", byService(""), {
		title: "Spans by Service",
		chartId: "query-builder-hbar",
		unit: "number",
	}, { x: 0, y: 4, w: 6, h: 4 }),
	widget("traces-funnel", "funnel", byService("root_only = true"), {
		title: "Traces by Service (funnel)",
		chartId: "query-builder-funnel",
		unit: "number",
		funnel: { showStepPercent: true },
	}, { x: 6, y: 4, w: 6, h: 4 }),
	widget("traces-dropoff", "funnel", byService("root_only = true"), {
		title: "Traces drop-off",
		chartId: "query-builder-funnel",
		unit: "number",
		funnel: { variant: "dropoff", showStepPercent: true },
	}, { x: 0, y: 8, w: 6, h: 4 }),
	widget("spans-histogram", "histogram", byService(""), {
		title: "Span volume by Service",
		chartId: "query-builder-histogram",
		unit: "number",
		histogram: { bucketCount: 20 },
	}, { x: 6, y: 8, w: 6, h: 4 }),
	widget("errors-heatmap", "heatmap", breakdown([
		breakdownQuery(0, { name: "A", legend: "Errors", whereClause: "has_error = true", groupBy: ["service.name"] }),
		breakdownQuery(1, { name: "B", legend: "OK", whereClause: "has_error = false", groupBy: ["service.name"] }),
	]), {
		title: "Errors vs OK by Service",
		chartId: "query-builder-heatmap",
		unit: "number",
		heatmap: { colorScale: "blues" },
	}, { x: 0, y: 12, w: 12, h: 5 }),
]

export const SECTIONS_DASHBOARD_ID = "dash_parity_ops_sections"

const inTab = <W extends ReturnType<typeof widget>>(item: W, sectionId: string, tabId: string) => ({
	...item,
	sectionId,
	tabId,
})

/** A grouped board: a root stat, a tabbed group, a group collapsed by default and a pinned empty one. */
const SECTION_WIDGETS = [
	widget("root-traces", "stat", totalTraces, { title: "Total Traces", unit: "number" }, { x: 0, y: 0, w: 3, h: 4 }),
	inTab(
		widget("latency-pie", "pie", byService("root_only = true"), {
			title: "Traces by Service",
			chartId: "query-builder-pie",
			unit: "number",
		}, { x: 0, y: 0, w: 6, h: 4 }),
		"sec-latency",
		"tab-overview",
	),
	inTab(
		widget("latency-stat", "stat", totalTraces, { title: "Traces (overview)", unit: "number" }, {
			x: 6,
			y: 0,
			w: 3,
			h: 4,
		}),
		"sec-latency",
		"tab-overview",
	),
	inTab(
		widget("breakdown-hbar", "hbar", byService(""), {
			title: "Spans by Service",
			chartId: "query-builder-hbar",
			unit: "number",
		}, { x: 0, y: 0, w: 6, h: 4 }),
		"sec-latency",
		"tab-breakdown",
	),
	inTab(
		widget("errors-funnel", "funnel", byService("has_error = true"), {
			title: "Errors by Service",
			chartId: "query-builder-funnel",
			unit: "number",
		}, { x: 0, y: 0, w: 6, h: 4 }),
		"sec-errors",
		"tab-errors",
	),
]

const SECTIONS = [
	{
		id: "sec-latency",
		title: "Latency",
		tabs: [
			{ id: "tab-overview", title: "Overview" },
			{ id: "tab-breakdown", title: "Breakdown" },
		],
	},
	{ id: "sec-errors", title: "Errors", collapsed: true, tabs: [{ id: "tab-errors", title: "Errors" }] },
	{ id: "sec-pinned", title: "Pinned notes", collapsible: false, tabs: [{ id: "tab-pinned", title: "Pinned notes" }] },
]

export const VARIABLES_DASHBOARD_ID = "dash_parity_ops_variables"

/** A board with a custom, a query (facet, with All) and a textbox variable, read by its widgets. */
const VARIABLES = [
	{
		name: "env",
		label: "Environment",
		type: "custom",
		defaultValue: "production",
		options: [{ value: "production" }, { value: "staging" }],
	},
	{ name: "service", type: "query", includeAll: true, source: { kind: "facet", facet: "service" } },
	{ name: "route", type: "textbox" },
]

const VARIABLE_WIDGETS = [
	widget("var-pie", "pie", byService('deployment.environment = "$env"'), {
		title: "Traces in $env",
		chartId: "query-builder-pie",
		unit: "number",
	}, { x: 0, y: 0, w: 6, h: 4 }),
	widget("var-hbar", "hbar", byService('service.name = "$service"'), {
		title: "Spans for $service",
		chartId: "query-builder-hbar",
		unit: "number",
	}, { x: 6, y: 0, w: 6, h: 4 }),
]

const createdAt = isoBefore(5 * DAY)
const updatedAt = isoBefore(DAY)

const board = (
	id: string,
	name: string,
	description: string,
	content: Readonly<Record<string, unknown>>,
): SyncedRow => ({
	org_id: acmeAdmin.orgId,
	id,
	name,
	payload_json: { id, name, description, timeRange: { type: "relative", value: "6h" }, ...content, createdAt, updatedAt },
	created_at: createdAt,
	updated_at: updatedAt,
	created_by: acmeAdmin.userId,
	updated_by: acmeAdmin.userId,
	version: 3,
})

export const widgetsDashboard = board(WIDGETS_DASHBOARD_ID, "Widget gallery", "Every breakdown widget over the warehouse.", {
	widgets: WIDGETS,
	tags: ["lab", "gallery"],
})

export const sectionsDashboard = board(SECTIONS_DASHBOARD_ID, "Grouped board", "Groups, tabs and a pinned group.", {
	widgets: SECTION_WIDGETS,
	sections: SECTIONS,
	tags: ["slo", "checkout"],
})

export const variablesDashboard = board(VARIABLES_DASHBOARD_ID, "Variables board", "Widgets filtered by dashboard variables.", {
	widgets: VARIABLE_WIDGETS,
	variables: VARIABLES,
	tags: ["checkout"],
})

