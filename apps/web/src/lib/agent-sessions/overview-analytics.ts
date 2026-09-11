// The view model behind `/agent-sessions/overview`: every number the board
// prints, derived from the two reads that produce it, with no React and no wire
// shape in sight.
//
// Three rules shape this module.
//
// The API reports COUNTS; the page reads RATIOS — cost per session, tokens per
// session, an error rate. Every one of those divides, and a window with no
// sessions in it divides by zero, so `ratio` is the only division here and it
// answers 0 rather than NaN. A tile that reads "NaN" is worse than one that
// reads "0".
//
// Durations arrive in milliseconds (the adapter converts the wire's
// nanoseconds), and quantiles never fold: the window's p95 is the summary's own
// un-bucketed figure, never the mean of the buckets'.
//
// A delta is expressed in the unit its metric is read in. A rate moves in
// percentage POINTS — 2% to 26% is "up 24 points", not "up 1200%" — a ratio
// moves in percent, and a duration moves by a duration.

import { formatErrorRate, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"

import { formatCost } from "./session-summary"
import { OVERVIEW_DIMENSIONS, type OverviewDimension } from "./overview-search"

/* -------------------------------------------------------------------------------------------------
 * Measures — the API's numbers, in the units the client reads
 * -----------------------------------------------------------------------------------------------*/

/**
 * What every overview read reports, so a tile, a point on a chart and a table
 * row are the same numbers under different groupings.
 *
 * A subset of the wire's `AiOverviewMeasures`: the session quantiles are
 * milliseconds here rather than nanoseconds, and the per-call ones are dropped
 * because nothing on the board reads them. See
 * `api/warehouse/ai-agent-overview.ts`.
 */
export interface OverviewMeasures {
	readonly sessions: number
	readonly erroredSessions: number
	/** Model calls, netted — a wrapper's roll-up, a gateway's mirror and a
	 *  provider retry of one call are one call. */
	readonly llmCalls: number
	/** Model-call SPANS, counted raw. The denominator of the LLM error rate. */
	readonly llmCallSpans: number
	readonly erroredLlmCalls: number
	readonly toolCalls: number
	readonly erroredToolCalls: number
	readonly cost: number
	/** Netted model calls that carried a price — the coverage behind `cost`. */
	readonly pricedLlmCalls: number
	readonly tokens: number
	readonly inputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	readonly sessionDurationP50Ms: number
	readonly sessionDurationP95Ms: number
}

export const EMPTY_OVERVIEW_MEASURES: OverviewMeasures = {
	sessions: 0,
	erroredSessions: 0,
	llmCalls: 0,
	llmCallSpans: 0,
	erroredLlmCalls: 0,
	toolCalls: 0,
	erroredToolCalls: 0,
	cost: 0,
	pricedLlmCalls: 0,
	tokens: 0,
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	sessionDurationP50Ms: 0,
	sessionDurationP95Ms: 0,
}

/** One bucket of a summary series. `bucket` is epoch milliseconds. */
export interface OverviewMeasurePoint extends OverviewMeasures {
	readonly bucket: number
}

/** One key of a breakdown, over both windows. */
export interface OverviewBreakdownEntry {
	/** `''` is a real key — a span carrying no value for this dimension. */
	readonly key: string
	readonly current: OverviewMeasures
	readonly previous: OverviewMeasures
}

/** One (bucket, model) pair of the model-mix read. */
export interface OverviewModelMixRow {
	readonly bucket: number
	readonly model: string
	readonly llmCallSpans: number
}

/* -------------------------------------------------------------------------------------------------
 * Derivations
 * -----------------------------------------------------------------------------------------------*/

/** The only division in this module. A window that ran nothing reads 0. */
const ratio = (numerator: number, denominator: number): number =>
	denominator > 0 ? numerator / denominator : 0

export const sessionErrorRate = (m: OverviewMeasures): number => ratio(m.erroredSessions, m.sessions)

/** `erroredLlmCalls / llmCallSpans` and never `/ llmCalls`: the two populations
 *  differ by every mirror and wrapper the netting collapses. */
export const llmErrorRate = (m: OverviewMeasures): number => ratio(m.erroredLlmCalls, m.llmCallSpans)

export const toolErrorRate = (m: OverviewMeasures): number => ratio(m.erroredToolCalls, m.toolCalls)

export const costPerSession = (m: OverviewMeasures): number => ratio(m.cost, m.sessions)
export const tokensPerSession = (m: OverviewMeasures): number => ratio(m.tokens, m.sessions)
export const toolCallsPerSession = (m: OverviewMeasures): number => ratio(m.toolCalls, m.sessions)
export const llmCallsPerSession = (m: OverviewMeasures): number => ratio(m.llmCalls, m.sessions)

/** Cache reads over everything that could have been a prompt read. */
export const cacheHitRatio = (m: OverviewMeasures): number =>
	ratio(m.cacheReadTokens, m.inputTokens + m.cacheReadTokens)

/**
 * `cost` is 0 for "nobody priced it" and not for "free" — this is how much of
 * the window it actually covers.
 *
 * Over `llmCalls` and never `llmCallSpans` — the mirror image of the LLM error
 * rate above. The server nets the priced calls exactly as it nets the volume,
 * so the two are one population and a fully priced window reads 100% rather
 * than the netting factor.
 */
export const pricedShare = (m: OverviewMeasures): number => ratio(m.pricedLlmCalls, m.llmCalls)

/* -------------------------------------------------------------------------------------------------
 * Token bands
 * -----------------------------------------------------------------------------------------------*/

export const OVERVIEW_TOKEN_BANDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const
export type OverviewTokenBand = (typeof OVERVIEW_TOKEN_BANDS)[number]

/**
 * The band a row falls back to. Rows materialized before the bucket columns
 * existed carry a total and five zeros; showing five empty bands over a
 * non-zero total would read as "no tokens".
 */
export const OVERVIEW_TOKEN_FALLBACK_BAND = "total"
export type OverviewTokenBandKey = OverviewTokenBand | typeof OVERVIEW_TOKEN_FALLBACK_BAND

export const OVERVIEW_TOKEN_BAND_KEYS = [...OVERVIEW_TOKEN_BANDS, OVERVIEW_TOKEN_FALLBACK_BAND] as const

const emptyBands = (): Record<OverviewTokenBandKey, number> => ({
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	reasoning: 0,
	total: 0,
})

/** Raw token counts per band, with the fallback applied. */
export function tokenBandValues(m: OverviewMeasures): Record<OverviewTokenBandKey, number> {
	const bands = emptyBands()
	const split = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens + m.outputTokens + m.reasoningTokens
	if (split === 0) {
		bands.total = m.tokens
		return bands
	}
	bands.input = m.inputTokens
	bands.cacheRead = m.cacheReadTokens
	bands.cacheWrite = m.cacheWriteTokens
	bands.output = m.outputTokens
	bands.reasoning = m.reasoningTokens
	return bands
}

/* -------------------------------------------------------------------------------------------------
 * Deltas
 * -----------------------------------------------------------------------------------------------*/

export type DeltaDirection = "up" | "down" | "flat"
/** How the move reads, not which way it went: a rise in cost is `bad`, a rise
 *  in sessions is `neutral`, a rise in cache hits is `good`. */
export type DeltaTone = "good" | "bad" | "neutral"
/** Which unit the change is expressed in. */
export type DeltaUnit = "percent" | "points" | "duration"

/** The colour a graded move is drawn in. A neutral move is just a number. */
export const deltaToneClass = (tone: DeltaTone): string =>
	tone === "bad"
		? "text-[var(--severity-error)]"
		: tone === "good"
			? "text-[var(--severity-info)]"
			: "text-muted-foreground"

export interface OverviewDelta {
	/** `after - before`, in the metric's own unit (ms for durations). */
	readonly absolute: number
	/** Fractional change (0.43 = +43%); `null` against a zero baseline. */
	readonly percent: number | null
	/** Percentage-point change (24 = +24pp); `null` unless the metric is a rate. */
	readonly pp: number | null
	readonly direction: DeltaDirection
	readonly tone: DeltaTone
	/** As a tile prints it, sign included: `+43%`, `24.0pp`, `+2.4s`. */
	readonly text: string
}

const FLAT_POINTS = 0.05
const FLAT_PERCENT = 0.001
const FLAT_MS = 1

const signed = (value: number, text: string): string => (value < 0 ? `-${text}` : `+${text}`)

/**
 * The change against the previous window.
 *
 * `null` where there is no reading to give: a percentage against a baseline of
 * zero is "up ∞%", which is not a number anybody acts on.
 */
export function overviewDelta(
	before: number,
	after: number,
	options: { unit: DeltaUnit; riseIs: DeltaTone },
): OverviewDelta | null {
	if (!Number.isFinite(before) || !Number.isFinite(after)) return null
	const absolute = after - before
	const flatAt = options.unit === "points" ? FLAT_POINTS / 100 : options.unit === "duration" ? FLAT_MS : 0
	const percent = before === 0 ? null : absolute / before

	if (options.unit === "percent" && percent === null) return null

	const direction: DeltaDirection =
		options.unit === "percent"
			? Math.abs(percent ?? 0) < FLAT_PERCENT
				? "flat"
				: absolute > 0
					? "up"
					: "down"
			: Math.abs(absolute) < flatAt
				? "flat"
				: absolute > 0
					? "up"
					: "down"

	const tone: DeltaTone =
		direction === "flat" || options.riseIs === "neutral"
			? "neutral"
			: direction === "up"
				? options.riseIs
				: options.riseIs === "bad"
					? "good"
					: "bad"

	if (options.unit === "points") {
		const pp = absolute * 100
		return {
			absolute,
			percent: null,
			pp,
			direction,
			// A move too small to read is not a signed zero: "+0.0pp" reads as a
			// rise that rounded away, which is a different claim from "flat".
			text: direction === "flat" ? "0pp" : signed(pp, `${Math.abs(pp).toFixed(1)}pp`),
			tone,
		}
	}
	if (options.unit === "duration") {
		return {
			absolute,
			percent,
			pp: null,
			direction,
			text: direction === "flat" ? "0s" : signed(absolute, formatOverviewDuration(Math.abs(absolute))),
			tone,
		}
	}
	return {
		absolute,
		percent,
		pp: null,
		direction,
		text: direction === "flat" ? "0%" : signed(absolute, formatPercent(Math.abs(percent ?? 0))),
		tone,
	}
}

/** The bucket width, as the Trends note states it: `15m`, `6h`, `1d`. */
export function bucketWidthLabel(seconds: number): string {
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`
	if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`
	return `${Math.round(seconds / 60)}m`
}

/* -------------------------------------------------------------------------------------------------
 * Formatters
 * -----------------------------------------------------------------------------------------------*/

/**
 * Counts read as themselves up to a million. "1.2K" and "1,243" are the same
 * number to a reader; compaction starts where the exact digits stop being
 * something anyone holds in their head.
 */
export function formatOverviewCount(value: number): string {
	return Math.abs(value) >= 1_000_000 ? formatNumber(value) : Math.round(value).toLocaleString()
}

/** A per-session ratio: one decimal while the number is small enough to have one. */
export function formatPerSession(value: number): string {
	if (!Number.isFinite(value)) return "—"
	return value >= 100 ? formatOverviewCount(value) : value.toFixed(1)
}

/**
 * A duration a session took, in the clock units the Sessions list reads them
 * in — `2m 30s`, `1h 4m` — so a session's row there and its cell here are the
 * same string. Zero means "nothing measured".
 *
 * The shared formatter starts at whole seconds, which is a reading on a list
 * row and a rounding on a delta: `+55s` and `+54.6s` are the same move only
 * until you compare two of them. The tenth therefore survives until the minutes
 * arrive to carry the magnitude instead.
 */
export function formatOverviewDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—"
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatSessionDuration(ms)
}

