import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { LoadChartRuntime } from "@maple/web/charts/chart-runtime"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { accept, idle, acceptCached } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { FetchList, FetchSparklines, FetchSummary, ReadClock, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { MetricsComposition } from "./composition"
import { updateCopy } from "../kit/copies"
import { type LoadCommand, load, loadSparklines } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

type PageCommand =
	| LoadCommand
	| ReturnType<typeof ReadRefreshClock>
	| ReturnType<typeof WaitSearchDebounce>
/** A handler's result: the page's Model, its fetches and an ask to the root. */
type Step = Readonly<{ model: Model; commands?: ReadonlyArray<PageCommand>; outMessage?: PageOutMessage }>
/** The page's own fields; the chart and the filter sections are assembled by their Bindings. */
type PageFields = Omit<Model, "sparkline" | "sections">

export const init = MetricsComposition.makeInit((context: PageContext) => {
	const q = queryOf(context.location).get("q") ?? ""
	const model: PageFields = {
		_tag: "MetricsPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		list: idle(),
		listUpdatedAtMs: 0,
		summary: idle(),
		sparklines: idle(),
		search: { text: q, version: 0, sent: q },
		isRefreshing: false,
		grid: { width: 0, height: 0, scrollTop: 0 },
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		copies: {},
	}
	return {
		model,
		commands: [
			ReadClock(),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
})

/** The hash changed: keep the search input in sync unless it is the page's own echo, then load. */
const locationChanged = (model: Model, context: PageContext): Step => {
	const q = queryOf(context.location).get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	return withPresence(load({ ...model, search }, context), context)
}

const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): Step => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

const setRange = (model: Model, context: PageContext, range: string): Step => ({
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

const editSearch = (model: Model, text: string): Step => {
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
const withPresence = (step: Step, context: PageContext): Step => {
	const service = queryOf(context.location).get("service") || undefined
	const isEmpty =
		AsyncData.isSuccess(step.model.list.data) && visibleEntries(step.model, service).length === 0
	return isEmpty && step.outMessage === undefined ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step
}

export const update = MetricsComposition.makeUpdate.withContext((context: PageContext) => ({
	CompletedReadClock: (model, { nowMs }) =>
		load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
	SucceededFetchList: (model, { key, data, fetchedAtMs }) => {
		const isCurrent = model.list.key === key
		const next = { ...model, list: accept(model.list, key, Result.succeed(data), fetchedAtMs), listUpdatedAtMs: isCurrent ? fetchedAtMs : model.listUpdatedAtMs }
		const sparklines = loadSparklines(next, context)
		return withPresence({ model: settleRefresh(sparklines.model), commands: sparklines.commands }, context)
	},
	FailedFetchList: (model, { key, failure }) => ({ model: settleRefresh({ ...model, list: accept(model.list, key, Result.fail(failure)) }) }),
	SucceededFetchSummary: (model, { key, rows, fetchedAtMs }) =>
		({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.succeed(rows), fetchedAtMs) }) }),
	FoundCachedList: (model, { request, cached }) => {
		if (model.list.key !== request.key) return { model }
		const next = { ...model, list: acceptCached(model.list, request.key, cached, cached.isFresh), listUpdatedAtMs: cached.updatedAtMs }
		const sparklines = loadSparklines(next, context)
		const fetch = cached.isFresh ? [] : [FetchList({ ...request, readsCache: false })]
		return withPresence({ model: settleRefresh(sparklines.model), commands: [...fetch, ...(sparklines.commands ?? [])] }, context)
	},
	FoundCachedSummary: (model, { request, cached }) =>
		model.summary.key === request.key
			? {
					model: settleRefresh({ ...model, summary: acceptCached(model.summary, request.key, cached, cached.isFresh) }),
					commands: cached.isFresh ? [] : [FetchSummary({ ...request, readsCache: false })],
				}
			: { model },
	FoundCachedSparklines: (model, { request, cached }) =>
		model.sparklines.key === request.key
			? {
					model: settleRefresh({ ...model, sparklines: acceptCached(model.sparklines, request.key, cached, cached.isFresh) }),
					commands: cached.isFresh ? [] : [FetchSparklines({ ...request, readsCache: false })],
				}
			: { model },
	FailedFetchSummary: (model, { key, failure }) => ({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.fail(failure)) }) }),
	SucceededFetchSparklines: (model, { key, sparklines, fetchedAtMs }) =>
		({ model: settleRefresh({ ...model, sparklines: accept(model.sparklines, key, Result.succeed(sparklines), fetchedAtMs) }) }),
	FailedFetchSparklines: (model, { key, failure }) =>
		({ model: settleRefresh({ ...model, sparklines: accept(model.sparklines, key, Result.fail(failure)) }) }),
	ClickedOpenFilters: (model) => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
	ClickedRefresh: (model) =>
		model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
	CompletedReadRefreshClock: (model, { nowMs }) => {
		const next = snapToMinute(nowMs)
		// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
		if (Option.getOrNull(model.maybeAnchorMs) !== next)
			return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
		const refetch = load({ ...model, nowMs }, context, true)
		return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
	},
	ChangedSearch: (model, { text }) => editSearch(model, text),
	ClickedClearSearch: (model) => editSearch(model, ""),
	ElapsedSearchDebounce: (model, { version }) => {
		if (version !== model.search.version) return { model }
		const trimmed = model.search.text.trim()
		return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
	},
	ToggledFacetOption: (model, { param, name }) =>
		navigate(model, context, { [param]: queryOf(context.location).get(param) === name ? null : name }),
	ClickedClearSidebarFilters: (model) => navigate(model, context, { service: null, type: null }),
	ClickedClearFilters: (model) => navigate(model, context, { service: null, type: null, q: null }),
	ChangedRange: (model, { range }) => setRange(model, context, range),
	ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
	MeasuredGrid: (model, { viewport }) => ({ model: { ...model, grid: viewport } }),
	ResolvedThemeColors: (model, { colors }) => ({ model: { ...model, themeColors: colors } }),
	CompletedLoadChartRuntime: (model) => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
	FailedLoadChartRuntime: (model, { reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
	InformedOfLocationChange: (model) => locationChanged(model, context),
	ReceivedCopyMessage: (model, { message }) => {
		const next = updateCopy(model.copies, message, (copyMessage) => Message.ReceivedCopyMessage({ message: copyMessage }))
		return { model: { ...model, copies: next.copies }, commands: next.commands }
	},
}))

