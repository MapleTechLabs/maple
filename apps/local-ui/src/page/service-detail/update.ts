import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { LoadChartRuntime } from "@maple/web/charts/chart-runtime"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { accept, idle, acceptCached } from "../../data/slot"
import { hrefFor, queryOf } from "../../route"
import { type PageContext, PageOutMessage, withParams } from "../contract"
import { ReadClock, ReadRefreshClock } from "./command"
import { ServiceDetailComposition } from "./composition"
import { type LoadCommand, load, type SlotName } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

type PageCommand = LoadCommand | ReturnType<typeof ReadRefreshClock>
/** A handler's result: the page's Model, its fetches and an ask to the root. */
type UpdateReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<PageCommand>
	outMessage?: PageOutMessage
}>
/** The page's own fields; the charts are assembled by their Bindings. */
type PageFields = Omit<
	Model,
	"latencyChart" | "throughputChart" | "apdexChart" | "errorRateChart" | "operationsChart"
>

/** Detail-page params that must not leak back into a list's filters. */
const DETAIL_ONLY_PARAMS = ["spanId", "view"]

export const init = ServiceDetailComposition.makeInit((_context: PageContext, serviceName: string) => {
	const model: PageFields = {
		_tag: "ServiceDetailPage",
		serviceName,
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		overview: idle(),
		operations: idle(),
		timeseries: idle(),
		golden: idle(),
		overviewUpdatedAtMs: 0,
		isRefreshing: false,
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
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

/** The refresh spinner stops once nothing the refresh started is still loading. */
const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	const busy = [model.overview, model.operations, model.timeseries, model.golden].some((slot) =>
		isLoading(slot.data),
	)
	return model.isRefreshing && !busy ? { ...model, isRefreshing: false } : model
}

/** A settled answer can change the chart window or the top operations, which re-key the charts. */
const settle = (model: Model, context: PageContext): UpdateReturn => {
	const next = load(model, context)
	return { model: settleRefresh(next.model), commands: next.commands }
}

/** A cached slot is on screen: re-key the charts it decides, and fetch it unless it is fresh. */
const settleCached = (model: Model, context: PageContext, slot: SlotName, isFresh: boolean): UpdateReturn => {
	const next = load(model, context, isFresh ? [] : [slot])
	return { model: settleRefresh(next.model), commands: next.commands }
}

const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** `back("/services")`: history back, else the list with the detail-only params dropped. */
const back = (model: Model, context: PageContext): UpdateReturn => {
	const fallback = queryOf(context.location)
	DETAIL_ONLY_PARAMS.forEach((key) => fallback.delete(key))
	return {
		model,
		outMessage: PageOutMessage.RequestedBack({ fallbackHash: hrefFor("/services", fallback) }),
	}
}

const retry = (model: Model, context: PageContext, slot: SlotName): UpdateReturn =>
	load(model, context, [slot])

const ALL_SLOTS: ReadonlyArray<SlotName> = ["overview", "operations", "timeseries", "golden"]

export const update = ServiceDetailComposition.makeUpdate.withContext((context: PageContext) => ({
	CompletedReadClock: (model, { nowMs }) =>
		load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
	SucceededFetchOverview: (model, { key, overview, fetchedAtMs }) =>
		settle(
			{
				...model,
				overview: accept(model.overview, key, Result.succeed(overview), fetchedAtMs),
				overviewUpdatedAtMs: model.overview.key === key ? fetchedAtMs : model.overviewUpdatedAtMs,
			},
			context,
		),
	FailedFetchOverview: (model, { key, failure }) =>
		settle({ ...model, overview: accept(model.overview, key, Result.fail(failure)) }, context),
	SucceededFetchOperations: (model, { key, operations, fetchedAtMs }) =>
		settle(
			{ ...model, operations: accept(model.operations, key, Result.succeed(operations), fetchedAtMs) },
			context,
		),
	FailedFetchOperations: (model, { key, failure }) =>
		settle({ ...model, operations: accept(model.operations, key, Result.fail(failure)) }, context),
	SucceededFetchTimeseries: (model, { key, points, fetchedAtMs }) =>
		settle(
			{ ...model, timeseries: accept(model.timeseries, key, Result.succeed(points), fetchedAtMs) },
			context,
		),
	FailedFetchTimeseries: (model, { key, failure }) =>
		settle({ ...model, timeseries: accept(model.timeseries, key, Result.fail(failure)) }, context),
	SucceededFetchGoldenSignals: (model, { key, rows, fetchedAtMs }) =>
		settle({ ...model, golden: accept(model.golden, key, Result.succeed(rows), fetchedAtMs) }, context),
	FoundCachedOverview: (model, { key, cached }) =>
		model.overview.key === key
			? settleCached(
					{
						...model,
						overview: acceptCached(model.overview, key, cached, cached.isFresh),
						overviewUpdatedAtMs: cached.updatedAtMs,
					},
					context,
					"overview",
					cached.isFresh,
				)
			: { model },
	FoundCachedOperations: (model, { key, cached }) =>
		model.operations.key === key
			? settleCached(
					{ ...model, operations: acceptCached(model.operations, key, cached, cached.isFresh) },
					context,
					"operations",
					cached.isFresh,
				)
			: { model },
	FoundCachedTimeseries: (model, { key, cached }) =>
		model.timeseries.key === key
			? settleCached(
					{ ...model, timeseries: acceptCached(model.timeseries, key, cached, cached.isFresh) },
					context,
					"timeseries",
					cached.isFresh,
				)
			: { model },
	FoundCachedGoldenSignals: (model, { key, cached }) =>
		model.golden.key === key
			? settleCached(
					{ ...model, golden: acceptCached(model.golden, key, cached, cached.isFresh) },
					context,
					"golden",
					cached.isFresh,
				)
			: { model },
	FailedFetchGoldenSignals: (model, { key, failure }) =>
		settle({ ...model, golden: accept(model.golden, key, Result.fail(failure)) }, context),
	ClickedRetryOverview: (model) => retry(model, context, "overview"),
	ClickedRetryOperations: (model) => retry(model, context, "operations"),
	ClickedRetryGoldenSignals: (model) => retry(model, context, "golden"),
	ClickedRefresh: (model) =>
		model.isRefreshing
			? { model }
			: { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
	CompletedReadRefreshClock: (model, { nowMs }) => {
		const next = snapToMinute(nowMs)
		// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
		if (Option.getOrNull(model.maybeAnchorMs) !== next)
			return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
		const refetch = load({ ...model, nowMs }, context, ALL_SLOTS)
		return {
			model: settleRefresh(refetch.model),
			commands: refetch.commands,
			outMessage: PageOutMessage.RefetchedInPlace(),
		}
	},
	ClickedBack: (model) => back(model, context),
	ChangedRange: (model, { range }) => setRange(model, context, range),
	ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
	CompletedLoadChartRuntime: (model) => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
	FailedLoadChartRuntime: (model, { reason }) => ({
		model: { ...model, chartRuntime: { _tag: "Failed", reason } },
	}),
	ResolvedThemeColors: (model, { colors }) => ({ model: { ...model, themeColors: colors } }),
	/** A search change (the range) re-keys every query on the new window. */
	InformedOfLocationChange: (model) => load(model, context),
}))
