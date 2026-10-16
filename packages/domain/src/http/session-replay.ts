import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionId, TraceId, UserId } from "../primitives"
import { SessionTag, TinybirdDateTime } from "../query-engine"
import { AuditedRead } from "./audit-log"
import { SessionAuthorization } from "./current-tenant"
import { QueryEngineExecutionError, QueryEngineTimeoutError } from "./query-engine"
import { warehouseHttpErrors } from "./warehouse"

// Session replay schemas shared by the v2 contract and the internal replay group.

export const SessionReplayListItem = Schema.Struct({
	sessionId: SessionId,
	startTime: Schema.String,
	endTime: Schema.NullOr(Schema.String),
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	/** Heartbeat-refreshed. Read it with `status`: a session whose tab died without
	 *  sending its unload row stays `"active"` for the rest of its retention, so
	 *  `status` alone cannot say whether a session is happening now. */
	lastActivityAt: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(UserId),
	// identify() identity. `""` when the session was never identified (including
	// every session recorded before the SDK had identify()) — the list falls back
	// to its session-id/host line, so an empty value is a display state, not a gap.
	userName: Schema.String,
	userEmail: Schema.String,
	groupId: Schema.String,
	groupName: Schema.String,
	/** Persistent per-browser id — equal across a visitor's marketing and app sessions. */
	visitorId: Schema.String,
	/** Acquisition source captured at session start; `""` when there was none. */
	utmSource: Schema.String,
	/** Entry pathname (no query/hash). Note `urlInitial` is the *latest* URL. */
	entryPath: Schema.String,
	urlInitial: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	country: Schema.String,
	serviceName: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	traceCount: Schema.Number,
	/** The SDK's `maple.session.recorded` marker. `"true"` / `"false"`, or `""`
	 *  for sessions written before the SDK stamped it — treat that as unknown,
	 *  not as "not recorded". */
	recorded: Schema.String,
})

export class ReplaysFacetsRequest extends Schema.Class<ReplaysFacetsRequest>("ReplaysFacetsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// Same optional-filter contract as ListReplaysRequest — see the note there.
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	userSearch: Schema.optional(Schema.String),
	groupName: Schema.optional(Schema.String),
	/** Scopes every facet and both header counts to one browser, like the list. */
	visitorId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
	pagePath: Schema.optional(Schema.String),
	/** Required tags; the tag facet itself ignores them so every tag keeps its count. */
	tags: Schema.optional(Schema.Array(SessionTag)),
}) {}

export const ReplayFacetItem = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class ReplaysFacetsResponse extends Schema.Class<ReplaysFacetsResponse>("ReplaysFacetsResponse")({
	services: Schema.Array(ReplayFacetItem),
	browsers: Schema.Array(ReplayFacetItem),
	countries: Schema.Array(ReplayFacetItem),
	devices: Schema.Array(ReplayFacetItem),
	/** Identified groups (company / team), by session count. Empty for orgs that
	 *  never call `identify()` with a group — the sidebar hides the section then. */
	groups: Schema.Array(ReplayFacetItem),
	/** Page paths visited, by sessions that reached them (top 200). */
	pages: Schema.Array(ReplayFacetItem),
	/** Sessions per rule-based tag (see `SESSION_TAGS`); tags with no sessions are absent. */
	tags: Schema.Array(ReplayFacetItem),
	/** Distinct sessions with at least one recorded error, within the current filter. */
	errorCount: Schema.Number,
	/** Every session in the window under the current filters — the header's own
	 *  count, so it stops describing however many rows the client has scrolled
	 *  into memory while the chips beside it describe the whole window. */
	totalSessions: Schema.Number,
	/** Sessions with activity inside the live window, on the same definition the
	 *  analytics live badge uses. Slightly over-counts sessions that ended within
	 *  that window; see the query. */
	liveSessions: Schema.Number,
	/** Session-length distribution: `name` is the bucket floor in ms, `count` the
	 *  sessions in it. Buckets are half-octaves from 1s, so each ceiling is
	 *  floor × √2. Unordered — the client sorts numerically. */
	durationBuckets: Schema.Array(ReplayFacetItem),
	/** Session-length percentiles (ms) over the same population as the buckets;
	 *  0 when no completed session falls in the window. */
	durationP50: Schema.Number,
	durationP95: Schema.Number,
}) {}

export class SessionTraceSummariesRequest extends Schema.Class<SessionTraceSummariesRequest>(
	"SessionTraceSummariesRequest",
)({
	/** The session's correlated trace ids (from the detail response's `traceIds`). */
	traceIds: Schema.Array(TraceId),
	// Optional partition-pruning window: the session's time span, which its
	// correlated traces fired within.
	windowStart: Schema.optional(TinybirdDateTime),
	windowEnd: Schema.optional(TinybirdDateTime),
}) {}

export const SessionTraceSummary = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.String,
	durationMs: Schema.Number,
	rootSpanName: Schema.String,
	rootServiceName: Schema.String,
	/** Root span's OTel kind — lets the UI format the canonical HTTP label. */
	rootSpanKind: Schema.optionalKey(Schema.String),
	/** Root span's attribute map, JSON-encoded — parsed by the UI for `getHttpInfo`. */
	rootSpanAttributes: Schema.optionalKey(Schema.String),
	spanCount: Schema.Number,
	hasError: Schema.Number,
})

export class SessionTraceSummariesResponse extends Schema.Class<SessionTraceSummariesResponse>(
	"SessionTraceSummariesResponse",
)({
	data: Schema.Array(SessionTraceSummary),
}) {}

// API group

const sessionReplayEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	...warehouseHttpErrors,
] as const

/**
 * Session-replay helpers that exist for the dashboard and are not public API.
 *
 * Facet exploration and per-session trace summaries are shapes the replay UI
 * drives — a filter sidebar's bucket counts and a timeline's span rollups — so
 * they are not lifted to `/v2`. They live in the internal tier instead, where
 * their shape can follow the UI.
 */
export class SessionReplaysInternalApiGroup extends HttpApiGroup.make("sessionReplaysInternal")
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: ReplaysFacetsRequest,
			success: ReplaysFacetsResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("traceSummaries", "/trace-summaries", {
			payload: SessionTraceSummariesRequest,
			success: SessionTraceSummariesResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.prefix("/internal/session-replays")
	.middleware(SessionAuthorization)
	.annotate(AuditedRead, "session_replay.read") {}
