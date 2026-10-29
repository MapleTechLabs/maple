import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { LoadChartRuntime } from "@maple/web/charts/chart-runtime"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { accept, acceptCached, idle } from "../../data/slot"
import { hrefFor, queryOf } from "../../route"
import { type PageContext, PageOutMessage, withParams } from "../contract"
import { FetchBreakdown, FetchEntry, FetchTimeseries, ReadClock, ReadRefreshClock } from "./command"
import { MetricDetailComposition } from "./composition"
import { load, loadDependents } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

type UpdateReturn = Readonly<{ model: Model; outMessage?: PageOutMessage }>
/** The page's own fields; the chart is assembled by its Binding. */
type PageFields = Omit<Model, "chart">

export const init = MetricDetailComposition.makeInit((_context: PageContext, metricName: string) => {
	const model: PageFields = {
		_tag: "MetricDetailPage",
		metricName,
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		entry: idle(),
		entryUpdatedAtMs: 0,
		timeseries: idle(),
		breakdown: idle(),
		isRefreshing: false,
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
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

/** Detail-page params that must not leak back into the list's filters. */
const DETAIL_ONLY_PARAMS = ["spanId", "view"]

/** `back("/metrics")`: history back within the app, else the list with the filters intact. */
export const backFallbackHash = (context: PageContext): string => {
	const fallback = queryOf(context.location)
	DETAIL_ONLY_PARAMS.forEach((key) => fallback.delete(key))
	return hrefFor("/metrics", fallback)
}

const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	return model.isRefreshing &&
		!isLoading(model.entry.data) &&
		!isLoading(model.timeseries.data) &&
		!isLoading(model.breakdown.data)
		? { ...model, isRefreshing: false }
		: model
}

export const update = MetricDetailComposition.makeUpdate.withContext((context: PageContext) => ({
	CompletedReadClock: (model, { nowMs }) =>
		load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
	SucceededFetchEntry: (model, { key, entry, fetchedAtMs }) => {
		const isCurrent = model.entry.key === key
		const next = {
			...model,
			entry: accept(model.entry, key, Result.succeed(entry), fetchedAtMs),
			entryUpdatedAtMs: isCurrent ? fetchedAtMs : model.entryUpdatedAtMs,
		}
		const dependents = loadDependents(next, context)
		return { model: settleRefresh(dependents.model), commands: dependents.commands }
	},
	FailedFetchEntry: (model, { key, failure }) =>
		({ model: settleRefresh({ ...model, entry: accept(model.entry, key, Result.fail(failure)) }) }),
	SucceededFetchTimeseries: (model, { key, points, fetchedAtMs }) =>
		({ model: settleRefresh({ ...model, timeseries: accept(model.timeseries, key, Result.succeed(points), fetchedAtMs) }) }),
	FailedFetchTimeseries: (model, { key, failure }) =>
		({ model: settleRefresh({ ...model, timeseries: accept(model.timeseries, key, Result.fail(failure)) }) }),
	SucceededFetchBreakdown: (model, { key, rows, fetchedAtMs }) =>
		({ model: settleRefresh({ ...model, breakdown: accept(model.breakdown, key, Result.succeed(rows), fetchedAtMs) }) }),
	FoundCachedEntry: (model, { request, cached }) => {
		if (model.entry.key !== request.key) return { model }
		const next = { ...model, entry: acceptCached(model.entry, request.key, cached, cached.isFresh), entryUpdatedAtMs: cached.updatedAtMs }
		const dependents = loadDependents(next, context)
		const fetch = cached.isFresh ? [] : [FetchEntry({ ...request, readsCache: false })]
		return { model: settleRefresh(dependents.model), commands: [...fetch, ...(dependents.commands ?? [])] }
	},
	FoundCachedTimeseries: (model, { request, cached }) =>
		model.timeseries.key === request.key
			? {
					model: settleRefresh({ ...model, timeseries: acceptCached(model.timeseries, request.key, cached, cached.isFresh) }),
					commands: cached.isFresh ? [] : [FetchTimeseries({ ...request, readsCache: false })],
				}
			: { model },
	FoundCachedBreakdown: (model, { request, cached }) =>
		model.breakdown.key === request.key
			? {
					model: settleRefresh({ ...model, breakdown: acceptCached(model.breakdown, request.key, cached, cached.isFresh) }),
					commands: cached.isFresh ? [] : [FetchBreakdown({ ...request, readsCache: false })],
				}
			: { model },
	FailedFetchBreakdown: (model, { key, failure }) =>
		({ model: settleRefresh({ ...model, breakdown: accept(model.breakdown, key, Result.fail(failure)) }) }),
	ClickedBack: (model) => ({ model, outMessage: PageOutMessage.RequestedBack({ fallbackHash: backFallbackHash(context) }) }),
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
	ChangedRange: (model, { range }) => setRange(model, context, range),
	ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
	ResolvedThemeColors: (model, { colors }) => ({ model: { ...model, themeColors: colors } }),
	CompletedLoadChartRuntime: (model) => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
	FailedLoadChartRuntime: (model, { reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
	InformedOfLocationChange: (model) => load(model, context),
}))
