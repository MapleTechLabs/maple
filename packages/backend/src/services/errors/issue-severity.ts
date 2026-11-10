/**
 * Severity helpers used by investigation diagnosis persistence, run on the caller's database.
 * Every write is idempotent: deterministic runId-derived ids plus
 * onConflictDoNothing, or guarded UPDATEs.
 */
import { createHash } from "node:crypto"
import type { AiTriageResult, IssueSeverity } from "@maple/domain/http"
import {
	ActorId,
	ErrorIssueEventId,
	ErrorIssueId,
	type InvestigationId,
	IssueEscalationId,
	OrgId,
} from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { Actors, ErrorIssueEvents, ErrorIssues, IssueEscalations } from "@maple/db/tables"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { TRIAGE_AGENT_NAME } from "@maple/domain/system-agents"
import { currentTxid } from "@maple/backend/platform/electric-txid"
import { ensureAgentActorRow } from "./agent-actor-row"

/**
 * effect-orm over the caller's client; inside `orm.transaction` the writes join
 * it, so callers can run the severity write atomically alongside their own.
 */
export type TriageSeverityDb = MapleDb

/**
 * The triage-agent actor row was neither found nor insertable. Only reachable
 * if the row is deleted between the guarded insert and the re-read.
 */
export class TriageActorMissingError extends Schema.TaggedError<TriageActorMissingError>()(
	"@maple/backend/services/TriageActorMissingError",
	{ message: Schema.String, orgId: OrgId },
) {}

const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const decodeEscalationId = Schema.decodeUnknownSync(IssueEscalationId)

const SEVERITY_RANK: Record<IssueSeverity, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
} satisfies Record<IssueSeverity, number>

export const severityRank = (severity: IssueSeverity | null): number =>
	severity === null ? 0 : SEVERITY_RANK[severity]

/** At-most-once per issue+level (unique index on the escalation outbox). */
export const escalationDedupeKey = (orgId: string, issueId: string, severity: IssueSeverity) =>
	`esc:${orgId}:${issueId}:${severity}`

/**
 * UUIDv5-style id derived from a seed so retried writers regenerate the SAME
 * id and the primary key (+ onConflictDoNothing) absorbs the duplicate.
 */
const deterministicUuid = (seed: string): string => {
	const hex = createHash("sha256").update(seed).digest("hex")
	return Arr.join(
		[
			Str.slice(0, 8)(hex),
			Str.slice(8, 12)(hex),
			`5${Str.slice(13, 16)(hex)}`,
			`${((Number.parseInt(Str.slice(16, 17)(hex), 16) & 0x3) | 0x8).toString(16)}${Str.slice(17, 20)(hex)}`,
			Str.slice(20, 32)(hex),
		],
		"-",
	)
}

/**
 * Upward-only escalation rule: a severity routes to destinations only when it
 * is newly set or strictly escalates. Downgrades and same-level confirmations
 * route nothing (detection-time noise is already covered by alert rule
 * destinations and the error notification policy).
 */
export const escalationReasonFor = (
	from: IssueSeverity | null,
	to: IssueSeverity,
): "severity_set" | "severity_escalated" | null => {
	if (from === null) return "severity_set"
	return severityRank(to) > severityRank(from) ? "severity_escalated" : null
}

export interface IssueSeverityWrite {
	readonly orgId: OrgId
	readonly issueId: ErrorIssueId
	readonly actorId: ActorId
	/** The severity the change was decided from: it decides the timeline event and the escalation. */
	readonly from: IssueSeverity | null
	/** `null` clears the severity, which never escalates. */
	readonly severity: IssueSeverity | null
	readonly source: "ai" | "manual"
	readonly timestamp: number
	readonly eventId: ErrorIssueEventId
	readonly eventPayload: Record<string, unknown>
	readonly escalation: {
		readonly id: IssueEscalationId
		readonly runId: string | null
		readonly investigationId: InvestigationId | null
		readonly payload: Record<string, unknown>
	}
}

