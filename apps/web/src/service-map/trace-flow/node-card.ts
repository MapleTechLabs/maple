import { type CacheInfo, cacheResultStyles } from "@maple/ui/lib/cache"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration } from "@maple/ui/lib/format"
import { httpStatusTone } from "@maple/ui/lib/http"
import { shortId } from "@maple/ui/lib/ids"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { flowHandle } from "../xyflow/view"
import { pickAttr } from "./cloud-platforms"
import type { AggregatedDuration, FlowNodeData } from "./flow-graph"
import type { SpanDescription } from "./span-category"
import { describeSpan } from "./span-category"

// `FlowSpanNode` (packages/ui `traces/flow-node.tsx`).

const HANDLE_CLASSES = "!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"

/** `<ServiceDot>` (packages/ui `service-dot.tsx`). */
export const serviceDot = <M>(h: HtmlBuilder<M>, serviceName: string, className: string): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class(cn("shrink-0 rounded-[35%] [corner-shape:squircle]", "size-2", className)),
		h.Style({ "background-color": getServiceColor(serviceName) }),
	])

const formatCombinedDuration = (isCombined: boolean, single: number, aggregated: AggregatedDuration) => {
	if (!isCombined) {
		const formatted = formatDuration(single)
		return { main: formatted, tooltip: formatted }
	}
	const avg = formatDuration(aggregated.avg)
	return {
		main: `avg ${avg}`,
		tooltip: `Avg: ${avg} | Min: ${formatDuration(aggregated.min)} | Max: ${formatDuration(aggregated.max)} | Total: ${formatDuration(aggregated.total)}`,
	}
}

const REDIS_LAYERS = [
	[
		"M22.5 13.7c-.1.5-1.6 1.2-4.6 2.3-1.7.7-3.8 1.3-5.9 1.7-2.1-.4-4.2-1-5.9-1.7C3.1 14.9 1.6 14.2 1.5 13.7v2.5c0 .6 1.5 1.3 4.5 2.3 1.7.7 3.8 1.3 5.9 1.7 2.1-.4 4.2-1 5.9-1.7 3-1 4.6-1.7 4.6-2.3V13.7z",
		"0.4",
	],
	[
		"M22.5 9.2c-.1.5-1.6 1.2-4.6 2.3-1.7.7-3.8 1.3-5.9 1.7-2.1-.4-4.2-1-5.9-1.7C3.1 10.4 1.6 9.7 1.5 9.2v2.5c0 .6 1.5 1.3 4.5 2.3 1.7.7 3.8 1.3 5.9 1.7 2.1-.4 4.2-1 5.9-1.7 3-1 4.6-1.7 4.6-2.3V9.2z",
		"0.6",
	],
	[
		"M22.5 4.7c0 .6-1.5 1.3-4.6 2.3C16.2 7.7 14.1 8.3 12 8.7 9.9 8.3 7.8 7.7 6.1 7 3.1 6 1.5 5.3 1.5 4.7S3.1 3.4 6.1 2.4C7.8 1.7 9.9 1.1 12 .7c2.1.4 4.2 1 5.9 1.7 3 1 4.6 1.7 4.6 2.3z",
		"0.9",
	],
] as const

const cacheSystemIcon = <M>(h: HtmlBuilder<M>, system: CacheInfo["system"], size: number): Html =>
	system?.toLowerCase() === "redis"
		? h.svg(
				[
					h.Attribute("width", String(size)),
					h.Attribute("height", String(size)),
					h.Attribute("viewBox", "0 0 24 24"),
					h.Attribute("fill", "none"),
					h.Class("shrink-0"),
				],
				REDIS_LAYERS.map(([d, opacity]) =>
					h.path([
						h.Attribute("d", d),
						h.Attribute("fill", "currentColor"),
						h.Attribute("opacity", opacity),
					]),
				),
			)
		: icon(h, "DatabaseIcon", { size, className: "shrink-0 text-current" })

