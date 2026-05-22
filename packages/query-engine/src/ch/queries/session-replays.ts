// ---------------------------------------------------------------------------
// Typed Session Replay Queries
//
// DSL-based queries over the session_replays (metadata) and
// session_replay_events (rrweb event payloads) datasources.
//
// `session_replays` is a ReplacingMergeTree(Version): the @maple/browser SDK
// writes a partial row at session start (Version=1) and a complete row at
// session end (Version=2). Reads can see both rows before a background merge
// collapses them, so every query that surfaces a session GROUPs BY SessionId
// and finalizes each field with argMax(field, Version) — this picks the latest
// version and is correct even with un-merged duplicates.
//
// Filters in WHERE only use version-invariant fields (browser/country/device/
// service/url/startTime, which are identical across both rows) plus the
// monotonic ErrorCount via `hasErrors` (true-only — see listSessionReplays).
// Stale-prone post-aggregation predicates (e.g. exact Status) are deliberately
// not exposed as SQL filters since the DSL has no HAVING clause.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { compileFnCall, compileFnCallCond } from "../define-fn"
import { param } from "../param"
import { from, type ColumnAccessor } from "../query"
import { unionAll, type CHUnionQuery } from "../union"
import { SessionReplays, SessionReplayEvents, TraceDetailSpans } from "../tables"

// argMax(value, ordering) — finalize a ReplacingMergeTree column to its latest
// version. Generic per call site, so declared here rather than via defineFn.
function argMax<T>(value: CH.Expr<T>, ordering: CH.Expr<unknown>): CH.Expr<T> {
	return compileFnCall<T>("argMax", value, ordering)
}

// has(array, element) — array membership as a WHERE condition (CH returns
// UInt8; non-zero is truthy).
function has<T>(array: CH.Expr<ReadonlyArray<T>>, element: CH.Expr<T>): CH.Condition {
	return compileFnCallCond("has", array, element)
}

