// Agent Sessions › Tools — the warehouse reads behind the tool analytics page.
//
// Everything here is `ai_trace_index` and nothing else: the filtered projection
// `ai_trace_index_mv` writes for every vendor-stamped GenAI span (see
// `ai-sessions.ts` for what that index is and what it costs). A tool call is an
// index row with `IsToolCall = 1`; the page's four reads are four different
// groupings of exactly that population, measured over 7 days of production at
// 60–130ms each, which is why none of them is cached or split in two the way
// the sessions list had to be.
//
// Two facts about tool rows shape every query in this file.
//
//   1. A tool row NEVER carries `Model`. The three GenAI identity columns are
//      mutually exclusive by construction — a chat span has a model and no
//      tool, a tool span the reverse — so "which model called this tool" is a
//      question about the tool span's NEIGHBOURS, not about the row. It is
//      answered in two steps: the parent span first
//      (`(TraceId, ParentSpanId) = (TraceId, SpanId)` against the index rows
//      that do carry a model), which covers 99.3% of maple-vendor tool spans,
//      and the trace's own model second (`anyIf(Model, Model != '')` per
//      trace) for the vendors whose tool spans hang off a workflow node rather
//      than the model call — vercel, and the `unknown:*` buckets. A tool call
//      that neither resolves keys under `''`, which the page renders as
//      unattributed rather than hiding.
//
//   2. `SessionId` on a tool row is vendor-dependent and usually `''` — the
//      session key sits on the turn-owning span alone. So the session a tool
//      call belongs to is resolved per TRACE, exactly as the sessions list
//      resolves it: `max(SessionId)` over the trace's index rows, then
//      `sessionKey(…)`, which files a trace whose vendor exposes no session
//      key under `trace:<TraceId>`. Sharing that helper is the point — a
//      second derivation would count sessions the list page never showed.
//
// Both facts are answered by the same two derived tables, joined into every
// read: `parentModels` (the model-bearing index rows, keyed by span) and
// `traceFacts` (one row per trace: its session key and its model). They are
// LEFT and INNER respectively, because a tool call may have no model-bearing
// parent but always belongs to a trace of the same window.
//
// Percentiles are the reason `totals` is its own query rather than a client-side
// fold of `series`: quantiles do not merge. The same reason keeps the previous
// window inside the totals read (a `UNION ALL` branch over `prevStartTime`/
// `prevEndTime`) instead of making it a second request.
//
// Durations stay in NANOSECONDS, like every other AI read — `Duration` is what
// the index stores and the client formats. Zero-duration tool spans are real
// (structured-output pseudo-tools emitted by several SDKs) and are NOT filtered
// out: they are calls, and dropping them would move every percentile.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import {
	from,
	fromQuery,
	inSubquery,
	param,
	unionAll,
	type CHUnionQuery,
} from "@maple-dev/effect-clickhouse"
import { AI_TOOLS_OTHER_SERIES_KEY } from "@maple/domain/http"
import { AiTraceIndex } from "@maple/query-engine/ch/tables"
import { finiteOrZero, isoBucket } from "@maple/query-engine/ch/format"
import { sessionKey } from "./ai-sessions"

/**
 * The page's selection, as every read here takes it.
 *
 * `tool` and `model` are the two the page's state machine drives; `service`
 * and `env` are the ambient scope the rest of the product filters by. All four
 * are exact matches, not prefixes — they come from the sessions page's own
 * facets, so a value that is not a facet value selects nothing by design.
 */
export interface AiToolsFilterOpts {
	/** `gen_ai.tool.name`, as the index stores it. */
	readonly tool?: string
	/** The RESOLVED model — the parent's, else the trace's. See the file header. */
	readonly model?: string
	readonly service?: string
	/** `deployment.environment(.name)`, both spellings coalesced by the MV. */
	readonly env?: string
	/**
	 * Tool-name substring, case-insensitive — the toolbar's text box, and the
	 * one filter here that is NOT an exact facet value. It narrows the whole
	 * population, so the tiles, the chart and both panels agree about which
	 * calls they are describing.
	 */
	readonly search?: string
	/** Keep only calls whose span failed (`IsError = 1`). */
	readonly failingOnly?: boolean
}

