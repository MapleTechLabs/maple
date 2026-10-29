import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { type LogsViewBuilder, ModeToggleBinding } from "./composition"
import { refreshButton, timeRangeSelect, toolbar, toolbarSearch, toolbarStat, toolbarStats } from "../kit/toolbar"
import type { LogsMode } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"
import { rowsOf } from "./stream"

// The toolbar `renderPage` wraps every mode in: mode toggle, search, the mode's stats, refresh, range.

/** Each mode supplies its own stat (`LogListMode` / `LogPatternsMode`). */
const stats = (h: LogsViewBuilder, model: Model, mode: LogsMode): ReadonlyArray<Html> => {
	if (mode === "list") {
		const hasNextPage = Option.exists(AsyncData.getData(model.logs.data), (data) => data.hasNextPage)
		return [toolbarStat(h, { value: rowsOf(model).length, label: hasNextPage ? "logs+" : "logs" })]
	}
	return Option.match(AsyncData.getData(model.patterns.data), {
		onNone: () => [],
		onSome: (data) => [
			toolbarStat(h, { value: data.patterns.length, label: "patterns" }),
			h.span(data.isTruncated ? [h.Title("Clustered from the newest logs only")] : [], [
				toolbarStat(h, { value: data.totalSampled, label: data.isTruncated ? "logs+" : "logs" }),
			]),
		],
	})
}

export const logsToolbar = (
	h: LogsViewBuilder,
	model: Model,
	mode: LogsMode,
	options: Readonly<{ range: string; hasNewData: boolean }>,
): Html =>
	toolbar(h, [
		h.block(
			ModeToggleBinding.embedView({
				slotId: "logs-mode-toggle",
				model: model.modeToggle,
				viewInputs: {
					items: [
						{ value: "list", label: "List" },
						{ value: "patterns", label: "Patterns" },
					],
					selectedValues: [mode],
					variant: "outline",
					size: "sm",
					className: "shrink-0",
				},
			}),
		),
		toolbarSearch(h, {
			id: "logs-search",
			value: model.search.text,
			placeholder: "Search log bodies…",
			onInput: (text) => Message.ChangedSearch({ text }),
			onClear: Message.ClickedClearSearch(),
			className: "min-w-48 flex-1",
		}),
		toolbarStats(
			h,
			[
				...stats(h, model, mode),
				refreshButton(h, { isSpinning: model.isRefreshing, hasNewData: options.hasNewData, onRefresh: Message.ClickedRefresh() }),
				timeRangeSelect(h, options.range, (range) => Message.ChangedRange({ range })),
			],
			"shrink-0",
		),
	])
