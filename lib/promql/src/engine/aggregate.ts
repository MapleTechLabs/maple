import { Result } from "effect"
import type { AggregateOp } from "../ast"
import {
	type EvalError,
	evalError,
	isValidLabelName,
	makeLabels,
	METRIC_NAME,
	signature,
	withLabel,
} from "./labels"
import type { InstantVector, Labels, Sample } from "./types"

export interface AggregateOptions {
	readonly grouping: ReadonlyArray<string>
	readonly without: boolean
	readonly param: number | string | undefined
	readonly evalTimeMs: number
}

/** Kahan-Neumaier step, a port of Prometheus' kahansum.Inc. */
export const kahanInc = (inc: number, sum: number, c: number): readonly [number, number] => {
	const t = sum + inc
	if (t === Infinity || t === -Infinity) return [t, 0]
	if (Math.abs(sum) >= Math.abs(inc)) return [t, c + (sum - t + inc)]
	return [t, c + (inc - t + sum)]
}

/** Prometheus' generateGroupingLabels. */
const groupingLabels = (labels: Labels, grouping: ReadonlyArray<string>, without: boolean): Labels => {
	const names = new Set(grouping)
	if (without) {
		names.add(METRIC_NAME)
		return makeLabels(Object.entries(labels).filter(([name]) => !names.has(name)))
	}
	return makeLabels(Object.entries(labels).filter(([name]) => names.has(name)))
}

interface Group {
	readonly labels: Labels
	readonly samples: Sample[]
}

/** Groups in first-seen order, keyed like Prometheus' generateGroupingKey. */
const groupBy = (
	input: InstantVector,
	grouping: ReadonlyArray<string>,
	without: boolean,
): ReadonlyArray<Group> => {
	const groups = new Map<string, Group>()
	for (const sample of input) {
		const key = signature(sample.labels, grouping, !without)
		const group = groups.get(key)
		if (group === undefined) {
			groups.set(key, { labels: groupingLabels(sample.labels, grouping, without), samples: [sample] })
		} else {
			group.samples.push(sample)
		}
	}
	return [...groups.values()]
}

const sum = (values: ReadonlyArray<number>): number => {
	let total = values[0] ?? Number.NaN
	let c = 0
	for (const v of values.slice(1)) [total, c] = kahanInc(v, total, c)
	return total + c
}

/** Prometheus' avg: a Kahan sum that switches to an incremental mean once the sum overflows. */
const avg = (values: ReadonlyArray<number>): number => {
	let value = values[0] ?? Number.NaN
	let mean = value
	let c = 0
	let count = 1
	let incremental = false
	for (const f of values.slice(1)) {
		count++
		if (!incremental) {
			const [newV, newC] = kahanInc(f, value, c)
			if (newV !== Infinity && newV !== -Infinity) {
				value = newV
				c = newC
				continue
			}
			incremental = true
			mean = value / (count - 1)
			c /= count - 1
		}
		const q = (count - 1) / count
		;[mean, c] = kahanInc(f / count, q * mean, q * c)
	}
	return incremental ? mean + c : value / count + c / count
}

/** Welford's population variance, NaN once any value is NaN or infinite. */
const stdvar = (values: ReadonlyArray<number>): number => {
	const first = values[0] ?? Number.NaN
	let value = Number.isFinite(first) ? 0 : Number.NaN
	let mean = first
	let count = 1
	for (const f of values.slice(1)) {
		count++
		const delta = f - mean
		mean += delta / count
		value += delta * (f - mean)
	}
	return value / count
}

const extreme = (
	values: ReadonlyArray<number>,
	better: (candidate: number, current: number) => boolean,
): number => {
	let value = values[0] ?? Number.NaN
	for (const f of values.slice(1)) {
		if (better(f, value) || Number.isNaN(value)) value = f
	}
	return value
}

/** Prometheus' quantile over a sorted sample set: NaN sorts first, linear interpolation between ranks. */
export const quantile = (q: number, input: ReadonlyArray<number>): number => {
	if (input.length === 0 || Number.isNaN(q)) return Number.NaN
	if (q < 0) return -Infinity
	if (q > 1) return Infinity
	const values = [...input].sort((a, b) =>
		Number.isNaN(a) ? (Number.isNaN(b) ? 0 : -1) : Number.isNaN(b) ? 1 : a < b ? -1 : a > b ? 1 : 0,
	)
	const n = values.length
	const rank = q * (n - 1)
	const lowerIndex = Math.max(0, Math.floor(rank))
	const upperIndex = Math.min(n - 1, lowerIndex + 1)
	const weight = rank - Math.floor(rank)
	const lower = values[lowerIndex] ?? Number.NaN
	if (weight === 0) return lower
	const upper = values[upperIndex] ?? Number.NaN
	if (Object.is(lower, upper)) return lower
	return lower * (1 - weight) + upper * weight
}