/** A search needle is a literal, so its `%`/`_` must not act as LIKE wildcards. */
const likeLiteral = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * Which pair of params bounds a read: the caller's window, or the window of
 * equal length immediately before it. Only the totals query uses `previous`,
 * and it uses both — one `UNION ALL` branch each.
 */
export type AiToolsWindow = "current" | "previous"

const startParam = (window: AiToolsWindow) =>
	param.dateTimeString(window === "current" ? "startTime" : "prevStartTime")
const endParam = (window: AiToolsWindow) =>
	param.dateTimeString(window === "current" ? "endTime" : "prevEndTime")

/** Series a bucketed read returns before the rest collapse into
 *  {@link AI_TOOLS_OTHER_SERIES_KEY}. */
export const AI_TOOLS_SERIES_MAX_KEYS = 8

/** Rows one breakdown branch returns. Both branches are ordered by calls, so
 *  this is "the 50 busiest", not an arbitrary 50. */
export const AI_TOOLS_BREAKDOWN_LIMIT = 50

/** Sessions the selection's session list returns, busiest first. */
export const AI_TOOLS_SESSIONS_LIMIT = 50

/**
 * The model-bearing index rows of the window, keyed by the span a tool call
 * would name as its parent. Left-joined, so a tool span whose parent is a
 * workflow node (or whose parent was never exported) still produces a row.
 */
const parentModels = (window: AiToolsWindow) =>
	from(AiTraceIndex)
		.select(($) => ({ TraceId: $.TraceId, SpanId: $.SpanId, Model: $.Model }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(startParam(window)),
			$.Timestamp.lte(endParam(window)),
			// The join key is `(TraceId, ParentSpanId)`, so rows with no model are
			// dead weight in the hash table AND would resolve a tool call to `''`
			// where the trace fallback would have answered.
			$.Model.neq(""),
		])
		// A DISTINCT, not an aggregation: the right side of a LEFT JOIN multiplies
		// its matches, so one duplicated index row (a replayed insert into an MV
		// that does not de-duplicate) would double the tool call it joins to.
		.groupBy("TraceId", "SpanId", "Model")

/**
 * One row per trace: the session it is filed under, and the model it ran on.
 *
 * `max(SessionId)` because the id sits on the turn-owning span alone and every
 * other row of the trace reads `''`, which `max` discards — the same derivation
 * `indexTraces` makes for the sessions list, so a tool call lands under the
 * session id that page showed.
 *
 * `traceModel` is `anyIf`, not `argMin`: a trace that used two models has no
 * one answer, and the fallback exists for traces whose tool spans carry no
 * model lineage at all — where any model of the trace is a better answer than
 * none. Tool calls attributed this way are the vercel/unknown minority.
 */
