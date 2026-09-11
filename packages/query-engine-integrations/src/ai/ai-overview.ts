// Agent Sessions › Overview — the warehouse reads behind the overview page.
//
// Everything here is `ai_trace_index` and nothing else (see `ai-sessions.ts`
// for what that index is and what it costs). The page asks three questions of
// one population — what the window totals, how it moved, and where it went —
// and the answer to all three has to be the same numbers the sessions LIST
// shows for the same window, or the two pages describe different products.
//
// That constraint is what shapes the file. Four rules, all borrowed rather
// than re-derived:
//
//   1. A SESSION is a trace-level key: `max(SessionId)` per trace, then
//      `sessionKey(…)` from `ai-sessions.ts`, which files a trace whose vendor
//      exposes no session key under `trace:<TraceId>`. Counted per row instead,
//      every sessionless span collapses into one phantom session.
//   2. A FILTER selects sessions, as a per-trace existence test — "some agent
//      span of this trace carries this value" — never a row predicate. The
//      three GenAI identity columns are mutually exclusive by construction, so
//      a row predicate ANDing a model with a tool can only match a row
//      carrying both, and two facets with non-zero counts would return
//      nothing. `traceKeys` is that test, and it is the same one `indexTraces`
//      makes for the list.
//   3. USAGE is netted per session — `usageReportersExpr` collected over the
//      session's spans, then `nettedReportersExpr` and `sessionUsageSum`.
//      A wrapper that rolls up its children's tokens, a gateway's second trace
//      of the same call, and a provider retry beneath the call each count
//      once. A bucketed `sum(Cost)` is one line of SQL and is wrong by
//      whatever the org's roll-up rate is.
//   4. A SESSION BELONGS TO ONE BUCKET — the one its first span started in —
//      so the series sums to the totals instead of counting a long session in
//      every bucket it touched. The session-duration quantiles are the
//      exception: they do not merge, which is why the totals are their own
//      un-bucketed read rather than a client-side fold of the series.
//
// The breakdown adds a fifth. A key is the value the SPAN ITSELF carries, and
// the netting runs per (session, key): a session that used two models is a
// session under each of them (rows overlap and do not sum to the totals), but
// its tokens are charged to the model whose call reported them rather than
// repeated under both. That is the most faithful per-model attribution the
// reporter mechanism allows without a second netting implementation, and it is
// what keeps a wrapper's roll-up and a gateway's mirror from being counted
// twice inside a key. Its one gap: a reporter whose dimension value differs
// from its children's — an eve turn span rolling up a Vercel model call under a
// `vendor` breakdown — is netted only within its own key, so those two rows
// can together exceed the window's cost. `model` and `tool` are read over the
// spans that can carry them (`IsLlmCall = 1`, `IsToolCall = 1`); the rest are
// read over every agent span, and a span that names no value keys under `''`,
// which the page renders as unattributed rather than hiding.
//
// MODEL CALLS are counted over two populations, because volume and failures
// cannot share one. `llmCalls` is the netted volume: a wrapper's roll-up, a
// gateway's mirror and a provider retry of one call are one call. Failures
// cannot be netted at all — the index carries no error flag into the reporters
// — so `erroredLlmCalls` is a raw `sumIf` over the model-call SPANS, and
// `llmCallSpans` counts exactly those spans so the two divide. Read against
// `llmCalls`, a mirrored call that failed on both observations is two failures
// of one call and the rate passes 100%.
//
// The MODEL MIX is the one read that is a plain GROUP BY over the index, and
// the one that folds its own tail: the models past the busiest few are counted
// under `other` in SQL, so a bucket answers a bounded number of rows however
// many models the org routes across.
//
// Durations stay in NANOSECONDS, like every other AI read — `Duration` is what
// the index stores and the client formats.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import {
	from,
	fromQuery,
	inSubquery,
	param,
	unionAll,
	type CHQuery,
	type CHUnionQuery,
	type ColumnDefs,
} from "@maple-dev/effect-clickhouse"
import { AI_OVERVIEW_BREAKDOWN_MAX, type AiOverviewDimension } from "@maple/domain/http"
import { AiTraceIndex } from "@maple/query-engine/ch/tables"
import { finiteOrZero, isoBucket } from "@maple/query-engine/ch/format"
import { sessionFilterConditions, sessionKey } from "./ai-sessions"
import {
	childClaimsExpr,
	nettedReportersExpr,
	reportingSpanIdsExpr,
	sessionLlmCalls,
	sessionPricedLlmCalls,
	sessionUsageSum,
	usageReportersExpr,
} from "./ai-span-columns"

