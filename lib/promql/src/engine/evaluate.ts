import { Result } from "effect"
import type { Call, Expr, LabelMatcher, MatrixSelector, SubqueryExpr, VectorSelector } from "../ast"
import { valueTypeOf } from "../types"
import {
	aggregate,
	compareLabels,
	dropMetricName,
	ensureUniqueLabelsets,
	labelsKey,
	makeLabels,
	type EvalError,
	bucketFraction,
	classicHistogram,
	histogramQuantile,
	instantFunction,
	scalarBinary,
	vectorScalarBinary,
	vectorVectorBinary,
} from "./ops"
import {
	gridTimes,
	isInstant,
	MAX_POINTS_PER_SERIES,
	type QueryParams,
	resolutionError,
	resolveAt,
	subqueryGrid,
	type TimeGrid,
} from "./plan"
import {
	DEFAULT_LIMITS,
	type EvalLimits,
	type InstantVector,
	type Labels,
	LOOKBACK_MS,
	type Point,
	type PushdownData,
	type QueryResult,
	type RangeSeries,
	type Sample,
	type SampleBucket,
	type SelectorData,
	type SeriesData,
} from "./types"
import {
	changes,
	doubleExponentialSmoothing,
	extrapolatedRate,
	instantValue,
	lastSample,
	linearRegression,
	type OverTimeFunction,
	overTime,
	quantile,
	resets,
	windowOf,
	windowValues,
} from "./window"

type R<A> = Result.Result<A, EvalError>

/** A vector-valued expression evaluated at every step of its grid. */
interface Steps {
	readonly kind: "vector"
	readonly times: ReadonlyArray<number>
	readonly vectors: ReadonlyArray<InstantVector>
}

interface Scalars {
	readonly kind: "scalar"
	readonly times: ReadonlyArray<number>
	readonly values: ReadonlyArray<number>
}

interface Text {
	readonly kind: "string"
	readonly value: string
}

type Value = Steps | Scalars | Text

/** A range argument: per series, buckets plus how to cut windows from them. */
interface RangeArg {
	readonly series: ReadonlyArray<SeriesData>
	readonly rangeMs: number
	readonly offsetMs: number
	readonly at: number | undefined
	readonly timeOriginMs: number
	/** The selector, for absent_over_time's labels. */
	readonly selector: VectorSelector | undefined
}

const err = (message: string): R<never> => Result.fail({ message })

const OVER_TIME: ReadonlySet<string> = new Set([
	"avg_over_time",
	"sum_over_time",
	"count_over_time",
	"min_over_time",
	"max_over_time",
	"last_over_time",
	"present_over_time",
	"stddev_over_time",
	"stdvar_over_time",
])

const isOverTime = (func: string): func is OverTimeFunction => OVER_TIME.has(func)

const DATE_FUNCTIONS: ReadonlySet<string> = new Set([
	"day_of_month",
	"day_of_week",
	"day_of_year",
	"days_in_month",
	"hour",
	"minute",
	"month",
	"year",
])

/** Labels for absent(): the selector's equality matchers, unless a name is matched twice. */
const absentLabels = (matchers: ReadonlyArray<LabelMatcher>): Labels => {
	const out = new Map<string, string>()
	const seen = new Set<string>()
	const duplicated = new Set<string>()
	for (const m of matchers) {
		if (m.name === "__name__") continue
		if (seen.has(m.name)) duplicated.add(m.name)
		seen.add(m.name)
		if (m.op === "=") out.set(m.name, m.value)
	}
	for (const name of duplicated) out.delete(name)
	return makeLabels(out)
}

const selectorOf = (expr: Expr): VectorSelector | undefined => {
	if (expr.type === "VectorSelector") return expr
	if (expr.type === "MatrixSelector") return expr.vector
	if (expr.type === "Paren") return selectorOf(expr.expr)
	return undefined
}

