import * as ToggleGroup from "@maple/web/ui/toggle-group"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	refreshButton,
	timeRangeSelect,
	toolbar,
	toolbarSearch,
	toolbarStat,
	toolbarStats,
} from "../kit/toolbar"
import type { LogsMode } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"
import { rowsOf } from "./stream"

// The toolbar `renderPage` wraps every mode in: mode toggle, search, the mode's stats, refresh, range.

/** Each mode supplies its own stat (`LogListMode` / `LogPatternsMode`). */
const stats = (h: HtmlBuilder<Message>, model: Model, mode: LogsMode): ReadonlyArray<Html> => {
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
	h: HtmlBuilder<Message>,
	model: Model,
	mode: LogsMode,
	options: Readonly<{ range: string; hasNewData: boolean }>,
): Html =>
	toolbar(h, [
		ToggleGroup.view(h, {
			model: { ...model.modeToggle, values: [mode] },
			toParentMessage: (message) => Message.GotModeToggleMessage({ message }),
			items: [
				{ value: "list", label: "List" },
				{ value: "patterns", label: "Patterns" },
			],
			variant: "outline",
			size: "sm",
			className: "shrink-0",
		}),
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
				refreshButton(h, {
					isSpinning: model.isRefreshing,
					hasNewData: options.hasNewData,
					onRefresh: Message.ClickedRefresh(),
				}),
				timeRangeSelect(h, options.range, (range) => Message.ChangedRange({ range })),
			],
			"shrink-0",
		),
	])
