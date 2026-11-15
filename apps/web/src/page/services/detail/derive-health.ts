import { parseWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Order } from "effect"
import type { Tone } from "@maple/ui/lib/tone"
import type { DetailPoint } from "../../kit/service-metrics/points"
import { isErrorRateUp, isP95Up } from "./derive-deploys"

// The health strip: each golden signal's latest complete bucket against the window around it.

export type Signal = Readonly<{
	/** The latest complete bucket's value; `null` when no bucket carried traffic. */
	now: number | null
	/** The window's value: an average, or for p95 the median bucket. */
	window: number | null
	values: ReadonlyArray<number>
	tone: Tone
}>

export type Health = Readonly<{
	throughput: Signal
	errorRate: Signal
	p95: Signal
	apdex: Signal
}>

const APDEX_DROP = 0.05
/** The share of buckets with traffic that makes a service steady enough for an empty one to alarm. */
const STEADY_SHARE = 0.9
/** Buckets of history before an empty run can read as an outage. */
const MIN_STEADY_HISTORY = 5

const sum = (values: ReadonlyArray<number>) => Arr.reduce(values, 0, (acc, value) => acc + value)

const median = (values: ReadonlyArray<number>): number | null => {
	const sorted = Arr.sort(values, Order.Number)
	const middle = Math.floor(sorted.length / 2)
	if (sorted.length === 0) return null
	return sorted.length % 2 === 1
		? (sorted[middle] ?? null)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** Count-weighted, so a quiet bucket does not move the window's rate. */
const weighted = (points: ReadonlyArray<DetailPoint>, pick: (point: DetailPoint) => number) => {
	const total = sum(Arr.map(points, (point) => point.totalCount))
	return total === 0 ? null : sum(Arr.map(points, (point) => pick(point) * point.totalCount)) / total
}

const signal = (
	now: number | null,
	window: number | null,
	values: ReadonlyArray<number>,
	tone: Tone = "neutral",
): Signal => ({ now, window, values, tone })

/** Seconds between the first two buckets: `throughput` is a bucket's request count, not a rate. */
const bucketSecondsOf = (points: ReadonlyArray<DetailPoint>): number => {
	const [first, second] = points
	if (first === undefined || second === undefined) return 60
	const seconds = (parseWarehouseDateTime(second.bucket) - parseWarehouseDateTime(first.bucket)) / 1000
	return Number.isFinite(seconds) && seconds > 0 ? seconds : 60
}

/**
 * "Now" is the last complete bucket, traffic or not: a service that went quiet reads 0/s, not the
 * last busy minute. The trailing partial bucket is still filling, so it is skipped, as is a bucket
 * that starts where the window ends (a past range ending on a bucket boundary carries an empty one).
 */
export const deriveHealth = (points: ReadonlyArray<DetailPoint>, endMs: number): Health | null => {
	const complete = Arr.filter(
		points,
		(point) => !point.partial && parseWarehouseDateTime(point.bucket) < endMs,
	)
	const served = Arr.filter(complete, (point) => point.totalCount > 0)
	const latest = Arr.last(complete)
	const lastServed = Arr.last(served)
	if (latest._tag === "None" || lastServed._tag === "None") return null
	// An empty bucket is an outage only for a service busy in nearly every bucket before the empty
	// run it ends; a sparse one (a few requests a minute) has empty minutes all the time, so it
	// reads its last busy one. Too short a history proves nothing either way.
	const history = Arr.filter(complete, (point) => point.bucket <= lastServed.value.bucket)
	const isSteady = history.length >= MIN_STEADY_HISTORY && served.length >= STEADY_SHARE * history.length
	const isSilent = latest.value.totalCount === 0 && isSteady
	const now = isSilent ? latest.value : lastServed.value
	const bucketSeconds = bucketSecondsOf(points)
	const perSecond = (point: DetailPoint) => point.throughput / bucketSeconds
	const errorWindow = weighted(served, (point) => point.errorRate) ?? 0
	const p95Window = median(Arr.map(served, (point) => point.p95LatencyMs)) ?? 0
	const apdexWindow = weighted(served, (point) => point.apdexScore) ?? 0
	const throughputWindow = sum(Arr.map(complete, perSecond)) / complete.length
	return {
		throughput: signal(
			perSecond(now),
			throughputWindow,
			Arr.map(points, perSecond),
			isSilent && throughputWindow > 0 ? "crit" : "neutral",
		),
		errorRate: signal(
			isSilent ? null : now.errorRate,
			errorWindow,
			Arr.map(points, (point) => point.errorRate),
			!isSilent && isErrorRateUp(errorWindow, now.errorRate) ? "crit" : "neutral",
		),
		p95: signal(
			isSilent ? null : now.p95LatencyMs,
			p95Window,
			Arr.map(points, (point) => point.p95LatencyMs),
			!isSilent && isP95Up(p95Window, now.p95LatencyMs) ? "warn" : "neutral",
		),
		apdex: signal(
			isSilent ? null : now.apdexScore,
			apdexWindow,
			Arr.map(points, (point) => point.apdexScore),
			!isSilent && apdexWindow - now.apdexScore >= APDEX_DROP ? "warn" : "neutral",
		),
	}
}