/**
 * The page's selection, as every read here takes it — the sessions list's
 * counted filters by the same names, so the two pages select the same
 * sessions. Each is a per-trace existence test; see rule 2 in the header.
 */
export interface AiOverviewFilterOpts {
	readonly vendorIds?: readonly string[]
	readonly serviceNames?: readonly string[]
	readonly deploymentEnvs?: readonly string[]
	readonly models?: readonly string[]
	readonly agentNames?: readonly string[]
	readonly toolNames?: readonly string[]
	/** Sessions with at least one failed agent span — the list's own rule. */
	readonly hasErrors?: boolean
}

export interface AiOverviewBreakdownOpts extends AiOverviewFilterOpts {
	readonly dimension: AiOverviewDimension
	/** Keys returned per period. Defaults to {@link AI_OVERVIEW_BREAKDOWN_MAX},
	 *  which is also where the request contract caps it — a larger `limit` is a
	 *  400 and never reaches here, so there is nothing to clamp twice. */
	readonly limit?: number
}

/**
 * Which pair of params bounds a read: the caller's window, or the window of
 * equal length immediately before it. Both reads use both — one `UNION ALL`
 * branch each — and every branch is built from the same expression functions,
 * because a `LowCardinality(String)` on one branch against a `String` on
 * another is a `NO_COMMON_TYPE`.
 */
type AiOverviewWindow = "current" | "previous"

/** Which window a row measures. `keys` is the breakdown's third branch: how
 *  many distinct keys the current window has, before the top-N cut. */
export type AiOverviewPeriod = "current" | "previous" | "keys"

/**
 * The period a branch stamps on its rows, as a literal the row type keeps.
 *
 * `CH.lit` widens a string to `string` — most literals are values rather than
 * tags — so without this the three-way `period` every caller switches on would
 * arrive as an open string.
 */
// SAFETY: the literal compiled into the branch IS the argument, so the row
// carries one of the three tags and nothing else.
const periodLit = (period: AiOverviewPeriod): CH.Expr<AiOverviewPeriod> =>
	CH.lit(period) as CH.Expr<AiOverviewPeriod>

const startParam = (window: AiOverviewWindow) =>
	param.dateTimeString(window === "current" ? "startTime" : "prevStartTime")
const endParam = (window: AiOverviewWindow) =>
	param.dateTimeString(window === "current" ? "endTime" : "prevEndTime")

/**
 * The window's bounds on a row's timestamp, on every level that reads the
 * index.
 *
 * The caller's window is CLOSED at both ends, the way every other Maple read
 * takes one. The comparison window is `[start − length, start)`: it ends where
 * the caller's begins, so its upper bound is EXCLUSIVE and a row sitting
 * exactly on the boundary belongs to the current window alone rather than to
 * both.
 *
 * The bound is an `Expr<string>` because Maple warehouse timestamps stay the
 * strings ClickHouse sends (`tables.ts`), which is what `param.dateTimeString`
 * compares against.
 */
const withinWindow = (
	timestamp: CH.Expr<string>,
	window: AiOverviewWindow,
): ReadonlyArray<CH.Condition> => [
	timestamp.gte(startParam(window)),
	window === "current" ? timestamp.lte(endParam(window)) : timestamp.lt(endParam(window)),
]

/**
 * One row per agent trace of the window that passes the selection: its id, the
 * session it is filed under, and how many of its spans failed.
 *
 * `max(SessionId)` because the id sits on the turn-owning span alone and every
 * other row of the trace reads `''`, which `max` discards. The filters are
 * `HAVING countIf(…) > 0` for the same reason `indexTraces` applies them
 * there — a row predicate would also narrow the rows the session id is read
 * from, and would file a trace under `trace:` whenever its session-bearing
 * span belonged to another vendor.
 *
 * `errorSpans` is read here so the `hasErrors` test below needs no second pass
 * over the index: a session failed when the traces filed under it did.
 */
