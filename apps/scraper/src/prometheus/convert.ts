/**
 * Converts parsed Prometheus metric families into Tinybird NDJSON rows for
 * the `metrics_sum` / `metrics_gauge` / `metrics_histogram` datasources.
 *
 * The row keys mirror the jsonPaths declared in
 * `packages/domain/src/tinybird/datasources.ts` and the shape produced by the
 * Rust ingest gateway (`metric_common_row` in `apps/ingest/src/telemetry.rs`)
 * — the other writer to these tables.
 */
import type { PromMetricFamily, PromSample } from "./parser"

export interface ScrapeRowContext {
	readonly orgId: string
	readonly targetId: string
	readonly targetName: string
	/** `job` label and `service_name` column: target serviceName ?? name. */
	readonly serviceName: string
	/** `instance` label: host of the target URL. */
	readonly instance: string
	/** Extra labels configured on the target (parsed `labelsJson`). */
	readonly targetLabels: Readonly<Record<string, string>>
	readonly scrapeTimeMs: number
}

export interface ConvertedMetricRows {
	readonly sum: ReadonlyArray<Record<string, unknown>>
	readonly gauge: ReadonlyArray<Record<string, unknown>>
	readonly histogram: ReadonlyArray<Record<string, unknown>>
	/** Series dropped because a required component was NaN or incomplete. */
	readonly droppedSeriesCount: number
}

