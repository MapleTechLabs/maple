// ---------------------------------------------------------------------------
// Typed Session Replay Queries
//
// DSL-based queries over the session_replays (metadata) and
// session_replay_events (rrweb event payloads) datasources.
//
// `session_replays` is a ReplacingMergeTree(Version): the @maple-dev/browser SDK
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

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compileFnCall, compileFnCallCond } from "@maple-dev/clickhouse-builder"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type ColumnAccessor, type CHQuery } from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { SessionReplays, SessionReplayEvents, TraceDetailSpans } from "../tables"
import { sessionActivityAggregateQuery } from "./session-events"

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
	/** Exact match on the session's end-user id. */
	userId?: string
	/** When true, only sessions with at least one recorded error. */
	hasErrors?: boolean
	/** Substring match on the initial page URL. */
	search?: string
	/** Keyset cursor: only sessions with StartTime strictly before this. */
	cursor?: string
	/** Min/max wall-clock duration (ms). Filters on the stored DurationMs; only
	 *  completed (Version=2) sessions carry it, so in-progress sessions are
	 *  excluded when either bound is set. */
	durationMinMs?: number
	durationMaxMs?: number
	/** Min/max active time (ms), computed from session_events gaps. Setting either
	 *  bound LEFT JOINs the per-session activity aggregate (the only path that
	 *  scans session_events — the default list never does). */
	activeTimeMinMs?: number
	activeTimeMaxMs?: number
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

// Return type is annotated (not inferred) because the duration/active filters
// branch into structurally-different sources (the base table vs a wrapping
// subquery, optionally joined) — all three produce the same row shape, but TS
// otherwise infers a union that won't unify at the compileCH call site. Mirrors
// metricsTimeseriesRateQuery's annotation.
export function sessionReplaysListQuery(
	opts: SessionReplaysListOpts,
): CHQuery<any, SessionReplaysListOutput, {}> {
	const limit = opts.limit ?? 50
	const needsDurationFilter = opts.durationMinMs != null || opts.durationMaxMs != null
	const needsActiveFilter = opts.activeTimeMinMs != null || opts.activeTimeMaxMs != null

	const base = from(SessionReplays)
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
			// Exact userId match is row-level (pre-GROUP BY). The completed Version=2
			// row carries the identified UserId, so GROUP BY SessionId still surfaces
			// each matching session once — same row-level-filter reasoning as
			// hasErrors/ErrorCount above (see this file's header).
			CH.when(opts.userId, (v: string) => $.UserId.eq(v)),
			CH.whenTrue(opts.hasErrors, () => $.ErrorCount.gt(0)),
			CH.when(opts.search, (v: string) => $.UrlInitial.ilike(`%${v}%`)),
			CH.when(opts.cursor, (v: string) => $.StartTime.lt(v)),
		])
		.groupBy("sessionId")

	// Fast path: no post-aggregate filters → the original grouped query, untouched
	// (never reads session_events).
	if (!needsDurationFilter && !needsActiveFilter) {
		return base.orderBy(["startTime", "desc"]).limit(limit).offset(opts.offset ?? 0).format("JSON")
	}

	// Duration and active-time bounds are post-aggregate predicates (argMax /
	// joined column), which the DSL can't put in WHERE/HAVING directly — wrap the
	// grouped query in a subquery and filter there. The active-time filter LEFT
	// JOINs the per-session session_events activity aggregate; the duration-only
	// path skips the join (and the session_events scan) entirely.
	if (needsActiveFilter) {
		return fromQuery(base, "s")
			.leftJoinQuery(sessionActivityAggregateQuery(), "a", (s, a) => s.sessionId.eq(a.sessionId))
			.select(($) => ({
				sessionId: $.sessionId,
				startTime: $.startTime,
				endTime: $.endTime,
				durationMs: $.durationMs,
				status: $.status,
				userId: $.userId,
				urlInitial: $.urlInitial,
				browserName: $.browserName,
				osName: $.osName,
				deviceType: $.deviceType,
				country: $.country,
				serviceName: $.serviceName,
				pageViews: $.pageViews,
				clickCount: $.clickCount,
				errorCount: $.errorCount,
				traceCount: $.traceCount,
			}))
			.where(($) => [
				CH.when(opts.durationMinMs, (v: number) => $.durationMs.gte(v)),
				CH.when(opts.durationMaxMs, (v: number) => $.durationMs.lte(v)),
				CH.when(opts.activeTimeMinMs, (v: number) => $.a.activeTimeMs.gte(v)),
				CH.when(opts.activeTimeMaxMs, (v: number) => $.a.activeTimeMs.lte(v)),
			])
			.orderBy(["startTime", "desc"])
			.limit(limit)
			.offset(opts.offset ?? 0)
			.format("JSON")
	}

	return fromQuery(base, "s")
		.select(($) => ({
			sessionId: $.sessionId,
			startTime: $.startTime,
			endTime: $.endTime,
			durationMs: $.durationMs,
			status: $.status,
			userId: $.userId,
			urlInitial: $.urlInitial,
			browserName: $.browserName,
			osName: $.osName,
			deviceType: $.deviceType,
			country: $.country,
			serviceName: $.serviceName,
			pageViews: $.pageViews,
			clickCount: $.clickCount,
			errorCount: $.errorCount,
			traceCount: $.traceCount,
		}))
		.where(($) => [
			CH.when(opts.durationMinMs, (v: number) => $.durationMs.gte(v)),
			CH.when(opts.durationMaxMs, (v: number) => $.durationMs.lte(v)),
		])
		.orderBy(["startTime", "desc"])
		.limit(limit)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// List facets (UNION ALL — browser / device / country / service + error count)