const traceRollup = (opts: AiOverviewFilterOpts, window: AiOverviewWindow) =>
	from(AiTraceIndex)
		.select(($) => ({
			TraceId: $.TraceId,
			rawSessionId: CH.max_($.SessionId),
			errorSpans: CH.sum($.IsError),
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), ...withinWindow($.Timestamp, window)])
		.groupBy("TraceId")
		.having(($) => sessionFilterConditions(opts, $))

/**
 * The session keys of the window with a failed agent span — the `hasErrors`
 * filter, as the list applies it.
 *
 * A session-level test and not a trace-level one: a session spans traces, and
 * the list matches it when ANY of its agent spans failed. Summed over the
 * trace rollup, which is the same sum one level up. It reads the whole
 * population rather than the dimension's, so a `model` breakdown under
 * `hasErrors` measures the sessions the list would have listed.
 */
const erroredSessionKeys = (opts: AiOverviewFilterOpts, window: AiOverviewWindow) =>
	fromQuery(traceRollup(opts, window), "errored_traces")
		.select(($) => ({ sessionId: sessionKey($.rawSessionId, $.TraceId) }))
		.groupBy("sessionId")
		.having(($) => [CH.sum($.errorSpans).gt(0)])

/**
 * The trace set every level of every read joins: the window's agent traces
 * that passed the selection, keyed by the session they are filed under.
 *
 * The failed-session test is applied HERE and nowhere else. It is a read of
 * its own, and a level that applied it for itself derived the whole errored
 * set again — four times over in one breakdown.
 */
const traceKeys = (opts: AiOverviewFilterOpts, window: AiOverviewWindow) =>
	fromQuery(traceRollup(opts, window), "selected_traces")
		.select(($) => ({ TraceId: $.TraceId, rawSessionId: $.rawSessionId }))
		.where(($) => [
			CH.whenTrue(opts.hasErrors, () =>
				inSubquery(sessionKey($.rawSessionId, $.TraceId), erroredSessionKeys(opts, window)),
			),
		])

interface CallColumns {
	readonly IsLlmCall: CH.Expr<number>
	readonly IsToolCall: CH.Expr<number>
}

/** The spans a dimension's keys can come from. `Model` sits on model calls and
 *  `ToolName` on tool calls; the rest are properties of every agent span. */
const dimensionPopulation = (
	dimension: AiOverviewDimension,
): (($: CallColumns) => CH.Condition) | undefined => {
	if (dimension === "model") return ($) => $.IsLlmCall.eq(1)
	if (dimension === "tool") return ($) => $.IsToolCall.eq(1)
	return undefined
}

/**
 * The value a row is filed under, as a plain `String`.
 *
 * `toString` because four of the six columns are `LowCardinality(String)` and
 * the breakdown unions them against a `String` literal on its third branch,
 * which is a `NO_COMMON_TYPE` without it.
 */
const dimensionKey = (dimension: AiOverviewDimension) => {
	switch (dimension) {
		case "model":
			return ($: DimensionColumns) => CH.toString_($.Model)
		case "agent":
			return ($: DimensionColumns) => CH.toString_($.AgentName)
		case "service":
			return ($: DimensionColumns) => CH.toString_($.ServiceName)
		case "environment":
			return ($: DimensionColumns) => CH.toString_($.DeploymentEnv)
		case "vendor":
			return ($: DimensionColumns) => CH.toString_($.VendorId)
		case "tool":
			return ($: DimensionColumns) => CH.toString_($.ToolName)
	}
}

interface DimensionColumns {
	readonly Model: CH.Expr<string>
	readonly AgentName: CH.Expr<string>
	readonly ServiceName: CH.Expr<string>
	readonly DeploymentEnv: CH.Expr<string>
	readonly VendorId: CH.Expr<string>
	readonly ToolName: CH.Expr<string>
}

/**
 * One row per session (or per session and key), with everything the index
 * carries about it: the measures summed over its spans, and its usage still as
 * reporters, netted one level up and summed at the grouping level.
 *
 * `key` is the breakdown's grouping; without it the rows are sessions, which
 * is what the totals and the series aggregate. Column names are deliberately
 * not the names the levels above select (`sessionStart`, not `bucket`): an
 * outer alias shadows a derived column of the same name, and an aggregate over
 * the shadowed name becomes a cyclic alias rather than the aggregate meant.
 */