/** `''` is a real breakdown key, shown as unattributed rather than hidden. */
export const UNATTRIBUTED_LABEL = "Unattributed"
export const breakdownKeyLabel = (key: string): string => (key === "" ? UNATTRIBUTED_LABEL : key)

/**
 * What the current scope matched, in one line.
 *
 * The three populations the rest of the board divides by, so a reader can see
 * at a glance whether a rate is measured over a thousand sessions or over four.
 */
export function overviewScopeSummary(current: OverviewMeasures): string {
	return [
		`${formatOverviewCount(current.sessions)} sessions`,
		`${formatOverviewCount(current.llmCalls)} LLM calls`,
		`${formatOverviewCount(current.toolCalls)} tool calls`,
	].join(" · ")
}

/* -------------------------------------------------------------------------------------------------
 * KPI tiles
 * -----------------------------------------------------------------------------------------------*/

export const OVERVIEW_TILES = [
	"sessions",
	"cost",
	"costPerSession",
	"tokens",
	"errorRate",
	"toolCallsPerSession",
	"durationP95",
] as const
export type OverviewTileId = (typeof OVERVIEW_TILES)[number]

export interface OverviewTile {
	readonly id: OverviewTileId
	/** The eyebrow, in the page's own words. */
	readonly label: string
	readonly value: string
	/** A short suffix beside the value, where one helps read it. */
	readonly unit?: string
	/** `null` when the comparison is off, or when there is no reading to give. */
	readonly delta: OverviewDelta | null
	/** The second half of the delta line: what the number is made of. */
	readonly sub: string
}

