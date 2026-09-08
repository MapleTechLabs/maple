import { Clock, Effect, Schema, type Types } from "effect"
import { ReplaysFacetsRequest, SessionId, SessionTraceSummariesRequest, TraceId } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	runWarehouseQuery,
	runWarehouseQueryV2,
} from "@/api/warehouse/effect-utils"

import {
	V2SessionReplayNotFound,
	type V2SessionReplaySearchParams,
	type V2SessionReplayWindowQuery,
	type V2SessionReplayCollectionQuery,
	type V2SessionReplaysForTraceParams,
} from "@maple/domain/http/v2"
import { collectV2Pages } from "@/lib/services/common/v2-pagination"
import { replayListItemFromV2, replayDetailFromV2, replayEventFromV2 } from "@/lib/services/session-replays"

import { formatWarehouseDateTime } from "@maple/query-engine"

const ListReplaysInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	/** Substring match on the identified user's name or email. */
	userSearch: Schema.optional(Schema.String),
	/** Identified group (company / team) name. */
	groupName: Schema.optional(Schema.String),
	/** Every session from one browser — the marketing-visit → signup join. */
	visitorId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	// Session-time range filters (ms) — duration is the stored wall-clock time,
	// activeTime is computed server-side from session_events gaps.
	durationMinMs: Schema.optional(Schema.Number),
	durationMaxMs: Schema.optional(Schema.Number),
	activeTimeMinMs: Schema.optional(Schema.Number),
	activeTimeMaxMs: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
})
export type ListReplaysInput = Schema.Schema.Type<typeof ListReplaysInput>

const defaultTimeRange = (nowMs: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMs - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMs),
	}
}

export const listReplays = Effect.fn("SessionReplays.listReplays")(function* ({
	data,
}: {
	data: ListReplaysInput
}) {
	const input = yield* decodeInput(ListReplaysInput, data ?? {}, "listReplays")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQueryV2("listReplays", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			const payload: Types.Mutable<V2SessionReplaySearchParams> = {
				start_time: toIsoWindow(input.startTime ?? fallback.startTime),
				end_time: toIsoWindow(input.endTime ?? fallback.endTime),
				limit: input.limit ?? 50,
			}
			if (input.serviceName !== undefined) payload.service_name = input.serviceName
			if (input.browser !== undefined) payload.browser = input.browser
			if (input.country !== undefined) payload.country = input.country
			if (input.deviceType !== undefined) payload.device_type = input.deviceType
			if (input.userId !== undefined) payload.user_id = input.userId
			if (input.userSearch !== undefined) payload.user_search = input.userSearch
			if (input.groupName !== undefined) payload.group_name = input.groupName
			if (input.visitorId !== undefined) payload.visitor_id = input.visitorId
			if (input.hasErrors !== undefined) payload.has_errors = input.hasErrors
			if (input.search !== undefined) payload.search = input.search
			if (input.cursor !== undefined) payload.cursor = input.cursor
			if (input.durationMinMs !== undefined) payload.duration_min_ms = input.durationMinMs
			if (input.durationMaxMs !== undefined) payload.duration_max_ms = input.durationMaxMs
			if (input.activeTimeMinMs !== undefined) payload.active_time_min_ms = input.activeTimeMinMs
			if (input.activeTimeMaxMs !== undefined) payload.active_time_max_ms = input.activeTimeMaxMs
			return yield* client.sessionReplays.search({ payload })
		}),
	)
	return {
		data: result.data.map(replayListItemFromV2),
		hasMore: result.has_more,
		nextCursor: result.next_cursor,
	}
})

// List facets (filter sidebar option counts)

const ReplaysFacetsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	userSearch: Schema.optional(Schema.String),
	groupName: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
})
export type ReplaysFacetsInput = Schema.Schema.Type<typeof ReplaysFacetsInput>