/** Go's strconv.FormatFloat(v, 'f', -1, 64): shortest round-trip digits, never an exponent. */
export const formatFloat = (v: number): string => {
	if (Number.isNaN(v)) return "NaN"
	if (v === Infinity) return "+Inf"
	if (v === -Infinity) return "-Inf"
	const text = String(v)
	const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text)
	if (match === null) return Object.is(v, -0) ? "-0" : text
	const [, sign = "", lead = "", frac = "", expText = "0"] = match
	const digits = lead + frac
	const point = 1 + Number(expText)
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`
	if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** Orders best-first for topk (descending) or bottomk (ascending); NaN is always worst, as in Prometheus' heaps. */
const rankOrder =
	(descending: boolean) =>
	(a: Sample, b: Sample): number => {
		const an = Number.isNaN(a.value)
		const bn = Number.isNaN(b.value)
		if (an || bn) return an === bn ? 0 : an ? 1 : -1
		if (a.value === b.value) return 0
		return a.value > b.value === descending ? -1 : 1
	}

const MAX_INT64 = 2 ** 63

const topBottomK = (
	op: "topk" | "bottomk",
	input: InstantVector,
	opts: AggregateOptions,
): Result.Result<InstantVector, EvalError> => {
	const param = opts.param
	if (typeof param !== "number") return Result.fail(evalError(`expected a number parameter for ${op}`))
	if (param < 1) return Result.succeed([])
	if (Number.isNaN(param)) return Result.fail(evalError("Parameter value is NaN"))
	if (param >= MAX_INT64)
		return Result.fail(evalError(`Scalar value ${formatFloat(param)} overflows int64`))
	const k = Math.min(Math.trunc(param), input.length)
	const out: Sample[] = []
	for (const group of groupBy(input, opts.grouping, opts.without)) {
		const ranked = heapSelect(group.samples, k, op === "topk").sort(rankOrder(op === "topk"))
		for (const sample of ranked)
			out.push({ labels: sample.labels, value: sample.value, t: opts.evalTimeMs })
	}
	return Result.succeed(out)
}

/**
 * Prometheus keeps the k best in a Go `container/heap` and evicts its root, so
 * which of two tied samples survives depends on the heap layout. Mirror it exactly.
 */
const heapSelect = (samples: ReadonlyArray<Sample>, k: number, top: boolean): Sample[] => {
	const heap: Sample[] = []
	// Root is the worst kept sample: smallest for topk, largest for bottomk, NaN below all.
	const less = (i: number, j: number): boolean => {
		const a = heap[i]?.value ?? Number.NaN
		const b = heap[j]?.value ?? Number.NaN
		if (Number.isNaN(a) && !Number.isNaN(b)) return true
		return top ? a < b : a > b
	}
	const swap = (i: number, j: number): void => {
		const a = heap[i]
		const b = heap[j]
		if (a === undefined || b === undefined) return
		heap[i] = b
		heap[j] = a
	}
	const up = (start: number): void => {
		let j = start
		while (j > 0) {
			const i = Math.floor((j - 1) / 2)
			if (!less(j, i)) break
			swap(i, j)
			j = i
		}
	}
	const down = (start: number): boolean => {
		let i = start
		for (;;) {
			const j1 = 2 * i + 1
			if (j1 >= heap.length) break
			const j2 = j1 + 1
			const j = j2 < heap.length && less(j2, j1) ? j2 : j1
			if (!less(j, i)) break
			swap(i, j)
			i = j
		}
		return i > start
	}
	for (const sample of samples) {
		const root = heap[0]
		if (heap.length < k) {
			heap.push(sample)
			up(heap.length - 1)
		} else if (
			root !== undefined &&
			((top ? root.value < sample.value : root.value > sample.value) ||
				(Number.isNaN(root.value) && !Number.isNaN(sample.value)))
		) {
			heap[0] = sample
			if (k > 1 && !down(0)) up(0)
		}
	}
	return heap
}

const countValues = (
	input: InstantVector,
	opts: AggregateOptions,
): Result.Result<InstantVector, EvalError> => {
	const label = opts.param
	if (typeof label !== "string")
		return Result.fail(evalError("expected a string parameter for count_values"))
	if (!isValidLabelName(label)) return Result.fail(evalError(`invalid label name ${JSON.stringify(label)}`))
	const grouping = opts.without ? opts.grouping : [...opts.grouping, label]
	const relabeled = input.map((s) => ({ ...s, labels: withLabel(s.labels, label, formatFloat(s.value)) }))
	return Result.succeed(
		groupBy(relabeled, grouping, opts.without).map((g) => ({
			labels: g.labels,
			value: g.samples.length,
			t: opts.evalTimeMs,
		})),
	)
}

const reducer = (op: AggregateOp, param: number): ((values: ReadonlyArray<number>) => number) | undefined => {
	switch (op) {
		case "sum":
			return sum
		case "avg":
			return avg
		case "min":
			return (values) => extreme(values, (f, current) => current > f)
		case "max":
			return (values) => extreme(values, (f, current) => current < f)
		case "count":
			return (values) => values.length
		case "group":
			return () => 1
		case "stdvar":
			return stdvar
		case "stddev":
			return (values) => Math.sqrt(stdvar(values))
		case "quantile":
			return (values) => quantile(param, values)
		default:
			return undefined
	}
}

export const aggregate = (
	op: AggregateOp,
	input: InstantVector,
	opts: AggregateOptions,
): Result.Result<InstantVector, EvalError> => {
	switch (op) {
		case "topk":
		case "bottomk":
			return topBottomK(op, input, opts)
		case "count_values":
			return countValues(input, opts)
		case "limitk":
		case "limit_ratio":
			return Result.fail(evalError("experimental aggregation not supported"))
		case "sum":
		case "avg":
		case "min":
		case "max":
		case "count":
		case "group":
		case "stddev":
		case "stdvar":
		case "quantile":
			break
	}
	if (op === "quantile" && typeof opts.param !== "number") {
		return Result.fail(evalError("expected a number parameter for quantile"))
	}
	const reduce = reducer(op, typeof opts.param === "number" ? opts.param : Number.NaN)
	if (reduce === undefined) return Result.fail(evalError(`unknown aggregation ${op}`))
	return Result.succeed(
		groupBy(input, opts.grouping, opts.without).map((g) => ({
			labels: g.labels,
			value: reduce(g.samples.map((s) => s.value)),
			t: opts.evalTimeMs,
		})),
	)
}
