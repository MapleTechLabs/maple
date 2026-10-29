import { cachedAs, readCached, recordCached, withCache } from "../../data/cached"
import { CH } from "@maple/query-engine"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { queryFirstRow, queryRows } from "../../data/local-query"
import { SessionDetailDefinition } from "./definition"
import { Message } from "./message"
import { SessionDetail, SessionTrace, TranscriptEvent } from "./model"

// The session detail queries as Commands.

export const ReadClock = SessionDetailDefinition.makeCommand("ReadSessionDetailClock", {
	messages: [Message.CompletedReadClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs }))
	},
})

/** Finalized metadata for one session (latest ReplacingMergeTree version), or null. */
export const FetchDetail = SessionDetailDefinition.makeCommand("FetchLocalSessionDetail", {
	args: {
		key: Schema.String,
		sessionId: Schema.String,
		apiBase: Schema.String,
		readsCache: Schema.Boolean,
	},
	messages: [Message.SucceededFetchDetail, Message.FailedFetchDetail, Message.FoundCachedDetail],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, sessionId, apiBase, readsCache }) =>
			Effect.gen(function* () {
				const cacheKey = ["local", "session", sessionId]
				const maybeCached = readsCache
					? yield* readCached(cacheKey, cachedAs(Schema.NullOr(SessionDetail)))
					: Option.none()
				if (Option.isSome(maybeCached))
					return Message.FoundCachedDetail({ key, cached: maybeCached.value })
				const row = yield* queryFirstRow(
					CH.compile(CH.getSessionReplayQuery(), { orgId: LOCAL_ORG_ID, sessionId }),
					apiBase,
				)
				const fetchedAtMs = yield* Clock.currentTimeMillis
				const detail = Option.match(row, {
					onNone: () => null,
					onSome: (session): SessionDetail => ({
						sessionId: session.sessionId,
						startTime: session.startTime,
						durationMs: session.durationMs,
						status: session.status,
						lastActivityAt: session.lastActivityAt,
						userId: session.userId,
						userName: session.userName,
						userEmail: session.userEmail,
						urlInitial: session.urlInitial,
						userAgent: session.userAgent,
						browserName: session.browserName,
						osName: session.osName,
						deviceType: session.deviceType,
						serviceName: session.serviceName,
						pageViews: session.pageViews,
						clickCount: session.clickCount,
						errorCount: session.errorCount,
						traceIds: session.traceIds,
					}),
				})
				yield* recordCached(cacheKey, detail, fetchedAtMs)
				return Message.SucceededFetchDetail({ key, detail, fetchedAtMs })
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchDetail({ key, failure }))))
	},
})

/** Distilled event transcript (navigation / click / console / network / error). */
export const FetchTranscript = SessionDetailDefinition.makeCommand("FetchLocalSessionTranscript", {
	args: {
		key: Schema.String,
		sessionId: Schema.String,
		apiBase: Schema.String,
		readsCache: Schema.Boolean,
	},
	messages: [
		Message.SucceededFetchTranscript,
		Message.FailedFetchTranscript,
		Message.FoundCachedTranscript,
	],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, sessionId, apiBase, readsCache }) =>
			withCache({
				key: ["local", "session-transcript", sessionId],
				readsCache,
				fromCached: cachedAs(Schema.Array(TranscriptEvent)),
				toCached: (events: ReadonlyArray<TranscriptEvent>) => events,
				fetch: Effect.map(
					queryRows(
						CH.compile(CH.sessionTranscriptQuery({ limit: 250 }), {
							orgId: LOCAL_ORG_ID,
							sessionId,
						}),
						apiBase,
					),
					(rows): ReadonlyArray<TranscriptEvent> =>
						rows.map((row): TranscriptEvent => ({
							timestamp: row.timestamp,
							seq: row.seq,
							type: row.type,
							url: row.url,
							level: row.level,
							message: row.message,
							targetSelector: row.targetSelector,
							targetText: row.targetText,
							netMethod: row.netMethod,
							netUrl: row.netUrl,
							netStatus: row.netStatus,
							netDurationMs: row.netDurationMs,
							errorStack: row.errorStack,
						})),
				),
				found: (cached) => Message.FoundCachedTranscript({ key, cached }),
				succeeded: (events, fetchedAtMs) =>
					Message.SucceededFetchTranscript({ key, events, fetchedAtMs }),
			}).pipe(
				Effect.catch((failure) => Effect.succeed(Message.FailedFetchTranscript({ key, failure }))),
			)
	},
})

/** Per-trace summaries for the session's correlated backend traces. */
export const FetchTraces = SessionDetailDefinition.makeCommand("FetchLocalSessionTraces", {
	args: {
		key: Schema.String,
		traceIds: Schema.Array(Schema.String),
		apiBase: Schema.String,
		readsCache: Schema.Boolean,
	},
	messages: [Message.SucceededFetchTraces, Message.FailedFetchTraces, Message.FoundCachedTraces],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, traceIds, apiBase, readsCache }) =>
			withCache({
				key: ["local", "session-traces", traceIds],
				readsCache,
				fromCached: cachedAs(Schema.Array(SessionTrace)),
				toCached: (traces: ReadonlyArray<SessionTrace>) => traces,
				fetch: Effect.map(
					queryRows(
						CH.compile(CH.sessionTraceSummariesQuery({ traceIds }), { orgId: LOCAL_ORG_ID }),
						apiBase,
					),
					(rows): ReadonlyArray<SessionTrace> =>
						rows.map((row): SessionTrace => ({
							traceId: row.traceId,
							durationMs: row.durationMs,
							rootSpanName: row.rootSpanName,
							rootServiceName: row.rootServiceName,
							spanCount: row.spanCount,
							hasError: row.hasError,
						})),
				),
				found: (cached) => Message.FoundCachedTraces({ key, cached }),
				succeeded: (traces, fetchedAtMs) =>
					Message.SucceededFetchTraces({ key, traces, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTraces({ key, failure }))))
	},
})

/** Every handler the page owns; HTTP and the result cache come from the application Layer. */
export const EffectsLayer = Layer.mergeAll(
	ReadClock.layer,
	FetchDetail.layer,
	FetchTranscript.layer,
	FetchTraces.layer,
)
