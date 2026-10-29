import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { type PresenceResult, presenceOf } from "../../data/signal-presence"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, rangeOf } from "../contract"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { errorState, listSkeleton } from "../kit/view-states"
import { LogSheetBinding, LogsComposition, type LogsViewBuilder } from "./composition"
import { activeFilterCount, filtersOf, type LogFilters, modeOf } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"
import { rowsOf } from "./stream"
import { patternsList } from "./view-patterns"
import { logsToolbar } from "./view-toolbar"
import { sidebar } from "./view-sidebar"
import { chipCard } from "./view-chip-card"
import { logStream } from "./view-stream"

// The Logs page: the list or the patterns mode.

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type LogsViewInputs = Readonly<{
	context: PageContext
	/** The shared signal presence read (`useSignalPresence`): none while loading or unreadable. */
	maybePresence: Option.Option<PresenceResult>
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the list loaded. */
const hasNewDataSince = (inputs: LogsViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

const emptyState = (h: LogsViewBuilder, model: Model, inputs: LogsViewInputs, filters: LogFilters): Html =>
	signalEmptyState(h, {
		signal: "logs",
		isFiltered: activeFilterCount(filters) > 0 || filters.search !== undefined,
		onClearFilters: Message.ClickedClearFilters(),
		range: rangeOf(inputs.context),
		onWidenRange: Message.ClickedWidenRange(),
		maybePresence: presenceOf(inputs.maybePresence, "logs"),
		nowMs: Option.match(inputs.maybePresence, { onNone: () => 0, onSome: (result) => result.nowMs }),
		guide: {
			id: "logs-empty",
			endpoint: inputs.context.env.otlpEndpoint,
			copies: model.copies,
			toCopyMessage: (message) => Message.ReceivedCopyMessage({ message }),
		},
	})

const listContent = (h: LogsViewBuilder, model: Model, inputs: LogsViewInputs, filters: LogFilters): ReadonlyArray<Html> => {
	const sheet = Option.match(model.maybeDetail, {
		onNone: () => [],
		onSome: (sheet) => [
			h.block(
				LogSheetBinding.embedView({
					slotId: "log-detail-sheet",
					model: sheet,
					viewInputs: { timeFormat: inputs.context.timeFormat },
				}),
			),
		],
	})
	if (isPending(model.logs)) return [listSkeleton(h, { variant: "table" }), ...sheet]
	const failure = failureWithoutData(model.logs)
	if (Option.isSome(failure))
		return [errorState(h, { label: "logs", failure: failure.value, onRetry: Message.ClickedRefresh() }), ...sheet]
	if (rowsOf(model).length === 0) return [emptyState(h, model, inputs, filters), ...sheet]
	return [logStream(h, model, filters.search, inputs.context.timeFormat), ...chipCard(h, model), ...sheet]
}

const patternsContent = (h: LogsViewBuilder, model: Model, inputs: LogsViewInputs, filters: LogFilters): Html => {
	if (isPending(model.patterns)) return listSkeleton(h, { variant: "table" })
	const failure = failureWithoutData(model.patterns)
	if (Option.isSome(failure))
		return errorState(h, { label: "log patterns", failure: failure.value, onRetry: Message.ClickedRefresh() })
	return Option.match(AsyncData.getData(model.patterns.data), {
		onNone: () => emptyState(h, model, inputs, filters),
		onSome: (data) =>
			data.patterns.length === 0
				? emptyState(h, model, inputs, filters)
				: patternsList(h, { patterns: data.patterns, totalSampled: data.totalSampled, isDimmed: model.patterns.isPlaceholder }),
	})
}

export const view = LogsComposition.makeView.withInputs<LogsViewInputs>((model, inputs, h) => {
	const query = queryOf(inputs.context.location)
	const filters = filtersOf(query)
	const mode = modeOf(query)
	const since = mode === "list" ? model.logsUpdatedAtMs : model.patternsUpdatedAtMs
	return pageShell(
		h,
		{
			onOpenFilters: Message.ClickedOpenFilters(),
			sidebar: sidebar(h, model, filters),
			toolbar: logsToolbar(h, model, mode, { range: rangeOf(inputs.context), hasNewData: hasNewDataSince(inputs, since) }),
			activeFilterCount: activeFilterCount(filters),
		},
		mode === "list" ? listContent(h, model, inputs, filters) : [patternsContent(h, model, inputs, filters)],
	)
})
