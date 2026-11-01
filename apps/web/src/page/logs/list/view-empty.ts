import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { excludedEmptyHint } from "../../../ui/filters/excluded-empty-hint"
import { docsLink, signalEmptyState } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import { canWidenRange, logFilterChips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { toolbar } from "./view-toolbar"

// The logs table's empty state.

const exclusionsHint = (h: HtmlBuilder<Message>, model: Model): Html | null =>
	excludedEmptyHint(h, {
		excluded: logFilterChips(model.search)
			.filter((chip) => chip.negated)
			.flatMap((chip) => chip.values),
		onClear: Message.ClickedClearExclusions(),
		className: "max-w-lg",
	})

/** A search term or trace scope explains the emptiness better than presence can. */
const searchEmpty = (h: HtmlBuilder<Message>, model: Model): Html => {
	const { traceId, search } = model.search
	const hint = exclusionsHint(h, model)
	return h.div(
		[h.Class("flex h-48 flex-col items-center justify-center gap-2 rounded-md border px-6 text-center")],
		[
			h.span(
				[h.Class("text-sm text-muted-foreground")],
				traceId
					? [
							"No logs on trace",
							" ",
							h.span([h.Class("font-mono text-foreground break-all")], [traceId]),
							" in this window",
						]
					: [
							"No log message contains",
							" ",
							h.span(
								[h.Class("font-mono text-foreground break-all")],
								["“", search ?? "", "”"],
							),
						],
			),
			...(traceId
				? [
						h.span(
							[
								h.Class(
									"flex max-w-md flex-col items-center gap-2 text-xs text-muted-foreground",
								),
							],
							[
								"Logs link to a trace when your logger bridge runs inside the active span.",
								docsLink(h, "logs"),
							],
						),
					]
				: []),
			button(
				h,
				{
					variant: "link",
					size: "xs",
					className: "text-primary",
					attributes: [h.OnClick(Message.ClickedClearSearch())],
				},
				["Clear search"],
			),
			...(hint === null ? [] : [hint]),
		],
	)
}

/** Unfiltered and the org never sent logs: the setup state is the answer, whatever the list says. */
export const isNeverReceived = (model: Model): boolean =>
	presenceOf(model.presence, "logs").status === "absent" &&
	!model.search.search &&
	!model.search.traceId &&
	logFilterChips(model.search).length === 0

export const emptyState = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.Class("flex-1 min-h-0 flex flex-col gap-4")],
		[
			toolbar(h, model),
			model.search.search || model.search.traceId
				? searchEmpty(h, model)
				: h.div(
						[h.Class("rounded-md border")],
						[
							signalEmptyState(h, {
								signal: "logs",
								presence: presenceOf(model.presence, "logs"),
								nowMs: model.nowMs,
								isFiltered: logFilterChips(model.search).length > 0,
								onClearFilters: Message.ClickedClearFilterChips(),
								onWidenRange: canWidenRange(model.search)
									? Message.ClickedWidenRange()
									: undefined,
								detail: exclusionsHint(h, model),
							}),
						],
					),
		],
	)
