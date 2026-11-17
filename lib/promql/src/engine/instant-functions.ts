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
import { anchoredRegex, type RegexMatch } from "../regex"

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
interface CivilTime {
	readonly year: number
	readonly month: number
	readonly day: number
	readonly dayOfYear: number
	readonly weekday: number
	readonly hour: number
	readonly minute: number
}

const INT64_MAX = 2n ** 63n - 1n
const INT64_MIN = -(2n ** 63n)

/** Go's int64(f): truncates toward zero, saturating (NaN is 0) as on the arm64 reference build. */
const goInt64 = (value: number): bigint => {
	if (Number.isNaN(value)) return 0n
	if (value >= 2 ** 63) return INT64_MAX
	if (value < -(2 ** 63)) return INT64_MIN
	return BigInt(Math.trunc(value))
}

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/** Proleptic Gregorian UTC fields of whole unix seconds (Hinnant's civil_from_days), past JS Date's range. */
const civilTime = (unixSeconds: bigint): CivilTime => {
	const floorDays = unixSeconds / 86_400n - (unixSeconds % 86_400n < 0n ? 1n : 0n)
	const secondOfDay = Number(unixSeconds - floorDays * 86_400n)
	const days = Number(floorDays)
	const z = days + 719_468
	const era = Math.floor(z / 146_097)
	const dayOfEra = z - era * 146_097
	const yearOfEra = Math.floor(
		(dayOfEra -
			Math.floor(dayOfEra / 1460) +
			Math.floor(dayOfEra / 36_524) -
			Math.floor(dayOfEra / 146_096)) /
			365,
	)
	const dayOfMarchYear =
		dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
	const monthFromMarch = Math.floor((5 * dayOfMarchYear + 2) / 153)
	const day = dayOfMarchYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1
	const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9
	const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
	// Days from 1 Jan to 1 Mar, then the March-based day count.
	const marchFirst = 59 + (isLeap(year) ? 1 : 0)
	const dayOfYear = month <= 2 ? dayOfMarchYear - 305 : marchFirst + dayOfMarchYear + 1
	return {
		year,
		month,
		day,
		dayOfYear,
		weekday: (((days + 4) % 7) + 7) % 7,
		hour: Math.floor(secondOfDay / 3600),
		minute: Math.floor((secondOfDay % 3600) / 60),
	}
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const DATE = {
	day_of_month: (d) => d.day,
	day_of_week: (d) => d.weekday,
	day_of_year: (d) => d.dayOfYear,
	days_in_month: (d) => (d.month === 2 && isLeap(d.year) ? 29 : (DAYS_IN_MONTH[d.month - 1] ?? 31)),
	hour: (d) => d.hour,
	minute: (d) => d.minute,
	month: (d) => d.month,
	year: (d: CivilTime) => d.year,
} satisfies Record<string, (d: CivilTime) => number>

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
			const va = lookup(a.labels, name) ?? ""
			const vb = lookup(b.labels, name) ?? ""
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

/** Go's regexp.Expand: `$1`, `${1}`, `$name`, `${name}`, `$$`; a malformed `$` is copied as is. */
export const expandTemplate = (template: string, match: RegexMatch): string => {
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
		out += (/^\d+$/.test(name) ? match.group(Number(name)) : match.group(name)) ?? ""
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
		const regex = anchoredRegex(regexStr)
		if (Option.isNone(regex)) {
			return yield* Result.fail(evalError(`invalid regular expression in label_replace(): ${regexStr}`))
		}
		if (!isValidLabelName(dst)) {
			return yield* Result.fail(evalError(`invalid destination label name in label_replace(): ${dst}`))
		}
		const out = vector.map((s): Sample => {
			const match = regex.value.exec(lookup(s.labels, src) ?? "")
			const labels =
				match === undefined ? s.labels : setLabel(s.labels, dst, expandTemplate(repl, match))
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
			const joined = srcs.map((src) => lookup(s.labels, src) ?? "").join(sep)
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
	if (date !== undefined) return mapValues(vector, evalTimeMs, (v) => date(civilTime(goInt64(v))))
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