/**
 * The seven tiles, left to right.
 *
 * Totals are neutral — more sessions is neither good nor bad news, and a bill
 * that rose because usage rose is not a regression. What is graded is the unit
 * economics and the failures: cost per session, tokens per session, the error
 * rate, tool calls per session and the p95.
 */
export function buildOverviewTiles(
	current: OverviewMeasures,
	previous: OverviewMeasures,
	options: { compare: boolean; windowLabel: string },
): ReadonlyArray<OverviewTile> {
	const delta = (before: number, after: number, unit: DeltaUnit, riseIs: DeltaTone): OverviewDelta | null =>
		options.compare ? overviewDelta(before, after, { unit, riseIs }) : null

	return [
		{
			id: "sessions",
			label: "Sessions",
			value: formatOverviewCount(current.sessions),
			delta: delta(previous.sessions, current.sessions, "percent", "neutral"),
			sub: options.compare
				? `vs ${formatOverviewCount(previous.sessions)} prev`
				: `over ${options.windowLabel}`,
		},
		{
			id: "cost",
			label: "Cost",
			value: formatCost(current.cost),
			delta: delta(previous.cost, current.cost, "percent", "neutral"),
			sub: `priced ${formatPercent(pricedShare(current))}`,
		},
		{
			id: "costPerSession",
			label: "Cost / session",
			value: formatCost(costPerSession(current)),
			delta: delta(costPerSession(previous), costPerSession(current), "percent", "bad"),
			sub: options.compare
				? `vs ${formatCost(costPerSession(previous))}`
				: `${formatOverviewCount(current.sessions)} sessions`,
		},
		{
			id: "tokens",
			label: "Tokens",
			value: formatNumber(current.tokens),
			unit: "tok",
			delta: delta(previous.tokens, current.tokens, "percent", "neutral"),
			sub: `${formatNumber(tokensPerSession(current))} / session`,
		},
		{
			id: "errorRate",
			label: "Error rate",
			value: formatErrorRate(sessionErrorRate(current)),
			delta: delta(sessionErrorRate(previous), sessionErrorRate(current), "points", "bad"),
			sub: `${formatOverviewCount(current.erroredSessions)} errored`,
		},
		{
			id: "toolCallsPerSession",
			label: "Tool calls / sess",
			value: formatPerSession(toolCallsPerSession(current)),
			delta: delta(toolCallsPerSession(previous), toolCallsPerSession(current), "percent", "bad"),
			sub: `${formatOverviewCount(current.toolCalls)} calls`,
		},
		{
			id: "durationP95",
			label: "Duration p95",
			value: formatOverviewDuration(current.sessionDurationP95Ms),
			delta: delta(previous.sessionDurationP95Ms, current.sessionDurationP95Ms, "duration", "bad"),
			sub: `p50 ${formatOverviewDuration(current.sessionDurationP50Ms)}`,
		},
	]
}

