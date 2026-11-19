// Prometheus' HTTP API wire format: request parameter parsing and the exact JSON bodies
// (`[<unix seconds>, "<value>"]` samples, Go float formatting, the error envelope).

import { DateTime, Effect, Option, Array as Arr, String as Str } from "effect"
import { parseDurationMs, type QueryResult } from "@maple/promql"
import { PromqlBadQueryError } from "@maple/backend/services/promql/PromqlQueryService"

const FLOAT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/

/**
 * Whether an RFC3339 match names a real calendar date and clock time, as Go's `time.Parse`
 * checks. JavaScript's Date would roll `24:00` or February 30 into another instant.
 */
const isRealTime = (match: RegExpExecArray): boolean => {
	const [
		,
		year = 0,
		month = 0,
		day = 0,
		hour = 0,
		minute = 0,
		second = 0,
		,
		offsetHour = 0,
		offsetMinute = 0,
	] = Arr.map(match, (part) => (part === undefined ? undefined : Number(part)))
	// Arithmetic, not Date.UTC, which reads years 0 to 99 as 1900 to 1999.
	const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
	const daysInMonth = month === 2 ? (isLeap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth &&
		hour < 24 &&
		minute < 60 &&
		second < 60 &&
		offsetHour < 24 &&
		offsetMinute < 60
	)
}

/** The largest epoch ms a JavaScript Date renders. */
export const MAX_DATE_MS = 8.64e15

/** A Prometheus timestamp: Unix seconds with an optional fraction, or RFC3339. Epoch ms. */
export const parseTime = (name: string, text: string): Effect.Effect<number, PromqlBadQueryError> => {
	if (FLOAT.test(text)) {
		const ms = Math.round(Number(text) * 1000)
		if (Math.abs(ms) <= MAX_DATE_MS) return Effect.succeed(ms)
	} else {
		const match = RFC3339.exec(text)
		const parsed = match !== null && isRealTime(match) ? DateTime.make(text) : Option.none()
		if (Option.isSome(parsed)) return Effect.succeed(DateTime.toEpochMillis(parsed.value))
	}
	return Effect.fail(
		new PromqlBadQueryError({
			message: `invalid parameter "${name}": cannot parse "${text}" to a valid timestamp`,
		}),
	)
}

/** A Prometheus duration (`30s`, `1m30s`) or float seconds. Epoch ms. */
export const parseStep = (text: string): Effect.Effect<number, PromqlBadQueryError> => {
	const ms = FLOAT.test(text) ? Math.round(Number(text) * 1000) : parseDurationMs(text)
	return ms !== undefined && Number.isFinite(ms)
		? Effect.succeed(ms)
		: Effect.fail(
				new PromqlBadQueryError({
					message: `invalid parameter "step": cannot parse "${text}" to a valid duration`,
				}),
			)
}

/** Moves the decimal point of `digits` (a plain decimal, no sign) by `exponent` places. */
const shiftPoint = (digits: string, exponent: number): string => {
	const [whole, fraction = ""] = Str.split(digits, ".")
	const all = whole + fraction
	const point = whole.length + exponent
	if (point <= 0) return `0.${Str.repeat(-point)("0")}${all}`
	if (point >= all.length) return all + Str.repeat(point - all.length)("0")
	return `${Str.slice(0, point)(all)}.${Str.slice(point)(all)}`
}

/** Go `strconv.FormatFloat(v, 'f', -1, 64)`: shortest round-trip digits, never an exponent. */
export const formatValue = (value: number): string => {
	if (Number.isNaN(value)) return "NaN"
	if (value === Infinity) return "+Inf"
	if (value === -Infinity) return "-Inf"
	if (Object.is(value, -0)) return "-0"
	const text = String(value)
	const [mantissa, exponent] = Str.split(text, "e")
	if (exponent === undefined) return text
	const negative = Str.startsWith("-")(mantissa)
	const shifted = shiftPoint(negative ? Str.slice(1)(mantissa) : mantissa, Number(exponent))
	return negative ? `-${shifted}` : shifted
}

type WirePoint = readonly [number, string]

const point = (t: number, v: number): WirePoint => [t / 1000, formatValue(v)]

/** The `data` of a query response. */
export const encodeQueryResult = (result: QueryResult) => {
	switch (result.resultType) {
		case "matrix":
			return {
				resultType: result.resultType,
				result: Arr.map(result.result, (series) => ({
					metric: series.labels,
					values: Arr.map(series.points, (p) => point(p.t, p.v)),
				})),
			}
		case "vector":
			return {
				resultType: result.resultType,
				result: Arr.map(result.result, (sample) => ({
					metric: sample.labels,
					value: point(sample.t, sample.value),
				})),
			}
		case "scalar":
			return { resultType: result.resultType, result: point(result.result.t, result.result.v) }
		case "string":
			return { resultType: result.resultType, result: [result.result.t / 1000, result.result.v] }
	}
}

export type PrometheusErrorType = "bad_data" | "execution" | "timeout" | "unavailable"

const ERROR_STATUS = {
	bad_data: 400,
	execution: 422,
	timeout: 503,
	unavailable: 503,
} satisfies Record<PrometheusErrorType, number>

export const errorStatus = (type: PrometheusErrorType): number => ERROR_STATUS[type]

export const errorBody = (type: PrometheusErrorType, error: string) => ({
	status: "error" as const,
	errorType: type,
	error,
})

export const successBody = <A>(data: A, warnings: ReadonlyArray<string> = []) =>
	warnings.length === 0
		? { status: "success" as const, data }
		: { status: "success" as const, data, warnings }

/** Prometheus' `limit` on a query: at most that many series, with a warning when some were cut. */
export const limitQueryResult = (
	result: QueryResult,
	limit: number | undefined,
): { readonly result: QueryResult; readonly warnings: ReadonlyArray<string> } => {
	if (limit === undefined) return { result, warnings: [] }
	const cut = [`results truncated due to limit`]
	switch (result.resultType) {
		case "matrix":
			return result.result.length > limit
				? { result: { ...result, result: Arr.take(result.result, limit) }, warnings: cut }
				: { result, warnings: [] }
		case "vector":
			return result.result.length > limit
				? { result: { ...result, result: Arr.take(result.result, limit) }, warnings: cut }
				: { result, warnings: [] }
		case "scalar":
		case "string":
			return { result, warnings: [] }
	}
}
