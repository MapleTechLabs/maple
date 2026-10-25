import {
	resolveDbNodeStyle,
	resolvePlanetScaleDbStyle,
} from "@maple/ui/components/service-map/service-map-db-style"
import type { PlanetScaleNodeMetrics } from "@maple/ui/components/service-map/service-map-utils"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatErrorRate, formatLatency, formatNumber, formatRate } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as ServiceMap from "../../service-map/map/service-map"
import { DB_ICON } from "../../service-map/map/node-card"
import { separator } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { scrollArea } from "../../ui/scroll-area"
import type { ScopedRows } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { detailPanelHeader, edgeRow, metricTile, metricValue, sampled } from "./view-panel-kit"
import {
	failureAlert,
	hyperdriveSection,
	planetscaleSection,
	queryActivity,
	topQueries,
} from "./view-db-sections"

// The database detail panel.
// TODO(gcp): `GcpCloudSqlSection` renders only while a GCP connection collects metrics; not ported.

type H = HtmlBuilder<Message>

export type DatabasePanelInputs = Readonly<{
	nodeId: string
	dbSystem: string
	/** "" is the generic node (edges with no identified database). */
	dbNamespace: string
	planetscale: PlanetScaleNodeMetrics | undefined
	rows: ScopedRows
	durationSeconds: number
	timeZone: string
}>

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

const hyperdriveOf = (model: Model, nodeId: string) =>
	Option.getOrUndefined(
		Option.flatMapNullishOr(
			model.map,
			(map) => map.source.rawNodes.find((node) => node.id === nodeId)?.data.hyperdrive,
		),
	)

/** The node's numbers: the summary once it lands, the edges until then (quantiles have no fallback). */
const panelMetrics = (model: Model, inputs: DatabasePanelInputs) => {
	const callers = inputs.rows.dbEdges.filter(
		(edge) => edge.dbSystem === inputs.dbSystem && edge.dbNamespace === inputs.dbNamespace,
	)
	const totalCalls = callers.reduce((sum, edge) => sum + edge.callCount, 0)
	const totalErrors = callers.reduce((sum, edge) => sum + edge.errorCount, 0)
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const avgLatencyMs =
		totalCalls > 0
			? callers.reduce((sum, edge) => sum + edge.avgDurationMs * edge.callCount, 0) / totalCalls
			: 0
	const estimatedCalls = callers.reduce((sum, edge) => sum + edge.estimatedCallCount, 0)
	const response = Option.getOrNull(
		Option.map(AsyncData.getData(model.dbSummary.data), (data) => data.value),
	)
	const summary = response?.summary ?? null
	const queryCount = summary?.estimatedQueryCount ?? estimatedCalls
	return {
		callers,
		response,
		queryCount,
		callsPerSecond: queryCount / Math.max(inputs.durationSeconds, 1),
		errorRate: summary?.errorRate ?? errorRate,
		avgLatencyMs: summary?.avgDurationMs ?? avgLatencyMs,
		p50: summary?.p50DurationMs ?? null,
		p95: summary?.p95DurationMs ?? null,
		hasSampling: summary
			? summary.estimatedQueryCount > summary.queryCount + 1
			: callers.some((caller) => caller.hasSampling),
	}
}

type PanelMetrics = ReturnType<typeof panelMetrics>

