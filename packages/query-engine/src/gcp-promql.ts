/**
 * Google Cloud PromQL answers, shaped for dashboard widgets. Pure, so the browser's server function
 * and the share API draw a PromQL widget from the same rows.
 */
import {
	GCP_PROMQL_MIN_STEP_SECONDS,
	type GcpMetricDescriptor,
	type GcpPromQlFailure,
	type GcpPromQlSeries,
} from "@maple/domain/http"
import { computeBucketSecondsForRange } from "./datetime"

/** A widget's step: the chart's own bucket for the window, never under Google's one minute. */
export const promQlStepSeconds = (startTime: string, endTime: string): number =>
	Math.max(GCP_PROMQL_MIN_STEP_SECONDS, computeBucketSecondsForRange(startTime, endTime))

const LEGEND_LABEL = /\{\{\s*([^{}\s]+)\s*\}\}/g

/**
 * The legend template filled from the labels (a missing label renders empty), or by default the
 * label set without `__name__`, and without `project_id` when a single project answered.
 */
const seriesKey = (
	labels: Readonly<Record<string, string>>,
	legend: string | undefined,
	oneProject: boolean,
): string => {
	if (legend !== undefined && legend.trim() !== "") {
		return legend.replace(LEGEND_LABEL, (_, name: string) => labels[name] ?? "")
	}
	const pairs = Object.entries(labels)
		.filter(([key]) => key !== "__name__" && !(oneProject && key === "project_id"))
		.sort(([a], [b]) => a.localeCompare(b))
	return pairs.length === 0 ? "value" : pairs.map(([key, value]) => `${key}=${value}`).join(", ")
}

/**
 * Series as the wide rows the time-series charts take, `{ bucket, [series]: value }`, one row per
 * timestamp in time order. A series with no point at a timestamp has no key in that row.
 */
export const promQlChartRows = (
	series: ReadonlyArray<GcpPromQlSeries>,
	projectCount: number,
	legend?: string,
): Array<Record<string, string | number>> => {
	const used = new Set<string>()
	const rows = new Map<number, Record<string, string | number>>()
	for (const one of series) {
		const base = seriesKey(one.labels, legend, projectCount <= 1)
		let key = base
		for (let n = 2; used.has(key); n++) key = `${base} (${n})`
		used.add(key)
		for (const [seconds, value] of one.points) {
			const row = rows.get(seconds) ?? { bucket: new Date(seconds * 1000).toISOString() }
			row[key] = value
			rows.set(seconds, row)
		}
	}
	return [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row)
}

/** One line for a partial answer. A share link names only the scopes, not the setup advice. */
export const promQlFailureNotice = (
	failures: ReadonlyArray<GcpPromQlFailure>,
	withCauses: boolean,
): string | undefined => {
	if (failures.length === 0) return undefined
	return withCauses
		? `Partial result. ${failures.map((failure) => `${failure.scope}: ${failure.message}`).join(" ")}`
		: `Partial result: ${failures.map((failure) => failure.scope).join(", ")} could not be read.`
}

/**
 * A query that runs as written for a metric picked from the metric search: a rate for DELTA and
 * CUMULATIVE metrics, an average for a GAUGE, the 95th percentile for a distribution's buckets.
 * Google refuses a selector without `monitored_resource` when the metric has several resource types.
 */
export const promQlStarterQuery = (metric: string, descriptor: GcpMetricDescriptor): string => {
	const [resource] = descriptor.monitoredResourceTypes
	const matcher = descriptor.monitoredResourceTypes.length > 1 ? `, monitored_resource="${resource}"` : ""
	const selector = (name: string) => `{"${name}"${matcher}}`
	const by = descriptor.labels[0] === undefined ? "" : ` by (${descriptor.labels[0].key})`
	if (descriptor.valueType === "DISTRIBUTION" && !/_(count|sum)$/u.test(metric)) {
		return `histogram_quantile(0.95, sum by (le) (rate(${selector(`${descriptor.type}_bucket`)}[5m])))`
	}
	if (descriptor.metricKind === "GAUGE") return `avg${by} (${selector(metric)})`
	return `sum${by} (rate(${selector(metric)}[5m]))`
}