/** One raw bucket per point, so subquery output feeds the same window kernel. */
const pointsToBuckets = (points: ReadonlyArray<Point>, originMs: number): SampleBucket[] =>
	points.map(({ t, v }) => {
		const x = (t - originMs) / 1000
		return {
			end: t,
			firstT: t,
			firstV: v,
			lastT: t,
			lastV: v,
			prevT: t,
			prevV: v,
			count: 1,
			sum: v,
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
	})

/** Steps to series: one entry per distinct label set, points in step order. */
const transpose = (steps: Steps): RangeSeries[] => {
	const byKey = new Map<string, { labels: Labels; points: Point[] }>()
	steps.vectors.forEach((vector, index) => {
		const t = steps.times[index] ?? 0
		for (const sample of vector) {
			const key = labelsKey(sample.labels)
			const entry = byKey.get(key) ?? { labels: sample.labels, points: [] }
			entry.points.push({ t, v: sample.value })
			byKey.set(key, entry)
		}
	})
	return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, series]) => series)
}

const checkUnique = (vector: InstantVector): R<InstantVector> => {
	const seen = new Set<string>()
	for (const sample of vector) {
		const key = labelsKey(sample.labels)
		if (seen.has(key)) return err("vector cannot contain metrics with the same labelset")
		seen.add(key)
	}
	return Result.succeed(vector)
}

const sortedSelectors = new WeakMap<SelectorData, SelectorData>()

export interface EvaluationInput {
	readonly expr: Expr
	readonly params: QueryParams
	/** What the source returned for each selector of `planRequests`. */
	readonly data: ReadonlyMap<VectorSelector, SelectorData>
	/** Subtrees the source evaluated itself (see `planPushdowns`). */
	readonly pushed?: ReadonlyMap<Expr, PushdownData>
	readonly limits?: EvalLimits
}

class Evaluator {
	private points = 0
	private readonly lookbackMs: number

	constructor(
		private readonly params: QueryParams,
		private readonly data: ReadonlyMap<VectorSelector, SelectorData>,
		private readonly limits: EvalLimits,
		private readonly pushed: ReadonlyMap<Expr, PushdownData>,
	) {
		this.lookbackMs = params.lookbackMs ?? LOOKBACK_MS
	}

	selectorData(selector: VectorSelector): R<SelectorData> {
		const data = this.data.get(selector)
		if (data === undefined) return err("internal error: selector was not planned")
		if (data.series.length > this.limits.maxSeries) {
			return err(`query selects more than ${this.limits.maxSeries} series; narrow the selector`)
		}
		const sorted = sortedSelectors.get(data)
		if (sorted !== undefined) return Result.succeed(sorted)
		// Prometheus reads series in label order; ties in topk and friends depend on it.
		const ordered = {
			...data,
			series: [...data.series].sort((a, b) => compareLabels(a.labels, b.labels)),
		}
		sortedSelectors.set(data, ordered)
		return Result.succeed(ordered)
	}

	/** Whether `pending` more samples still fit, checked while a vector is being built. */
	fits(pending: number): boolean {
		return this.points + pending <= this.limits.maxPoints
	}

	tooMany(): R<never> {
		return err(`query processing would load too many samples (more than ${this.limits.maxPoints})`)
	}

	count(vectors: ReadonlyArray<InstantVector>): R<void> {
		for (const vector of vectors) this.points += vector.length
		return this.points > this.limits.maxPoints
			? err(`query processing would load too many samples (more than ${this.limits.maxPoints})`)
			: Result.succeed(undefined)
	}

	/** A consumed stage's samples are no longer live; the budget is on live samples, like Prometheus'. */
	release(value: Steps): void {
		for (const vector of value.vectors) this.points -= vector.length
	}

	steps(times: ReadonlyArray<number>, vectors: InstantVector[]): R<Steps> {
		return Result.map(this.count(vectors), () => ({ kind: "vector" as const, times, vectors }))
	}

	/** Map every step of a vector value through `f`. */
	perStep(
		value: Steps,
		f: (vector: InstantVector, index: number, t: number) => R<InstantVector>,
	): R<Steps> {
		const out: InstantVector[] = []
		for (const [index, vector] of value.vectors.entries()) {
			const next = f(vector, index, value.times[index] ?? 0)
			if (Result.isFailure(next)) return Result.fail(next.failure)
			out.push(next.success)
		}
		// Input and output are both live while the output is built; the input is freed after.
		const result = this.steps(value.times, out)
		this.release(value)
		return result
	}

