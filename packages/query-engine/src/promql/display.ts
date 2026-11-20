// A stored metric's PromQL names and a starter query, for pages and tools that list metrics. Pure.

import { print } from "@maple/promql"
import { Array as Arr, Option, String as Str } from "effect"
import { type CatalogMetric, type OtelMetricType, promNamesOf } from "./names"

/** A metric as list views carry it: the type is any string, the unit may be missing. */
export interface ListedMetric {
	readonly metricName: string
	readonly metricType: string
	readonly isMonotonic: boolean
	readonly unit: string | null | undefined
}

const OTEL_TYPES: ReadonlyArray<OtelMetricType> = ["sum", "gauge", "histogram", "exponential_histogram"]

const asCatalog = (metric: ListedMetric): Option.Option<CatalogMetric> =>
	Option.map(
		Arr.findFirst(OTEL_TYPES, (type) => type === metric.metricType),
		(metricType) => ({
			metricName: metric.metricName,
			metricType,
			isMonotonic: metric.isMonotonic,
			unit: metric.unit ?? "",
		}),
	)

/** The name a bare selector reads each component by (`_bucket`, `_count`, `_sum` for a histogram). */
export const promqlNamesFor = (metric: ListedMetric): ReadonlyArray<string> =>
	Option.match(asCatalog(metric), {
		onNone: () => [],
		onSome: (catalog) =>
			Arr.map(
				Arr.dedupeWith(promNamesOf(catalog), (a, b) => a.component === b.component),
				(name) => name.promName,
			),
	})

/** A selector for `name` as the printer spells it: `{"NaN"}` where a bare name would parse as a number. */
const selectorOf = (name: string): string =>
	print({
		type: "VectorSelector",
		name,
		matchers: [{ name: "__name__", op: "=", value: name }],
		offsetMs: 0,
		at: undefined,
	})

/** A query to start from: a rate for counters, the p95 for histograms, the value for gauges. */
export const examplePromqlFor = (metric: ListedMetric): string | undefined => {
	const names = Arr.map(promqlNamesFor(metric), selectorOf)
	const [first] = names
	if (first === undefined) return undefined
	switch (metric.metricType) {
		case "histogram":
			return `histogram_quantile(0.95, sum by (le) (rate(${first}[5m])))`
		case "exponential_histogram": {
			const sum = Arr.findFirst(names, Str.endsWith("_sum"))
			const count = Arr.findFirst(names, Str.endsWith("_count"))
			return Option.isSome(sum) && Option.isSome(count)
				? `sum(rate(${sum.value}[5m])) / sum(rate(${count.value}[5m]))`
				: undefined
		}
		case "sum":
			return metric.isMonotonic ? `sum by (job) (rate(${first}[5m]))` : `sum by (job) (${first})`
		default:
			return `avg by (job) (${first})`
	}
}
