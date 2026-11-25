import {
	RETENTION_SIGNAL_DATASOURCES,
	RETENTION_SIGNALS,
	RETENTION_TIME_COLUMNS,
	type RetentionSignal,
} from "@maple/domain/retention"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { RetentionReadHorizon } from "@maple/backend/services/retention/RetentionService"
import type { ReadBound } from "./tinybird-jwt"

// Which datasources an org's read horizon bounds in its read token, and by which column.
//
// The raw tables come from the domain's retention model. Traces also have row-level
// projections, bounded the same way so the trace list never shows a trace whose detail is hidden.
//
// Aggregated rollups (hourly and minutely tables, `error_events`, `service_usage` and the like)
// are NOT bounded here: they keep their own periods until a later change.
//
// Only reads of the managed Tinybird warehouse run on this token. BYO ClickHouse orgs
// (`org_clickhouse_settings`) and env-level vanilla ClickHouse own their cluster: out of scope.

/** Row-level projections of `traces`, each with the column its own expiry is keyed on. */
export const TRACE_PROJECTION_TIME_COLUMNS = {
	trace_index: "Bucket",
	trace_list_mv: "Timestamp",
	service_map_spans: "Timestamp",
	service_map_children: "Timestamp",
	service_overview_spans: "Timestamp",
	ai_trace_index: "Timestamp",
	ai_crawler_requests: "Timestamp",
	scanner_requests: "Timestamp",
} as const satisfies Readonly<Record<string, string>>

/** `trace_index.Bucket` is the start of a `TRACE_BUCKET_EXPR` bucket: five minutes of spans. */
const TRACE_INDEX_BUCKET_MINUTES = 5

interface ReadHorizonTable {
	readonly datasource: string
	/** The signal whose read horizon bounds this datasource. */
	readonly signal: RetentionSignal
	readonly column: string
	/** Set where `column` is a bucket start, so a bucket the horizon cuts through is kept. */
	readonly bucketMinutes?: number
}

/** Every datasource a read horizon bounds: each signal's raw tables, then the trace projections. */
export const READ_HORIZON_TABLES: ReadonlyArray<ReadHorizonTable> = [
	...Arr.flatMap(RETENTION_SIGNALS, (signal) =>
		Arr.map(RETENTION_SIGNAL_DATASOURCES[signal], (datasource): ReadHorizonTable => ({
			datasource,
			signal,
			column: RETENTION_TIME_COLUMNS[datasource],
		})),
	),
	...Arr.map(Rec.toEntries(TRACE_PROJECTION_TIME_COLUMNS), ([datasource, column]): ReadHorizonTable => ({
		datasource,
		signal: "traces",
		column,
		// Trace detail seeks spans through the index: without the slack, spans still inside
		// the horizon would be unreachable for the last minutes of their bucket.
		...(datasource === "trace_index" ? { bucketMinutes: TRACE_INDEX_BUCKET_MINUTES } : undefined),
	})),
]

const NO_BOUNDS: ReadonlyMap<string, ReadBound> = new Map()

const isWholeDays = (days: number): boolean => Number.isSafeInteger(days) && days >= 1

/**
 * The bound per datasource, for the signals the organization set a period for. An organization
 * that set nothing gets none, so its token stays as it was. None at all when a period is not a
 * whole number of days: the filter is only ever built from an integer.
 */
export const readBoundsOf = (
	horizon: RetentionReadHorizon,
): Option.Option<ReadonlyMap<string, ReadBound>> => {
	if (horizon.configured.length === 0) return Option.some(NO_BOUNDS)
	if (!Arr.every(horizon.configured, (signal) => isWholeDays(horizon.days[signal]))) return Option.none()
	return Option.some(
		new Map(
			Arr.map(
				Arr.filter(READ_HORIZON_TABLES, (table) => Arr.contains(horizon.configured, table.signal)),
				(table) => [
					table.datasource,
					{
						column: table.column,
						days: horizon.days[table.signal],
						...(table.bucketMinutes === undefined
							? undefined
							: { bucketMinutes: table.bucketMinutes }),
					},
				],
			),
		),
	)
}

/** Changes whenever the bounds do, for the token cache key. Empty for an organization that set nothing. */
export const readHorizonKey = (horizon: RetentionReadHorizon): string =>
	Arr.join(
		Arr.map(horizon.configured, (signal) => `${signal}=${horizon.days[signal]}`),
		",",
	)