//
// Populates the replays filter sidebar. Counts use uniq(SessionId) so the two
// ReplacingMergeTree rows per session (Version 1 + 2) don't double-count. Each
// dimension's own equality filter is excluded from its branch so the currently
// selected value doesn't collapse the facet to a single option.
// ---------------------------------------------------------------------------

export interface SessionReplaysFacetsOpts {
	serviceName?: string
	browser?: string
	country?: string
	deviceType?: string
	/** Exact match on the session's end-user id (narrows every facet branch). */
	userId?: string
	hasErrors?: boolean
	search?: string
}

export interface SessionReplaysFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

type SessionFacetKey = "service" | "browser" | "country" | "device"

export function sessionReplaysFacetsQuery(
	opts: SessionReplaysFacetsOpts,
): CHUnionQuery<SessionReplaysFacetsOutput> {
	const baseWhere = (
		$: ColumnAccessor<typeof SessionReplays.columns>,
		exclude?: SessionFacetKey,
	): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.StartTime.gte(param.dateTime("startTime")),
		$.StartTime.lte(param.dateTime("endTime")),
		exclude === "service" ? undefined : CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		exclude === "browser" ? undefined : CH.when(opts.browser, (v: string) => $.BrowserName.eq(v)),
		exclude === "country" ? undefined : CH.when(opts.country, (v: string) => $.Country.eq(v)),
		exclude === "device" ? undefined : CH.when(opts.deviceType, (v: string) => $.DeviceType.eq(v)),
		// UserId has no facet branch (high cardinality), so it's never excluded — it
		// narrows every dimension's counts to the selected user.
		CH.when(opts.userId, (v: string) => $.UserId.eq(v)),
		CH.whenTrue(opts.hasErrors, () => $.ErrorCount.gt(0)),
		CH.when(opts.search, (v: string) => $.UrlInitial.ilike(`%${v}%`)),
	]

	const makeFacet = (
		facetType: SessionFacetKey,
		column: ($: ColumnAccessor<typeof SessionReplays.columns>) => CH.Expr<string>,
		limit = 50,
	) =>
		from(SessionReplays)
			.select(($) => ({
				name: column($),
				count: CH.uniq($.SessionId),
				facetType: CH.lit(facetType),
			}))
			.where(($) => [...baseWhere($, facetType), column($).neq("")])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)

	return unionAll(
		makeFacet("service", ($) => $.ServiceName),
		makeFacet("browser", ($) => $.BrowserName),
		makeFacet("country", ($) => $.Country),
		makeFacet("device", ($) => $.DeviceType),
		// Distinct sessions with at least one recorded error (drives the "Has
		// errors" toggle count). Its own hasErrors filter is omitted here.
		from(SessionReplays)
			.select(($) => ({
				name: CH.lit("error"),
				count: CH.uniq($.SessionId),
				facetType: CH.lit("error"),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.StartTime.gte(param.dateTime("startTime")),
				$.StartTime.lte(param.dateTime("endTime")),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.browser, (v: string) => $.BrowserName.eq(v)),
				CH.when(opts.country, (v: string) => $.Country.eq(v)),
				CH.when(opts.deviceType, (v: string) => $.DeviceType.eq(v)),
				CH.when(opts.userId, (v: string) => $.UserId.eq(v)),
				CH.when(opts.search, (v: string) => $.UrlInitial.ilike(`%${v}%`)),
				$.ErrorCount.gt(0),
			]),
	).format("JSON")
}

// ---------------------------------------------------------------------------
// Single session detail
//
// (OrgId, SessionId) is the full sort-key prefix, so this is an O(log N)
// lookup. Dedup the ReplacingMergeTree versions by taking the highest Version.
//
// session_replays is PARTITION BY toDate(StartTime); the optional startTime/
// endTime bounds (version-invariant column, identical across v1/v2) prune the
// daily partitions a deep-scan would otherwise touch. Omit to scan all.
// ---------------------------------------------------------------------------

