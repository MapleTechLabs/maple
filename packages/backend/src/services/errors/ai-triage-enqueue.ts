import { randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	type ErrorIssueId,
	InvestigationIncidentSubject,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationSubjectSnapshot,
	type IssueSeverity,
	type OrgId,
} from "@maple/domain/http"
import { InvestigationId, IsoDateTimeString } from "@maple/domain/primitives"
import { aiTriageSettings, investigations } from "@maple/db"
import { and, eq, lt } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"

import { Database } from "@maple/backend/platform/DatabaseLive"

import {
	evaluateInvestigationQuota,
	selectInvestigationUsage,
} from "@maple/backend/services/errors/investigation-quota"
import { startInvestigationTurn } from "@maple/backend/services/errors/investigation-start"
import {
	STALE_MS,
	isInvestigationStale,
	staleTimeoutMessage,
} from "@maple/backend/services/errors/investigation-stale"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

const decodeInvestigationId = Schema.decodeUnknownSync(InvestigationId)

const STALE_INVESTIGATION_MS = 15 * 60 * 1000

const contextString = (context: Record<string, unknown>, key: string): string | undefined => {
	const value = context[key]
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

const contextNumber = (context: Record<string, unknown>, key: string): number | null => {
	const value = context[key]
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * The first of these keys that carries a usable instant, as an ISO string.
 *
 * Several keys because each incident kind names its own window differently and
 * none of them was reaching the snapshot: the interval was hardcoded `null` while
 * every prompt opened with "establish the exact incident interval from the
 * attached subject". The `Date` branch is load-bearing, not defensive — the error
 * path passes `firstSeen`/`lastSeen` as `Date` objects, and a string-only reader
 * would have silently kept the old `null`.
 *
 * Every branch normalizes through `Date` before encoding, so a producer that
 * passes an already-ISO string still gets a value the branded schema accepts
 * rather than one that merely looks like it.
 */
const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

const contextInstant = (
	context: Record<string, unknown>,
	...keys: ReadonlyArray<string>
): IsoDateTimeString | null => {
	for (const key of keys) {
		const value = context[key]
		const instant =
			value instanceof Date
				? value
				: typeof value === "number" && Number.isFinite(value)
					? new Date(value)
					: typeof value === "string" && value.trim().length > 0
						? new Date(value)
						: null
		if (instant !== null && !Number.isNaN(instant.getTime())) {
			return decodeIso(instant.toISOString())
		}
	}
	return null
}

const snapshotFor = (input: MaybeEnqueueTriageInput): InstanceType<typeof InvestigationSubjectSnapshot> => {
	const serviceName = contextString(input.context, "serviceName")
	const kindWord = `${input.incidentKind[0]?.toUpperCase() ?? ""}${input.incidentKind.slice(1)}`
	// The last resort is what the investigations list renders as a title, so it
	// names the service when there is one — "Alert incident" says nothing the
	// list's kind marker doesn't already say. (`reason` is deliberately not in
	// this chain: it's an enum token like `first_seen`, not a sentence.)
	// `exceptionType: message` beats either alone: the type is what an engineer
	// recognizes, the message is what distinguishes two of the same type. Falling
	// through to `errorLabel` before `signalType` matters for the exact class of
	// error that reads worst — a status-message-only error has no exception type,
	// and its label is the only human-readable thing about it.
	const exceptionHeadline = (() => {
		const type = contextString(input.context, "exceptionType")
		const message = contextString(input.context, "exceptionMessage")
		if (type && message) return `${type}: ${message}`
		return type ?? message
	})()
	const title =
		contextString(input.context, "title") ??
		contextString(input.context, "ruleName") ??
		exceptionHeadline ??
		contextString(input.context, "errorLabel") ??
		contextString(input.context, "signalType") ??
		(serviceName ? `${kindWord} on ${serviceName}` : `${kindWord} incident`)
	const severityValue = Schema.decodeUnknownOption(Schema.Literals(["critical", "high", "medium", "low"]))(
		input.context.severity,
	)
	const severity: IssueSeverity | null = severityValue._tag === "Some" ? severityValue.value : null
	const fingerprintHash = contextString(input.context, "fingerprintHash") ?? null
	const exceptionType = contextString(input.context, "exceptionType") ?? null
	const exceptionMessage = contextString(input.context, "exceptionMessage") ?? null
	const topFrame = contextString(input.context, "topFrame") ?? null
	const occurrenceCount = contextNumber(input.context, "occurrenceCount")

	// Display facts. The identifier fields below are the same values again, but the
	// two lists are for different readers — this one renders on the investigation
	// page, that one is what the agent calls tools with — so they are built from one
	// source rather than allowed to drift.
	const factKeys = [
		["Incident", input.incidentId],
		["Service", serviceName],
		["Signal", contextString(input.context, "signalType")],
		["Reason", contextString(input.context, "reason")],
		["Exception", exceptionType],
		["Top frame", topFrame],
		["Fingerprint", fingerprintHash],
		["Occurrences", occurrenceCount === null ? undefined : String(occurrenceCount)],
	] as const

	return new InvestigationSubjectSnapshot({
		title,
		scope: serviceName ?? null,
		status: "open",
		severity,
		facts: factKeys.flatMap(([label, value]) =>
			value ? [new InvestigationSnapshotFact({ label, value })] : [],
		),
		references: input.issueId
			? [
					new InvestigationSnapshotReference({
						label: "Issue",
						url: `/errors/issues/${input.issueId}`,
					}),
				]
			: [],
		// Both were hardcoded `null` while every producer already knew the answer.
		incidentStartedAt: contextInstant(
			input.context,
			"firstSeen",
			"firstTriggeredAt",
			"windowStart",
			"detectedAt",
		),
		incidentEndedAt: contextInstant(input.context, "lastSeen", "lastTriggeredAt"),
		fingerprintHash,
		exceptionType,
		exceptionMessage,
		topFrame,
		errorLabel: contextString(input.context, "errorLabel") ?? null,
		occurrenceCount,
		serviceName: serviceName ?? null,
		deploymentEnv: contextString(input.context, "deploymentEnv") ?? null,
		signalType: contextString(input.context, "signalType") ?? null,
		observedValue: contextNumber(input.context, "observedValue"),
		thresholdValue: contextNumber(input.context, "thresholdValue"),
	})
}

export interface MaybeEnqueueTriageInput {
	readonly orgId: OrgId
	readonly incidentKind: AiTriageIncidentKind
	readonly incidentId: string
	readonly issueId?: ErrorIssueId
	readonly context: Record<string, unknown>
	/** The Worker env, for the `ChatSession` binding. Absent means the row records why it could not run. */
	readonly workerEnv?: Record<string, unknown>
	/** Manual starts ignore the automation-enabled flag, but never the quota. */
	readonly force?: boolean
}

export interface MaybeEnqueueTriageResult {
	readonly enqueued: boolean
	readonly investigationId?: InvestigationId
	readonly reason?: "disabled" | "daily_cap" | "duplicate" | "no_binding" | "rejected" | "error"
}

/**
 * Create and seed one durable investigation for a newly opened incident.
 *
 * Producers retain a non-failing "maybe enqueue" contract: investigation
 * failures must never take down the detector or alert tick that discovered the
 * incident.
 */
export const maybeEnqueueTriage: (
	input: MaybeEnqueueTriageInput,
) => Effect.Effect<MaybeEnqueueTriageResult, never, Database> = Effect.fn("maybeStartInvestigation")(
	function* (input) {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis

		const existingRows = yield* database.execute((db) =>
			db
				.select()
				.from(investigations)
				.where(
					and(
						eq(investigations.orgId, input.orgId),
						eq(investigations.incidentKind, input.incidentKind),
						eq(investigations.incidentId, input.incidentId),
					),
				)
				.limit(1),
		)
		const existing = existingRows[0]
		if (existing) {
			if (isInvestigationStale(existing, nowMs)) {
				const budget = STALE_MS
				yield* database.execute((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							error: staleTimeoutMessage(budget),
							updatedAt: new Date(nowMs),
						})
						.where(
							and(
								eq(investigations.orgId, input.orgId),
								eq(investigations.id, existing.id),
								lt(investigations.startedAt, new Date(nowMs - budget)),
							),
						),
				)
			}
			return { enqueued: false, investigationId: existing.id, reason: "duplicate" as const }
		}

		const settingsRows = yield* database.execute((db) =>
			db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, input.orgId)).limit(1),
		)
		const settings = settingsRows[0]
		if (!input.force && (settings === undefined || !settings.enabled)) {
			return { enqueued: false, reason: "disabled" as const }
		}

		const snapshot = snapshotFor(input)

		// One agent, one pass. Shared with `InvestigationService` so the two ceilings
		// are judged the same way on both paths.
		const usage = yield* database.execute((db) => selectInvestigationUsage(db, input.orgId, nowMs))
		const verdict = evaluateInvestigationQuota({
			usage,
			limits: settings,
			passCount: 1,
			nowMs,
			// Severity decides which ceiling applies, in both units, so that a burst of
			// `low` incidents just after UTC midnight cannot spend the slice a
			// `critical` opening at noon needs.
			severity: snapshot.severity,
		})
		if (verdict.kind === "exceeded") {
			yield* Effect.logWarning("Investigation daily budget reached; skipping autonomous start").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					quotaDimension: verdict.dimension,
					quotaLimit: verdict.limit,
					// Without this the log says a start was refused but not what was
					// refused. "runs, 100" read the same for a `low` anomaly and for the
					// `critical` the reserve exists to protect, so there was no way to tell
					// a working ceiling from one that had just turned away the day's only
					// real incident.
					severity: snapshot.severity ?? "unclassified",
				}),
			)
			// A refused start has to be visible as a *refusal*. `start_result` used to
			// be set only on the success path, so a budget-exhausted org looked
			// identical in traces to one with nothing to investigate — which is how
			// this went unnoticed for two weeks.
			yield* Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.start_result": "quota_exceeded",
				"maple.investigation.quota_dimension": verdict.dimension,
				"maple.investigation.quota_limit": verdict.limit,
				"maple.investigation.severity": snapshot.severity ?? "unclassified",
			})
			return { enqueued: false, reason: "daily_cap" as const }
		}

		const investigationId = decodeInvestigationId(randomUUID())
		const subject = new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: input.incidentKind,
			incidentId: input.incidentId,
			...(input.issueId ? { issueId: input.issueId } : undefined),
		})
		const inserted = yield* database.execute((db) =>
			db
				.insert(investigations)
				.values({
					id: investigationId,
					orgId: input.orgId,
					status: "investigating",
					seededBy: "system",
					subjectJson: subject,
					snapshotJson: snapshot,
					incidentKind: input.incidentKind,
					incidentId: input.incidentId,
					issueId: input.issueId ?? null,
					startedAt: new Date(nowMs),
					autonomousTurns: 1,
					createdAt: new Date(nowMs),
					updatedAt: new Date(nowMs),
				})
				.onConflictDoNothing()
				.returning({ id: investigations.id }),
		)
		if (inserted.length === 0) {
			return { enqueued: false, reason: "duplicate" as const }
		}

		const started = yield* startInvestigationTurn({
			orgId: input.orgId,
			investigationId,
			subject,
			snapshot,
			workerEnv: input.workerEnv,
			nowMs,
		})
		if (!started.started) {
			return {
				enqueued: false,
				investigationId,
				reason: started.reason === "no_binding" ? ("no_binding" as const) : ("error" as const),
			}
		}
		return { enqueued: true, investigationId }
	},
	(effect, input) =>
		Effect.catchCause(effect, (cause) =>
			Effect.logError("Investigation enqueue failed").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentKind: input.incidentKind,
					incidentId: input.incidentId,
					error: summarizeCause(cause),
				}),
				Effect.as({ enqueued: false, reason: "error" as const }),
			),
		),
)