	instantSelector(selector: VectorSelector, grid: TimeGrid): R<Steps> {
		return Result.gen(this, function* () {
			const data = yield* this.selectorData(selector)
			const times = gridTimes(grid)
			const at = resolveAt(selector.at, this.params)
			const vectors: Sample[][] = []
			let pending = 0
			for (const t of times) {
				const ref = (at ?? t) - selector.offsetMs
				const out: Sample[] = []
				for (const series of data.series) {
					const last = lastSample(windowOf(series.buckets, ref - this.lookbackMs, ref))
					if (last === undefined) continue
					pending += 1
					if (!this.fits(pending)) return yield* this.tooMany()
					out.push({ labels: series.labels, value: last.v, t: last.t })
				}
				vectors.push(out)
			}
			return yield* this.steps(times, vectors)
		})
	}

	rangeArg(expr: Expr, grid: TimeGrid): R<RangeArg> {
		return Result.gen(this, function* () {
			if (expr.type === "Paren") return yield* this.rangeArg(expr.expr, grid)
			if (expr.type === "MatrixSelector") return yield* this.matrixArg(expr)
			if (expr.type === "Subquery") return yield* this.subqueryArg(expr, grid)
			return yield* err("expected a range vector")
		})
	}

	matrixArg(node: MatrixSelector): R<RangeArg> {
		return Result.map(this.selectorData(node.vector), (data) => ({
			series: data.series,
			rangeMs: node.rangeMs,
			offsetMs: node.vector.offsetMs,
			at: resolveAt(node.vector.at, this.params),
			timeOriginMs: data.timeOriginMs,
			selector: node.vector,
		}))
	}

	subqueryArg(node: SubqueryExpr, grid: TimeGrid): R<RangeArg> {
		return Result.gen(this, function* () {
			const inner = subqueryGrid(node, grid, this.params)
			// Checked before the grid exists: `x[1y:1ms]` would allocate billions of timestamps.
			const points = Math.floor((inner.endMs - inner.startMs) / inner.stepMs) + 1
			if (points > MAX_POINTS_PER_SERIES) {
				return yield* err(
					`subquery resolution too fine: ${points} points per series, at most ${MAX_POINTS_PER_SERIES}; use a larger subquery step`,
				)
			}
			const value = yield* this.eval(node.expr, inner)
			if (value.kind !== "vector")
				return yield* err("subquery expression must return an instant vector")
			this.release(value)
			const series = transpose(value).map((s) => ({
				labels: s.labels,
				buckets: pointsToBuckets(s.points, inner.startMs),
			}))
			return {
				series,
				rangeMs: node.rangeMs,
				offsetMs: node.offsetMs,
				at: resolveAt(node.at, this.params),
				timeOriginMs: inner.startMs,
				selector: undefined,
			}
		})
	}

	scalarAt(value: Value, index: number): number {
		return value.kind === "scalar" ? (value.values[index] ?? Number.NaN) : Number.NaN
	}

	/** Apply a per-window function to every series at every step. */
	overWindows(
		arg: RangeArg,
		grid: TimeGrid,
		keepName: boolean,
		f: (
			window: ReturnType<typeof windowOf>,
			series: SeriesData,
			index: number,
			evalMs: number,
			stepMs: number,
		) => number | undefined,
	): R<Steps> {
		const times = gridTimes(grid)
		const vectors: InstantVector[] = []
		let pending = 0
		for (const [index, t] of times.entries()) {
			const evalMs = arg.at ?? t
			const to = evalMs - arg.offsetMs
			const out: Sample[] = []
			for (const series of arg.series) {
				const value = f(windowOf(series.buckets, to - arg.rangeMs, to), series, index, evalMs, t)
				if (value === undefined) continue
				pending += 1
				if (!this.fits(pending)) return this.tooMany()
				out.push({ labels: keepName ? series.labels : dropMetricName(series.labels), value, t })
			}
			const unique = checkUnique(out)
			if (Result.isFailure(unique)) return Result.fail(unique.failure)
			vectors.push(out)
		}
		return this.steps(times, vectors)
	}