const traceFacts = (window: AiToolsWindow) =>
	from(AiTraceIndex)
		.select(($) => ({
			TraceId: $.TraceId,
			rawSessionId: CH.max_($.SessionId),
			traceModel: CH.anyIf($.Model, $.Model.neq("")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(startParam(window)),
			$.Timestamp.lte(endParam(window)),
		])
		.groupBy("TraceId")

/**
 * The model a tool call is attributed to: its parent model call's, else its
 * trace's, else `''`.
 *
 * ClickHouse's default `join_use_nulls = 0` already turns an unmatched LEFT
 * JOIN into `''` rather than NULL; the `ifNull` is what makes the TYPE agree
 * with that, since `leftJoinQuery` declares the joined side nullable.
 */
const resolvedModel = (parentModel: CH.Expr<string | null>, traceModel: CH.Expr<string>): CH.Expr<string> => {
	const parent = CH.ifNull(parentModel, CH.lit(""))
	return CH.if_(parent.neq(""), parent, traceModel)
}

/**
 * One row per tool call in the window, with its model and session resolved —
 * the level all four reads aggregate. Every filter the page carries is applied
 * here, including `model`, which is an expression rather than a column and so
 * cannot be pushed any lower.
 *
 * Column names are deliberately NOT the names the outer aggregates select
 * (`ts` vs `bucket`, `svc` vs `serviceName`): an outer alias shadows a derived
 * column of the same name, and an aggregate over the shadowed name becomes a
 * cyclic alias rather than the aggregate the author meant.
 */
const toolCalls = (opts: AiToolsFilterOpts, window: AiToolsWindow = "current") =>
	from(AiTraceIndex)
		.leftJoinQuery(parentModels(window), "parent", (call, parent) =>
			call.TraceId.eq(parent.TraceId).and(call.ParentSpanId.eq(parent.SpanId)),
		)
		.innerJoinQuery(traceFacts(window), "trace", (call, trace) => call.TraceId.eq(trace.TraceId))
		.select(($) => ({
			ts: $.Timestamp,
			sessionKey: sessionKey($.trace.rawSessionId, $.TraceId),
			toolName: $.ToolName,
			modelName: resolvedModel($.parent.Model, $.trace.traceModel),
			svc: $.ServiceName,
			agent: $.AgentName,
			isError: $.IsError,
			durationNs: $.Duration,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(startParam(window)),
			$.Timestamp.lte(endParam(window)),
			// The whole population, and the only predicate that is not a filter:
			// `IsToolCall` is what the MV stamped on a span the vendor mapper
			// classified as a tool call.
			$.IsToolCall.eq(1),
			CH.when(opts.tool, (tool) => $.ToolName.eq(tool)),
			CH.when(opts.service, (service) => $.ServiceName.eq(service)),
			CH.when(opts.env, (env) => $.DeploymentEnv.eq(env)),
			CH.when(opts.model, (model) => resolvedModel($.parent.Model, $.trace.traceModel).eq(model)),
			CH.when(opts.search, (search) => $.ToolName.ilike(`%${likeLiteral(search)}%`)),
			CH.whenTrue(opts.failingOnly, () => $.IsError.eq(1)),
		])

/** The accessor shape every aggregate below reads off {@link toolCalls}. */
interface ToolCallColumns {
	readonly ts: CH.Expr<string>
	readonly sessionKey: CH.Expr<string>
	readonly toolName: CH.Expr<string>
	readonly modelName: CH.Expr<string>
	readonly svc: CH.Expr<string>
	readonly agent: CH.Expr<string>
	readonly isError: CH.Expr<number>
	readonly durationNs: CH.Expr<number>
}

/**
 * The four measures every grouping reports, so a tile, a point on the chart and
 * a breakdown row are the same numbers under different `GROUP BY`s.
 *
 * `uniqExact` rather than `uniq`: the counts have to agree with the sessions
 * list beside them, and an agent org's session counts are small enough that the
 * exact aggregate costs nothing.
 *
 * The percentiles are three separate `quantile` calls rather than one
 * `quantiles(…)` array, because an array column decodes as an array and every
 * consumer wants three named fields. `finiteOrZero` guards the empty group: a
 * quantile over no rows is NULL, which the row schema refuses.
 */
const measures = ($: ToolCallColumns) => ({
	calls: CH.count(),
	sessions: CH.uniqExact($.sessionKey),
	errors: CH.sum($.isError),
	p50: finiteOrZero(CH.quantile(0.5)($.durationNs)),
	p90: finiteOrZero(CH.quantile(0.9)($.durationNs)),
	p95: finiteOrZero(CH.quantile(0.95)($.durationNs)),
})

/**
 * Which dimension the chart's series are keyed by, derived from the selection
 * alone — the page never asks for one.
 *
 * No tool selected, so the chart compares tools. A tool selected but no model,
 * so it compares the models that tool ran under. Both selected, so there is one
 * series and its key is the tool.
 */
export type AiToolsSeriesKind = "tool" | "model"

export const aiToolsSeriesKind = (opts: AiToolsFilterOpts): AiToolsSeriesKind =>
	opts.tool !== undefined && opts.model === undefined ? "model" : "tool"

const seriesKeyColumn = (opts: AiToolsFilterOpts) => (($: ToolCallColumns) =>
	aiToolsSeriesKind(opts) === "model" ? $.modelName : $.toolName)

/**
 * The busiest {@link AI_TOOLS_SERIES_MAX_KEYS} keys of the selection, as a
 * one-column subquery for `IN`.
 *
 * Two levels because an `IN` subquery must project exactly one column while the
 * ranking needs the count it orders by. The inner scan is the same
 * `toolCalls` read the series itself runs — ClickHouse pays for the index twice
 * here, which at ~10k index rows a day is the cheaper half of the alternative
 * (a second round trip, and a chart that disagrees with its own legend when the
 * two reads land either side of an insert).
 */
const topSeriesKeys = (opts: AiToolsFilterOpts) => {
	const key = seriesKeyColumn(opts)
	const ranked = fromQuery(toolCalls(opts), "series_ranking")
		.select(($) => ({ rankKey: key($), rankCalls: CH.count() }))
		.groupBy("rankKey")
		// The key breaks ties, so two keys with the same call count cannot swap
		// places between loads and move a series in and out of `other`.
		.orderBy(["rankCalls", "desc"], ["rankKey", "asc"])
		.limit(AI_TOOLS_SERIES_MAX_KEYS)
	return fromQuery(ranked, "top_series_keys").select(($) => ({ topKey: $.rankKey }))
}

/**
 * The chart: the measures bucketed by time and split by series key.
 *
 * The key is `tool` or `model` per {@link aiToolsSeriesKind} — the caller reads
 * that from the same helper rather than being told, so the response shape does
 * not depend on the query having run.
 *
 * Keys past the top N collapse into `other` rather than being dropped, so the
 * chart's stacked total still equals the totals tile. That fold is also why the
 * quantiles of `other` are the quantiles of the merged population and not an
 * average of the merged series' quantiles — the only form of it that is a real
 * number.
 *
 * A key of `''` is a real answer, not a gap: a tool call whose model resolved
 * to neither its parent nor its trace. The page renders it as unattributed.
 */
export function aiToolsSeriesQuery(opts: AiToolsFilterOpts = {}) {
	const key = seriesKeyColumn(opts)
	return fromQuery(toolCalls(opts), "tool_calls")
		.select(($) => ({
			bucket: isoBucket($.ts),
			seriesKey: CH.if_(
				inSubquery(key($), topSeriesKeys(opts)),
				key($),
				CH.lit(AI_TOOLS_OTHER_SERIES_KEY),
			),
			...measures($),
		}))
		.groupBy("bucket", "seriesKey")
		// Oldest first, and the busiest series first inside a bucket — the order
		// a stacked chart draws in.
		.orderBy(["bucket", "asc"], ["calls", "desc"], ["seriesKey", "asc"])
		.format("JSON")
}

/** Which window a totals row measures. */
export type AiToolsPeriod = "current" | "previous"

export interface AiToolsTotalsOutput {
	readonly period: string
	readonly calls: number
	readonly sessions: number
	readonly errors: number
	readonly p50: number
	readonly p90: number
	readonly p95: number
}

/**
 * The KPI tiles: the same measures un-bucketed, for the caller's window and for
 * the window of equal length immediately before it.
 *
 * One query rather than two requests, and not folded from `series` either:
 * quantiles cannot be merged after the fact, so a p95 for the window is only
 * available from a read that grouped the window. The previous branch is bounded
 * by its own pair of params (`prevStartTime`/`prevEndTime`), which the caller
 * computes — the query has no opinion about what "previous" means beyond
 * reading a second window.
 */
export function aiToolsTotalsQuery(opts: AiToolsFilterOpts = {}): CHUnionQuery<AiToolsTotalsOutput> {
	const branch = (window: AiToolsWindow, period: AiToolsPeriod) =>
		fromQuery(toolCalls(opts, window), `tool_calls_${period}`).select(($) => ({
			period: CH.lit(period),
			...measures($),
		}))
	return unionAll(branch("current", "current"), branch("previous", "previous")).format("JSON")
}

/** Which dimension a breakdown row keys on. */
export type AiToolsBreakdownKind = "tool" | "model"

export interface AiToolsBreakdownsOutput {
	readonly kind: string
	readonly key: string
	readonly calls: number
	readonly sessions: number
	readonly errors: number
	readonly p50: number
	readonly p90: number
	readonly p95: number
	readonly lastSeen: string
}

/**
 * Both side panels in one read: tool rows and model rows, tagged by `kind`.
 *
 * Each branch drops its OWN dimension from the filters and keeps the other's —
 * the tool list is every tool the selected MODEL ran, and the model list is
 * every model the selected TOOL ran under. A branch that kept its own filter
 * would return exactly the one row the user already clicked, which is what the
 * panel is for choosing an alternative to.
 *
 * `GROUPING SETS` would express this in one scan and the builder has no
 * `GROUPING SETS`; the two branches also differ in their filters, which a
 * grouping set could not express anyway.
 */
export function aiToolsBreakdownsQuery(
	opts: AiToolsFilterOpts = {},
): CHUnionQuery<AiToolsBreakdownsOutput> {
	const branch = (kind: AiToolsBreakdownKind, scoped: AiToolsFilterOpts, key: ($: ToolCallColumns) => CH.Expr<string>) =>
		fromQuery(toolCalls(scoped), `${kind}_breakdown`)
			.select(($) => ({
				kind: CH.lit(kind),
				key: key($),
				...measures($),
				lastSeen: CH.toString_(CH.max_($.ts)),
			}))
			.groupBy("kind", "key")
			.orderBy(["calls", "desc"], ["key", "asc"])
			.limit(AI_TOOLS_BREAKDOWN_LIMIT)
	return unionAll(
		branch("tool", { ...opts, tool: undefined }, ($) => $.toolName),
		branch("model", { ...opts, model: undefined }, ($) => $.modelName),
	).format("JSON")
}

export interface AiToolsSessionsOpts extends AiToolsFilterOpts {
	/** Defaults to {@link AI_TOOLS_SESSIONS_LIMIT}. */
	readonly limit?: number
}

/**
 * The sessions that invoked the selection, busiest first — the page's drill-in
 * from a tool (× model) to the runs it happened in.
 *
 * The session key is the sessions list's own (`sessionKey`, per trace), so a
 * row here links straight to that page. A session spanning several traces is
 * one row, and its `agentName`/`model`/`serviceName` are `anyIf` over the tool
 * calls that matched: one value where the session is homogeneous, which it
 * almost always is, and an arbitrary one of them where it is not. The page
 * shows them as labels, not as facts to filter on.
 *
 * Durations are the matched TOOL CALLS', not the session's — average and
 * maximum nanoseconds over the calls this selection counted.
 */
export function aiToolsSessionsQuery(opts: AiToolsSessionsOpts = {}) {
	return fromQuery(toolCalls(opts), "tool_calls")
		.select(($) => ({
			sessionId: $.sessionKey,
			agentName: CH.anyIf($.agent, $.agent.neq("")),
			model: CH.anyIf($.modelName, $.modelName.neq("")),
			serviceName: CH.anyIf($.svc, $.svc.neq("")),
			calls: CH.count(),
			errors: CH.sum($.isError),
			avgDurationNs: finiteOrZero(CH.avg($.durationNs)),
			maxDurationNs: CH.max_($.durationNs),
			startedAt: CH.toString_(CH.min_($.ts)),
		}))
		.groupBy("sessionId")
		// The id breaks ties so a page of equally busy sessions is stable.
		.orderBy(["calls", "desc"], ["sessionId", "asc"])
		.limit(opts.limit ?? AI_TOOLS_SESSIONS_LIMIT)
		.format("JSON")
}
