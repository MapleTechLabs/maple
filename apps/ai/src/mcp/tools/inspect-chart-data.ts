import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Option, Schema } from "effect"
import { WarehouseTimeInput } from "@maple/query-engine"
import { InspectChartDataOutput } from "@maple/domain/mcp-outputs"
import { dataSourceEndpoint } from "@maple/widgets/dashboard"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { inspectWidget, type InspectWidgetTimeRange } from "../lib/inspect-widget"
import { truncate } from "../lib/format"
import { resolveDashboardTimeRange, type DashboardTimeRangeInput } from "../lib/resolve-dashboard-time-range"
import { resolveTimeRange } from "../lib/time"
import { dashboardNotFound, toMcpDashboardError } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

const TOOL = "inspect_chart_data"

type Output = typeof InspectChartDataOutput.Type
type QueryResult = Output["queries"][number]

/** A value as JSON, or absent when it has no JSON form. JSON text drops `undefined` keys first. */
const asJson = (value: unknown): Option.Option<Schema.Json> =>
	Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(JSON.stringify(value) ?? "")

const decodeRows = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
)

function formatNumber(value: number | null): string {
	if (value === null) return "null"
	if (!Number.isFinite(value)) return String(value)
	if (Math.abs(value) >= 1000) return value.toFixed(0)
	if (Math.abs(value) >= 1) return value.toFixed(2)
	return value.toFixed(4)
}

function queryBlocks(query: QueryResult): ReadonlyArray<DocBlock> {
	const lines: string[] = [`Status: ${query.status}`]
	if (query.builderWarnings && query.builderWarnings.length > 0) {
		lines.push(`Warnings: ${query.builderWarnings.join("; ")}`)
	}
	const heading = doc.heading(`Query ${query.queryName} (${query.queryId})`)
	if (query.status === "error" && query.error) {
		lines.push(`Error: ${query.error}`)
		return [heading, doc.text(lines.join("\n"))]
	}
	lines.push(`Rows: ${query.stats.rowCount}, Series: ${query.stats.seriesCount}`)
	if (query.stats.firstBucket && query.stats.lastBucket) {
		lines.push(`Time span: ${query.stats.firstBucket} to ${query.stats.lastBucket}`)
	}
	if (query.reducedValue !== undefined) {
		lines.push(`Reduced value: ${formatNumber(query.reducedValue)}`)
	}
	const blocks: Array<DocBlock> = [heading, doc.text(lines.join("\n"))]
	if (query.stats.seriesStats.length > 0) {
		const shown = query.stats.seriesStats.slice(0, 10)
		blocks.push(
			doc.text("Series stats:"),
			doc.list([
				...shown.map(
					(series) =>
						`${series.name}: min=${formatNumber(series.min)} max=${formatNumber(series.max)} avg=${formatNumber(series.avg)} (valid=${series.validCount}, null=${series.nullCount}, zero=${series.zeroCount})`,
				),
				...(query.stats.seriesStats.length > 10
					? [`+${query.stats.seriesStats.length - 10} more series`]
					: []),
			]),
		)
	}
	if (query.flags.length > 0) blocks.push(doc.text(`Flags: ${query.flags.join(", ")}`))
	return blocks
}

function rawSqlCell(value: Schema.Json | undefined): string {
	if (value === null || value === undefined) return "null"
	if (typeof value === "object") return truncate(JSON.stringify(value), 60)
	return truncate(String(value), 60)
}

const inspectChartDataDescription =
	"Inspect the actual data a dashboard chart will render. " +
	"The mutation tools (`create_dashboard`, `add_dashboard_widget`, `update_dashboard_widget`) now run this validation automatically. " +
	"Use this tool to re-verify a widget after fixing it, or to inspect any existing widget on demand. " +
	"Returns row counts, series statistics, sample data points, and sanity flags (EMPTY, ALL_ZEROS, FLAT_LINE, UNIT_MISMATCH, PERCENT_SCALE_MISMATCH, NEGATIVE_VALUES, UNREALISTIC_MAGNITUDE, SINGLE_SERIES_DOMINATES, CARDINALITY_EXPLOSION, SUSPICIOUS_GAP, BROKEN_BREAKDOWN, SINGLE_POINT, ALL_NULLS, BUILDER_WARNINGS). " +
	"The verdict is one of `looks_healthy`, `suspicious`, or `broken`. **If the verdict is not `looks_healthy`, fix the widget via update_dashboard_widget and re-inspect.** " +
	"Supports widgets backed by a `query` data source (timeseries and breakdown result shapes) and by `raw_sql` (which is executed and its rows returned). " +
	"Limitations: formula expressions in `formulas[]` are NOT evaluated server-side — only the base queries are inspected; " +
	"checks only the requested window without the dashboard UI's auto-fallback. For widgets backed by a curated `route` data source (service_overview, errors_summary, etc.), this tool returns guidance to use `query_data` directly with the widget's params."

