// Agent Sessions › Tools — the warehouse reads behind the tool analytics page.
//
// Everything here is `ai_trace_index` and nothing else: the filtered projection
// `ai_trace_index_mv` writes for every vendor-stamped GenAI span (see
// `ai-sessions.ts` for what that index is and what it costs). A tool call is an
// index row with `IsToolCall = 1`; the overview's three reads are three
// different groupings of exactly that population, measured over 7 days of
// production at 60–130ms each, which is why none of them is cached or split in
// two the way the sessions list had to be.
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
import { AI_TOOLS_BREAKDOWN_MAX, AI_TOOLS_OTHER_SERIES_KEY } from "@maple/domain/http"
import type { AiGenAiField } from "@maple/domain/gen-ai"
import { Schema } from "effect"
import type { CompiledQueryRowSchema } from "@maple-dev/effect-clickhouse"
import { AiTraceIndex, TraceDetailSpans } from "@maple/query-engine/ch/tables"
import { finiteOrZero, isoBucket, leftUTF8 } from "@maple/query-engine/ch/format"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { aiFieldSourceKeys } from "./ai-integrations"
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
	/**
	 * What the chart's series split by, where the caller has an opinion. Absent
	 * means {@link aiToolsSeriesKind} derives it from the selection, which is what
	 * the overview wants; the tool detail page asks for `none` explicitly — it is
	 * already one tool's page, and a split it then re-merges client-side would
	 * double-count sessions and average quantiles.
	 */
	readonly split?: AiToolsSeriesKind
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

/** Rows the Tools breakdown returns. Ordered by calls, so this is "the 50
 *  busiest", not an arbitrary 50 — the page's footer says so off the same
 *  number, which is why it is declared in the domain contract. */
export const AI_TOOLS_BREAKDOWN_LIMIT = AI_TOOLS_BREAKDOWN_MAX

/**
 * The model-bearing index rows of the window, keyed by the span a tool call
 * would name as its parent. Left-joined, so a tool span whose parent is a
 * workflow node (or whose parent was never exported) still produces a row.
 */
const parentModels = (window: AiToolsWindow) =>
	from(AiTraceIndex)
		.select(($) => ({
			TraceId: $.TraceId,
			SpanId: $.SpanId,
			// Not aliased `Model`: an aggregate named after its own input column
			// would be what the WHERE below resolves `Model` to.
			parentModel: CH.anyIf($.Model, $.Model.neq("")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(startParam(window)),
			$.Timestamp.lte(endParam(window)),
			// The join key is `(TraceId, ParentSpanId)`, so rows with no model are
			// dead weight in the hash table AND would resolve a tool call to `''`
			// where the trace fallback would have answered.
			$.Model.neq(""),
		])
		// One row per span, not per (span, model): the right side of a LEFT JOIN
		// multiplies its matches, so a duplicated index row (a replayed insert into
		// an MV that does not de-duplicate) or one span indexed under two model
		// values would double the tool call it joins to.
		.groupBy("TraceId", "SpanId")

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
 * the level every read below aggregates. Every filter the page carries is applied
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
			traceId: $.TraceId,
			sessionKey: sessionKey($.trace.rawSessionId, $.TraceId),
			toolName: $.ToolName,
			modelName: resolvedModel($.parent.parentModel, $.trace.traceModel),
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
			CH.when(opts.model, (model) => resolvedModel($.parent.parentModel, $.trace.traceModel).eq(model)),
			CH.when(opts.search, (search) => $.ToolName.ilike(`%${likeLiteral(search)}%`)),
			CH.whenTrue(opts.failingOnly, () => $.IsError.eq(1)),
		])

