import { errorState } from "@maple/views/ui/error-state"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { listSkeleton } from "../kit/placeholders"
import { signalEmptyState } from "../kit/signal-empty-state"
import { activeFilterCount, filtersOf, isFiltered, type LogFilters, modeOf } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"
import { rowsOf } from "./update-stream"
import { patternsList } from "./view-patterns"
import * as LogSheet from "@maple/views/logs/log-sheet"
import { sheetClock, traceHash } from "../kit/log-sheet"
import { logsToolbar } from "./view-toolbar"
import { sidebar } from "./view-sidebar"
import { attributeFilterChips, logStream } from "./view-stream"

// The Logs page: the list or the patterns mode.

const toCopy = (id: string, message: Parameters<typeof Message.GotCopyMessage>[0]["message"]) =>
	Message.GotCopyMessage({ id, message })

const emptyState = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, filters: LogFilters): Html =>
	signalEmptyState(h, {
		signal: "logs",
		isFiltered: isFiltered(filters),
		onClearFilters: Message.ClickedClearFilters(),
		range: rangeOf(inputs.context),
		onWidenRange: Message.ClickedWidenRange(),
		maybePresence: inputs.presenceOf("logs"),
		nowMs: inputs.presenceNowMs,
		guide: { id: "logs-empty", endpoint: inputs.context.env.otlpEndpoint, copies: model.copies, toCopyMessage: toCopy },
	})

const listContent = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, filters: LogFilters): ReadonlyArray<Html> => {
	const sheet = Option.match(model.maybeDetail, {
		onNone: () => [],
		onSome: (sheet) => [
			h.submodel({
				slotId: "log-detail-sheet",
				model: sheet,
				view: LogSheet.view,
				viewInputs: { ...sheetClock(inputs.context.timeFormat), canFilter: true, traceHref: traceHash },
				toParentMessage: (message) => Message.GotLogSheetMessage({ message }),
			}),
		],
	})
	if (isAwaitingFirstData(model.logs)) return [listSkeleton(h, "table", 8), ...sheet]
	const failure = failureWithoutData(model.logs)
	if (Option.isSome(failure))
		return [
			errorState(h, {
				failure: failure.value, title: "Couldn’t load logs",
				onRetry: Message.ClickedRefresh(),
			}),
			...sheet,
		]
	if (rowsOf(model).length === 0) return [emptyState(h, model, inputs, filters), ...sheet]
	return [logStream(h, model, filters.search, inputs.context.timeFormat), ...sheet]
}

const patternsContent = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, filters: LogFilters): Html => {
	if (isAwaitingFirstData(model.patterns)) return listSkeleton(h, "table", 8)
	const failure = failureWithoutData(model.patterns)
	if (Option.isSome(failure))
		return errorState(h, {
			failure: failure.value, title: "Couldn’t load log patterns",
			onRetry: Message.ClickedRefresh(),
		})
	return Option.match(AsyncData.getData(model.patterns.data), {
		onNone: () => emptyState(h, model, inputs, filters),
		onSome: (data) =>
			data.patterns.length === 0
				? emptyState(h, model, inputs, filters)
				: patternsList(h, { patterns: data.patterns, totalSampled: data.totalSampled, isDimmed: model.patterns.retained === true }),
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
			toolbar: logsToolbar(h, model, mode, { range: rangeOf(inputs.context), hasNewData: inputs.hasNewDataSince(since) }),
			activeFilterCount: activeFilterCount(filters),
		},
		[
			h.div(
				[h.Class("flex h-full min-h-0 flex-col")],
				[
					...attributeFilterChips(h, filters),
					h.div(
						[h.Class("min-h-0 flex-1 overflow-auto")],
						mode === "list" ? listContent(h, model, inputs, filters) : [patternsContent(h, model, inputs, filters)],
					),
				],
			),
		],
	)
})
