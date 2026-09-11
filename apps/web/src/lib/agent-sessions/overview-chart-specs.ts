import { formatWarehouseDateTime } from "@maple/query-engine"
import { formatErrorRate, formatNumber, formatPercent } from "@maple/ui/lib/format"

import {
	OVERVIEW_MODEL_MIX_OTHER,
	OVERVIEW_TOKEN_BANDS,
	OVERVIEW_TOKEN_FALLBACK_BAND,
	formatOverviewCount,
	formatOverviewDuration,
	formatPerSession,
	type OverviewChartId,
	type OverviewModelMix,
	type OverviewSeriesPoint,
	type OverviewTokenBandKey,
} from "./overview-analytics"
import { formatCost } from "./session-summary"

/* -------------------------------------------------------------------------------------------------
 * The shape a small multiple is drawn from
 * -----------------------------------------------------------------------------------------------*/

/** One bucket, wide: every mark on the chart reads its own field off this row. */
export interface OverviewPlotRow extends Record<string, string | number | Date | null> {
	bucket: string
	date: Date
}

/**
 * `line` is the subject, `ghost` the previous period behind it, `band` a layer
 * of a stack, `spread` the faint region a line of the same colour reads over.
 */
export type OverviewPlotKind = "line" | "ghost" | "band" | "spread"

export interface OverviewPlotMark {
	/** The row field this mark plots — a band's TOP edge. */
	readonly key: string
	readonly color: string
	readonly kind: OverviewPlotKind
	/** A band's floor field. A line sits on the axis and omits it. */
	readonly base?: string
	/** The tooltip's name for the series. */
	readonly label: string
}

export interface OverviewPlotLegendItem {
	readonly label: string
	readonly color: string
	readonly kind: OverviewPlotKind
}

export interface OverviewPlotSpec {
	readonly rows: ReadonlyArray<OverviewPlotRow>
	/** Painted in order — bands first, then the lines that read over them. */
	readonly marks: ReadonlyArray<OverviewPlotMark>
	readonly legend: ReadonlyArray<OverviewPlotLegendItem>
	/** Bands the legend did not name, as the design's trailing `+2`. */
	readonly legendMore: number
	/** The axis top. Every plot draws exactly `0` and this. */
	readonly yMax: number
	readonly format: (value: number) => string
}

export interface OverviewPlotInput {
	readonly series: ReadonlyArray<OverviewSeriesPoint>
	/** Already shifted onto this axis; empty with the comparison off. */
	readonly previousSeries: ReadonlyArray<OverviewSeriesPoint>
	readonly modelMix: OverviewModelMix
}

/* -------------------------------------------------------------------------------------------------
 * The y axis's two ticks, and the gutter they need
 * -----------------------------------------------------------------------------------------------*/

/** The gap a tick label keeps from the plot it labels. */
export const OVERVIEW_TICK_PADDING = 6
/** One character of the 10px mono tick label, rounded up from the 0.6em advance
 *  the face actually uses — the axis is painted onto a canvas, so the gutter has
 *  to be decided before there is anything to measure. */
const TICK_CHAR_WIDTH = 6.2
/** Four characters — `100%`, `4.0%`, `10.0` — and the width the design drew. */
const MIN_GUTTER = 32

/**
 * A tick as the axis prints it. A duration or a cost renders zero as an em
 * dash, which is right for a headline and wrong for an axis floor.
 */
export const overviewAxisTick = (spec: OverviewPlotSpec, value: number): string =>
	value === 0 ? "0" : spec.format(value)

/**
 * The left gutter the nine plots share, wide enough for the widest label any of
 * them will print.
 *
 * A fixed gutter only ever fits the formatter it was written for: `100%` and
 * `150.0K` are the same axis and not the same width, and a label that does not
 * fit is drawn straight off the canvas's left edge. Right-aligned text overflows
 * leftwards, so what is lost is the leading character — the one carrying the
 * magnitude, which leaves `$0.50` reading as `0.50`.
 *
 * One width for the whole grid rather than one per chart: the board is read
 * across as much as down, and a plot starting further right than the one beside
 * it reads as a different instrument. Only the top tick is measured; the floor
 * is always `0`.
 */
export function overviewAxisGutter(specs: Iterable<OverviewPlotSpec>): number {
	let widest = 0
	for (const spec of specs) widest = Math.max(widest, overviewAxisTick(spec, spec.yMax).length)
	return Math.max(MIN_GUTTER, Math.ceil(widest * TICK_CHAR_WIDTH) + OVERVIEW_TICK_PADDING)
}

/* -------------------------------------------------------------------------------------------------
 * Colours
 * -----------------------------------------------------------------------------------------------*/

const PRIMARY = "var(--primary)"
/** The previous period: present, and never mistakable for the subject. */
const GHOST = "var(--muted-foreground)"

/**
 * The token buckets wear their own designated hues rather than `--chart-1..5`
 * slots — the same five the session detail's usage bar draws, so a band here
 * and a segment there are the same colour for the same tokens.
 */
