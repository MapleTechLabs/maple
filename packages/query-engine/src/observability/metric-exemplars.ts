import { Array as Arr, DateTime, Effect, Order, Schema } from "effect"
import { type AttributeFilter, MetricType } from "@maple/domain/query-engine"
import * as CH from "../ch"
import { formatWarehouseDateTimeMs } from "../datetime"
import { WarehouseExecutor, type WarehouseExecutorError } from "./WarehouseExecutor"
import type { TimeRange } from "./types"

export interface MetricExemplarsInput {
	readonly metricName: string
	/** Looked up in the metric catalog when omitted. */
	readonly metricType?: MetricType
	readonly service?: string
	readonly environment?: string
	/** Predicates on the datapoint Attributes map (metric labels). */
	readonly attributeFilters?: ReadonlyArray<AttributeFilter>
	readonly timeRange: TimeRange
	readonly bucketSeconds: number
	readonly perBucket?: number
	readonly limit?: number
}

/** One exemplar: the trace and span an SDK sampled while recording `value`. */
export interface MetricExemplar {
	/** Start of the time bucket it was ranked in, `YYYY-MM-DD HH:mm:ss.mmm` UTC. */
	readonly bucket: string
	/** When the value was recorded, same format. */
	readonly timestamp: string
	readonly value: number
	readonly traceId: string
	readonly spanId: string
	readonly serviceName: string
}

/** The exemplars of a found metric, or the catalog names that matched when it was not found. */
export type MetricExemplarsResult =
	| {
			readonly _tag: "found"
			readonly metricType: MetricType
			readonly exemplars: ReadonlyArray<MetricExemplar>
	  }
	| { readonly _tag: "missing"; readonly similar: ReadonlyArray<string> }

const isMetricType = Schema.is(MetricType)

// Histograms carry most exemplars (latency), so a name recorded as several types reads as one.
const typePreference = (type: MetricType): number =>
	type === "histogram" ? 0 : type === "exponential_histogram" ? 1 : 2

const formatTime = (value: DateTime.Utc): string => formatWarehouseDateTimeMs(DateTime.toEpochMillis(value))

/**
 * A metric's exemplars in range, highest value first, at most `perBucket` per time bucket so
 * one spike cannot crowd out the rest of the window.
 */
export const metricExemplars = Effect.fn("Observability.metricExemplars")(function* (
	input: MetricExemplarsInput,
) {
	const executor = yield* WarehouseExecutor
	const window = {
		orgId: executor.orgId,
		startTime: input.timeRange.startTime,
		endTime: input.timeRange.endTime,
	}
	yield* Effect.annotateCurrentSpan({
		"maple.query.metric_name": input.metricName,
		"maple.query.service": input.service ?? "all",
	})

	// One name has a row per (type, service); the exact read takes them all, suggestions only a few.
	const catalogRows = (match: { readonly exactName: string } | { readonly search: string }) =>
		executor.compiledQuery(
			CH.compile(
				CH.listMetricsQuery({
					...match,
					...(input.service === undefined ? undefined : { serviceName: input.service }),
					limit: "exactName" in match ? 1000 : 50,
				}),
				window,
			),
			{ profile: "discovery", context: "metricExemplars.catalog" },
		)

	const readFor = (metricType: MetricType) =>
		executor.compiledQuery(
			CH.compile(
				CH.metricExemplarsQuery({
					metricType,
					...(input.service === undefined ? undefined : { serviceName: input.service }),
					...(input.environment === undefined ? undefined : { environments: [input.environment] }),
					...(input.attributeFilters === undefined || input.attributeFilters.length === 0
						? undefined
						: { attributeFilters: input.attributeFilters }),
					...(input.perBucket === undefined ? undefined : { perBucket: input.perBucket }),
					...(input.limit === undefined ? undefined : { limit: input.limit }),
				}),
				{ ...window, metricName: input.metricName, bucketSeconds: input.bucketSeconds },
			),
			{ profile: "list", context: "metricExemplars" },
		)

	// A name recorded as several types (one environment moved to exponential histograms) is read
	// type by type, preferred first, until one has exemplars under the filters.
	type Read = Effect.Success<ReturnType<typeof readFor>>
	const firstWithExemplars = (
		types: Arr.NonEmptyReadonlyArray<MetricType>,
	): Effect.Effect<{ readonly metricType: MetricType; readonly rows: Read }, WarehouseExecutorError> => {
		const [first, ...rest] = types
		return Effect.flatMap(readFor(first), (rows) =>
			rows.length > 0 || !Arr.isReadonlyArrayNonEmpty(rest)
				? Effect.succeed({ metricType: first, rows })
				: firstWithExemplars(rest),
		)
	}

	const exact = input.metricType === undefined ? yield* catalogRows({ exactName: input.metricName }) : []
	const candidates: ReadonlyArray<MetricType> =
		input.metricType !== undefined
			? [input.metricType]
			: Arr.sort(
					Arr.dedupe(
						Arr.filter(
							Arr.map(
								Arr.filter(exact, (row) => row.metricName === input.metricName),
								(row) => row.metricType,
							),
							isMetricType,
						),
					),
					Order.mapInput(Order.Number, typePreference),
				)
	if (!Arr.isReadonlyArrayNonEmpty(candidates)) {
		const similar = yield* catalogRows({ search: input.metricName })
		return {
			_tag: "missing",
			similar: Arr.dedupe(Arr.map(similar, (row) => row.metricName)),
		} satisfies MetricExemplarsResult
	}

	const { metricType, rows } = yield* firstWithExemplars(candidates)
	yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
	return {
		_tag: "found",
		metricType,
		exemplars: Arr.map(rows, (row): MetricExemplar => ({
			bucket: formatTime(row.bucket),
			timestamp: formatTime(row.timestamp),
			value: row.value,
			traceId: row.traceId,
			spanId: row.spanId,
			serviceName: row.serviceName,
		})),
	} satisfies MetricExemplarsResult
})
