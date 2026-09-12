import {
	formatValue,
	type RangeBucket,
	type RangePreset,
	type RangeUnit,
} from "@maple/ui/components/filters/range-filter-section"

/** One non-empty log bucket as the warehouse counts it: its floor, already in
 *  the control's unit, and the sessions in it. */
export interface LogBucketCount {
	readonly floor: number
	readonly count: number
}

/** Share of sessions the axis must cover before the rest is folded into a single
 *  overflow bar. Real data has abandoned tabs measured in days; on a log axis one
 *  of those stretches the range past 500h and squashes every genuine session into
 *  the first few pixels. */
const AXIS_COVERAGE = 0.99

/**
 * The warehouse buckets a heavy-tailed measure on a log scale — `stepsPerOctave`
 * buckets per doubling, anchored at 1 in the control's unit — and returns only
 * the non-empty ones. Rebuild the full run so the histogram's axis stays
 * continuous instead of collapsing gaps into neighbouring bars. Each ceiling is
 * the next floor, so octave buckets over a count keep whole bounds.
 */
export function toLogBuckets(raw: ReadonlyArray<LogBucketCount>, stepsPerOctave: number): RangeBucket[] {
	const counts = new Map<number, number>()
	for (const item of raw) {
		if (!Number.isFinite(item.floor) || item.floor <= 0) continue
		counts.set(Math.round(Math.log2(item.floor) * stepsPerOctave), item.count)
	}
	if (counts.size === 0) return []

	const steps = [...counts.keys()]
	const buckets: RangeBucket[] = []
	for (let k = Math.min(...steps); k <= Math.max(...steps); k++) {
		buckets.push({
			from: 2 ** (k / stepsPerOctave),
			to: 2 ** ((k + 1) / stepsPerOctave),
			count: counts.get(k) ?? 0,
		})
	}

	// Keep the outliers visible as one unbounded bar at the right edge rather than
	// dropping them — they're real sessions, and folding them into the last kept
	// bucket would misreport it as a spike.
	const total = buckets.reduce((sum, b) => sum + b.count, 0)
	if (total === 0) return buckets
	let covered = 0
	for (const [index, bucket] of buckets.entries()) {
		covered += bucket.count
		if (covered < total * AXIS_COVERAGE) continue
		const tail = buckets.slice(index + 1)
		const tailCount = tail.reduce((sum, b) => sum + b.count, 0)
		if (tailCount === 0) return buckets.slice(0, index + 1)
		return [
			...buckets.slice(0, index + 1),
			{ from: tail[0]!.from, to: Number.POSITIVE_INFINITY, count: tailCount, unbounded: true },
		]
	}
	return buckets
}

/** The smallest threshold worth a shortcut. Under a second is noise; a count of
 *  1 is every session a count's histogram holds; a dollar amount below what
 *  `formatUsd` can show reads as "$0.0000". */
const MIN_THRESHOLD = { ms: 1, s: 1, count: 2, usd: 0.0001 } satisfies Record<RangeUnit, number>

/** A percentile lands on values like 2647s or 48213 tokens — precision no one
 *  asked for on a shortcut. Round durations to the minute above a minute, and
 *  everything else to two significant figures; a count stays whole, since the
 *  request schema rejects a fractional one. */
function roundThreshold(value: number, unit: RangeUnit): number {
	if (unit === "s") return value < 60 ? Math.round(value) : Math.round(value / 60) * 60
	const rounded = Number(value.toPrecision(2))
	return unit === "count" ? Math.round(rounded) : rounded
}

/**
 * "> p50" and "> p95" shortcuts, each carrying the threshold it resolves to —
 * the percentiles are this audience's own vocabulary. A threshold too small to
 * mean anything is skipped, and so is a p95 that rounds to the p50.
 */
export function percentilePresets(p50: number, p95: number, unit: RangeUnit): RangePreset[] {
	const presets: RangePreset[] = []
	for (const [key, value] of [
		["p50", p50],
		["p95", p95],
	] as const) {
		const threshold = roundThreshold(value, unit)
		if (threshold < MIN_THRESHOLD[unit] || presets.some((preset) => preset.min === threshold)) continue
		presets.push({ key, label: `> ${key}`, value: formatValue(threshold, unit), min: threshold })
	}
	return presets
}
