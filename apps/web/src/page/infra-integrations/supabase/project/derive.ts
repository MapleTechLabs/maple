import type { SupabaseApiTrafficBucket, SupabaseCallerMix, SupabaseTopQuery } from "@maple/domain/http"
import { formatPercent } from "@maple/ui/lib/format"
import type { SupabaseProjectTimeseriesRow } from "../model"
import { Array as Arr, Record as Rec, Order } from "effect"

// The pure halves of the project page's panels.

type Row = SupabaseProjectTimeseriesRow

const MIX_LABELS: ReadonlyArray<readonly [keyof SupabaseCallerMix, string]> = [
	["rest", "REST"],
	["auth", "Auth"],
	["storage", "Storage"],
	["realtime", "Realtime"],
	["functions", "Functions"],
	["postgres", "Postgres"],
	["other", "Other"],
]

/** "REST 71% · Postgres 29%": a caller's products by share, largest first, at most three. */
export const callerMixText = (mix: SupabaseCallerMix): string => {
	const total = Arr.reduce(MIX_LABELS, 0, (sum, [key]) => sum + mix[key])
	if (total <= 0) return ""
	return Arr.join(
		Arr.map(
			Arr.sort(
				Arr.filter(MIX_LABELS, ([key]) => mix[key] > 0),
				Order.flip(Order.mapInput(Order.Number, ([key]: (typeof MIX_LABELS)[number]) => mix[key])),
			).slice(0, 3),
			([key, label]) => `${label} ${formatPercent(mix[key] / total)}`,
		),
		" · ",
	)
}

export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const
export type StatusClass = (typeof STATUS_CLASSES)[number]

const countOf = (bucket: SupabaseApiTrafficBucket, status: StatusClass): number =>
	status === "2xx"
		? bucket.status2xx
		: status === "3xx"
			? bucket.status3xx
			: status === "4xx"
				? bucket.status4xx
				: bucket.status5xx

/** The stacked bars' rows: one per bucket, a column per status class. */
export const trafficRows = (buckets: ReadonlyArray<SupabaseApiTrafficBucket>) =>
	Arr.map(buckets, (bucket) => ({
		bucket: bucket.bucket,
		...Rec.fromEntries(Arr.map(STATUS_CLASSES, (status) => [status, countOf(bucket, status)])),
	}))

/** Each status class's share of the window's classified requests, for the legend. */
export const trafficShares = (
	buckets: ReadonlyArray<SupabaseApiTrafficBucket>,
): ReadonlyArray<Readonly<{ status: StatusClass; share: number }>> => {
	const totals = Arr.map(STATUS_CLASSES, (status) => ({
		status,
		count: Arr.reduce(buckets, 0, (sum, bucket) => sum + countOf(bucket, status)),
	}))
	const total = Arr.reduce(totals, 0, (sum, entry) => sum + entry.count)
	return Arr.map(totals, ({ status, count }) => ({ status, share: total > 0 ? count / total : 0 }))
}

/** Each statement's share of the listed statements' total execution time. */
export const queryShares = (queries: ReadonlyArray<SupabaseTopQuery>): ReadonlyArray<number> => {
	const total = Arr.reduce(queries, 0, (sum, query) => sum + query.totalExecMs)
	return Arr.map(queries, (query) => (total > 0 ? query.totalExecMs / total : 0))
}

const last = <A>(values: ReadonlyArray<A>): A | undefined => values[values.length - 1]

/** The health strip's figures over the timeseries; `null` without any bucket. */
export const healthStrip = (rows: ReadonlyArray<Row>) => {
	const latest = last(rows)
	if (latest === undefined) return null
	const cpuSamples = Arr.flatMap(rows, (row) =>
		row.cpu === null ? [] : [{ bucket: row.bucket, cpu: row.cpu }],
	)
	const peakCpu = Arr.reduce<(typeof cpuSamples)[number], (typeof cpuSamples)[number] | null>(
		cpuSamples,
		null,
		(best, sample) => (best === null || sample.cpu > best.cpu ? sample : best),
	)
	const cacheHits = Arr.flatMap(rows, (row) => (row.cacheHitRatio === null ? [] : [row.cacheHitRatio]))
	const sizes = Arr.flatMap(rows, (row) => (row.dbSize > 0 ? [row.dbSize] : []))
	const limits = Arr.flatMap(rows, (row) => (row.maxConnections === null ? [] : [row.maxConnections]))
	return {
		cpu: {
			/** `null` when no bucket had CPU increments. */
			avg:
				cpuSamples.length === 0
					? null
					: Arr.reduce(cpuSamples, 0, (sum, sample) => sum + sample.cpu) / cpuSamples.length,
			peak: peakCpu,
			spark: Arr.map(rows, (row) => ({ bucket: row.bucket, value: row.cpu })),
		},
		memory: {
			used: latest.memoryAvg,
			total: latest.memoryTotal,
			spark: Arr.map(rows, (row) => ({
				bucket: row.bucket,
				value: row.memoryTotal > 0 ? row.memoryAvg : null,
			})),
		},
		disk: {
			used: latest.diskUsed,
			size: latest.diskSize,
			spark: Arr.map(rows, (row) => ({
				bucket: row.bucket,
				value: row.diskSize > 0 ? row.diskUsed : null,
			})),
		},
		connections: {
			current: latest.connectionsAvg,
			peak: Arr.reduce(rows, 0, (max, row) => Math.max(max, row.connectionsMax)),
			limit: last(limits) ?? null,
			pooler: latest.poolerClients,
			spark: Arr.map(rows, (row) => ({ bucket: row.bucket, value: row.connectionsAvg })),
		},
		cacheHit: {
			ratio: last(cacheHits) ?? null,
			spark: Arr.map(rows, (row) => ({ bucket: row.bucket, value: row.cacheHitRatio })),
		},
		dbSize: {
			bytes: last(sizes) ?? null,
			growth: sizes.length < 2 ? null : (last(sizes) ?? 0) - (sizes[0] ?? 0),
			spark: Arr.map(rows, (row) => ({
				bucket: row.bucket,
				value: row.dbSize > 0 ? row.dbSize : null,
			})),
		},
	}
}
export type HealthStrip = NonNullable<ReturnType<typeof healthStrip>>

/** The window's rollback share of all transactions; `null` with none. */
export const rollbackShare = (rows: ReadonlyArray<Row>): number | null => {
	const commits = Arr.reduce(rows, 0, (sum, row) => sum + (row.commitsPerSecond ?? 0))
	const rollbacks = Arr.reduce(rows, 0, (sum, row) => sum + (row.rollbacksPerSecond ?? 0))
	return commits + rollbacks > 0 ? rollbacks / (commits + rollbacks) : null
}
