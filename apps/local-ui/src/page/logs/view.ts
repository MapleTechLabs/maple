import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { errorState, listSkeleton } from "../kit/view-states"
import { activeFilterCount, filtersOf, type LogFilters, modeOf } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"
import { rowsOf } from "./stream"
import { patternsList } from "./view-patterns"
import * as LogSheetView from "../kit/log-sheet/view"
import { logsToolbar } from "./view-toolbar"
import { sidebar } from "./view-sidebar"
import { chipCard } from "./view-chip-card"
import { logStream } from "./view-stream"

// The Logs page: the list or the patterns mode.

const toCopy = (id: string, message: Parameters<typeof Message.GotCopyMessage>[0]["message"]) =>
	Message.GotCopyMessage({ id, message })

const emptyState = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: PageViewInputs,
	filters: LogFilters,
): Html =>
	signalEmptyState(h, {
		signal: "logs",
		isFiltered: activeFilterCount(filters) > 0 || filters.search !== undefined,
		onClearFilters: Message.ClickedClearFilters(),
		range: rangeOf(inputs.context),
		onWidenRange: Message.ClickedWidenRange(),
		maybePresence: inputs.presenceOf("logs"),
		nowMs: inputs.presenceNowMs,
		guide: {
			id: "logs-empty",
			endpoint: inputs.context.env.otlpEndpoint,
			copies: model.copies,
			toCopyMessage: toCopy,
		},
	})

const listContent = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: PageViewInputs,
	filters: LogFilters,
): ReadonlyArray<Html> => {
	const sheet = Option.match(model.maybeDetail, {
		onNone: () => [],
		onSome: (sheet) => [
			h.submodel({
				slotId: "log-detail-sheet",
				model: sheet,
				view: LogSheetView.view,
				viewInputs: { timeFormat: inputs.context.timeFormat },
				toParentMessage: (message) => Message.GotLogSheetMessage({ message }),
			}),
		],
	})
	if (isPending(model.logs)) return [listSkeleton(h, { variant: "table" }), ...sheet]
	const failure = failureWithoutData(model.logs)
	if (Option.isSome(failure))
		return [
			errorState(h, { label: "logs", failure: failure.value, onRetry: Message.ClickedRefresh() }),
			...sheet,
		]
	if (rowsOf(model).length === 0) return [emptyState(h, model, inputs, filters), ...sheet]
	return [logStream(h, model, filters.search, inputs.context.timeFormat), ...chipCard(h, model), ...sheet]
}

const patternsContent = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: PageViewInputs,
	filters: LogFilters,
): Html => {
	if (isPending(model.patterns)) return listSkeleton(h, { variant: "table" })
	const failure = failureWithoutData(model.patterns)
	if (Option.isSome(failure))
		return errorState(h, {
			label: "log patterns",
			failure: failure.value,
			onRetry: Message.ClickedRefresh(),
		})
	return Option.match(AsyncData.getData(model.patterns.data), {
		onNone: () => emptyState(h, model, inputs, filters),
		onSome: (data) =>
			data.patterns.length === 0
				? emptyState(h, model, inputs, filters)
				: patternsList(h, {
						patterns: data.patterns,
						totalSampled: data.totalSampled,
						isDimmed: model.patterns.isPlaceholder,
					}),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const query = queryOf(inputs.context.location)
	const filters = filtersOf(query)
	const mode = modeOf(query)
	const since = mode === "list" ? model.logsUpdatedAtMs : model.patternsUpdatedAtMs
	return pageShell(
		h,
		{
			onOpenFilters: Message.ClickedOpenFilters(),
			sidebar: sidebar(h, model, filters),
			toolbar: logsToolbar(h, model, mode, {
				range: rangeOf(inputs.context),
				hasNewData: inputs.hasNewDataSince(since),
			}),
			activeFilterCount: activeFilterCount(filters),
		},
		mode === "list"
			? listContent(h, model, inputs, filters)
			: [patternsContent(h, model, inputs, filters)],
	)
})