/** The accessor shape every aggregate below reads off {@link toolCalls}. */
interface ToolCallColumns {
	readonly ts: CH.Expr<string>
	readonly traceId: CH.Expr<string>
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
export type AiToolsSeriesKind = "tool" | "model" | "none"

export const aiToolsSeriesKind = (opts: AiToolsFilterOpts): AiToolsSeriesKind =>
	opts.split ??
	(opts.tool !== undefined && opts.model === undefined ? "model" : "tool")

/**
 * The expression a bucket is split by, or `undefined` for `none` — one series
 * over the whole selection, whose measures are therefore the real quantiles and
 * the real `uniqExact` rather than a client-side merge of per-model ones.
 */
const seriesKeyColumn = (opts: AiToolsFilterOpts) => {
	const kind = aiToolsSeriesKind(opts)
	if (kind === "none") return undefined
	return ($: ToolCallColumns) => (kind === "model" ? $.modelName : $.toolName)
}

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
const topSeriesKeys = (opts: AiToolsFilterOpts, key: ($: ToolCallColumns) => CH.Expr<string>) => {
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
			// `none` still projects the column, so the response shape does not
			// depend on the split. `''` is the only honest key for a series that
			// is not keyed by anything.
			seriesKey:
				key === undefined
					? CH.lit("")
					: CH.if_(
							inSubquery(key($), topSeriesKeys(opts, key)),
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

/** A datetime aggregate as `''` where the aggregate saw no rows at all. Only
 *  un-grouped aggregates need it — a GROUP BY key exists because a row produced
 *  it, so a grouped `min()` always has one to report. */
const emptyWhenNoRows = (value: CH.Expr<string>): CH.Expr<string> =>
	CH.if_(CH.count().eq(0), CH.lit(""), CH.toString_(value))

/** Which window a totals row measures. `window` is the third branch: the
 *  window's whole session population, before any of the page's filters. */
export type AiToolsPeriod = "current" | "previous" | "window"

export interface AiToolsTotalsOutput {
	readonly period: string
	readonly calls: number
	readonly sessions: number
	readonly errors: number
	readonly p50: number
	readonly p90: number
	readonly p95: number
	/** Warehouse datetime of the first and last matched call, `''` for a period
	 *  that matched nothing. Bounded by the read's window, so "first seen" means
	 *  "first seen in this range". */
	readonly firstSeen: string
	readonly lastSeen: string
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
			// A non-grouped `min()`/`max()` over zero rows returns the DateTime
			// default (`1970-01-01 00:00:00`), not an empty string — so a period
			// that matched nothing would claim a first call in 1970. The contract
			// these two carry is `''` for "nothing matched"; this is what holds it.
			firstSeen: emptyWhenNoRows(CH.min_($.ts)),
			lastSeen: emptyWhenNoRows(CH.max_($.ts)),
		}))
	// The window's whole session population, which is the denominator the
	// Sessions tile reads ("142 of all 1,284 sessions") and the count the tab
	// strip shows. Deliberately unscoped by the selection AND by the toolbar: it
	// is the same number the sessions list would show for this window, and a
	// share against a moving denominator is not a share.
	const windowPeriod: AiToolsPeriod = "window"
	const allSessions = fromQuery(traceFacts("current"), "window_traces").select(($) => ({
		period: CH.lit(windowPeriod),
		calls: CH.lit(0),
		sessions: CH.uniqExact(sessionKey($.rawSessionId, $.TraceId)),
		errors: CH.lit(0),
		p50: CH.lit(0),
		p90: CH.lit(0),
		p95: CH.lit(0),
		firstSeen: CH.lit(""),
		lastSeen: CH.lit(""),
	}))
	return unionAll(branch("current", "current"), branch("previous", "previous"), allSessions).format(
		"JSON",
	)
}

export interface AiToolsBreakdownsOutput {
	readonly key: string
	readonly calls: number
	readonly sessions: number
	readonly errors: number
	readonly p50: number
	readonly p90: number
	readonly p95: number
	readonly lastSeen: string
	/** The earliest call under this key IN THE WINDOW — what the page's "new"
	 *  badge reads. A tool that predates the window reports the window's start,
	 *  so the badge is a statement about this range and not about all time. */
	readonly firstSeen: string
}

/**
 * The Tools table: every tool of the window, busiest first.
 *
 * The selection's OWN tool is dropped and everything else kept — the table
 * exists to pick a different tool, and keeping the filter would return exactly
 * the one row the reader already clicked.
 *
 * `firstSeen` and `lastSeen` are grouped aggregates, so they need no
 * empty-window guard: a key is in the result because a row produced it.
 */
