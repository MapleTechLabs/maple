import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { excludedEmptyHint } from "@maple/views/ui/filters/excluded-empty-hint"
import { docsLink, signalEmptyState } from "../../kit/signal-empty-state"
import { presenceOf } from "@maple/views/data/signal-presence"
import { canWidenRange, type LogFilterChip, logFilterChips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { toolbar } from "./view-toolbar"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { vstack } from "@maple/views/ui/stack"

// The logs table's empty state.

const exclusionsHint = (h: HtmlBuilder<Message>, model: Model): Html | null =>
	excludedEmptyHint(h, {
		excluded: Arr.flatMap(
			Arr.filter(logFilterChips(model.search), (chip) => chip.negated),
			(chip: LogFilterChip) => chip.values,
		),
		onClear: Message.ClickedClearExclusions(),
		className: "max-w-lg",
	})

/** A search term or trace scope explains the emptiness better than presence can. */
const searchEmpty = (h: HtmlBuilder<Message>, model: Model): Html => {
	const { traceId, search } = model.search
	const hint = exclusionsHint(h, model)
	return vstack(
		h,
		{
			gap: "2",
			align: "center",
			justify: "center",
			className: "h-48 rounded-md border px-6 text-center",
		},
		[
			typography(
				h,
				{ size: "sm", tone: "muted" },
				traceId
					? [
							"No logs on trace",
							" ",
							typography(h, { tone: "foreground", mono: true, className: "break-all" }, [
								traceId,
							]),
							" in this window",
						]
					: [
							"No log message contains",
							" ",
							typography(h, { tone: "foreground", mono: true, className: "break-all" }, [
								"“",
								search ?? "",
								"”",
							]),
						],
			),
			...(traceId
				? [
						vstack(
							h,
							{
								gap: "2",
								align: "center",
								as: "span",
								className: "max-w-md text-xs text-muted-foreground",
							},
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

export const emptyState = (h: HtmlBuilder<Message>, model: Model, timeZone: string): Html =>
	vstack(h, { gap: "4", grow: true, className: "min-h-0" }, [
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
							timeZone,
							isFiltered: logFilterChips(model.search).length > 0,
							onClearFilters: Message.ClickedClearFilterChips(),
							onWidenRange: canWidenRange(model.search)
								? Message.ClickedWidenRange()
								: undefined,
							detail: exclusionsHint(h, model),
						}),
					],
				),
	])
