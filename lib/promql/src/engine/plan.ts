import type { AtModifier, Expr, MatrixSelector, SubqueryExpr, VectorSelector } from "../ast"
import {
	LOOKBACK_MS,
	PUSHDOWN_AGGREGATIONS,
	PUSHDOWN_FUNCTIONS,
	type PushdownAggregation,
	type PushdownFunction,
	type PushdownRequest,
	type SelectorRequest,
} from "./types"

/** Query parameters. An instant query has `startMs === endMs` and any step. */
export interface QueryParams {
	readonly startMs: number
	readonly endMs: number
	readonly stepMs: number
	readonly lookbackMs?: number
	/** Instant (one sample per series) or range (a matrix). Default: instant when start equals end. */
	readonly instant?: boolean
}

export const isInstant = (params: QueryParams): boolean => params.instant ?? params.startMs === params.endMs

/** The evaluation timestamps of one (sub)expression: `start, start + step, ..., <= end`. */
export interface TimeGrid {
	readonly startMs: number
	readonly endMs: number
	readonly stepMs: number
}

export const gridTimes = (grid: TimeGrid): number[] => {
	const out: number[] = []
	if (grid.stepMs <= 0) return [grid.startMs]
	for (let t = grid.startMs; t <= grid.endMs; t += grid.stepMs) out.push(t)
	return out
}

/** Buckets narrower than this are not worth aggregating: fetch raw samples instead. */
const MIN_BUCKET_MS = 1000

/** Functions that need every sample value, which buckets cannot provide. */
const RAW_FUNCTIONS: ReadonlySet<string> = new Set([
	"quantile_over_time",
	"mad_over_time",
	"stddev_over_time",
	"stdvar_over_time",
	"holt_winters",
	"double_exponential_smoothing",
])

/** Default subquery resolution when the query has no step (Prometheus' evaluation interval). */
const DEFAULT_SUBQUERY_STEP_MS = 60_000

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

export const resolveAt = (at: AtModifier | undefined, params: QueryParams): number | undefined => {
	if (at === undefined) return undefined
	if (at.kind === "start") return params.startMs
	// An instant query has one timestamp, its start, whatever end the caller passed.
	if (at.kind === "end") return isInstant(params) ? params.startMs : params.endMs
	return at.timeMs
}

/** The grid a selector or subquery reads at, after `@` pins it. */
const pinned = (grid: TimeGrid, at: number | undefined): TimeGrid =>
	at === undefined ? grid : { startMs: at, endMs: at, stepMs: 0 }

/** The inner grid of a subquery: absolute multiples of its step, covering every outer window. */
export const subqueryGrid = (sub: SubqueryExpr, grid: TimeGrid, params: QueryParams): TimeGrid => {
	const outer = pinned(grid, resolveAt(sub.at, params))
	// Prometheus' default is the evaluation interval, never the query step.
	const stepMs = sub.stepMs ?? DEFAULT_SUBQUERY_STEP_MS
	const earliest = outer.startMs - sub.offsetMs - sub.rangeMs
	// Windows are left-open, so a point exactly on `earliest` is excluded.
	const startMs = (Math.floor(earliest / stepMs) + 1) * stepMs
	return { startMs, endMs: outer.endMs - sub.offsetMs, stepMs }
}

const unparen = (expr: Expr): Expr => (expr.type === "Paren" ? unparen(expr.expr) : expr)

/** Every selector of the query with the request that feeds it. */
export type RequestPlan = Map<VectorSelector, SelectorRequest>

const request = (
	selector: VectorSelector,
	grid: TimeGrid,
	params: QueryParams,
	windowMs: number,
	raw: boolean,
): SelectorRequest => {
	const g = pinned(grid, resolveAt(selector.at, params))
	const last =
		g.stepMs > 0 ? g.startMs + Math.floor((g.endMs - g.startMs) / g.stepMs) * g.stepMs : g.startMs
	const originMs = g.startMs - selector.offsetMs
	let widthMs = g.stepMs > 0 && g.endMs > g.startMs ? gcd(g.stepMs, windowMs) : windowMs
	if (raw || widthMs < MIN_BUCKET_MS) widthMs = 0
	return {
		metricName: selector.name,
		matchers: selector.matchers,
		startMs: originMs - windowMs,
		endMs: last - selector.offsetMs,
		originMs,
		widthMs,
		needsValues: raw,
	}
}