export const getReplaysFacets = Effect.fn("SessionReplays.facets")(function* ({
	data,
}: {
	data: ReplaysFacetsInput
}) {
	const input = yield* decodeInput(ReplaysFacetsInput, data ?? {}, "replaysFacets")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("replaysFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.sessionReplaysInternal.facets({
				payload: new ReplaysFacetsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					serviceName: input.serviceName,
					browser: input.browser,
					country: input.country,
					deviceType: input.deviceType,
					userId: input.userId,
					userSearch: input.userSearch,
					groupName: input.groupName,
					hasErrors: input.hasErrors,
					search: input.search,
				}),
			})
		}),
	)
	return {
		services: result.services,
		browsers: result.browsers,
		countries: result.countries,
		devices: result.devices,
		groups: result.groups,
		errorCount: result.errorCount,
		durationBuckets: result.durationBuckets,
		durationP50: result.durationP50,
		durationP95: result.durationP95,
	}
})

const GetReplayInput = Schema.Struct({
	sessionId: SessionId,
	// Optional session time window (derived from the `t` navigation hint) so the
	// warehouse prunes daily partitions instead of scanning the 30-day retention.
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
// Encoded shape (plain strings) — callers pass raw route params; decodeInput brands them.
export type GetReplayInput = (typeof GetReplayInput)["Encoded"]

export const getReplay = Effect.fn("SessionReplays.getReplay")(function* ({
	data,
}: {
	data: GetReplayInput
}) {
	const input = yield* decodeInput(GetReplayInput, data ?? {}, "getReplay")
	const dataResult = yield* runWarehouseQueryV2("getReplay", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.sessionReplays
				.retrieve({
					params: { id: input.sessionId },
					query: replayWindow(input),
				})
				.pipe(
					Effect.map(replayDetailFromV2),
					Effect.catchIf(Schema.is(V2SessionReplayNotFound.schema), () => Effect.succeed(null)),
				)
		}),
	)
	return { data: dataResult }
})

// Session event chunks — manifest first, then bounded ranges (v2)
//
// A session's rrweb payload is unbounded by construction: ingest accepts up to
// 1 GiB and the p99 session is ~594 MB. Fetching all of it in one response
// buffered the whole thing into a 128 MB Worker and surfaced as a 503 that
// blamed the database. So the player pulls the cheap manifest (timeline and
// sizes, no payloads), then pulls payloads a range at a time.
//
// All replay resource reads use v2; payload reads remain manifest-first and bounded.

/** Warehouse `YYYY-MM-DD HH:mm:ss` → the ISO-8601 the v2 query params take. */
const toIsoWindow = (value: string) => new Date(`${value.replace(" ", "T")}Z`).toISOString()

const replayWindow = (input: { windowStart?: string; windowEnd?: string }) => {
	const query: Types.Mutable<V2SessionReplayWindowQuery> = {}
	if (input.windowStart !== undefined) query.window_start = toIsoWindow(input.windowStart)
	if (input.windowEnd !== undefined) query.window_end = toIsoWindow(input.windowEnd)
	return query
}

const GetReplayManifestInput = Schema.Struct({
	sessionId: SessionId,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type GetReplayManifestInput = (typeof GetReplayManifestInput)["Encoded"]

export const getReplayManifest = Effect.fn("SessionReplays.getReplayManifest")(function* ({
	data,
}: {
	data: GetReplayManifestInput
}) {
	const input = yield* decodeInput(GetReplayManifestInput, data ?? {}, "getReplayManifest")
	return yield* runWarehouseQueryV2("getReplayManifest", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			// The `srep_…` public-ID codec lives in the client's param encoder, so
			// the internal SessionId goes in as-is.
			return yield* client.sessionReplays.manifest({
				params: { id: input.sessionId },
				query: replayWindow(input),
			})
		}),
	)
})

const GetReplayEventsInput = Schema.Struct({
	sessionId: SessionId,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
	/**
	 * Inclusive chunk range from the manifest. Required: an optional range would
	 * leave the unbounded read reachable from the client, and something would
	 * eventually reach it.
	 */
	fromChunkSeq: Schema.Number,
	toChunkSeq: Schema.Number,
})
export type GetReplayEventsInput = (typeof GetReplayEventsInput)["Encoded"]

