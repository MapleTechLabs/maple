import { formatValue, type RangeUnit } from "./range-format"
import type { RangePreset } from "./range-filter-section"
import type { RangeBucket } from "./range-histogram"

/** One non-empty log bucket as the warehouse counts it: its floor, in the control's unit. */
export interface LogBucketCount {
	readonly floor: number
	readonly count: number
}

/** Share of sessions the axis must cover before the rest folds into one overflow bar. */
const AXIS_COVERAGE = 0.99

/** The full log-spaced run (empty buckets included) from the warehouse's non-empty ones. */
export const toLogBuckets = (
	raw: ReadonlyArray<LogBucketCount>,
	stepsPerOctave: number,
): ReadonlyArray<RangeBucket> => {
	const counts = new Map(
		raw
			.filter((item) => Number.isFinite(item.floor) && item.floor > 0)
			.map((item) => [Math.round(Math.log2(item.floor) * stepsPerOctave), item.count] as const),
	)
	if (counts.size === 0) return []
	const steps = [...counts.keys()]
	const low = Math.min(...steps)
	const buckets: ReadonlyArray<RangeBucket> = Array.from(
		{ length: Math.max(...steps) - low + 1 },
		(_, offset) => ({
			from: 2 ** ((low + offset) / stepsPerOctave),
			to: 2 ** ((low + offset + 1) / stepsPerOctave),
			count: counts.get(low + offset) ?? 0,
		}),
	)
	const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
	if (total === 0) return buckets
	const covering = buckets.findIndex(
		(_, index) =>
			buckets.slice(0, index + 1).reduce((sum, bucket) => sum + bucket.count, 0) >= total * AXIS_COVERAGE,
	)
	if (covering === -1) return buckets
	const tail = buckets.slice(covering + 1)
	const tailCount = tail.reduce((sum, bucket) => sum + bucket.count, 0)
	const head = buckets.slice(0, covering + 1)
	const firstTail = tail[0]
	return tailCount === 0 || firstTail === undefined
		? head
		: [...head, { from: firstTail.from, to: Number.POSITIVE_INFINITY, count: tailCount, unbounded: true }]
}

const MIN_THRESHOLD = { ms: 1, s: 1, count: 2, usd: 0.0001 } satisfies Record<RangeUnit, number>

const roundThreshold = (value: number, unit: RangeUnit): number => {
	if (unit === "s") return value < 60 ? Math.round(value) : Math.round(value / 60) * 60
	const rounded = Number(value.toPrecision(2))
	return unit === "count" ? Math.round(rounded) : rounded
}

/** "> p50" and "> p95" shortcuts, each carrying the threshold it resolves to. */
export const percentilePresets = (p50: number, p95: number, unit: RangeUnit): ReadonlyArray<RangePreset> =>
	(
		[
			["p50", p50],
			["p95", p95],
		] as const
	).reduce<ReadonlyArray<RangePreset>>((presets, [key, value]) => {
		const threshold = roundThreshold(value, unit)
		return threshold < MIN_THRESHOLD[unit] || presets.some((preset) => preset.min === threshold)
			? presets
			: [...presets, { key, label: `> ${key}`, value: formatValue(threshold, unit), min: threshold }]
	}, [])
