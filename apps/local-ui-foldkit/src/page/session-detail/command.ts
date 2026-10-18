import { CH } from "@maple/query-engine"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { queryFirstRow, queryRows } from "../../data/local-query"
import { Message } from "./message"
import type { SessionDetail, SessionTrace, TranscriptEvent } from "./model"

// apps/local-ui/src/hooks/use-local-session-detail.ts as Commands.

export const ReadClock = Command.define("ReadSessionDetailClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** Finalized metadata for one session (latest ReplacingMergeTree version), or null. */
export const FetchDetail = Command.define("FetchLocalSessionDetail", {
	args: { key: Schema.String, sessionId: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededFetchDetail, Message.FailedFetchDetail],
	execute: ({ key, sessionId, apiBase }) =>
		Effect.gen(function* () {
			const row = yield* queryFirstRow(CH.compile(CH.getSessionReplayQuery(), { orgId: LOCAL_ORG_ID, sessionId }), apiBase)
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
			return Message.SucceededFetchDetail({ key, detail, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchDetail({ key, failure })))),
})

/** Distilled event transcript (navigation / click / console / network / error). */
export const FetchTranscript = Command.define("FetchLocalSessionTranscript", {
	args: { key: Schema.String, sessionId: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededFetchTranscript, Message.FailedFetchTranscript],
	execute: ({ key, sessionId, apiBase }) =>
		queryRows(CH.compile(CH.sessionTranscriptQuery({ limit: 250 }), { orgId: LOCAL_ORG_ID, sessionId }), apiBase).pipe(
			Effect.map((rows) =>
				Message.SucceededFetchTranscript({
					key,
					events: rows.map(
						(row): TranscriptEvent => ({
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
						}),
					),
				}),
			),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchTranscript({ key, failure }))),
		),
})

/** Per-trace summaries for the session's correlated backend traces. */
export const FetchTraces = Command.define("FetchLocalSessionTraces", {
	args: { key: Schema.String, traceIds: Schema.Array(Schema.String), apiBase: Schema.String },
	messages: [Message.SucceededFetchTraces, Message.FailedFetchTraces],
	execute: ({ key, traceIds, apiBase }) =>
		queryRows(CH.compile(CH.sessionTraceSummariesQuery({ traceIds }), { orgId: LOCAL_ORG_ID }), apiBase).pipe(
			Effect.map((rows) =>
				Message.SucceededFetchTraces({
					key,
					traces: rows.map(
						(row): SessionTrace => ({
							traceId: row.traceId,
							durationMs: row.durationMs,
							rootSpanName: row.rootSpanName,
							rootServiceName: row.rootServiceName,
							spanCount: row.spanCount,
							hasError: row.hasError,
						}),
					),
				}),
			),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchTraces({ key, failure }))),
		),
})