export function registerInspectChartDataTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description: inspectChartDataDescription,
		parameters: Schema.Struct({
			dashboard_id: P.text("Dashboard ID containing the widget"),
			widget_id: P.text("Widget ID to inspect"),
			start_time: Schema.optional(WarehouseTimeInput).annotate({
				description:
					"Override start time (YYYY-MM-DD HH:mm:ss UTC or ISO 8601), with end_time. Defaults to the widget's own timeRange, else the dashboard's.",
			}),
			end_time: Schema.optional(WarehouseTimeInput).annotate({
				description:
					"Override end time (YYYY-MM-DD HH:mm:ss UTC or ISO 8601), with start_time. Defaults to the widget's own timeRange, else the dashboard's.",
			}),
		}),
		output: InspectChartDataOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting chart data"],
		handler: Effect.fn("McpTool.inspectChartData")(function* ({
			dashboard_id,
			widget_id,
			start_time,
			end_time,
		}) {
			if ((start_time === undefined) !== (end_time === undefined)) {
				return yield* new McpInvalidInputError({
					message:
						"Pass both start_time and end_time to override the window, or neither to use the widget's.",
					parameter: start_time === undefined ? "start_time" : "end_time",
				})
			}

			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const list = yield* persistence
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpDashboardError(TOOL)))

			const dashboard = list.dashboards.find((d) => d.id === dashboard_id)
			if (!dashboard) return yield* dashboardNotFound(dashboard_id)

			const widget = dashboard.widgets.find((w) => w.id === widget_id)
			if (!widget) {
				return yield* new McpInvalidInputError({
					message: `Widget not found: ${widget_id} in dashboard ${dashboard_id}. Use get_dashboard to list widget IDs.`,
					parameter: "widget_id",
				})
			}

			let timeRange: InspectWidgetTimeRange
			if (start_time !== undefined && end_time !== undefined) {
				const range = resolveTimeRange(start_time, end_time)
				if (range.requestedHours < 0) {
					return yield* new McpInvalidInputError({
						message: `start_time (${range.st}) is after end_time (${range.et}).`,
						parameter: "start_time",
					})
				}
				timeRange = { startTime: range.st, endTime: range.et, source: "override" }
			} else {
				// A widget pinned to its own window is inspected on that window —
				// otherwise the rows returned here aren't the rows the tile renders.
				const source = widget.timeRange ? ("widget" as const) : ("dashboard" as const)
				const resolved = resolveDashboardTimeRange(
					(widget.timeRange ?? dashboard.timeRange) as DashboardTimeRangeInput,
				)
				if (resolved) {
					timeRange = { startTime: resolved.startTime, endTime: resolved.endTime, source }
				} else {
					const fallback = resolveTimeRange(undefined, undefined, 6)
					timeRange = { startTime: fallback.st, endTime: fallback.et, source: "fallback" }
				}
			}

			const outcome = yield* inspectWidget({ tenant, dashboardName: dashboard.name, widget, timeRange })

			const base = {
				dashboardId: dashboard.id,
				dashboardName: dashboard.name,
				timeRange,
			}
			const widgetInfo = {
				id: widget.id,
				...(widget.display.title === undefined ? undefined : { title: widget.display.title }),
				visualization: widget.visualization,
				...(widget.display.unit === undefined ? undefined : { displayUnit: widget.display.unit }),
				hasFormulaWarning: false,
				hasUnsupportedTransform: false,
			}

			switch (outcome.kind) {
				case "supported": {
					const { data } = outcome
					const outcomeKind: Output["outcome"] = "inspected"
					return {
						...base,
						outcome: outcomeKind,
						widget: data.widget,
						timeRange: data.timeRange,
						queries: data.queries.map(({ spec, ...query }) => {
							const json = spec === undefined ? Option.none() : asJson(spec)
							return Option.isSome(json) ? { ...query, spec: json.value } : query
						}),
						verdict: data.verdict,
						flags: data.flags,
						notes: data.notes,
					}
				}
				case "raw_sql": {
					const { data } = outcome
					const verdict: Output["verdict"] =
						data.status === "error"
							? "broken"
							: data.rowCount === 0
								? "suspicious"
								: "looks_healthy"
					const outcomeKind: Output["outcome"] = "raw_sql"
					return {
						...base,
						outcome: outcomeKind,
						widget: { ...widgetInfo, endpoint: data.endpoint },
						timeRange: data.timeRange,
						queries: [],
						verdict,
						flags: [],
						notes: [],
						rawSql: {
							sql: data.sql,
							...(data.expandedSql === undefined
								? undefined
								: { expandedSql: data.expandedSql }),
							status: data.status,
							...(data.error === undefined ? undefined : { error: data.error }),
							rowCount: data.rowCount,
							columns: data.columns,
							rows: Option.getOrElse(decodeRows(JSON.stringify(data.rows)), () => []),
							truncated: data.truncated,
						},
					}
				}
				case "unsupported": {
					const dataSource = asJson(widget.dataSource)
					// Nothing ran, so there is no verdict to report; `suspicious` is the closest
					// member and `outcome` says why.
					const verdict: Output["verdict"] = "suspicious"
					const outcomeKind: Output["outcome"] = "unsupported"
					return {
						...base,
						outcome: outcomeKind,
						widget: {
							...widgetInfo,
							endpoint: dataSourceEndpoint(widget.dataSource) ?? "(typed data source)",
						},
						queries: [],
						verdict,
						flags: [],
						notes: [],
						...(Option.isSome(dataSource) ? { dataSource: dataSource.value } : undefined),
					}
				}
				case "skipped":
					return yield* new McpInvalidInputError({
						message: outcome.detail,
						parameter: "widget_id",
					})
				case "inspection_error":
					return yield* new McpQueryError({
						message: `Inspection failed unexpectedly: ${outcome.message}`,
						pipeName: TOOL,
					})
			}
		}),
		render: (output) => {
			const title = `Widget inspection: ${output.widget.title ?? output.widget.id}`
			const scope: Array<readonly [string, string | undefined]> = [
				["Dashboard", output.dashboardName],
				["Visualization", output.widget.visualization],
				["Endpoint", output.widget.endpoint],
			]
			const window = `Time range: ${output.timeRange.startTime} to ${output.timeRange.endTime} (source: ${output.timeRange.source})`
			const recheck = doc.next(
				TOOL,
				{ dashboard_id: output.dashboardId, widget_id: output.widget.id },
				"re-verify after fixing it with update_dashboard_widget",
			)

			if (output.outcome === "unsupported") {
				return {
					title,
					scope,
					blocks: [
						doc.text(
							"This endpoint is not yet supported by inspect_chart_data. Use the `query_data` tool directly to verify, with the params shown below.",
						),
						// The whole data source: this is the diagnostic path for a widget nothing
						// else could read, so showing exactly what is stored beats a subset.
						...(output.dataSource === undefined
							? []
							: [
									doc.text("Widget definition:"),
									doc.code("json", JSON.stringify(output.dataSource, null, 2)),
								]),
					],
				}
			}

			if (output.outcome === "raw_sql" && output.rawSql !== undefined) {
				const raw = output.rawSql
				if (raw.status === "error") {
					return {
						title,
						scope,
						blocks: [
							doc.text(window),
							doc.heading("Verdict: BROKEN"),
							doc.text(`Error: ${raw.error ?? "unknown error"}`),
							doc.text(
								"Fix the SQL via update_dashboard_widget and re-run inspect_chart_data to verify.",
							),
						],
						next: [recheck],
					}
				}
				return {
					title,
					scope,
					blocks: [
						doc.text(window),
						doc.heading(`Verdict: ${raw.rowCount === 0 ? "SUSPICIOUS (no rows)" : "OK"}`),
						doc.text(`Rows: ${raw.rowCount} | Columns: ${raw.columns.length}`),
						...(raw.rowCount === 0
							? [
									doc.text(
										"Query executed successfully but returned no rows. Check filters and the time range.",
									),
								]
							: [
									doc.table(
										raw.columns,
										raw.rows.map((row) => raw.columns.map((col) => rawSqlCell(row[col]))),
									),
								]),
					],
					...(raw.truncated
						? { truncation: { shown: raw.rows.length, total: raw.rowCount, noun: "rows" } }
						: undefined),
					...(raw.rowCount === 0 ? { next: [recheck] } : undefined),
				}
			}

			return {
				title,
				scope,
				blocks: [
					...(output.widget.displayUnit
						? [doc.text(`Display unit: ${output.widget.displayUnit}`)]
						: []),
					doc.text(window),
					doc.heading(`Verdict: ${output.verdict.toUpperCase()}`),
					doc.text(
						output.flags.length > 0 ? `Flags: ${output.flags.join(", ")}` : "No issues detected.",
					),
					...output.queries.flatMap(queryBlocks),
					...(output.notes.length > 0 ? [doc.heading("Notes"), doc.list(output.notes)] : []),
					...(output.verdict !== "looks_healthy"
						? [
								doc.text(
									`Verdict is '${output.verdict}'. Refine the widget via update_dashboard_widget and re-run inspect_chart_data to verify.`,
								),
							]
						: []),
				],
				...(output.verdict !== "looks_healthy" ? { next: [recheck] } : undefined),
			}
		},
	})
}