	/** A range function, its input buckets charged to the budget while it reads them. */
	rangeFunction(call: Call, grid: TimeGrid): R<Steps> {
		return Result.gen(this, function* () {
			const rangeIndex = call.func === "quantile_over_time" ? 1 : 0
			const rangeExpr = call.args[rangeIndex]
			if (rangeExpr === undefined) return yield* err(`missing range argument to ${call.func}`)
			const arg = yield* this.rangeArg(rangeExpr, grid)
			let input = 0
			for (const series of arg.series) input += series.buckets.length
			if (!this.fits(input)) return yield* this.tooMany()
			this.points += input
			const result = this.rangeFunctionOver(call, grid, arg, rangeIndex)
			this.points -= input
			return yield* result
		})
	}

	rangeFunctionOver(call: Call, grid: TimeGrid, arg: RangeArg, rangeIndex: number): R<Steps> {
		const func = call.func
		return Result.gen(this, function* () {
			const scalarArgs: Value[] = []
			for (const [index, a] of call.args.entries()) {
				if (index !== rangeIndex) scalarArgs.push(yield* this.eval(a, grid))
			}
			const param = (i: number, step: number): number => {
				const value = scalarArgs[i]
				return value === undefined ? Number.NaN : this.scalarAt(value, step)
			}
			switch (func) {
				case "rate":
				case "increase":
				case "delta":
					return yield* this.overWindows(arg, grid, false, (w) =>
						extrapolatedRate(w, arg.rangeMs, func !== "delta", func === "rate"),
					)
				case "irate":
				case "idelta":
					return yield* this.overWindows(arg, grid, false, (w) => instantValue(w, func === "irate"))
				case "resets":
					return yield* this.overWindows(arg, grid, false, (w) => resets(w))
				case "changes":
					return yield* this.overWindows(arg, grid, false, (w) => changes(w))
				case "deriv":
					return yield* this.overWindows(arg, grid, false, (w) => {
						const first = w.buckets[w.from]
						return first === undefined
							? undefined
							: linearRegression(w, arg.timeOriginMs, first.firstT)?.slope
					})
				case "predict_linear":
					// `@` pins the input window; the prediction is still made at the step's time.
					return yield* this.overWindows(arg, grid, false, (w, _s, step, _evalMs, stepMs) => {
						const fit = linearRegression(w, arg.timeOriginMs, stepMs)
						return fit === undefined ? undefined : fit.slope * param(0, step) + fit.intercept
					})
				case "quantile_over_time":
					return yield* this.overWindows(arg, grid, false, (w, _s, step) => {
						const values = windowValues(w)
						return values.length === 0 ? undefined : quantile(param(0, step), values)
					})
				case "mad_over_time":
					return yield* this.overWindows(arg, grid, false, (w) => {
						const values = windowValues(w)
						if (values.length === 0) return undefined
						const median = quantile(0.5, values)
						return quantile(
							0.5,
							values.map((v) => Math.abs(v - median)),
						)
					})
				case "holt_winters":
				case "double_exponential_smoothing": {
					for (const [step] of gridTimes(grid).entries()) {
						const sf = param(0, step)
						const tf = param(1, step)
						if (!(sf > 0 && sf < 1))
							return yield* err(`invalid smoothing factor. Expected: 0 < sf < 1, got: ${sf}`)
						if (!(tf > 0 && tf < 1))
							return yield* err(`invalid trend factor. Expected: 0 < tf < 1, got: ${tf}`)
					}
					return yield* this.overWindows(arg, grid, false, (w, _s, step) =>
						doubleExponentialSmoothing(windowValues(w), param(0, step), param(1, step)),
					)
				}
				case "absent_over_time":
					return yield* this.absentOverTime(arg, grid)
				default:
					if (isOverTime(func)) {
						return yield* this.overWindows(arg, grid, func === "last_over_time", (w) =>
							overTime(func, w),
						)
					}
					return yield* err(`unsupported range function ${func}`)
			}
		})
	}

