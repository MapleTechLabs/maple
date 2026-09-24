import type { McpToolRegistrar } from "./types"
import { queryWarehouse, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ListMetricsOutput } from "@maple/domain/mcp-outputs"
import { MetricType } from "@maple/query-engine"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_DISCOVERY_MAX_HOURS })

interface MetricListRow {
	readonly metricName: string
	readonly metricType: string
	readonly serviceName: string
	readonly metricUnit: string | null
	readonly isMonotonic: boolean | number
	readonly dataPointCount: number | string
}

interface MetricSummaryRow {
	readonly metricType: string
	readonly metricCount: number | string
	readonly dataPointCount: number | string
}

export function registerListMetricsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_metrics",
		description:
			"Discover available custom metrics with their types, units, monotonicity, and data volume. Supports pagination: check hasMore in the response. Use query_data source=metrics with a discovered metric_name and metric_type. For monotonic sum metrics, prefer metric=rate or metric=increase instead of raw sum.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			search: P.optionalText("Search in metric name"),
			metric_type: P.optionalOneOf(MetricType.literals, "Only metrics of this type"),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 50, max: 500, noun: "metrics" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ListMetricsOutput,
		hints: { readOnly: true },
		phrases: ["Listing metrics", "Looking up metrics"],
		handler: Effect.fn("McpTool.listMetrics")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "list_metrics")
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				metricType: params.metric_type ?? "all",
				limit: params.limit,
				offset: params.offset,
			})

			const [metricsResult, summaryResult] = yield* Effect.all(
				[
					queryWarehouse<MetricListRow>("list_metrics", {
						start_time: st,
						end_time: et,
						service: params.service,
						search: params.search,
						metric_type: params.metric_type,
						offset: params.offset,
						limit: params.limit,
					}),
					queryWarehouse<MetricSummaryRow>("metrics_summary", {
						start_time: st,
						end_time: et,
						service: params.service,
					}),
				],
				{ concurrency: "unbounded" },
			)

			const metrics = metricsResult.data
			yield* Effect.annotateCurrentSpan("result.rowCount", metrics.length)

			const hasMore = metrics.length === params.limit
			return {
				timeRange: { start: st, end: et },
				pagination: {
					offset: params.offset,
					limit: params.limit,
					hasMore,
					...(hasMore ? { nextOffset: params.offset + metrics.length } : undefined),
				},
				summary: summaryResult.data.map((s) => ({
					metricType: s.metricType,
					metricCount: Number(s.metricCount),
					dataPointCount: Number(s.dataPointCount),
				})),
				metrics: metrics.map((m) => ({
					metricName: m.metricName,
					metricType: m.metricType,
					serviceName: m.serviceName,
					metricUnit: m.metricUnit || "",
					isMonotonic: Boolean(m.isMonotonic),
					dataPointCount: Number(m.dataPointCount),
				})),
				filters: {
					...(params.service === undefined ? undefined : { service: params.service }),
					...(params.search === undefined ? undefined : { search: params.search }),
					...(params.metric_type === undefined ? undefined : { metricType: params.metric_type }),
				},
			}
		}),
		render: (output) => {
			const filters = output.filters ?? {}
			// `metrics_summary` is scoped only by service, NOT by search/metric_type. Printing those
			// totals next to an empty filtered result reads as a contradiction, so suppress them.
			const hasNarrowingFilter = filters.search !== undefined || filters.metricType !== undefined
			const showSummary =
				output.summary.length > 0 && (output.metrics.length > 0 || !hasNarrowingFilter)
			const filterDesc = [
				filters.search === undefined ? undefined : `name contains "${filters.search}"`,
				filters.metricType === undefined ? undefined : `type=${filters.metricType}`,
				filters.service === undefined ? undefined : `service=${filters.service}`,
			]
				.filter((part) => part !== undefined)
				.join(", ")
			const pagination = output.pagination
			return {
				title: "Available Metrics",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Service", filters.service],
					["Search", filters.search],
					["Type", filters.metricType],
				],
				...(output.metrics.length === 0
					? {
							empty: {
								message:
									filterDesc === ""
										? "No metrics found in this time range."
										: `No metrics found matching ${filterDesc} in this time range.`,
								hints: ["Widen start_time/end_time, or loosen the search and type filters."],
							},
						}
					: undefined),
				blocks: [
					...(showSummary
						? [
								doc.table(
									["Type", "Metrics", "Data Points"],
									output.summary.map((s) => [
										s.metricType,
										formatNumber(s.metricCount),
										formatNumber(s.dataPointCount),
									]),
								),
							]
						: []),
					...(output.metrics.length === 0
						? []
						: [
								doc.table(
									["Name", "Type", "Monotonic", "Service", "Unit", "Data Points"],
									output.metrics.map((m) => [
										truncate(m.metricName, 40),
										m.metricType,
										m.isMonotonic ? "yes" : "-",
										m.serviceName,
										m.metricUnit || "-",
										formatNumber(m.dataPointCount),
									]),
								),
							]),
				],
				...(pagination?.nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: output.metrics.length,
								noun: "metrics",
								next: doc.next(
									"list_metrics",
									{
										start_time: output.timeRange.start,
										end_time: output.timeRange.end,
										service: filters.service,
										search: filters.search,
										metric_type: filters.metricType,
										offset: pagination.nextOffset,
										limit: pagination.limit,
									},
									"the next page",
								),
							},
						}),
				next: output.metrics.slice(0, 3).map((m) =>
					doc.next(
						"query_data",
						{
							source: "metrics",
							kind: "timeseries",
							metric_name: m.metricName,
							metric_type: m.metricType,
							metric: m.metricType === "sum" && m.isMonotonic ? "rate" : "avg",
						},
						"chart this metric",
					),
				),
			}
		},
	})
}