const TOKEN_BAND_COLOR = {
	input: "var(--chart-tok-input)",
	cacheRead: "var(--chart-tok-cache-read)",
	cacheWrite: "var(--chart-tok-cache-write)",
	output: "var(--chart-tok-output)",
	reasoning: "var(--chart-tok-reasoning)",
	total: PRIMARY,
} satisfies Record<OverviewTokenBandKey, string>

/** Short enough that five of them fit on one legend line at this width. */
const TOKEN_BAND_SHORT = {
	input: "in",
	cacheRead: "cache r",
	cacheWrite: "cache w",
	output: "out",
	reasoning: "reason",
	total: "tokens",
} satisfies Record<OverviewTokenBandKey, string>

const MODEL_MIX_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
] as const
/** The folded tail is a residue, not a model — it wears no chart slot. */
const MODEL_MIX_OTHER_COLOR = "var(--muted-foreground)"
/** Model names are long; the rest of them are counted instead of listed. */
const MODEL_MIX_LEGEND_LIMIT = 3

export const overviewModelMixColor = (index: number, model: string): string =>
	model === OVERVIEW_MODEL_MIX_OTHER
		? MODEL_MIX_OTHER_COLOR
		: (MODEL_MIX_COLORS[index % MODEL_MIX_COLORS.length] ?? MODEL_MIX_OTHER_COLOR)

/** A band's floor field, beside the field carrying its top edge. */
const baseKey = (key: string): string => `${key}_base`

/* -------------------------------------------------------------------------------------------------
 * The nine specs
 * -----------------------------------------------------------------------------------------------*/

/**
 * What one small multiple draws, as data.
 *
 * Pure so the awkward parts — which token bands survive the fallback, where a
 * stack's layers sit, what the axis tops out at — are testable without a
 * rendered chart, and so the plot component stays a translation of this into
 * marks rather than nine branches of chart code.
 */
export function buildOverviewPlotSpec(id: OverviewChartId, input: OverviewPlotInput): OverviewPlotSpec {
	switch (id) {
		case "sessions":
			return lineSpec(input, (point) => point.sessions, "sessions", formatOverviewCount)
		case "costPerSession":
			return lineSpec(input, (point) => point.costPerSession, "$ / session", formatCost)
		case "tokensPerSession":
			return tokenSpec(input)
		case "toolCallsPerSession":
			return lineSpec(input, (point) => point.toolCallsPerSession, "calls / session", formatPerSession)
		case "errorRate":
			return errorRateSpec(input)
		case "sessionDuration":
			return durationSpec(input)
		case "llmCallsPerSession":
			return lineSpec(input, (point) => point.llmCallsPerSession, "calls / session", formatPerSession)
		case "modelMix":
			return modelMixSpec(input)
		case "cacheHitRatio":
			return lineSpec(input, (point) => point.cacheHitRatio, "hit ratio", formatPercent, 1)
	}
}

/** One series, plus the previous period behind it when the comparison is on. */
function lineSpec(
	input: OverviewPlotInput,
	read: (point: OverviewSeriesPoint) => number,
	label: string,
	format: (value: number) => string,
	fixedMax?: number,
): OverviewPlotSpec {
	const previous = new Map(input.previousSeries.map((point) => [point.bucket, read(point)]))
	const rows = input.series.map((point) =>
		row(point.bucket, { value: read(point), prev: previous.get(point.bucket) ?? null }),
	)
	const marks: OverviewPlotMark[] = [{ key: "value", label, color: PRIMARY, kind: "line" }]
	if (input.previousSeries.length > 0) {
		marks.push({ key: "prev", label: "prev", color: GHOST, kind: "ghost" })
	}
	return spec(rows, marks, fixedMax ?? axisTop(rows, marks), format)
}

/**
 * Tokens per session, split five ways.
 *
 * The band set is decided once for the whole window rather than per bucket: an
 * SDK that reports no breakdown reports none all window, and a stack that
 * changed its own vocabulary mid-chart would read as a shift in usage.
 */
function tokenSpec(input: OverviewPlotInput): OverviewPlotSpec {
	const split = input.series.some((point) =>
		OVERVIEW_TOKEN_BANDS.some((band) => point.tokenBands[band] > 0),
	)
	const bands: ReadonlyArray<OverviewTokenBandKey> = split
		? OVERVIEW_TOKEN_BANDS
		: [OVERVIEW_TOKEN_FALLBACK_BAND]

	const rows = input.series.map((point) =>
		stackRow(
			point.bucket,
			bands.map((band) => ({ key: band, value: point.tokenBands[band] })),
		),
	)
	const marks = bands.map((band) => bandMark(band, TOKEN_BAND_COLOR[band], TOKEN_BAND_SHORT[band]))
	return spec(rows, marks, axisTop(rows, marks), formatNumber)
}