export function aiToolsBreakdownsQuery(opts: AiToolsFilterOpts = {}) {
	return fromQuery(toolCalls({ ...opts, tool: undefined }), "tool_breakdown")
		.select(($) => ({
			key: $.toolName,
			...measures($),
			lastSeen: CH.toString_(CH.max_($.ts)),
			firstSeen: CH.toString_(CH.min_($.ts)),
		}))
		.groupBy("key")
		.orderBy(["calls", "desc"], ["key", "asc"])
		.limit(AI_TOOLS_BREAKDOWN_LIMIT)
		.format("JSON")
}

/* -------------------------------------------------------------------------------------------------
 * Tool detail — the failures of one tool
 *
 * These three are the only reads on this page that are NOT `ai_trace_index`.
 * The index carries `IsError` and nothing about WHY: an error type, a status
 * message and a call's arguments and result live on the span, in
 * `trace_detail_spans`. So the shape is always the same — the index names the
 * traces (cheap, and it is where the page's selection is expressible), and the
 * span table is read only inside those traces:
 *
 *   TraceId IN (traces of this tool's failing calls) AND <this span is one>
 *
 * Without that subquery the span read is a whole-window scan of every span the
 * org emitted, which at this table's per-partition seek cost is seconds.
 *
 * Model is applied by the TRACE subquery alone, where the parent-model
 * attribution lives. A trace that ran two models and failed the same tool under
 * both therefore contributes both failures; the page states the selection above
 * the table, and the alternative is a second index scan to match span ids.
 */

/** The traces holding failing calls of the selection — the span read's prefilter. */
const failingToolTraceIds = (opts: AiToolsFilterOpts) =>
	fromQuery(toolCalls({ ...opts, failingOnly: true }), "failing_tool_calls")
		.select(($) => ({ traceId: $.traceId }))
		.groupBy("traceId")

const RESPONSE_STATUS_ATTR = "gen_ai.response.status"
/** `gen_ai.response.status` values that mean the call failed — semconv's
 *  `failed` plus the pre-enum `error` dialect. The same list the sessions
 *  reads use, so a failure counted there is a failure here. */
const FAILED_RESPONSE_STATUSES = ["failed", "error"]

/** How much of a status message a breakdown row carries. The table clamps it to
 *  one line anyway, and a stack trace in a `GROUP BY` key is not free. */
export const AI_TOOL_ERROR_MESSAGE_MAX = 400

/** How much of an argument or result payload one occurrence carries. Vendors put
 *  whole files in these; the modal shows a code block, not a file viewer, and
 *  reports the true size beside it. */
export const AI_TOOL_ERROR_PAYLOAD_MAX = 4_000

/** Error types one breakdown returns, worst first. */
export const AI_TOOL_ERRORS_LIMIT = 50

/** Occurrences (and their sessions) one modal opens with. */
export const AI_TOOL_OCCURRENCES_LIMIT = 50

type SpanAccessor = {
	readonly SpanAttributes: CH.Expr<Record<string, string>>
	readonly StatusCode: CH.Expr<string>
}

/** `coalesce(nullIf(a, ''), …, '')` — the first source key of a field that has
 *  a value, across every vendor dialect the integrations declare. */
const spanField = ($: SpanAccessor, field: AiGenAiField): CH.Expr<string> =>
	CH.coalesce(
		...aiFieldSourceKeys(field).map((key) => CH.nullIf(CH.mapGet($.SpanAttributes, key), "")),
		CH.lit(""),
	)

/** The span failed, by the sessions pages' rule. */
const spanFailed = ($: SpanAccessor) =>
	$.StatusCode.eq("Error").or(
		spanField($, "errorType")
			.neq("")
			.or(CH.inList(CH.mapGet($.SpanAttributes, RESPONSE_STATUS_ATTR), FAILED_RESPONSE_STATUSES)),
	)

export interface AiToolErrorsOpts extends AiToolsFilterOpts {
	/** The error type a modal is open on. `''` selects the failures that named
	 *  none, which is a real group and the one the page labels `unknown`. */
	readonly errorType?: string
	/** One session's occurrences — the modal's left pane, as a filter on its right. */
	readonly session?: string
	readonly limit?: number
}

/** `''` is a real error type — a span that failed without naming one. Passing
 *  it has to narrow, so the predicate is on presence of the OPT, not on truth
 *  of the value. */
