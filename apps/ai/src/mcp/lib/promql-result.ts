// Turns a PromQL evaluation into query_promql's output: steps, capped series, encoded values.
import { Array as Arr, Option, Order, String as Str, type Context, type Effect } from "effect"
import type { PromqlQueryService } from "@maple/backend/services/promql/PromqlQueryService"
import type { PromqlSampleValue, PromqlSeries, QueryPromqlOutput } from "@maple/domain/mcp-outputs"

export type PromqlResult = Effect.Success<
	ReturnType<Context.Service.Shape<typeof PromqlQueryService>["query"]>
>

export const MAX_SERIES = 20
export const MAX_POINTS = 200

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

/**
 * Float seconds as whole milliseconds, when they are whole up to float rounding (`1.001` is 1001);
 * a real fraction of a millisecond (`1000.0005`) is refused at any scale.
 */
const secondsToMs = (seconds: number): number => {
	const exact = seconds * 1000
	const ms = Math.round(exact)
	return Math.abs(exact - ms) <= 8 * Number.EPSILON * Math.max(1, Math.abs(exact)) ? ms : Number.NaN
}

/**
 * A Prometheus duration (`1m`, `1h30m`) or float seconds, as whole milliseconds; undefined when
 * neither, or when it is not a positive whole number of milliseconds the engine can step by.
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

/** Prometheus' spelling of a non-finite sample, so the output survives JSON. */
export const encodeSample = (value: number): typeof PromqlSampleValue.Type =>
	Number.isFinite(value) ? value : Number.isNaN(value) ? "NaN" : value > 0 ? "+Inf" : "-Inf"

interface RawSeries {
	readonly labels: Readonly<Record<string, string>>
	readonly points: ReadonlyArray<{ readonly t: number; readonly v: number }>
}

const rawSeries = (result: PromqlResult): ReadonlyArray<RawSeries> => {
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

const peak = (series: RawSeries): number =>
	Arr.reduce(series.points, Number.NEGATIVE_INFINITY, (max, p) =>
		// NaN never ranks; +Inf (a division by zero) ranks highest, as the peak it is.
		!Number.isNaN(p.v) && p.v > max ? p.v : max,
	)

// Peaks are computed once per series, not once per comparison.
const byPeakDescending = Order.mapInput(
	Order.flip(Order.Number),
	([max]: readonly [number, RawSeries]) => max,
)

/** Over {@link MAX_SERIES}, the series with the highest peaks; each keeps its last {@link MAX_POINTS} points. */
export const capSeries = (result: PromqlResult): ReadonlyArray<typeof PromqlSeries.Type> => {
	const all = rawSeries(result)
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

/** Min, average and max over every point before the cap; infinities count, NaN does not. */
const seriesStats = (series: RawSeries) => {
	const values = Arr.filter(
		Arr.map(series.points, (p) => p.v),
		(v) => !Number.isNaN(v),
	)
	if (values.length === 0) return undefined
	const sum = Arr.reduce(values, 0, (a, b) => a + b)
	return {
		min: encodeSample(Arr.reduce(values, Infinity, (a, b) => Math.min(a, b))),
		avg: encodeSample(sum / values.length),
		max: encodeSample(Arr.reduce(values, -Infinity, (a, b) => Math.max(a, b))),
	}
}

export const toOutput = (input: {
	readonly query: string
	readonly instant: boolean
	readonly timeRange: { readonly start: string; readonly end: string }
	readonly stepSeconds: number
	readonly result: PromqlResult
}): typeof QueryPromqlOutput.Type => ({
	query: input.query,
	resultType: input.result.resultType,
	instant: input.instant,
	timeRange: input.timeRange,
	stepSeconds: input.stepSeconds,
	series: capSeries(input.result),
	totalSeries: rawSeries(input.result).length,
	...(input.result.resultType === "string" ? { stringValue: input.result.result.v } : undefined),
})
