import { kahanInc, quantile } from "./aggregate"
import type { SampleBucket } from "./types"

// quantile_over_time shares the aggregation's quantile, so both read infinities the same way.
export { quantile }

/** Index of the first bucket whose `end` is greater than `t` (buckets sorted by `end`). */
const upperBound = (buckets: ReadonlyArray<SampleBucket>, t: number): number => {
	let lo = 0
	let hi = buckets.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if ((buckets[mid]?.end ?? Number.POSITIVE_INFINITY) <= t) lo = mid + 1
		else hi = mid
	}
	return lo
}

/**
 * The buckets of one window `(fromMs, toMs]`. Buckets are aligned with window
 * edges, so a bucket belongs to the window when its `end` does.
 */
export interface Window {
	readonly buckets: ReadonlyArray<SampleBucket>
	readonly from: number
	readonly to: number
	readonly fromMs: number
	readonly toMs: number
}

export const windowOf = (buckets: ReadonlyArray<SampleBucket>, fromMs: number, toMs: number): Window => ({
	buckets,
	from: upperBound(buckets, fromMs),
	to: upperBound(buckets, toMs),
	fromMs,
	toMs,
})

const isEmpty = (w: Window): boolean => w.to <= w.from

const at = (w: Window, index: number): SampleBucket | undefined => w.buckets[index]

export const sampleCount = (w: Window): number => {
	let n = 0
	for (let i = w.from; i < w.to; i++) n += at(w, i)?.count ?? 0
	return n
}

const counterDelta = (previous: number, current: number): number =>
	current < previous ? current : current - previous

interface PairTotals {
	readonly increase: number
	readonly resets: number
	readonly changes: number
}

/** Pair statistics inside the window: each bucket's own pairs plus the pairs between neighbours. */
const pairTotals = (w: Window): PairTotals => {
	let increase = 0
	let resets = 0
	let changes = 0
	let previous: SampleBucket | undefined
	for (let i = w.from; i < w.to; i++) {
		const b = at(w, i)
		if (b === undefined) continue
		increase += b.increase
		resets += b.resets
		changes += b.changes
		if (previous !== undefined) {
			increase += counterDelta(previous.lastV, b.firstV)
			if (b.firstV < previous.lastV) resets += 1
			if (b.firstV !== previous.lastV && !(Number.isNaN(b.firstV) && Number.isNaN(previous.lastV)))
				changes += 1
		}
		previous = b
	}
	return { increase, resets, changes }
}

/**
 * rate, increase and delta: Prometheus' `extrapolatedRate`. The window is
 * `(fromMs, toMs]`; at least two samples are needed.
 */
export const extrapolatedRate = (
	w: Window,
	rangeMs: number,
	isCounter: boolean,
	isRate: boolean,
): number | undefined => {
	if (isEmpty(w)) return undefined
	const first = at(w, w.from)
	const last = at(w, w.to - 1)
	if (first === undefined || last === undefined) return undefined
	const count = sampleCount(w)
	if (count < 2) return undefined
	let result = isCounter ? pairTotals(w).increase : last.lastV - first.firstV
	const sampledInterval = (last.lastT - first.firstT) / 1000
	// Prometheus' storage never holds two samples at one timestamp; ours can, so no result.
	if (sampledInterval <= 0) return undefined
	const averageBetween = sampledInterval / (count - 1)
	const threshold = averageBetween * 1.1
	let toStart = (first.firstT - w.fromMs) / 1000
	let toEnd = (w.toMs - last.lastT) / 1000
	if (toStart >= threshold) toStart = averageBetween / 2
	if (isCounter && result > 0 && first.firstV >= 0) {
		// Counters cannot go below zero: never extrapolate past the zero point.
		const toZero = sampledInterval * (first.firstV / result)
		if (toZero < toStart) toStart = toZero
	}
	if (toEnd >= threshold) toEnd = averageBetween / 2
	let factor = (sampledInterval + toStart + toEnd) / sampledInterval
	if (isRate) factor /= rangeMs / 1000
	result *= factor
	return result
}

/** The last two samples of the window, oldest first. */
const lastTwo = (w: Window): readonly [{ t: number; v: number }, { t: number; v: number }] | undefined => {
	if (isEmpty(w)) return undefined
	const last = at(w, w.to - 1)
	if (last === undefined) return undefined
	if (last.count >= 2)
		return [
			{ t: last.prevT, v: last.prevV },
			{ t: last.lastT, v: last.lastV },
		]
	const before = w.to - 2 >= w.from ? at(w, w.to - 2) : undefined
	if (before === undefined) return undefined
	return [
		{ t: before.lastT, v: before.lastV },
		{ t: last.lastT, v: last.lastV },
	]
}

/** irate and idelta: Prometheus' `instantValue`. */
export const instantValue = (w: Window, isRate: boolean): number | undefined => {
	const pair = lastTwo(w)
	if (pair === undefined) return undefined
	const [previous, last] = pair
	const value = isRate && last.v < previous.v ? last.v : last.v - previous.v
	const interval = last.t - previous.t
	if (interval === 0) return undefined
	return isRate ? value / (interval / 1000) : value
}

export const resets = (w: Window): number | undefined => (isEmpty(w) ? undefined : pairTotals(w).resets)

export const changes = (w: Window): number | undefined => (isEmpty(w) ? undefined : pairTotals(w).changes)