	absentOverTime(arg: RangeArg, grid: TimeGrid): R<Steps> {
		const labels = absentLabels(arg.selector?.matchers ?? [])
		const times = gridTimes(grid)
		const vectors = times.map((t): InstantVector => {
			const to = (arg.at ?? t) - arg.offsetMs
			const present = arg.series.some((s) => {
				const w = windowOf(s.buckets, to - arg.rangeMs, to)
				return w.to > w.from
			})
			return present ? [] : [{ labels, value: 1, t }]
		})
		return this.steps(times, vectors)
	}

	constant(grid: TimeGrid, f: (t: number) => number): Scalars {
		const times = gridTimes(grid)
		return { kind: "scalar", times, values: times.map(f) }
	}

	vectorArg(expr: Expr | undefined, grid: TimeGrid): R<Steps> {
		if (expr === undefined) return err("missing argument")
		return Result.flatMap(this.eval(expr, grid), (value) =>
			value.kind === "vector" ? Result.succeed(value) : err("expected an instant vector argument"),
		)
	}

	call(call: Call, grid: TimeGrid): R<Value> {
		const func = call.func
		return Result.gen(this, function* (): Generator<R<unknown>, Value> {
			const first = call.args[0]
			if (call.args.some((a) => valueTypeOf(a) === "matrix"))
				return yield* this.rangeFunction(call, grid)
			switch (func) {
				case "time":
					return this.constant(grid, (t) => t / 1000)
				case "pi":
					return this.constant(grid, () => Math.PI)
				case "vector": {
					const s = yield* this.eval(first ?? { type: "NumberLiteral", value: Number.NaN }, grid)
					const times = gridTimes(grid)
					return yield* this.steps(
						times,
						times.map((t, i) => [{ labels: {}, value: this.scalarAt(s, i), t }]),
					)
				}
				case "scalar": {
					const v = yield* this.vectorArg(first, grid)
					this.release(v)
					return {
						kind: "scalar",
						times: v.times,
						values: v.vectors.map((vec) =>
							vec.length === 1 ? (vec[0]?.value ?? Number.NaN) : Number.NaN,
						),
					}
				}
				case "absent": {
					const v = yield* this.vectorArg(first, grid)
					const selector = first === undefined ? undefined : selectorOf(first)
					const labels = absentLabels(selector?.matchers ?? [])
					return yield* this.perStep(v, (vec, _i, t) =>
						Result.succeed(vec.length === 0 ? [{ labels, value: 1, t }] : []),
					)
				}
				// The rest of the native-histogram functions skip float samples, and every stored sample is a float.
				case "histogram_avg":
				case "histogram_count":
				case "histogram_stddev":
				case "histogram_stdvar":
				case "histogram_sum": {
					for (const arg of call.args.slice(0, -1)) yield* this.eval(arg, grid)
					return yield* this.perStep(yield* this.vectorArg(call.args.at(-1), grid), () =>
						Result.succeed([]),
					)
				}
				case "histogram_fraction": {
					const lower = yield* this.eval(
						first ?? { type: "NumberLiteral", value: Number.NaN },
						grid,
					)
					const upper = yield* this.eval(
						call.args[1] ?? { type: "NumberLiteral", value: Number.NaN },
						grid,
					)
					const v = yield* this.vectorArg(call.args[2], grid)
					return yield* this.perStep(v, (vec, i, t) =>
						classicHistogram(vec, t, (buckets) =>
							bucketFraction(this.scalarAt(lower, i), this.scalarAt(upper, i), buckets),
						),
					)
				}
				case "histogram_quantile": {
					const phi = yield* this.eval(first ?? { type: "NumberLiteral", value: Number.NaN }, grid)
					const v = yield* this.vectorArg(call.args[1], grid)
					return yield* this.perStep(v, (vec, i, t) =>
						histogramQuantile(this.scalarAt(phi, i), vec, t),
					)
				}
			}
			// Date functions default to vector(time()).
			const target: Steps =
				first === undefined && DATE_FUNCTIONS.has(func)
					? yield* this.steps(
							gridTimes(grid),
							gridTimes(grid).map((t) => [{ labels: {}, value: t / 1000, t }]),
						)
					: yield* this.vectorArg(first, grid)
			const params: Value[] = []
			for (const arg of call.args.slice(1)) params.push(yield* this.eval(arg, grid))
			return yield* this.perStep(target, (vec, i, t) =>
				instantFunction(
					func,
					vec,
					params.map((p) => (p.kind === "string" ? p.value : this.scalarAt(p, i))),
					t,
				),
			)
		})
	}

