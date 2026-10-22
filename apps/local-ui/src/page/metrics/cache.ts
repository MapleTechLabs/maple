import { Array, Option, Schema } from "effect"
import type { CacheValue } from "../../data/cache-store"
import { cachedAs } from "../../data/cached"
import { MetricsListData } from "./catalog"
import { type MetricSparkline, SparklinePoint, SummaryRow } from "./fetch"

// The metrics hooks' data as the result cache keeps them (keys are built in the Commands).

export const listFromCached = cachedAs(MetricsListData)
export const summaryFromCached = cachedAs(Schema.Array(SummaryRow))

const isPoints = Schema.is(Schema.toType(Schema.Array(SparklinePoint)))

/** Legacy caches the previews as `ReadonlyMap<metricName, points>`. */
export const sparklinesToCached = (sparklines: ReadonlyArray<MetricSparkline>) =>
	new Map(sparklines.map((sparkline) => [sparkline.metricName, sparkline.points]))

export const sparklinesFromCached = (value: CacheValue): Option.Option<ReadonlyArray<MetricSparkline>> => {
	if (!(value instanceof Map)) return Option.none()
	const entries = Array.fromIterable(value.entries()).map(([metricName, points]) =>
		typeof metricName === "string" && isPoints(points)
			? Option.some({ metricName, points })
			: Option.none(),
	)
	return Option.all(entries)
}
