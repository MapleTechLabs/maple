import { calculateSelfTime, getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration, formatPercent } from "@maple/ui/lib/format"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import { getSpanKindLabel } from "@maple/ui/lib/span-kind"
import { spanStartMs } from "@maple/ui/lib/span-tree"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import type { SpanNode } from "@maple/ui/lib/types"
import type { Html, HtmlBuilder } from "foldkit/html"
import { middleTruncate } from "../ui/middle-truncate"
import { hstack } from "../ui/stack"
import { typography } from "../ui/typography"

// `SpanTooltipContent` (packages/ui `traces/span-tooltip.tsx`).

export interface SpanTooltipOptions {
	readonly totalDurationMs?: number
	readonly traceStartTime?: string
}

const GRID = "grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-3xs"

const term = <M>(h: HtmlBuilder<M>, label: string): Html => typography(h, { tone: "muted" }, [label])

const statusClass = (statusCode: string): string =>
	statusCode === "Error" ? "text-severity-error" : statusCode === "Ok" ? "text-severity-info" : ""

const startOffsetCell = <M>(h: HtmlBuilder<M>, offsetMs: number): Html =>
	offsetMs < 0
		? typography(h, { tone: "warning" }, [`−${formatDuration(Math.abs(offsetMs))} (clock skew)`])
		: h.span([], [`+${formatDuration(offsetMs)}`])

const durationBlock = <M>(h: HtmlBuilder<M>, span: SpanNode, percent: number): Html =>
	h.div(
		[h.Class("space-y-1")],
		[
			hstack(h, { align: "center", justify: "between", className: "text-3xs" }, [
				term(h, "Duration"),
				h.span([], [`${formatDuration(span.durationMs)} (${formatPercent(percent / 100)})`]),
			]),
			h.div(
				[h.Class("h-1.5 w-full bg-muted overflow-hidden")],
				[h.div([h.Class("h-full bg-primary/70"), h.Style({ width: `${Math.max(percent, 1)}%` })])],
			),
		],
	)

const httpBlock = <M>(h: HtmlBuilder<M>, span: SpanNode): ReadonlyArray<Html> => {
	const info = getHttpInfo(span)
	if (info === null) return []
	const status = info.statusCode
	const statusCells =
		status == null
			? []
			: [
					term(h, "HTTP"),
					h.span(
						[
							h.Class(
								httpStatusTone(status) === "neutral"
									? "text-severity-info"
									: TONE_TEXT[httpStatusTone(status)],
							),
						],
						[String(status)],
					),
				]
	const routeCells =
		info.route === null || info.route === ""
			? []
			: [
					term(h, "Route"),
					middleTruncate(h, { text: info.route, tail: 14, className: "max-w-[180px]" }),
				]
	return [
		h.div(
			[h.Class(`border-t border-border pt-1.5 ${GRID}`)],
			[
				term(h, "Method"),
				typography(h, { weight: "medium" }, [info.method]),
				...statusCells,
				...routeCells,
			],
		),
	]
}

/** A span's name, duration share, self time, kind, offset, status and HTTP facts. */
export const spanTooltipContent = <M>(
	h: HtmlBuilder<M>,
	span: SpanNode,
	options: SpanTooltipOptions = {},
): Html => {
	const serviceColor = getServiceColor(span.serviceName)
	const selfTime = calculateSelfTime(span, span.children)
	const selfPercent = span.durationMs > 0 ? (selfTime / span.durationMs) * 100 : 0
	const { totalDurationMs, traceStartTime } = options
	const durationPercent =
		totalDurationMs === undefined || totalDurationMs === 0
			? null
			: (span.durationMs / totalDurationMs) * 100
	const startOffset =
		traceStartTime === undefined ? null : spanStartMs(span) - new Date(traceStartTime).getTime()
	return h.div(
		[h.Class("space-y-2 font-mono text-xs")],
		[
			hstack(h, { gap: "2", align: "center" }, [
				...(serviceColor === ""
					? []
					: [
							h.div([
								h.Class("h-2.5 w-2.5 shrink-0"),
								h.Style({ "background-color": serviceColor }),
							]),
						]),
				typography(h, { weight: "medium", truncate: true }, [span.spanName]),
			]),
			...(durationPercent === null ? [] : [durationBlock(h, span, durationPercent)]),
			...(span.children.length > 0
				? [
						hstack(h, { align: "center", justify: "between", className: "text-3xs" }, [
							term(h, "Self time"),
							h.span([], [`${formatDuration(selfTime)} (${formatPercent(selfPercent / 100)})`]),
						]),
					]
				: []),
			h.div(
				[h.Class(GRID)],
				[
					term(h, "Service"),
					h.span([], [span.serviceName]),
					term(h, "Kind"),
					h.span([], [getSpanKindLabel(span.spanKind)]),
					...(startOffset === null
						? []
						: [term(h, "Start offset"), startOffsetCell(h, startOffset)]),
					...(durationPercent === null
						? [term(h, "Duration"), h.span([], [formatDuration(span.durationMs)])]
						: []),
					term(h, "Status"),
					h.span(
						[h.Class(statusClass(span.statusCode))],
						[span.statusCode === "" ? "Unset" : span.statusCode],
					),
				],
			),
			...httpBlock(h, span),
			...(span.statusMessage === ""
				? []
				: [
						h.div(
							[h.Class("border-t border-border pt-1.5 text-3xs")],
							[term(h, "Message: "), span.statusMessage],
						),
					]),
		],
	)
}