/** The three layers a session can fail at, on one rate axis. */
function errorRateSpec(input: OverviewPlotInput): OverviewPlotSpec {
	const rows = input.series.map((point) =>
		row(point.bucket, {
			sessions: point.sessionErrorRate,
			llm: point.llmErrorRate,
			tool: point.toolErrorRate,
		}),
	)
	const marks: ReadonlyArray<OverviewPlotMark> = [
		{ key: "sessions", label: "sessions", color: "var(--severity-error)", kind: "line" },
		{ key: "llm", label: "llm calls", color: "var(--chart-2)", kind: "line" },
		{ key: "tool", label: "tool calls", color: "var(--chart-5)", kind: "line" },
	]
	return spec(rows, marks, axisTop(rows, marks), formatErrorRate)
}

/** The median with the spread above it — the tail is the question. */
function durationSpec(input: OverviewPlotInput): OverviewPlotSpec {
	const rows = input.series.map((point) =>
		row(point.bucket, {
			p50: point.sessionP50Ms,
			p95: point.sessionP95Ms,
			p95_base: point.sessionP50Ms,
		}),
	)
	const marks: ReadonlyArray<OverviewPlotMark> = [
		{ key: "p95", base: "p95_base", label: "p50 – p95", color: PRIMARY, kind: "spread" },
		{ key: "p50", label: "p50", color: PRIMARY, kind: "line" },
	]
	return spec(rows, marks, axisTop(rows, marks), formatOverviewDuration)
}

/** Every bucket normalised to 1, so the question is share and not volume. */
function modelMixSpec(input: OverviewPlotInput): OverviewPlotSpec {
	const { models, points } = input.modelMix
	const rows = points.map((point) =>
		stackRow(
			point.bucket,
			models.map((model) => ({ key: model, value: point.shares[model] ?? 0 })),
		),
	)
	const marks = models.map((model, index) => bandMark(model, overviewModelMixColor(index, model), model))
	const legend = marks.slice(0, MODEL_MIX_LEGEND_LIMIT).map((mark, index) => ({
		label: `${models[index] ?? ""} ${formatPercent(modelShare(input.modelMix, models[index] ?? ""))}`,
		color: mark.color,
		kind: mark.kind,
	}))
	return {
		rows,
		marks,
		legend,
		legendMore: Math.max(0, marks.length - legend.length),
		yMax: 1,
		format: formatPercent,
	}
}

/** A model's share of the window's plotted spans, for its legend entry. */
function modelShare(mix: OverviewModelMix, model: string): number {
	let total = 0
	let own = 0
	for (const point of mix.points) {
		for (const band of mix.models) total += point.spans[band] ?? 0
		own += point.spans[model] ?? 0
	}
	return total === 0 ? 0 : own / total
}

/* -------------------------------------------------------------------------------------------------
 * Row and axis plumbing
 * -----------------------------------------------------------------------------------------------*/

function row(bucketMs: number, values: Record<string, number | null>): OverviewPlotRow {
	return { bucket: formatWarehouseDateTime(bucketMs), date: new Date(bucketMs), ...values }
}

/** A stack's layers, each carrying the top edge it landed on and its floor. */
function stackRow(bucketMs: number, layers: ReadonlyArray<{ key: string; value: number }>): OverviewPlotRow {
	const values: Record<string, number> = {}
	let floor = 0
	for (const layer of layers) {
		values[baseKey(layer.key)] = floor
		floor += layer.value
		values[layer.key] = floor
	}
	return row(bucketMs, values)
}

const bandMark = (key: string, color: string, label: string): OverviewPlotMark => ({
	key,
	base: baseKey(key),
	color,
	kind: "band",
	label,
})

function spec(
	rows: ReadonlyArray<OverviewPlotRow>,
	marks: ReadonlyArray<OverviewPlotMark>,
	yMax: number,
	format: (value: number) => string,
): OverviewPlotSpec {
	return {
		rows,
		marks,
		legend: marks.map((mark) => ({ label: mark.label, color: mark.color, kind: mark.kind })),
		legendMore: 0,
		yMax,
		format,
	}
}

/**
 * A finer ladder than a chart library's: these plots are 86px tall, so a top
 * two steps above the data spends a quarter of the height on empty air. Every
 * rung still prints as a round number through the chart's own formatter.
 */
const CEILING_STEPS = [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 4, 5, 6, 8, 10]

/**
 * The axis top: the next round number above the largest plotted value.
 *
 * Above, not equal to — a flat series at exactly the top rides the ceiling and
 * reads as clipped rather than as steady, which is the one thing these nine
 * charts exist to show. A stack's layers carry their cumulative top, so the
 * same maximum covers both shapes; an all-zero window still gets a `1` so the
 * scale has a domain, which draws the flat floor it should.
 */
function axisTop(rows: ReadonlyArray<OverviewPlotRow>, marks: ReadonlyArray<OverviewPlotMark>): number {
	let max = 0
	for (const plotRow of rows) {
		for (const mark of marks) {
			const value = plotRow[mark.key]
			if (typeof value === "number" && value > max) max = value
		}
	}
	if (max <= 0) return 1
	const magnitude = 10 ** Math.floor(Math.log10(max))
	const scaled = max / magnitude
	const step = CEILING_STEPS.find((candidate) => scaled <= candidate * 1.000_001) ?? 10
	return step * magnitude
}