export const getReplayEvents = Effect.fn("SessionReplays.getReplayEvents")(function* ({
	data,
}: {
	data: GetReplayEventsInput
}) {
	const input = yield* decodeInput(GetReplayEventsInput, data ?? {}, "getReplayEvents")
	const result = yield* runWarehouseQueryV2("getReplayEvents", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.sessionReplays.events({
				params: { id: input.sessionId },
				query: {
					from_chunk_seq: input.fromChunkSeq,
					to_chunk_seq: input.toChunkSeq,
					// One page covers the whole range: ranges are sized by the caller
					// against the server's advertised cap, so paging within one would
					// only add round-trips.
					limit: Math.max(1, input.toChunkSeq - input.fromChunkSeq + 1),
					...replayWindow(input),
				},
			})
		}),
	)
	return { chunks: result.data }
})

// Distilled session transcript (console / network / errors / nav / clicks)

const SessionTranscriptInput = Schema.Struct({
	sessionId: SessionId,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type SessionTranscriptInput = (typeof SessionTranscriptInput)["Encoded"]

export const getSessionTranscript = Effect.fn("SessionReplays.sessionTranscript")(function* ({
	data,
}: {
	data: SessionTranscriptInput
}) {
	const input = yield* decodeInput(SessionTranscriptInput, data ?? {}, "sessionTranscript")
	const events = yield* runWarehouseQueryV2("sessionTranscript", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* collectV2Pages((cursor) => {
				const query: Types.Mutable<typeof V2SessionReplayCollectionQuery.Type> = {
					...replayWindow(input),
					limit: 100,
				}
				if (cursor !== undefined) query.cursor = cursor
				return client.sessionReplays.transcript({ params: { id: input.sessionId }, query })
			}).pipe(Effect.catchIf(Schema.is(V2SessionReplayNotFound.schema), () => Effect.succeed([])))
		}),
	)
	return { data: events.map(replayEventFromV2) }
})

// Reverse correlation: replays observing a trace

const ReplaysForTraceInput = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})
export type ReplaysForTraceInput = (typeof ReplaysForTraceInput)["Encoded"]

export const getReplaysForTrace = Effect.fn("SessionReplays.replaysForTrace")(function* ({
	data,
}: {
	data: ReplaysForTraceInput
}) {
	const input = yield* decodeInput(ReplaysForTraceInput, data ?? {}, "replaysForTrace")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const replays = yield* runWarehouseQueryV2("replaysForTrace", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* collectV2Pages((cursor) => {
				const payload: Types.Mutable<V2SessionReplaysForTraceParams> = {
					trace_id: input.traceId,
					start_time: toIsoWindow(input.startTime ?? fallback.startTime),
					end_time: toIsoWindow(input.endTime ?? fallback.endTime),
					limit: 100,
				}
				if (cursor !== undefined) payload.cursor = cursor
				return client.sessionReplays.forTrace({ payload })
			})
		}),
	)
	return {
		data: replays.map((replay) => ({
			sessionId: replay.id,
			startTime: replay.start_time,
			durationMs: replay.duration_ms,
		})),
	}
})

// Per-trace summaries for a session's correlated traces (timeline bars)

const SessionTraceSummariesInput = Schema.Struct({
	traceIds: Schema.Array(TraceId),
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type SessionTraceSummariesInput = (typeof SessionTraceSummariesInput)["Encoded"]

export const getSessionTraceSummaries = Effect.fn("SessionReplays.traceSummaries")(function* ({
	data,
}: {
	data: SessionTraceSummariesInput
}) {
	const input = yield* decodeInput(SessionTraceSummariesInput, data ?? { traceIds: [] }, "traceSummaries")
	const result = yield* runWarehouseQuery("traceSummaries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.sessionReplaysInternal.traceSummaries({
				payload: new SessionTraceSummariesRequest({
					traceIds: input.traceIds,
					windowStart: input.windowStart,
					windowEnd: input.windowEnd,
				}),
			})
		}),
	)
	return { data: result.data }
})
