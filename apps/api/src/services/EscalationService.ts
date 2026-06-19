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
	AlertSignalType,
	EscalationConfidence,
	IssueEscalationPolicyRule,
	type AlertSeverity,
	type IssueSeverity,
	type OrgId,
} from "@maple/domain/http"
import {
	errorIssues,
	issueEscalationPolicies,
	issueEscalations,
	type IssueEscalationPolicyRow,
	type IssueEscalationRow,
} from "@maple/db"
import { and, asc, eq } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseClient, DatabaseError } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const ESCALATIONS_PER_TICK = 50
const MAX_ATTEMPTS = 3

const PolicyRulesFromJson = Schema.fromJsonString(Schema.Array(IssueEscalationPolicyRule))
const decodePolicyRules = Schema.decodeUnknownOption(PolicyRulesFromJson)
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)
const JsonRecordFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecord = Schema.decodeUnknownOption(JsonRecordFromString)
const decodeConfidence = Schema.decodeUnknownOption(EscalationConfidence)

const CONFIDENCE_RANK: Record<EscalationConfidence, number> = { low: 1, medium: 2, high: 3 }

const chatSeverityFor = (severity: IssueSeverity): AlertSeverity =>
	severity === "critical" || severity === "high" ? "critical" : "warning"

export interface EscalationTickResult {
	readonly processed: number
	readonly sent: number
	readonly skipped: number
	readonly failed: number
	readonly retried: number
}

export interface EscalationServiceShape {
	readonly runEscalationTick: () => Effect.Effect<EscalationTickResult, DatabaseError>
}

/*
 * Hoisted out of the class options with an explicit annotation so the
 * `EscalationService.of(...)` return does not create a circular inference
 * through the class's own base expression.
 */
