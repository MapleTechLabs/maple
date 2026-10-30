import {
	resolveDbNodeStyle,
	resolvePlanetScaleDbStyle,
	withAlpha,
} from "@maple/ui/components/service-map/service-map-db-style"
import {
	getServiceMapNodeColor,
	type ServiceNodeData,
} from "@maple/ui/components/service-map/service-map-utils"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatDuration, formatRate } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { formatLatency } from "@maple/ui/lib/format"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { eyebrow } from "../../ui/eyebrow"
import { middleTruncate } from "../../ui/middle-truncate"
import { statusDot } from "../../ui/status-dot"
import { flowHandle } from "../xyflow/view"
import {
	avgCell,
	DB_ICON,
	errCell,
	HANDLE_CLASSES,
	HEALTH_TONE,
	metricCell,
	PLATFORM_ICON,
	rateText,
	selectedBorderClass,
	tooltipTrigger,
	UTILIZATION_TEXT,
} from "./node-card"
import { formatRuntime } from "./runtime"

// `ServiceNode`, `DatabaseNode`, `NamespaceAggregateNode` and the `ServiceMapNode` wrapper.

const handles = <M>(h: HtmlBuilder<M>, id: string): ReadonlyArray<Html> => [
	flowHandle(h, id, "target", "left", HANDLE_CLASSES),
	flowHandle(h, id, "source", "right", HANDLE_CLASSES),
]

/** The brand-tinted card of database and collapsed-namespace nodes; the selection adds a halo. */
const tintedCard = (color: string, tint: number, border: number, selected: boolean | undefined) => {
	const base = {
		"background-image": `linear-gradient(${withAlpha(color, tint)}, ${withAlpha(color, tint)})`,
		"border-color": selected ? color : withAlpha(color, border),
	}
	return selected ? { ...base, "box-shadow": `0 0 0 3px ${withAlpha(color, 0.16)}` } : base
}

const podsCell = <M>(h: HtmlBuilder<M>, data: ServiceNodeData): Html =>
	h.div(
		[h.Class("ml-auto flex flex-col items-end gap-px")],
		[
			eyebrow(h, { className: "text-4xs text-muted-foreground/60" }, ["pods"]),
			data.infra
				? tooltipTrigger(h, [
						h.span(
							[
								h.Class(
									"flex items-center gap-1 font-mono text-2xs font-medium tabular-nums text-secondary-foreground",
								),
							],
							[
								icon(h, "CubeIcon", { size: 10, className: "text-muted-foreground/70" }),
								String(data.infra.podCount),
							],
						),
					])
				: h.span(
						[h.Class("font-mono text-2xs tabular-nums text-muted-foreground/30")],
						[EMPTY_VALUE],
					),
		],
	)

const serviceNode = <M>(h: HtmlBuilder<M>, id: string, data: ServiceNodeData): ReadonlyArray<Html> => {
	const {
		label,
		throughput,
		hasSampling,
		errorRate,
		avgLatencyMs,
		selected,
		platform,
		runtime,
		colorMode,
	} = data
	const runtimeInfo = formatRuntime(runtime, platform)
	const accentColor = getServiceMapNodeColor(
		{ label, kind: "service", errorRate, platform },
		colorMode ?? "service",
	)
	const platformIcon = PLATFORM_ICON[platform ?? "none"]
	return [
		...handles(h, id),
		h.div(
			[
				h.Class(
					cn(
						"flex w-[220px] cursor-pointer overflow-hidden rounded-r-lg border bg-card transition-[border-color,box-shadow] duration-150",
						selected
							? selectedBorderClass(errorRate)
							: "border-border hover:border-border-active",
					),
				),
			],
			[
				h.div([h.Class("w-[3px] shrink-0"), h.Style({ "background-color": accentColor })]),
				h.div(
					[h.Class("flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5")],
					[
						h.div(
							[h.Class("flex items-center gap-1.5")],
							[
								statusDot(h, { tone: HEALTH_TONE[errorRateLevel(errorRate)] }),
								tooltipTrigger(h, [
									icon(h, platformIcon.icon, {
										size: 12,
										className: cn(
											"shrink-0",
											!platformIcon.branded && "text-muted-foreground/80",
										),
									}),
								]),
								middleTruncate(h, {
									text: label,
									tail: 12,
									className: "text-xs font-medium text-foreground",
								}),
								...(runtimeInfo === null
									? []
									: [
											runtimeInfo.icon === null
												? eyebrow(
														h,
														{
															className:
																"shrink-0 text-4xs text-muted-foreground/60",
														},
														[runtimeInfo.short],
													)
												: tooltipTrigger(h, [
														icon(h, runtimeInfo.icon, {
															size: 12,
															className: "shrink-0 text-muted-foreground/70",
														}),
													]),
										]),
							],
						),
						h.div(
							[h.Class("flex gap-4")],
							[
								tooltipTrigger(h, [
									metricCell(h, "req/s", rateText(throughput, hasSampling)),
								]),
								errCell(h, errorRate),
								avgCell(h, avgLatencyMs),
								// A service on a platform has no pods; the logo by its name already says where it runs.
								...(data.infra === undefined && data.runsOn !== undefined ? [] : [podsCell(h, data)]),
							],
						),
					],
				),
			],
		),
	]
}

const formatLag = (seconds: number): string => formatDuration(seconds * 1000)