/* -------------------------------------------------------------------------------------------------
 * The series behind the small multiples
 * -----------------------------------------------------------------------------------------------*/

export interface OverviewSeriesPoint {
	/** Epoch milliseconds, the bucket's start. */
	readonly bucket: number
	readonly sessions: number
	readonly costPerSession: number
	readonly tokensPerSession: number
	/** Tokens per session, split by band — the stacked chart's values. */
	readonly tokenBands: Record<OverviewTokenBandKey, number>
	/** Each band's share of the bucket's tokens, 0–1. */
	readonly tokenBandShares: Record<OverviewTokenBandKey, number>
	readonly toolCallsPerSession: number
	readonly sessionErrorRate: number
	readonly llmErrorRate: number
	readonly toolErrorRate: number
	readonly sessionP50Ms: number
	readonly sessionP95Ms: number
	readonly llmCallsPerSession: number
	readonly cacheHitRatio: number
}

export function buildOverviewSeries(
	points: ReadonlyArray<OverviewMeasurePoint>,
): ReadonlyArray<OverviewSeriesPoint> {
	return points.map((point) => {
		const bands = tokenBandValues(point)
		const total = OVERVIEW_TOKEN_BAND_KEYS.reduce((sum, key) => sum + bands[key], 0)
		const perSession = emptyBands()
		const shares = emptyBands()
		for (const key of OVERVIEW_TOKEN_BAND_KEYS) {
			perSession[key] = ratio(bands[key], point.sessions)
			shares[key] = ratio(bands[key], total)
		}
		return {
			bucket: point.bucket,
			sessions: point.sessions,
			costPerSession: costPerSession(point),
			tokensPerSession: tokensPerSession(point),
			tokenBands: perSession,
			tokenBandShares: shares,
			toolCallsPerSession: toolCallsPerSession(point),
			sessionErrorRate: sessionErrorRate(point),
			llmErrorRate: llmErrorRate(point),
			toolErrorRate: toolErrorRate(point),
			sessionP50Ms: point.sessionDurationP50Ms,
			sessionP95Ms: point.sessionDurationP95Ms,
			llmCallsPerSession: llmCallsPerSession(point),
			cacheHitRatio: cacheHitRatio(point),
		}
	})
}

