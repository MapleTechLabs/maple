// BOUNDARY: This module reads a model-authored ```chart fence and narrows it
// before it becomes a plot.
import { Option, Schema } from "effect"

/**
 * The chart a model may draw inside a reply.
 *
 * A table already carries the numbers; a chart is for the shape of them — a
 * latency climb, a burst of errors, a ranking. The payload mirrors the one
 * `query_data` returns (`{ bucket, series }` rows) so a chart the model writes
 * and a chart a tool result renders reach the same component with the same
 * rows.
 *
 * Everything here is model output, so a shape that does not decode leaves the
 * fence rendering as code rather than reaching a plot.
 */

/** A time bucket and the value of each series in it. */
const TimeseriesPoint = Schema.Struct({
	/** Anything `Date` parses — the charts drop a row whose bucket does not. */
	bucket: Schema.String,
	series: Schema.Record(Schema.String, Schema.Finite),
})

/** One named category and its value, for a ranking. */
const RankedPoint = Schema.Struct({
	name: Schema.String,
	value: Schema.Finite,
})

const TimeseriesSpec = Schema.Struct({
	type: Schema.Literals(["line", "area", "bar"]),
	title: Schema.optionalKey(Schema.String),
	unit: Schema.optionalKey(Schema.String),
	data: Schema.Array(TimeseriesPoint),
})

const RankedSpec = Schema.Struct({
	type: Schema.Literal("ranked"),
	title: Schema.optionalKey(Schema.String),
	unit: Schema.optionalKey(Schema.String),
	data: Schema.Array(RankedPoint),
})

const ChartSpec = Schema.Union([TimeseriesSpec, RankedSpec])
export type ChartSpec = Schema.Schema.Type<typeof ChartSpec>

// `fromJsonString` folds the parse and the shape check into one decode, so a
// truncated fence comes back as `None` instead of throwing.
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ChartSpec))

/**
 * The unit strings `formatValueByUnit` knows, and the shorthands a model writes
 * instead.
 *
 * Unit is normalized rather than validated: a chart is worth drawing with the
 * wrong axis suffix, and losing the whole plot because the model typed `ms` for
 * `duration_ms` is not a trade worth making. An unrecognized unit falls through
 * to plain numbers, which is what the formatter does with it anyway.
 */
const UNIT_ALIASES = new Map<string, string>([
	["%", "percent"],
	["count", "number"],
	["ms", "duration_ms"],
	["msec", "duration_ms"],
	["milliseconds", "duration_ms"],
	["ns", "duration_ns"],
	["req/s", "requests_per_sec"],
	["rps", "requests_per_sec"],
	["s", "duration_s"],
	["sec", "duration_s"],
	["seconds", "duration_s"],
	["us", "duration_us"],
	["µs", "duration_us"],
])

const KNOWN_UNITS = new Set([
	"bytes",
	"duration_ms",
	"duration_ns",
	"duration_s",
	"duration_us",
	"number",
	"percent",
	"percent_100",
	"requests_per_sec",
])

export function normalizeUnit(unit: string | undefined): string {
	if (!unit) return "number"
	const lower = unit.trim().toLowerCase()
	if (KNOWN_UNITS.has(lower)) return lower
	return UNIT_ALIASES.get(lower) ?? "number"
}

/**
 * The spec a fence holds, or null when it holds something else.
 *
 * An empty `data` array is a null too: a plot of nothing is a labelled blank
 * box, and the prose around it already says whatever the model meant by it.
 *
 * A timeseries row survives only if its bucket is a time and it names at least
 * one series — the schema cannot say either. A bucket `Date` rejects plots as
 * an `Invalid Date` tick, and a row with no series contributes nothing but a
 * gap, so both are dropped here rather than downstream.
 */
export function parseChartSpec(source: string): ChartSpec | null {
	const decoded = decode(source)
	if (Option.isNone(decoded)) return null
	const spec = decoded.value
	if (spec.type === "ranked") return spec.data.length === 0 ? null : spec
	const data = spec.data.filter(
		(point) => !Number.isNaN(Date.parse(point.bucket)) && Object.keys(point.series).length > 0,
	)
	return data.length === 0 ? null : { ...spec, data }
}

/** `{ bucket, series: { … } }` flattened to the `{ bucket, ...series }` rows every chart takes. */
export function timeseriesRows(
	data: ReadonlyArray<{ readonly bucket: string; readonly series: Readonly<Record<string, number>> }>,
): Array<Record<string, unknown>> {
	return data.map((point) => ({ bucket: point.bucket, ...point.series }))
}

/** Ranked points, copied into the plain rows the breakdown charts read. */
export function rankedRows(
	data: ReadonlyArray<{ readonly name: string; readonly value: number }>,
): Array<Record<string, unknown>> {
	return data.map((point) => ({ name: point.name, value: point.value }))
}
