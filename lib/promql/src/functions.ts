import type { ValueType } from "./ast"
import { lookup } from "./lookup"

export interface FunctionSignature {
	readonly args: ReadonlyArray<ValueType>
	/** How many trailing args may be left out (-1: the last arg repeats without limit). */
	readonly optional: number
	readonly returns: ValueType
}

const sig = (args: ReadonlyArray<ValueType>, returns: ValueType, optional = 0): FunctionSignature => ({
	args,
	returns,
	optional,
})

const V: ValueType = "vector"
const M: ValueType = "matrix"
const S: ValueType = "scalar"
const STR: ValueType = "string"

const vectorMath = sig([V], V)
const overTime = sig([M], V)
const dateFn = sig([V], V, 1)

/** The PromQL functions Maple evaluates (Prometheus 3.5), by name; `info()` is left out. */
export const FUNCTIONS = {
	abs: vectorMath,
	absent: vectorMath,
	absent_over_time: overTime,
	acos: vectorMath,
	acosh: vectorMath,
	asin: vectorMath,
	asinh: vectorMath,
	atan: vectorMath,
	atanh: vectorMath,
	avg_over_time: overTime,
	ceil: vectorMath,
	changes: overTime,
	clamp: sig([V, S, S], V),
	clamp_max: sig([V, S], V),
	clamp_min: sig([V, S], V),
	cos: vectorMath,
	cosh: vectorMath,
	count_over_time: overTime,
	day_of_month: dateFn,
	day_of_week: dateFn,
	day_of_year: dateFn,
	days_in_month: dateFn,
	deg: vectorMath,
	delta: overTime,
	deriv: overTime,
	exp: vectorMath,
	floor: vectorMath,
	histogram_avg: vectorMath,
	histogram_count: vectorMath,
	histogram_fraction: sig([S, S, V], V),
	histogram_quantile: sig([S, V], V),
	histogram_stddev: vectorMath,
	histogram_stdvar: vectorMath,
	histogram_sum: vectorMath,
	holt_winters: sig([M, S, S], V),
	double_exponential_smoothing: sig([M, S, S], V),
	hour: dateFn,
	idelta: overTime,
	increase: overTime,
	irate: overTime,
	label_join: sig([V, STR, STR, STR], V, -1),
	label_replace: sig([V, STR, STR, STR, STR], V),
	last_over_time: overTime,
	ln: vectorMath,
	log10: vectorMath,
	log2: vectorMath,
	max_over_time: overTime,
	mad_over_time: overTime,
	min_over_time: overTime,
	minute: dateFn,
	month: dateFn,
	pi: sig([], S),
	predict_linear: sig([M, S], V),
	present_over_time: overTime,
	quantile_over_time: sig([S, M], V),
	rad: vectorMath,
	rate: overTime,
	resets: overTime,
	round: sig([V, S], V, 1),
	scalar: sig([V], S),
	sgn: vectorMath,
	sin: vectorMath,
	sinh: vectorMath,
	sort: vectorMath,
	sort_desc: vectorMath,
	sort_by_label: sig([V, STR], V, -1),
	sort_by_label_desc: sig([V, STR], V, -1),
	sqrt: vectorMath,
	stddev_over_time: overTime,
	stdvar_over_time: overTime,
	sum_over_time: overTime,
	tan: vectorMath,
	tanh: vectorMath,
	time: sig([], S),
	timestamp: vectorMath,
	vector: sig([S], V),
	year: dateFn,
} satisfies Record<string, FunctionSignature>

export const functionSignature = (name: string): FunctionSignature | undefined => lookup(FUNCTIONS, name)
