/**
 * Delta reconciliation — the piece that makes a revisable source safe to write into an
 * append-only warehouse.
 *
 * `metrics_sum` is a plain MergeTree with no dedupe, and GA4 keeps revising `dateHour` rows for
 * ~48h after the fact. Re-polling an hour and writing the new value again would leave two rows at
 * the same timestamp, and every reducer would then read wrong: `sum` double-counts, `avg` blends
 * stale with fresh, `max` breaks on a downward revision.
 *
 * So nothing is ever written as an absolute value. Each series remembers what it has already
 * emitted for a bucket (the ledger), and a re-poll emits only the DIFFERENCE. `sum(Value)` per
 * bucket is then exactly GA4's current answer, by construction, no matter how many times the hour
 * is revisited — and a downward revision is simply a negative delta. This is what
 * `AggregationTemporality = 1` (DELTA) means, and it is why these rows are emitted with
 * `is_monotonic: false`: the corrections are genuinely allowed to be negative.
 *
 * Chart these metrics with `sum`. Never `rate` or `increase` — those assume cumulative
 * temporality and would double-difference the data (see
 * `packages/query-engine/src/query-builder/model.ts`).
 */
import { Option, Schema } from "effect"
import { fmtMetricTs, type MetricAttrs, type MetricSumRow } from "@/services/warehouse/metric-rows"
import type { GaDatasetDef } from "./datasets"
import { SCOPE_NAME, serviceNameFor } from "./datasets"
import { type GaSeriesPoint, seriesKey } from "./mapping"

/** What has already been emitted for one (property, dataset, bucket): seriesKey → value. */
export interface LedgerBucket {
	readonly bucketMs: number
	readonly emitted: Readonly<Record<string, number>>
}

export interface ReconcileResult {
	/** DELTA rows to ship. Series whose value is unchanged produce nothing. */
	readonly rows: ReadonlyArray<MetricSumRow>
	/** Ledger buckets to persist. A bucket that ends up empty is flagged for deletion. */
	readonly ledger: ReadonlyArray<LedgerBucket>
}

/**
 * Parse a stored ledger blob. A corrupt or non-object blob decodes to "nothing emitted yet",
 * which re-emits the bucket's full current value — a visible double-count in one hour, versus
 * silently freezing that hour forever if we treated the failure as "already up to date".
 */
const LedgerBlob = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeLedgerBlob = Schema.decodeUnknownOption(LedgerBlob)
const decodeEmittedValue = Schema.decodeUnknownOption(Schema.Finite)

export const parseLedger = (json: string | null | undefined): Readonly<Record<string, number>> => {
	if (json == null || json === "") return {}
	const blob = Option.getOrNull(decodeLedgerBlob(json))
	if (blob === null) return {}
	// Filtered per key rather than validated as a whole: the blob is a map of INDEPENDENT series,
	// so one unreadable entry should cost that series a re-emission, not force every other series
	// in the hour to be re-emitted alongside it.
	const emitted: Record<string, number> = {}
	for (const [key, value] of Object.entries(blob)) {
		const parsed = decodeEmittedValue(value)
		if (Option.isSome(parsed)) emitted[key] = parsed.value
	}
	return emitted
}

export const serializeLedger = (emitted: Readonly<Record<string, number>>): string => JSON.stringify(emitted)

const resourceAttributes = (options: {
	readonly orgId: string
	readonly propertyId: string
	readonly propertyName: string | null
	readonly accountName: string | null
}): MetricAttrs => {
	const attributes: MetricAttrs = {
		maple_org_id: options.orgId,
		"service.name": serviceNameFor(options.propertyId),
		"google_analytics.property.id": options.propertyId,
	}
	// Display names are absent until discovery has named the property; an empty-string attribute
	// would read as "named, blank" everywhere downstream.
	if (options.propertyName != null) attributes["google_analytics.property.name"] = options.propertyName
	if (options.accountName != null) attributes["google_analytics.account.name"] = options.accountName
	return attributes
}

/**
 * Reconcile one dataset's freshly-polled points against the ledger.
 *
 * `coveredFromMs`/`coveredToMs` bound the half-open range the report actually asked GA4 about.
 * They are what make the "series disappeared" case safe: inside the window, a series present in
 * the ledger but absent from the response has genuinely gone to zero (revised away, or folded
 * into `other` as top-N membership shifted) and must be zeroed out with a negative delta, or its
 * old value would linger in the bucket's sum forever. Outside the window we know nothing, so
 * those buckets are passed through untouched.
 */
