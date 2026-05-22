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
// Backed by the session_replays (metadata) + session_replay_chunks (R2 index)
// datasources. Event blobs themselves never transit this API — `getReplayEvents`
// returns short-lived signed R2 URLs the player fetches directly.
// ---------------------------------------------------------------------------

// --- List ---

export class ListReplaysRequest extends Schema.Class<ListReplaysRequest>("ListReplaysRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	serviceName: Schema.optionalKey(Schema.String),
	browser: Schema.optionalKey(Schema.String),
	country: Schema.optionalKey(Schema.String),
	deviceType: Schema.optionalKey(Schema.String),
	hasErrors: Schema.optionalKey(Schema.Boolean),
	search: Schema.optionalKey(Schema.String),
	cursor: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Number),
	offset: Schema.optionalKey(Schema.Number),
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

// --- Events (signed chunk URLs) ---

export class GetReplayEventsRequest extends Schema.Class<GetReplayEventsRequest>(
	"GetReplayEventsRequest",
)({
	sessionId: SessionId,
}) {}

export const SessionReplayChunkUrl = Schema.Struct({
	chunkSeq: Schema.Number,
	timestamp: Schema.String,
	durationMs: Schema.Number,
	eventCount: Schema.Number,
	byteSize: Schema.Number,
	isCheckpoint: Schema.Number,
	url: Schema.String,
})

export class GetReplayEventsResponse extends Schema.Class<GetReplayEventsResponse>(
	"GetReplayEventsResponse",
)({
	chunks: Schema.Array(SessionReplayChunkUrl),
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
	.prefix("/api/session-replays")
	.middleware(Authorization) {}