const sessionRows = (
	opts: AiOverviewFilterOpts,
	window: AiOverviewWindow,
	dimension?: AiOverviewDimension,
) => {
	const population = dimension === undefined ? undefined : dimensionPopulation(dimension)
	const key = dimension === undefined ? undefined : dimensionKey(dimension)
	const rows = from(AiTraceIndex)
		.innerJoinQuery(traceKeys(opts, window), "trace", (row, trace) => row.TraceId.eq(trace.TraceId))
		.select(($) => ({
			sessionId: sessionKey($.trace.rawSessionId, $.TraceId),
			// The totals and the series are a breakdown of one key, so the column
			// is always there and is `''` for them — a constant, which needs no
			// place in the GROUP BY and costs the read nothing.
			key: key === undefined ? CH.lit("") : key($),
			// The bucket the session is filed under is cut from this one level
			// up — the session's FIRST span, so it lands in exactly one bucket.
			sessionStart: CH.min_($.Timestamp),
			// `Timestamp` is the span's START, so the extent ends where the
			// last-starting span ended. Without the `+ Duration` a session whose
			// trace is one long span reports a duration of 0.
			sessionDurationNs: CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration))).sub(
				CH.toUnixTimestamp64Nano(CH.min_($.Timestamp)),
			),
			errorSpans: CH.sum($.IsError),
			toolCalls: CH.sum($.IsToolCall),
			erroredToolCalls: CH.sumIf($.IsError, $.IsToolCall.eq(1)),
			// The failed model-call SPANS. Not netted — the index carries no
			// error flag into the reporters — so a framework that echoes a
			// failure onto the span wrapping the call reports it twice.
			erroredLlmCalls: CH.sumIf($.IsError, $.IsLlmCall.eq(1)),
			// Its denominator: the SAME spans, counted. The netted `llmCalls`
			// below measures a different population — one mirrored call is one
			// call there and two failures above — so an error rate taken against
			// it can exceed 100%.
			llmCallSpans: CH.sum($.IsLlmCall),
			// Usage AND model calls travel as reporters: both are counted above,
			// where every span of the session is in hand — see `ai-span-columns`.
			// The two lookups the netting makes are taken off the reporters here,
			// once per session, rather than once per reporter inside the netting.
			reporters: usageReportersExpr($),
			childClaims: childClaimsExpr("reporters"),
			reportingIds: reportingSpanIdsExpr("reporters"),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...withinWindow($.Timestamp, window),
			population === undefined ? undefined : population($),
		])
	return key === undefined ? rows.groupBy("sessionId") : rows.groupBy("sessionId", "key")
}

/** The reporters netted into claims — its own level, because the netting reads
 *  the three columns below it inside lambdas and an alias of the same level
 *  would be evaluated once per reporter. */
const nettedRows = (opts: AiOverviewFilterOpts, window: AiOverviewWindow, dimension?: AiOverviewDimension) =>
	fromQuery(sessionRows(opts, window, dimension), "session_rows").select(($) => ({
		key: $.key,
		sessionStart: $.sessionStart,
		sessionDurationNs: $.sessionDurationNs,
		errorSpans: $.errorSpans,
		toolCalls: $.toolCalls,
		erroredToolCalls: $.erroredToolCalls,
		erroredLlmCalls: $.erroredLlmCalls,
		llmCallSpans: $.llmCallSpans,
		netted: nettedReportersExpr("reporters", "childClaims", "reportingIds"),
	}))

/** The accessor shape {@link measures} reads off {@link nettedRows}. */
interface SessionColumns {
	readonly sessionDurationNs: CH.Expr<number>
	readonly errorSpans: CH.Expr<number>
	readonly toolCalls: CH.Expr<number>
	readonly erroredToolCalls: CH.Expr<number>
	readonly erroredLlmCalls: CH.Expr<number>
	readonly llmCallSpans: CH.Expr<number>
}

/**
 * The measures every grouping reports, so a tile, a point on the chart and a
 * breakdown row are the same numbers under different `GROUP BY`s.
 *
 * `count()` rather than `uniqExact`: the level below is already one row per
 * session (or per session and key), so a session is counted once and exactly
 * once — and a session lands in one bucket, so the series sums to the totals.
 *
 * The usage sums are the netting evaluated per session and summed over the
 * group. Written as one pass per measure over the netted claims, the same
 * eight the sessions list makes, because what a level computes is what it
 * costs: the warehouse analyses every lambda in a SELECT before it reads a
 * row.
 */
