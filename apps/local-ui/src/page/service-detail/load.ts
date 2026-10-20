import type { Resources } from "../../platform/resources"
import { boundsForRange, chartWindow, type ChartWindow, type TimeBounds } from "../../lib/time"
import { Array, Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { FetchGoldenSignals, FetchOperations, FetchOverview, FetchTimeseries } from "./command"
import type { Message } from "./message"
import type { Model } from "./model"

const CHART_SERIES_LIMIT = 8

export type SlotName = "overview" | "operations" | "timeseries" | "golden"

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

/** `chartWindow(bounds, firstSeenMs)`: clipped to when the service first showed up, ending now. */
export const chartOf = (model: Model, bounds: TimeBounds): ChartWindow => {
	const firstSeenMs = Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.overview.data), (overview) => Option.fromNullishOr(overview?.firstSeenMs)),
	)
	return chartWindow(bounds, firstSeenMs, model.nowMs)
}

/** The chart's series: the first eight operations by volume. */
export const topSpanNames = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.operations.data), {
		onNone: () => [],
		onSome: (operations) => operations.slice(0, CHART_SERIES_LIMIT).map((operation) => operation.spanName),
	})

/**
 * Requests every query whose key the window, the overview's first-seen time or the top operations
 * changed. `forced` refetches those slots in place, as `invalidateQueries` or a Retry does.
 */
export const load = (
	model: Model,
	context: PageContext,
	forced: ReadonlyArray<SlotName> = [],
): Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }> =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const { serviceName } = model
			const window = { serviceName, ...bounds, apiBase: context.env.apiBase }
			const boundsKey = `${bounds.startTime}/${bounds.endTime}`
			const { bucketSeconds } = chartOf(model, bounds)
			const spanNames = topSpanNames(model)
			const keys = {
				overview: keyOf("service-overview", { serviceName, boundsKey }),
				operations: keyOf("service-operations", { serviceName, boundsKey }),
				timeseries: keyOf("service-operations-ts", { serviceName, spanNames, bucketSeconds, boundsKey }),
				golden: keyOf("service-golden-signals", { serviceName, bucketSeconds, boundsKey }),
			}
			// A key the slot has no rows for opens on its cached result; a forced refetch does not.
			const readsCache = (slot: SlotName) => !forced.includes(slot) && model[slot].key !== keys[slot]
			const overview = request(model.overview, keys.overview, forced.includes("overview"))
			const operations = request(model.operations, keys.operations, forced.includes("operations"))
			// `skipToken` while no operation is known: nothing to chart.
			const timeseries =
				spanNames.length === 0 ? Option.none() : request(model.timeseries, keys.timeseries, forced.includes("timeseries"))
			const golden = request(model.golden, keys.golden, forced.includes("golden"))
			return {
				model: {
					...model,
					overview: Option.getOrElse(overview, () => model.overview),
					operations: Option.getOrElse(operations, () => model.operations),
					timeseries: Option.getOrElse(timeseries, () => model.timeseries),
					golden: Option.getOrElse(golden, () => model.golden),
				},
				commands: Array.getSomes([
					Option.map(overview, () => FetchOverview({ key: keys.overview, ...window, readsCache: readsCache("overview") })),
					Option.map(operations, () => FetchOperations({ key: keys.operations, ...window, readsCache: readsCache("operations") })),
					Option.map(timeseries, () =>
						FetchTimeseries({ key: keys.timeseries, ...window, spanNames, bucketSeconds, readsCache: readsCache("timeseries") }),
					),
					Option.map(golden, () => FetchGoldenSignals({ key: keys.golden, ...window, bucketSeconds, readsCache: readsCache("golden") })),
				]),
			}
		},
	})
