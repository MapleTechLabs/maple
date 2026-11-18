import { lookup } from "../lookup"
import { Option } from "effect"
import type { LabelMatcher } from "../ast"
import { anchoredRegex } from "../regex"
import { kahanInc } from "./aggregate"
import type { Labels, SampleBucket, SelectorData, SelectorRequest } from "./types"

export interface RawSeries {
	readonly labels: Labels
	/** [epoch ms, value], in time order. */
	readonly samples: ReadonlyArray<readonly [number, number]>
}

export const matchesLabels = (matchers: ReadonlyArray<LabelMatcher>, labels: Labels): boolean =>
	matchers.every((m) => {
		const value = lookup(labels, m.name) ?? ""
		switch (m.op) {
			case "=":
				return value === m.value
			case "!=":
				return value !== m.value
			case "=~":
			case "!~": {
				const regex = Option.getOrUndefined(anchoredRegex(m.value))
				const hit = regex?.test(value) ?? false
				return m.op === "=~" ? hit : !hit
			}
		}
	})

interface Acc {
	end: number
	firstT: number
	firstV: number
	lastT: number
	lastV: number
	prevT: number
	prevV: number
	count: number
	sum: number
	sumC: number
	min: number
	max: number
	sumSquares: number
	resetSum: number
	resets: number
	changes: number
	sumT: number
	sumTT: number
	sumTV: number
	values: number[]
}

/** Aggregate one series' samples into request buckets: the reference for every source. */
export const bucketSamples = (
	samples: ReadonlyArray<readonly [number, number]>,
	request: SelectorRequest,
): SampleBucket[] => {
	const out: Acc[] = []
	let current: Acc | undefined
	for (const [t, v] of samples) {
		if (t <= request.startMs || t > request.endMs) continue
		const end =
			request.widthMs === 0
				? t
				: request.originMs + Math.ceil((t - request.originMs) / request.widthMs) * request.widthMs
		const x = (t - request.startMs) / 1000
		if (current !== undefined && current.end === end && request.widthMs !== 0) {
			const prev = current.lastV
			if (v < prev) {
				current.resetSum += prev
				current.resets += 1
			}
			if (v !== prev && !(Number.isNaN(v) && Number.isNaN(prev))) current.changes += 1
			current.prevT = current.lastT
			current.prevV = prev
			current.lastT = t
			current.lastV = v
			current.count += 1
			;[current.sum, current.sumC] = kahanInc(v, current.sum, current.sumC)
			if (v < current.min || Number.isNaN(current.min)) current.min = v
			if (v > current.max || Number.isNaN(current.max)) current.max = v
			current.sumSquares += v * v
			current.sumT += x
			current.sumTT += x * x
			current.sumTV += x * v
			current.values.push(v)
			continue
		}
		current = {
			end,
			firstT: t,
			firstV: v,
			lastT: t,
			lastV: v,
			prevT: t,
			prevV: v,
			count: 1,
			sum: v,
			sumC: 0,
			min: v,
			max: v,
			sumSquares: v * v,
			resetSum: 0,
			resets: 0,
			changes: 0,
			sumT: x,
			sumTT: x * x,
			sumTV: x * v,
			values: [v],
		}
		out.push(current)
	}
	// A bucket's sum is Kahan-compensated, as Prometheus sums raw samples.
	return out.map(({ values, ...bucket }) => (request.needsValues ? { ...bucket, values } : bucket))
}

/** A source over in-memory series, for tests and compliance runs. */
export const memorySource =
	(series: ReadonlyArray<RawSeries>) =>
	(request: SelectorRequest): SelectorData => ({
		timeOriginMs: request.startMs,
		series: series
			.filter((s) => matchesLabels(request.matchers, s.labels))
			.map((s) => ({ labels: s.labels, buckets: bucketSamples(s.samples, request) }))
			.filter((s) => s.buckets.length > 0),
	})
