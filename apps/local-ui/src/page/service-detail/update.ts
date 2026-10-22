import type { Resources } from "../../platform/resources"
import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import * as Chart from "@maple/web/charts/chart"
import { LoadChartRuntime } from "@maple/web/charts/chart-runtime"
import { Option, Record, Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { accept, idle, acceptCached } from "../../data/slot"
import { hrefFor, queryOf } from "../../route"
import { type PageContext, PageOutMessage, withParams } from "../contract"
import { ReadClock, ReadRefreshClock } from "./command"
import { load, type SlotName } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>

/** Detail-page params that must not leak back into a list's filters. */
const DETAIL_ONLY_PARAMS = ["spanId", "view"]

export const init = (
	_context: PageContext,
	serviceName: string,
): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }> => ({
	model: {
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
		charts: {},
	},
	commands: [
		ReadClock(),
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

/** A search change (the range) re-keys every query on the new window. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => load(model, context)

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

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) =>
			load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchOverview: ({ key, overview, fetchedAtMs }) =>
			settle(
				{
					...model,
					overview: accept(model.overview, key, Result.succeed(overview), fetchedAtMs),
					overviewUpdatedAtMs: model.overview.key === key ? fetchedAtMs : model.overviewUpdatedAtMs,
				},
				context,
			),
		FailedFetchOverview: ({ key, failure }) =>
			settle({ ...model, overview: accept(model.overview, key, Result.fail(failure)) }, context),
		SucceededFetchOperations: ({ key, operations, fetchedAtMs }) =>
			settle(
				{
					...model,
					operations: accept(model.operations, key, Result.succeed(operations), fetchedAtMs),
				},
				context,
			),
		FailedFetchOperations: ({ key, failure }) =>
			settle({ ...model, operations: accept(model.operations, key, Result.fail(failure)) }, context),
		SucceededFetchTimeseries: ({ key, points, fetchedAtMs }) =>
			settle(
				{ ...model, timeseries: accept(model.timeseries, key, Result.succeed(points), fetchedAtMs) },
				context,
			),
		FailedFetchTimeseries: ({ key, failure }) =>
			settle({ ...model, timeseries: accept(model.timeseries, key, Result.fail(failure)) }, context),
		SucceededFetchGoldenSignals: ({ key, rows, fetchedAtMs }) =>
			settle(
				{ ...model, golden: accept(model.golden, key, Result.succeed(rows), fetchedAtMs) },
				context,
			),
		FoundCachedOverview: ({ key, cached }) =>
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
		FoundCachedOperations: ({ key, cached }) =>
			model.operations.key === key
				? settleCached(
						{ ...model, operations: acceptCached(model.operations, key, cached, cached.isFresh) },
						context,
						"operations",
						cached.isFresh,
					)
				: { model },
		FoundCachedTimeseries: ({ key, cached }) =>
			model.timeseries.key === key
				? settleCached(
						{ ...model, timeseries: acceptCached(model.timeseries, key, cached, cached.isFresh) },
						context,
						"timeseries",
						cached.isFresh,
					)
				: { model },
		FoundCachedGoldenSignals: ({ key, cached }) =>
			model.golden.key === key
				? settleCached(
						{ ...model, golden: acceptCached(model.golden, key, cached, cached.isFresh) },
						context,
						"golden",
						cached.isFresh,
					)
				: { model },
		FailedFetchGoldenSignals: ({ key, failure }) =>
			settle({ ...model, golden: accept(model.golden, key, Result.fail(failure)) }, context),
		ClickedRetryOverview: () => retry(model, context, "overview"),
		ClickedRetryOperations: () => retry(model, context, "operations"),
		ClickedRetryGoldenSignals: () => retry(model, context, "golden"),
		ClickedRefresh: () =>
			model.isRefreshing
				? { model }
				: { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load(
					{ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false },
					context,
				)
			const refetch = load({ ...model, nowMs }, context, ALL_SLOTS)
			return {
				model: settleRefresh(refetch.model),
				commands: refetch.commands,
				outMessage: PageOutMessage.RefetchedInPlace(),
			}
		},
		ClickedBack: () => back(model, context),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ chartId, message: child }) => {
			const current = Option.getOrElse(Record.get(model.charts, chartId), Chart.init)
			const next = Chart.update(current, child)
			return {
				model: { ...model, charts: Record.set(model.charts, chartId, next.model) },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ chartId, message: chart }),
				),
			}
		},
	})
