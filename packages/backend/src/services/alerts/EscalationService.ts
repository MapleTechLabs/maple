/**
 * Drains the issue-escalation outbox (`issue_escalations`, written by the AI
 * triage workflow's persist step and manual severity changes) through the
 * org's escalation policy to the shared NotificationDispatcher.
 *
 * Severity → destination routing is the *triage-outcome* channel: detection
 * noise stays on alert-rule destinations / the error notification policy, so
 * a severity escalation is at-most-once per issue+level (outbox dedupeKey),
 * upward-only (enforced by the writers via escalationReasonFor).
 */
import {
	AlertPersistenceError,
	AlertSignalType,
	EscalationConfidence,
	IssueEscalationPolicyRule,
	type AlertSeverity,
	type IssueSeverity,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDestinations,
	ErrorIssues,
	IssueEscalationPolicies,
	IssueEscalations,
	type IssueEscalationPolicyRow,
	type IssueEscalationRow,
} from "@maple/db/tables"
import { Cause, Clock, Context, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { evaluateEscalationPolicy } from "@maple/backend/services/alerts/escalation-policy"
import { makePersistenceError } from "./alert-persistence"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { transitionRow } from "@maple/backend/platform/transition-row"

const ESCALATIONS_PER_TICK = 50
const MAX_ATTEMPTS = 3
// A claim that never reaches its pre-dispatch "sent" flip (a defect) frees the row after this.
const CLAIM_LEASE_MS = 5 * 60 * 1000

type EscalationStatus = IssueEscalationRow["status"]

/** A tick's claim on a row: its attempts value fences every later write against a newer claim. */
interface EscalationClaim {
	readonly row: IssueEscalationRow
	readonly attempt: number
}

const decodePolicyRules = Schema.decodeUnknownOption(Schema.Array(IssueEscalationPolicyRule))
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeConfidence = Schema.decodeUnknownOption(EscalationConfidence)

const chatSeverityFor = (severity: IssueSeverity): AlertSeverity =>
	severity === "critical" || severity === "high" ? "critical" : "warning"

interface EscalationTickResult {
	readonly processed: number
	readonly sent: number
	readonly skipped: number
	readonly failed: number
	readonly retried: number
}

export interface EscalationServiceApi {
	readonly runEscalationTick: Effect.Effect<EscalationTickResult, AlertPersistenceError>
}

/*
 * Hoisted out of the class options with an explicit annotation so the
 * `EscalationService.of(...)` return does not create a circular inference
 * through the class's own base expression.
 */
const make: Effect.Effect<EscalationServiceApi, never, Database | NotificationDispatcher | Env> = Effect.gen(
	function* () {
		const database = yield* Database
		const dispatcher = yield* NotificationDispatcher
		const env = yield* Env

		const dbExecute = makeDbExecute(database, "EscalationService", makePersistenceError)

		const loadPolicy = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(IssueEscalationPolicies)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/**
		 * Moves a claimed row, guarded on the claim still holding (attempts) and the status it
		 * expects. False when another claim took the row; nothing is written then.
		 */
		const finalize = (
			claim: EscalationClaim,
			from: Arr.NonEmptyReadonlyArray<EscalationStatus>,
			status: EscalationStatus,
			timestamp: number,
			error?: string,
			deliveryResults?: unknown,
		) =>
			transitionRow({ table: "issue_escalations", id: claim.row.id, from, to: status }, (from) =>
				dbExecute((db) =>
					db.run(
						PG.update(IssueEscalations)
							.set({
								status,
								error: error ?? null,
								...(!(deliveryResults === undefined)
									? { deliveryResultsJson: deliveryResults }
									: undefined),
								// A requeue releases the lease so the next tick can retry at once.
								...(status === "queued" ? { claimedAt: null } : { processedAt: timestamp }),
							})
							.where(($) => [
								$.orgId.eq(claim.row.orgId),
								$.id.eq(claim.row.id),
								$.status.in_(...from),
								$.attempts.eq(claim.attempt),
							])
							.returning("id"),
					),
				),
			).pipe(
				Effect.as(true),
				Effect.catchTag("@maple/backend/TransitionConflictError", (conflict) =>
					Effect.logWarning("Escalation claim lost before finalize").pipe(
						Effect.annotateLogs({ escalationId: claim.row.id, message: conflict.message }),
						Effect.as(false),
					),
				),
			)

		const processOne = Effect.fn("EscalationService.processOne")(function* (
			row: IssueEscalationRow,
			policyCache: Map<OrgId, IssueEscalationPolicyRow | null>,
		) {
			const timestamp = yield* Clock.currentTimeMillis

			// Lease claim: only a queued row with no live lease, at the attempts this tick read. A
			// concurrent tick loses the CAS and skips; an expired lease (a claim that died) is fair game.
			// A claim that died still spent its attempt, so an exhausted row fails instead.
			const exhausted = row.attempts >= MAX_ATTEMPTS
			const claimed = yield* dbExecute((db) =>
				db.run(
					PG.update(IssueEscalations)
						.set(
							exhausted
								? {
										status: "failed",
										error: "max_attempts_exceeded",
										processedAt: timestamp,
									}
								: { attempts: row.attempts + 1, claimedAt: timestamp },
						)
						.where(($) => [
							$.orgId.eq(row.orgId),
							$.id.eq(row.id),
							$.status.eq("queued"),
							$.attempts.eq(row.attempts),
							PG.or($.claimedAt.isNull(), $.claimedAt.lt(timestamp - CLAIM_LEASE_MS)),
						])
						// The returned row is the claim: empty means the CAS lost.
						.returning("id"),
				),
			)
			if (claimed.length === 0) {
				return "contended" as const
			}
			if (exhausted) {
				return "failed" as const
			}
			const claim: EscalationClaim = { row, attempt: row.attempts + 1 }

			let policy = policyCache.get(row.orgId)
			if (policy === undefined) {
				policy = yield* loadPolicy(row.orgId)
				policyCache.set(row.orgId, policy)
			}
			const rules =
				policy == null ? [] : Option.getOrElse(decodePolicyRules(policy.rulesJson), () => [])
			const payload = Option.getOrElse(
				decodeJsonRecord(row.payloadJson),
				(): Record<string, unknown> => ({}),
			)
			const configuredDestinationIds = Arr.flatMap(rules, (rule) => rule.destinationIds)
			const destinationRows =
				configuredDestinationIds.length === 0
					? []
					: yield* dbExecute((db) =>
							db.run(
								PG.from(AlertDestinations)
									.select("id")
									.where(($) => [
										$.orgId.eq(row.orgId),
										$.enabled.eq(true),
										$.id.in_(...configuredDestinationIds),
									]),
							),
						)
			const confidence = Option.getOrUndefined(decodeConfidence(payload.confidence))
			const decision = evaluateEscalationPolicy({
				enabled: policy?.enabled ?? false,
				rules,
				severity: row.severity,
				source: row.source,
				...(!(confidence === undefined) ? { confidence } : undefined),
				enabledDestinationIds: new Set(Arr.map(destinationRows, (destination) => destination.id)),
			})
			yield* Effect.annotateCurrentSpan({
				"maple.escalation.policy_outcome": decision.outcome,
				...(decision.skipReason
					? { "maple.escalation.skip_reason": decision.skipReason }
					: undefined),
				"maple.escalation.destination_count": decision.destinationIds.length,
			})
			if (decision.outcome === "skip") {
				const moved = yield* finalize(claim, ["queued"], "skipped", timestamp, decision.skipReason)
				return moved ? ("skipped" as const) : ("contended" as const)
			}

			const issueRows = yield* dbExecute((db) =>
				db.run(
					PG.from(ErrorIssues)
						.select()
						.where(($) => [$.orgId.eq(row.orgId), $.id.eq(row.issueId)])
						.limit(1),
				),
			)
			const issue = issueRows[0]
			if (issue === undefined) {
				const moved = yield* finalize(claim, ["queued"], "skipped", timestamp, "issue_missing")
				return moved ? ("skipped" as const) : ("contended" as const)
			}

			const sourceRef =
				issue.sourceRefJson == null ? null : Option.getOrNull(decodeJsonRecord(issue.sourceRefJson))

			const linkUrl = `${env.MAPLE_APP_BASE_URL}/errors/issues/${issue.id}`
			const request: NotificationRequest = {
				// Stable across retries (no attempt suffix) so any downstream
				// consumer that dedupes on the key absorbs a re-send.
				deliveryKey: `escalation:${row.id}`,
				ruleId: typeof sourceRef?.ruleId === "string" ? sourceRef.ruleId : issue.id,
				ruleName: issue.exceptionType || "Issue escalation",
				groupKey: null,
				signalType: Option.getOrElse(
					decodeSignalType(sourceRef?.signalType),
					() => "error_rate" as const,
				),
				severity: chatSeverityFor(row.severity),
				comparator: "gt",
				threshold: 0,
				thresholdUpper: null,
				eventType: "trigger",
				incidentId: null,
				incidentStatus: "open",
				dedupeKey: row.dedupeKey,
				windowMinutes: 0,
				value: null,
				sampleCount: null,
				linkUrl,
				escalation: {
					issue: {
						id: issue.id,
						kind: issue.kind,
						title: issue.exceptionType,
						serviceName: issue.serviceName,
						workflowState: issue.workflowState,
						severity: row.severity,
						severitySource: issue.severitySource,
						linkUrl,
					},
					...(payload.triage !== undefined ? { triage: payload.triage } : undefined),
					source: row.source,
					reason: row.reason,
					...(row.investigationId != null
						? {
								investigation: {
									id: row.investigationId,
									url: `${env.MAPLE_APP_BASE_URL}/investigations/${row.investigationId}`,
								},
							}
						: undefined),
					...(row.runId != null ? { runId: row.runId } : undefined),
				},
			}

			// At-most-once: flip to "sent" BEFORE dispatching. With the old
			// dispatch-then-finalize order, a finalize failure after a successful
			// delivery left the row queued and the next tick re-paged everyone.
			// Now the failure window drops the escalation instead; the design
			// explicitly prefers a rare drop over a duplicate page. The row being
			// "sent" also keeps a concurrent tick's claim CAS (status = queued)
			// from picking it up mid-dispatch. A lost lease means another tick owns it: never dispatch.
			const flipped = yield* finalize(claim, ["queued"], "sent", timestamp)
			if (!flipped) {
				return "contended" as const
			}
			const result = yield* dispatcher.dispatch(row.orgId, decision.destinationIds, request)
			yield* finalize(claim, ["sent"], "sent", timestamp, undefined, result.destinations)

			if (result.delivered > 0) {
				return "sent" as const
			}
			if (result.failed === 0) {
				// No enabled destinations matched, nothing to retry.
				yield* finalize(claim, ["sent"], "skipped", timestamp, "no_enabled_destinations")
				return "skipped" as const
			}
			if (claim.attempt >= MAX_ATTEMPTS) {
				yield* finalize(claim, ["sent"], "failed", timestamp, "delivery_failed")
				return "failed" as const
			}
			// Genuine delivery failure (dispatch reported it, nothing was sent):
			// surrender the early "sent" and requeue; next tick retries with the
			// already-bumped attempts counter.
			yield* finalize(claim, ["sent"], "queued", timestamp, "delivery_failed_will_retry")
			return "retried" as const
		})

		const runEscalationTick: EscalationServiceApi["runEscalationTick"] = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(IssueEscalations)
						.select()
						.where(($) => [
							$.status.eq("queued"),
							PG.or($.claimedAt.isNull(), $.claimedAt.lt(now - CLAIM_LEASE_MS)),
						])
						.orderBy(["createdAt", "asc"])
						.limit(ESCALATIONS_PER_TICK),
				),
			)

			const policyCache = new Map<OrgId, IssueEscalationPolicyRow | null>()
			// catchCause isolates defects: a dying processOne is logged and
			// counted as "failed", and the row keeps whatever state it reached:
			// still "queued" and leased before the pre-dispatch sent-flip, so a tick
			// after the lease retries it (up to MAX_ATTEMPTS); "sent" after the flip,
			// so it is never re-delivered (at-most-once). Interruption is re-raised.
			const outcomes = yield* Effect.forEach(rows, (row) =>
				processOne(row, policyCache).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.logError("Escalation processing failed").pipe(
									Effect.annotateLogs({
										escalationId: row.id,
										orgId: row.orgId,
										cause: summarizeCause(cause),
									}),
									Effect.as("failed" as const),
								),
					),
				),
			)
			const count = (outcome: (typeof outcomes)[number]) =>
				Arr.filter(outcomes, (o) => o === outcome).length
			return {
				processed: outcomes.length - count("contended"),
				sent: count("sent"),
				skipped: count("skipped"),
				failed: count("failed"),
				retried: count("retried"),
			}
		}).pipe(Effect.withSpan("EscalationService.runEscalationTick"))

		return EscalationService.of({ runEscalationTick })
	},
)

export class EscalationService extends Context.Service<EscalationService, EscalationServiceApi>()(
	"@maple/backend/services/EscalationService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(NotificationDispatcher.layer))
}
