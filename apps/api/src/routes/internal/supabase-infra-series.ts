import type {
	SupabaseProjectGaugeSeriesOutput,
	SupabaseProjectRateSeriesOutput,
} from "@maple/query-engine-integrations"
import { DateTime } from "effect"

// /infra/supabase/$ref: the gauge and counter-rate reads, joined on their bucket.

const GAUGE_ZEROS: Omit<SupabaseProjectGaugeSeriesOutput, "bucket"> = {
	memoryAvg: 0,
	memoryMax: 0,
	memoryTotal: 0,
	diskUsed: 0,
	diskSize: 0,
	dbSize: 0,
	connectionsAvg: 0,
	connectionsMax: 0,
	poolerClients: 0,
	poolerWaiting: 0,
	authUsers: 0,
	authSamples: 0,
	realtimeSubscriptions: 0,
	postgrestPoolMax: 0,
	postgrestPoolInUse: 0,
	postgrestPoolWaiting: 0,
}

const RATE_ZEROS: Omit<SupabaseProjectRateSeriesOutput, "bucket"> = {
	cpu: 0,
	commitsPerSecond: 0,
	rollbacksPerSecond: 0,
	cacheHitRatio: 0,
	cacheReads: 0,
	deadlocks: 0,
	networkRxPerSecond: 0,
	networkTxPerSecond: 0,
	diskReadPerSecond: 0,
	diskWritePerSecond: 0,
}

export type SupabaseSeriesRow = Omit<SupabaseProjectGaugeSeriesOutput, "bucket"> &
	Omit<SupabaseProjectRateSeriesOutput, "bucket"> & { readonly bucket: string }

/** Every bucket either read has, in time order; the half a bucket lacks reads as zeros. */
export const mergeSupabaseSeries = (
	gauges: ReadonlyArray<SupabaseProjectGaugeSeriesOutput>,
	rates: ReadonlyArray<SupabaseProjectRateSeriesOutput>,
): Array<SupabaseSeriesRow> => {
	const gaugeByBucket = new Map(gauges.map(({ bucket, ...row }) => [DateTime.formatIso(bucket), row]))
	const rateByBucket = new Map(rates.map(({ bucket, ...row }) => [DateTime.formatIso(bucket), row]))
	const buckets = [...new Set([...gaugeByBucket.keys(), ...rateByBucket.keys()])].sort()
	return buckets.map((bucket) => ({
		...GAUGE_ZEROS,
		...gaugeByBucket.get(bucket),
		...RATE_ZEROS,
		...rateByBucket.get(bucket),
		bucket,
	}))
}