const metricsGrid = (h: H, metrics: PanelMetrics): Html => {
	const { p50, p95 } = metrics
	return h.div(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h4" }, ["Metrics"]),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-6 gap-y-4")],
				[
					metricTile(
						h,
						"Queries",
						metricValue(
							h,
							undefined,
							sampled(metrics.hasSampling, formatNumber(metrics.queryCount)),
						),
					),
					metricTile(
						h,
						"Throughput",
						metricValue(
							h,
							undefined,
							sampled(metrics.hasSampling, formatRate(metrics.callsPerSecond)),
						),
						["calls/s"],
					),
					metricTile(
						h,
						"Error rate",
						metricValue(h, errorRateClass(metrics.errorRate), [
							formatErrorRate(metrics.errorRate),
						]),
					),
					metricTile(
						h,
						"P50 latency",
						metricValue(
							h,
							cn(p50 === null ? "text-muted-foreground" : latencyToneClass(p50, "p50")),
							[p50 === null ? EMPTY_VALUE : formatLatency(p50)],
						),
					),
					metricTile(
						h,
						"P95 latency",
						metricValue(
							h,
							cn(
								p95 === null
									? "text-muted-foreground"
									: p50 !== null && p95 > p50 * 3
										? "text-severity-warn"
										: latencyToneClass(p95, "p95"),
							),
							[p95 === null ? EMPTY_VALUE : formatLatency(p95)],
						),
					),
					metricTile(
						h,
						"Avg latency",
						metricValue(h, cn(latencyToneClass(metrics.avgLatencyMs, "avg")), [
							formatLatency(metrics.avgLatencyMs),
						]),
					),
				],
			),
		],
	)
}

const header = (h: H, inputs: DatabasePanelInputs): Html => {
	const style =
		inputs.planetscale === undefined
			? resolveDbNodeStyle(inputs.dbSystem, inputs.dbNamespace)
			: resolvePlanetScaleDbStyle(inputs.dbSystem, inputs.dbNamespace, inputs.planetscale.kind)
	return detailPanelHeader(
		h,
		style.color,
		[
			icon(h, DB_ICON[style.icon], {
				size: 14,
				className: "shrink-0",
				style: style.branded ? undefined : { color: style.color },
			}),
			h.span([h.Class("text-sm font-semibold text-foreground truncate")], [style.title]),
			eyebrow(h, { className: "shrink-0" }, [style.badge]),
		],
		[
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Close",
					attributes: [h.OnClick(toMap(ServiceMap.Message.ClickedCloseDetail()))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)
}

/** The database's panel: header, metrics, the overlays, query activity, top shapes and callers. */
export const databasePanel = (h: H, model: Model, inputs: DatabasePanelInputs): Html => {
	const metrics = panelMetrics(model, inputs)
	const hyperdrive = hyperdriveOf(model, inputs.nodeId)
	const isWaiting =
		AsyncData.isLoading(model.dbSummary.data) || AsyncData.isRefreshing(model.dbSummary.data)
	return h.div(
		[h.Class("flex flex-col h-full bg-background overflow-hidden")],
		[
			header(h, inputs),
			scrollArea(h, { idPrefix: "service-map-db-scroll", className: "flex-1 min-h-0" }, [
				h.div(
					[h.Class("p-4 space-y-5")],
					[
						metricsGrid(h, metrics),
						...(hyperdrive !== undefined && hyperdrive.length > 0
							? [hyperdriveSection(h, hyperdrive)]
							: []),
						...(inputs.planetscale === undefined
							? []
							: [planetscaleSection(h, model, inputs.planetscale)]),
						h.div(
							[h.Class("space-y-3")],
							[
								separator(h, "horizontal", undefined),
								h.div(
									[h.Class("flex items-center justify-between gap-2")],
									[
										eyebrow(h, { as: "h4" }, ["Query activity"]),
										...(isWaiting && metrics.response !== null
											? [
													h.span(
														[h.Class("text-3xs text-muted-foreground")],
														["Refreshing"],
													),
												]
											: []),
									],
								),
								...Option.toArray(failureAlert(h, model.dbSummary.data)),
								queryActivity(h, model, metrics.response, isWaiting, inputs.timeZone),
							],
						),
						...topQueries(h, metrics.response),
						...(metrics.callers.length === 0
							? []
							: [
									h.div(
										[h.Class("space-y-3")],
										[
											separator(h, "horizontal", undefined),
											eyebrow(h, { as: "h4" }, ["Called by"]),
											h.div(
												[h.Class("space-y-1.5")],
												metrics.callers.map((caller) =>
													edgeRow(h, {
														service: caller.sourceService,
														edge: caller,
														durationSeconds: inputs.durationSeconds,
														unit: "calls/s",
													}),
												),
											),
										],
									),
								]),
					],
				),
			]),
		],
	)
}
