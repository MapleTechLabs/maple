import { Effect } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type { SessionTranscriptOutput } from "../ch/queries/session-events"

/**
 * Search for sessions whose distilled events match the given predicates
 * (errors, network status, console/url text, trace id). Returns one row per
 * matching session with the match count and time bounds — the MCP / UI layer
 * joins these back to session metadata.
 */
export interface SearchSessionsInput {
	readonly startTime: string
	readonly endTime: string
	readonly type?: string
	readonly level?: string
	readonly minStatus?: number
	readonly urlSearch?: string
	readonly messageSearch?: string
	readonly traceId?: string
	readonly limit?: number
	readonly offset?: number
}

export const searchSessions = Effect.fn("Observability.searchSessions")(function* (
	input: SearchSessionsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.searchSessionsByEventQuery({
			type: input.type,
			level: input.level,
			minStatus: input.minStatus,
			urlSearch: input.urlSearch,
			messageSearch: input.messageSearch,
			traceId: input.traceId,
			limit: input.limit,
			offset: input.offset,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, { profile: "list" })
})

/**
 * Return a page of the distilled-event transcript for a single session, in order.
 * Bounded by `limit`/`offset` and optionally narrowed by event type / trace / errors-only,
 * so a long session can't blow an agent's context window.
 */
export interface SessionTranscriptInput {
	readonly sessionId: string
	readonly types?: readonly string[]
	readonly traceId?: string
	readonly errorsOnly?: boolean
	readonly limit?: number
	readonly offset?: number
}

export const getSessionTranscript = Effect.fn("Observability.getSessionTranscript")(function* (
	input: SessionTranscriptInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({ orgId: executor.orgId, sessionId: input.sessionId })
	const compiled = CH.compile(
		CH.sessionTranscriptQuery({
			types: input.types,
			traceId: input.traceId,
			errorsOnly: input.errorsOnly,
			limit: input.limit,
			offset: input.offset,
		}),
		{
			orgId: executor.orgId,
			sessionId: input.sessionId,
		},
	)
	return yield* executor.compiledQuery(compiled, { profile: "list" })
})