export interface SessionReplayDetailOpts {
	startTime?: string
	endTime?: string
}

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

export function getSessionReplayQuery(opts: SessionReplayDetailOpts = {}) {
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
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SessionId.eq(param.string("sessionId")),
			CH.when(opts.startTime, (v: string) => $.StartTime.gte(v)),
			CH.when(opts.endTime, (v: string) => $.StartTime.lte(v)),
		])
		.orderBy(["version", "desc"])
		.limit(1)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Chunk index for one session (ordered for playback)
//
// session_replay_events is a plain MergeTree — each chunk is written exactly
// once, so no dedup is needed. Sorted by (OrgId, SessionId, ChunkSeq) so the
// player receives chunks in replay order.
//
// The table is PARTITION BY toDate(Timestamp) with a 30-day TTL. (OrgId,
// SessionId) is a perfect sort-key prefix, but without a Timestamp predicate
// ClickHouse must read the primary index of every daily partition to find this
// session's chunks. The optional startTime/endTime bounds (the caller passes
// the session's time window) prune to the 1-2 partitions the session spans.
// ---------------------------------------------------------------------------

export interface SessionReplayEventsOpts {
	/** Optional session time window — prunes daily partitions. Omit to scan all. */
	startTime?: string
	endTime?: string
}

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

export function sessionReplayEventsQuery(opts: SessionReplayEventsOpts = {}) {
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
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SessionId.eq(param.string("sessionId")),
			CH.when(opts.startTime, (v: string) => $.Timestamp.gte(v)),
			CH.when(opts.endTime, (v: string) => $.Timestamp.lte(v)),
		])
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
// Per-trace summaries for a session's correlated traces
//
// One row per TraceId, used to draw a single bar per trace on the session
// replay timeline (the expandable span lanes fetch full spans on demand via
// spanHierarchyQuery). Reads `trace_detail_spans`, whose sort key
// (OrgId, TraceId, SpanId) makes `TraceId IN (...)` a cheap prefix lookup
// WITHIN a part. But the table is PARTITION BY toDate(Timestamp) with a 30-day
// TTL, so without a Timestamp predicate ClickHouse reads the primary index of
// every daily partition to find these traces — pure scan fan-out (observed at
// 7s+ for a handful of matching spans on a high-volume org). The optional
// startTime/endTime bounds (the session's time window — its correlated traces
// fired within it) prune to the 1-2 partitions the session spans. The root
// span (ParentSpanId = '') supplies the trace's name/service/duration, with a
// fallback for traces whose root span wasn't ingested.
// ---------------------------------------------------------------------------

export interface SessionTraceSummariesOpts {
	/** The correlated trace ids to summarize (from session_replays.TraceIds). */
	traceIds: ReadonlyArray<string>
	/** Optional session time window — prunes daily partitions. Omit to scan all. */
	startTime?: string
	endTime?: string
	limit?: number
}

export interface SessionTraceSummaryOutput {
	readonly traceId: string
	readonly startTime: string
	readonly durationMs: number
	readonly rootSpanName: string
	readonly rootServiceName: string
	/** Root span's OTel kind (e.g. SPAN_KIND_CLIENT), so the UI can format the HTTP label. */
	readonly rootSpanKind: string
	/** Root span's attribute map, JSON-encoded — parsed by the UI for `getHttpInfo`. */
	readonly rootSpanAttributes: string
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
				rootSpanName: CH.coalesce(CH.nullIf(CH.anyIf($.SpanName, isRoot), ""), CH.any_($.SpanName)),
				rootServiceName: CH.coalesce(
					CH.nullIf(CH.anyIf($.ServiceName, isRoot), ""),
					CH.any_($.ServiceName),
				),
				// Root span's kind + attributes let the UI render the canonical HTTP
				// label (`POST /api/foo`) instead of the raw span name. Traces with no
				// ingested root span yield empty strings — the UI's getHttpInfo then
				// falls back to name-only parsing.
				rootSpanKind: CH.anyIf($.SpanKind, isRoot),
				rootSpanAttributes: CH.anyIf(CH.toJSONString($.SpanAttributes), isRoot),
				spanCount: CH.count(),
				hasError: CH.if_(CH.countIf($.StatusCode.eq("Error")).gt(0), CH.lit(1), CH.lit(0)),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TraceId.in_(...opts.traceIds),
			CH.when(opts.startTime, (v: string) => $.Timestamp.gte(v)),
			CH.when(opts.endTime, (v: string) => $.Timestamp.lte(v)),
		])
		.groupBy("traceId")
		.orderBy(["startTime", "asc"])
		.limit(limit)
		.format("JSON")
}