interface Moments {
	readonly count: number
	readonly sum: number
	readonly sumSquares: number
	readonly min: number
	readonly max: number
}

const moments = (w: Window): Moments => {
	let count = 0
	let sum = 0
	let sumSquares = 0
	let min = Number.NaN
	let max = Number.NaN
	for (let i = w.from; i < w.to; i++) {
		const b = at(w, i)
		if (b === undefined) continue
		count += b.count
		sum += b.sum
		sumSquares += b.sumSquares
		// Prometheus replaces a NaN extreme with any real value it meets.
		if (b.min < min || Number.isNaN(min)) min = b.min
		if (b.max > max || Number.isNaN(max)) max = b.max
	}
	return { count, sum, sumSquares, min, max }
}

/**
 * Prometheus' stdvar_over_time: Welford with Kahan sums over the raw values. Moments
 * (sum of squares minus squared mean) cancel catastrophically on large gauges.
 */
const stdvar = (values: ReadonlyArray<number>): number => {
	let count = 0
	let mean = 0
	let cMean = 0
	let aux = 0
	let cAux = 0
	for (const v of values) {
		count += 1
		const delta = v - (mean + cMean)
		;[mean, cMean] = kahanInc(delta / count, mean, cMean)
		;[aux, cAux] = kahanInc(delta * (v - (mean + cMean)), aux, cAux)
	}
	return (aux + cAux) / count
}

export type OverTimeFunction =
	| "avg_over_time"
	| "sum_over_time"
	| "count_over_time"
	| "min_over_time"
	| "max_over_time"
	| "last_over_time"
	| "present_over_time"
	| "stddev_over_time"
	| "stdvar_over_time"

export const overTime = (func: OverTimeFunction, w: Window): number | undefined => {
	if (isEmpty(w)) return undefined
	if (func === "last_over_time") return at(w, w.to - 1)?.lastV
	if (func === "present_over_time") return 1
	const m = moments(w)
	if (m.count === 0) return undefined
	switch (func) {
		case "avg_over_time":
			return m.sum / m.count
		case "sum_over_time":
			return m.sum
		case "count_over_time":
			return m.count
		case "min_over_time":
			return m.min
		case "max_over_time":
			return m.max
		case "stddev_over_time":
			return Math.sqrt(stdvar(windowValues(w)))
		case "stdvar_over_time":
			return stdvar(windowValues(w))
	}
}

/** The time of the window's last sample; instant selectors report it as the sample timestamp. */
export const lastSample = (w: Window): { readonly t: number; readonly v: number } | undefined => {
	if (isEmpty(w)) return undefined
	const last = at(w, w.to - 1)
	return last === undefined ? undefined : { t: last.lastT, v: last.lastV }
}

/**
 * Prometheus' `linearRegression` with x in seconds relative to `interceptMs`.
 * Bucket sums are relative to `originMs`, so they are shifted first.
 */
export const linearRegression = (
	w: Window,
	originMs: number,
	interceptMs: number,
): { readonly slope: number; readonly intercept: number } | undefined => {
	let n = 0
	let sumX = 0
	let sumY = 0
	let sumXX = 0
	let sumXY = 0
	for (let i = w.from; i < w.to; i++) {
		const b = at(w, i)
		if (b === undefined) continue
		n += b.count
		sumX += b.sumT
		sumY += b.sum
		sumXX += b.sumTT
		sumXY += b.sumTV
	}
	if (n < 2) return undefined
	const m = moments(w)
	// Constant only when every value is: a NaN sample leaves min equal to max but the sums NaN.
	if (m.min === m.max && !Number.isNaN(sumY)) {
		// A constant series: slope 0, unless it is constantly infinite.
		return Number.isFinite(m.min)
			? { slope: 0, intercept: m.min }
			: { slope: Number.NaN, intercept: Number.NaN }
	}
	const d = (interceptMs - originMs) / 1000
	const x = sumX - n * d
	const xx = sumXX - 2 * d * sumX + n * d * d
	const xy = sumXY - d * sumY
	const covXY = xy - (x * sumY) / n
	const varX = xx - (x * x) / n
	const slope = covXY / varX
	return { slope, intercept: sumY / n - (slope * x) / n }
}

/** Raw-mode sample values of the window, in time order. */
export const windowValues = (w: Window): number[] => {
	const out: number[] = []
	for (let i = w.from; i < w.to; i++) {
		const b = at(w, i)
		if (b === undefined) continue
		if (b.values !== undefined) out.push(...b.values)
		else out.push(b.lastV)
	}
	return out
}

/** double_exponential_smoothing (formerly holt_winters), Prometheus semantics. */
export const doubleExponentialSmoothing = (
	values: ReadonlyArray<number>,
	sf: number,
	tf: number,
): number | undefined => {
	if (values.length < 2 || sf <= 0 || sf >= 1 || tf <= 0 || tf >= 1) return undefined
	const first = values[0] ?? 0
	const second = values[1] ?? 0
	let s0 = 0
	let s1 = first
	let b = second - first
	for (let i = 1; i < values.length; i++) {
		const x = sf * (values[i] ?? 0)
		if (i > 1) b = tf * (s1 - s0) + (1 - tf) * b
		s0 = s1
		s1 = x + (1 - sf) * (s0 + b)
	}
	return s1
}
