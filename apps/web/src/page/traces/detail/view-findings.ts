import { countLabel } from "@maple/ui/lib/format"
import { collectTraceErrors, spanHttpStatus, type TraceErrors } from "../../../lib/traces/trace-errors"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { serviceDot } from "@maple/views/ui/values"
import { Message } from "./message"
import type { ProductEvent } from "./model"
import { type SpanNodeData, toSpanNode } from "@maple/views/traces/trace-data"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Record as Rec } from "effect"
import { hstack } from "@maple/views/ui/stack"
import { dividedList } from "@maple/views/ui/rule"

// The trace's error callout and product events.

export const traceErrors = (rootSpans: ReadonlyArray<SpanNodeData>): TraceErrors =>
	collectTraceErrors(Arr.map(rootSpans, toSpanNode))

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
				typography(h, { tone: "error" }, [countLabel(errors.spans.length, "failed span")]),
				errors.spans.length > 1
					? typography(h, { tone: "muted", weight: "normal" }, ["likely origin"])
					: null,
				hstack(
					h,
					{
						gap: "1.5",
						align: "center",
						shrink: true,
						as: "span",
						className: "font-mono font-normal",
					},
					[
						serviceDot(h, { serviceName: origin.serviceName, size: "sm" }),
						typography(h, { tone: "muted" }, [origin.serviceName]),
						typography(h, { truncate: true }, [origin.spanName]),
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
		typography(h, { weight: "medium" }, [event.eventName]),
		event.serviceName === "" ? null : typography(h, { tone: "muted" }, [event.serviceName]),
		person === "" ? null : typography(h, { tone: "muted" }, ["· ", person]),
		...Arr.map(Rec.toEntries(event.attributes), ([key, value]) =>
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
				hstack(h, { gap: "2", align: "center", as: "header", className: "border-b px-3 py-2" }, [
					icon(h, "ChartBarTrendUpIcon", { className: "size-3.5 text-muted-foreground" }),
					hstack(h, { gap: "2.5", align: "baseline" }, [
						heading(h, { level: 2, variant: "subsection" }, [
							"Product events",
							h.span(
								[h.Class("ml-2 font-mono text-xs text-muted-foreground")],
								[String(events.length)],
							),
						]),
					]),
				]),
				dividedList(
					h,
					{ as: "ul", bordered: false },
					Arr.map(events, (event) => productEventRow(h, event)),
				),
			])