	/** A pushed subtree's answer as steps; a bare range function drops the metric name. */
	fromPushed(expr: Expr, data: PushdownData, grid: TimeGrid): R<Steps> {
		// The source returns one row past the cap, so overflow shows here as it does for selectors.
		if (data.series.length > this.limits.maxSeries) {
			return err(
				`query returns more than ${this.limits.maxSeries} series; narrow the selector or aggregate`,
			)
		}
		const times = gridTimes(grid)
		const vectors: Sample[][] = times.map(() => [])
		const keepName = expr.type === "Aggregate" || (expr.type === "Call" && expr.func === "last_over_time")
		// Label order, as the selector would have read them; ties in topk depend on it.
		const ordered = [...data.series].sort((x, y) => compareLabels(x.labels, y.labels))
		let pending = 0
		for (const series of ordered) {
			const labels = keepName ? series.labels : dropMetricName(series.labels)
			for (const [i, step] of series.steps.entries()) {
				const t = times[step]
				const value = series.values[i]
				const vector = vectors[step]
				if (t === undefined || value === undefined || vector === undefined) continue
				pending += 1
				if (!this.fits(pending)) return this.tooMany()
				vector.push({ labels, value, t })
			}
		}
		for (const vector of vectors) {
			const unique = checkUnique(vector)
			if (Result.isFailure(unique)) return Result.fail(unique.failure)
		}
		return this.steps(times, vectors)
	}

	eval(expr: Expr, grid: TimeGrid): R<Value> {
		const pushed = this.pushed.get(expr)
		if (pushed !== undefined) return this.fromPushed(expr, pushed, grid)
		return Result.gen(this, function* (): Generator<R<unknown>, Value> {
			switch (expr.type) {
				case "NumberLiteral":
					return this.constant(grid, () => expr.value)
				case "StringLiteral":
					return { kind: "string", value: expr.value }
				case "Paren":
					return yield* this.eval(expr.expr, grid)
				case "VectorSelector":
					return yield* this.instantSelector(expr, grid)
				case "MatrixSelector":
				case "Subquery":
					return yield* err("range vectors are only valid as function arguments")
				case "Call":
					return yield* this.call(expr, grid)
				case "Unary": {
					const inner = yield* this.eval(expr.expr, grid)
					if (expr.op === "+" && inner.kind === "vector") {
						// Evaluated, not selected: `timestamp(+x)` reads the evaluation time, as in Prometheus.
						return yield* this.perStep(inner, (vec, _i, t) =>
							Result.succeed(vec.map((s) => ({ ...s, t }))),
						)
					}
					if (expr.op === "+") return inner
					if (inner.kind === "scalar") return { ...inner, values: inner.values.map((v) => -v) }
					if (inner.kind === "string") return yield* err("unary minus on a string")
					// A computed value: the evaluation time, and no duplicate label sets once names drop.
					return yield* this.perStep(inner, (vec, _i, t) =>
						ensureUniqueLabelsets(
							vec.map((s) => ({ labels: dropMetricName(s.labels), value: -s.value, t })),
						),
					)
				}
				case "Aggregate": {
					const input = yield* this.vectorArg(expr.expr, grid)
					const param = expr.param === undefined ? undefined : yield* this.eval(expr.param, grid)
					return yield* this.perStep(input, (vec, i, t) =>
						aggregate(expr.op, vec, {
							grouping: expr.grouping,
							without: expr.without,
							param:
								param === undefined
									? undefined
									: param.kind === "string"
										? param.value
										: this.scalarAt(param, i),
							evalTimeMs: t,
						}),
					)
				}
				case "Binary": {
					const lhs = yield* this.eval(expr.lhs, grid)
					const rhs = yield* this.eval(expr.rhs, grid)
					if (lhs.kind === "string" || rhs.kind === "string")
						return yield* err("binary operator on a string")
					if (lhs.kind === "scalar" && rhs.kind === "scalar") {
						return {
							kind: "scalar",
							times: lhs.times,
							values: lhs.values.map((l, i) =>
								scalarBinary(expr.op, l, rhs.values[i] ?? Number.NaN, expr.returnBool),
							),
						}
					}
					if (lhs.kind === "vector" && rhs.kind === "vector") {
						const result = yield* this.perStep(lhs, (vec, i, t) =>
							vectorVectorBinary(
								expr.op,
								vec,
								rhs.vectors[i] ?? [],
								expr.matching,
								expr.returnBool,
								t,
							),
						)
						this.release(rhs)
						return result
					}
					const vector = lhs.kind === "vector" ? lhs : rhs.kind === "vector" ? rhs : undefined
					const scalar = lhs.kind === "scalar" ? lhs : rhs.kind === "scalar" ? rhs : undefined
					if (vector === undefined || scalar === undefined)
						return yield* err("invalid binary operands")
					return yield* this.perStep(vector, (vec, i, t) =>
						ensureUniqueLabelsets(
							vectorScalarBinary(
								expr.op,
								vec,
								scalar.values[i] ?? Number.NaN,
								lhs.kind === "scalar",
								expr.returnBool,
								t,
							),
						),
					)
				}
			}
		})
	}

