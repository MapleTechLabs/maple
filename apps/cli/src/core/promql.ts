// PromQL in the CLI, shared by both backends: the query is parsed here first, so a syntax error
// points at its position without a round trip, and every answer takes `query_promql`'s output shape.

import { Array as Arr, Effect, Option, Order, Result, String as Str } from "effect"
import {
	type Expr,
	MAX_POINTS_PER_SERIES,
	parse,
	type PromqlSyntaxError,
	type QueryParams,
	type QueryResult,
	valueTypeOf,
} from "@maple/promql"
import type { PromqlSampleValue, PromqlSeries, QueryPromqlOutput } from "@maple/domain/mcp-outputs"
import { CliUsageError } from "../lib/errors"
import { parseTimestampMs, type Range } from "./time"

export type PromqlOutput = typeof QueryPromqlOutput.Type

/** Series and points one answer keeps, the hosted tool's caps, so both modes print alike. */
export const MAX_SERIES = 20
export const MAX_POINTS = 200

/** The longest range evaluation, `query_promql`'s window cap. */
export const MAX_RANGE_DAYS = 7

export const EXAMPLE_QUERY = "sum by (job) (rate(http_server_request_duration_seconds_count[5m]))"

/** The query with a caret under `position`, on the line that holds it. */
export const caretLines = (query: string, position: number): ReadonlyArray<string> => {
	const lines = Str.split("\n")(query)
	const located = Arr.reduce(
		lines,
		{ offset: 0, line: Option.none<{ text: string; column: number }>() },
		(acc, text) => {
			const end = acc.offset + text.length
			const line =
				Option.isNone(acc.line) && position <= end
					? Option.some({ text, column: Math.max(0, position - acc.offset) })
					: acc.line
			return { offset: end + 1, line }
		},
	)
	const { text, column } = Option.getOrElse(located.line, () => ({
		text: lines[lines.length - 1] ?? "",
		column: (lines[lines.length - 1] ?? "").length,
	}))
	return [`  ${text}`, `  ${Str.repeat(column)(" ")}^`]
}

export const syntaxError = (query: string, error: PromqlSyntaxError): CliUsageError =>
	new CliUsageError({
		message: Arr.join(
			[
				`invalid PromQL at position ${error.position}: ${error.message}`,
				...caretLines(query, error.position),
			],
			"\n",
		),
		hint: `metric names are Prometheus-style, e.g. ${EXAMPLE_QUERY}; list them with \`maple promql metrics\``,
	})

/** Parse, and refuse what Prometheus refuses before evaluating: a range vector or string over a range. */
export const parseQuery = (query: string, instant: boolean): Effect.Effect<Expr, CliUsageError> => {
	const parsed = parse(query)
	if (Result.isFailure(parsed)) return Effect.fail(syntaxError(query, parsed.failure))
	const type = valueTypeOf(parsed.success)
	if (!instant && (type === "matrix" || type === "string")) {
		return Effect.fail(
			new CliUsageError({
				message: `a ${type === "matrix" ? "range vector" : "string"} cannot be evaluated over a range`,
				hint:
					type === "matrix"
						? "wrap it in a function such as rate(...), or pass --instant"
						: "pass --instant",
			}),
		)
	}
	return Effect.succeed(parsed.success)
}

const unitMs = (unit: string | undefined): number => {
	switch (unit) {
		case "ms":
			return 1
		case "m":
			return 60_000
		case "h":
			return 3_600_000
		case "d":
			return 86_400_000
		case "w":
			return 604_800_000
		case "y":
			return 31_536_000_000
		default:
			return 1000
	}
}
const DURATION = /^(?:\d+(?:ms|s|m|h|d|w|y))+$/
const DURATION_PART = /(\d+)(ms|s|m|h|d|w|y)/g

/** Decimal seconds as whole milliseconds, up to float rounding; a real fraction of one is refused. */
const secondsToMs = (seconds: number): number => {
	const exact = seconds * 1000
	const ms = Math.round(exact)
	return Math.abs(exact - ms) <= 8 * Number.EPSILON * Math.max(1, Math.abs(exact)) ? ms : Number.NaN
}

/**
 * A Prometheus duration (`30s`, `1m30s`) or decimal seconds, as a positive whole number of
 * milliseconds. The hosted `query_promql` reads `step` with these rules, so both modes agree.
 */
