import { Option, Result } from "effect"
import {
	compareLabels,
	dropMetricName,
	ensureUniqueLabelsets,
	type EvalError,
	evalError,
	isValidLabelName,
	makeLabels,
} from "./labels"
import type { InstantVector, Labels, Sample } from "./types"
import { lookup } from "../lookup"

type R = Result.Result<InstantVector, EvalError>

const SIMPLE = {
	abs: Math.abs,
	ceil: Math.ceil,
	floor: Math.floor,
	exp: Math.exp,
	ln: Math.log,
	log2: Math.log2,
	log10: Math.log10,
	sqrt: Math.sqrt,
	sgn: (v) => (v < 0 ? -1 : v > 0 ? 1 : v),
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	sinh: Math.sinh,
	cosh: Math.cosh,
	tanh: Math.tanh,
	asinh: Math.asinh,
	acosh: Math.acosh,
	atanh: Math.atanh,
	deg: (v) => (v * 180) / Math.PI,
	rad: (v: number) => (v * Math.PI) / 180,
} satisfies Record<string, (v: number) => number>

/** Go's time functions on `time.Unix(floor(v), 0).UTC()`. */
const DATE = {
	day_of_month: (d) => d.getUTCDate(),
	day_of_week: (d) => d.getUTCDay(),
	day_of_year: (d) =>
		(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) /
			86_400_000 +
		1,
	days_in_month: (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(),
	hour: (d) => d.getUTCHours(),
	minute: (d) => d.getUTCMinutes(),
	month: (d) => d.getUTCMonth() + 1,
	year: (d: Date) => d.getUTCFullYear(),
} satisfies Record<string, (d: Date) => number>

/** Applies `f` to every value and drops __name__, like Prometheus' simpleFloatFunc. */
const mapValues = (vector: InstantVector, evalTimeMs: number, f: (v: number) => number): R =>
	ensureUniqueLabelsets(
		vector.map((s) => ({ labels: dropMetricName(s.labels), value: f(s.value), t: evalTimeMs })),
	)

const numberParam = (
	params: ReadonlyArray<number | string>,
	index: number,
	func: string,
): Result.Result<number, EvalError> => {
	const value = params[index]
	return typeof value === "number"
		? Result.succeed(value)
		: Result.fail(evalError(`${func}: expected a number argument`))
}

const stringParam = (
	params: ReadonlyArray<number | string>,
	index: number,
	func: string,
): Result.Result<string, EvalError> => {
	const value = params[index]
	return typeof value === "string"
		? Result.succeed(value)
		: Result.fail(evalError(`${func}: expected a string argument`))
}

const MAX_INT64 = 9_223_372_036_854_775_807n

/** strconv.Atoi on a digit chunk: undefined when it is not digits or overflows int64. */
const atoi = (chunk: string): bigint | undefined => {
	if (!/^\d+$/.test(chunk)) return undefined
	const n = BigInt(chunk)
	return n > MAX_INT64 ? undefined : n
}

/** A port of github.com/facette/natsort Compare, which Prometheus' sort_by_label uses. */
export const natsortLess = (a: string, b: string): boolean => {
	const chunksA = a.match(/\d+|\D+/g) ?? []
	const chunksB = b.match(/\d+|\D+/g) ?? []
	for (let i = 0; i < chunksA.length; i++) {
		if (i >= chunksB.length) return false
		const ca = chunksA[i] ?? ""
		const cb = chunksB[i] ?? ""
		const ia = atoi(ca)
		const ib = atoi(cb)
		const both = ia !== undefined && ib !== undefined
		if (both ? ia === ib : ca === cb) {
			if (i === chunksA.length - 1) return true
			if (i === chunksB.length - 1) return false
			continue
		}
		return both ? ia < ib : ca < cb
	}
	return false
}

const sortByLabel = (vector: InstantVector, names: ReadonlyArray<string>, desc: boolean): InstantVector =>
	[...vector].sort((a, b) => {
		for (const name of names) {
			const va = a.labels[name] ?? ""
			const vb = b.labels[name] ?? ""
			if (va === vb) continue
			return natsortLess(va, vb) === desc ? 1 : -1
		}
		return desc ? -compareLabels(a.labels, b.labels) : compareLabels(a.labels, b.labels)
	})

/** sort and sort_desc: NaN sorts last either way, like Prometheus' value heaps. */
const sortByValue = (vector: InstantVector, desc: boolean): InstantVector =>
	[...vector].sort((a, b) => {
		const an = Number.isNaN(a.value)
		const bn = Number.isNaN(b.value)
		if (an || bn) return an === bn ? 0 : an ? 1 : -1
		if (a.value === b.value) return 0
		return a.value < b.value === desc ? 1 : -1
	})

/** RE2 syntax to JS: named groups `(?P<n>` become `(?<n>`; `s` mirrors Prometheus' `(?s:...)` wrapper. */
const compileGoRegex = Option.liftThrowable(
	(pattern: string) => new RegExp(`^(?:${pattern.replace(/\(\?P</g, "(?<")})$`, "s"),
)

/** Go's regexp.Expand: `$1`, `${1}`, `$name`, `${name}`, `$$`; a malformed `$` is copied as is. */
export const expandTemplate = (template: string, match: RegExpExecArray): string => {
	let out = ""
	let rest = template
	while (rest.length > 0) {
		const dollar = rest.indexOf("$")
		if (dollar < 0) return out + rest
		out += rest.slice(0, dollar)
		rest = rest.slice(dollar)
		if (rest.startsWith("$$")) {
			out += "$"
			rest = rest.slice(2)
			continue
		}
		const ref = /^\$(?:\{(\w+)\}|(\w+))/.exec(rest)
		const name = ref?.[1] ?? ref?.[2]
		if (ref === null || name === undefined) {
			out += "$"
			rest = rest.slice(1)
			continue
		}
		rest = rest.slice(ref[0].length)
		out += /^\d+$/.test(name) ? (match[Number(name)] ?? "") : (match.groups?.[name] ?? "")
	}
	return out
}

const setLabel = (labels: Labels, name: string, value: string): Labels =>
	makeLabels([...Object.entries(labels).filter(([n]) => n !== name), [name, value]])

const labelReplace = (vector: InstantVector, params: ReadonlyArray<number | string>, evalTimeMs: number): R =>
	Result.gen(function* () {
		const dst = yield* stringParam(params, 0, "label_replace")
		const repl = yield* stringParam(params, 1, "label_replace")
		const src = yield* stringParam(params, 2, "label_replace")
		const regexStr = yield* stringParam(params, 3, "label_replace")
		const regex = compileGoRegex(regexStr)
		if (Option.isNone(regex)) {
			return yield* Result.fail(evalError(`invalid regular expression in label_replace(): ${regexStr}`))
		}
		if (!isValidLabelName(dst)) {
			return yield* Result.fail(evalError(`invalid destination label name in label_replace(): ${dst}`))
		}
		const out = vector.map((s): Sample => {
			const match = regex.value.exec(s.labels[src] ?? "")
			const labels = match === null ? s.labels : setLabel(s.labels, dst, expandTemplate(repl, match))
			return { labels, value: s.value, t: evalTimeMs }
		})
		return yield* ensureUniqueLabelsets(out)
	})

const labelJoin = (vector: InstantVector, params: ReadonlyArray<number | string>, evalTimeMs: number): R =>
	Result.gen(function* () {
		const dst = yield* stringParam(params, 0, "label_join")
		const sep = yield* stringParam(params, 1, "label_join")
		const srcs: string[] = []
		for (let i = 2; i < params.length; i++) {
			const src = yield* stringParam(params, i, "label_join")
			if (!isValidLabelName(src)) {
				return yield* Result.fail(evalError(`invalid source label name in label_join(): ${src}`))
			}
			srcs.push(src)
		}
		if (!isValidLabelName(dst)) {
			return yield* Result.fail(evalError(`invalid destination label name in label_join(): ${dst}`))
		}
		const out = vector.map((s): Sample => {
			const joined = srcs.map((src) => s.labels[src] ?? "").join(sep)
			return { labels: setLabel(s.labels, dst, joined), value: s.value, t: evalTimeMs }
		})
		return yield* ensureUniqueLabelsets(out)
	})

const clamp = (vector: InstantVector, min: number, max: number, evalTimeMs: number): R =>
	max < min ? Result.succeed([]) : mapValues(vector, evalTimeMs, (v) => Math.max(min, Math.min(max, v)))

export const instantFunction = (
	func: string,
	vector: InstantVector,
	params: ReadonlyArray<number | string>,
	evalTimeMs: number,
): R => {
	const simple = lookup(SIMPLE, func)
	if (simple !== undefined) return mapValues(vector, evalTimeMs, simple)
	const date = lookup(DATE, func)
	if (date !== undefined) return mapValues(vector, evalTimeMs, (v) => date(new Date(Math.floor(v) * 1000)))
	switch (func) {
		case "clamp":
			return Result.flatMap(
				Result.all([numberParam(params, 0, func), numberParam(params, 1, func)]),
				([min, max]) => clamp(vector, min, max, evalTimeMs),
			)
		case "clamp_min":
			return Result.flatMap(numberParam(params, 0, func), (min) =>
				clamp(vector, min, Infinity, evalTimeMs),
			)
		case "clamp_max":
			return Result.flatMap(numberParam(params, 0, func), (max) =>
				clamp(vector, -Infinity, max, evalTimeMs),
			)
		case "round": {
			const toNearest = params.length === 0 ? Result.succeed(1) : numberParam(params, 0, func)
			return Result.flatMap(toNearest, (n) => {
				const inverse = 1 / n
				return mapValues(vector, evalTimeMs, (v) => Math.floor(v * inverse + 0.5) / inverse)
			})
		}
		case "timestamp":
			return ensureUniqueLabelsets(
				vector.map((s) => ({ labels: dropMetricName(s.labels), value: s.t / 1000, t: evalTimeMs })),
			)
		case "label_replace":
			return labelReplace(vector, params, evalTimeMs)
		case "label_join":
			return labelJoin(vector, params, evalTimeMs)
		case "sort":
		case "sort_desc":
			return Result.succeed(
				sortByValue(vector, func === "sort_desc").map((s) => ({ ...s, t: evalTimeMs })),
			)
		case "sort_by_label":
		case "sort_by_label_desc":
			return Result.flatMap(Result.all(params.map((_, i) => stringParam(params, i, func))), (names) =>
				Result.succeed(
					sortByLabel(vector, names, func === "sort_by_label_desc").map((s) => ({
						...s,
						t: evalTimeMs,
					})),
				),
			)
		default:
			return Result.fail(evalError(`function ${func} is not supported on instant vectors`))
	}
}
