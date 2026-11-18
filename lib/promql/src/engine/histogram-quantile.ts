import { Result } from "effect"
import { ensureUniqueLabelsets, type EvalError, labelsKey, makeLabels, METRIC_NAME } from "./labels"
import type { InstantVector, Labels, Sample } from "./types"
import { lookup } from "../lookup"

const BUCKET_LABEL = "le"
const SMALL_DELTA_TOLERANCE = 1e-12
const MIN_NORMAL = 2.2250738585072014e-308

export interface Bucket {
	readonly upperBound: number
	count: number
}

/** Go's strconv.ParseFloat for decimal input and the Inf/NaN spellings; undefined when it would fail. */
export const parseGoFloat = (text: string): number | undefined => {
	if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity
	if (/^nan$/i.test(text)) return Number.NaN
	if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return undefined
	return Number(text)
}

/** Prometheus' almost.Equal. */
const almostEqual = (a: number, b: number, epsilon: number): boolean => {
	if (Number.isNaN(a) && Number.isNaN(b)) return true
	if (a === b) return true
	const absSum = Math.abs(a) + Math.abs(b)
	const diff = Math.abs(a - b)
	if (a === 0 || b === 0 || absSum < MIN_NORMAL) return diff < epsilon * MIN_NORMAL
	return diff / Math.min(absSum, Number.MAX_VALUE) < epsilon
}

const sortByUpperBound = (input: ReadonlyArray<Bucket>): Bucket[] =>
	[...input].sort((a, b) => (a.upperBound < b.upperBound ? -1 : a.upperBound > b.upperBound ? 1 : 0))

const coalesce = (buckets: ReadonlyArray<Bucket>): Bucket[] => {
	const out: Bucket[] = []
	for (const b of buckets) {
		const last = out[out.length - 1]
		if (last !== undefined && last.upperBound === b.upperBound) last.count += b.count
		else out.push({ upperBound: b.upperBound, count: b.count })
	}
	return out
}

/** Prometheus' ensureMonotonicAndIgnoreSmallDeltas. */
const ensureMonotonic = (buckets: Bucket[]): void => {
	let prev = buckets[0]?.count ?? 0
	for (const bucket of buckets.slice(1)) {
		const curr = bucket.count
		if (curr === prev) continue
		if (almostEqual(prev, curr, SMALL_DELTA_TOLERANCE) || curr < prev) {
			bucket.count = prev
			continue
		}
		prev = curr
	}
}

/** Prometheus' BucketQuantile over classic buckets. */
export const bucketQuantile = (q: number, input: ReadonlyArray<Bucket>): number => {
	if (Number.isNaN(q)) return Number.NaN
	if (q < 0) return -Infinity
	if (q > 1) return Infinity
	const sorted = sortByUpperBound(input)
	if (sorted[sorted.length - 1]?.upperBound !== Infinity) return Number.NaN
	const buckets = coalesce(sorted)
	ensureMonotonic(buckets)
	if (buckets.length < 2) return Number.NaN
	const observations = buckets[buckets.length - 1]?.count ?? 0
	if (observations === 0) return Number.NaN
	let rank = q * observations
	// sort.Search over all but the +Inf bucket.
	let b = buckets.length - 1
	for (let i = 0; i < buckets.length - 1; i++) {
		if ((buckets[i]?.count ?? 0) >= rank) {
			b = i
			break
		}
	}
	const at = (i: number): Bucket => buckets[i] ?? { upperBound: Number.NaN, count: Number.NaN }
	if (b === buckets.length - 1) return at(buckets.length - 2).upperBound
	if (b === 0 && at(0).upperBound <= 0) return at(0).upperBound
	let bucketStart = 0
	let count = at(b).count
	if (b > 0) {
		bucketStart = at(b - 1).upperBound
		count -= at(b - 1).count
		rank -= at(b - 1).count
	}
	return bucketStart + (at(b).upperBound - bucketStart) * (rank / count)
}

interface MetricWithBuckets {
	readonly labels: Labels
	readonly buckets: Bucket[]
}

/** Prometheus' BucketFraction: the share of observations between `lower` and `upper`. */
export const bucketFraction = (lower: number, upper: number, input: ReadonlyArray<Bucket>): number => {
	const sorted = sortByUpperBound(input)
	if (sorted[sorted.length - 1]?.upperBound !== Infinity) return Number.NaN
	const buckets = coalesce(sorted)
	const count = buckets[buckets.length - 1]?.count ?? 0
	if (count === 0 || Number.isNaN(lower) || Number.isNaN(upper)) return Number.NaN
	if (lower >= upper) return 0
	let rank = 0
	let lowerRank: number | undefined
	let upperRank: number | undefined
	// As upstream Prometheus: positive buckets start at 0, and an infinite-width first bucket
	// contributes its whole count instead of interpolating Inf/Inf.
	const firstLowerBound = (buckets[0]?.upperBound ?? 0) <= 0 ? -Infinity : 0
	for (const [i, b] of buckets.entries()) {
		const lowerBound = i > 0 ? (buckets[i - 1]?.upperBound ?? -Infinity) : firstLowerBound
		const interpolate = (v: number) =>
			lowerBound === -Infinity
				? b.count
				: rank + ((b.count - rank) * (v - lowerBound)) / (b.upperBound - lowerBound)
		if (lowerRank === undefined && lowerBound >= lower) lowerRank = rank
		if (upperRank === undefined && lowerBound >= upper) upperRank = rank
		if (lowerRank !== undefined && upperRank !== undefined) break
		if (lowerRank === undefined && lowerBound < lower && b.upperBound > lower)
			lowerRank = interpolate(lower)
		if (upperRank === undefined && lowerBound < upper && b.upperBound > upper)
			upperRank = interpolate(upper)
		if (lowerRank !== undefined && upperRank !== undefined) break
		rank = b.count
	}
	const lo = lowerRank === undefined || lowerRank > count ? count : lowerRank
	const hi = upperRank === undefined || upperRank > count ? count : upperRank
	return (hi - lo) / count
}

/** Groups classic `le` buckets by every other label and reduces each group to one sample. */
export const classicHistogram = (
	vector: InstantVector,
	evalTimeMs: number,
	reduce: (buckets: ReadonlyArray<Bucket>) => number,
): Result.Result<InstantVector, EvalError> => {
	const groups = new Map<string, MetricWithBuckets>()
	for (const sample of vector) {
		const upperBound = parseGoFloat(lookup(sample.labels, BUCKET_LABEL) ?? "")
		if (upperBound === undefined || Number.isNaN(upperBound)) continue
		const rest = Object.entries(sample.labels).filter(([name]) => name !== BUCKET_LABEL)
		// Grouped by every label but `le`, metric name included, as in Prometheus' resetHistograms.
		const key = labelsKey(makeLabels(rest))
		let group = groups.get(key)
		if (group === undefined) {
			group = { labels: makeLabels(rest.filter(([name]) => name !== METRIC_NAME)), buckets: [] }
			groups.set(key, group)
		}
		group.buckets.push({ upperBound, count: sample.value })
	}
	const out: Sample[] = [...groups.values()].map((g) => ({
		labels: g.labels,
		value: reduce(g.buckets),
		t: evalTimeMs,
	}))
	return ensureUniqueLabelsets(out)
}

export const histogramQuantile = (phi: number, vector: InstantVector, evalTimeMs: number) =>
	classicHistogram(vector, evalTimeMs, (buckets) => bucketQuantile(phi, buckets))
