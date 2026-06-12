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
	IssueEscalationPolicyRule,
	type AlertSeverity,
	type EscalationConfidence,
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
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseClient, DatabaseError } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const ESCALATIONS_PER_TICK = 50
const MAX_ATTEMPTS = 3

const PolicyRulesFromJson = Schema.fromJsonString(Schema.Array(IssueEscalationPolicyRule))
const decodePolicyRules = Schema.decodeUnknownOption(PolicyRulesFromJson)
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)

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

export class EscalationService extends Context.Service<EscalationService, EscalationServiceShape>()(
	"@maple/api/services/EscalationService",
	{
		make: Effect.gen(function* () {
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

				const payload = (() => {
					try {
						const parsed = JSON.parse(row.payloadJson)
						return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
					} catch {
						return {}
					}
				})()

				// minConfidence gates AI escalations only — a human's manual
				// severity change is explicit intent and always routes.
				if (row.source === "ai" && rule.minConfidence !== undefined) {
					const confidence = payload.confidence
					const rank =
						typeof confidence === "string" && confidence in CONFIDENCE_RANK
							? CONFIDENCE_RANK[confidence as EscalationConfidence]
							: 0
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

				const sourceRef = (() => {
					try {
						const parsed = issue.sourceRefJson == null ? null : JSON.parse(issue.sourceRefJson)
						return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
					} catch {
						return null
					}
				})()

				const linkUrl = `${env.MAPLE_APP_BASE_URL}/errors/issues/${issue.id}`
				const request: NotificationRequest = {
					deliveryKey: `escalation:${row.id}:${row.attempts + 1}`,
					ruleId: typeof sourceRef?.ruleId === "string" ? sourceRef.ruleId : issue.id,
					ruleName: issue.exceptionType || "Issue escalation",
					groupKey: null,
					signalType: Option.getOrElse(decodeSignalType(sourceRef?.signalType), () => "error_rate" as const),
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

				const result = yield* dispatcher.dispatch(row.orgId, rule.destinationIds, request)

				if (result.delivered > 0) {
					yield* finalize(row, "sent", timestamp)
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
				// Leave queued; next tick retries (attempts already bumped).
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

				const counts = { processed: 0, sent: 0, skipped: 0, failed: 0, retried: 0 }
				const policyCache = new Map<OrgId, IssueEscalationPolicyRow | null>()
				for (const row of rows) {
					const outcome = yield* processOne(row, policyCache).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Escalation processing failed").pipe(
								Effect.annotateLogs({
									escalationId: row.id,
									orgId: row.orgId,
									cause: String(cause),
								}),
								Effect.as("failed" as const),
							),
						),
					)
					if (outcome === "contended") continue
					counts.processed += 1
					if (outcome === "sent") counts.sent += 1
					else if (outcome === "skipped") counts.skipped += 1
					else if (outcome === "failed") counts.failed += 1
					else if (outcome === "retried") counts.retried += 1
				}
				return counts
			})

			return { runEscalationTick } satisfies EscalationServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
