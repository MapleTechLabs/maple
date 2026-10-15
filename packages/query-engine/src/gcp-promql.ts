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

/**
 * The range request a widget's planned params make, for `GcpPromQlRangeRequest` to decode. The step
 * is the chart's own bucket for the window, never under Google's one minute.
 */
export const promQlRangeInput = (
	params: { readonly promql: string; readonly projects?: ReadonlyArray<string> | undefined },
	window: { readonly startTime: string; readonly endTime: string },
) => ({
	query: params.promql.trim(),
	startTime: window.startTime,
	endTime: window.endTime,
	stepSeconds: Math.max(
		GCP_PROMQL_MIN_STEP_SECONDS,
		computeBucketSecondsForRange(window.startTime, window.endTime),
	),
	...(params.projects === undefined ? undefined : { projects: params.projects }),
})

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

/**
 * An answer as widget data: the chart rows, and a one-line notice when some scopes could not be read.
 * Members get each scope and its cause; a share link gets only the count, no project ids or setup.
 */
export const promQlWidgetData = (
	result: {
		readonly series: ReadonlyArray<GcpPromQlSeries>
		readonly projects: ReadonlyArray<string>
		readonly failures: ReadonlyArray<GcpPromQlFailure>
	},
	legend: string | undefined,
	withCauses: boolean,
): { data: Array<Record<string, string | number>>; notice?: string } => {
	const data = promQlChartRows(result.series, result.projects.length, legend)
	const { failures } = result
	if (failures.length === 0) return { data }
	return {
		data,
		notice: withCauses
			? `Partial result. ${failures.map((failure) => `${failure.scope}: ${failure.message}`).join(" ")}`
			: `Partial result: ${failures.length === 1 ? "1 Google Cloud scope" : `${failures.length} Google Cloud scopes`} could not be read.`,
	}
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