const primaryText = (span: FlowNodeData["span"], desc: SpanDescription): string => {
	const { httpInfo, cacheInfo, category } = desc
	if (category.id === "cache" && cacheInfo) {
		const op = cacheInfo.operation?.toUpperCase()
		const name = cacheInfo.name ?? span.spanName
		return op ? `${op} ${name}` : name
	}
	if ((category.id === "http" || category.id === "server") && httpInfo)
		return `${httpInfo.method} ${httpInfo.route ?? span.spanName}`
	if (category.id === "db") {
		const operation = pickAttr(span.spanAttributes, "db.operation.name", "db.operation")
		const table = pickAttr(span.spanAttributes, "db.collection.name")
		if (operation) return table ? `${operation} ${table}` : operation
	}
	return span.spanName
}

/** `outcomeBadgeStyle` (packages/ui `lib/cloud-platforms/types.ts`). */
const outcomeBadgeStyle = (bad: boolean): string =>
	bad
		? "bg-severity-error/15 text-severity-error border-severity-error/30"
		: "bg-severity-info/15 text-severity-info border-severity-info/30"

const statusBadge = <M>(
	h: HtmlBuilder<M>,
	desc: SpanDescription,
	isError: boolean,
	statusCode: string,
): Html | null => {
	const { platform, cacheInfo, httpInfo } = desc
	const base = "shrink-0 rounded px-1.5 py-0.5 text-3xs font-semibold"
	if (platform?.outcome?.bad) {
		return h.span(
			[h.Class(cn(base, outcomeBadgeStyle(true))), h.Title(`${platform.label} outcome`)],
			[platform.outcome.value],
		)
	}
	if (cacheInfo?.result) {
		return h.span(
			[h.Class(cn(base, "font-mono", cacheResultStyles[cacheInfo.result]))],
			[cacheInfo.result === "hit" ? "HIT" : "MISS"],
		)
	}
	if (httpInfo?.statusCode != null) {
		const code = httpInfo.statusCode
		const tone = httpStatusTone(code)
		return h.span(
			[
				h.Class(
					cn(
						base,
						"font-mono",
						code >= 200 && code < 300 && "bg-severity-info/15 text-severity-info",
						code >= 300 && code < 400 && "bg-chart-p50/15 text-chart-p50",
						tone !== "neutral" && TONE_SOFT[tone],
						code < 200 && "text-muted-foreground",
					),
				),
			],
			[String(code)],
		)
	}
	if (isError) return h.span([h.Class(cn(base, "bg-severity-error/15 text-severity-error"))], ["Error"])
	if (statusCode === "Ok")
		return h.span([h.Class(cn(base, "bg-severity-info/15 text-severity-info"))], ["OK"])
	return null
}