const measures = ($: SessionColumns) => ({
	sessions: CH.count(),
	erroredSessions: CH.countIf($.errorSpans.gt(0)),
	llmCalls: CH.sum(sessionLlmCalls("netted")),
	llmCallSpans: CH.sum($.llmCallSpans),
	erroredLlmCalls: CH.sum($.erroredLlmCalls),
	toolCalls: CH.sum($.toolCalls),
	erroredToolCalls: CH.sum($.erroredToolCalls),
	cost: CH.sum(sessionUsageSum("netted", "cost")),
	pricedLlmCalls: CH.sum(sessionPricedLlmCalls("netted")),
	tokens: CH.sum(sessionUsageSum("netted", "tokens")),
	inputTokens: CH.sum(sessionUsageSum("netted", "inputTokens")),
	cacheReadTokens: CH.sum(sessionUsageSum("netted", "cacheReadTokens")),
	cacheWriteTokens: CH.sum(sessionUsageSum("netted", "cacheWriteTokens")),
	outputTokens: CH.sum(sessionUsageSum("netted", "outputTokens")),
	reasoningTokens: CH.sum(sessionUsageSum("netted", "reasoningTokens")),
	// A quantile over an empty group is NULL, which the row schema refuses.
	sessionDurationP50Ns: finiteOrZero(CH.quantile(0.5)($.sessionDurationNs)),
	sessionDurationP95Ns: finiteOrZero(CH.quantile(0.95)($.sessionDurationNs)),
})

/** Every measure at zero — the shape a branch that measures something else
 *  still has to project, since a `UNION ALL`'s branches share one row. */
const noMeasures = () => ({
	sessions: CH.lit(0),
	erroredSessions: CH.lit(0),
	llmCalls: CH.lit(0),
	llmCallSpans: CH.lit(0),
	erroredLlmCalls: CH.lit(0),
	toolCalls: CH.lit(0),
	erroredToolCalls: CH.lit(0),
	cost: CH.lit(0),
	pricedLlmCalls: CH.lit(0),
	tokens: CH.lit(0),
	inputTokens: CH.lit(0),
	cacheReadTokens: CH.lit(0),
	cacheWriteTokens: CH.lit(0),
	outputTokens: CH.lit(0),
	reasoningTokens: CH.lit(0),
	sessionDurationP50Ns: CH.lit(0),
	sessionDurationP95Ns: CH.lit(0),
})

export interface AiOverviewMeasuresOutput {
	readonly sessions: number
	readonly erroredSessions: number
	readonly llmCalls: number
	readonly llmCallSpans: number
	readonly erroredLlmCalls: number
	readonly toolCalls: number
	readonly erroredToolCalls: number
	readonly cost: number
	readonly pricedLlmCalls: number
	readonly tokens: number
	readonly inputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	readonly sessionDurationP50Ns: number
	readonly sessionDurationP95Ns: number
}

export interface AiOverviewTotalsOutput extends AiOverviewMeasuresOutput {
	readonly period: AiOverviewPeriod
}

export interface AiOverviewSeriesOutput extends AiOverviewTotalsOutput {
	/** ISO-8601 with a literal `Z`. */
	readonly bucket: string
}

export interface AiOverviewBreakdownOutput extends AiOverviewTotalsOutput {
	readonly key: string
	/** Distinct keys the current window has — carried by the `keys` branch
	 *  alone, 0 on the two that measure. */
	readonly keyCount: number
}

/**
 * The KPI tiles: every measure over the caller's window, and over the window of
 * equal length immediately before it.
 *
 * One read rather than two requests, and not folded from the series either:
 * quantiles cannot be merged after the fact, so a p95 for the window is only
 * available from a read that grouped the window. The previous branch is bounded
 * by its own pair of params (`prevStartTime`/`prevEndTime`), which the caller
 * computes — the query has no opinion about what "previous" means beyond
 * reading a second window, half-open at its upper bound so a session on the
 * boundary is measured once (see {@link withinWindow}).
 */
