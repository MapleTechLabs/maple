import type { Resources } from "../../platform/resources"
import { boundsForRange, type ChartWindow, chartWindow, parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { isMetricType } from "../../lib/units"
import { Array, Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import type { MetricEntry } from "../metrics/catalog"
import { FetchBreakdown, FetchEntry, FetchTimeseries } from "./command"
import type { Message } from "./message"
import type { Model } from "./model"

type Step = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

const boundsKey = (bounds: TimeBounds) => `${bounds.startTime}/${bounds.endTime}`

/** The entry on screen (a previous window's while the new one loads), or null. */
export const entryOf = (model: Model): MetricEntry | null =>
	Option.getOrNull(Option.flatMap(AsyncData.getData(model.entry.data), Option.fromNullishOr))

/** `chartWindow(bounds, firstSeenMs)`: the range clipped to when the metric first reported. */
export const chartOf = (model: Model, bounds: TimeBounds): ChartWindow =>
	chartWindow(bounds, parseClickHouseDateTime(entryOf(model)?.firstSeen), model.nowMs)

/** The timeseries and the breakdown read the entry: nothing to ask for until one exists. */
export const loadDependents = (model: Model, context: PageContext, force = false): Step => {
	const entry = entryOf(model)
	const maybeBounds = boundsOf(model, context)
	if (entry === null || Option.isNone(maybeBounds)) return { model }
	const bounds = maybeBounds.value
	const apiBase = context.env.apiBase
	const { bucketSeconds } = chartOf(model, bounds)
	const identity = { metricName: entry.metricName, metricType: entry.metricType, bounds: boundsKey(bounds) }
	const timeseriesKey = keyOf("metric-timeseries", { ...identity, isMonotonic: entry.isMonotonic, bucketSeconds })
	const breakdownKey = keyOf("metric-breakdown", identity)
	const timeseries = request(model.timeseries, timeseriesKey, force)
	const breakdown = isMetricType(entry.metricType) ? request(model.breakdown, breakdownKey, force) : Option.none()
	return {
		model: {
			...model,
			timeseries: Option.getOrElse(timeseries, () => model.timeseries),
			breakdown: Option.getOrElse(breakdown, () => model.breakdown),
		},
		commands: Array.getSomes([
			Option.map(timeseries, () =>
				FetchTimeseries({ key: timeseriesKey, entry, bucketSeconds, ...bounds, apiBase, readsCache: !force && model.timeseries.key !== timeseriesKey }),
			),
			Option.map(breakdown, () => FetchBreakdown({ key: breakdownKey, entry, ...bounds, apiBase, readsCache: !force && model.breakdown.key !== breakdownKey })),
		]),
	}
}

export const load = (model: Model, context: PageContext, force = false): Step =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const key = keyOf("metric-entry", { metricName: model.metricName, bounds: boundsKey(bounds) })
			const entry = request(model.entry, key, force)
			const next = { ...model, entry: Option.getOrElse(entry, () => model.entry) }
			const dependents = loadDependents(next, context, force)
			return {
				model: dependents.model,
				commands: [
					...Array.getSomes([
						Option.map(entry, () =>
							FetchEntry({ key, metricName: model.metricName, ...bounds, apiBase: context.env.apiBase, readsCache: !force && model.entry.key !== key }),
						),
					]),
					...(dependents.commands ?? []),
				],
			}
		},
	})
