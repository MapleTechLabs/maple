import { describeSpanEvent, formatEventOffset } from "../../../../lib/traces/span-events"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../../ui/icon"
import { keyValue, keyValueList } from "../../../../ui/key-value"
import { copyButton, statusOf } from "./copy"
import { Message } from "./message"
import type { Model, SpanEventData } from "./model"

// The span's events section.

type H = HtmlBuilder<Message>

const eventAttributes = (
	h: H,
	model: Model,
	eventId: string,
	attributes: Readonly<Record<string, string>>,
) => {
	const entries = Object.entries(attributes)
	return entries.length === 0
		? []
		: [
				keyValueList(
					h,
					{ className: "gap-0.5 text-2xs" },
					entries.map(([key, value]) => {
						const id = `${eventId}:attr:${key}`
						return keyValue(
							h,
							{
								label: key,
								mono: true,
								wrap: true,
								copy: {
									status: statusOf(model, id),
									onCopy: Message.ClickedCopy({ id, text: value }),
								},
							},
							[value],
						)
					}),
				),
			]
}

const stackTrace = (h: H, model: Model, eventId: string, stacktrace: string): Html => {
	const id = `${eventId}:stack`
	const isOpen = model.openIds.includes(id)
	return h.div(
		[h.DataAttribute(isOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
		[
			h.div(
				[h.Class("flex items-center gap-1")],
				[
					h.button(
						[
							h.AriaDisabled(false),
							h.AriaExpanded(isOpen),
							h.Class(
								"group flex items-center gap-1 text-3xs text-muted-foreground transition-colors hover:text-foreground",
							),
							...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
							h.DataAttribute("slot", "collapsible-trigger"),
							h.Tabindex(0),
							h.Type("button"),
							h.OnClick(Message.ToggledCollapsible({ id })),
						],
						[
							icon(h, "ChevronRightIcon", {
								size: 10,
								className: "transition-transform group-data-[panel-open]:rotate-90",
							}),
							"Stack trace",
						],
					),
					copyButton(h, model, {
						id: `${id}:copy`,
						value: stacktrace,
						label: "stack trace",
						iconSize: 10,
					}),
				],
			),
			...(isOpen
				? [
						h.pre(
							[
								h.Class(
									"mt-1 max-h-80 overflow-auto rounded-sm bg-muted/40 p-2 font-mono text-3xs leading-relaxed",
								),
							],
							[stacktrace],
						),
					]
				: []),
		],
	)
}

const eventRow = (h: H, model: Model, event: SpanEventData, index: number): Html => {
	const eventId = `event:${index}`
	const described = describeSpanEvent(event)
	const offset = h.span(
		[
			h.Class("w-20 shrink-0 font-mono text-3xs tabular-nums text-muted-foreground"),
			h.Title(event.timestamp),
		],
		[formatEventOffset(event.offsetMs)],
	)
	if (described.kind === "event") {
		return h.li(
			[h.Class("space-y-1 p-2")],
			[
				h.div(
					[h.Class("flex min-w-0 items-baseline gap-2")],
					[
						offset,
						h.span([h.Class("min-w-0 truncate font-mono text-xs")], [event.name || "(unnamed)"]),
					],
				),
				...eventAttributes(h, model, eventId, described.attributes),
			],
		)
	}
	return h.li(
		[h.Class("space-y-1 p-2")],
		[
			h.div(
				[h.Class("flex min-w-0 items-baseline gap-2")],
				[
					offset,
					h.span(
						[h.Class("flex min-w-0 items-center gap-1 font-mono text-xs text-severity-error")],
						[
							icon(h, "CircleXmarkIcon", { size: 12, className: "shrink-0 self-center" }),
							h.span([h.Class("truncate")], [described.type ?? "exception"]),
						],
					),
				],
			),
			...(described.message === undefined
				? []
				: [
						h.p(
							[h.Class("font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]")],
							[described.message],
						),
					]),
			...(described.stacktrace === undefined
				? []
				: [stackTrace(h, model, eventId, described.stacktrace)]),
			...eventAttributes(h, model, eventId, described.attributes),
		],
	)
}

/** The span's OTel events in time order, `exception` events expanded; nothing when there are none. */
export const spanEventsSection = (h: H, model: Model, events: ReadonlyArray<SpanEventData>): Html | null =>
	events.length === 0
		? null
		: h.div(
				[h.Class("space-y-1")],
				[
					h.h4(
						[h.Class("text-xs font-medium text-muted-foreground")],
						["Events (", String(events.length), ")"],
					),
					h.ul(
						[h.Class("divide-y rounded-md border")],
						events.map((event, index) => eventRow(h, model, event, index)),
					),
				],
			)