// length(array) — element count.
function arrayLength<T>(array: CH.Expr<ReadonlyArray<T>>): CH.Expr<number> {
	return compileFnCall<number>("length", array)
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export interface SessionReplaysListOpts {
	serviceName?: string
	browser?: string
	country?: string
	deviceType?: string
	/** When true, only sessions with at least one recorded error. */
	hasErrors?: boolean
	/** Substring match on the initial page URL. */
	search?: string
	/** Keyset cursor: only sessions with StartTime strictly before this. */
	cursor?: string
	limit?: number
	offset?: number
}

export interface SessionReplaysListOutput {
	readonly sessionId: string
	readonly startTime: string
	readonly endTime: string | null
	readonly durationMs: number | null
	readonly status: string
	readonly userId: string
	readonly urlInitial: string
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly country: string
	readonly serviceName: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
	readonly traceCount: number
}

export function sessionReplaysListQuery(opts: SessionReplaysListOpts) {
	const limit = opts.limit ?? 50

	return from(SessionReplays)
		.select(($) => ({
			sessionId: $.SessionId,
			startTime: argMax($.StartTime, $.Version),
			endTime: argMax($.EndTime, $.Version),
			durationMs: argMax($.DurationMs, $.Version),
			status: argMax($.Status, $.Version),
			userId: argMax($.UserId, $.Version),
			urlInitial: argMax($.UrlInitial, $.Version),
			browserName: argMax($.BrowserName, $.Version),
			osName: argMax($.OsName, $.Version),
			deviceType: argMax($.DeviceType, $.Version),
			country: argMax($.Country, $.Version),
			serviceName: argMax($.ServiceName, $.Version),
			pageViews: argMax($.PageViews, $.Version),
			clickCount: argMax($.ClickCount, $.Version),
			errorCount: argMax($.ErrorCount, $.Version),
			traceCount: arrayLength(argMax($.TraceIds, $.Version)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.browser, (v: string) => $.BrowserName.eq(v)),
			CH.when(opts.country, (v: string) => $.Country.eq(v)),
			CH.when(opts.deviceType, (v: string) => $.DeviceType.eq(v)),
			CH.whenTrue(opts.hasErrors, () => $.ErrorCount.gt(0)),
			CH.when(opts.search, (v: string) => $.UrlInitial.ilike(`%${v}%`)),
			CH.when(opts.cursor, (v: string) => $.StartTime.lt(v)),
		])
		.groupBy("sessionId")
		.orderBy(["startTime", "desc"])
		.limit(limit)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Single session detail
//
// (OrgId, SessionId) is the full sort-key prefix, so this is an O(log N)
// lookup. Dedup the ReplacingMergeTree versions by taking the highest Version.
// ---------------------------------------------------------------------------

export interface SessionReplayDetailOutput {
	readonly sessionId: string
	readonly startTime: string
	readonly endTime: string | null
	readonly durationMs: number | null
	readonly status: string
	readonly userId: string
	readonly urlInitial: string
	readonly userAgent: string
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly country: string
	readonly serviceName: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
	readonly traceIds: ReadonlyArray<string>
	readonly resourceAttributes: string
	readonly version: number
}

export function getSessionReplayQuery() {
	return from(SessionReplays)
		.select(($) => ({
			version: $.Version,
			sessionId: $.SessionId,
			startTime: $.StartTime,
			endTime: $.EndTime,
			durationMs: $.DurationMs,
			status: $.Status,
			userId: $.UserId,
			urlInitial: $.UrlInitial,
			userAgent: $.UserAgent,
			browserName: $.BrowserName,
			osName: $.OsName,
			deviceType: $.DeviceType,
			country: $.Country,
			serviceName: $.ServiceName,
			pageViews: $.PageViews,
			clickCount: $.ClickCount,
			errorCount: $.ErrorCount,
			traceIds: $.TraceIds,
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), $.SessionId.eq(param.string("sessionId"))])
		.orderBy(["version", "desc"])
		.limit(1)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Chunk index for one session (ordered for playback)
//
// session_replay_chunks is a plain MergeTree — each chunk is written exactly
// once, so no dedup is needed. Sorted by (Timestamp, ChunkSeq) so the player
// receives blobs in replay order.
// ---------------------------------------------------------------------------

export interface SessionReplayEventsOutput {
	readonly chunkSeq: number
	readonly timestamp: string
	readonly durationMs: number
	readonly eventCount: number
	readonly byteSize: number
	/** The rrweb event array for this chunk, serialized as a JSON string. */
	readonly events: string
	readonly isCheckpoint: number
}

export function sessionReplayEventsQuery() {
	return from(SessionReplayEvents)
		.select(($) => ({
			chunkSeq: $.ChunkSeq,
			timestamp: $.Timestamp,
			durationMs: $.DurationMs,
			eventCount: $.EventCount,
			byteSize: $.ByteSize,
			events: $.Events,
			isCheckpoint: $.IsCheckpoint,
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), $.SessionId.eq(param.string("sessionId"))])
		.orderBy(["chunkSeq", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Reverse correlation: sessions that observed a given trace id
// ---------------------------------------------------------------------------

export interface SessionsForTraceOpts {
	traceId: string
	limit?: number
}

export interface SessionsForTraceOutput {
	readonly sessionId: string
	readonly startTime: string
	readonly durationMs: number | null
}

export function sessionsForTraceQuery(opts: SessionsForTraceOpts) {
	return from(SessionReplays)
		.select(($) => ({
			sessionId: $.SessionId,
			startTime: argMax($.StartTime, $.Version),
			durationMs: argMax($.DurationMs, $.Version),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			has($.TraceIds, CH.lit(opts.traceId)),
		])
		.groupBy("sessionId")
		.orderBy(["startTime", "desc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Facets for the filter sidebar (browser / country / device)
//
// Counts DISTINCT sessions (uniq(SessionId)) rather than rows, so the
// duplicate Version rows of a ReplacingMergeTree don't double-count.
// ---------------------------------------------------------------------------

export interface SessionReplayFacetsOutput {
	readonly name: string
	readonly facetType: string
	readonly count: number
}

export function sessionReplayFacetsQuery(
	opts: SessionReplaysListOpts,
): CHUnionQuery<SessionReplayFacetsOutput> {
	const baseWhere = (
		$: ColumnAccessor<typeof SessionReplays.columns>,
	): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.StartTime.gte(param.dateTime("startTime")),
		$.StartTime.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.whenTrue(opts.hasErrors, () => $.ErrorCount.gt(0)),
	]

	const browserQuery = from(SessionReplays)
		.select(($) => ({
			name: $.BrowserName,
			facetType: CH.lit("browser"),
			count: CH.uniq($.SessionId),
		}))
		.where(($) => [...baseWhere($), $.BrowserName.neq("")])
		.groupBy("name")

	const countryQuery = from(SessionReplays)
		.select(($) => ({
			name: $.Country,
			facetType: CH.lit("country"),
			count: CH.uniq($.SessionId),
		}))
		.where(($) => [...baseWhere($), $.Country.neq("")])
		.groupBy("name")

	const deviceQuery = from(SessionReplays)
		.select(($) => ({
			name: $.DeviceType,
			facetType: CH.lit("device"),
			count: CH.uniq($.SessionId),
		}))
		.where(($) => [...baseWhere($), $.DeviceType.neq("")])
		.groupBy("name")

	return unionAll(browserQuery, countryQuery, deviceQuery)
		.orderBy(["count", "desc"])
		.limit(300)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Per-trace summaries for a session's correlated traces
//
// One row per TraceId, used to draw a single bar per trace on the session
// replay timeline (the expandable span lanes fetch full spans on demand via
// spanHierarchyQuery). Reads `trace_detail_spans`, whose sort key
// (OrgId, TraceId, SpanId) makes `TraceId IN (...)` a cheap prefix lookup —
// no time-window scan needed. The root span (ParentSpanId = '') supplies the
// trace's name/service/duration, with a fallback for traces whose root span
// wasn't ingested.
// ---------------------------------------------------------------------------

export interface SessionTraceSummariesOpts {
	/** The correlated trace ids to summarize (from session_replays.TraceIds). */
	traceIds: ReadonlyArray<string>
	limit?: number
}

export interface SessionTraceSummaryOutput {
	readonly traceId: string
	readonly startTime: string
	readonly durationMs: number
	readonly rootSpanName: string
	readonly rootServiceName: string
	readonly spanCount: number
	readonly hasError: number
}

export function sessionTraceSummariesQuery(opts: SessionTraceSummariesOpts) {
	const limit = opts.limit ?? 200

	return from(TraceDetailSpans)
		.select(($) => {
			const isRoot = $.ParentSpanId.eq("")
			// Root span duration is the canonical "trace duration" elsewhere in the
			// codebase; fall back to the widest span when no root span is present.
			const entryDurationMs = CH.maxIf($.Duration, isRoot).div(1000000)
			const fallbackDurationMs = CH.max_($.Duration).div(1000000)
			return {
				traceId: $.TraceId,
				startTime: CH.min_($.Timestamp),
				durationMs: CH.if_(entryDurationMs.gt(0), entryDurationMs, fallbackDurationMs),
				rootSpanName: CH.coalesce(
					CH.nullIf(CH.anyIf($.SpanName, isRoot), ""),
					CH.any_($.SpanName),
				),
				rootServiceName: CH.coalesce(
					CH.nullIf(CH.anyIf($.ServiceName, isRoot), ""),
					CH.any_($.ServiceName),
				),
				spanCount: CH.count(),
				hasError: CH.if_(CH.countIf($.StatusCode.eq("Error")).gt(0), CH.lit(1), CH.lit(0)),
			}
		})
		.where(($) => [$.OrgId.eq(param.string("orgId")), $.TraceId.in_(...opts.traceIds)])
		.groupBy("traceId")
		.orderBy(["startTime", "asc"])
		.limit(limit)
		.format("JSON")
}