/**
 * The one severity write: the guarded UPDATE (an `ai` write never lands over a manual one), the
 * `severity_change` event when the value moved, and the escalation-outbox row when it newly sets
 * or strictly escalates. Returns the UPDATE's txid rows; empty means a concurrent manual write won.
 */
export const writeIssueSeverity = (
	db: TriageSeverityDb,
	write: IssueSeverityWrite,
): Effect.Effect<ReadonlyArray<{ readonly txid: string }>, MapleDbError> =>
	Effect.gen(function* () {
		const { orgId, issueId, severity, from, timestamp } = write
		const rows = yield* db.run(
			PG.update(ErrorIssues)
				.set({
					severity,
					severitySource: severity === null ? null : write.source,
					updatedAt: timestamp,
				})
				.where(($) => [
					$.orgId.eq(orgId),
					$.id.eq(issueId),
					// Repeated in SQL so a manual write between the caller's read and this one still wins.
					write.source === "ai"
						? PG.or($.severitySource.isNull(), $.severitySource.neq("manual"))
						: undefined,
				])
				.returning(() => ({ txid: currentTxid })),
		)
		if (rows.length === 0) return rows
		if (from !== severity) {
			yield* db.run(
				PG.insertInto(ErrorIssueEvents)
					.values({
						id: write.eventId,
						orgId,
						issueId,
						actorId: write.actorId,
						type: "severity_change",
						fromState: null,
						toState: null,
						payloadJson: write.eventPayload,
						createdAt: timestamp,
					})
					.onConflictDoNothing(),
			)
		}
		const reason = severity === null ? null : escalationReasonFor(from, severity)
		if (severity !== null && reason !== null) {
			yield* db.run(
				PG.insertInto(IssueEscalations)
					.values({
						id: write.escalation.id,
						orgId,
						issueId,
						severity,
						source: write.source,
						reason,
						runId: write.escalation.runId,
						investigationId: write.escalation.investigationId,
						payloadJson: write.escalation.payload,
						deliveryResultsJson: [],
						status: "queued",
						attempts: 0,
						dedupeKey: escalationDedupeKey(orgId, issueId, severity),
						error: null,
						createdAt: timestamp,
						processedAt: null,
					})
					.onConflictDoNothing(),
			)
		}
		return rows
	})

const ensureTriageAgentActor = (
	db: TriageSeverityDb,
	orgId: OrgId,
	timestamp: number,
): Effect.Effect<ActorId, MapleDbError | TriageActorMissingError> =>
	Effect.gen(function* () {
		const row = yield* ensureAgentActorRow(db, orgId, TRIAGE_AGENT_NAME, {
			capabilities: ["auto-triage"],
			createdBy: null,
			timestamp,
		})
		if (Option.isNone(row)) {
			return yield* new TriageActorMissingError({
				message: "Failed to ensure maple-triage-agent actor row",
				orgId,
			})
		}
		return row.value.id
	})

export interface ApplyTriageSeverityInput {
	readonly orgId: OrgId
	readonly issueId: ErrorIssueId
	readonly runId: string
	/** Durable investigation id; omitted by the short-lived legacy workflow. */
	readonly investigationId?: InvestigationId
	/**
	 * Undefined when the report carried no assessment. The issue is left at the
	 * severity it already had — see the early return below.
	 */
	readonly severity: IssueSeverity | undefined
	readonly confidence: AiTriageResult["confidence"]
	readonly timestamp: number
	/** Full triage result; snapshotted into the escalation payload. */
	readonly result?: AiTriageResult
}

export interface ApplyTriageSeverityOutcome {
	readonly applied: boolean
	readonly actorId: ActorId | null
}

/**
 * Apply an AI triage severity assessment to an issue: guarded severity write
 * (manual override always wins), `severity_change` timeline event, and an
 * escalation-outbox row when the severity newly sets or strictly escalates.
 */
