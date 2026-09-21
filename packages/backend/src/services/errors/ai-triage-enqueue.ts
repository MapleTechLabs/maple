import { randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	type ErrorIssueId,
	IncidentTriagePriorDiagnosis,
	IncidentTriageRequest,
	type IncidentTriageVerdict,
	InvestigationIncidentSubject,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationSubjectSnapshot,
	type IssueSeverity,
	type OrgId,
	PRIOR_DIAGNOSES_LIMIT,
} from "@maple/domain/http"
import { InvestigationId, IsoDateTimeString } from "@maple/domain/primitives"
import { aiTriageSettings, errorIssues, investigations } from "@maple/db"
import type { MapleDbLike } from "@maple/db/client"
import { and, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@maple/backend/platform/DatabaseLive"
import { dateToMs } from "@maple/backend/platform/time"

import { IncidentClassifier } from "@maple/backend/services/errors/IncidentClassifier"
import {
	evaluateIncidentGate,
	evaluateIssueGate,
	type LatestIssueInvestigation,
	REINVESTIGATE_AFTER_MS,
} from "@maple/backend/services/errors/investigation-gate"
import {
	evaluateInvestigationQuota,
	selectInvestigationUsage,
} from "@maple/backend/services/errors/investigation-quota"
import { applyClassifierSeverity } from "@maple/backend/services/errors/issue-severity"
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
	/** Manual starts ignore the automation-enabled flag and the gates, but never the quota. */
	readonly force?: boolean
}

/**
 * The gates' refusals. Distinct from the operational reasons below because
 * each is a decision, not a failure: the incident was seen and judged not to
 * need a run, and a producer may want to record that (the anomaly path does).
 */
export type MaybeEnqueueTriageSkipReason =
	| "issue_handled"
	| "investigation_in_flight"
	| "recently_diagnosed"
	| "noise"
	| "covered_by_prior"

const SKIP_REASONS: ReadonlySet<string> = new Set<MaybeEnqueueTriageSkipReason>([
	"issue_handled",
	"investigation_in_flight",
	"recently_diagnosed",
	"noise",
	"covered_by_prior",
])

export const isTriageSkipReason = (reason: string | undefined): reason is MaybeEnqueueTriageSkipReason =>
	reason !== undefined && SKIP_REASONS.has(reason)

export interface MaybeEnqueueTriageResult {
	readonly enqueued: boolean
	readonly investigationId?: InvestigationId
	readonly reason?:
		| "disabled"
		| "daily_cap"
		| "duplicate"
		| "no_binding"
		| "rejected"
		| "error"
		| MaybeEnqueueTriageSkipReason
	/** For a skip that defers to an existing run: which one. */
	readonly priorInvestigationId?: InvestigationId
}

/**
 * Diagnoses on file for the same service, newest first, for the classifier to
 * recognise a flare-up of a known cause under a new fingerprint. The incident's
 * own issue is excluded: its history is the issue gate's business, judged
 * without a model.
 */
const selectPriorDiagnoses = (
	db: MapleDbLike,
	orgId: OrgId,
	serviceName: string,
	issueId: ErrorIssueId | null,
	sinceMs: number,
) =>
	Effect.map(
		db
			.select({
				id: investigations.id,
				reportJson: investigations.reportJson,
				snapshotJson: investigations.snapshotJson,
			})
			.from(investigations)
			.where(
				and(
					eq(investigations.orgId, orgId),
					eq(investigations.status, "diagnosed"),
					gte(investigations.createdAt, new Date(sinceMs)),
					sql`${investigations.snapshotJson}->>'serviceName' = ${serviceName}`,
					issueId === null
						? undefined
						: or(isNull(investigations.issueId), ne(investigations.issueId, issueId)),
				),
			)
			.orderBy(desc(investigations.createdAt))
			.limit(PRIOR_DIAGNOSES_LIMIT),
		(rows) =>
			rows.flatMap((row) => {
				const headline = row.reportJson?.headline ?? row.reportJson?.summary
				if (headline === undefined || headline.trim().length === 0) return []
				return [
					new IncidentTriagePriorDiagnosis({
						investigationId: row.id,
						headline,
						exceptionType: row.snapshotJson?.exceptionType ?? null,
					}),
				]
			}),
	)

