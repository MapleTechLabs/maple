import type { SpanNodeData } from "@maple/web/page/traces/detail/trace-data"
import { middleTruncate } from "@maple/web/ui/middle-truncate"
import { calculateSelfTime, getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import { getSpanKindLabel } from "@maple/ui/lib/span-kind"
import { spanStartMs } from "@maple/ui/lib/span-tree"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message"

// `SpanTooltipContent` (packages/ui/src/components/traces/span-tooltip.tsx) and the timeline's
// hover tooltip around it: fixed above the pointer, never in the way of it.

type H = HtmlBuilder<Message>

const muted = (h: H, text: string): Html => h.span([h.Class("text-muted-foreground")], [text])

const statusClass = (statusCode: string): string => {
	if (statusCode === "Error") return "text-severity-error"
	if (statusCode === "Ok") return "text-severity-info"
	return ""
}

const startOffsetCell = (h: H, startOffset: number): Html =>
	startOffset < 0
		? h.span(
				[h.Class("text-severity-warn")],
				["−", formatDuration(Math.abs(startOffset)), " (clock skew)"],
			)
		: h.span([], ["+", formatDuration(startOffset)])

const httpBlock = (h: H, span: SpanNodeData): ReadonlyArray<Html> => {
	const info = getHttpInfo({
		spanName: span.spanName,
		spanAttributes: { ...span.spanAttributes },
		spanKind: span.spanKind,
	})
	if (info === null || info === undefined) return []
	const code = info.statusCode
	const codeClass = (value: number) =>
		httpStatusTone(value) === "neutral" ? "text-severity-info" : TONE_TEXT[httpStatusTone(value)]
	return [
		h.div(
			[h.Class("border-t border-border pt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-3xs")],
			[
				muted(h, "Method"),
				h.span([h.Class("font-medium")], [info.method]),
				...(code === null || code === undefined
					? []
					: [muted(h, "HTTP"), h.span([h.Class(codeClass(code))], [String(code)])]),
				...(info.route
					? [
							muted(h, "Route"),
							middleTruncate(h, { text: info.route, tail: 14, className: "max-w-[180px]" }),
						]
					: []),
			],
		),
	]
}

const spanTooltipContent = (
	h: H,
	span: SpanNodeData,
	totalDurationMs: number,
	traceStartTime: string,
): Html => {
	const serviceColor = getServiceColor(span.serviceName)
	const selfTime = calculateSelfTime(span, [...span.children])
	const selfTimePercent = span.durationMs > 0 ? (selfTime / span.durationMs) * 100 : 0
	const durationPercent = totalDurationMs ? (span.durationMs / totalDurationMs) * 100 : null
	const startOffset = traceStartTime ? spanStartMs(span) - new Date(traceStartTime).getTime() : null
	return h.div(
		[h.Class("space-y-2 font-mono text-xs")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					h.div(
						[h.Class("h-2.5 w-2.5 shrink-0"), h.Style({ "background-color": serviceColor })],
						[],
					),
					h.span([h.Class("font-medium truncate")], [span.spanName]),
				],
			),
			...(durationPercent === null
				? []
				: [
						h.div(
							[h.Class("space-y-1")],
							[
								h.div(
									[h.Class("flex items-center justify-between text-3xs")],
									[
										muted(h, "Duration"),
										h.span(
											[],
											[
												formatDuration(span.durationMs),
												" (",
												formatPercent(durationPercent / 100),
												")",
											],
										),
									],
								),
								h.div(
									[h.Class("h-1.5 w-full bg-muted overflow-hidden")],
									[
										h.div(
											[
												h.Class("h-full bg-primary/70"),
												h.Style({ width: `${Math.max(durationPercent, 1)}%` }),
											],
											[],
										),
									],
								),
							],
						),
					]),
			...(span.children.length > 0
				? [
						h.div(
							[h.Class("flex items-center justify-between text-3xs")],
							[
								muted(h, "Self time"),
								h.span(
									[],
									[
										formatDuration(selfTime),
										" (",
										formatPercent(selfTimePercent / 100),
										")",
									],
								),
							],
						),
					]
				: []),
			h.div(
				[h.Class("grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-3xs")],
				[
					muted(h, "Service"),
					h.span([], [span.serviceName]),
					muted(h, "Kind"),
					h.span([], [getSpanKindLabel(span.spanKind)]),
					...(startOffset === null
						? []
						: [muted(h, "Start offset"), startOffsetCell(h, startOffset)]),
					...(durationPercent === null
						? [muted(h, "Duration"), h.span([], [formatDuration(span.durationMs)])]
						: []),
					muted(h, "Status"),
					h.span([h.Class(statusClass(span.statusCode))], [span.statusCode || "Unset"]),
				],
			),
			...httpBlock(h, span),
			...(span.statusMessage
				? [
						h.div(
							[h.Class("border-t border-border pt-1.5 text-3xs")],
							[muted(h, "Message: "), span.statusMessage],
						),
					]
				: []),
		],
	)
}

/** The hover tooltip: fixed at the pointer, lifted 8px and centred above it. */
export const spanTooltip = (
	h: H,
	input: Readonly<{
		span: SpanNodeData
		pointer: Readonly<{ x: number; y: number }>
		totalDurationMs: number
		traceStartTime: string
	}>,
): Html =>
	h.div(
		[
			h.Class("fixed left-0 top-0 z-[9999] pointer-events-none"),
			h.Style({
				transform: `translate3d(${input.pointer.x}px, ${input.pointer.y - 8}px, 0) translate(-50%, -100%)`,
			}),
		],
		[
			h.div(
				[h.Class("bg-popover text-popover-foreground border border-border shadow-lg p-2.5 max-w-sm")],
				[spanTooltipContent(h, input.span, input.totalDurationMs, input.traceStartTime)],
			),
		],
	)
