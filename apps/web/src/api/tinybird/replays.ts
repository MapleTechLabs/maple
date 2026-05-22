import { Clock, Effect, Schema } from "effect"
import {
	GetReplayEventsRequest,
	GetReplayRequest,
	ListReplaysRequest,
	ReplaysForTraceRequest,
	SessionId,
	TraceId,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { TinybirdDateTimeString, decodeInput, runTinybirdQuery } from "@/api/tinybird/effect-utils"

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

const ListReplaysInput = Schema.Struct({
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
})
export type ListReplaysInput = Schema.Schema.Type<typeof ListReplaysInput>

const defaultTimeRange = (nowMs: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMs - 24 * 60 * 60 * 1000), endTime: fmt(nowMs) }
}

export const listReplays = Effect.fn("SessionReplays.listReplays")(function* ({
	data,
}: {
	data: ListReplaysInput
}) {
	const input = yield* decodeInput(ListReplaysInput, data ?? {}, "listReplays")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runTinybirdQuery("listReplays", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.listReplays({
				payload: new ListReplaysRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					serviceName: input.serviceName,
					browser: input.browser,
					country: input.country,
					deviceType: input.deviceType,
					hasErrors: input.hasErrors,
					search: input.search,
					cursor: input.cursor,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				}),
			})
		}),
	)
	return { data: result.data }
})

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------

const GetReplayInput = Schema.Struct({ sessionId: SessionId })
// Encoded shape (plain strings) — callers pass raw route params; decodeInput brands them.
export type GetReplayInput = (typeof GetReplayInput)["Encoded"]

export const getReplay = Effect.fn("SessionReplays.getReplay")(function* ({
	data,
}: {
	data: GetReplayInput
}) {
	const input = yield* decodeInput(GetReplayInput, data ?? {}, "getReplay")
	const result = yield* runTinybirdQuery("getReplay", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.getReplay({
				payload: new GetReplayRequest({ sessionId: input.sessionId }),
			})
		}),
	)
	return { data: result.data }
})

// ---------------------------------------------------------------------------
// Session event chunks (signed R2 URLs, ordered)
// ---------------------------------------------------------------------------

const GetReplayEventsInput = Schema.Struct({ sessionId: SessionId })
export type GetReplayEventsInput = (typeof GetReplayEventsInput)["Encoded"]

export const getReplayEvents = Effect.fn("SessionReplays.getReplayEvents")(function* ({
	data,
}: {
	data: GetReplayEventsInput
}) {
	const input = yield* decodeInput(GetReplayEventsInput, data ?? {}, "getReplayEvents")
	const result = yield* runTinybirdQuery("getReplayEvents", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.getReplayEvents({
				payload: new GetReplayEventsRequest({ sessionId: input.sessionId }),
			})
		}),
	)
	return { chunks: result.chunks }
})

// ---------------------------------------------------------------------------
// Reverse correlation: replays observing a trace
// ---------------------------------------------------------------------------

const ReplaysForTraceInput = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
})
export type ReplaysForTraceInput = (typeof ReplaysForTraceInput)["Encoded"]

export const getReplaysForTrace = Effect.fn("SessionReplays.replaysForTrace")(function* ({
	data,
}: {
	data: ReplaysForTraceInput
}) {
	const input = yield* decodeInput(ReplaysForTraceInput, data ?? {}, "replaysForTrace")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runTinybirdQuery("replaysForTrace", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.replaysForTrace({
				payload: new ReplaysForTraceRequest({
					traceId: input.traceId,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)
	return { data: result.data }
})
