import type { SupabaseApiTrafficBucket, SupabaseCallerMix, SupabaseTopQuery } from "@maple/domain/http"
import { formatPercent } from "@maple/ui/lib/format"
import type { SupabaseProjectTimeseriesRow } from "../model"

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
	const total = MIX_LABELS.reduce((sum, [key]) => sum + mix[key], 0)
	if (total <= 0) return ""
	return MIX_LABELS.filter(([key]) => mix[key] > 0)
		.toSorted((a, b) => mix[b[0]] - mix[a[0]])
		.slice(0, 3)
		.map(([key, label]) => `${label} ${formatPercent(mix[key] / total)}`)
		.join(" · ")
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
	buckets.map((bucket) => ({
		bucket: bucket.bucket,
		...Object.fromEntries(STATUS_CLASSES.map((status) => [status, countOf(bucket, status)])),
	}))

/** Each status class's share of the window's classified requests, for the legend. */
export const trafficShares = (
	buckets: ReadonlyArray<SupabaseApiTrafficBucket>,
): ReadonlyArray<Readonly<{ status: StatusClass; share: number }>> => {
	const totals = STATUS_CLASSES.map((status) => ({
		status,
		count: buckets.reduce((sum, bucket) => sum + countOf(bucket, status), 0),
	}))
	const total = totals.reduce((sum, entry) => sum + entry.count, 0)
	return totals.map(({ status, count }) => ({ status, share: total > 0 ? count / total : 0 }))
}

/** Each statement's share of the listed statements' total execution time. */
export const queryShares = (queries: ReadonlyArray<SupabaseTopQuery>): ReadonlyArray<number> => {
	const total = queries.reduce((sum, query) => sum + query.totalExecMs, 0)
	return queries.map((query) => (total > 0 ? query.totalExecMs / total : 0))
}

const last = <A>(values: ReadonlyArray<A>): A | undefined => values[values.length - 1]

/** The health strip's figures over the timeseries; `null` without any bucket. */
export const healthStrip = (rows: ReadonlyArray<Row>) => {
	const latest = last(rows)
	if (latest === undefined) return null
	const peakCpu = rows.reduce((best, row) => (row.cpu > best.cpu ? row : best), latest)
	const cacheHits = rows.flatMap((row) => (row.cacheHitRatio === null ? [] : [row.cacheHitRatio]))
	const sizes = rows.flatMap((row) => (row.dbSize > 0 ? [row.dbSize] : []))
	const limits = rows.flatMap((row) => (row.maxConnections === null ? [] : [row.maxConnections]))
	return {
		cpu: {
			avg: rows.reduce((sum, row) => sum + row.cpu, 0) / rows.length,
			peak: peakCpu.cpu,
			peakAt: peakCpu.bucket,
			spark: rows.map((row) => row.cpu),
		},
		memory: {
			used: latest.memoryAvg,
			total: latest.memoryTotal,
			spark: rows.map((row) => row.memoryAvg),
		},
		disk: { used: latest.diskUsed, size: latest.diskSize, spark: rows.map((row) => row.diskUsed) },
		connections: {
			current: latest.connectionsAvg,
			peak: rows.reduce((max, row) => Math.max(max, row.connectionsMax), 0),
			limit: last(limits) ?? null,
			pooler: latest.poolerClients,
			spark: rows.map((row) => row.connectionsAvg),
		},
		cacheHit: { ratio: last(cacheHits) ?? null, spark: cacheHits },
		dbSize: {
			bytes: last(sizes) ?? null,
			growth: sizes.length < 2 ? null : (last(sizes) ?? 0) - (sizes[0] ?? 0),
			spark: sizes,
		},
	}
}
export type HealthStrip = NonNullable<ReturnType<typeof healthStrip>>

/** The window's rollback share of all transactions; `null` with none. */
export const rollbackShare = (rows: ReadonlyArray<Row>): number | null => {
	const commits = rows.reduce((sum, row) => sum + row.commitsPerSecond, 0)
	const rollbacks = rows.reduce((sum, row) => sum + row.rollbacksPerSecond, 0)
	return commits + rollbacks > 0 ? rollbacks / (commits + rollbacks) : null
}