const missingCard = <M>(
	h: HtmlBuilder<M>,
	nodeId: string,
	data: FlowNodeData,
	isSelected: boolean,
): ReadonlyArray<Html> => [
	flowHandle(h, nodeId, "target", "top", HANDLE_CLASSES),
	h.div(
		[
			h.Class(
				cn(
					"relative w-[280px] rounded-lg border-2 border-dashed border-muted-foreground/30 bg-card/50",
					"flex flex-col gap-1 px-3 py-2 transition-all duration-200",
					isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-1.5 min-w-0 text-2xs")],
				[
					h.span([h.Class("font-semibold text-muted-foreground")], ["Missing span"]),
					h.span([h.Class("flex-1")]),
					h.span(
						[
							h.Class(cn("font-mono tabular-nums", "text-muted-foreground/60 truncate")),
							h.Title(data.span.spanId),
						],
						[shortId(data.span.spanId, "span")],
					),
				],
			),
			h.div([h.Class("text-3xs italic text-muted-foreground/50")], ["Not ingested or dropped"]),
		],
	),
	flowHandle(h, nodeId, "source", "bottom", HANDLE_CLASSES),
]

const spanIsError = (statusCode: string, httpError: boolean) =>
	statusCode === "Error" || (statusCode !== "Ok" && httpError)

/** The node's children: handles around the span card. */
export const flowSpanNode = <M>(
	h: HtmlBuilder<M>,
	nodeId: string,
	data: FlowNodeData,
	isSelected: boolean,
): ReadonlyArray<Html> => {
	const { span, count, combinedSpans, aggregatedDuration, totalDurationMs } = data
	if (span.isMissing) return missingCard(h, nodeId, data, isSelected)
	const isCombined = count > 1
	const desc = describeSpan(span)
	const { category, httpInfo, cacheInfo } = desc
	const isError =
		spanIsError(span.statusCode, httpInfo?.isError ?? false) ||
		(isCombined && combinedSpans.some((s) => s.statusCode === "Error"))
	const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)
	const railDurationMs = isCombined ? aggregatedDuration.avg : span.durationMs
	const costFraction =
		totalDurationMs > 0 ? Math.min(1, Math.max(0.02, Math.sqrt(railDurationMs / totalDurationMs))) : 0
	const badge = statusBadge(h, desc, isError, span.statusCode)
	const text = primaryText(span, desc)
	return [
		flowHandle(h, nodeId, "target", "top", HANDLE_CLASSES),
		h.div(
			[
				h.Class(
					cn(
						"relative w-[280px] rounded-lg border bg-card shadow-sm transition-all duration-200 hover:shadow-md",
						isError && "border-severity-error/30 bg-severity-error/5 shadow-severity-error/10",
						isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-md",
						isCombined &&
							"before:absolute before:inset-0 before:-z-10 before:translate-x-1.5 before:translate-y-1.5 before:rounded-lg before:border before:bg-card",
					),
				),
			],
			[
				...(isCombined
					? [
							h.span(
								[
									h.Class(
										"absolute -top-2 -right-2 rounded-full border bg-muted px-1.5 py-0.5 text-3xs font-semibold tabular-nums text-muted-foreground shadow-sm",
									),
								],
								["×", String(count)],
							),
						]
					: []),
				h.div(
					[h.Class("flex items-center gap-2 p-2 pb-2.5 pr-2.5")],
					[
						h.span(
							[
								h.Class(
									cn(
										"flex size-6 shrink-0 items-center justify-center rounded-md",
										isError
											? "bg-severity-error/15 text-severity-error"
											: cn(category.accent.soft, category.accent.text),
									),
								),
							],
							[
								category.id === "cache" && cacheInfo?.system
									? cacheSystemIcon(h, cacheInfo.system, 13)
									: icon(h, category.icon, { size: 13 }),
							],
						),
						h.div(
							[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
							[
								h.div(
									[h.Class("flex min-w-0 items-center gap-1.5")],
									[
										h.span(
											[
												h.Class(
													cn(
														"block min-w-0 truncate",
														"font-mono",
														"flex-1 text-2xs font-medium text-foreground",
													),
												),
												h.Title(text),
											],
											[text],
										),
										...(badge === null ? [] : [badge]),
									],
								),
								h.div(
									[
										h.Class(
											"flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground",
										),
									],
									[
										serviceDot(h, span.serviceName, "size-1.5"),
										h.span([h.Class("truncate")], [span.serviceName]),
										h.span([h.Class("shrink-0 text-muted-foreground/50")], ["·"]),
										h.span([h.Class("shrink-0")], [category.label]),
										h.span([h.Class("flex-1")]),
										h.span([h.Class("shrink-0 tabular-nums"), h.Title(tooltip)], [main]),
									],
								),
							],
						),
					],
				),
				h.div(
					[
						h.Class(
							"absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-[7px] bg-muted/40",
						),
					],
					[
						h.div([
							h.Class(cn("h-full", isError ? "bg-severity-error" : category.accent.rail)),
							h.Style({ width: `${costFraction * 100}%` }),
						]),
					],
				),
			],
		),
		flowHandle(h, nodeId, "source", "bottom", HANDLE_CLASSES),
	]
}