/**
 * The previous period's points moved onto the current period's x-axis.
 *
 * The comparison window is the equal-length one immediately before, so adding
 * the window's length puts each of its buckets under the current bucket it is
 * being compared with — which is what lets the ghost line share one axis.
 */
export function shiftOverviewSeries(
	points: ReadonlyArray<OverviewSeriesPoint>,
	offsetMs: number,
): ReadonlyArray<OverviewSeriesPoint> {
	return points.map((point) => ({ ...point, bucket: point.bucket + offsetMs }))
}

/* -------------------------------------------------------------------------------------------------
 * Model mix
 * -----------------------------------------------------------------------------------------------*/

/** Models plotted as their own band; everything past this is folded. */
export const OVERVIEW_MODEL_MIX_LIMIT = 5
export const OVERVIEW_MODEL_MIX_OTHER = "other"

export interface OverviewModelMixPoint {
	readonly bucket: number
	/** Spans per band key, over the models {@link OverviewModelMix.models} names. */
	readonly spans: Record<string, number>
	/** Each band's share of the bucket, 0–1 — the 100% stack. */
	readonly shares: Record<string, number>
}

export interface OverviewModelMix {
	/** The plotted bands, busiest first, with `other` last when the tail exists. */
	readonly models: ReadonlyArray<string>
	readonly points: ReadonlyArray<OverviewModelMixPoint>
}

/**
 * The top models by span count, with the rest folded into one grey band.
 *
 * A line per model is unreadable past a handful and the tail is a residue
 * rather than a thing; what the chart is for is noticing that one band took
 * over.
 */
export function buildModelMix(rows: ReadonlyArray<OverviewModelMixRow>): OverviewModelMix {
	const totals = new Map<string, number>()
	for (const row of rows) totals.set(row.model, (totals.get(row.model) ?? 0) + row.llmCallSpans)

	const ranked = [...totals.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([model]) => model)
	const top = ranked.slice(0, OVERVIEW_MODEL_MIX_LIMIT)
	const kept = new Set(top)
	const models = ranked.length > top.length ? [...top, OVERVIEW_MODEL_MIX_OTHER] : top

	const byBucket = new Map<number, Record<string, number>>()
	for (const row of rows) {
		const band = kept.has(row.model) ? row.model : OVERVIEW_MODEL_MIX_OTHER
		let bucket = byBucket.get(row.bucket)
		if (bucket === undefined) {
			bucket = Object.fromEntries(models.map((model) => [model, 0]))
			byBucket.set(row.bucket, bucket)
		}
		bucket[band] += row.llmCallSpans
	}

	const points = [...byBucket.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([bucket, spans]) => {
			const total = models.reduce((sum, model) => sum + spans[model], 0)
			const shares: Record<string, number> = {}
			for (const model of models) shares[model] = ratio(spans[model], total)
			return { bucket, spans, shares }
		})

	return { models, points }
}

/* -------------------------------------------------------------------------------------------------
 * Breakdown tables
 * -----------------------------------------------------------------------------------------------*/

export interface OverviewBreakdownRow {
	readonly key: string
	readonly label: string
	/** Share of the table's cost, 0–1 — the usage dimensions' bar. */
	readonly shareOfCost: number
	/** Share of the table's tool calls, 0–1 — the tool dimension's bar. */
	readonly shareOfCalls: number
	readonly sessions: number
	readonly llmCalls: number
	readonly tokensPerSession: number
	readonly cost: number
	readonly costPerSession: number
	readonly toolCalls: number
	readonly toolErrors: number
	/** Tool calls that failed for the `tool` dimension, sessions that failed for
	 *  every other — the failure the dimension can actually attribute. */
	readonly errorRate: number
	/** The same rate's move in percentage points; `null` where the key did not
	 *  appear in the previous window. */
	readonly errorRateDeltaPp: number | null
}

export interface OverviewBreakdown {
	readonly dimension: OverviewDimension
	readonly rows: ReadonlyArray<OverviewBreakdownRow>
	/** Distinct keys the window had, so the table can say what it is not showing. */
	readonly totalKeys: number
}

/** A tool row's failures are its calls'; every other dimension's are its sessions'. */
const dimensionErrorRate = (dimension: OverviewDimension, m: OverviewMeasures): number =>
	dimension === "tool" ? toolErrorRate(m) : sessionErrorRate(m)

const dimensionPopulation = (dimension: OverviewDimension, m: OverviewMeasures): number =>
	dimension === "tool" ? m.toolCalls : m.sessions

/**
 * One table's rows, in the order the server ranked them (busiest first).
 *
 * Shares are of the ROWS, not of the window: the table shows at most a dozen
 * keys and a bar measured against a total it is not showing would never fill.
 */