export const reconcile = (options: {
	readonly orgId: string
	readonly propertyId: string
	readonly propertyName: string | null
	readonly accountName: string | null
	readonly dataset: GaDatasetDef
	readonly points: ReadonlyArray<GaSeriesPoint>
	readonly ledger: ReadonlyArray<LedgerBucket>
	readonly coveredFromMs: number
	readonly coveredToMs: number
}): ReconcileResult => {
	const { points, coveredFromMs, coveredToMs } = options
	const resource = resourceAttributes(options)
	const serviceName = serviceNameFor(options.propertyId)

	const ledgerByBucket = new Map(options.ledger.map((bucket) => [bucket.bucketMs, bucket.emitted]))

	// Group the freshly-polled points by bucket so each bucket is reconciled as a unit — the
	// disappeared-series check below is only sound against a bucket's complete new picture.
	const freshByBucket = new Map<number, Map<string, GaSeriesPoint>>()
	for (const point of points) {
		if (point.bucketMs < coveredFromMs || point.bucketMs >= coveredToMs) continue
		let bucket = freshByBucket.get(point.bucketMs)
		if (bucket === undefined) {
			bucket = new Map()
			freshByBucket.set(point.bucketMs, bucket)
		}
		bucket.set(seriesKey(point.metric.metric, point.attributes), point)
	}

	// A covered bucket the report said nothing about is still covered: GA4 was asked and answered
	// "nothing here". Seeding it empty is what lets the retraction pass below zero it out — without
	// this, an hour revised away entirely (or a breakdown that stopped receiving traffic) would
	// keep its last value in the warehouse forever, since no fresh point would ever name it again.
	for (const bucket of options.ledger) {
		if (bucket.bucketMs < coveredFromMs || bucket.bucketMs >= coveredToMs) continue
		if (!freshByBucket.has(bucket.bucketMs)) freshByBucket.set(bucket.bucketMs, new Map())
	}

	const rows: Array<MetricSumRow> = []
	const nextLedger: Array<LedgerBucket> = []

	const emit = (bucketMs: number, point: GaSeriesPoint, delta: number) => {
		const ts = fmtMetricTs(bucketMs)
		rows.push({
			timestamp: ts,
			start_timestamp: ts,
			metric_name: point.metric.metric,
			metric_description: point.metric.description,
			metric_unit: point.metric.unit,
			metric_attributes: point.attributes,
			service_name: serviceName,
			resource_schema_url: "",
			resource_attributes: resource,
			scope_schema_url: "",
			scope_name: SCOPE_NAME,
			scope_version: "",
			scope_attributes: {},
			value: delta,
			flags: 0,
			exemplars_trace_id: [],
			exemplars_span_id: [],
			exemplars_timestamp: [],
			exemplars_value: [],
			exemplars_filtered_attributes: [],
			// DELTA. Each row is an increment for its hour, not a running total.
			aggregation_temporality: 1,
			// A correction may be negative, so this sum is explicitly non-monotonic. It also keeps
			// these rows out of the cumulative rate path, which selects on `IsMonotonic = 1`.
			is_monotonic: false,
		})
	}

	// Buckets the poll covered: emit the difference for every series, in either direction.
	for (const [bucketMs, fresh] of freshByBucket) {
		const previous = ledgerByBucket.get(bucketMs) ?? {}
		const emitted: Record<string, number> = {}

		for (const [key, point] of fresh) {
			const delta = point.value - (previous[key] ?? 0)
			if (delta !== 0) emit(bucketMs, point, delta)
			// Zero-valued series are dropped from the ledger rather than recorded as 0: keeping
			// them would grow the blob with every path that ever appeared once.
			if (point.value !== 0) emitted[key] = point.value
		}

		for (const [key, previousValue] of Object.entries(previous)) {
			if (fresh.has(key) || previousValue === 0) continue
			// Gone from the report, so it is now zero. Reconstruct just enough of the series to
			// emit the retraction.
			const series = parseSeriesKey(key, options.dataset)
			if (series === null) continue
			emit(bucketMs, { bucketMs, metric: series.metric, attributes: series.attributes, value: 0 }, -previousValue)
		}

		nextLedger.push({ bucketMs, emitted })
	}

	// Buckets outside the covered window are left exactly as they were.
	for (const bucket of options.ledger) {
		if (!freshByBucket.has(bucket.bucketMs)) nextLedger.push(bucket)
	}

	return { rows, ledger: nextLedger }
}

/**
 * Inverse of {@link seriesKey} for the retraction path.
 *
 * Not a general parser, and it must not become one: it works because a dataset has at most ONE
 * breakdown, so the key is exactly `"<metric> <attributeKey>=<value>"` and the value is
 * everything after the first `=` following a known attribute key. Splitting on whitespace instead
 * would corrupt every value that contains a space — `sessionDefaultChannelGroup` alone yields
 * "Organic Search", "Paid Social", "Cross-network".
 *
 * Returns null when the key does not belong to this dataset (a stale blob written by an older
 * registry), which drops the retraction rather than emitting it against a guessed series.
 */
const parseSeriesKey = (
	key: string,
	dataset: GaDatasetDef,
): { readonly metric: GaDatasetDef["metrics"][number]; readonly attributes: Record<string, string> } | null => {
	// Longest first: within a dataset one metric name can prefix another
	// (`…page_views` vs `…page_views.by_page`), and the shorter would match wrongly.
	const candidates = [...dataset.metrics].sort((a, b) => b.metric.length - a.metric.length)
	for (const metric of candidates) {
		if (!key.startsWith(metric.metric)) continue
		const rest = key.slice(metric.metric.length)
		if (rest === "") return { metric, attributes: {} }
		const breakdown = dataset.breakdown
		if (breakdown === null) continue
		const prefix = ` ${breakdown.attributeKey}=`
		if (!rest.startsWith(prefix)) continue
		return { metric, attributes: { [breakdown.attributeKey]: rest.slice(prefix.length) } }
	}
	return null
}