export const applyTriageSeverity = (
	db: TriageSeverityDb,
	input: ApplyTriageSeverityInput,
): Effect.Effect<ApplyTriageSeverityOutcome, MapleDbError | TriageActorMissingError> =>
	Effect.gen(function* () {
		const issueRows = yield* db.run(
			PG.from(ErrorIssues)
				.select()
				.where(($) => [$.orgId.eq(input.orgId), $.id.eq(input.issueId)])
				.limit(1),
		)
		const issue = issueRows[0]
		if (issue === undefined) return { applied: false, actorId: null }

		const actorId = yield* ensureTriageAgentActor(db, input.orgId, input.timestamp)

		// No assessment, no re-rank: a report that did not judge the severity must not
		// overwrite one that was. The actor is still returned so the caller can record
		// that triage ran on the issue's timeline.
		const severity = input.severity
		if (severity === undefined) return { applied: false, actorId }

		const from = issue.severity ?? null

		if (issue.severitySource === "manual") {
			return { applied: false, actorId }
		}

		// Deterministic ids, so a retried diagnosis writes its event and escalation once.
		const updated = yield* writeIssueSeverity(db, {
			orgId: input.orgId,
			issueId: input.issueId,
			actorId,
			from,
			severity,
			source: "ai",
			timestamp: input.timestamp,
			eventId: decodeEventId(deterministicUuid(`ai-triage-severity:${input.runId}`)),
			eventPayload: {
				from,
				to: severity,
				source: "ai",
				runId: input.runId,
				confidence: input.confidence,
			},
			escalation: {
				id: decodeEscalationId(deterministicUuid(`ai-triage-escalation:${input.runId}`)),
				runId: input.runId,
				investigationId: input.investigationId ?? null,
				payload: {
					confidence: input.confidence,
					...(input.result ? { triage: input.result } : undefined),
				},
			},
		})
		if (updated.length === 0) {
			return { applied: false, actorId }
		}

		yield* db.run(
			PG.update(Actors)
				.set({ lastActiveAt: input.timestamp })
				.where(($) => [$.id.eq(actorId)]),
		)

		return { applied: true, actorId }
	})

export interface ApplyClassifierSeverityInput {
	readonly orgId: OrgId
	readonly issueId: ErrorIssueId
	/** The incident the verdict was about; keys the timeline event so a retried tick writes it once. */
	readonly incidentId: string
	readonly severity: IssueSeverity
	/** The model's probability for the severity it chose. */
	readonly confidence: number
	readonly timestamp: number
}

/** The three-step confidence the timeline already renders, from a probability. */
const confidenceLabel = (probability: number): AiTriageResult["confidence"] =>
	probability >= 0.8 ? "high" : probability >= 0.5 ? "medium" : "low"

/**
 * A severity the classifier set on an incident that was NOT investigated.
 *
 * Only an untriaged issue takes it, and it never escalates. The point of a skip
 * is that nobody needs to look, so nothing on this path may page anyone; and
 * an issue the detector, a report or a person already ranked keeps its ranking
 * — the classifier read a summary, they read the signal.
 */
export const applyClassifierSeverity = (
	db: TriageSeverityDb,
	input: ApplyClassifierSeverityInput,
): Effect.Effect<{ readonly applied: boolean }, MapleDbError | TriageActorMissingError> =>
	Effect.gen(function* () {
		const updated = yield* db.run(
			PG.update(ErrorIssues)
				.set({ severity: input.severity, severitySource: "ai", updatedAt: input.timestamp })
				.where(($) => [$.orgId.eq(input.orgId), $.id.eq(input.issueId), $.severity.isNull()])
				.returning("id"),
		)
		if (updated.length === 0) return { applied: false }

		const actorId = yield* ensureTriageAgentActor(db, input.orgId, input.timestamp)
		yield* db.run(
			PG.insertInto(ErrorIssueEvents)
				.values({
					id: decodeEventId(deterministicUuid(`classifier-severity:${input.incidentId}`)),
					orgId: input.orgId,
					issueId: input.issueId,
					actorId,
					type: "severity_change",
					fromState: null,
					toState: null,
					payloadJson: {
						from: null,
						to: input.severity,
						source: "ai",
						runId: input.incidentId,
						confidence: confidenceLabel(input.confidence),
					},
					createdAt: input.timestamp,
				})
				.onConflictDoNothing(),
		)
		return { applied: true }
	})
