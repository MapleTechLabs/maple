/**
 * Starting an investigation's autonomous pass: one turn on the investigation's
 * `ChatSession` Durable Object, run by the investigate agent, closed by
 * `submit_diagnosis`.
 *
 * Every producer reaches this — an incident opening, a merged PR's verification,
 * a manual start or restart — so the failure discipline is in one place: a
 * missing binding or a turn that could not be claimed marks the row `failed`
 * with a retryable reason and says so on the span.
 */
import { investigations } from "@maple/db"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import { AUTONOMOUS_ORIGIN, encodeChatTurnTenant } from "@maple/domain/chat-session"
import { chatSessionStub } from "@maple/domain/chat-session-stub"
import type { InvestigationSubject, InvestigationSubjectSnapshot, OrgId } from "@maple/domain/http"
import { AUTONOMOUS_KICKOFF_LEAD, buildIncidentContextMessage } from "@maple/domain/incident-context"
import type { InvestigationId } from "@maple/domain/primitives"
import { UserId } from "@maple/domain/primitives"
import { eq } from "drizzle-orm"
import { Effect, Exit, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

/** Identity an autonomous investigation turn runs as — the same one the internal MCP RPC uses. */
export const internalServiceUserId = Schema.decodeSync(UserId)("internal-service")

/** The chat session an investigation's transcript lives in. */
export const investigationSessionId = (orgId: OrgId, investigationId: InvestigationId): string =>
	`${orgId}:inv-${investigationId}`

export const AGENT_UNAVAILABLE_ERROR = "agent_unavailable: the investigation agent is not configured; retry"
export const START_FAILED_ERROR = "start_failed: the investigation agent could not start a turn; retry"

export interface StartInvestigationTurnInput {
	readonly orgId: OrgId
	readonly investigationId: InvestigationId
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	/** The Worker env, for the `ChatSession` binding. Absent outside a Worker isolate. */
	readonly workerEnv: Record<string, unknown> | undefined
	readonly nowMs: number
	/** Extra span attributes merged into every outcome annotation. */
	readonly annotations?: Record<string, string>
}

export type StartInvestigationTurnResult =
	| { readonly started: true }
	/** `busy`: the session already has a turn in flight, so the pass is already under way. */
	| { readonly started: false; readonly reason: "no_binding" | "busy" | "error" }

export const startInvestigationTurn: (
	input: StartInvestigationTurnInput,
) => Effect.Effect<StartInvestigationTurnResult, DatabaseError, Database> = Effect.fn(
	"startInvestigationTurn",
)(function* (input) {
	const database = yield* Database
	const { orgId, investigationId, nowMs } = input
	const annotate = (result: string) =>
		Effect.annotateCurrentSpan({
			orgId,
			"maple.investigation.id": investigationId,
			"maple.investigation.start_result": result,
			...input.annotations,
		})

	const markFailed = (error: string) =>
		database
			.execute((db) =>
				db
					.update(investigations)
					.set({ status: "failed", error, updatedAt: new Date(nowMs) })
					.where(eq(investigations.id, investigationId)),
			)
			.pipe(Effect.asVoid)

	const sessionId = investigationSessionId(orgId, investigationId)
	const stub = input.workerEnv === undefined ? undefined : chatSessionStub(input.workerEnv, sessionId)
	if (stub === undefined) {
		yield* markFailed(AGENT_UNAVAILABLE_ERROR)
		yield* annotate("no_binding")
		return { started: false, reason: "no_binding" as const }
	}

	// Fenced in full: this prompt is machine-written, and the transcript replays user
	// turns to everyone who opens the investigation.
	const text = wrapChatContext(
		buildIncidentContextMessage(AUTONOMOUS_KICKOFF_LEAD, input.subject, input.snapshot),
		"",
	)
	const claimed = yield* Effect.exit(
		Effect.tryPromise(() =>
			stub.beginTurn({
				sessionId,
				messageId: crypto.randomUUID(),
				text,
				tenant: encodeChatTurnTenant({
					orgId,
					userId: internalServiceUserId,
					roles: [],
					authMode: "self_hosted",
				}),
				origin: AUTONOMOUS_ORIGIN,
			}),
		),
	)

	if (Exit.isFailure(claimed)) {
		yield* Effect.logWarning("Investigation turn could not be started").pipe(
			Effect.annotateLogs({ orgId, investigationId, error: summarizeCause(claimed.cause) }),
		)
		yield* markFailed(START_FAILED_ERROR)
		yield* annotate("start_failed")
		return { started: false, reason: "error" as const }
	}
	if (claimed.value === undefined) {
		yield* annotate("turn_in_flight")
		return { started: false, reason: "busy" as const }
	}

	yield* annotate("started")
	return { started: true as const }
})