/** Walk the query and collect what every selector must read. */
export const planRequests = (expr: Expr, params: QueryParams): RequestPlan => {
	const plan: RequestPlan = new Map()
	const lookback = params.lookbackMs ?? LOOKBACK_MS
	// The grid `evaluate` walks: an instant query reads at its start only.
	const top: TimeGrid = isInstant(params)
		? { startMs: params.startMs, endMs: params.startMs, stepMs: 0 }
		: { startMs: params.startMs, endMs: params.endMs, stepMs: params.stepMs }
	const matrix = (node: MatrixSelector, grid: TimeGrid, raw: boolean): void => {
		plan.set(node.vector, request(node.vector, grid, params, node.rangeMs, raw))
	}
	const walk = (node: Expr, grid: TimeGrid, raw: boolean): void => {
		switch (node.type) {
			case "NumberLiteral":
			case "StringLiteral":
				return
			case "VectorSelector":
				plan.set(node, request(node, grid, params, lookback, raw))
				return
			case "MatrixSelector":
				matrix(node, grid, raw)
				return
			case "Subquery":
				walk(node.expr, subqueryGrid(node, grid, params), false)
				return
			case "Paren":
			case "Unary":
				walk(node.expr, grid, raw)
				return
			case "Aggregate":
				if (node.param !== undefined) walk(node.param, grid, false)
				walk(node.expr, grid, false)
				return
			case "Binary":
				walk(node.lhs, grid, false)
				walk(node.rhs, grid, false)
				return
			case "Call": {
				const needsRaw = RAW_FUNCTIONS.has(node.func)
				for (const arg of node.args) walk(arg, grid, needsRaw)
				return
			}
		}
	}
	// A bare range selector returns its raw samples, parenthesized or not.
	walk(expr, top, unparen(expr).type === "MatrixSelector")
	return plan
}

/** A subtree a source may evaluate whole, and the one selector it reads. */
export interface PushdownCandidate {
	readonly request: PushdownRequest
	readonly selector: VectorSelector
}

const isPushdownFunction = (func: string): func is PushdownFunction =>
	func !== "last" && PUSHDOWN_FUNCTIONS.some((f) => f === func)

const isPushdownAggregation = (op: string): op is PushdownAggregation =>
	PUSHDOWN_AGGREGATIONS.some((a) => a === op)

/** `func(selector[range])`, or a bare selector read as its lookback (`last`). */
const pushableInner = (
	expr: Expr,
	lookbackMs: number,
): { selector: VectorSelector; func: PushdownFunction; rangeMs: number } | undefined => {
	const node = unparen(expr)
	if (node.type === "VectorSelector" && node.at === undefined)
		return { selector: node, func: "last", rangeMs: lookbackMs }
	if (node.type !== "Call" || !isPushdownFunction(node.func) || node.args.length !== 1) return undefined
	const arg = node.args[0]
	if (arg?.type !== "MatrixSelector" || arg.vector.at !== undefined) return undefined
	return { selector: arg.vector, func: node.func, rangeMs: arg.rangeMs }
}

/**
 * Subtrees of the top-level grid a source may evaluate whole: a range function
 * over a selector, or `sum|avg|min|max|count|group [by (...)]` over one or over a
 * bare selector. The source may decline any of them; the evaluator then reads
 * the selector as usual. Nothing inside a subquery is offered.
 */
