/**
 * Starting an investigation: the one place that admits a start against the org's daily budget
 * and kicks off its autonomous pass (one turn on the investigation's `ChatSession`, closed by
 * `submit_diagnosis`).
 *
 * Every producer reaches this: an incident opening, a merged PR's verification, a manual start
 * or restart. Admission takes a per-org Postgres lock around the quota read and the write that
 * spends it, so producers in different isolates cannot all read the same usage and overshoot.
 */
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { AiTriageSettings, Investigations } from "@maple/db/tables"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import { encodeChatTurnTenant } from "@maple/domain/chat-session"
import type {
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	IssueSeverity,
	OrgId,
} from "@maple/domain/http"
import type { InvestigationId } from "@maple/primitives"
import { UserId } from "@maple/primitives"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { ChatSessions } from "@maple/backend/platform/bindings"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { AUTONOMOUS_KICKOFF_LEAD, buildIncidentContextMessage } from "./incident-context"
import {
	evaluateInvestigationQuota,
	type InvestigationQuotaVerdict,
	selectInvestigationUsage,
} from "./investigation-quota"

/** Identity an autonomous investigation turn runs as: the same one the internal MCP RPC uses. */
export const internalServiceUserId = Schema.decodeSync(UserId)("internal-service")

/** The chat session an investigation's transcript lives in. */
export const investigationSessionId = (orgId: OrgId, investigationId: InvestigationId): string =>
	`${orgId}:inv-${investigationId}`

export const AGENT_UNAVAILABLE_ERROR = "agent_unavailable: the investigation agent is not configured; retry"
export const START_FAILED_ERROR = "start_failed: the investigation agent could not start a turn; retry"

export interface AdmitInvestigationInput<A> {
	readonly orgId: OrgId
	readonly nowMs: number
	/** Decides which ceiling applies; absent reads as ordinary, never as priority. */
	readonly severity: IssueSeverity | null
	/** The write that spends the budget (an insert or a `startedAt` claim), run under the lock. */
	readonly spend: (db: MapleDb) => Effect.Effect<A, MapleDbError>
	/** Extra annotations for the refusal's log line and span. */
	readonly annotations?: Record<string, string>
}

export type InvestigationAdmission<A> =
	| { readonly admitted: true; readonly value: A }
	| { readonly admitted: false; readonly verdict: Extract<InvestigationQuotaVerdict, { kind: "exceeded" }> }

export interface StartInvestigationTurnInput {
	readonly orgId: OrgId
	readonly investigationId: InvestigationId
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly nowMs: number
	/** Extra span attributes merged into every outcome annotation. */
	readonly annotations?: Record<string, string>
}

export type StartInvestigationTurnResult =
	| { readonly started: true }
	/** `busy`: the session already has a turn in flight, so the pass is already under way. */
	| { readonly started: false; readonly reason: "no_binding" | "busy" | "error" }

export interface InvestigationStarterApi {
	readonly admit: <A>(
		input: AdmitInvestigationInput<A>,
	) => Effect.Effect<InvestigationAdmission<A>, DatabaseError>
	/**
	 * Kick off the pass. A missing binding or a turn that could not be claimed marks the row
	 * `failed` with a retryable reason and says so on the span.
	 */
	readonly startTurn: (
		input: StartInvestigationTurnInput,
	) => Effect.Effect<StartInvestigationTurnResult, DatabaseError>
}

/** Serializes an org's investigation admissions within their transaction. */
const lockAdmissions = (db: MapleDb, orgId: OrgId) =>
	db.execute(Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext('investigation_admission'))`)

/**
 * A manual start or restart's write, under the same lock so it counts toward what the producers
 * read, but never refused: the v2 create and restart contracts carry no quota error.
 */
export const admitManualStart = <A, E>(db: MapleDb, orgId: OrgId, spend: Effect.Effect<A, E>) =>
	db.transaction(Effect.andThen(lockAdmissions(db, orgId), spend))

export class InvestigationStarter extends Context.Service<InvestigationStarter, InvestigationStarterApi>()(
	"@maple/backend/services/errors/InvestigationStarter",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			// The one optional read of the agent port: absent outside a Worker isolate, where a
			// start records `no_binding` rather than silently degrading.
			const chatSessionsOption = yield* Effect.serviceOption(ChatSessions)
			const chatSessions = Option.getOrUndefined(chatSessionsOption)

			const admit: InvestigationStarterApi["admit"] = (input) =>
				database
					.execute((db) =>
						db.transaction(
							Effect.gen(function* () {
								yield* lockAdmissions(db, input.orgId)
								const settings = yield* db.run(
									PG.from(AiTriageSettings)
										.select(($) => ({
											maxRunsPerDay: $.maxRunsPerDay,
											maxPassesPerDay: $.maxPassesPerDay,
										}))
										.where(($) => [$.orgId.eq(input.orgId)])
										.limit(1),
								)
								const usage = yield* selectInvestigationUsage(db, input.orgId, input.nowMs)
								const verdict = evaluateInvestigationQuota({
									usage,
									limits: settings[0],
									passCount: 1,
									nowMs: input.nowMs,
									// Severity decides which ceiling applies, so a burst of `low` incidents
									// just after UTC midnight cannot spend the slice a `critical` needs.
									severity: input.severity,
								})
								if (verdict.kind === "exceeded") return { admitted: false as const, verdict }
								return { admitted: true as const, value: yield* input.spend(db) }
							}),
						),
					)
					.pipe(
						Effect.tap((admission) => {
							if (admission.admitted) return Effect.void
							const severity = input.severity ?? "unclassified"
							const { verdict } = admission
							return Effect.logWarning(
								"Investigation daily budget reached; skipping start",
							).pipe(
								Effect.annotateLogs({
									orgId: input.orgId,
									quotaDimension: verdict.dimension,
									quotaLimit: verdict.limit,
									// "runs, 100" reads the same for a `low` anomaly and for the `critical`
									// the reserve protects; the severity tells them apart.
									severity,
									...input.annotations,
								}),
								// A refusal must read as one on the span, not as an org with nothing to do.
								Effect.andThen(
									Effect.annotateCurrentSpan({
										orgId: input.orgId,
										"maple.investigation.start_result": "quota_exceeded",
										"maple.investigation.quota_dimension": verdict.dimension,
										"maple.investigation.quota_limit": verdict.limit,
										"maple.investigation.severity": severity,
										...input.annotations,
									}),
								),
							)
						}),
					)

			const startTurn: InvestigationStarterApi["startTurn"] = Effect.fn(
				"InvestigationStarter.startTurn",
			)(function* (input) {
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
							db.run(
								PG.update(Investigations)
									.set({ status: "failed", error, updatedAt: nowMs })
									.where(($) => [
										$.orgId.eq(orgId),
										$.id.eq(investigationId),
										$.status.eq("investigating"),
									]),
							),
						)
						.pipe(Effect.asVoid)

				const sessionId = investigationSessionId(orgId, investigationId)
				const stub = chatSessions?.session(sessionId)
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
					stub.beginTurn({
						sessionId,
						messageId: SecureRandom.uuidV4Unsafe(),
						text,
						tenant: encodeChatTurnTenant({
							orgId,
							userId: internalServiceUserId,
							roles: [],
							authMode: "self_hosted",
						}),
						origin: { kind: "autonomous" },
					}),
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

			return { admit, startTurn } satisfies InvestigationStarterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
