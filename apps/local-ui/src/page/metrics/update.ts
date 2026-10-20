import type { Resources } from "../../platform/resources"
import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { LoadChartRuntime } from "@maple/web/charts/chart-runtime"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Option, Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { accept, idle, acceptCached } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { updateCopy } from "../kit/copies"
import { FetchList, FetchSparklines, FetchSummary, ReadClock, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { load, loadSparklines } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const init = (
	context: PageContext,
): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }> => {
	const q = queryOf(context.location).get("q") ?? ""
	return {
		model: {
			_tag: "MetricsPage",
			maybeAnchorMs: Option.none(),
			nowMs: 0,
			list: idle(),
			listUpdatedAtMs: 0,
			summary: idle(),
			sparklines: idle(),
			search: { text: q, version: 0, sent: q },
			sections: FilterSections.init(),
			isRefreshing: false,
			grid: { width: 0, height: 0, scrollTop: 0 },
			themeColors: null,
			chartRuntime: { _tag: "Loading" },
			copies: {},
		},
		commands: [
			ReadClock(),
			Command.mapMessage(FilterSections.ReadRemembered(), toSections),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** The hash changed: keep the search input in sync unless it is the page's own echo, then load. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
	const q = queryOf(context.location).get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	return withPresence(load({ ...model, search }, context), context)
}

const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** The refresh spinner stops once nothing the refresh started is still loading. */
const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	return model.isRefreshing && !isLoading(model.list.data) && !isLoading(model.summary.data) && !isLoading(model.sparklines.data)
		? { ...model, isRefreshing: false }
		: model
}

const editSearch = (model: Model, text: string): UpdateReturn => {
	const version = model.search.version + 1
	return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
}

/** The service-filtered entries the grid shows (the service filter never re-runs SQL). */
export const visibleEntries = (model: Model, service: string | undefined) =>
	Option.match(AsyncData.getData(model.list.data), {
		onNone: () => [],
		onSome: (data) => (service ? data.entries.filter((entry) => entry.serviceNames.includes(service)) : data.entries),
	})

/** A settled empty grid renders `SignalEmptyState`, which reads the shared signal presence. */
const withPresence = (step: UpdateReturn, context: PageContext): UpdateReturn => {
	const service = queryOf(context.location).get("service") || undefined
	const isEmpty =
		AsyncData.isSuccess(step.model.list.data) && visibleEntries(step.model, service).length === 0
	return isEmpty && step.outMessage === undefined ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step
}

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) =>
			load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchList: ({ key, data, fetchedAtMs }) => {
			const isCurrent = model.list.key === key
			const next = { ...model, list: accept(model.list, key, Result.succeed(data), fetchedAtMs), listUpdatedAtMs: isCurrent ? fetchedAtMs : model.listUpdatedAtMs }
			const sparklines = loadSparklines(next, context)
			return withPresence({ model: settleRefresh(sparklines.model), commands: sparklines.commands }, context)
		},
		FailedFetchList: ({ key, failure }) => ({ model: settleRefresh({ ...model, list: accept(model.list, key, Result.fail(failure)) }) }),
		SucceededFetchSummary: ({ key, rows, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.succeed(rows), fetchedAtMs) }) }),
		FoundCachedList: ({ request, cached }) => {
			if (model.list.key !== request.key) return { model }
			const next = { ...model, list: acceptCached(model.list, request.key, cached, cached.isFresh), listUpdatedAtMs: cached.updatedAtMs }
			const sparklines = loadSparklines(next, context)
			const fetch = cached.isFresh ? [] : [FetchList({ ...request, readsCache: false })]
			return withPresence({ model: settleRefresh(sparklines.model), commands: [...fetch, ...(sparklines.commands ?? [])] }, context)
		},
		FoundCachedSummary: ({ request, cached }) =>
			model.summary.key === request.key
				? {
						model: settleRefresh({ ...model, summary: acceptCached(model.summary, request.key, cached, cached.isFresh) }),
						commands: cached.isFresh ? [] : [FetchSummary({ ...request, readsCache: false })],
					}
				: { model },
		FoundCachedSparklines: ({ request, cached }) =>
			model.sparklines.key === request.key
				? {
						model: settleRefresh({ ...model, sparklines: acceptCached(model.sparklines, request.key, cached, cached.isFresh) }),
						commands: cached.isFresh ? [] : [FetchSparklines({ ...request, readsCache: false })],
					}
				: { model },
		FailedFetchSummary: ({ key, failure }) => ({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.fail(failure)) }) }),
		SucceededFetchSparklines: ({ key, sparklines, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, sparklines: accept(model.sparklines, key, Result.succeed(sparklines), fetchedAtMs) }) }),
		FailedFetchSparklines: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, sparklines: accept(model.sparklines, key, Result.fail(failure)) }) }),
		ClickedOpenFilters: () => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
		ClickedRefresh: () =>
			model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
			const refetch = load({ ...model, nowMs }, context, true)
			return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
		},
		ChangedSearch: ({ text }) => editSearch(model, text),
		ClickedClearSearch: () => editSearch(model, ""),
		ElapsedSearchDebounce: ({ version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledFacetOption: ({ param, name }) =>
			navigate(model, context, { [param]: queryOf(context.location).get(param) === name ? null : name }),
		ClickedClearSidebarFilters: () => navigate(model, context, { service: null, type: null }),
		ClickedClearFilters: () => navigate(model, context, { service: null, type: null, q: null }),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		MeasuredGrid: ({ viewport }) => ({ model: { ...model, grid: viewport } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		GotSparklineMessage: () => ({ model }),
		GotFilterSectionsMessage: ({ message: child }) => {
			const next = FilterSections.update(model.sections, child)
			return { model: { ...model, sections: next.model }, commands: Command.mapMessages(next.commands ?? [], toSections) }
		},
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) => Message.GotCopyMessage({ id: copyId, message: copyMessage }))
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
	})
