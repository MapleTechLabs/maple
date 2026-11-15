// Prometheus discovery answers (metric names, label names, metadata) derived from the metric
// catalog and the attribute rollups, so they never scan the raw metric tables. Pure.

import { Array as Arr, Order, String as Str } from "effect"
import type { PromqlMetadataRow } from "../ch/queries/promql"
import { normalizeLabelName } from "./labels"
import { type CatalogMetric, type OtelMetricType, promNamesOf, unitSuffix } from "./names"

const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(values), Order.String)

/** The first name of each component of a stored metric: the one a bare selector reads it by. */
const canonicalNamesOf = (metric: CatalogMetric): ReadonlyArray<string> =>
	Arr.map(
		Arr.dedupeWith(promNamesOf(metric), (a, b) => a.component === b.component),
		(name) => name.promName,
	)

/** Every metric name the catalog answers to by default, sorted. */
export const canonicalPromNames = (catalog: ReadonlyArray<CatalogMetric>): ReadonlyArray<string> =>
	sortedUnique(Arr.flatMap(catalog, canonicalNamesOf))

/** The raw attribute keys whose Prometheus label name is `name`. */
export const keysForLabel = (keys: ReadonlyArray<string>, name: string): ReadonlyArray<string> =>
	Arr.filter(keys, (key) => normalizeLabelName(key) === name)

/** Label names when no series selector narrows them: identity labels plus attribute keys. */
export const labelNamesFrom = (
	catalog: ReadonlyArray<CatalogMetric>,
	attributeKeys: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	if (catalog.length === 0) return []
	// `le` is left out: its values come from bucket bounds, which no rollup lists.
	return sortedUnique(["__name__", "job", ...Arr.map(attributeKeys, normalizeLabelName)])
}

export interface PrometheusMetadata {
	readonly type: "counter" | "gauge" | "histogram"
	readonly help: string
	readonly unit: string
}

const METRIC_TYPES: ReadonlySet<string> = new Set<OtelMetricType>([
	"sum",
	"gauge",
	"histogram",
	"exponential_histogram",
])

const isMetricType = (value: string): value is OtelMetricType => METRIC_TYPES.has(value)

/** Histograms are keyed by their family name, without the `_bucket`/`_count` series suffix. */
const familyName = (metric: CatalogMetric): string => {
	const [first] = canonicalNamesOf(metric)
	if (first === undefined) return metric.metricName
	if (metric.metricType === "sum" || metric.metricType === "gauge") return first
	return Str.replace(/_(bucket|count|sum)$/, "")(first)
}

const typeOf = (metric: CatalogMetric): PrometheusMetadata["type"] => {
	if (metric.metricType === "sum") return metric.isMonotonic ? "counter" : "gauge"
	return metric.metricType === "gauge" ? "gauge" : "histogram"
}

/** `/api/v1/metadata` data: one entry per metric family, keyed by its Prometheus name. */
export const prometheusMetadata = (
	rows: ReadonlyArray<PromqlMetadataRow>,
): ReadonlyMap<string, ReadonlyArray<PrometheusMetadata>> => {
	const out = new Map<string, ReadonlyArray<PrometheusMetadata>>()
	for (const row of rows) {
		if (!isMetricType(row.metricType)) continue
		const metric: CatalogMetric = {
			metricName: row.metricName,
			metricType: row.metricType,
			isMonotonic: row.isMonotonic > 0,
			unit: row.unit,
		}
		const name = familyName(metric)
		if (out.has(name)) continue
		const unit = Arr.join(unitSuffix(row.unit, metric.metricType), "_")
		out.set(name, [{ type: typeOf(metric), help: row.description, unit }])
	}
	return out
}