const errorTypeFilter = (opts: AiToolErrorsOpts, errorType: CH.Expr<string>) =>
	opts.errorType === undefined ? undefined : errorType.eq(opts.errorType)

/**
 * One row per failed tool call of the selection: what failed, in which session,
 * and when. The level all three reads below aggregate.
 */
const toolErrorSpans = (opts: AiToolErrorsOpts) =>
	from(TraceDetailSpans)
		.leftJoinQuery(traceFacts("current"), "trace", (span, trace) => span.TraceId.eq(trace.TraceId))
		.select(($) => ({
			ts: $.Timestamp,
			traceId: $.TraceId,
			spanId: $.SpanId,
			session: sessionKey(CH.ifNull($.trace.rawSessionId, CH.lit("")), $.TraceId),
			errorType: spanField($, "errorType"),
			// A status message and nothing else is what most failures carry, so the
			// message is the identity of the group as often as the type is.
			message: leftUTF8($.StatusMessage, CH.lit(AI_TOOL_ERROR_MESSAGE_MAX)),
			agent: spanField($, "agentName"),
			model: CH.ifNull($.trace.traceModel, CH.lit("")),
			svc: $.ServiceName,
			durationNs: $.Duration,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			inSubquery($.TraceId, failingToolTraceIds(opts)),
			spanField($, "toolName").eq(param.string("toolName")),
			spanFailed($),
			// The service is a column on the span, so it is applied here as well
			// as in the prefilter — without it a trace that failed this tool in a
			// second service would contribute that service's spans too. `env` has
			// no span column and stays prefilter-only: it narrows by trace.
			CH.when(opts.service, (service) => $.ServiceName.eq(service)),
		])

/**
 * The Errors table: every error type this tool failed with, worst first.
 *
 * The message is the most RECENT one under the type, not an arbitrary one —
 * a type whose message carries a changing detail (a path, a worker count)
 * should read as the failure that is happening now.
 */
export interface AiToolErrorsOutput {
	readonly errorType: string
	readonly message: string
	readonly calls: number
	readonly sessions: number
	readonly firstSeen: string
	readonly lastSeen: string
}

/** Counts are `CHNumber`: a gateway that refuses
 *  `output_format_json_quote_64bit_integers=0` sends them quoted. */
export const aiToolErrorsRowSchema: CompiledQueryRowSchema<AiToolErrorsOutput> = Schema.Struct({
	errorType: Schema.String,
	message: Schema.String,
	calls: CHNumber,
	sessions: CHNumber,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
})

export function aiToolErrorsQuery(opts: AiToolErrorsOpts = {}) {
	return fromQuery(toolErrorSpans(opts), "tool_error_spans")
		.select(($) => ({
			errorType: $.errorType,
			message: CH.argMax($.message, $.ts),
			calls: CH.count(),
			sessions: CH.uniqExact($.session),
			firstSeen: CH.toString_(CH.min_($.ts)),
			lastSeen: CH.toString_(CH.max_($.ts)),
		}))
		.groupBy("errorType")
		.orderBy(["calls", "desc"], ["errorType", "asc"])
		.limit(opts.limit ?? AI_TOOL_ERRORS_LIMIT)
		.format("JSON")
}

/** The modal's left pane: which sessions hit this error type, and how often. */
export interface AiToolErrorSessionsOutput {
	readonly sessionId: string
	readonly agentName: string
	readonly model: string
	readonly hits: number
	readonly lastSeen: string
}

export const aiToolErrorSessionsRowSchema: CompiledQueryRowSchema<AiToolErrorSessionsOutput> =
	Schema.Struct({
		sessionId: Schema.String,
		agentName: Schema.String,
		model: Schema.String,
		hits: CHNumber,
		lastSeen: Schema.String,
	})

export function aiToolErrorSessionsQuery(opts: AiToolErrorsOpts = {}) {
	return fromQuery(toolErrorSpans(opts), "tool_error_spans")
		.select(($) => ({
			sessionId: $.session,
			agentName: CH.anyIf($.agent, $.agent.neq("")),
			model: CH.anyIf($.model, $.model.neq("")),
			hits: CH.count(),
			lastSeen: CH.toString_(CH.max_($.ts)),
		}))
		.where(($) => [errorTypeFilter(opts, $.errorType)])
		.groupBy("sessionId")
		.orderBy(["hits", "desc"], ["sessionId", "asc"])
		.limit(opts.limit ?? AI_TOOL_OCCURRENCES_LIMIT)
		.format("JSON")
}

/**
 * The modal's right pane: the individual failed calls, newest first, each with
 * what it was called with and what came back.
 *
 * Its own read of `trace_detail_spans` rather than a projection of
 * {@link toolErrorSpans}, because the two payload columns are the expensive
 * half of the row and no aggregate above wants them.
 */
export interface AiToolErrorOccurrencesOutput {
	readonly timestamp: string
	readonly traceId: string
	readonly spanId: string
	readonly sessionId: string
	readonly agentName: string
	readonly model: string
	readonly errorType: string
	readonly message: string
	readonly durationNs: number
	readonly statusCode: string
	/** Truncated to {@link AI_TOOL_ERROR_PAYLOAD_MAX}; `*Bytes` is the true size. */
	readonly arguments: string
	readonly argumentsBytes: number
	readonly result: string
	readonly resultBytes: number
}

export const aiToolErrorOccurrencesRowSchema: CompiledQueryRowSchema<AiToolErrorOccurrencesOutput> =
	Schema.Struct({
		timestamp: Schema.String,
		traceId: Schema.String,
		spanId: Schema.String,
		sessionId: Schema.String,
		agentName: Schema.String,
		model: Schema.String,
		errorType: Schema.String,
		message: Schema.String,
		durationNs: CHNumber,
		statusCode: Schema.String,
		arguments: Schema.String,
		argumentsBytes: CHNumber,
		result: Schema.String,
		resultBytes: CHNumber,
	})

export function aiToolErrorOccurrencesQuery(opts: AiToolErrorsOpts = {}) {
	return from(TraceDetailSpans)
		.leftJoinQuery(traceFacts("current"), "trace", (span, trace) => span.TraceId.eq(trace.TraceId))
		.select(($) => {
			const args = spanField($, "toolCallArguments")
			const result = spanField($, "toolCallResult")
			return {
				timestamp: CH.toString_($.Timestamp),
				traceId: $.TraceId,
				spanId: $.SpanId,
				sessionId: sessionKey(CH.ifNull($.trace.rawSessionId, CH.lit("")), $.TraceId),
				agentName: spanField($, "agentName"),
				model: CH.ifNull($.trace.traceModel, CH.lit("")),
				errorType: spanField($, "errorType"),
				message: leftUTF8($.StatusMessage, CH.lit(AI_TOOL_ERROR_MESSAGE_MAX)),
				durationNs: $.Duration,
				statusCode: $.StatusCode,
				// Characters, not bytes: `left` cuts mid-codepoint on any payload
				// holding one. `length` stays byte-based — it reports a size.
				arguments: leftUTF8(args, CH.lit(AI_TOOL_ERROR_PAYLOAD_MAX)),
				argumentsBytes: CH.length_(args),
				result: leftUTF8(result, CH.lit(AI_TOOL_ERROR_PAYLOAD_MAX)),
				resultBytes: CH.length_(result),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			inSubquery($.TraceId, failingToolTraceIds(opts)),
			spanField($, "toolName").eq(param.string("toolName")),
			spanFailed($),
			// See `toolErrorSpans`: the service is a span column, `env` is not.
			CH.when(opts.service, (service) => $.ServiceName.eq(service)),
			errorTypeFilter(opts, spanField($, "errorType")),
			// The left pane's selection: one session's occurrences of this error.
			CH.when(opts.session, (session) =>
				sessionKey(CH.ifNull($.trace.rawSessionId, CH.lit("")), $.TraceId).eq(session),
			),
		])
		// Newest first: a modal opened from a failing tool is asking what is
		// happening now, and `spanId` breaks the ties agent spans routinely have.
		.orderBy(["timestamp", "desc"], ["spanId", "asc"])
		.limit(opts.limit ?? AI_TOOL_OCCURRENCES_LIMIT)
		.format("JSON")
}