export const parseStepMs = (raw: string): number | undefined => {
	const text = Str.trim(raw)
	const ms = DURATION.test(text)
		? Arr.reduce(
				Arr.fromIterable(Str.matchAll(DURATION_PART)(text)),
				0,
				(total, part) => total + Number(part[1]) * unitMs(part[2]),
			)
		: text === ""
			? Number.NaN
			: secondsToMs(Number(text))
	return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

// Short windows step in seconds too, so a 2-minute spike still gets 60 to 120 points.
const NICE_STEPS = [
	1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400,
]

/** The smallest round step that keeps a range at no more than 120 points. */
export const defaultStepSeconds = (rangeSeconds: number): number =>
	Option.getOrElse(
		Arr.findFirst(NICE_STEPS, (step) => rangeSeconds / step <= 120),
		() => Math.ceil(rangeSeconds / 120),
	)

export interface PromqlWindow extends QueryParams {
	readonly range: Range
	readonly stepSeconds: number
}

/** The evaluation grid: once at the window's end with --instant, else every step across it. */
export const evaluationWindow = (p: {
	readonly range: Range
	readonly step?: string
	readonly instant: boolean
}): Effect.Effect<PromqlWindow, CliUsageError> => {
	const endMs = parseTimestampMs(p.range.endTime) ?? Number.NaN
	if (p.instant) return Effect.succeed({ range: p.range, startMs: endMs, endMs, stepMs: 0, stepSeconds: 0 })
	const startMs = parseTimestampMs(p.range.startTime) ?? Number.NaN
	const rangeSeconds = (endMs - startMs) / 1000
	// The hosted tool narrows a longer window without saying so; refuse it in both modes instead.
	if (rangeSeconds > MAX_RANGE_DAYS * 86_400) {
		return Effect.fail(
			new CliUsageError({
				message: `a PromQL range covers at most ${MAX_RANGE_DAYS}d`,
				hint: `use --since ${MAX_RANGE_DAYS}d or a shorter --start/--end, or --instant with a range function such as max_over_time(x[30d])`,
			}),
		)
	}
	const requested = p.step === undefined ? undefined : parseStepMs(p.step)
	if (p.step !== undefined && requested === undefined) {
		return Effect.fail(
			new CliUsageError({
				message: `--step "${p.step}" is not a Prometheus duration or a number of seconds`,
				hint: "e.g. --step 30s, --step 1m, --step 1h",
			}),
		)
	}
	const stepMs = requested ?? defaultStepSeconds(rangeSeconds) * 1000
	if (Math.floor((endMs - startMs) / stepMs) > MAX_POINTS_PER_SERIES) {
		return Effect.fail(
			new CliUsageError({
				message: `--step ${p.step ?? `${stepMs / 1000}s`} gives more than ${MAX_POINTS_PER_SERIES} steps over this window`,
				hint: `use at least --step ${Math.ceil(rangeSeconds / MAX_POINTS_PER_SERIES)}s, or a shorter window`,
			}),
		)
	}
	return Effect.succeed({ range: p.range, startMs, endMs, stepMs, stepSeconds: stepMs / 1000 })
}

/** Prometheus' spelling of a non-finite sample, so the output survives JSON. */
export const encodeSample = (value: number): typeof PromqlSampleValue.Type =>
	Number.isFinite(value) ? value : Number.isNaN(value) ? "NaN" : value > 0 ? "+Inf" : "-Inf"

interface RawSeries {
	readonly labels: Readonly<Record<string, string>>
	readonly points: ReadonlyArray<{ readonly t: number; readonly v: number }>
}

const rawSeries = (result: QueryResult): ReadonlyArray<RawSeries> => {
	switch (result.resultType) {
		case "matrix":
			return result.result
		case "vector":
			return Arr.map(result.result, (s) => ({ labels: s.labels, points: [{ t: s.t, v: s.value }] }))
		case "scalar":
			return [{ labels: {}, points: [result.result] }]
		case "string":
			return []
	}
}

// NaN never ranks; +Inf (a division by zero) ranks highest, as the peak it is.
const peak = (series: RawSeries): number =>
	Arr.reduce(series.points, Number.NEGATIVE_INFINITY, (max, p) =>
		!Number.isNaN(p.v) && p.v > max ? p.v : max,
	)

const byPeakDescending = Order.mapInput(
	Order.flip(Order.Number),
	([max]: readonly [number, RawSeries]) => max,
)

/** Min, average and max over every point before the cap; infinities count, NaN does not. */
const seriesStats = (series: RawSeries) => {
	const values = Arr.filter(
		Arr.map(series.points, (p) => p.v),
		(v) => !Number.isNaN(v),
	)
	if (values.length === 0) return undefined
	return {
		min: encodeSample(Arr.reduce(values, Infinity, (a, b) => Math.min(a, b))),
		avg: encodeSample(Arr.reduce(values, 0, (a, b) => a + b) / values.length),
		max: encodeSample(Arr.reduce(values, -Infinity, (a, b) => Math.max(a, b))),
	}
}

/** Over {@link MAX_SERIES}, the series with the highest peaks; each keeps its last {@link MAX_POINTS} points. */
const capSeries = (all: ReadonlyArray<RawSeries>): ReadonlyArray<typeof PromqlSeries.Type> => {
	const kept =
		all.length > MAX_SERIES
			? Arr.map(
					Arr.take(
						Arr.sort(
							Arr.map(all, (series) => [peak(series), series] as const),
							byPeakDescending,
						),
						MAX_SERIES,
					),
					([, series]) => series,
				)
			: all
	return Arr.map(kept, (series) => {
		const stats = seriesStats(series)
		return {
			labels: series.labels,
			points: Arr.map(Arr.takeRight(series.points, MAX_POINTS), (p) => ({
				t: p.t,
				v: encodeSample(p.v),
			})),
			totalPoints: series.points.length,
			...(stats === undefined ? undefined : { stats }),
		}
	})
}

/** An evaluation as `query_promql` reports it, so `--format json` is the same in both modes. */
export const toPromqlOutput = (query: string, window: PromqlWindow, result: QueryResult): PromqlOutput => {
	const all = rawSeries(result)
	return {
		query,
		resultType: result.resultType,
		instant: window.stepMs === 0,
		timeRange: { start: window.range.startTime, end: window.range.endTime },
		stepSeconds: window.stepSeconds,
		series: capSeries(all),
		totalSeries: all.length,
		...(result.resultType === "string" ? { stringValue: result.result.v } : undefined),
	}
}
