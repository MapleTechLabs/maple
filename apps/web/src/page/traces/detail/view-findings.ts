import { countLabel } from "@maple/ui/lib/format"
import { collectTraceErrors, spanHttpStatus, type TraceErrors } from "../../../lib/traces/trace-errors"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { heading } from "../../../ui/heading"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { pressable } from "../../../ui/pressable"
import { serviceDot } from "../../../ui/values"
import { Message } from "./message"
import type { ProductEvent } from "./model"
import { type SpanNodeData, toSpanNode } from "./trace-data"

// The trace's error callout and product events.

export const traceErrors = (rootSpans: ReadonlyArray<SpanNodeData>): TraceErrors =>
	collectTraceErrors(rootSpans.map(toSpanNode))

/** The failure up front: where the trace most likely broke and why, one click from its span. */
export const errorCallout = (
	h: HtmlBuilder<Message>,
	errors: TraceErrors,
	selectedSpanId: string | undefined,
): Html | null => {
	const origin = errors.origin
	if (origin === undefined) return null
	const httpStatus = spanHttpStatus(origin)
	const reason = origin.statusMessage || (httpStatus === undefined ? undefined : `HTTP ${httpStatus}`)
	return alert(h, { variant: "crit", size: "sm", className: "shrink-0" }, [
		icon(h, "CircleXmarkIcon"),
		alertTitle(
			h,
			[
				h.span([h.Class("text-severity-error")], [countLabel(errors.spans.length, "failed span")]),
				errors.spans.length > 1
					? h.span([h.Class("text-muted-foreground font-normal")], ["likely origin"])
					: null,
				h.span(
					[h.Class("flex min-w-0 items-center gap-1.5 font-mono font-normal")],
					[
						serviceDot(h, { serviceName: origin.serviceName, size: "sm" }),
						h.span([h.Class("text-muted-foreground")], [origin.serviceName]),
						h.span([h.Class("truncate")], [origin.spanName]),
					],
				),
			],
			"flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5",
		),
		reason === undefined || reason === ""
			? null
			: alertDescription(
					h,
					[
						h.p(
							[
								h.Class("line-clamp-2 font-mono text-xs [overflow-wrap:anywhere]"),
								h.Title(reason),
							],
							[reason],
						),
					],
					"min-w-0",
				),
		alertAction(h, [
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					isDisabled: selectedSpanId === origin.spanId,
					attributes: [h.OnClick(Message.ClickedViewOriginSpan({ spanId: origin.spanId }))],
				},
				["View span"],
			),
		]),
	])
}

const productEventRow = (h: HtmlBuilder<Message>, event: ProductEvent): Html => {
	const person = event.userId || event.groupId || event.visitorId
	const content = [
		h.span([h.Class("font-medium")], [event.eventName]),
		event.serviceName === "" ? null : h.span([h.Class("text-muted-foreground")], [event.serviceName]),
		person === "" ? null : h.span([h.Class("text-muted-foreground")], ["· ", person]),
		...Object.entries(event.attributes).map(([key, value]) =>
			badge(h, { variant: "secondary", className: "font-normal" }, [key, ": ", value]),
		),
	]
	const rowClassName = "flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-xs"
	return event.spanId === ""
		? h.li([h.Class(rowClassName)], content)
		: h.li(
				[],
				[
					pressable(
						h,
						{
							onClick: Message.ClickedProductEvent({ spanId: event.spanId }),
							className: `${rowClassName} hover:bg-muted active:bg-muted focus-visible:bg-muted focus-visible:outline-none`,
						},
						content,
					),
				],
			)
}

/** The product events this trace produced; nothing while loading, on failure or when there are none. */
export const productEvents = (h: HtmlBuilder<Message>, events: ReadonlyArray<ProductEvent>): Html | null =>
	events.length === 0
		? null
		: panel(h, { tone: "background" }, [
				h.header(
					[h.Class("flex items-center gap-2 border-b px-3 py-2")],
					[
						icon(h, "ChartBarTrendUpIcon", { className: "size-3.5 text-muted-foreground" }),
						h.div(
							[h.Class("flex items-baseline gap-2.5")],
							[
								heading(
									h,
									{ level: 2, variant: "subsection" },
									[
										"Product events",
										h.span(
											[h.Class("ml-2 font-mono text-xs text-muted-foreground")],
											[String(events.length)],
										),
									],
								),
							],
						),
					],
				),
				h.ul(
					[h.Class("divide-y")],
					events.map((event) => productEventRow(h, event)),
				),
			])