const triageRequestFor = (
	input: MaybeEnqueueTriageInput,
	snapshot: InvestigationSubjectSnapshot,
	reason: string | null,
	priorDiagnoses: ReadonlyArray<IncidentTriagePriorDiagnosis>,
): IncidentTriageRequest =>
	new IncidentTriageRequest({
		title: snapshot.title,
		incidentKind: input.incidentKind,
		reason,
		detectorSeverity: snapshot.severity,
		serviceName: snapshot.serviceName ?? null,
		deploymentEnv: snapshot.deploymentEnv ?? null,
		exceptionType: snapshot.exceptionType ?? null,
		exceptionMessage: snapshot.exceptionMessage ?? null,
		topFrame: snapshot.topFrame ?? null,
		occurrenceCount: snapshot.occurrenceCount ?? null,
		signalType: snapshot.signalType ?? null,
		observedValue: snapshot.observedValue ?? null,
		thresholdValue: snapshot.thresholdValue ?? null,
		priorDiagnoses,
	})

/** The verdict as span attributes, on every start and skip, so the gate can be measured in prod. */
const verdictAttributes = (verdict: IncidentTriageVerdict | null): Record<string, string | number> =>
	verdict === null
		? {}
		: {
				"maple.triage.disposition": verdict.disposition,
				"maple.triage.disposition_confidence": verdict.dispositionConfidence,
				"maple.triage.severity": verdict.severity,
				"maple.triage.user_impact": verdict.userImpact,
				"maple.triage.model": verdict.model,
				...(verdict.matchedPrior
					? { "maple.triage.prior_match_probability": verdict.matchedPrior.probability }
					: undefined),
			}

/**
 * A refused start has to be visible as a refusal, the same way a quota
 * refusal is: on the span, under `start_result`, so a gate that skips too much
 * reads as a gate rather than as an org with nothing to investigate.
 */
const recordSkip = (
	input: MaybeEnqueueTriageInput,
	reason: MaybeEnqueueTriageSkipReason,
	details: {
		readonly priorInvestigationId: InvestigationId | null
		readonly severity: IssueSeverity | null
		readonly verdict: IncidentTriageVerdict | null
	},
) =>
	Effect.logInfo("Investigation skipped by the gate").pipe(
		Effect.annotateLogs({
			orgId: input.orgId,
			incidentKind: input.incidentKind,
			incidentId: input.incidentId,
			issueId: input.issueId ?? "(none)",
			skipReason: reason,
			priorInvestigationId: details.priorInvestigationId ?? "(none)",
			severity: details.severity ?? "unclassified",
		}),
		Effect.andThen(
			Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.start_result": reason,
				"maple.investigation.severity": details.severity ?? "unclassified",
				...(details.priorInvestigationId
					? { "maple.investigation.prior_id": details.priorInvestigationId }
					: undefined),
				...verdictAttributes(details.verdict),
			}),
		),
	)