export function aiOverviewTotalsQuery(opts: AiOverviewFilterOpts = {}): CHUnionQuery<AiOverviewTotalsOutput> {
	const branch = (window: AiOverviewWindow) =>
		fromQuery(nettedRows(opts, window), `netted_${window}`).select(($) => ({
			period: periodLit(window),
			...measures($),
		}))
	return unionAll(branch("current"), branch("previous")).format("JSON")
}

/**
 * The chart: the same measures, cut into buckets.
 *
 * A session is filed under the bucket its FIRST span started in, so the points
 * sum to the totals — every other reading counts a session that ran across a
 * bucket boundary twice. The session's whole netted usage goes with it, which
 * is the simplification the attribution makes: at bucket widths of five
 * minutes and up a session's spans are inside one bucket or the next.
 */
export function aiOverviewSeriesQuery(opts: AiOverviewFilterOpts = {}): CHUnionQuery<AiOverviewSeriesOutput> {
	const branch = (window: AiOverviewWindow) =>
		fromQuery(nettedRows(opts, window), `netted_${window}`)
			.select(($) => ({
				period: periodLit(window),
				bucket: isoBucket($.sessionStart),
				...measures($),
			}))
			.groupBy("bucket")
	// Oldest first, so a client plots the points in the order they arrive.
	return unionAll(branch("current"), branch("previous"))
		.orderBy(["period", "asc"], ["bucket", "asc"])
		.format("JSON")
}

/**
 * Every key of the current window with its session count — one row per key,
 * which is both the ranking the table is cut from and the count of what the
 * table is not showing.
 *
 * Ranked on sessions alone, off the raw index rows rather than the netted
 * pipeline: which keys the table shows is a question about counts, and running
 * the netting a third time to break a tie by cost would cost more than the tie
 * is worth. The key breaks ties instead, so two keys with the same session
 * count cannot swap places between loads.
 */
