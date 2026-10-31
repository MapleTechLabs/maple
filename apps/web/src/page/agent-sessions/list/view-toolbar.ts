import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { refreshButton } from "../../../ui/refresh-button"
import { switchControl } from "../../../ui/switch"
import { toolbarStat } from "../../kit/list-toolbar"
import { Message } from "./message"
import type { Model } from "./model"
import { searchInput } from "../../../ui/search-input"

// The agent sessions toolbar, its search over `SearchInput`.
// TODO(tooltip): the count's and the switch's tooltips are drawn as triggers only.

type H = HtmlBuilder<Message>

const ERRORS_LABEL_ID = "agent-sessions-errors-label"

/** `ToolbarSearch` (debounced 300 ms), toolbar size. */
const toolbarSearch = (h: H, model: Model): Html =>
	searchInput(h, {
		id: "agent-sessions-search",
		size: "sm",
		className: cn("max-w-sm", "w-full sm:max-w-sm"),
		placeholder: "Session or trace ID…",
		value: model.searchInput,
		onInput: (value) => Message.ChangedSearchInput({ value }),
		onClear: Message.ChangedSearchInput({ value: "" }),
	})

/** `ToolbarStat`: "6 of 1,666" when the total is known and larger, else "6 shown". */
const stat = (h: H, value: number, total: number | undefined): Html =>
	toolbarStat(h, {
		value: value.toLocaleString(),
		label: total !== undefined && total > value ? `of ${total.toLocaleString()}` : "shown",
	})

const tooltipTrigger = <M>(h: HtmlBuilder<M>, id: string) => [
	h.DataAttribute("base-ui-tooltip-trigger", ""),
	h.DataAttribute("slot", "tooltip-trigger"),
	h.Id(id),
]

export const toolbar = (
	h: H,
	model: Model,
	options: Readonly<{
		sessionCount: number | undefined
		totalCount?: number
		isWaiting: boolean
		/** The failure card's Try again is the one retry while the list is failed. */
		isFailed?: boolean
	}>,
): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center justify-between gap-3")],
		[
			toolbarSearch(h, model),
			h.div(
				[
					...(options.isWaiting ? [h.AriaBusy(true)] : []),
					h.Class(cn("flex flex-wrap items-center gap-4", refreshingClass(options.isWaiting))),
				],
				[
					...(options.sessionCount === undefined
						? []
						: [
								h.span(
									[
										h.Class("hidden sm:block"),
										...tooltipTrigger(h, "agent-sessions-count"),
									],
									[stat(h, options.sessionCount, options.totalCount)],
								),
							]),
					h.label(
						[
							h.Class("inline-flex cursor-pointer items-center gap-2 text-xs font-medium"),
							...tooltipTrigger(h, ERRORS_LABEL_ID),
						],
						[
							...switchControl(h, {
								id: "agent-sessions-errors-switch",
								inputId: "agent-sessions-errors-input",
								isChecked: model.search.hasErrors === true,
								labelledBy: ERRORS_LABEL_ID,
								className:
									"[--thumb-size:--spacing(3.5)] data-checked:bg-severity-error sm:[--thumb-size:--spacing(3.5)]",
								onToggle: Message.ToggledErrorsOnly(),
							}),
							"With errors",
						],
					),
					...(options.isFailed === true
						? []
						: [
								refreshButton(h, {
									onRefresh: Message.ClickedReload(),
									isPending: model.isReloading,
									label: "Reload",
								}),
							]),
				],
			),
		],
	)