const make: Effect.Effect<EscalationServiceShape, never, Database | NotificationDispatcher | Env> =
	Effect.gen(function* () {
		const database = yield* Database
		const dispatcher = yield* NotificationDispatcher
		const env = yield* Env

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) => database.execute(fn)

		const loadPolicy = (orgId: OrgId) =>
			dbExecute((db) =>
				db
					.select()
					.from(issueEscalationPolicies)
					.where(eq(issueEscalationPolicies.orgId, orgId))
					.limit(1),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const finalize = (
			row: IssueEscalationRow,
			status: "sent" | "skipped" | "failed" | "queued",
			timestamp: number,
			error?: string,
		) =>
			dbExecute((db) =>
				db
					.update(issueEscalations)
					.set({
						status,
						error: error ?? null,
						...(status === "queued" ? {} : { processedAt: timestamp }),
					})
					.where(eq(issueEscalations.id, row.id)),
			)

		const processOne = Effect.fn("EscalationService.processOne")(function* (
			row: IssueEscalationRow,
			policyCache: Map<OrgId, IssueEscalationPolicyRow | null>,
		) {
			const timestamp = yield* Clock.currentTimeMillis

			// Optimistic claim: bump attempts iff nobody else already has. A
			// concurrent tick loses the CAS and skips the row.
			const claimed = yield* dbExecute((db) =>
				db
					.update(issueEscalations)
					.set({ attempts: row.attempts + 1 })
					.where(
						and(
							eq(issueEscalations.id, row.id),
							eq(issueEscalations.status, "queued"),
							eq(issueEscalations.attempts, row.attempts),
						),
					),
			)
			if (((claimed as { rowsAffected?: number }).rowsAffected ?? 0) === 0) {
				return "contended" as const
			}

			let policy = policyCache.get(row.orgId)
			if (policy === undefined) {
				policy = yield* loadPolicy(row.orgId)
				policyCache.set(row.orgId, policy)
			}
			if (policy == null || policy.enabled !== 1) {
				yield* finalize(row, "skipped", timestamp, "policy_disabled")
				return "skipped" as const
			}

			const rules = Option.getOrElse(decodePolicyRules(policy.rulesJson), () => [])
			const rule = rules.find((r) => r.severity === row.severity)
			if (rule === undefined || rule.destinationIds.length === 0) {
				yield* finalize(row, "skipped", timestamp, "no_destinations_for_severity")
				return "skipped" as const
			}

			const payload = Option.getOrElse(
				decodeJsonRecord(row.payloadJson),
				(): Record<string, unknown> => ({}),
			)

			// minConfidence gates AI escalations only — a human's manual
			// severity change is explicit intent and always routes.
			if (row.source === "ai" && rule.minConfidence !== undefined) {
				const rank = Option.match(decodeConfidence(payload.confidence), {
					onNone: () => 0,
					onSome: (confidence) => CONFIDENCE_RANK[confidence],
				})
				if (rank < CONFIDENCE_RANK[rule.minConfidence]) {
					yield* finalize(row, "skipped", timestamp, "below_min_confidence")
					return "skipped" as const
				}
			}

			const issueRows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, row.orgId), eq(errorIssues.id, row.issueId)))
					.limit(1),
			)
			const issue = issueRows[0]
			if (!issue) {
				yield* finalize(row, "skipped", timestamp, "issue_missing")
				return "skipped" as const
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
					...(payload.triage !== undefined ? { triage: payload.triage } : {}),
					source: row.source,
					reason: row.reason,
					...(row.runId != null ? { runId: row.runId } : {}),
				},
			}

			// At-most-once: flip to "sent" BEFORE dispatching. With the old
			// dispatch-then-finalize order, a finalize failure after a successful
			// delivery left the row queued and the next tick re-paged everyone.
			// Now the failure window drops the escalation instead — the design
			// explicitly prefers a rare drop over a duplicate page. The row being
			// "sent" also keeps a concurrent tick's claim CAS (status = queued)
			// from picking it up mid-dispatch.
			yield* finalize(row, "sent", timestamp)
			const result = yield* dispatcher.dispatch(row.orgId, rule.destinationIds, request)

			if (result.delivered > 0) {
				return "sent" as const
			}
			if (result.failed === 0) {
				// No enabled destinations matched — nothing to retry.
				yield* finalize(row, "skipped", timestamp, "no_enabled_destinations")
				return "skipped" as const
			}
			if (row.attempts + 1 >= MAX_ATTEMPTS) {
				yield* finalize(row, "failed", timestamp, "delivery_failed")
				return "failed" as const
			}
			// Genuine delivery failure (dispatch reported it, nothing was sent):
			// surrender the early "sent" and requeue; next tick retries with the
			// already-bumped attempts counter.
			yield* finalize(row, "queued", timestamp, "delivery_failed_will_retry")
			return "retried" as const
		})

		const runEscalationTick: EscalationServiceShape["runEscalationTick"] = Effect.fn(
			"EscalationService.runEscalationTick",
		)(function* () {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(issueEscalations)
					.where(eq(issueEscalations.status, "queued"))
					.orderBy(asc(issueEscalations.createdAt))
					.limit(ESCALATIONS_PER_TICK),
			)

			const policyCache = new Map<OrgId, IssueEscalationPolicyRow | null>()
			// catchCause swallows defects too: a dying processOne is logged and
			// counted as "failed", and the row keeps whatever state it reached —
			// still "queued" (attempts bumped) before the pre-dispatch sent-flip,
			// so the next tick retries it; "sent" after the flip, so it is never
			// re-delivered (at-most-once).
			const outcomes = yield* Effect.forEach(rows, (row) =>
				processOne(row, policyCache).pipe(
					Effect.catchCause((cause) =>
						Effect.logError("Escalation processing failed").pipe(
							Effect.annotateLogs({
								escalationId: row.id,
								orgId: row.orgId,
								cause: Cause.pretty(cause),
							}),
							Effect.as("failed" as const),
						),
					),
				),
			)
			const count = (outcome: (typeof outcomes)[number]) => outcomes.filter((o) => o === outcome).length
			return {
				processed: outcomes.length - count("contended"),
				sent: count("sent"),
				skipped: count("skipped"),
				failed: count("failed"),
				retried: count("retried"),
			}
		})

		return EscalationService.of({ runEscalationTick })
	})

export class EscalationService extends Context.Service<EscalationService, EscalationServiceShape>()(
	"@maple/api/services/EscalationService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