	/** A bare range selector or subquery in an instant query: its raw points. */
	rawMatrix(expr: Expr, grid: TimeGrid): R<RangeSeries[]> {
		return Result.flatMap(this.rangeArg(expr, grid), (arg) => {
			const evalMs = arg.at ?? grid.startMs
			const to = evalMs - arg.offsetMs
			const out: RangeSeries[] = []
			let pending = 0
			for (const series of arg.series) {
				const w = windowOf(series.buckets, to - arg.rangeMs, to)
				const points: Point[] = []
				for (let i = w.from; i < w.to; i++) {
					const b = series.buckets[i]
					if (b === undefined) continue
					pending += 1
					if (!this.fits(pending)) return this.tooMany()
					points.push({ t: b.lastT, v: b.lastV })
				}
				if (points.length > 0) out.push({ labels: series.labels, points })
			}
			return Result.succeed(out)
		})
	}
}

/** Evaluate a planned query once the source has answered every request of `planRequests`. */
export const evaluate = (input: EvaluationInput): R<QueryResult> => {
	const { expr, params } = input
	// Callers may skip `runQuery`; refuse a grid that would be too large before building it.
	const resolution = resolutionError(expr, params)
	if (resolution !== undefined) return err(resolution)
	const evaluator = new Evaluator(
		params,
		input.data,
		input.limits ?? DEFAULT_LIMITS,
		input.pushed ?? new Map(),
	)
	const instant = isInstant(params)
	const grid: TimeGrid = instant
		? { startMs: params.startMs, endMs: params.startMs, stepMs: 0 }
		: { startMs: params.startMs, endMs: params.endMs, stepMs: params.stepMs }
	const type = valueTypeOf(expr)
	if (type === "matrix") {
		if (!instant)
			return err(
				'invalid expression type "range vector" for range query, must be Scalar or instant Vector',
			)
		return Result.map(evaluator.rawMatrix(expr, grid), (result) => ({ resultType: "matrix", result }))
	}
	return Result.flatMap(evaluator.eval(expr, grid), (value): R<QueryResult> => {
		if (value.kind === "string") {
			return instant
				? Result.succeed({ resultType: "string", result: { t: params.startMs, v: value.value } })
				: err('invalid expression type "string" for range query, must be Scalar or instant Vector')
		}
		if (instant) {
			if (value.kind === "scalar") {
				return Result.succeed({
					resultType: "scalar",
					result: { t: params.startMs, v: value.values[0] ?? Number.NaN },
				})
			}
			const vector = (value.vectors[0] ?? []).map((s) => ({ ...s, t: params.startMs }))
			return Result.succeed({ resultType: "vector", result: vector })
		}
		if (value.kind === "scalar") {
			const points = value.times.map((t, i) => ({ t, v: value.values[i] ?? Number.NaN }))
			return Result.succeed({ resultType: "matrix", result: [{ labels: {}, points }] })
		}
		return Result.succeed({ resultType: "matrix", result: transpose(value) })
	})
}
