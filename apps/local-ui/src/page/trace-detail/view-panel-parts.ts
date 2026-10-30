import { formatUtcTitle } from "../../lib/time"
import { formatDateTime, type TimeFormat } from "../kit/local-time"
import { cacheResultStyles, getCacheInfo } from "@maple/ui/lib/cache"
import { formatDuration } from "@maple/ui/lib/format"
import { getSpanStatusBadgeClass } from "@maple/ui/lib/span-kind"
import { copyableValue } from "@maple/web/page/traces/detail/span-panel/copy"
import { errorSection } from "@maple/web/page/traces/detail/span-panel/error-section"
import type { Message } from "@maple/web/page/traces/detail/span-panel/message"
import type { Model } from "@maple/web/page/traces/detail/span-panel/model"
import { panelHeader } from "@maple/web/page/traces/detail/span-panel/view-header"
import { badge } from "@maple/web/ui/display"
import { icon } from "@maple/web/ui/icon"
import { keyValue, keyValueList } from "@maple/web/ui/key-value"
import type { Html, HtmlBuilder } from "foldkit/html"

// The span panel's parts that speak the web span panel's Messages (copies, error disclosure,
// close): its header and error card as ported, the local summary row and Details body. Each
// takes any builder whose Message union contains the web panel's.

type H<P> = HtmlBuilder<Message | P>

/** The panel header: service rail, span name, service and kind, close. */
export const headerView = <P>(h: H<P>, model: Model): Html => panelHeader(h, model)

const summary = <P>(h: H<P>, model: Model): Html => {
	const { span } = model
	const duration = formatDuration(span.durationMs)
	const cacheInfo = getCacheInfo({ ...span.spanAttributes })
	return h.div(
		[h.Class("flex shrink-0 items-center gap-4 border-b px-3 py-1.5 text-xs")],
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					icon(h, "ClockIcon", { size: 12, className: "text-muted-foreground" }),
					h.span(
						[h.Class("font-mono")],
						[copyableValue(h, model, { id: "duration", value: duration }, [duration])],
					),
				],
			),
			badge(
				h,
				{ variant: "outline", size: "xs", className: getSpanStatusBadgeClass(span.statusCode) },
				[span.statusCode || "Unset"],
			),
			...(cacheInfo?.result
				? [
						badge(
							h,
							{
								variant: "outline",
								size: "xs",
								className: cacheResultStyles[cacheInfo.result],
							},
							[cacheInfo.result === "hit" ? "HIT" : "MISS"],
						),
					]
				: []),
		],
	)
}

export type SummaryInputs = Readonly<{ attributes: Readonly<Record<string, string>> }>

/** The summary stats, then the error card for an errored span with a message. */
export const summaryView = <P>(h: H<P>, model: Model, inputs: SummaryInputs): Html =>
	h.div(
		[],
		[
			summary(h, model),
			...(model.span.statusCode === "Error" && model.span.statusMessage
				? [
						errorSection(h, model, {
							message: model.span.statusMessage,
							prompt: {
								serviceName: model.span.serviceName,
								operation: model.span.spanName,
								attributes: inputs.attributes,
							},
						}),
					]
				: []),
		],
	)

/** `SpanPositionBar`: the span's window inside the trace's wall-clock track, clamped. */
const positionBar = <P>(h: H<P>, model: Model, color: string): Html | null => {
	const offsetMs = new Date(model.span.startTime).getTime() - new Date(model.traceStartTime).getTime()
	const total = model.totalDurationMs
	if (!Number.isFinite(offsetMs) || total <= 0) return null
	const offsetPct = Math.min(Math.max((offsetMs / total) * 100, 0), 100)
	const widthPct = Math.min(Math.max((model.span.durationMs / total) * 100, 0.75), 100 - offsetPct)
	return h.div(
		[h.Class("py-1")],
		[
			h.div(
				[h.Class("relative h-1.5 w-full overflow-hidden rounded-full bg-muted")],
				[
					h.div(
						[
							h.Class("absolute inset-y-0 rounded-full"),
							h.Style({
								left: `${offsetPct}%`,
								width: `${widthPct}%`,
								"background-color": color,
							}),
						],
						[],
					),
				],
			),
			h.div(
				[h.Class("mt-1 flex justify-between text-3xs text-muted-foreground tabular-nums")],
				[
					offsetMs < 0
						? h.span(
								[
									h.Class("text-severity-warn"),
									h.Title("Starts before the trace root: the clocks disagree"),
								],
								["−", formatDuration(Math.abs(offsetMs)), " (clock skew)"],
							)
						: h.span([], ["+", formatDuration(offsetMs)]),
					h.span([], [formatDuration(total), " total"]),
				],
			),
		],
	)
}

const heading = <P>(h: H<P>, text: string): Html =>
	h.h4([h.Class("text-xs font-medium text-muted-foreground")], [text])

const idRow = <P>(h: H<P>, model: Model, label: string, id: string, value: string): Html =>
	keyValue(h, { label, mono: true }, [copyableValue(h, model, { id, value }, [value])])

export type DetailsInputs = Readonly<{
	color: string
	attributes: () => ReadonlyArray<Html>
	timeFormat: TimeFormat
}>

/** The Details tab: timing, identifiers, then the attribute sections the page builds. */
export const detailsView = <P>(h: H<P>, model: Model, inputs: DetailsInputs): Html => {
	const { span } = model
	return h.div(
		[h.Class("space-y-3 p-3")],
		[
			h.div(
				[h.Class("space-y-1")],
				[
					heading(h, "Timing"),
					...[positionBar(h, model, inputs.color)].filter((bar) => bar !== null),
					keyValueList(h, { className: "gap-1 rounded-md border p-2" }, [
						keyValue(h, { label: "Start time", mono: true }, [
							h.span(
								[h.Title(formatUtcTitle(span.startTime))],
								[
									copyableValue(h, model, { id: "start-time", value: span.startTime }, [
										formatDateTime(inputs.timeFormat, span.startTime),
									]),
								],
							),
						]),
					]),
				],
			),
			h.div(
				[h.Class("space-y-1")],
				[
					heading(h, "Identifiers"),
					keyValueList(h, { className: "gap-1 rounded-md border p-2" }, [
						idRow(h, model, "Span ID", "span-id", span.spanId),
						idRow(h, model, "Trace ID", "trace-id", span.traceId),
						...(span.parentSpanId
							? [idRow(h, model, "Parent span ID", "parent-span-id", span.parentSpanId)]
							: []),
					]),
				],
			),
			...inputs.attributes(),
		],
	)
}