const rankedKeys = (opts: AiOverviewBreakdownOpts) => {
	const population = dimensionPopulation(opts.dimension)
	const key = dimensionKey(opts.dimension)
	return from(AiTraceIndex)
		.innerJoinQuery(traceKeys(opts, "current"), "trace", (row, trace) => row.TraceId.eq(trace.TraceId))
		.select(($) => ({
			rankKey: key($),
			rankSessions: CH.uniqExact(sessionKey($.trace.rawSessionId, $.TraceId)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...withinWindow($.Timestamp, "current"),
			population === undefined ? undefined : population($),
		])
		.groupBy("rankKey")
}

/** The busiest of them, as a one-column subquery for `IN`. */
const topKeys = (opts: AiOverviewBreakdownOpts) =>
	fromQuery(
		rankedKeys(opts)
			.orderBy(["rankSessions", "desc"], ["rankKey", "asc"])
			.limit(opts.limit ?? AI_OVERVIEW_BREAKDOWN_MAX),
		"top_keys",
	).select(($) => ({ topKey: $.rankKey }))

/**
 * The breakdown table: the busiest keys of the current window, each measured
 * over both windows.
 *
 * Three branches. Two measure the keys the ranking picked — the previous one
 * over the same keys, so a key that stopped being used still shows what it
 * cost. The third counts the window's distinct keys, which is what lets the
 * table say how many it is not showing: the groups the ranking already forms,
 * counted, rather than a third read of the index.
 */
export function aiOverviewBreakdownQuery(
	opts: AiOverviewBreakdownOpts,
): CHUnionQuery<AiOverviewBreakdownOutput> {
	// Rendered into BOTH measuring branches: a `CHUnionQuery` takes no `WITH`,
	// so the branches have no CTE to share the ranking through.
	const keys = topKeys(opts)
	const branch = (window: AiOverviewWindow) =>
		fromQuery(nettedRows(opts, window, opts.dimension), `netted_${window}`)
			.select(($) => ({
				period: periodLit(window),
				key: $.key,
				keyCount: CH.lit(0),
				...measures($),
			}))
			.where(($) => [inSubquery($.key, keys)])
			.groupBy("key")
	const keyCount = fromQuery(rankedKeys(opts), "window_keys").select(() => ({
		period: periodLit("keys"),
		key: CH.lit(""),
		keyCount: CH.count(),
		...noMeasures(),
	}))
	return unionAll(branch("current"), branch("previous"), keyCount).format("JSON")
}

/** Models the mix plots as bands of their own. Everything past them is one
 *  `other` band, which is what bounds the response. */
const AI_OVERVIEW_MODEL_MIX_BANDS = 5

/** The band every model outside the top {@link AI_OVERVIEW_MODEL_MIX_BANDS} is
 *  counted under — the key the client folds its own tail into. */
const AI_OVERVIEW_MODEL_MIX_OTHER = "other"

/**
 * Rows one model mix returns, across every bucket and band together.
 *
 * A guard the page cannot reach rather than a cut: the tail is folded in SQL,
 * so a bucket answers at most six rows and a year of daily buckets is still
 * well inside this.
 */
export const AI_OVERVIEW_MODEL_MIX_MAX_ROWS = 4000

export interface AiOverviewModelMixOutput {
	/** ISO-8601 with a literal `Z`. */
	readonly bucket: string
	/** The model the spans named, or the folded `other` band. */
	readonly model: string
	readonly llmCallSpans: number
}

/**
 * The busiest models of the window, as a one-column subquery for `IN`.
 *
 * Ranked over the population the mix counts — model-call SPANS naming a model,
 * among the selected sessions — so the bands are the ones a full answer would
 * have shown. The name breaks ties, so two models with the same count cannot
 * swap bands between loads.
 */
const topModels = (opts: AiOverviewFilterOpts) => {
	const ranked = from(AiTraceIndex)
		.innerJoinQuery(traceKeys(opts, "current"), "trace", (row, trace) => row.TraceId.eq(trace.TraceId))
		.select(($) => ({ rankModel: CH.toString_($.Model), rankSpans: CH.count() }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...withinWindow($.Timestamp, "current"),
			$.IsLlmCall.eq(1),
			$.Model.neq(""),
		])
		.groupBy("rankModel")
		.orderBy(["rankSpans", "desc"], ["rankModel", "asc"])
		.limit(AI_OVERVIEW_MODEL_MIX_BANDS)
	return fromQuery(ranked, "top_models").select(($) => ({ topModel: $.rankModel }))
}

/**
 * The model mix: the window's model-call SPANS, split by band, bucket by
 * bucket.
 *
 * The share of model SPANS and not of netted calls — this is a plain GROUP BY
 * over the index, where the netting is a per-session array pass — so a
 * gateway's mirror of a call is counted under the model it names, twice. It is
 * the same population the summary counts as `llmCallSpans`, less the calls
 * whose instrumentation named no model: those carry no share of a model mix,
 * so the two totals differ by exactly them.
 *
 * The TAIL IS FOLDED HERE. Ordered by bucket and cut at a row cap, the cap
 * drops the newest buckets — the end of the chart — in exactly the org that
 * needs the chart most. Ranking the window's models once and counting the rest
 * under `other` bounds a bucket at six rows instead, and it is the band the
 * client would have folded anyway.
 *
 * A span is filed under the bucket ITS OWN timestamp falls in, where the
 * summary's series files a whole session under the bucket it started in. The
 * rows here are spans, so there is no session to keep whole.
 *
 * Sessions are selected the way every other read in this file selects them —
 * `traceKeys`, the failed-session test included — so the mix describes the
 * sessions the tiles above it measure. The current window alone: the chart has
 * no comparison band.
 */
export function aiOverviewModelMixQuery(
	opts: AiOverviewFilterOpts = {},
): CHQuery<ColumnDefs, AiOverviewModelMixOutput, {}> {
	const bands = topModels(opts)
	return from(AiTraceIndex)
		.innerJoinQuery(traceKeys(opts, "current"), "trace", (row, trace) => row.TraceId.eq(trace.TraceId))
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			// `toString` for the reason the breakdown's key takes it: `Model` is
			// `LowCardinality(String)` in the index, and a model key is a plain
			// `String` everywhere else the page reads one.
			model: CH.if_(
				inSubquery(CH.toString_($.Model), bands),
				CH.toString_($.Model),
				CH.lit(AI_OVERVIEW_MODEL_MIX_OTHER),
			),
			llmCallSpans: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...withinWindow($.Timestamp, "current"),
			$.IsLlmCall.eq(1),
			$.Model.neq(""),
		])
		.groupBy("bucket", "model")
		.orderBy(["bucket", "asc"], ["llmCallSpans", "desc"])
		.limit(AI_OVERVIEW_MODEL_MIX_MAX_ROWS)
		.format("JSON")
}