export function buildBreakdownRows(
	dimension: OverviewDimension,
	entries: ReadonlyArray<OverviewBreakdownEntry>,
): ReadonlyArray<OverviewBreakdownRow> {
	const totalCost = entries.reduce((sum, entry) => sum + entry.current.cost, 0)
	const totalCalls = entries.reduce((sum, entry) => sum + entry.current.toolCalls, 0)
	return entries.map((entry) => {
		const rate = dimensionErrorRate(dimension, entry.current)
		const hadPrevious = dimensionPopulation(dimension, entry.previous) > 0
		return {
			key: entry.key,
			label: breakdownKeyLabel(entry.key),
			shareOfCost: ratio(entry.current.cost, totalCost),
			shareOfCalls: ratio(entry.current.toolCalls, totalCalls),
			sessions: entry.current.sessions,
			llmCalls: entry.current.llmCalls,
			tokensPerSession: tokensPerSession(entry.current),
			cost: entry.current.cost,
			costPerSession: costPerSession(entry.current),
			toolCalls: entry.current.toolCalls,
			toolErrors: entry.current.erroredToolCalls,
			errorRate: rate,
			errorRateDeltaPp: hadPrevious
				? (rate - dimensionErrorRate(dimension, entry.previous)) * 100
				: null,
		}
	})
}

/* -------------------------------------------------------------------------------------------------
 * "What changed" — the movers rail
 * -----------------------------------------------------------------------------------------------*/

/** A key this quiet moved by accident, not by regression. */
export const OVERVIEW_MOVER_MIN_SESSIONS = 10
export const OVERVIEW_MOVER_LIMIT = 6

export type OverviewMoverMetric =
	| "sessionErrorRate"
	| "llmErrorRate"
	| "toolErrorRate"
	| "costPerSession"
	| "toolCallsPerSession"
	| "tokensPerSession"
	| "durationP95"

export interface OverviewMover {
	readonly dimension: OverviewDimension
	readonly key: string
	readonly label: string
	readonly metric: OverviewMoverMetric
	readonly metricLabel: string
	/** Formatted in the metric's own unit. */
	readonly before: string
	readonly after: string
	readonly deltaText: string
	readonly tone: DeltaTone
	/** Percentage points for a rate, tenths of a percent for a ratio — the one
	 *  scale the rail ranks on, and the magnitude bar's length. */
	readonly score: number
}

interface MoverMetric {
	readonly id: OverviewMoverMetric
	readonly label: string
	readonly unit: DeltaUnit
	readonly riseIs: DeltaTone
	readonly value: (m: OverviewMeasures) => number
	readonly format: (value: number) => string
	/** Absent means every dimension. */
	readonly only?: OverviewDimension
}

const MOVER_METRICS: ReadonlyArray<MoverMetric> = [
	{
		id: "sessionErrorRate",
		label: "session error rate",
		unit: "points",
		riseIs: "bad",
		value: sessionErrorRate,
		format: formatErrorRate,
	},
	{
		id: "llmErrorRate",
		label: "LLM error rate",
		unit: "points",
		riseIs: "bad",
		value: llmErrorRate,
		format: formatErrorRate,
	},
	{
		id: "toolErrorRate",
		label: "tool error rate",
		unit: "points",
		riseIs: "bad",
		value: toolErrorRate,
		format: formatErrorRate,
		only: "tool",
	},
	{
		id: "costPerSession",
		label: "cost / session",
		unit: "percent",
		riseIs: "bad",
		value: costPerSession,
		format: formatCost,
	},
	{
		id: "toolCallsPerSession",
		label: "tool calls / session",
		unit: "percent",
		riseIs: "bad",
		value: toolCallsPerSession,
		format: formatPerSession,
	},
	{
		id: "tokensPerSession",
		label: "tokens / session",
		unit: "percent",
		riseIs: "bad",
		value: tokensPerSession,
		format: formatNumber,
	},
	{
		id: "durationP95",
		label: "p95 duration",
		unit: "percent",
		riseIs: "bad",
		value: (m) => m.sessionDurationP95Ms,
		format: formatOverviewDuration,
	},
]

/** Points for a rate, a tenth of a percent for a ratio — so an 8-point jump in
 *  failures outranks an 80% rise in tokens, which is the order a reader wants. */
const moverScore = (delta: OverviewDelta): number =>
	delta.pp !== null ? Math.abs(delta.pp) : Math.abs((delta.percent ?? 0) * 100) / 10

/**
 * The biggest movers across every dimension, worst first.
 *
 * One line per key, not per metric: a key whose cost and tokens both doubled
 * moved once, and printing it twice would push a different regression off the
 * rail. Keys too small to read are dropped in both windows — a group that ran
 * three sessions last week and four this week can post any rate at all.
 */
