import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionId, TraceId } from "../primitives"
import { TinybirdDateTime } from "../query-engine"
import { Authorization } from "./current-tenant"
import { QueryEngineExecutionError, QueryEngineTimeoutError } from "./query-engine"
import { TinybirdQueryError, TinybirdQuotaExceededError } from "./tinybird"

// ---------------------------------------------------------------------------
// Session replay endpoint schemas
//
// Backed by the session_replays (metadata) + session_replay_events (rrweb event
// payloads) datasources, both in ClickHouse. `getReplayEvents` returns the rrweb
// event arrays inline (read straight from the warehouse — no R2, no signed URLs).
// ---------------------------------------------------------------------------

// --- List ---

export class ListReplaysRequest extends Schema.Class<ListReplaysRequest>("ListReplaysRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// Optional filters are constructed JS-side by the web/MCP clients, which pass
	// `undefined` for any unset filter. `Schema.optional` accepts an explicit
	// `undefined` (key present, value undefined); `Schema.optionalKey` would
	// reject it and throw "Expected string, got undefined" at construction time,
	// before the request is ever sent. See CLAUDE.md (optional vs optionalKey).
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

export const SessionReplayListItem = Schema.Struct({
	sessionId: Schema.String,
	startTime: Schema.String,
	endTime: Schema.NullOr(Schema.String),
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	userId: Schema.String,
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
})

export class ListReplaysResponse extends Schema.Class<ListReplaysResponse>("ListReplaysResponse")({
	data: Schema.Array(SessionReplayListItem),
}) {}

// --- Detail ---

export class GetReplayRequest extends Schema.Class<GetReplayRequest>("GetReplayRequest")({
	sessionId: SessionId,
}) {}

export class GetReplayResponse extends Schema.Class<GetReplayResponse>("GetReplayResponse")({
	data: Schema.NullOr(
		Schema.Struct({
			sessionId: Schema.String,
			startTime: Schema.String,
			endTime: Schema.NullOr(Schema.String),
			durationMs: Schema.NullOr(Schema.Number),
			status: Schema.String,
			userId: Schema.String,
			urlInitial: Schema.String,
			userAgent: Schema.String,
			browserName: Schema.String,
			osName: Schema.String,
			deviceType: Schema.String,
			country: Schema.String,
			serviceName: Schema.String,
			pageViews: Schema.Number,
			clickCount: Schema.Number,
			errorCount: Schema.Number,
			traceIds: Schema.Array(Schema.String),
			resourceAttributes: Schema.String,
		}),
	),
}) {}

// --- Events (rrweb chunks, payload inline) ---

export class GetReplayEventsRequest extends Schema.Class<GetReplayEventsRequest>(
	"GetReplayEventsRequest",
)({
	sessionId: SessionId,
}) {}

export const SessionReplayChunk = Schema.Struct({
	chunkSeq: Schema.Number,
	timestamp: Schema.String,
	durationMs: Schema.Number,
	eventCount: Schema.Number,
	byteSize: Schema.Number,
	isCheckpoint: Schema.Number,
	/** The rrweb event array for this chunk, serialized as a JSON string. */
	events: Schema.String,
})

export class GetReplayEventsResponse extends Schema.Class<GetReplayEventsResponse>(
	"GetReplayEventsResponse",
)({
	chunks: Schema.Array(SessionReplayChunk),
}) {}

// --- Reverse correlation (trace → sessions) ---

export class ReplaysForTraceRequest extends Schema.Class<ReplaysForTraceRequest>(
	"ReplaysForTraceRequest",
)({
	traceId: TraceId,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class ReplaysForTraceResponse extends Schema.Class<ReplaysForTraceResponse>(
	"ReplaysForTraceResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			sessionId: Schema.String,
			startTime: Schema.String,
			durationMs: Schema.NullOr(Schema.Number),
		}),
	),
}) {}

// --- Trace summaries (one bar per correlated trace) ---

export class SessionTraceSummariesRequest extends Schema.Class<SessionTraceSummariesRequest>(
	"SessionTraceSummariesRequest",
)({
	/** The session's correlated trace ids (from the detail response's `traceIds`). */
	traceIds: Schema.Array(TraceId),
}) {}

export const SessionTraceSummary = Schema.Struct({
	traceId: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.Number,
	rootSpanName: Schema.String,
	rootServiceName: Schema.String,
	spanCount: Schema.Number,
	hasError: Schema.Number,
})

export class SessionTraceSummariesResponse extends Schema.Class<SessionTraceSummariesResponse>(
	"SessionTraceSummariesResponse",
)({
	data: Schema.Array(SessionTraceSummary),
}) {}

// --- Session transcript (distilled events) ---

export class SessionTranscriptRequest extends Schema.Class<SessionTranscriptRequest>(
	"SessionTranscriptRequest",
)({
	sessionId: SessionId,
}) {}

export const SessionEventItem = Schema.Struct({
	timestamp: Schema.String,
	seq: Schema.Number,
	type: Schema.String,
	url: Schema.String,
	traceId: Schema.String,
	level: Schema.String,
	message: Schema.String,
	targetSelector: Schema.String,
	targetText: Schema.String,
	netMethod: Schema.String,
	netUrl: Schema.String,
	netStatus: Schema.Number,
	netDurationMs: Schema.Number,
	errorStack: Schema.String,
})

export class SessionTranscriptResponse extends Schema.Class<SessionTranscriptResponse>(
	"SessionTranscriptResponse",
)({
	data: Schema.Array(SessionEventItem),
}) {}

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

const sessionReplayEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	TinybirdQueryError,
	TinybirdQuotaExceededError,
] as const

export class SessionReplaysApiGroup extends HttpApiGroup.make("sessionReplays")
	.add(
		HttpApiEndpoint.post("listReplays", "/list", {
			payload: ListReplaysRequest,
			success: ListReplaysResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("getReplay", "/get", {
			payload: GetReplayRequest,
			success: GetReplayResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("getReplayEvents", "/events", {
			payload: GetReplayEventsRequest,
			success: GetReplayEventsResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("replaysForTrace", "/for-trace", {
			payload: ReplaysForTraceRequest,
			success: ReplaysForTraceResponse,
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
	.add(
		HttpApiEndpoint.post("sessionTranscript", "/transcript", {
			payload: SessionTranscriptRequest,
			success: SessionTranscriptResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.prefix("/api/session-replays")
	.middleware(Authorization) {}