export const planPushdowns = (expr: Expr, params: QueryParams): Map<Expr, PushdownCandidate> => {
	const out = new Map<Expr, PushdownCandidate>()
	const lookback = params.lookbackMs ?? LOOKBACK_MS
	const instant = isInstant(params) || params.stepMs <= 0
	const steps = instant ? 1 : Math.floor((params.endMs - params.startMs) / params.stepMs) + 1
	const offer = (
		node: Expr,
		inner: { selector: VectorSelector; func: PushdownFunction; rangeMs: number },
		aggregation: PushdownRequest["aggregation"],
	): boolean => {
		const widthMs = instant ? inner.rangeMs : gcd(params.stepMs, inner.rangeMs)
		if (widthMs < MIN_BUCKET_MS) return false
		out.set(node, {
			selector: inner.selector,
			request: {
				metricName: inner.selector.name,
				matchers: inner.selector.matchers,
				offsetMs: inner.selector.offsetMs,
				func: inner.func,
				rangeMs: inner.rangeMs,
				startMs: params.startMs,
				stepMs: instant ? 0 : params.stepMs,
				steps,
				widthMs,
				aggregation,
			},
		})
		return true
	}
	const walk = (node: Expr): void => {
		switch (node.type) {
			case "Aggregate": {
				const inner = pushableInner(node.expr, lookback)
				if (
					inner !== undefined &&
					isPushdownAggregation(node.op) &&
					!node.without &&
					node.param === undefined &&
					offer(node, inner, { op: node.op, by: node.grouping })
				) {
					return
				}
				if (node.param !== undefined) walk(node.param)
				walk(node.expr)
				return
			}
			case "Call": {
				const inner = pushableInner(node, lookback)
				if (inner !== undefined && inner.func !== "last" && offer(node, inner, undefined)) return
				for (const arg of node.args) walk(arg)
				return
			}
			case "Paren":
			case "Unary":
				walk(node.expr)
				return
			case "Binary":
				walk(node.lhs)
				walk(node.rhs)
				return
			case "NumberLiteral":
			case "StringLiteral":
			case "VectorSelector":
			case "MatrixSelector":
			case "Subquery":
				return
		}
	}
	walk(expr)
	return out
}

/** Prometheus' cap on points per series: steps of a range query, and points of every subquery. */
export const MAX_POINTS_PER_SERIES = 11_000

/**
 * Why the query would evaluate too many points per series, or undefined. Run it
 * before reading anything: a subquery like `x[1y:1ms]` is rejected here, not
 * after its selectors were read.
 */
export const resolutionError = (expr: Expr, params: QueryParams): string | undefined => {
	const points = (g: TimeGrid) => (g.stepMs > 0 ? Math.floor((g.endMs - g.startMs) / g.stepMs) + 1 : 1)
	const instant = isInstant(params)
	const top: TimeGrid = instant
		? { startMs: params.startMs, endMs: params.startMs, stepMs: 0 }
		: { startMs: params.startMs, endMs: params.endMs, stepMs: params.stepMs }
	if (!instant && params.stepMs <= 0) {
		return "zero or negative query resolution step widths are not accepted. Try a positive integer"
	}
	// Prometheus' API counts intervals, not points: 11,000 steps (11,001 points) still pass.
	if (!instant && Math.floor((params.endMs - params.startMs) / params.stepMs) > MAX_POINTS_PER_SERIES) {
		return `exceeded maximum resolution of ${MAX_POINTS_PER_SERIES.toLocaleString("en-US")} points per timeseries. Try decreasing the query resolution (?step=XX)`
	}
	const walk = (node: Expr, grid: TimeGrid): string | undefined => {
		switch (node.type) {
			case "Subquery": {
				const inner = subqueryGrid(node, grid, params)
				const n = points(inner)
				if (n > MAX_POINTS_PER_SERIES) {
					return `subquery resolution too fine: ${n} points per series, at most ${MAX_POINTS_PER_SERIES}; use a larger subquery step`
				}
				return walk(node.expr, inner)
			}
			case "Paren":
			case "Unary":
				return walk(node.expr, grid)
			case "Aggregate":
				return (
					(node.param === undefined ? undefined : walk(node.param, grid)) ?? walk(node.expr, grid)
				)
			case "Binary":
				return walk(node.lhs, grid) ?? walk(node.rhs, grid)
			case "Call":
				for (const arg of node.args) {
					const error = walk(arg, grid)
					if (error !== undefined) return error
				}
				return undefined
			case "NumberLiteral":
			case "StringLiteral":
			case "VectorSelector":
			case "MatrixSelector":
				return undefined
		}
	}
	return walk(expr, top)
}