/** `dateTime64(9)` ingest shape: `YYYY-MM-DD HH:MM:SS.nnnnnnnnn`, UTC, no zone suffix. */
export const formatTimestampMs = (epochMs: number): string => {
	const iso = new Date(epochMs).toISOString() // YYYY-MM-DDTHH:mm:ss.sssZ
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000000`
}

/** OTLP "unknown start time" — matches the Rust gateway's zero-nanos fallback. */
export const EPOCH_TIMESTAMP = "1970-01-01 00:00:00.000000000"

/** Cumulative aggregation temporality (OTLP enum value). */
const CUMULATIVE = 2

/**
 * Target labels first, then scraped labels, then system labels last — user or
 * scrape-supplied `job`/`instance` must never override tenant attribution
 * (same defense the deleted SD endpoint applied).
 */
const mergeAttributes = (
	ctx: ScrapeRowContext,
	sampleLabels: Readonly<Record<string, string>>,
): Record<string, string> => ({
	...ctx.targetLabels,
	...sampleLabels,
	job: ctx.serviceName,
	instance: ctx.instance,
})

const commonRow = (
	ctx: ScrapeRowContext,
	family: PromMetricFamily,
	metricName: string,
	attributes: Record<string, string>,
	timestampMs: number | null,
): Record<string, unknown> => ({
	resource_attributes: {
		maple_org_id: ctx.orgId,
		maple_ingest_source: "prometheus-scrape",
		maple_ingest_key_type: "internal",
		maple_scrape_target_id: ctx.targetId,
		maple_scrape_target_name: ctx.targetName,
		"service.name": ctx.serviceName,
	},
	resource_schema_url: "",
	scope_name: "maple-prometheus-scraper",
	scope_version: "",
	scope_attributes: {},
	scope_schema_url: "",
	service_name: ctx.serviceName,
	metric_name: metricName,
	metric_description: family.help ?? "",
	metric_unit: family.unit ?? "",
	metric_attributes: attributes,
	start_timestamp: EPOCH_TIMESTAMP,
	timestamp: formatTimestampMs(timestampMs ?? ctx.scrapeTimeMs),
	flags: 0,
	exemplars_trace_id: [],
	exemplars_span_id: [],
	exemplars_timestamp: [],
	exemplars_value: [],
	exemplars_filtered_attributes: [],
})

/** Stable fingerprint of a label set, excluding histogram/summary component labels. */
const seriesKey = (labels: Readonly<Record<string, string>>, exclude: string): string =>
	JSON.stringify(
		Object.keys(labels)
			.filter((key) => key !== exclude)
			.sort()
			.map((key) => [key, labels[key]]),
	)

const withoutLabel = (labels: Readonly<Record<string, string>>, name: string): Record<string, string> => {
	const { [name]: _, ...rest } = labels
	return rest
}

interface HistogramSeries {
	labels: Record<string, string>
	buckets: Array<{ le: number; cumulative: number }>
	sum: number | null
	count: number | null
	timestampMs: number | null
}

const convertHistogramFamily = (
	family: PromMetricFamily,
	ctx: ScrapeRowContext,
	out: Array<Record<string, unknown>>,
): number => {
	const series = new Map<string, HistogramSeries>()
	let dropped = 0

	const seriesFor = (sample: PromSample): HistogramSeries => {
		const key = seriesKey(sample.labels, "le")
		let entry = series.get(key)
		if (!entry) {
			entry = {
				labels: withoutLabel(sample.labels, "le"),
				buckets: [],
				sum: null,
				count: null,
				timestampMs: sample.timestampMs,
			}
			series.set(key, entry)
		}
		return entry
	}

	for (const sample of family.samples) {
		if (sample.name === `${family.name}_bucket`) {
			const le = sample.labels.le === "+Inf" ? Number.POSITIVE_INFINITY : Number(sample.labels.le)
			if (sample.labels.le === undefined || Number.isNaN(le) || !Number.isFinite(sample.value)) {
				dropped++
				continue
			}
			seriesFor(sample).buckets.push({ le, cumulative: sample.value })
		} else if (sample.name === `${family.name}_sum`) {
			seriesFor(sample).sum = sample.value
		} else if (sample.name === `${family.name}_count`) {
			seriesFor(sample).count = sample.value
		}
		// A bare `family.name` sample inside a histogram family is malformed; ignore.
	}

	for (const entry of series.values()) {
		entry.buckets.sort((a, b) => a.le - b.le)

		const infBucket = entry.buckets.find((bucket) => bucket.le === Number.POSITIVE_INFINITY)
		const totalCount = entry.count ?? infBucket?.cumulative ?? null
		if (totalCount === null || !Number.isFinite(totalCount)) {
			dropped++
			continue
		}

		const finiteBuckets = entry.buckets.filter((bucket) => Number.isFinite(bucket.le))
		const explicitBounds = finiteBuckets.map((bucket) => bucket.le)

		// Prometheus buckets are cumulative; OTLP bucket_counts are per-bucket.
		// The +Inf bucket becomes the final entry, so
		// bucket_counts.length === explicit_bounds.length + 1.
		const bucketCounts: Array<number> = []
		let previous = 0
		for (const bucket of finiteBuckets) {
			bucketCounts.push(Math.max(0, bucket.cumulative - previous))
			previous = bucket.cumulative
		}
		bucketCounts.push(Math.max(0, totalCount - previous))

		out.push({
			...commonRow(ctx, family, family.name, mergeAttributes(ctx, entry.labels), entry.timestampMs),
			count: totalCount,
			sum: entry.sum !== null && Number.isFinite(entry.sum) ? entry.sum : 0,
			bucket_counts: bucketCounts,
			explicit_bounds: explicitBounds,
			min: null,
			max: null,
			aggregation_temporality: CUMULATIVE,
		})
	}

	return dropped
}

const convertSummaryFamily = (
	family: PromMetricFamily,
	ctx: ScrapeRowContext,
	sumOut: Array<Record<string, unknown>>,
	gaugeOut: Array<Record<string, unknown>>,
): number => {
	let dropped = 0
	for (const sample of family.samples) {
		const attributes = mergeAttributes(ctx, sample.labels)
		// JSON cannot carry NaN/Infinity (JSON.stringify emits null), so
		// non-finite values are dropped rather than corrupting the NDJSON batch.
		// NaN quantiles ("no observations yet") fall under this too.
		if (!Number.isFinite(sample.value)) {
			dropped++
			continue
		}
		if (sample.name === `${family.name}_sum` || sample.name === `${family.name}_count`) {
			sumOut.push({
				...commonRow(ctx, family, sample.name, attributes, sample.timestampMs),
				value: sample.value,
				aggregation_temporality: CUMULATIVE,
				// `_count` only increases; `_sum` can decrease with negative observations.
				is_monotonic: sample.name === `${family.name}_count`,
			})
		} else {
			gaugeOut.push({
				...commonRow(ctx, family, sample.name, attributes, sample.timestampMs),
				value: sample.value,
			})
		}
	}
	return dropped
}

export const convertFamiliesToRows = (
	families: ReadonlyArray<PromMetricFamily>,
	ctx: ScrapeRowContext,
): ConvertedMetricRows => {
	const sum: Array<Record<string, unknown>> = []
	const gauge: Array<Record<string, unknown>> = []
	const histogram: Array<Record<string, unknown>> = []
	let droppedSeriesCount = 0

	for (const family of families) {
		switch (family.type) {
			case "counter": {
				for (const sample of family.samples) {
					if (!Number.isFinite(sample.value)) {
						droppedSeriesCount++
						continue
					}
					sum.push({
						...commonRow(ctx, family, sample.name, mergeAttributes(ctx, sample.labels), sample.timestampMs),
						value: sample.value,
						aggregation_temporality: CUMULATIVE,
						is_monotonic: true,
					})
				}
				break
			}
			case "gauge":
			case "untyped": {
				for (const sample of family.samples) {
					// Non-finite values cannot be represented in JSON; drop the point.
					if (!Number.isFinite(sample.value)) {
						droppedSeriesCount++
						continue
					}
					gauge.push({
						...commonRow(ctx, family, sample.name, mergeAttributes(ctx, sample.labels), sample.timestampMs),
						value: sample.value,
					})
				}
				break
			}
			case "histogram": {
				droppedSeriesCount += convertHistogramFamily(family, ctx, histogram)
				break
			}
			case "summary": {
				droppedSeriesCount += convertSummaryFamily(family, ctx, sum, gauge)
				break
			}
		}
	}

	return { sum, gauge, histogram, droppedSeriesCount }
}