export function buildMovers(
	breakdowns: ReadonlyArray<{
		readonly dimension: OverviewDimension
		readonly entries: ReadonlyArray<OverviewBreakdownEntry>
	}>,
): ReadonlyArray<OverviewMover> {
	const best: OverviewMover[] = []
	for (const breakdown of breakdowns) {
		for (const entry of breakdown.entries) {
			if (
				entry.current.sessions < OVERVIEW_MOVER_MIN_SESSIONS ||
				entry.previous.sessions < OVERVIEW_MOVER_MIN_SESSIONS
			) {
				continue
			}
			let winner: OverviewMover | undefined
			for (const metric of MOVER_METRICS) {
				if (metric.only !== undefined && metric.only !== breakdown.dimension) continue
				const before = metric.value(entry.previous)
				const after = metric.value(entry.current)
				const delta = overviewDelta(before, after, {
					unit: metric.unit,
					riseIs: metric.riseIs,
				})
				if (delta === null || delta.direction === "flat") continue
				const score = moverScore(delta)
				if (winner !== undefined && score <= winner.score) continue
				winner = {
					dimension: breakdown.dimension,
					key: entry.key,
					label: breakdownKeyLabel(entry.key),
					metric: metric.id,
					metricLabel: metric.label,
					before: metric.format(before),
					after: metric.format(after),
					deltaText: delta.text,
					tone: delta.tone,
					score,
				}
			}
			if (winner !== undefined) best.push(winner)
		}
	}
	return best
		.sort(
			(a, b) =>
				b.score - a.score ||
				OVERVIEW_DIMENSIONS.indexOf(a.dimension) - OVERVIEW_DIMENSIONS.indexOf(b.dimension) ||
				a.key.localeCompare(b.key),
		)
		.slice(0, OVERVIEW_MOVER_LIMIT)
}

/* -------------------------------------------------------------------------------------------------
 * Coverage
 * -----------------------------------------------------------------------------------------------*/

/** The one coverage line the API can answer: how much of the window has a price. */
export interface OverviewCoverage {
	readonly label: string
	readonly share: number
}

export const overviewCoverage = (current: OverviewMeasures): OverviewCoverage => ({
	label: "LLM calls with a cost",
	share: pricedShare(current),
})

/* -------------------------------------------------------------------------------------------------
 * The nine small multiples
 * -----------------------------------------------------------------------------------------------*/

export const OVERVIEW_CHARTS = [
	"sessions",
	"costPerSession",
	"tokensPerSession",
	"toolCallsPerSession",
	"errorRate",
	"sessionDuration",
	"llmCallsPerSession",
	"modelMix",
	"cacheHitRatio",
] as const
export type OverviewChartId = (typeof OVERVIEW_CHARTS)[number]

export interface OverviewChartSummary {
	readonly id: OverviewChartId
	readonly title: string
	/** The unit sub-label under the title. */
	readonly unit: string
	/** The window's headline, from the un-bucketed summary — never folded from
	 *  the buckets, because quantiles do not merge. */
	readonly value: string
	readonly delta: OverviewDelta | null
}

/** The chart headlines, in the grid's reading order. */
export function buildOverviewCharts(
	current: OverviewMeasures,
	previous: OverviewMeasures,
	options: { compare: boolean; modelMix: OverviewModelMix },
): ReadonlyArray<OverviewChartSummary> {
	const delta = (before: number, after: number, unit: DeltaUnit, riseIs: DeltaTone): OverviewDelta | null =>
		options.compare ? overviewDelta(before, after, { unit, riseIs }) : null

	const leadModel = options.modelMix.models[0]
	const spansOf = (model: string) =>
		options.modelMix.points.reduce((sum, point) => sum + point.spans[model], 0)
	const mixSpans = options.modelMix.models.reduce((sum, model) => sum + spansOf(model), 0)
	const leadShare = leadModel === undefined ? 0 : ratio(spansOf(leadModel), mixSpans)

	return [
		{
			id: "sessions",
			title: "Sessions started",
			unit: "sessions / bucket",
			value: formatOverviewCount(current.sessions),
			delta: delta(previous.sessions, current.sessions, "percent", "neutral"),
		},
		{
			id: "costPerSession",
			title: "Cost per session",
			unit: "USD / session",
			value: formatCost(costPerSession(current)),
			delta: delta(costPerSession(previous), costPerSession(current), "percent", "bad"),
		},
		{
			id: "tokensPerSession",
			title: "Tokens per session",
			unit: "tokens / session, by band",
			value: formatNumber(tokensPerSession(current)),
			delta: delta(tokensPerSession(previous), tokensPerSession(current), "percent", "bad"),
		},
		{
			id: "toolCallsPerSession",
			title: "Tool calls per session",
			unit: "calls / session",
			value: formatPerSession(toolCallsPerSession(current)),
			delta: delta(toolCallsPerSession(previous), toolCallsPerSession(current), "percent", "bad"),
		},
		{
			id: "errorRate",
			title: "Error rate",
			unit: "sessions · LLM calls · tool calls",
			value: formatErrorRate(sessionErrorRate(current)),
			delta: delta(sessionErrorRate(previous), sessionErrorRate(current), "points", "bad"),
		},
		{
			id: "sessionDuration",
			title: "Session duration",
			unit: "p50 with p50–p95 band",
			value: formatOverviewDuration(current.sessionDurationP95Ms),
			delta: delta(previous.sessionDurationP95Ms, current.sessionDurationP95Ms, "duration", "bad"),
		},
		{
			id: "llmCallsPerSession",
			title: "LLM calls per session",
			unit: "calls / session",
			value: formatPerSession(llmCallsPerSession(current)),
			delta: delta(llmCallsPerSession(previous), llmCallsPerSession(current), "percent", "neutral"),
		},
		{
			id: "modelMix",
			title: "Model mix",
			unit: "share of LLM call spans",
			value: leadModel === undefined ? "—" : `${leadModel} ${formatPercent(leadShare)}`,
			delta: null,
		},
		{
			id: "cacheHitRatio",
			title: "Cache hit ratio",
			unit: "cache reads / prompt tokens",
			value: formatPercent(cacheHitRatio(current)),
			delta: delta(cacheHitRatio(previous), cacheHitRatio(current), "points", "good"),
		},
	]
}

