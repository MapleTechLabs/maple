// BOUNDARY: This module reads a model-authored ```chart fence and narrows it
// before it becomes a plot.
import { Option, Schema } from "effect"
import type { ChartUnit } from "@maple/widgets/chart/static-chart"

/**
 * The chart a model may draw inside a reply, and the schema that decides whether a fence holds
 * one. The agent is taught to write it (see the chat prompt); every consumer of a reply — the web
 * transcript, a chat-platform bot — reads it back through this module.
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
export const TimeseriesPoint = Schema.Struct({
	/** Anything `Date` parses — the charts drop a row whose bucket does not. */
	bucket: Schema.String,
	series: Schema.Record(Schema.String, Schema.Finite),
})

/** One named category and its value, for a ranking. */
export const RankedPoint = Schema.Struct({
	name: Schema.String,
	value: Schema.Finite,
})

export const TimeseriesSpec = Schema.Struct({
	type: Schema.Literals(["line", "area", "bar"]),
	title: Schema.optionalKey(Schema.String),
	unit: Schema.optionalKey(Schema.String),
	data: Schema.Array(TimeseriesPoint),
})
export type TimeseriesSpec = Schema.Schema.Type<typeof TimeseriesSpec>

export const RankedSpec = Schema.Struct({
	type: Schema.Literal("ranked"),
	title: Schema.optionalKey(Schema.String),
	unit: Schema.optionalKey(Schema.String),
	data: Schema.Array(RankedPoint),
})
export type RankedSpec = Schema.Schema.Type<typeof RankedSpec>

export const ChartSpec = Schema.Union([TimeseriesSpec, RankedSpec])
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
 *
 * A fence's `percent` is the number as a reader says it — 92.86 is 92.86% — so
 * it lands on the formatter's `percent_100`, not its 0–1 `percent`. Tools print
 * rates to the model as `92.86%`, and a fraction contract had it charting the
 * printed number 100x high. `fraction` is there for a model holding 0–1 values.
 */
const UNIT_ALIASES = new Map<string, string>([
	["%", "percent_100"],
	["fraction", "percent"],
	["percent", "percent_100"],
	["ratio", "percent"],
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
	"percent_100",
	"requests_per_sec",
])

/** A model-written unit, resolved to one `formatValueByUnit` knows, or `"number"`. */
export function normalizeUnit(unit: string | undefined): string {
	if (!unit) return "number"
	const lower = unit.trim().toLowerCase()
	if (KNOWN_UNITS.has(lower)) return lower
	return UNIT_ALIASES.get(lower) ?? "number"
}

/**
 * The same unit as the *static* renderer names them, plus the factor its values
 * need to be in it.
 *
 * `@maple/widgets`' image renderer knows five units where
 * `formatValueByUnit` knows nine, so the four it does not carry are converted
 * rather than dropped: a chart labelled `s` keeps reading in seconds because
 * the formatter scales milliseconds back up, and one labelled `ratio` keeps
 * reading as a percentage because 0–1 is scaled onto the renderer's 0–100
 * `percent`. Dropping to plain numbers instead would strip the axis suffix off
 * exactly the charts that need it most.
 */
export function staticChartUnit(unit: string | undefined): {
	readonly unit: ChartUnit
	readonly scale: number
} {
	switch (normalizeUnit(unit)) {
		case "bytes":
			return { unit: "bytes", scale: 1 }
		case "duration_ms":
			return { unit: "duration_ms", scale: 1 }
		case "duration_ns":
			return { unit: "duration_ms", scale: 1 / 1_000_000 }
		case "duration_s":
			return { unit: "duration_ms", scale: 1000 }
		case "duration_us":
			return { unit: "duration_ms", scale: 1 / 1000 }
		case "percent_100":
			return { unit: "percent", scale: 1 }
		// `normalizeUnit` reserves a bare `percent` for the 0–1 aliases.
		case "percent":
			return { unit: "percent", scale: 100 }
		case "requests_per_sec":
			return { unit: "requests_per_sec", scale: 1 }
		default:
			return { unit: "number", scale: 1 }
	}
}

const FENCE_OPEN = /^\s{0,3}(`{3,})\s*([^\s`]*)/
const CHART_FENCE_INFO = "chart"

/**
 * A reply cut into the prose between its charts and the charts themselves.
 *
 * `closed` is false for a fence whose closing line has not arrived — a reply
 * still streaming. It is always the last part, so a consumer may drop it
 * without shifting anything before it.
 */
export type ChartFencePart =
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "chart"; readonly value: string; readonly closed: boolean }

/**
 * A reply, split at its ```chart fences, in the order they appear in it.
 *
 * **Position is the identity of a chart.** A reply can hold several, nothing
 * numbers them, and the image URL for one has to name it somehow. Order of
 * appearance is the one answer every consumer can reach independently, so it is
 * the contract — and the reason this is one function rather than one per
 * surface. Two implementations of it disagreed once: counting only the fences
 * that *parsed* renumbered every chart after a malformed one, so a reader got
 * the wrong plot under the right words.
 *
 * Counted on the way in, therefore, before anything asks whether the payload is
 * a chart at all. A caller that cannot draw the Nth fence skips it; it does not
 * renumber the rest.
 *
 * A line scan rather than a regex over the whole reply: a fence is a line
 * construct, fences nest, a chart payload can legitimately contain a line of
 * backticks, and a regex that pairs the wrong two of them silently reindexes
 * everything after it. Fences that are not charts keep their own lines and pass
 * through as prose, so splitting a reply and rejoining it loses nothing.
 */
export function splitChartFences(text: string): ReadonlyArray<ChartFencePart> {
	const parts: Array<ChartFencePart> = []
	let prose: Array<string> = []
	let open: { readonly ticks: number; readonly isChart: boolean } | undefined
	let body: Array<string> = []

	const flushProse = () => {
		parts.push({ kind: "text", value: prose.join("\n") })
		prose = []
	}

	for (const line of text.split("\n")) {
		const fence = FENCE_OPEN.exec(line)
		const ticks = fence?.[1]?.length ?? 0
		const info = fence?.[2] ?? ""

		if (open === undefined) {
			if (ticks === 0) {
				prose.push(line)
				continue
			}
			open = { ticks, isChart: info === CHART_FENCE_INFO }
			if (open.isChart) {
				flushProse()
				body = []
			} else prose.push(line)
			continue
		}

		// A closing fence is at least as long as the one that opened it and
		// carries no info string of its own.
		if (ticks >= open.ticks && info === "") {
			if (open.isChart) parts.push({ kind: "chart", value: body.join("\n"), closed: true })
			else prose.push(line)
			open = undefined
			continue
		}
		if (open.isChart) body.push(line)
		else prose.push(line)
	}

	if (open?.isChart === true) parts.push({ kind: "chart", value: body.join("\n"), closed: false })
	else flushProse()
	return parts
}

/** Every ```chart fence in a reply, in the order they appear in it. */
export function chartFences(text: string): ReadonlyArray<string> {
	return splitChartFences(text).flatMap((part) => (part.kind === "chart" ? [part.value] : []))
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
