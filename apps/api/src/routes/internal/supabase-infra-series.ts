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
	maxConnections: 0,
	poolerClients: 0,
	authUsers: 0,
	authSamples: 0,
	postgrestPoolMax: 0,
	postgrestPoolInUse: 0,
	postgrestPoolWaiting: 0,
}

const RATE_ZEROS: Omit<SupabaseProjectRateSeriesOutput, "bucket"> = {
	// No counter samples in the bucket: gaps, not 0% busy, zero rates or 0% hits.
	cpu: null,
	commitsPerSecond: null,
	rollbacksPerSecond: null,
	cacheHitRatio: null,
	networkRxPerSecond: null,
	networkTxPerSecond: null,
	diskReadPerSecond: null,
	diskWritePerSecond: null,
}

export type SupabaseSeriesRow = Omit<SupabaseProjectGaugeSeriesOutput, "bucket"> &
	Omit<SupabaseProjectRateSeriesOutput, "bucket"> & { readonly bucket: string }

/** Every bucket either read has, in time order; a missing gauge half reads as zeros, a missing rate half as gaps. */
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