/* -------------------------------------------------------------------------------------------------
 * The whole board
 * -----------------------------------------------------------------------------------------------*/

export interface AgentOverviewData {
	readonly current: OverviewMeasures
	readonly previous: OverviewMeasures
	readonly compare: boolean
	readonly tiles: ReadonlyArray<OverviewTile>
	readonly charts: ReadonlyArray<OverviewChartSummary>
	readonly series: ReadonlyArray<OverviewSeriesPoint>
	/** Already shifted onto the current window's axis; empty when compare is off. */
	readonly previousSeries: ReadonlyArray<OverviewSeriesPoint>
	readonly modelMix: OverviewModelMix
	readonly movers: ReadonlyArray<OverviewMover>
	readonly coverage: OverviewCoverage
	/** All six, in `OVERVIEW_DIMENSIONS` order — the tabs are component state,
	 *  and the movers rail reads every one of them anyway. */
	readonly breakdowns: ReadonlyArray<OverviewBreakdown>
	readonly bucketSeconds: number
}

export interface AgentOverviewInput {
	readonly current: OverviewMeasures
	readonly previous: OverviewMeasures
	readonly series: ReadonlyArray<OverviewMeasurePoint>
	readonly previousSeries: ReadonlyArray<OverviewMeasurePoint>
	readonly modelMix: ReadonlyArray<OverviewModelMixRow>
	readonly breakdowns: ReadonlyArray<{
		readonly dimension: OverviewDimension
		readonly entries: ReadonlyArray<OverviewBreakdownEntry>
		readonly totalKeys: number
	}>
	readonly bucketSeconds: number
	/** The resolved window, in epoch ms — its length is the ghost's shift. */
	readonly windowMs: { readonly startMs: number; readonly endMs: number }
	/** Names the comparison in the tiles, e.g. `7d`. */
	readonly windowLabel: string
	readonly compare: boolean
}

/** Everything the view renders, from everything the reads returned. */
export function buildAgentOverviewData(input: AgentOverviewInput): AgentOverviewData {
	const modelMix = buildModelMix(input.modelMix)
	const windowMs = input.windowMs.endMs - input.windowMs.startMs
	return {
		current: input.current,
		previous: input.previous,
		compare: input.compare,
		tiles: buildOverviewTiles(input.current, input.previous, {
			compare: input.compare,
			windowLabel: input.windowLabel,
		}),
		charts: buildOverviewCharts(input.current, input.previous, {
			compare: input.compare,
			modelMix,
		}),
		series: buildOverviewSeries(input.series),
		previousSeries: input.compare
			? shiftOverviewSeries(buildOverviewSeries(input.previousSeries), windowMs)
			: [],
		modelMix,
		movers: buildMovers(input.breakdowns),
		coverage: overviewCoverage(input.current),
		breakdowns: input.breakdowns.map((breakdown) => ({
			dimension: breakdown.dimension,
			rows: buildBreakdownRows(breakdown.dimension, breakdown.entries),
			totalKeys: breakdown.totalKeys,
		})),
		bucketSeconds: input.bucketSeconds,
	}
}
