import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { HUB_SORTS, SEVERITY_FILTERS, type SeverityFilter } from "../../../lib/errors/hub-params"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as SelectView from "../../../ui/select-view"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import * as TabsView from "../../../ui/tabs-view"
import { SEVERITY_FILL, SEVERITY_LABEL, SEVERITY_ORDER, severityDot } from "../kit/severity"
import { Message } from "./message"
import type { Model } from "./model"
import { searchInput } from "../../../ui/search-input"

// The errors stat strip, list toolbar, search and the sort and severity selects.

type H = HtmlBuilder<Message>

const stat = (h: H, value: number | string, label: string): Html =>
	h.span(
		[h.Class("flex items-center gap-1.5 whitespace-nowrap text-sm")],
		[
			h.span(
				[h.Class(cn("font-medium tabular-nums"))],
				[typeof value === "number" ? formatNumber(value) : value],
			),
			h.span([h.Class("text-muted-foreground")], [label]),
		],
	)

/** Window totals; a failed summary draws nothing rather than take the list down. */
export const statStrip = (h: H, model: Model): Html | null =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () =>
			h.div(
				[h.Class("flex items-center gap-4 px-3 py-2")],
				[skeleton(h, "h-4 w-28"), skeleton(h, "h-4 w-28")],
			),
		onFailure: () => null,
		onData: (summary) =>
			summary === null
				? null
				: h.div(
						[
							h.Class(
								cn(
									"flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2",
									refreshingClass(AsyncData.isRefreshing(model.summary.data)),
								),
							),
							...(AsyncData.isRefreshing(model.summary.data) ? [h.AriaBusy(true)] : []),
						],
						[
							h.div(
								[h.Class("flex items-center gap-4 flex-wrap gap-y-1")],
								[
									stat(h, summary.totalErrors, "error events"),
									stat(h, formatErrorRate(summary.errorRate), "of all spans"),
								],
							),
							h.span([h.Class("text-xs text-muted-foreground/60")], ["in the last 24 hours"]),
						],
					),
	})

const VIEW_LABELS = ["Open", "Closed", "All"]

const SORT_LABEL = { last_seen: "Most recent", volume: "Most errors", severity: "Severity" } as const

const SEVERITY_FILTER_LABEL = {
	all: "All severities",
	...SEVERITY_LABEL,
	unset: "Unset",
} satisfies Record<SeverityFilter, string>

/** The closed trigger's shorter form: the stacked blob already says "all of them". */
const SEVERITY_TRIGGER_LABEL = { ...SEVERITY_FILTER_LABEL, all: "Severity" } satisfies Record<
	SeverityFilter,
	string
>

const isSeverityFilter = (value: string): value is SeverityFilter =>
	SEVERITY_FILTERS.some((filter) => filter === value)

/** `SeverityFilterDot`: the four real levels stacked for "all", the hollow ring for unset. */
const severityFilterDot = (h: H, value: SeverityFilter): Html =>
	value === "all"
		? h.span(
				[h.AriaHidden(true), h.Class("flex shrink-0 -space-x-1")],
				SEVERITY_ORDER.map((severity) =>
					statusDot(h, {
						tone: "custom",
						size: "lg",
						className: cn("ring-1 ring-popover", SEVERITY_FILL[severity]),
					}),
				),
			)
		: severityDot(h, value === "unset" ? null : value)

const severityContent = (
	h: H,
	value: string,
	labels: Record<SeverityFilter, string>,
): ReadonlyArray<Html | string> =>
	isSeverityFilter(value)
		? [h.span([h.Class("flex items-center gap-2")], [severityFilterDot(h, value), labels[value]])]
		: ["Severity"]

const SORT_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = HUB_SORTS.map((value) => ({
	_tag: "Item",
	item: { value, label: SORT_LABEL[value] },
}))

const SEVERITY_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = SEVERITY_FILTERS.map((value) => ({
	_tag: "Item",
	item: { value, label: SEVERITY_FILTER_LABEL[value] },
}))

/** `ToolbarSearch` (`SearchInput` size sm): typing is debounced into the URL's `q`. */
const toolbarSearch = (h: H, draft: string): Html =>
	searchInput(h, {
		id: "errors-search",
		size: "sm",
		className: cn("max-w-sm", "w-52"),
		placeholder: "Search issues…",
		value: draft,
		onInput: (value) => Message.ChangedSearchDraft({ value }),
		onClear: Message.ChangedSearchDraft({ value: "" }),
	})

/** `ListToolbar`: view tabs, then search, sort, severity and the count readout. */
export const toolbar = (h: H, model: Model, count: ReadonlyArray<string> | null): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2 gap-y-1.5 pb-3")],
		[
			h.submodel({
				slotId: "errors-view-tabs",
				model: model.tabs,
				view: TabsView.view,
				viewInputs: {
					labels: VIEW_LABELS,
					ariaLabel: "Filter errors",
					tabClassName: "group/tab h-7 grow-0 px-2.5 text-xs sm:h-7 sm:text-xs",
					panel: () => undefined,
				},
				toParentMessage: (message) => Message.GotTabsMessage({ message }),
			}),
			h.div(
				[h.Class("ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2")],
				[
					toolbarSearch(h, model.searchDraft),
					h.submodel({
						slotId: model.sortSelect.id,
						model: model.sortSelect,
						view: SelectView.view,
						viewInputs: {
							entries: SORT_ENTRIES,
							size: "sm",
							className: "h-7 w-[126px] text-xs",
							toView: (parts) => h.div([h.Class("contents")], parts),
						},
						toParentMessage: (message) => Message.GotSortSelectMessage({ message }),
					}),
					h.submodel({
						slotId: model.severitySelect.id,
						model: model.severitySelect,
						view: SelectView.view,
						viewInputs: {
							entries: SEVERITY_ENTRIES,
							size: "sm",
							className: "h-7 w-[122px] text-xs",
							renderValue: (value) => severityContent(h, value, SEVERITY_TRIGGER_LABEL),
							renderItem: (option) => severityContent(h, option.value, SEVERITY_FILTER_LABEL),
							toView: (parts) => h.div([h.Class("contents")], parts),
						},
						toParentMessage: (message) => Message.GotSeveritySelectMessage({ message }),
					}),
					...(count === null
						? []
						: [h.span([h.Class("text-xs text-muted-foreground tabular-nums")], count)]),
				],
			),
		],
	)