/**
 * Create and seed one durable investigation for a newly opened incident.
 *
 * Producers retain a non-failing "maybe enqueue" contract: investigation
 * failures must never take down the detector or alert tick that discovered the
 * incident.
 *
 * Three gates stand between an open incident and a model pass, cheapest first:
 * the issue's own history (no model), the decision model's verdict on the
 * incident, and the daily quota. The order matters twice over — the classifier
 * is not asked about an issue somebody already owns, and the quota is judged
 * by the severity the classifier settled on.
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

		const detected = snapshotFor(input)
		const reason = contextString(input.context, "reason") ?? null

		// Gate 1: what Maple already knows about the issue. An error incident
		// auto-resolves after thirty quiet minutes and the next occurrence opens a
		// fresh one, so without this an issue firing on a retry cadence was
		// diagnosed again on every flare-up (fifteen times in five days, prod
		// 2026-09-20), and one a person had already taken to review kept getting
		// fresh reports nobody had asked for.
		if (input.issueId !== undefined) {
			const issueId = input.issueId
			const issueRows = yield* database.execute((db) =>
				db
					.select({ workflowState: errorIssues.workflowState })
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, issueId)))
					.limit(1),
			)
			const latestRows = yield* database.execute((db) =>
				db
					.select({
						id: investigations.id,
						status: investigations.status,
						createdAt: investigations.createdAt,
						startedAt: investigations.startedAt,
					})
					.from(investigations)
					.where(and(eq(investigations.orgId, input.orgId), eq(investigations.issueId, issueId)))
					.orderBy(desc(investigations.createdAt))
					.limit(1),
			)
			const latestRow = latestRows[0]
			const latest: LatestIssueInvestigation | null =
				latestRow === undefined
					? null
					: {
							id: latestRow.id,
							status: latestRow.status,
							createdAtMs: dateToMs(latestRow.createdAt),
							startedAtMs: dateToMs(latestRow.startedAt),
						}
			const issueGate = evaluateIssueGate({
				workflowState: issueRows[0]?.workflowState ?? null,
				reason,
				latest,
				incidentKind: input.incidentKind,
				nowMs,
				force: input.force,
			})
			if (issueGate.kind === "skip") {
				yield* recordSkip(input, issueGate.reason, {
					priorInvestigationId: issueGate.priorInvestigationId,
					severity: detected.severity,
					verdict: null,
				})
				return {
					enqueued: false,
					reason: issueGate.reason,
					...(issueGate.priorInvestigationId
						? { priorInvestigationId: issueGate.priorInvestigationId }
						: undefined),
				}
			}
		}

		// Gates 2 and 3: the decision model, where this deployment has one. Read
		// optionally on purpose — the Workers that open incidents bind it, tests
		// and the CLI do not, and its absence is "investigate unclassified", the
		// behaviour every incident had before the gate existed.
		const classifier = yield* Effect.serviceOption(IncidentClassifier)
		const priorsFor = (serviceName: string) =>
			database.execute((db) =>
				selectPriorDiagnoses(
					db,
					input.orgId,
					serviceName,
					input.issueId ?? null,
					nowMs - REINVESTIGATE_AFTER_MS.error,
				),
			)
		const serviceName = detected.serviceName ?? null
		const priors = Option.isNone(classifier) || serviceName === null ? [] : yield* priorsFor(serviceName)
		const verdict = Option.isNone(classifier)
			? null
			: yield* classifier.value.classify(triageRequestFor(input, detected, reason, priors))
		const gate = evaluateIncidentGate({
			verdict,
			detectorSeverity: detected.severity,
			force: input.force,
		})
		if (gate.kind === "skip") {
			// The one write a skip makes: an untriaged issue the model called noise
			// is labelled with its severity, so the hub can sort it below the rest.
			// Never an escalation — see `applyClassifierSeverity`.
			if (input.issueId !== undefined && gate.reason === "noise") {
				const issueId = input.issueId
				yield* database.execute((db) =>
					applyClassifierSeverity(db, {
						orgId: input.orgId,
						issueId,
						incidentId: input.incidentId,
						severity: gate.classification.severity,
						confidence: gate.classification.severityConfidence,
						timestamp: nowMs,
					}),
				)
			}
			yield* recordSkip(input, gate.reason, {
				priorInvestigationId: gate.priorInvestigationId,
				severity: gate.classification.severity,
				verdict: gate.classification,
			})
			return {
				enqueued: false,
				reason: gate.reason,
				...(gate.priorInvestigationId
					? { priorInvestigationId: gate.priorInvestigationId }
					: undefined),
			}
		}
		yield* Effect.annotateCurrentSpan(verdictAttributes(gate.classification))

		// The snapshot the run is seeded with carries the settled severity: the
		// detector's, raised by the model where it saw more urgency.
		const snapshot =
			gate.severity === detected.severity
				? detected
				: new InvestigationSubjectSnapshot({ ...detected, severity: gate.severity })

		// One agent, one pass. Shared with `InvestigationService` so the two ceilings
		// are judged the same way on both paths.
		const usage = yield* database.execute((db) => selectInvestigationUsage(db, input.orgId, nowMs))
		const quota = evaluateInvestigationQuota({
			usage,
			limits: settings,
			passCount: 1,
			nowMs,
			// Severity decides which ceiling applies, in both units, so that a burst of
			// `low` incidents just after UTC midnight cannot spend the slice a
			// `critical` opening at noon needs.
			severity: snapshot.severity,
		})
		if (quota.kind === "exceeded") {
			yield* Effect.logWarning("Investigation daily budget reached; skipping autonomous start").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					quotaDimension: quota.dimension,
					quotaLimit: quota.limit,
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
				"maple.investigation.quota_dimension": quota.dimension,
				"maple.investigation.quota_limit": quota.limit,
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
