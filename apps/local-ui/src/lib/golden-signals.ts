import type { ChartWindow } from "./time"

/** One warehouse bucket of a service's entry-span signals. */
export interface GoldenSignalRow {
	readonly bucketMs: number
	readonly count: number
	readonly errorRate: number
	readonly p50Ms: number
	readonly p95Ms: number
	readonly p99Ms: number
	readonly apdexScore: number
}

/** One bucket, shaped for the @maple/ui service charts (a type alias, so it is a plot row). */
export type GoldenSignalPoint = {
	readonly bucket: string
	/** Entry spans in the bucket; the throughput chart turns it into a rate. */
	readonly throughput: number
	/** Same count: lets the charts drop an in-flight bucket nothing has reported into yet. */
	readonly totalCount: number
	readonly errorRate: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly apdexScore: number
}

/**
 * One point per bucket across the chart window. A bucket with no row is zero traffic,
 * so a quiet stretch reads as quiet, not as a gap; `totalCount: 0` marks it so the
 * charts can trim an empty in-flight bucket instead of plunging to zero at "now".
 */
export function fillGoldenSignals(
	rows: ReadonlyArray<GoldenSignalRow>,
	window: ChartWindow,
): ReadonlyArray<GoldenSignalPoint> {
	const byBucket = new Map(rows.map((row) => [row.bucketMs, row] as const))
	const stepMs = window.bucketSeconds * 1000
	const firstMs = Math.floor(window.startMs / stepMs) * stepMs
	const count = Math.max(0, Math.floor((window.endMs - firstMs) / stepMs) + 1)
	return Array.from({ length: count }, (_, i): GoldenSignalPoint => {
		const ms = firstMs + i * stepMs
		const row = byBucket.get(ms)
		return {
			bucket: new Date(ms).toISOString(),
			throughput: row?.count ?? 0,
			totalCount: row?.count ?? 0,
			errorRate: row?.errorRate ?? 0,
			p50LatencyMs: row?.p50Ms ?? 0,
			p95LatencyMs: row?.p95Ms ?? 0,
			p99LatencyMs: row?.p99Ms ?? 0,
			apdexScore: row?.apdexScore ?? 0,
		}
	})
}