const planetscaleRow = <M>(
	h: HtmlBuilder<M>,
	stats: NonNullable<NonNullable<ServiceNodeData["planetscale"]>["stats"]>,
): Html =>
	h.div(
		[h.Class("flex gap-4")],
		[
			metricCell(h, "conns", formatRate(stats.connectionsAvg)),
			metricCell(
				h,
				"cpu",
				`${stats.cpuMaxPercent.toFixed(0)}%`,
				UTILIZATION_TEXT[utilizationLevel(stats.cpuMaxPercent / 100)],
			),
			metricCell(
				h,
				"lag",
				formatLag(stats.replicaLagMaxSeconds),
				stats.replicaLagMaxSeconds > 10
					? "text-severity-error"
					: stats.replicaLagMaxSeconds > 1
						? "text-severity-warn"
						: undefined,
			),
		],
	)

const databaseNode = <M>(h: HtmlBuilder<M>, id: string, data: ServiceNodeData): ReadonlyArray<Html> => {
	const {
		throughput,
		hasSampling,
		errorRate,
		avgLatencyMs,
		maxLatencyMs,
		p95LatencyMs,
		dbSystem,
		dbNamespace,
		selected,
		planetscale,
	} = data
	const style = planetscale
		? resolvePlanetScaleDbStyle(dbSystem, dbNamespace, planetscale.kind)
		: resolveDbNodeStyle(dbSystem, dbNamespace)
	const { title, badge, color, branded } = style
	const tail = p95LatencyMs ?? maxLatencyMs ?? 0
	return [
		...handles(h, id),
		h.div(
			[
				h.Class(
					"flex w-[220px] cursor-pointer overflow-hidden rounded-r-lg border bg-card transition-[border-color,box-shadow] duration-150",
				),
				h.Style(tintedCard(color, 0.12, 0.4, selected)),
			],
			[
				h.div([h.Class("w-[3px] shrink-0"), h.Style({ "background-color": color })]),
				h.div(
					[h.Class("flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5")],
					[
						h.div(
							[h.Class("flex items-center gap-1.5")],
							[
								statusDot(h, { tone: HEALTH_TONE[errorRateLevel(errorRate)] }),
								tooltipTrigger(h, [
									icon(h, DB_ICON[style.icon], {
										size: 12,
										className: "shrink-0",
										style: branded ? undefined : { color },
									}),
								]),
								h.span(
									[h.Class("truncate text-xs font-medium text-foreground"), h.Title(title)],
									[title],
								),
								h.span(
									[
										h.Class(
											"ml-auto shrink-0 text-4xs font-semibold uppercase tracking-wide",
										),
										h.Style({ color }),
									],
									[badge],
								),
							],
						),
						h.div(
							[h.Class("flex gap-4")],
							[
								metricCell(h, "calls/s", rateText(throughput, hasSampling)),
								errCell(h, errorRate),
								avgCell(h, avgLatencyMs),
								metricCell(
									h,
									p95LatencyMs === undefined ? "max" : "p95",
									formatLatency(tail),
									latencyToneClass(tail, "p95"),
								),
							],
						),
						...(planetscale?.stats ? [planetscaleRow(h, planetscale.stats)] : []),
					],
				),
			],
		),
	]
}

const namespaceAggregateNode = <M>(
	h: HtmlBuilder<M>,
	id: string,
	data: ServiceNodeData,
): ReadonlyArray<Html> => {
	const { label, throughput, errorRate, avgLatencyMs, selected, nsMemberCount, colorMode } = data
	const color = getServiceMapNodeColor(data, colorMode ?? "service")
	return [
		...handles(h, id),
		h.div(
			[
				h.Class(
					"flex w-[220px] cursor-pointer overflow-hidden rounded-r-lg border border-dashed bg-card transition-[border-color,box-shadow] duration-150",
				),
				h.Style(tintedCard(color, 0.1, 0.55, selected)),
				h.Title("Collapsed namespace. Click to expand"),
			],
			[
				h.div([h.Class("w-[3px] shrink-0"), h.Style({ "background-color": color })]),
				h.div(
					[h.Class("flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5")],
					[
						h.div(
							[h.Class("flex items-center gap-1.5")],
							[
								statusDot(h, { tone: HEALTH_TONE[errorRateLevel(errorRate)] }),
								h.span(
									[
										h.Class(
											"truncate text-xs font-semibold uppercase tracking-wider text-foreground",
										),
									],
									[label],
								),
								h.span(
									[
										h.Class(
											"ml-auto shrink-0 text-4xs font-semibold uppercase tracking-wide",
										),
										h.Style({ color }),
									],
									[String(nsMemberCount ?? 0), " services"],
								),
							],
						),
						h.div(
							[h.Class("flex gap-4")],
							[
								metricCell(h, "req/s", formatRate(throughput)),
								errCell(h, errorRate),
								avgCell(h, avgLatencyMs),
							],
						),
					],
				),
			],
		),
	]
}

/** `ServiceMapNode`: the card for the node's kind inside the focus-dim wrapper. */
export const serviceMapNode = <M>(h: HtmlBuilder<M>, id: string, data: ServiceNodeData): Html =>
	h.div(
		[h.Class(cn("transition-opacity duration-200", data.dimmed && "opacity-25"))],
		data.kind === "database"
			? databaseNode(h, id, data)
			: data.kind === "namespaceAggregate"
				? namespaceAggregateNode(h, id, data)
				: serviceNode(h, id, data),
	)
